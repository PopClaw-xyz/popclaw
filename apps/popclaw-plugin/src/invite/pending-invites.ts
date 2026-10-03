/**
 * The verification-experience closed loop (ADR-0040) — an application I submitted now always
 * gets a follow-up.
 *
 * Three pieces:
 *   - `PendingInvitesStore`  a small ledger (migration 016): in-progress + a settle-once idempotency gate
 *   - `routeInviteVerified`  SSE `invite_verified` arrives → if it's mine, enqueue to L1 (Act 2)
 *   - `checkInviteOnce` / `watchInvite` / `checkPendingInvites`
 *     short-polls the lore-house's `GET /v1/invites/<task_id>` → rejections get an echo too (Act 3)
 *
 * Both paths share the same gate: `claimResolved`'s UPDATE ... WHERE notified = 0.
 * Whichever settles it first does the notifying, the other path stays silent — even an SSE
 * reconnect replaying the same event only announces once.
 */
import bs58 from 'bs58';
import type { HostDb } from '../host/host-db.js';
import type { Notifier } from '../notifier/notifier.js';
import { numberOrZero } from '../ingress/feed-item-projection.js';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/** Application validity period (ADR-0040 Act 1: valid for 48h, zero penalty on expiry). Expired ones no longer count as "in progress". */
export const INVITE_TTL_SECONDS = 48 * 3600;
/** Rejection polling: every 15s, capped at 10 minutes, after which the next status / interaction's lazy-lookup backstops it. */
export const INVITE_POLL_INTERVAL_MS = 15_000;
export const INVITE_POLL_MAX_MS = 10 * 60_000;

export type InviteState = 'pending' | 'approved' | 'rejected';

export interface PendingInvite {
  readonly taskId: string;
  readonly platform: string;
  readonly handle: string;
  readonly sigil: string;
  readonly createdAt: number;
}

interface Row {
  task_id: string;
  platform: string;
  handle: string;
  sigil: string;
  created_at: number;
}

