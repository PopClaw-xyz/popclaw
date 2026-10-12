/**
 * Pings · replies to my posts, with durable unread and first-reply tracking.
 *
 * In one line: for everything you've ever said, if someone replies, you'll know.
 *
 * Three pieces:
 *   - `ReplyPingsStore`  two small primary-key-only ledgers (migration 013): idempotency gate + first-reply gate + unread cursor
 *   - `routeReplyPing`   called at the same site where the echo lands in the cache: decide → enqueue (first reply L1 / everything else L2)
 *   - `collectPings` / `renderPings`  material for the agent and its tiered rendering
 *
 * "The material set" and "the unread ledger" are the same thing: material is
 * only ever pulled from the unread set (both sides compute the id with the
 * same `pingIdOf`), and however many are actually shown is exactly how many
 * get marked read. Whatever wasn't shown keeps getting surfaced next time.
 *
 * Instant push (slice ③) isn't in this file: the `'first'` branch is picked
 * up by the caller into `notifyOwnerNow` (notifier/owner-notifier.ts). That's
 * why the freshness gate (spec §5) has to live here — otherwise a fresh
 * install's/reinstall's full SSE backfill would shout months of historical
 * first-replies at the owner all at once; and even if that branch never
 * fires, the same `notifyOwnerNow` will still drain out every pending L1 the
 * moment a DM arrives and write it straight to the channel.
 */
import type { HostDb } from '../host/host-db.js';
import { deriveSigil } from '../invite/sigil.js';
import { languageDirective } from '../lexicon/directive.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import type { BondTier } from '../bonds/bond-tier.js';
import { tierRank, tierLabel } from '../bonds/bond-tier.js';
import { numberOrZero, type CachedFeedItem } from '../ingress/feed-item-projection.js';
import type { ReplyToOwner } from '../ingress/world-feed-cache.js';
import type { Notifier } from '../notifier/notifier.js';
import { timeContext } from '../time/time-context.js';
import {
  safeRecord,
  type SocialLogRecorder,
  type SocialLogVerified,
} from '../social-log/social-log.js';

