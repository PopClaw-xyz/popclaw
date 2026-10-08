/**
 * pending_follows (migration 023) — follow intents pulled from the canvas,
 * capped, surfaced to the owner in batches, and driven to a terminal status.
 *
 * A ➕
 * is credited to the READER who clicked it, named by the reader pass their
 * browser holds, so the intents a plugin pulls are ITS OWNER's clicks —
 * wherever they were made. An author who never appeared in this machine's own
 * papers is therefore ordinary, not suspicious, and the local author set is
 * only a source of better display material. The trust anchor moved to the
 * canvas: an unpaired click is never credited to anyone, so nothing arrives
 * here that the owner did not click. What still gets binned is junk no reader
 * could have produced — ids that are not popclaw ids, labels that are not names.
 *
 * Time-unit split (documented once, honored everywhere):
 * - first_ts / latest_ts are unix MILLISECONDS — the canvas speaks ms.
 * - first_surfaced_ts is unix SECONDS — the plugin house clock (injectable
 *   `now`) speaks seconds, like the bonds tables. Do not mix them.
 */
import type { HostDb } from '../host/host-db.js';
import { looksLikeBase58Id } from '../identity/person-resolver.js';

/**
 * One follow intent as pulled from the canvas. Field names and types are
 * byte-identical to the canvas side (apps/popclaw-canvas/src/intent-store.ts).
 */
export interface FollowIntentRow {
  owner_popclaw_id: string;
  followee_popclaw_id: string;
  followee_label: string;
  /** Unix ms — first click of this (owner, followee) intent; never reset. */
  first_ts: number;
  /** Unix ms — most recent click. */
  latest_ts: number;
  click_count: number;
}

export interface AbsorbReport {
  /** Intents that landed as pending rows in this call (new rows + refreshes). */
  absorbed: number;
  /** Plugin-side display names of followees dropped because the owner already follows them. */
  droppedFollowed: string[];
  /** Pending rows deleted because this batch pushed the pending total over the cap. */
  overflow: number;
}

/** A pending row, in FollowIntentRow shape plus the persisted extras. */
export interface PendingFollowRow extends FollowIntentRow {
  /** Unix seconds; null until the batch is claimed by claimSurface. */
  first_surfaced_ts: number | null;
  display_name: string;
  descriptor: string | null;
}

interface Row {
  followee_popclaw_id: string;
  display_name: string;
  descriptor: string | null;
  source_issue_date: string | null;
  first_ts: number;
  latest_ts: number;
  first_surfaced_ts: number | null;
  status: string;
}

const DEFAULT_CAP = 20;

/** A display name has no business being a paragraph; anything longer is junk. */
const LABEL_MAX = 80;

/**
 * The display name a foreign intent carries, or null when the label is not a
 * name at all. The label is link-holder input: it is shown to the owner in a
 * one-line summary, so a blank, an oversized blob or anything carrying control
 * characters (which would break that line apart) never lands.
 */
function foreignDisplayName(label: string): string | null {
  if (label.length > LABEL_MAX) return null;
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null; // a name has no control characters in it
  }
  return label.trim() || null;
}

/** What the owner will be shown about one followee, wherever it came from. */
interface FolloweeMeta {
  display_name: string;
  descriptor: string | null;
  /** The local issue this author appeared in; null for a foreign paper. */
  issue_date: string | null;
}