export class PendingInvitesStore {
  constructor(
    private readonly db: HostDb,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Records an entry when submission succeeds and the receipt carries a task_id. Resubmitting the same task_id = no-op. */
  add(inv: {
    taskId: string;
    platform: string;
    handle: string;
    sigil?: string;
    proofUrl?: string;
  }): void {
    this.db.execute(
      'INSERT OR IGNORE INTO pending_invites (task_id, platform, handle, sigil, proof_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [inv.taskId, inv.platform, inv.handle, inv.sigil ?? '', inv.proofUrl ?? '', this.now()],
    );
  }

  /** In-progress, unexpired applications (used for status's "verification in progress" line + the lazy-lookup backstop's checklist). */
  listPending(): PendingInvite[] {
    return this.db
      .queryAll<Row>(
        "SELECT task_id, platform, handle, sigil, created_at FROM pending_invites WHERE state = 'pending' AND created_at > ? ORDER BY created_at DESC",
        [this.now() - INVITE_TTL_SECONDS],
      )
      .map((r) => ({
        taskId: r.task_id,
        platform: r.platform,
        handle: r.handle,
        sigil: r.sigil,
        createdAt: r.created_at,
      }));
  }

  get(taskId: string): PendingInvite | null {
    const r = this.db.queryOne<Row>(
      'SELECT task_id, platform, handle, sigil, created_at FROM pending_invites WHERE task_id = ?',
      [taskId],
    );
    return r
      ? { taskId: r.task_id, platform: r.platform, handle: r.handle, sigil: r.sigil, createdAt: r.created_at }
      : null;
  }

  /**
   * Settles + claims this notification. `true` = this call is the first to settle it, so only
   * it should announce.
   *
   * If there's no matching row yet, seed one first (the process was reinstalled, or the SSE
   * event still arrives when the application was submitted from another machine) — that way
   * the gate still holds, and the ledger retains a record of this verification.
   */
  claimResolved(
    taskId: string,
    state: Exclude<InviteState, 'pending'>,
    seed?: { platform: string; handle: string },
  ): boolean {
    if (seed) {
      this.db.execute(
        'INSERT OR IGNORE INTO pending_invites (task_id, platform, handle, created_at) VALUES (?, ?, ?, ?)',
        [taskId, seed.platform, seed.handle, this.now()],
      );
    }
    return (
      this.db.execute(
        'UPDATE pending_invites SET state = ?, resolved_at = ?, notified = 1 WHERE task_id = ? AND notified = 0',
        [state, this.now(), taskId],
      ).changes === 1
    );
  }
}

// ---------------------------------------------------------------------------
// Act 2: approved — SSE invite_verified
// ---------------------------------------------------------------------------

/** The handful of fields this module needs from the `invite_verified` payload (pbjs shape). */
export interface InviteVerifiedLike {
  readonly taskId?: string | null;
  /** Raw 32-byte pubkey; must be base58-encoded before comparing against boot.popclawId. */
  readonly applicantPopclawId?: Uint8Array | null;
  readonly platform?: string | null;
  readonly handle?: string | null;
  readonly followerCount?: unknown; // proto int64 — could be number/Long/string
}

export interface InviteNotifyWiring {
  readonly ownerPopclawId: string;
  readonly pending: PendingInvitesStore;
  readonly notifier: Pick<Notifier, 'enqueue'>;
  /** Delivery via the direct-write channel (index.ts's pushL1ToOwner). The enqueuing branch kicks it itself, the caller doesn't need to kick it again. */
  readonly notifyOwner: () => void;
  /** The owner's namecard URL — the Act 2 payoff. Empty = don't include a link.
   *  A function is read when the notice is built: the owner may have renamed
   *  since the wiring was assembled at boot. */
  readonly profileUrl?: string | (() => string);
}

function ownerProfileUrl(deps: Pick<InviteNotifyWiring, 'profileUrl'>): string {
  return (typeof deps.profileUrl === 'function' ? deps.profileUrl() : deps.profileUrl) ?? '';
}

export type InviteVerifiedOutcome =
  /** Someone else's verification (visible to everyone in the world stream) → none of my business */
  | 'not-mine'
  /** Already notified for this one (SSE reconnect replay / polling settled it first) → stay silent */
  | 'duplicate'
  /** First time settling it → enqueued to L1 */
  | 'notified';

export function routeInviteVerified(
  deps: InviteNotifyWiring,
  payload: InviteVerifiedLike,
): InviteVerifiedOutcome {
  const raw = payload.applicantPopclawId;
  if (!raw || raw.length === 0) return 'not-mine';
  const applicant = bs58.encode(raw);
  if (applicant !== deps.ownerPopclawId) return 'not-mine';

  // A task_id-less event can't be claimed: `claimResolved('')` would seed and
  // latch the '' row, and the NEXT such event would come back 'duplicate' —
  // one malformed envelope would permanently mute this leg.
  const taskId = payload.taskId ?? '';
  if (!taskId) return 'not-mine';
  const platform = payload.platform ?? '';
  const handle = payload.handle ?? '';
  if (!deps.pending.claimResolved(taskId, 'approved', { platform, handle })) return 'duplicate';

  deps.notifier.enqueue({
    level: 'L1',
    kind: 'ranger_verify_done',
    payload: {
      platform,
      handle,
      followerCount: numberOrZero(payload.followerCount),
      profileUrl: ownerProfileUrl(deps),
    },
  });
  deps.notifyOwner();
  return 'notified';
}

// ---------------------------------------------------------------------------
// Act 3: rejected — GET /v1/invites/<task_id>
// ---------------------------------------------------------------------------

export interface InviteWatchDeps extends InviteNotifyWiring {
  readonly fetch: typeof globalThis.fetch;
  readonly loreHouseUrl: string;
  readonly logger?: { info(msg: string): void };
}

function expiredReason(): string {
  return renderCopy(ownerLang(), 'invite.reason.expired');
}

/**
 * Lore-house state → a reason the owner can actually understand (only final states get a
 * reason; in-progress returns null).
 *
 * The lore-house's expiry scan marks quests `EXPIRED` / outcome `INCONCLUSIVE`, and
 * `/v1/invites` reports outcome preferentially — so by the time a timeout reaches the owner's
 * eyes, it usually shows up looking like INCONCLUSIVE. Comparing against the response's
 * `expires_at` splits the two apart: past the expiry it's Act 5 (just resubmit), not past
 * expiry it's a genuine "not enough rangers responded". The EXPIRED branch is kept as a
 * backstop (in case the lore-house ever reports it directly).
 */
function failReason(
  state: string,
  counts: { reject: number; abstain: number },
  expired: boolean,
): string | null {
  const lang = ownerLang();
  switch (state) {
    case 'REJECTED':
      return counts.reject > 0
        ? renderCopy(lang, 'invite.reason.rejectedCounted', { count: String(counts.reject) })
        : renderCopy(lang, 'invite.reason.rejectedUncounted');
    case 'INCONCLUSIVE':
      return expired ? expiredReason() : renderCopy(lang, 'invite.reason.inconclusive');
    case 'EXPIRED':
      return expiredReason();
    default:
      return null;
  }
}

/**
 * Queries the lore-house once. `true` = already settled (approved or rejected either way), no
 * need to check again.
 *
 * The approved branch here only backstops what SSE missed: if `claimResolved` hits notified=1
 * it's a no-op.
 */
export async function checkInviteOnce(deps: InviteWatchDeps, taskId: string): Promise<boolean> {
  const url = `${deps.loreHouseUrl.replace(/\/$/, '')}/v1/invites/${encodeURIComponent(taskId)}`;
  let body: {
    state?: string;
    platform?: string;
    handle?: string;
    reject_count?: number;
    abstain_count?: number;
    follower_count?: number;
    /** RFC3339. Act 5 uses this to separate "timed out" from "rangers didn't reach quorum". */
    expires_at?: string;
  };
  try {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS) });
    if (!res.ok) return false; // 404 = not yet persisted / already GC'd; a network-level failure is the same — keep waiting
    body = (await res.json()) as typeof body;
  } catch {
    return false;
  }
  const state = body.state ?? '';
  const known = deps.pending.get(taskId);
  const platform = body.platform || known?.platform || '';
  const handle = body.handle || known?.handle || '';

  if (state === 'APPROVED') {
    if (deps.pending.claimResolved(taskId, 'approved', { platform, handle })) {
      deps.notifier.enqueue({
        level: 'L1',
        kind: 'ranger_verify_done',
        payload: {
          platform,
          handle,
          followerCount: body.follower_count ?? 0,
          profileUrl: ownerProfileUrl(deps),
        },
      });
      deps.notifyOwner();
    }
    return true;
  }

  const expiresAt = Date.parse(body.expires_at ?? '');
  const reason = failReason(
    state,
    { reject: body.reject_count ?? 0, abstain: body.abstain_count ?? 0 },
    Number.isFinite(expiresAt) && Date.now() > expiresAt,
  );
  if (reason === null) return false; // PENDING / DISPATCHED

  if (deps.pending.claimResolved(taskId, 'rejected', { platform, handle })) {
    deps.notifier.enqueue({
      level: 'L1',
      kind: 'ranger_verify_fail',
      payload: { platform, handle, reason },
    });
    deps.notifyOwner();
  }
  return true;
}

