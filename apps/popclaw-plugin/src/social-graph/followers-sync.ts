/**
 * Followed-you notifications — known-follower set + diff-based backfill (spec
 * `docs/superpowers/specs/2026-07-27-follower-notification-design.md` slices ②③).
 *
 * Today the plugin has zero awareness of "someone followed me." The original
 * design planned to filter `FollowDeclared` in the world-stream callback, but
 * **that path doesn't exist**: lore-house's world_feed projection only
 * ingests Post / Reply / HouseEvent, and discovery also classifies Follow*
 * events as "relationship control plane, not content." With zero server
 * changes allowed, the only viable path is diffing `GET /followers/:me`
 * against this local table — so the spec's "backfill leg" is the **only** leg in this version.
 *
 * Two hard rules:
 *   1. **The first run only establishes a baseline, never notifies** —
 *      existing followers aren't new followers; treating them as new and
 *      flooding notifications is the easiest mistake to make and the most
 *      damaging one (pinned down by a test).
 *   2. **Unfollows are silent** — FollowRevoked only updates the local set, never notifies the person unfollowed.
 *
 * ponytail: a single 30-minute poll doubles as both the "backfill" cadence
 * and L2's batching window — there's no live leg to hook into, so a second
 * timer isn't needed. If a lore-house ever agrees to put FollowDeclared into
 * some stream, downgrade `syncFollowers` to pure backfill — no table or
 * rendering changes needed.
 */
import type { HostDb } from '../host/host-db.js';
import type { ReadAuthRefusal, ReadAuthority } from '../identity/read-authority.js';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';
import type { Notifier } from '../notifier/notifier.js';
import { passesRelativeValueGate, type GraphLike } from '../notifier/relative-value.js';
import { personVerdict } from '../butler/person-verdict.js';
import type { BondTier } from '../bonds/bond-tier.js';
import { safeRecord, type SocialLogRecorder } from '../social-log/social-log.js';
import { displayPerson } from '../identity/person-resolver.js';
import { bondContextPrefix } from '../bonds/bond-context.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { ActionInactiveError, assertActionActive, withAction, type ActionGate } from '../runtime/house-lifecycle/action-context.js';

/** Poll interval + L2 batching window. ADR-0012's L2 is "say it in a batch," and 30 minutes is its natural cadence. */
export const FOLLOWER_SYNC_INTERVAL_MS = 30 * 60_000;

export interface NewFollower {
  readonly houseSlug: string;
  readonly followerId: string;
}

interface FollowerRow { follower_id: string }

/** Bound ids per settle statement, well under SQLite's variable limit. */
const BASELINE_SETTLE_CHUNK = 400;

/**
 * A read the house refused before it was ever sent, carrying the bare code.
 *
 * The message is unchanged — callers and tests have always matched the code
 * at the front of it — but the code is now a field, so the one caller that
 * has to branch on "nothing has pinned this house YET" does it on a value
 * rather than on the prose around it.
 */
export class ReadRefusedError extends Error {
  constructor(readonly refusal: ReadAuthRefusal, message: string) {
    super(`${refusal}: ${message}`);
    this.name = 'ReadRefusedError';
  }
}

/**
 * Whether this failure is the one a fresh install hits at boot: the poll and
 * the default-house pin start in the same tick and neither is awaited, so the
 * poll asks for a credential against a binding that commits a few hundred
 * milliseconds later. It is the one refusal that is expected to stop being
 * true on its own, which is why it is worth asking about again soon.
 */
export function isHouseNotYetTrusted(err: unknown): boolean {
  return err instanceof ReadRefusedError && err.refusal === 'READ_AUTH_HOUSE_NOT_TRUSTED';
}

