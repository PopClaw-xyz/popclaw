import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { ProposalsStore } from '../../../src/bonds/proposals-store.js';
import { proposeTierChanges } from '../../../src/bonds/propose-tier-changes.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const NOW = 1_000_000;

function fresh() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  const bonds = new BondsStore(db, () => NOW);
  const proposals = new ProposalsStore(db, () => NOW);
  return { db, bonds, proposals };
}

describe('proposeTierChanges', () => {
  // 理由句是纯机械计数。做梦每晚已经写下了
  // 这个人最近在干什么 —— 用它，主人读到的才是一个人，不是一个计数器。
  it('理由句捎上做梦写下的近况；没有就退回纯计数', () => {
    const { bonds, proposals } = fresh();
    bonds.ensure('A');
    for (let i = 0; i < 3; i++) bonds.recordInteraction('A', NOW - 1000 * (i + 1));
    bonds.addDynamic('A', { summary: '像是要结婚了', isMilestone: true, ts: NOW - 500 });
    const warm = proposeTierChanges({ bondsStore: bonds, proposalsStore: proposals, now: () => NOW });
    expect(warm[0]!.rationale).toContain('像是要结婚了');
    expect(warm[0]!.rationale).toContain('3');

    const bare = fresh();
    bare.bonds.ensure('B');
    for (let i = 0; i < 3; i++) bare.bonds.recordInteraction('B', NOW - 1000 * (i + 1));
    const cold = proposeTierChanges({ bondsStore: bare.bonds, proposalsStore: bare.proposals, now: () => NOW });
    expect(cold[0]!.rationale).toContain('3');
    expect(cold[0]!.rationale).not.toContain('undefined');
  });

  it('proposes acquaintance→friend when recent interactions >= FRIEND_THRESHOLD', () => {
    const { bonds, proposals } = fresh();
    bonds.ensure('A'); // acquaintance
    for (let i = 0; i < 3; i++) bonds.recordInteraction('A', NOW - 1000 * (i + 1));
    const n = proposeTierChanges({ bondsStore: bonds, proposalsStore: proposals, now: () => NOW });
    expect(n).toHaveLength(1);
    // 明细而非计数：做梦要能告诉主人「是谁」，只给个数字就只能沉默。
    expect(n[0]).toMatchObject({ toTier: 'friend' });
    expect(typeof n[0]!.popclawId).toBe('string');
    expect(n[0]!.rationale.length).toBeGreaterThan(0);
    expect(proposals.listPending()[0]).toMatchObject({ popclawId: 'A', fromTier: 'acquaintance', toTier: 'friend' });
  });

  it('proposes friend→close at CLOSE_THRESHOLD; one step only', () => {
    const { bonds, proposals } = fresh();
    bonds.setTier('B', 'friend', 'manual');
    for (let i = 0; i < 10; i++) bonds.recordInteraction('B', NOW - 1000 * (i + 1));
    proposeTierChanges({ bondsStore: bonds, proposalsStore: proposals, now: () => NOW });
    const p = proposals.listPending();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ fromTier: 'friend', toTier: 'close' });
  });

  it('does not propose below threshold', () => {
    const { bonds, proposals } = fresh();
    bonds.ensure('C');
    bonds.recordInteraction('C', NOW - 500); // only 1
    expect(proposeTierChanges({ bondsStore: bonds, proposalsStore: proposals, now: () => NOW })).toHaveLength(0);
  });

  it('ignores interactions outside the 30-day window', () => {
    const { bonds, proposals } = fresh();
    bonds.ensure('D');
    for (let i = 0; i < 5; i++) bonds.recordInteraction('D', NOW - 40 * 24 * 3600 - i); // all stale
    expect(proposeTierChanges({ bondsStore: bonds, proposalsStore: proposals, now: () => NOW })).toHaveLength(0);
  });

  it('does not propose for negative tiers or close→close_plus', () => {
    const { bonds, proposals } = fresh();
    bonds.setTier('E', 'blocked', 'manual');
    bonds.setTier('F', 'close', 'manual');
    for (const id of ['E', 'F']) for (let i = 0; i < 12; i++) bonds.recordInteraction(id, NOW - 1000 * (i + 1));
    expect(proposeTierChanges({ bondsStore: bonds, proposalsStore: proposals, now: () => NOW })).toHaveLength(0);
  });

  it('dedupes: no second pending proposal for the same (person,toTier)', () => {
    const { bonds, proposals } = fresh();
    bonds.setTier('G', 'friend', 'manual');
    for (let i = 0; i < 10; i++) bonds.recordInteraction('G', NOW - 1000 * (i + 1));
    proposeTierChanges({ bondsStore: bonds, proposalsStore: proposals, now: () => NOW });
    proposeTierChanges({ bondsStore: bonds, proposalsStore: proposals, now: () => NOW });
    expect(proposals.listPending()).toHaveLength(1);
  });

  it('respects 7-day cooldown after a rejection', () => {
    const { db, bonds } = fresh();
    bonds.setTier('H', 'friend', 'manual');
    for (let i = 0; i < 10; i++) bonds.recordInteraction('H', NOW - 1000 * (i + 1));
    // a rejected proposal 3 days ago
    const proposals = new ProposalsStore(db, () => NOW - 3 * 24 * 3600);
    proposals.add({ popclawId: 'H', fromTier: 'friend', toTier: 'close', rationale: '' });
    proposals.decide(proposals.listPending()[0]!.id, 'rejected');
    const n = proposeTierChanges({ bondsStore: bonds, proposalsStore: new ProposalsStore(db, () => NOW), now: () => NOW });
    expect(n).toHaveLength(0); // within cooldown
  });
});