/**
 * Short-polling after submission (Act 3). An in-process await-sleep loop is all it needs — no
 * persistent timer: after a process restart, the next status/interaction's `checkPendingInvites`
 * backstops it via lazy lookup.
 */
export async function watchInvite(
  deps: InviteWatchDeps,
  taskId: string,
  opts: {
    intervalMs?: number;
    maxMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? INVITE_POLL_INTERVAL_MS;
  const maxMs = opts.maxMs ?? INVITE_POLL_MAX_MS;
  // ponytail: bare setTimeout, not wired to host.timer — after the plugin unloads, this chain
  // runs at most another 10min (INVITE_POLL_MAX_MS) before finishing on its own, harmless at
  // this scale. Upgrade once the host exposes a cancelable timer.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + maxMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    if (await checkInviteOnce(deps, taskId)) return;
  }
  deps.logger?.info(`popclaw: invite ${taskId.slice(0, 8)}… still no result, falling back to lazy-check (will ask again on the next status)`);
}

/** Lazy-lookup backstop: asks the lore-house about every application still pending in the ledger. Called on status / the next interaction. */
export async function checkPendingInvites(deps: InviteWatchDeps): Promise<void> {
  for (const inv of deps.pending.listPending()) {
    await checkInviteOnce(deps, inv.taskId).catch(() => false);
  }
}