export class PendingFollowStore {
  constructor(
    private readonly db: HostDb,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /**
   * Absorb a pulled batch, one intent at a time:
   * - followee in the (unexpired) local author set → the owner's own paper
   *   supplies name, descriptor and issue, as it always has;
   * - followee not in it → the reader met them on someone ELSE's paper (owner
   *   ruling 2026-09-13): the intent's own label becomes the display name and
   *   the descriptor says where it came from, PROVIDED both look like a
   *   popclaw id and a name — junk is still discarded silently;
   * - owner already follows the followee → upsert status='dropped_followed'
   *   (kept as a record, never counted against the cap);
   * - otherwise upsert pending.
   * Re-absorbing keeps the row's first first_ts and its surfaced anchor, and
   * refreshes latest_ts (re-clicks are activity, so refreshes count as absorbed).
   * One status is terminal against re-absorption: a `confirmed` row — the owner
   * already ran the follow — only gets its latest_ts refreshed and is reported
   * in NEITHER counter (not `absorbed`, not `droppedFollowed`). A later click on
   * a ➕ that is already honoured is a no-op, not a demotion back to `pending`
   * and not a fresh batch to announce. `pending` / `dropped_followed` /
   * `expired` rows re-absorb as usual.
   * Cap: after landing, if the pending total (pre-existing rows included)
   * exceeds cap, the smallest-first_ts rows are deleted and counted as overflow.
   */
  absorb(
    intents: FollowIntentRow[],
    opts: {
      authors: ReadonlyMap<string, { display_name: string; descriptor: string | null; issue_date: string }>;
      followsIn: (popclawId: string) => boolean;
      cap?: number;
      /** Where a foreign followee came from, in the owner's language; the
       *  caller resolves the copy (this module holds no lexicon). */
      foreignDescriptor?: string | null;
    },
  ): AbsorbReport {
    const cap = opts.cap ?? DEFAULT_CAP;
    const metaFor = (it: FollowIntentRow): FolloweeMeta | null => {
      const author = opts.authors.get(it.followee_popclaw_id);
      if (author) return author;
      if (!looksLikeBase58Id(it.followee_popclaw_id)) return null;
      const name = foreignDisplayName(it.followee_label);
      if (!name) return null;
      return { display_name: name, descriptor: opts.foreignDescriptor ?? null, issue_date: null };
    };
    return this.db.transaction((tx) => {
      let absorbed = 0;
      const droppedFollowed: string[] = [];
      for (const it of intents) {
        const author = metaFor(it);
        if (!author) continue; // junk — no id to follow, or no name to show
        // A confirmed row is done: the owner ran the follow and a real
        // FollowDeclared exists. Re-clicks only refresh the activity clock —
        // `status = excluded.status` below would otherwise demote it to
        // pending and re-offer a follow the owner already made.
        const current = tx.queryOne<{ status: string }>(
          'SELECT status FROM pending_follows WHERE followee_popclaw_id = ?',
          [it.followee_popclaw_id],
        )?.status;
        if (current === 'confirmed') {
          tx.execute('UPDATE pending_follows SET latest_ts = ? WHERE followee_popclaw_id = ?', [
            it.latest_ts,
            it.followee_popclaw_id,
          ]);
          continue;
        }
        const followed = opts.followsIn(it.followee_popclaw_id);
        if (followed) droppedFollowed.push(author.display_name);
        else absorbed++;
        tx.execute(
          `INSERT INTO pending_follows
             (followee_popclaw_id, display_name, descriptor, source_issue_date, first_ts, latest_ts, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(followee_popclaw_id) DO UPDATE SET
             display_name = excluded.display_name,
             descriptor = excluded.descriptor,
             source_issue_date = excluded.source_issue_date,
             latest_ts = excluded.latest_ts,
             status = excluded.status`,
          [
            it.followee_popclaw_id,
            author.display_name,
            author.descriptor,
            author.issue_date,
            it.first_ts,
            it.latest_ts,
            followed ? 'dropped_followed' : 'pending',
          ],
        );
      }
      let overflow = 0;
      const pendingCount = tx.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM pending_follows WHERE status = 'pending'`,
      )?.n ?? 0;
      if (pendingCount > cap) {
        const evicted = tx
          .queryAll<{ followee_popclaw_id: string }>(
            `SELECT followee_popclaw_id FROM pending_follows WHERE status = 'pending'
             ORDER BY first_ts ASC, followee_popclaw_id ASC LIMIT ?`,
            [pendingCount - cap],
          )
          .map((r) => r.followee_popclaw_id);
        const del = tx.execute(
          `DELETE FROM pending_follows WHERE status = 'pending' AND followee_popclaw_id IN (${evicted.map(() => '?').join(',')})`,
          evicted,
        );
        overflow = del.changes;
      }
      return { absorbed, droppedFollowed, overflow };
    });
  }

  /** Pending rows, oldest first (stable order for numbered lists). */
  listPending(): PendingFollowRow[] {
    const rows = this.db.queryAll<Row>(
      `SELECT * FROM pending_follows WHERE status = 'pending'
       ORDER BY first_ts ASC, followee_popclaw_id ASC`,
    );
    return rows.map((r) => ({
      // Not persisted here: this social DB is single-owner (self), and the
      // canvas-side click counter does not survive the pull. Documented sentinels.
      owner_popclaw_id: '',
      click_count: 0,
      followee_popclaw_id: r.followee_popclaw_id,
      // FollowIntentRow shape requires the label field; the row's display name
      // is the persisted one (the local author set's, or the vetted label of a
      // foreign paper) — alias it rather than keep a second copy.
      followee_label: r.display_name,
      first_ts: r.first_ts,
      latest_ts: r.latest_ts,
      first_surfaced_ts: r.first_surfaced_ts,
      display_name: r.display_name,
      descriptor: r.descriptor,
    }));
  }

  /**
   * MIN(first_ts) (unix ms) over every un-surfaced pending/dropped row — the
   * batch anchor the doorbell's first-click debounce counts from. null = no
   * batch is waiting (or only surfaced/expired/confirmed rows remain).
   */
  unreportedFirstTs(): number | null {
    return (
      this.db.queryOne<{ m: number | null }>(
        `SELECT MIN(first_ts) AS m FROM pending_follows
         WHERE first_surfaced_ts IS NULL AND status IN ('pending', 'dropped_followed')`,
      )?.m ?? null
    );
  }

  /**
   * dropped_followed rows whose batch has never been surfaced — the "already
   * in your follows" micro-notice owes the owner these names exactly once.
   */
  hasDroppedUnreported(): Array<{ display_name: string }> {
    return this.db.queryAll<{ display_name: string }>(
      `SELECT display_name FROM pending_follows
       WHERE status = 'dropped_followed' AND first_surfaced_ts IS NULL
       ORDER BY first_ts ASC, followee_popclaw_id ASC`,
    );
  }

  /**
   * Atomically claim every un-surfaced pending/dropped row as one batch
   * (single UPDATE = the critical section; two surfacing paths stay mutually
   * exclusive). Returns the number of rows claimed; 0 means someone else won.
   */
  claimSurface(nowSec: number = this.now()): number {
    return this.db.execute(
      `UPDATE pending_follows SET first_surfaced_ts = ?
       WHERE first_surfaced_ts IS NULL AND status IN ('pending', 'dropped_followed')`,
      [nowSec],
    ).changes;
  }

  /** pending → confirmed. Only call after declareFollow actually succeeded. */
  markConfirmed(popclawId: string): void {
    this.db.execute(
      `UPDATE pending_follows SET status = 'confirmed' WHERE followee_popclaw_id = ? AND status = 'pending'`,
      [popclawId],
    );
  }

  /**
   * pending/dropped → expired for rows whose first_ts is older than the cutoff.
   * cutoff is unix SECONDS (house clock); first_ts is ms — converted here.
   * TTL counts from the first click, so re-clicks never reset the clock.
   */
  expireOlderThan(cutoffSec: number): number {
    return this.db.execute(
      `UPDATE pending_follows SET status = 'expired'
       WHERE status IN ('pending', 'dropped_followed') AND first_ts < ?`,
      [cutoffSec * 1000],
    ).changes;
  }
}
