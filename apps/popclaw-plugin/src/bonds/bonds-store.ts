import type { HostDb } from '../host/host-db.js';
import { maxTier, tierRank, type BondTier } from './bond-tier.js';

const MAX_RECENT_INTERACTIONS = 50; // cap on stored outgoing-interaction timestamps per bond

export interface Bond {
  popclawId: string;
  tier: BondTier;
  tierSource: 'auto' | 'manual';
  peakTier: BondTier;
  nickname: string;
  remarkName: string;
  description: string;
  tags: string[];
  contact: Record<string, unknown>;
  followed: boolean;
  lastInteractionTs: number | null;
  lastDreamTs: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BondDynamic {
  ts: number;
  summary: string;
  isMilestone: boolean;
}

interface BondRow {
  popclaw_id: string;
  tier: string;
  tier_source: string;
  peak_tier: string;
  nickname: string;
  remark_name: string;
  description: string;
  tags: string;
  contact_json: string;
  followed: number;
  last_interaction_ts: number | null;
  last_dream_ts: number | null;
  created_at: number;
  updated_at: number;
}

function rowToBond(r: BondRow): Bond {
  return {
    popclawId: r.popclaw_id,
    tier: r.tier as BondTier,
    tierSource: r.tier_source as 'auto' | 'manual',
    peakTier: r.peak_tier as BondTier,
    nickname: r.nickname,
    remarkName: r.remark_name,
    description: r.description,
    tags: JSON.parse(r.tags) as string[],
    contact: JSON.parse(r.contact_json) as Record<string, unknown>,
    followed: r.followed === 1,
    lastInteractionTs: r.last_interaction_ts,
    lastDreamTs: r.last_dream_ts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class BondsStore {
  constructor(
    private readonly db: HostDb,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  get(popclawId: string): Bond | null {
    const row = this.db.queryOne<BondRow>('SELECT * FROM bonds WHERE popclaw_id = ?', [popclawId]);
    return row ? rowToBond(row) : null;
  }

  /** Create at 'acquaintance' if absent ("a row opens the moment you act"); return existing otherwise. */
  ensure(popclawId: string): Bond {
    const existing = this.get(popclawId);
    if (existing) return existing;
    const ts = this.now();
    this.db.execute(
      `INSERT INTO bonds (popclaw_id, tier, tier_source, peak_tier, created_at, updated_at)
       VALUES (?, 'acquaintance', 'auto', 'acquaintance', ?, ?)`,
      [popclawId, ts, ts],
    );
    return this.get(popclawId)!;
  }

  /** List bonds, optionally floored by tier, ordered by tier rank desc then recency. */
  list(opts: { minTier?: BondTier; limit?: number } = {}): Bond[] {
    const rows = this.db.queryAll<BondRow>('SELECT * FROM bonds', []);
    const minRank = opts.minTier ? tierRank(opts.minTier) : -1;
    const bonds = rows
      .map(rowToBond)
      .filter((b) => tierRank(b.tier) >= minRank)
      .sort(
        (a, b) =>
          tierRank(b.tier) - tierRank(a.tier) ||
          (b.lastInteractionTs ?? 0) - (a.lastInteractionTs ?? 0),
      );
    return opts.limit ? bonds.slice(0, opts.limit) : bonds;
  }

  /** Explicitly set tier (master or dreamer-approved). Raises peak_tier monotonically. */
  setTier(popclawId: string, tier: BondTier, source: 'auto' | 'manual'): Bond {
    const current = this.ensure(popclawId);
    const peak = maxTier(current.peakTier, tier);
    const ts = this.now();
    this.db.execute(
      `UPDATE bonds SET tier = ?, tier_source = ?, peak_tier = ?, updated_at = ? WHERE popclaw_id = ?`,
      [tier, source, peak, ts, popclawId],
    );
    return this.get(popclawId)!;
  }

  /**
   * Record an outgoing interaction ("a row opens the moment you act"): create
   * the bond at 'acquaintance' if absent, bump last_interaction_ts, and
   * append the ts to a capped rolling window (newest
   * MAX_RECENT_INTERACTIONS) feeding the closeness signal. Never changes
   * tier.
   */
  recordInteraction(popclawId: string, ts: number = this.now()): Bond {
    this.ensure(popclawId);
    const row = this.db.queryOne<{ recent_interactions_json: string }>(
      'SELECT recent_interactions_json FROM bonds WHERE popclaw_id = ?',
      [popclawId],
    );
    const recent = (row ? (JSON.parse(row.recent_interactions_json) as number[]) : []).concat(ts);
    const trimmed = recent.slice(-MAX_RECENT_INTERACTIONS);
    this.db.execute(
      `UPDATE bonds SET last_interaction_ts = ?, recent_interactions_json = ?, updated_at = ? WHERE popclaw_id = ?`,
      [ts, JSON.stringify(trimmed), ts, popclawId],
    );
    return this.get(popclawId)!;
  }

  /** Count of the master's outgoing interactions with this bond at/after `sinceTs`. */
  recentInteractionCount(popclawId: string, sinceTs: number): number {
    const row = this.db.queryOne<{ recent_interactions_json: string }>(
      'SELECT recent_interactions_json FROM bonds WHERE popclaw_id = ?',
      [popclawId],
    );
    if (!row) return 0;
    return (JSON.parse(row.recent_interactions_json) as number[]).filter((t) => t >= sinceTs).length;
  }

  /**
   * Advance the dreamer's incremental cursor to the latest post ts processed.
   * Bookkeeping only — deliberately does NOT bump updated_at (it isn't a content
   * change; setKnowledge already bumped it this pass). ensure() keeps the method
   * safe to call standalone.
   */
  markDreamed(popclawId: string, ts: number): void {
    this.ensure(popclawId);
    this.db.execute(`UPDATE bonds SET last_dream_ts = ? WHERE popclaw_id = ?`, [ts, popclawId]);
  }

  /** Project follow state (signed FollowDeclared stays the source of truth). */
  setFollowed(popclawId: string, followed: boolean): Bond {
    this.ensure(popclawId);
    this.db.execute(`UPDATE bonds SET followed = ?, updated_at = ? WHERE popclaw_id = ?`, [
      followed ? 1 : 0,
      this.now(),
      popclawId,
    ]);
    return this.get(popclawId)!;
  }

  /** Store the followee's own declared nickname (from /v1/resolve at follow time). */
  setNickname(popclawId: string, nickname: string): Bond {
    this.ensure(popclawId);
    this.db.execute(`UPDATE bonds SET nickname = ?, updated_at = ? WHERE popclaw_id = ?`, [
      nickname,
      this.now(),
      popclawId,
    ]);
    return this.get(popclawId)!;
  }

  /**
   * A nickname resolved through identity resolution is **backfilled** into
   * the bond book — the bond book is the single source of truth for local
   * social assets: anyone I know, their nickname should be recorded here,
   * instead of asking the lore-house fresh every time and throwing it away
   * after.
   *
   * How this differs from setNickname (this is the entire reason it exists):
   *  - Fill-empty-only: only writes when `nickname = ''`. Any existing value
   *    is left untouched (if the owner hand-edited it, or if what's stored
   *    was their self-reported nickname at the time, neither should be
   *    overwritten by an incidental identity resolution).
   *  - Never creates a row: if the row doesn't exist, this does nothing.
   *    Creating the row is the job of "a row opens the moment you act"
   *    (recordInteraction / setFollowed) — resolving someone's identity once
   *    shouldn't grow a row for a total stranger in the bond book.
   *
   * Returns whether it actually wrote (callers need to observe this; the
   * write-back is a silent side channel).
   */
  fillNickname(popclawId: string, nickname: string): boolean {
    const name = nickname.trim();
    if (!name) return false;
    const r = this.db.execute(
      `UPDATE bonds SET nickname = ?, updated_at = ? WHERE popclaw_id = ? AND nickname = ''`,
      [name, this.now(), popclawId],
    );
    return r.changes > 0;
  }

  /**
   * The startup nickname-sync worklist: **every bond-book row** (ordered by
   * most-recently-updated), not just the ones with an empty name.
   *
   * It used to only select `nickname = ''`, so a row where "the nickname slot
   * got occupied by a handle" would never make it onto the worklist (real
   * machine, 2026-07-30: host-b's row for `owl_scribe_7` sat stuck for two
   * days). A nickname is a name someone else self-reports and it can change;
   * what's stored locally is a cache — and a cache needs to stay correct, not
   * just get corrected once while it happens to be empty.
   */
  idsForNicknameSync(limit: number): string[] {
    const rows = this.db.queryAll<{ popclaw_id: string }>(
      `SELECT popclaw_id FROM bonds ORDER BY updated_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => r.popclaw_id);
  }

  /**
   * Unconditionally writes the nickname (the row must already exist; this
   * method never creates one). Same as what's stored → 0 changes → false, so
   * it never makes a pointless write. **Only for the nickname-sync path**;
   * a nickname learned in passing still goes through `fillNickname`
   * (fill-empty-only), so a one-off encounter can't clobber a name that was
   * already synced correctly. The `setNickname` call at follow time is a
   * different thing (it creates the row and returns the whole row) — don't
   * conflate the two.
   */
  syncNickname(popclawId: string, nickname: string): boolean {
    const name = nickname.trim();
    if (!name) return false;
    const r = this.db.execute(
      `UPDATE bonds SET nickname = ?, updated_at = ? WHERE popclaw_id = ? AND nickname <> ?`,
      [name, this.now(), popclawId, name],
    );
    return r.changes > 0;
  }

  /**
   * Idempotent: the same person + the same ts + the same line = the same
   * update, so a duplicate insert would be pointless.
   *
   * The write-back can be replayed (during a night digest, a batch of people
   * fails partway through → the token is retained → the agent resubmits the
   * whole batch), and a raw INSERT would grow the update list a string of
   * identical rows. This dedupe lives here rather than on the night-digest
   * side: every caller funnels through this one opening, so it only needs
   * fixing once (the dedupe key can't collide with a genuinely different
   * update — all three fields matching means it's the same one).
   */
  addDynamic(popclawId: string, dyn: BondDynamic): void {
    this.ensure(popclawId);
    this.db.execute(
      `INSERT INTO bond_dynamics (popclaw_id, ts, summary, is_milestone)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM bond_dynamics WHERE popclaw_id = ? AND ts = ? AND summary = ?
       )`,
      [popclawId, dyn.ts, dyn.summary, dyn.isMilestone ? 1 : 0, popclawId, dyn.ts, dyn.summary],
    );
  }

  recentDynamics(popclawId: string, limit: number): BondDynamic[] {
    const rows = this.db.queryAll<{ ts: number; summary: string; is_milestone: number }>(
      `SELECT ts, summary, is_milestone FROM bond_dynamics WHERE popclaw_id = ? ORDER BY ts DESC LIMIT ?`,
      [popclawId, limit],
    );
    return rows.map((r) => ({ ts: r.ts, summary: r.summary, isMilestone: r.is_milestone === 1 }));
  }

  /**
   * All not-yet-reported dynamics across every bond, joined with the person's
   * current tier + remark, newest first. The daily review reads this, then calls
   * markDynamicsReported() so each surfaces once.
   */
  unreportedDynamics(
    limit = 100,
  ): { id: number; popclawId: string; tier: BondTier; remarkName: string; ts: number; summary: string; isMilestone: boolean }[] {
    const rows = this.db.queryAll<{
      id: number; popclaw_id: string; tier: string; remark_name: string;
      ts: number; summary: string; is_milestone: number;
    }>(
      `SELECT d.id, d.popclaw_id, b.tier, b.remark_name, d.ts, d.summary, d.is_milestone
       FROM bond_dynamics d JOIN bonds b ON b.popclaw_id = d.popclaw_id
       WHERE d.reported = 0 ORDER BY d.ts DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id, popclawId: r.popclaw_id, tier: r.tier as BondTier, remarkName: r.remark_name,
      ts: r.ts, summary: r.summary, isMilestone: r.is_milestone === 1,
    }));
  }

  /** Mark dynamics as reported (shown in a review) so they don't surface again. */
  markDynamicsReported(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.execute(`UPDATE bond_dynamics SET reported = 1 WHERE id IN (${placeholders})`, ids);
  }

  /** Set AI/master knowledge + reindex this row's FTS entry. (Dreamer calls this later.) */
  setKnowledge(
    popclawId: string,
    k: { description?: string; tags?: string[]; remarkName?: string; contact?: Record<string, unknown> },
  ): Bond {
    const b = this.ensure(popclawId);
    const description = k.description ?? b.description;
    const tags = k.tags ?? b.tags;
    const remarkName = k.remarkName ?? b.remarkName;
    const contact = k.contact ?? b.contact;
    this.db.execute(
      `UPDATE bonds SET description = ?, tags = ?, remark_name = ?, contact_json = ?, updated_at = ? WHERE popclaw_id = ?`,
      [description, JSON.stringify(tags), remarkName, JSON.stringify(contact), this.now(), popclawId],
    );
    this.indexFts(popclawId);
    return this.get(popclawId)!;
  }

  /** (Re)write the FTS row for one bond. Contentless table → delete + insert. */
  private indexFts(popclawId: string): void {
    const b = this.get(popclawId);
    if (!b) return;
    this.db.execute(`DELETE FROM bonds_fts WHERE popclaw_id = ?`, [popclawId]);
    this.db.execute(
      `INSERT INTO bonds_fts (popclaw_id, remark_name, description, tags) VALUES (?, ?, ?, ?)`,
      [popclawId, b.remarkName, b.description, b.tags.join(' ')],
    );
  }

  /**
   * Coarse retrieval (stage 1); LLM refine is the caller's job. Sanitizes input
   * into FTS5 phrase literals so arbitrary tokens (quotes, parens, AND/OR, LLM
   * output) can't throw a syntax error; empty input → no results.
   */
  search(query: string, limit = 50): Bond[] {
    const terms = query
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, '""')}"`);
    if (terms.length === 0) return [];
    const rows = this.db.queryAll<{ popclaw_id: string }>(
      `SELECT popclaw_id FROM bonds_fts WHERE bonds_fts MATCH ? LIMIT ?`,
      [terms.join(' '), limit],
    );
    return rows.map((r) => this.get(r.popclaw_id)).filter((b): b is Bond => b !== null);
  }
}