/** Hard cap on one material fetch (far larger than any realistic ping volume; >100 tier only shows the first 20 + an aggregate count). */
export const PINGS_FETCH_CAP = 500;
/** Freshness gate: if the reply's own timestamp is older than now by this many seconds → enqueue (L2) only, never L1 (spec §5). */
export const PING_FRESH_WINDOW_SECONDS = 10 * 60;
/** ≤ this many → full-text rendering. */
const FULL_RENDER_MAX = 5;
/** ≤ this many → compact timeline; above it → first HEAD_CAP entries + an aggregate count. */
const COMPACT_RENDER_MAX = 100;
const HEAD_CAP = 20;
/** Truncation line for a single reply body (a lighter-weight version of the same 500 used by popclaw_author_latest). */
const BODY_CHARS = 300;

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export class ReplyPingsStore {
  constructor(
    private readonly db: HostDb,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /**
   * Idempotency gate: true = this reply event arrived for the first time
   * (an SSE reconnect backfill will resend the same one). "The insert
   * succeeded" is the whole answer — no counting, no querying.
   */
  claimArrival(replyEventId: string, targetPostId: string): boolean {
    return (
      this.db.execute(
        'INSERT OR IGNORE INTO reply_pings (reply_event_id, target_post_id, arrived_at) VALUES (?, ?, ?)',
        [replyEventId, targetPostId, this.now()],
      ).changes === 1
    );
  }

  /** First-reply gate: true = this "thing I said" just received its first-ever echo. Also determined solely by whether the insert succeeded. */
  claimFirstReply(targetPostId: string): boolean {
    return (
      this.db.execute('INSERT OR IGNORE INTO reply_first_ping (target_post_id, at) VALUES (?, ?)', [
        targetPostId,
        this.now(),
      ]).changes === 1
    );
  }

  /** Arrival, first-reply claim and notification enqueue commit together.
   *  The enqueue callback must write to this store's HostDb synchronously.
   *  null = duplicate; otherwise the result identifies the first reply.
   *  A failure rolls back all three writes so replay can route the reply. */
  claimAndEnqueue(replyEventId: string, targetPostId: string, enqueue: (isFirst: boolean) => void): boolean | null {
    return this.db.transaction(() => {
      if (!this.claimArrival(replyEventId, targetPostId)) return null;
      const isFirst = this.claimFirstReply(targetPostId);
      enqueue(isFirst);
      return isFirst;
    });
  }

  /** Unread count (for the tool's trailer). */
  unreadCount(): number {
    return (
      this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM reply_pings WHERE read_at IS NULL')
        ?.n ?? 0
    );
  }

  /** Unread reply ids, most recently arrived first — material is pulled from this batch. */
  listUnread(limit: number): string[] {
    return this.db
      .queryAll<{ reply_event_id: string }>(
        'SELECT reply_event_id FROM reply_pings WHERE read_at IS NULL ORDER BY arrived_at DESC, rowid DESC LIMIT ?',
        [limit],
      )
      .map((r) => r.reply_event_id);
  }

  /**
   * Mark read — but only mark the ones that were **actually shown to the
   * owner** (spec §7). Anything that didn't make it into the material (cut
   * by tiered rendering, or missing from the cache) stays unread and keeps
   * getting surfaced next time. Returns how many were marked.
   */
  markRead(replyEventIds: readonly string[]): number {
    if (replyEventIds.length === 0) return 0;
    const holes = replyEventIds.map(() => '?').join(',');
    return this.db.execute(
      `UPDATE reply_pings SET read_at = ? WHERE read_at IS NULL AND reply_event_id IN (${holes})`,
      [this.now(), ...replyEventIds],
    ).changes;
  }
}

/**
 * A reply's id in the ledger. `routeReplyPing` (write) and `collectPings`
 * (read) must use the exact same expression, or the two sides won't join —
 * this is the only seam of "material set ∩ unread ledger". When event_id is
 * missing (an older server), falls back to (platform, postId), i.e.
 * world_feed's primary key.
 */
export function pingIdOf(r: {
  eventId?: string | null;
  platform?: string | null;
  platformPostId?: string | null;
}): string {
  return (r.eventId ?? '') || `${r.platform ?? ''}:${r.platformPostId ?? ''}`;
}

// ---------------------------------------------------------------------------
// Enqueue routing
// ---------------------------------------------------------------------------

/** The handful of fields this module needs out of a world-feed entry (protobuf shape, fields may be null). */
export interface IncomingItemLike {
  readonly platform?: string | null;
  readonly platformPostId?: string | null;
  readonly eventId?: string | null;
  readonly authorPopclawId?: string | null;
  readonly handle?: string | null;
  readonly actorNickname?: string | null;
  readonly textPreview?: string | null;
  readonly platformPostCreatedAt?: unknown; // proto int64 — could be number/Long/string
  readonly replyToPlatform?: string | null;
  readonly replyToPostId?: string | null;
  /** The author's verified platforms, baked in by the lore-house at ingest (the sole source for the social log's `verified_then`). */
  readonly actorVerified?: ReadonlyArray<{
    platform?: string | null;
    followerCount?: number | null;
  }> | null;
}

/** `actor_verified` → the social log's `verified_then`. Empty/missing → undefined (omitted rather than an empty array). */
export function verifiedThenOf(
  refs: IncomingItemLike['actorVerified'],
): SocialLogVerified[] | undefined {
  const out = (refs ?? [])
    .filter((v) => (v.platform ?? '').length > 0)
    .map((v) => ({
      platform: v.platform ?? '',
      ...(typeof v.followerCount === 'number' && v.followerCount > 0
        ? { followers: v.followerCount }
        : {}),
    }));
  return out.length > 0 ? out : undefined;
}

export interface ReplyPingDeps {
  readonly ownerPopclawId: string;
  readonly cache: { lookup(platform: string, id: string): CachedFeedItem | null };
  readonly pings: ReplyPingsStore;
  /** Enqueues synchronously into the same HostDb as pings (the runtime's shared queue). */
  readonly notifier: Pick<Notifier, 'enqueue'>;
  /** wall-clock SECONDS seam (house convention); defaults to Date.now()/1000. */
  readonly now?: () => number;
  /** The social log's `reply_received` collection point (spec 2026-07-26 §4). Not recorded if not injected. */
  readonly socialLog?: SocialLogRecorder;
  /**
   * The bond-context trailer line (bonds/bond-context.ts). Same pattern as
   * `fromName`: baked into the payload at enqueue time, so the render step
   * doesn't query the db and it survives a requeue. No trailer if not
   * injected.
   */
  readonly bondContext?: (popclawId: string, beforeTs?: number) => string;
}

export type ReplyPingOutcome =
  /** Not a reply to something I said (includes ordinary posts) → cache only */
  | 'not-mine'
  /** I replied to myself → cache only */
  | 'self'
  /** This reply was already routed before → don't re-enqueue */
  | 'duplicate'
  /** First reply to this post, and fresh → L1 */
  | 'first'
  /** First reply but it's already old itself (reconnect backfill) → enqueue L2 only, don't interrupt */
  | 'first-stale'
  /** A subsequent reply on the same post → L2 */
  | 'more';

/** One world-feed entry arrives, passed through the gates in order (spec §6). Called at the same site where the echo lands in the cache. */
export function routeReplyPing(deps: ReplyPingDeps, incoming: IncomingItemLike): ReplyPingOutcome {
  const targetId = incoming.replyToPostId ?? '';
  if (targetId.length === 0) return 'not-mine';
  const author = incoming.authorPopclawId ?? '';
  if (author === deps.ownerPopclawId) return 'self';
  // The basis for judgment is always "is the post being replied to something
  // I said" — never look at reply_to_author_popclaw_id (always empty on the
  // live tail, spec §12). Go through the full primary key (platform,
  // post_id): recognizing id alone would let a forged platform value ride
  // along to hit the owner's mirrored post, and it would also degrade this
  // SSE hot-path query into a full table scan.
  const target = deps.cache.lookup(incoming.replyToPlatform || 'popclaw', targetId);
  if (!target || target.authorPopclawId !== deps.ownerPopclawId) return 'not-mine';

  let stale = false;
  const isFirst = deps.pings.claimAndEnqueue(pingIdOf(incoming), targetId, (first) => {
    // Freshness gate: an SSE disconnect/reconnect or a reinstall backfills
    // history all at once — without this gate, one reconnect in the middle of
    // the night could shout three months' worth of first-replies out as L1.
    // A single stateless comparison, no timer, no queue.
    const createdAt = numberOrZero(incoming.platformPostCreatedAt);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    stale = createdAt > 0 && now - createdAt > PING_FRESH_WINDOW_SECONDS;
    // Bond context: this reply itself isn't in the inbox, so there's no need to
    // exclude "the current entry" — just look straight through to now.
    const bondLine = deps.bondContext?.(author) ?? '';
    deps.notifier.enqueue({
      level: first && !stale ? 'L1' : 'L2',
      kind: 'reply',
      payload: {
        replyEventId: pingIdOf(incoming),
        fromPopclawId: author,
        fromName: incoming.actorNickname || incoming.handle || '',
        body: (incoming.textPreview ?? '').slice(0, BODY_CHARS),
        targetPostId: targetId,
        targetPreview: target.textPreview,
        ...(bondLine ? { bondLine } : {}),
      },
    });
  });
  if (isFirst === null) return 'duplicate';

  // JSONL is outside the SQL transaction. Append only after commit so a
  // failed enqueue and its replay cannot record the same interaction twice.
  // Fresh and stale replies both happened for real and are both recorded.
  // Keep both original texts: the world-feed cache is pruned after a year.
  safeRecord(deps.socialLog, {
    kind: 'reply_received',
    actor: {
      id: author,
      name: incoming.actorNickname || incoming.handle || '',
      verified_then: verifiedThenOf(incoming.actorVerified),
    },
    text: incoming.textPreview ?? '',
    in_reply_to: { event_id: target.eventId, text: target.textPreview },
    event_id: pingIdOf(incoming),
  });

  if (!isFirst) return 'more';
  return stale ? 'first-stale' : 'first';
}

// ---------------------------------------------------------------------------
// Material + tiered rendering
// ---------------------------------------------------------------------------

export interface PingMaterial {
  eventId: string;
  replierPopclawId: string;
  replierName: string;
  /** Bond tier: decides sort order and labeling only, never any interrupt behavior (ADR-0012 amendment §1). */
  tier: BondTier;
  body: string;
  createdAt: number;
  targetPostId: string;
  targetPreview: string;
  /** Web link for a native popclaw post; '' for mirrored posts / when missing. */
  webUrl: string;
}

export interface CollectPingsDeps {
  readonly ownerPopclawId: string;
  readonly cache: { repliesToOwner(ownerId: string, limit: number): ReplyToOwner[] };
  readonly pings: Pick<ReplyPingsStore, 'listUnread'>;
  /** Bond-book lookup + alias, resolved in one pass; the bond book lives in
   *  my-social-assets.db while the world-feed cache lives in lorehouses/*.db,
   *  and cross-db SQL joins aren't possible → merged here instead. Not found = a stranger. */
  readonly bondOf: (popclawId: string) => { tier: BondTier; remarkName?: string } | null;
  readonly webBaseUrl?: string;
}

/**
 * Ping material = unread ledger ∩ world-feed cache. Sort: bond tier
 * descending → time **descending** (newest first).
 *
 * Only pulling from the unread set is what makes "this batch" a coherent
 * concept: after tiered truncation, the caller marks only what it actually
 * showed as read, and the rest keeps getting surfaced next time. Taking the
 * full history as material and then marking it all read in one sweep would
 * mean that once the newest entry gets pushed out of the top 20, it would
 * never be surfaced again.
 */
export function collectPings(deps: CollectPingsDeps, cap = PINGS_FETCH_CAP): PingMaterial[] {
  const unread = new Set(deps.pings.listUnread(cap));
  if (unread.size === 0) return [];
  return deps.cache
    .repliesToOwner(deps.ownerPopclawId, cap)
    .filter((r) => unread.has(pingIdOf(r.reply)))
    .map((r) => {
      const id = r.reply.authorPopclawId;
      const bond = deps.bondOf(id);
      return {
        eventId: pingIdOf(r.reply),
        replierPopclawId: id,
        // Same rule as every owner-facing name: alias > handle > #sigil. The
        // bare id prefix used to leak here when neither existed — renderPings
        // prints this string directly, so the prefix reached the screen.
        replierName: bond?.remarkName || r.reply.handle || `#${deriveSigil(id)}`,
        tier: bond?.tier ?? 'stranger',
        body: r.reply.textPreview.slice(0, BODY_CHARS),
        createdAt: r.reply.platformPostCreatedAt,
        targetPostId: r.targetPostId,
        targetPreview: r.targetPreview,
        webUrl:
          deps.webBaseUrl && r.reply.platform === 'popclaw'
            ? `${deps.webBaseUrl}/post/${r.reply.platformPostId.slice(0, 10)}`
            : '',
      };
    })
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.createdAt - a.createdAt);
}

