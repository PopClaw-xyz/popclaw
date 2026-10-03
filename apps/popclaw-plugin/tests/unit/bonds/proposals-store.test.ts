import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { ProposalsStore } from '../../../src/bonds/proposals-store.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

function freshStore(now = 1000): ProposalsStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  // bond_proposals carries a FK to bonds(popclaw_id) — seed both fixture people.
  db.execute(
    `INSERT INTO bonds (popclaw_id, tier, tier_source, peak_tier, created_at, updated_at) VALUES ('A','friend','auto','friend',1,1)`,
    [],
  );
  db.execute(
    `INSERT INTO bonds (popclaw_id, tier, tier_source, peak_tier, created_at, updated_at) VALUES ('B','friend','auto','friend',1,1)`,
    [],
  );
  return new ProposalsStore(db, () => now);
}

describe('ProposalsStore', () => {
  it('add + listPending returns the proposal (oldest first)', () => {
    const s = freshStore();
    s.add({ popclawId: 'A', fromTier: 'friend', toTier: 'close', rationale: 'busy' });
    const pending = s.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ popclawId: 'A', fromTier: 'friend', toTier: 'close', status: 'pending' });
    expect(typeof pending[0]!.id).toBe('number');
  });

  it('decide(accept) flips status + stamps decided_at; drops from pending', () => {
    const s = freshStore(5000);
    s.add({ popclawId: 'A', fromTier: 'friend', toTier: 'close', rationale: '' });
    const id = s.listPending()[0]!.id;
    const decided = s.decide(id, 'accepted');
    expect(decided).toMatchObject({ id, status: 'accepted', decidedAt: 5000 });
    expect(s.listPending()).toHaveLength(0);
  });

  it('decide on unknown id returns null', () => {
    expect(freshStore().decide(999, 'accepted')).toBeNull();
  });

  it('lastFor returns the most recent proposal for (person,toTier) regardless of status', () => {
    const s = freshStore(100);
    s.add({ popclawId: 'A', fromTier: 'friend', toTier: 'close', rationale: '' });
    const id = s.listPending()[0]!.id;
    s.decide(id, 'rejected');
    const last = s.lastFor('A', 'close');
    expect(last).toMatchObject({ toTier: 'close', status: 'rejected' });
    expect(s.lastFor('A', 'friend')).toBeNull();
  });

  // 已决定/失效提议不再作为新建议送达。
  // L2 投递前的 live 核对靠这个查询。
  it('hasPendingFor: 只有活的 pending (person,toTier) 才为真', () => {
    const s = freshStore(1000);
    s.add({ popclawId: 'A', fromTier: 'friend', toTier: 'close', rationale: '' });
    expect(s.hasPendingFor('A', 'close')).toBe(true);
    expect(s.hasPendingFor('A', 'friend')).toBe(false);
    expect(s.hasPendingFor('B', 'close')).toBe(false);
    s.decide(s.listPending()[0]!.id, 'accepted');
    expect(s.hasPendingFor('A', 'close')).toBe(false);
  });

  // 直接设档与待决提议的状态一致性。
  // 主人亲手设了档 = 那个人的提议问题已被回答：命中的记 accepted，
  // 被行动盖过的记 rejected，别人的提议一个字不动。
  it('settlePendingForManualTier: 命中档位记 accepted，其余记 rejected，别人不动', () => {
    const s = freshStore(5000);
    s.add({ popclawId: 'A', fromTier: 'friend', toTier: 'close', rationale: '' });
    s.add({ popclawId: 'A', fromTier: 'acquaintance', toTier: 'friend', rationale: '' });
    s.add({ popclawId: 'B', fromTier: 'friend', toTier: 'close', rationale: '' });
    const ids = s.listPending().map((p) => p.id);
    const settled = s.settlePendingForManualTier('A', 'close');
    expect(settled).toBe(2);
    expect(s.get(ids[0]!)).toMatchObject({ status: 'accepted', decidedAt: 5000 });
    expect(s.get(ids[1]!)).toMatchObject({ status: 'rejected', decidedAt: 5000 });
    expect(s.get(ids[2]!)).toMatchObject({ status: 'pending', decidedAt: null });
    expect(s.settlePendingForManualTier('NOBODY', 'friend')).toBe(0);
  });
});
