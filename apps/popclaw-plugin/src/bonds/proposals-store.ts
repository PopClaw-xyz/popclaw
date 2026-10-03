/**
 * bond_proposals (migration 009) — tier up/down-grade proposals the dreamer
 * generates and the master confirms (1 agree / 2 disagree / 3 need more thought). Local-private
 * (ADR-0011/0022). Design: docs/superpowers/plans/2026-06-15-bond-book-report-review.md §E1.
 */
import type { HostDb } from '../host/host-db.js';
import type { BondTier } from './bond-tier.js';

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'deferred';

export interface BondProposal {
  id: number;
  popclawId: string;
  fromTier: BondTier;
  toTier: BondTier;
  rationale: string;
  status: ProposalStatus;
  createdAt: number;
  decidedAt: number | null;
}

interface ProposalRow {
  id: number;
  popclaw_id: string;
  from_tier: string;
  to_tier: string;
  rationale: string;
  status: string;
  created_at: number;
  decided_at: number | null;
}

function rowToProposal(r: ProposalRow): BondProposal {
  return {
    id: r.id,
    popclawId: r.popclaw_id,
    fromTier: r.from_tier as BondTier,
    toTier: r.to_tier as BondTier,
    rationale: r.rationale,
    status: r.status as ProposalStatus,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export class ProposalsStore {
  constructor(
    private readonly db: HostDb,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  add(p: { popclawId: string; fromTier: BondTier; toTier: BondTier; rationale: string }): void {
    this.db.execute(
      `INSERT INTO bond_proposals (popclaw_id, from_tier, to_tier, rationale, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [p.popclawId, p.fromTier, p.toTier, p.rationale, this.now()],
    );
  }

  /** Pending proposals, oldest first (stable order for numbered review display). */
  listPending(): BondProposal[] {
    return this.db
      .queryAll<ProposalRow>(
        `SELECT * FROM bond_proposals WHERE status = 'pending' ORDER BY created_at ASC, id ASC`,
        [],
      )
      .map(rowToProposal);
  }

  get(id: number): BondProposal | null {
    const row = this.db.queryOne<ProposalRow>('SELECT * FROM bond_proposals WHERE id = ?', [id]);
    return row ? rowToProposal(row) : null;
  }

  /** Resolve a proposal; returns the updated proposal, or null if unknown. */
  decide(id: number, status: Exclude<ProposalStatus, 'pending'>): BondProposal | null {
    if (!this.get(id)) return null;
    this.db.execute(`UPDATE bond_proposals SET status = ?, decided_at = ? WHERE id = ?`, [
      status,
      this.now(),
      id,
    ]);
    return this.get(id);
  }

  /** Most recent proposal for (person, toTier) regardless of status — for dedupe/cooldown. */
  lastFor(popclawId: string, toTier: BondTier): BondProposal | null {
    const row = this.db.queryOne<ProposalRow>(
      `SELECT * FROM bond_proposals WHERE popclaw_id = ? AND to_tier = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [popclawId, toTier],
    );
    return row ? rowToProposal(row) : null;
  }

  /**
   * Whether a live pending proposal exists for (person, toTier) — the live
   * check L2 delivery runs before rendering: a
   * proposal decided between enqueue and hand-off must not reach the owner as
   * a fresh suggestion. The fact stays durable behind `/popclaw review`.
   */
  hasPendingFor(popclawId: string, toTier: BondTier): boolean {
    const row = this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bond_proposals WHERE popclaw_id = ? AND to_tier = ? AND status = 'pending'`,
      [popclawId, toTier],
    );
    return (row?.n ?? 0) > 0;
  }

  /**
   * A manual tier move settles that person's pending proposals: the owner
   * answering the tier question by hand IS an answer — the proposal the
   * action carried out is `accepted`, any other
   * pending suggestion for the same person is overruled (`rejected`). Other
   * people's proposals are untouched. Returns how many were settled.
   */
  settlePendingForManualTier(popclawId: string, tier: BondTier): number {
    const mine = this.listPending().filter((p) => p.popclawId === popclawId);
    for (const p of mine) {
      this.decide(p.id, p.toTier === tier ? 'accepted' : 'rejected');
    }
    return mine.length;
  }
}