/** The known-follower set keyed on `(house_slug, follower_id)` (migration 017). */
export class KnownFollowersStore {
  constructor(
    private readonly db: HostDb,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Whether this house has been seen before. An empty table ≠ first run — genuinely zero followers also looks like an empty table. */
  hasBaseline(houseSlug: string): boolean {
    return !!this.db.queryOne<{ house_slug: string }>(
      'SELECT house_slug FROM known_followers_baseline WHERE house_slug = ?',
      [houseSlug],
    );
  }

  /**
   * Establish the baseline, and settle what it makes history.
   *
   * The row alone is not enough. By the time the first sync commits, this
   * house's whole existing follower set is already in `known_followers` with
   * `announced_at` NULL — put there by the reconcile that just ran, and by
   * whatever a cold personal stream replayed before it. Writing only the
   * baseline row hands every one of those people to the drain sweep as an
   * unannounced debt, and the owner is introduced to their entire back
   * catalogue at once: precisely the flood the baseline exists to prevent,
   * arriving through the door the baseline opens.
   *
   * So the two are one act, in one transaction: what the baseline was DRAWN
   * FROM is history. Only rows outside it are news. Idempotent — a second
   * call finds the baseline already there and settles nothing, so a follower
   * learned a minute later keeps the announcement it is owed.
   *
   * `snapshot` is that membership: the follower ids the house's own list
   * named. It is not a detail, and "every unannounced row that happens to
   * exist right now" is not a cheap stand-in for it. The first pass can fail
   * — at boot it usually does, because the default-house pin commits a few
   * hundred milliseconds after the poll starts — and the next attempt is a
   * whole interval away. Someone who genuinely follows in that window is
   * learned from the relation stream and left owed an announcement, and a
   * blanket settle files them as history they were never part of: never
   * introduced, nothing in the queue, nothing on stderr. The sub-second form
   * is the same bug — someone who follows between the house computing its
   * list and this committing is absent from the list too.
   *
   * Membership, not a timestamp: a row's `first_seen_at` is written by
   * whichever process learned it, so deciding who is news by comparing it
   * against this clock would decide it by the skew between two writers.
   *
   * One kind of row is outside the baseline's meaning however the list reads:
   * a follower whose signed declaration this client WITNESSED (`verified_at`,
   * migration 043). The baseline's claim is "these people were already there
   * before this client ever looked" — and a witnessed declaration is precisely
   * the evidence that disproves it. The house's list names them too, because
   * they do follow, so settling by membership alone filed them as history and
   * neither path ever introduced them. They are skipped here and stay owed.
   */
  markBaseline(houseSlug: string, snapshot: readonly string[] = []): void {
    const ts = this.now();
    this.db.transaction(() => {
      const established = this.db.execute(
        'INSERT OR IGNORE INTO known_followers_baseline (house_slug, established_at) VALUES (?, ?)',
        [houseSlug, ts],
      );
      if (established.changes !== 1) return;
      // Chunked: SQLite binds a bounded number of parameters per statement,
      // and a house's follower list has no bound.
      const ids = [...new Set(snapshot.filter((id) => id))];
      for (let i = 0; i < ids.length; i += BASELINE_SETTLE_CHUNK) {
        const chunk = ids.slice(i, i + BASELINE_SETTLE_CHUNK);
        this.db.execute(
          `UPDATE known_followers SET announced_at = ?
            WHERE house_slug = ? AND announced_at IS NULL AND verified_at IS NULL
              AND follower_id IN (${chunk.map(() => '?').join(',')})`,
          [ts, houseSlug, ...chunk],
        );
      }
    });
  }

  /**
   * Union across all houses, deduped — **the local source for identity
   * resolution** (person-resolver's `followers`).
   * Kept separate from `list()`: that one is per-house, used for sync diffing;
   * identity resolution doesn't care which house someone came from.
   */
  allFollowerIds(): string[] {
    return this.db
      .queryAll<FollowerRow>('SELECT DISTINCT follower_id FROM known_followers', [])
      .map((r) => r.follower_id);
  }

  list(houseSlug: string): string[] {
    return this.db
      .queryAll<FollowerRow>('SELECT follower_id FROM known_followers WHERE house_slug = ?', [houseSlug])
      .map((r) => r.follower_id);
  }

  /**
   * A VERIFIED single-follower note from the relation consumer: someone the
   * house just relayed a signed Follow for (followee == the owner). One row,
   * added — never the reconcile's wholesale delete, so a verified arrival
   * updates identity resolution immediately without waiting for the next
   * poll, and without touching anyone else's row.
   *
   * `witnessed` records WHICH of those two things happened, because they are
   * not the same evidence (migration 043). A frame this client took delivery
   * of is a declaration it saw happen; the catch-up pass reads a projection
   * that was already adjudicated, possibly by a build that existed before this
   * column did, and can vouch for no such thing. Only the first may be
   * announced ahead of a baseline.
   */
  noteVerifiedFollow(
    houseSlug: string,
    followerId: string,
    options: { readonly witnessed?: boolean } = {},
  ): boolean {
    // `announced_at` stays NULL: learning is not telling, and the process
    // that learns may not be the one that can tell. The sweep below closes
    // that gap from whichever process holds the notifier.
    const ts = this.now();
    const res = this.db.execute(
      'INSERT OR IGNORE INTO known_followers (house_slug, follower_id, first_seen_at, verified_at) VALUES (?, ?, ?, ?)',
      [houseSlug, followerId, ts, options.witnessed === false ? null : ts],
    );
    return res.changes === 1; // actually NEW — the poll's notify pipeline wants exactly these
  }

  /**
   * Followers learned but not yet decided about: everyone at a house that HAS
   * a baseline, plus anyone whose declaration this client witnessed.
   *
   * The baseline condition is not an optimisation. A house being seen for the
   * first time hands over its whole history at once — a cold personal stream
   * replays from the start of the log — and every one of those is someone the
   * owner has had all along, not someone who just arrived.
   *
   * But it cannot be the ONLY condition, because the poll's first successful
   * pass is the only thing that writes a baseline, and that pass can be
   * minutes away or fail outright. Requiring one means a follow whose signed
   * original is already committed here is held with nothing said about it —
   * on a brand-new install, for the first minutes of someone's life on this
   * network, which is when it matters most. A witnessed declaration answers
   * the question the baseline was asked for: this client was looking when it
   * happened, so it is not history from before this client looked.
   */
  unannounced(limit = 50): NewFollower[] {
    return this.db
      .queryAll<{ house_slug: string; follower_id: string }>(
        `SELECT f.house_slug, f.follower_id FROM known_followers f
          WHERE f.announced_at IS NULL
            AND (f.verified_at IS NOT NULL
                 OR EXISTS (SELECT 1 FROM known_followers_baseline b WHERE b.house_slug = f.house_slug))
          ORDER BY f.first_seen_at LIMIT ?`,
        [limit],
      )
      .map((r) => ({ houseSlug: r.house_slug, followerId: r.follower_id }));
  }

  /**
   * This row has been decided about — told, or deliberately not told.
   *
   * A row the value gate refused is as finished as one that was announced:
   * leaving it NULL would make the sweep reconsider it for ever, and a
   * decision that is re-made on every tick is not a decision.
   */
  markAnnounced(houseSlug: string, followerId: string): void {
    this.db.execute(
      'UPDATE known_followers SET announced_at = ? WHERE house_slug = ? AND follower_id = ? AND announced_at IS NULL',
      [this.now(), houseSlug, followerId],
    );
  }

  /** A VERIFIED unfollow: remove exactly this one row. No one else's. */
  noteVerifiedUnfollow(houseSlug: string, followerId: string): void {
    this.db.execute(
      'DELETE FROM known_followers WHERE house_slug = ? AND follower_id = ?',
      [houseSlug, followerId],
    );
  }

  /**
   * Reconcile this house's known set to `current`, and hand back the diff.
   * Added = new follower; disappeared = unfollow (deleted silently, no notification).
   *
   * The poll is now one source of follower truth among two. `guards` carries
   * the other: a name the AUTHOR has verified as following cannot be erased
   * by a list that merely fails to name it, and a name the author has
   * verified as unfollowed cannot be resurrected by a stale list. Absent
   * guards = the old poll-only behaviour, unchanged.
   *
   * ONE transaction, guards included: the guard reads and the cache writes
   * share a connection, so another process's verified revoke cannot land
   * between the guard's verdict and the write it authorized.
   */
  reconcile(
    houseSlug: string,
    current: readonly string[],
    guards?: VerifiedFollowerGuards,
  ): { added: string[]; removed: string[] } {
    const ts = this.now();
    return this.db.transaction(() => {
      const known = new Set(this.list(houseSlug));
      const now = new Set(current.filter((id) => id));
      const added: string[] = [];
      for (const id of now) {
        if (known.has(id)) continue;
        if (guards !== undefined && guards.isVerifiedFormerFollower(id)) {
          continue; // a stale list cannot resurrect a signed unfollow
        }
        this.db.execute(
          'INSERT OR IGNORE INTO known_followers (house_slug, follower_id, first_seen_at) VALUES (?, ?, ?)',
          [houseSlug, id, ts],
        );
        added.push(id);
      }
      const removed: string[] = [];
      for (const id of known) {
        if (now.has(id)) continue;
        if (guards !== undefined && guards.isVerifiedFollower(id)) {
          continue; // a list that fails to name them cannot erase a signed follow
        }
        this.db.execute('DELETE FROM known_followers WHERE house_slug = ? AND follower_id = ?', [houseSlug, id]);
        removed.push(id);
      }
      return { added, removed }; // the diff the cache actually took, guards included
    });
  }
}

/**
 * Guards derived from the adjudicated relation projection, SCOPED TO ONE
 * HOUSE: the cache row and the poll are both per-house, so the facts that
 * outrank them are per-house too. A follower the author verified as following
 * AT THIS HOUSE is sticky here; a revoke verified at THIS HOUSE blocks
 * resurrection here — but H2's stale list must not consult H1's edges. With a
 * house-agnostic union, a follow at H1 plus a revoke at H2 would leave H2's
 * list able to resurrect the follower.
 */
export interface VerifiedFollowerGuards {
  isVerifiedFollower(id: string): boolean;
  isVerifiedFormerFollower(id: string): boolean;
}

/**
 * The guards a root should hand the poll, resolved per house from the pins.
 *
 * Lives here rather than at the root so it can be tested with a real database
 * instead of only through a plugin boot: the previous shape left
 * `makeVerifiedFollowerGuards` exported with no caller anywhere, the poll
 * running unguarded, and nothing red.
 *
 * A house nobody has pinned gets guards that protect nothing — there are no
 * verified facts to outrank its list, so the poll behaves as it always did.
 * Scoping by the pinned key is the point: a follow verified at one house must
 * not protect a row a different house failed to name.
 */
export function houseScopedVerifiedGuards(
  db: HostDb,
  ownerPopclawId: string,
  slugOf: (origin: string) => string,
): (house: HouseRef) => VerifiedFollowerGuards {
  return (house) => {
    const pins = db.queryAll<{ origin: string; house_key: string }>(
      'SELECT origin, house_key FROM house_binding_pin',
    );
    const pinned = pins.find((row) => slugOf(row.origin) === house.slug);
    if (pinned === undefined) {
      return { isVerifiedFollower: () => false, isVerifiedFormerFollower: () => false };
    }
    return makeVerifiedFollowerGuards(db, ownerPopclawId, pinned.house_key);
  };
}

export function makeVerifiedFollowerGuards(
  db: HostDb,
  ownerPopclawId: string,
  houseKey: string,
): VerifiedFollowerGuards {
  const rows = (id: string) =>
    db.queryAll<{ state: string }>(
      'SELECT state FROM relation_edges WHERE follower_popclaw_id = ? AND followee_popclaw_id = ? AND house_key = ?',
      [id, ownerPopclawId, houseKey],
    );
  return {
    isVerifiedFollower: (id) => rows(id).some((r) => r.state === 'following'),
    isVerifiedFormerFollower: (id) => {
      const all = rows(id);
      return all.length > 0 && all.every((r) => r.state === 'revoked');
    },
  };
}

/**
 * Insert cache rows for edges the projection already adjudicated but the
 * cache never saw — a database that carried adjudicated edges across an
 * upgrade has no cache row for them, the same-CID replay is INSERT OR
 * IGNORE'd, and the drain only takes unapplied attempts, so the bridge never
 * fires. This pass reads the ALREADY-ADJUDICATED projection and inserts what
 * is missing: no re-broadcast, no notifications, no pretending they are new.
 *
 * Not witnessed, therefore: this pass did not see any of these declarations
 * arrive — it is reading rows some earlier build committed, about follows of
 * unknown age. They wait for the baseline exactly as they do today, which is
 * the whole difference between filling a gap in a cache and introducing
 * somebody.
 */
export function catchUpVerifiedFollowersIntoCache(
  db: HostDb,
  ownerPopclawId: string,
  slugOfHouseKey: (houseKey: string) => string | undefined,
  store: KnownFollowersStore,
): number {
  const edges = db.queryAll<{ house_key: string; follower_popclaw_id: string }>(
    "SELECT DISTINCT house_key, follower_popclaw_id FROM relation_edges WHERE followee_popclaw_id = ? AND state = 'following'",
    [ownerPopclawId],
  );
  let n = 0;
  for (const e of edges) {
    const slug = slugOfHouseKey(e.house_key);
    if (slug === undefined) continue;
    if (store.noteVerifiedFollow(slug, e.follower_popclaw_id, { witnessed: false })) n += 1;
  }
  return n;
}

export interface HouseRef {
  readonly slug: string;
  readonly baseUrl: string;
}

export interface FollowerSyncDeps {
  readonly ownerPopclawId: string;
  readonly store: KnownFollowersStore;
  readonly notifier: Notifier;
  /** The host of the gate. `followed_you` is an explicit exemption class — new followers are almost always outside the graph. */
  readonly socialGraph: GraphLike;
  readonly socialLog?: SocialLogRecorder;
  /** Name resolution (bond book / world stream). Falls back to the id prefix if not found. */
  readonly displayName?: (popclawId: string) => string;
  /**
   * Bond context (bonds/bond-context.ts). New followers are mostly strangers →
   * returns an empty string → no line emitted; only the small subset of
   * old acquaintances following you back is worth a mention. If not injected, never emits a line.
   */
  readonly bondContext?: (popclawId: string, beforeTs?: number) => string;
  /**
   * External standing for the "a well-known name followed you" tag. Absent =
   * the tag simply doesn't appear; this sync has never needed it to work.
   */
  readonly verifiedFollowers?: {
    refresh(popclawId: string, houseOrigin?: string): Promise<void>;
    getFresh(popclawId: string, houseOrigin?: string): number | undefined;
  };
  /** Bond-book lookup — used by the gatekeeper (someone you blocked following you shouldn't ring a bell, ADR-0046). Not injected = no block filtering. */
  readonly bondOf?: (popclawId: string) => { tier: BondTier } | null | undefined;
  /** Capture this house owner once per sync; never replace its generation after an await. */
  readonly gateForHouse?: (house: HouseRef) => ActionGate;
  /**
   * This house refused the read because nothing has pinned it YET — the boot
   * race, not a broken install. Reported rather than only logged so the
   * service that owns the schedule can ask again in seconds instead of in
   * half an hour. Absent = the refusal is only logged, as before.
   */
  readonly onHouseNotYetTrusted?: (house: HouseRef) => void;
  /** Only a transient HTTP read failure can request a bounded scheduled retry. */
  readonly onHouseTransientReadFailure?: (house: HouseRef) => void;
  readonly fetch: typeof globalThis.fetch;
  /**
   * How a read at this house proves who is asking.
   *
   * Required, and a function of the house: who follows me is mine to ask
   * about, so every one of these requests carries an identity or does not
   * happen. There is no anonymous lane left — a house that does not do
   * identity reads answers a refusal here, not an empty list, because an
   * empty list is indistinguishable from "nobody follows you" and would
   * quietly retire every follower this client knows about.
   */
  readonly readAuthorityFor: (house: HouseRef) => ReadAuthority;
  readonly logger?: { info(m: string): void; warn(m: string): void };
  /** Composition guards from the author-verified edges; absent = poll-only. */
  readonly verifiedGuards?: (house: HouseRef) => VerifiedFollowerGuards;
}

class FollowerListHttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/**
 * `GET {baseUrl}/followers/{me}` → list of follower popclaw_ids.
 *
 * Carries proof that the caller holds this identity's key. Who follows whom
 * is the pair's business, so a house may only answer it to the person being
 * asked about — and that means this request must say who is asking, in a way
 * nobody else can say.
 *
 * The proof is the same one the personal stream already uses: it is minted
 * per request (about a minute of validity), the server checks that the
 * identity inside it matches the one in the path, and it is the mechanism
 * already running in production rather than a second thing to get wrong.
 *
 * The credential is not optional. Sending no header at all used to be the
 * answer for a house that had not asked for one — but an unauthenticated read
 * of a private list returns an empty array, and an empty array here is
 * indistinguishable from "nobody follows you". So a house whose declared
 * scheme this build cannot speak is refused BEFORE the request, loudly, rather
 * than answered with a silence that reads as an emptied social graph.
 *
 * Throws on failure; the caller logs the reason and skips this house.
 */
export async function fetchFollowers(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  ownerPopclawId: string,
  readAuth: ReadAuthority,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/followers/${encodeURIComponent(ownerPopclawId)}`;
  assertActionActive();
  const credential = await readAuth('relation-list');
  assertActionActive();
  if (!credential.ok) throw new ReadRefusedError(credential.refusal, credential.message);
  const resp = await fetchImpl(url, {
    signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS),
    headers: { ...credential.headers },
  });
  assertActionActive();
  // 403 is not 401: the key is fine, the question was about someone else.
  // Saying "unauthorized" for it would send a person to re-register a key
  // that was never the problem.
  if (resp.status === 403) throw new Error('FOLLOWER_LIST_NOT_OURS');
  if (!resp.ok) throw new FollowerListHttpError(resp.status);
  const body = (await resp.json()) as Array<{ popclaw_id?: string }>;
  assertActionActive();
  if (!Array.isArray(body)) throw new Error('followers response is not an array');
  return body.map((r) => r?.popclaw_id ?? '').filter((id) => id);
}

/**
 * Run one diff for one house. Returns this round's new followers (always empty on the first run).
 *
 * A fetch failure **throws directly**: treating a network hiccup as "everyone
 * unfollowed" would wipe the local set, and once things recover it would
 * announce every existing follower as new — that's the loudest kind of bug.
 */
export async function syncFollowersOnce(
  deps: FollowerSyncDeps,
  house: HouseRef,
): Promise<NewFollower[]> {
  const gate = deps.gateForHouse?.(house);
  return withAction(gate, async () => {
    const snapshot = await readFollowerSnapshot(deps, house, gate);
    const added = commitFollowerSnapshot(deps, house, snapshot, gate);
    return snapshot.news.filter((follower) => added.has(follower.followerId));
  });
}

interface FollowerSnapshot {
  readonly current: string[];
  readonly first: boolean;
  readonly news: NewFollower[];
}

/** Stage the diff without changing the baseline while enrichment can still await. */
async function readFollowerSnapshot(
  deps: FollowerSyncDeps, house: HouseRef, gate: ActionGate | undefined,
): Promise<FollowerSnapshot> {
  assertActionActive(gate);
  const current = await fetchFollowers(deps.fetch, house.baseUrl, deps.ownerPopclawId, deps.readAuthorityFor(house));
  assertActionActive(gate);
  const first = !deps.store.hasBaseline(house.slug);
  const known = new Set(deps.store.list(house.slug));
  const news = first ? [] : [...new Set(current)]
    .filter((id) => !known.has(id))
    .map((followerId) => ({ houseSlug: house.slug, followerId }));
  return { current, first, news };
}

function commitFollowerSnapshot(
  deps: FollowerSyncDeps, house: HouseRef, snapshot: FollowerSnapshot, gate: ActionGate | undefined,
): ReadonlySet<string> {
  assertActionActive(gate);
  const { added } = deps.store.reconcile(house.slug, snapshot.current, deps.verifiedGuards?.(house));
  if (snapshot.first) {
    assertActionActive(gate);
    // The snapshot's own membership, which is what the baseline was drawn
    // from — the rows reconcile just wrote from `current` plus the ones it
    // already found there. A row the house never named is outside the
    // baseline's meaning and keeps the announcement it is owed.
    deps.store.markBaseline(house.slug, snapshot.current);
    deps.logger?.info(
      `popclaw: followers baseline [${house.slug}] — ${snapshot.current.length} existing, not notifying (first run)`,
    );
  }
  return new Set(added);
}

/**
 * "So-and-so#sigil, #sigil followed you." If a name can't be resolved, report
 * just the sigil — never make one up, and never fall back to the id prefix:
 * when two strangers' id prefixes collide (both render as `@unknownP`), the
 * owner can't tell they're two different people.
 */
function nameOf(deps: FollowerSyncDeps, id: string): string {
  return displayPerson(id, deps.displayName?.(id));
}

/**
 * Rendered grouped by house across multiple houses (spec: messages carry a house tag).
 *
 * Bond context: for the subset of new followers who **already have content in
 * the bond book**, each gets its own line reading "they're in your bond book:
 * …" — an old acquaintance following you back is worth the owner knowing who
 * it is. A stranger new follower returns an empty string → no line emitted
 * (new followers are overwhelmingly strangers; forcing a line for each would
 * mean noise every 30 minutes). The trailing line here must include names:
 * one house's line can bundle several people, and without naming them there's no way to tell who's who.
 */
/**
 * ponytail: no longer on the delivery path — the L2 handoff leg renders every
 * tier uniformly through `renderNotifications`, so both host kinds show the
 * owner the same thing. Kept because this is the richer rendering (grouped by
 * house, one line per house instead of one per follower); wire it back in if
 * the per-item form ever reads badly with a burst of new followers.
 */
export function renderFollowedYou(deps: FollowerSyncDeps, news: readonly NewFollower[]): string {
  const lang = ownerLang();
  const byHouse = new Map<string, NewFollower[]>();
  for (const n of news) {
    const list = byHouse.get(n.houseSlug) ?? [];
    list.push(n);
    byHouse.set(n.houseSlug, list);
  }
  const lines: string[] = [];
  for (const [slug, list] of byHouse) {
    const names = list.map((n) => nameOf(deps, n.followerId));
    const countSuffix =
      list.length > 1 ? renderCopy(lang, 'social.followedYou.countSuffix', { count: String(list.length) }) : '';
    lines.push(
      renderCopy(lang, 'social.followedYou.line', {
        slug,
        names: names.join(renderCopy(lang, 'social.followedYou.nameSep')),
        countSuffix,
      }),
    );
    list.forEach((n, i) => {
      const ctx = deps.bondContext?.(n.followerId) ?? '';
      if (ctx) {
        const prefix = bondContextPrefix(lang);
        lines.push(
          `${prefix}${renderCopy(lang, 'social.followedYou.bondContext', {
            name: names[i]!,
            ctx: ctx.slice(prefix.length),
          })}`,
        );
      }
    });
  }
  return lines.join('\n');
}

/**
 * Each house owns its entire fetch → diff → profile → commit round. A slow or
 * cancelled house cannot block another house's progress. Await every real
 * operation so the caller can drain this round before releasing its owners.
 * Returns the number queued for the existing L2 handoff delivery path.
 */
interface EnrichedFollower {
  readonly follower: NewFollower;
  readonly bondLine: string;
  readonly verifiedFollowerCount: number | undefined;
}

/**
 * Tell the owner about one new follower, exactly once, the same way however
 * it was learned.
 *
 * There are two sources now. The poll below diffs `GET /followers/:me` every
 * half hour; a house that delivers ordered relations puts the original on the
 * personal stream and the read bridge has it in seconds. They must announce
 * IDENTICALLY — a follow noticed by the fast path and re-rendered by the slow
 * one would read as two different events about the same person.
 */
function announceFollower(deps: FollowerSyncDeps, enriched: EnrichedFollower, gate?: ActionGate): void {
  const { follower, bondLine, verifiedFollowerCount } = enriched;
  assertActionActive(gate);
  deps.notifier.enqueue({
    level: 'L2',
    kind: 'followed_you',
    payload: {
      followerPopclawId: follower.followerId,
      houseSlug: follower.houseSlug,
      ...(bondLine ? { bondLine } : {}),
      ...(verifiedFollowerCount ? { verifiedFollowerCount } : {}),
    },
  });
  assertActionActive(gate);
  safeRecord(deps.socialLog, {
    kind: 'followed_you',
    actor: { id: follower.followerId, name: deps.displayName?.(follower.followerId) ?? '' },
  });
  deps.store.markAnnounced(follower.houseSlug, follower.followerId);
}

/**
 * Announce followers the RELATION path has already committed.
 *
 * The bridge writes the cache row inside the apply transaction, which is the
 * only place that can know the row is new — and is also the one place nothing
 * may notify from. So it queues them and this runs on the drain, through the
 * same gate, the same enrichment and the same L2 pipeline the poll uses.
 *
 * Wiring reception without this is a silent regression, not a gap: the fast
 * path updates the known set, the poll then finds no difference, and the
 * owner simply stops being told that anyone followed them.
 */
export async function announceVerifiedFollowers(
  deps: FollowerSyncDeps,
  news: readonly NewFollower[],
  houseBaseUrl?: (houseSlug: string) => string | undefined,
): Promise<number> {
  let announced = 0;
  for (const follower of news) {
    try {
      const baseUrl = houseBaseUrl?.(follower.houseSlug);
      // New followers are exempt from the graph gate; an explicit block
      // remains a hard veto — same rule as the poll, not a second policy.
      if (!passesRelativeValueGate('followed_you', follower.followerId, deps.socialGraph, undefined,
        personVerdict(follower.followerId, { bondOf: deps.bondOf }))) {
        // Decided, and the decision was no. Marked so the sweep stops
        // reconsidering it — a choice re-made every tick is not a choice.
        deps.store.markAnnounced(follower.houseSlug, follower.followerId);
        continue;
      }
      const bondLine = deps.bondContext?.(follower.followerId) ?? '';
      if (baseUrl !== undefined) await deps.verifiedFollowers?.refresh(follower.followerId, baseUrl);
      const verifiedFollowerCount = baseUrl !== undefined
        ? deps.verifiedFollowers?.getFresh(follower.followerId, baseUrl)
        : undefined;
      announceFollower(deps, { follower, bondLine, verifiedFollowerCount });
      announced += 1;
    } catch (err) {
      if (!(err instanceof ActionInactiveError)) {
        deps.logger?.warn(`popclaw: verified-follower announcement failed [${follower.houseSlug}] — ${String(err)}`);
      }
    }
  }
  if (announced) deps.logger?.info(`popclaw: followed_you n=${announced} → queued (L2, from the relation stream)`);
  return announced;
}

export async function syncFollowers(
  deps: FollowerSyncDeps,
  houses: readonly HouseRef[],
): Promise<number> {
  const counts = await Promise.all(houses.map(async (house) => {
    try {
      const gate = deps.gateForHouse?.(house);
      return await withAction(gate, async () => {
        const snapshot = await readFollowerSnapshot(deps, house, gate);
        const ready: { follower: NewFollower; bondLine: string; verifiedFollowerCount: number | undefined }[] = [];
        for (const follower of snapshot.news) {
          assertActionActive(gate);
          // New followers are exempt from the graph gate; an explicit block
          // remains a hard veto. Enrichment never promotes this L2 event.
          if (!passesRelativeValueGate('followed_you', follower.followerId, deps.socialGraph, undefined,
            personVerdict(follower.followerId, { bondOf: deps.bondOf }))) continue;
          const bondLine = deps.bondContext?.(follower.followerId) ?? '';
          await deps.verifiedFollowers?.refresh(follower.followerId, house.baseUrl);
          assertActionActive(gate);
          const verifiedFollowerCount = deps.verifiedFollowers?.getFresh(follower.followerId, house.baseUrl);
          ready.push({ follower, bondLine, verifiedFollowerCount });
        }

        // No awaits from here through the local writes. A cancelled profile
        // read must not consume the diff or erase an existing follower set.
        const added = commitFollowerSnapshot(deps, house, snapshot, gate);
        // Another round may have committed while profiles were pending. Only
        // the round which actually adds a follower may enqueue that fact.
        const committed = ready.filter(({ follower }) => added.has(follower.followerId));
        for (const enriched of committed) announceFollower(deps, enriched, gate);
        return committed.length;
      });
    } catch (err) {
      if (!(err instanceof ActionInactiveError)) {
        if (isHouseNotYetTrusted(err)) deps.onHouseNotYetTrusted?.(house);
        if (err instanceof FollowerListHttpError && (err.status === 429 || err.status >= 500))
          deps.onHouseTransientReadFailure?.(house);
        deps.logger?.warn(`popclaw: followers sync failed [${house.slug}] — ${String(err)}`);
      }
      return 0;
    }
  }));
  const count = counts.reduce((sum, n) => sum + n, 0);
  if (count) deps.logger?.info(`popclaw: followed_you n=${count} → queued (L2)`);
  return count;
}