function day(sec: number, lang: Lang): string {
  if (sec <= 0) return renderCopy(lang, 'pings.unknownTime');
  // The owner's local timezone (ADR-0045) — this line gets read aloud to the owner, and UTC would make it not match their own clock.
  const c = timeContext(sec);
  return `${c.ymd} ${c.hm}`;
}

/** Material footer + S1 language directive (whatever language the owner speaks, this material gets told in that language). */
function footer(lang: Lang): string {
  return `${renderCopy(lang, 'pings.footer')}\n${languageDirective()}`;
}

/**
 * Tiered rendering, copied straight from the already-merged one-body-two-tier
 * pattern in `popclaw_author_latest`: ≤5 full text / 6–100 compact timeline /
 * >100 first 20 entries + an aggregate count.
 *
 * Returns `shown` = the entries actually rendered; the caller marks only
 * these as read — the truncated tail must stay unread, or it would vanish
 * forever.
 *
 * S3 rollout — renders in `lang` (defaults to `ownerLang()`, S1). Layout
 * (numbering/emoji/indent) untouched; tier labels go through `tierLabel()`,
 * sentences through the `pings.*` lexicon copy.
 */
export function renderPings(
  items: PingMaterial[],
  lang: Lang = ownerLang(),
): { text: string; shown: PingMaterial[] } {
  if (items.length === 0) {
    return { text: renderCopy(lang, 'pings.empty'), shown: [] };
  }
  const people = new Set(items.map((p) => p.replierPopclawId)).size;
  const header = renderCopy(lang, 'pings.header', { count: String(items.length), people: String(people) });

  if (items.length <= FULL_RENDER_MAX) {
    const blocks = items.map((p, i) =>
      [
        `${i + 1}. [${tierLabel(p.tier, lang)}] ${p.replierName} · ${day(p.createdAt, lang)}`,
        `   ${renderCopy(lang, 'pings.replyingTo', { preview: p.targetPreview })}`,
        `   ${p.body}`,
        p.webUrl ? `   ${renderCopy(lang, 'pings.linkLabel', { url: p.webUrl })}` : '',
      ]
        .filter((l) => l.length > 0)
        .join('\n'),
    );
    return { text: [header, ...blocks, footer(lang)].join('\n\n'), shown: items };
  }

  const shown = items.length <= COMPACT_RENDER_MAX ? items : items.slice(0, HEAD_CAP);
  const lines = shown.map(
    (p) =>
      `[${tierLabel(p.tier, lang)}] ${p.replierName} · ${day(p.createdAt, lang)} ` +
      renderCopy(lang, 'pings.compactLine', { preview: p.targetPreview.slice(0, 20), body: p.body }),
  );
  const tail =
    items.length > COMPACT_RENDER_MAX
      ? renderCopy(lang, 'pings.tail', { more: String(items.length - HEAD_CAP), cap: String(HEAD_CAP) })
      : '';
  return {
    text: [header, lines.join('\n'), tail, footer(lang)].filter((s) => s.length > 0).join('\n\n'),
    shown,
  };
}
