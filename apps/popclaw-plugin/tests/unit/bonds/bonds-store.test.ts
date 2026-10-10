import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

function freshStore(): BondsStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return new BondsStore(db, () => 1000);
}

describe('BondsStore — create/get/list', () => {
  it('get returns null for unknown popclaw_id (stranger = no row)', () => {
    expect(freshStore().get('NOBODY')).toBeNull();
  });

  it('ensure creates an acquaintance row with timestamps', () => {
    const s = freshStore();
    const bond = s.ensure('ALICE');
    expect(bond.popclawId).toBe('ALICE');
    expect(bond.tier).toBe('acquaintance');
    expect(bond.peakTier).toBe('acquaintance');
    expect(bond.followed).toBe(false);
    expect(bond.createdAt).toBe(1000);
    expect(s.get('ALICE')).not.toBeNull();
  });

  it('ensure is idempotent — second call returns existing, does not reset', () => {
    const s = freshStore();
    s.ensure('ALICE');
    s.setTier('ALICE', 'friend', 'manual');
    const again = s.ensure('ALICE');
    expect(again.tier).toBe('friend');
  });

  it('list filters by minTier and orders by tier rank desc', () => {
    const s = freshStore();
    s.ensure('ACQ');
    s.ensure('FRIEND'); s.setTier('FRIEND', 'friend', 'manual');
    s.ensure('CLOSE'); s.setTier('CLOSE', 'close', 'manual');
    const friendsUp = s.list({ minTier: 'friend' }).map((b) => b.popclawId);
    expect(friendsUp).toEqual(['CLOSE', 'FRIEND']);
  });
});

describe('BondsStore — setTier + recordInteraction', () => {
  it('setTier updates tier + tier_source and raises peak_tier monotonically', () => {
    const s = freshStore();
    s.ensure('ALICE');
    s.setTier('ALICE', 'close', 'manual');
    expect(s.get('ALICE')!.peakTier).toBe('close');
    s.setTier('ALICE', 'blocked', 'manual');
    const a = s.get('ALICE')!;
    expect(a.tier).toBe('blocked');
    expect(a.peakTier).toBe('close');
    expect(a.tierSource).toBe('manual');
  });

  it('recordInteraction creates the bond if absent (出手即建档) and bumps last_interaction_ts', () => {
    const s = freshStore();
    const b = s.recordInteraction('BOB', 2000);
    expect(b.tier).toBe('acquaintance');
    expect(b.lastInteractionTs).toBe(2000);
    expect(s.get('BOB')).not.toBeNull();
  });

  it('recordInteraction on an existing higher-tier bond keeps the tier, only bumps ts', () => {
    const s = freshStore();
    s.ensure('CAROL'); s.setTier('CAROL', 'close', 'manual');
    s.recordInteraction('CAROL', 3000);
    const c = s.get('CAROL')!;
    expect(c.tier).toBe('close');
    expect(c.lastInteractionTs).toBe(3000);
  });

  it('setFollowed projects follow state without changing tier', () => {
    const s = freshStore();
    s.setFollowed('DAVE', true);
    expect(s.get('DAVE')!.followed).toBe(true);
    expect(s.get('DAVE')!.tier).toBe('acquaintance');
    s.setFollowed('DAVE', false);
    expect(s.get('DAVE')!.followed).toBe(false);
  });

  it('setNickname stores + reads the followee nickname', () => {
    const s = freshStore();
    s.setNickname('alice', '苍梧居士');
    expect(s.get('alice')?.nickname).toBe('苍梧居士');
  });

  it('nickname defaults to empty string for a bond created without one', () => {
    const s = freshStore();
    s.setFollowed('bob', true);
    expect(s.get('bob')?.nickname).toBe('');
  });
});

describe('BondsStore — dynamics + search', () => {
  it('addDynamic stores a timeline entry; unreportedDynamics returns newest first', () => {
    const s = freshStore();
    s.ensure('ALICE');
    s.addDynamic('ALICE', { ts: 5000, summary: 'launched a startup', isMilestone: true });
    s.addDynamic('ALICE', { ts: 6000, summary: 'hiring', isMilestone: false });
    const dyn = s.unreportedDynamics(10).filter((d) => d.popclawId === 'ALICE');
    expect(dyn).toHaveLength(2);
    expect(dyn[0]!.summary).toBe('hiring');
    expect(dyn[1]!.isMilestone).toBe(true);
  });

  it('search finds bonds by FTS over description/tags after setKnowledge', () => {
    const s = freshStore();
    s.ensure('INV');
    s.setKnowledge('INV', { description: 'angel investor, met at YC', tags: ['investor', 'fintech'] });
    s.ensure('ENG');
    s.setKnowledge('ENG', { description: 'rust systems engineer', tags: ['engineer'] });
    const hits = s.search('investor').map((b) => b.popclawId);
    expect(hits).toContain('INV');
    expect(hits).not.toContain('ENG');
  });

  it('search returns [] for empty / no-hit / special-char input without throwing', () => {
    const s = freshStore();
    s.ensure('INV');
    s.setKnowledge('INV', { description: 'angel investor', tags: ['investor'] });
    expect(s.search('')).toEqual([]);
    expect(s.search('   ')).toEqual([]);
    expect(s.search('nonexistentterm')).toEqual([]);
    expect(() => s.search('inv("AND OR')).not.toThrow(); // special chars don't crash
  });
});

describe('BondsStore — markDreamed (dreamer cursor)', () => {
  it('sets last_dream_ts without touching tier/peak', () => {
    const s = freshStore();
    s.ensure('ALICE');
    s.markDreamed('ALICE', 1700);
    const a = s.get('ALICE')!;
    expect(a.lastDreamTs).toBe(1700);
    expect(a.tier).toBe('acquaintance');
    expect(a.peakTier).toBe('acquaintance');
  });

  it('ensures the row first when the person is unknown', () => {
    const s = freshStore();
    s.markDreamed('NEWBIE', 900);
    expect(s.get('NEWBIE')!.lastDreamTs).toBe(900);
  });

  it('advances monotonically as the dreamer reprocesses', () => {
    const s = freshStore();
    s.ensure('BOB');
    s.markDreamed('BOB', 1000);
    s.markDreamed('BOB', 2000);
    expect(s.get('BOB')!.lastDreamTs).toBe(2000);
  });
});

describe('BondsStore — rolling interaction count', () => {
  it('recordInteraction accumulates timestamps; recentInteractionCount filters by window', () => {
    const s = freshStore(); // now = 1000
    s.recordInteraction('ALICE', 100);
    s.recordInteraction('ALICE', 200);
    s.recordInteraction('ALICE', 900);
    expect(s.recentInteractionCount('ALICE', 150)).toBe(2); // 200, 900
    expect(s.recentInteractionCount('ALICE', 0)).toBe(3);
    expect(s.recentInteractionCount('NOBODY', 0)).toBe(0);
  });

  it('caps stored timestamps at 50 (keeps newest)', () => {
    const s = freshStore();
    for (let i = 1; i <= 60; i++) s.recordInteraction('BOB', i);
    expect(s.recentInteractionCount('BOB', 0)).toBe(50);
    expect(s.recentInteractionCount('BOB', 11)).toBe(50); // 11..60 kept
    expect(s.recentInteractionCount('BOB', 10)).toBe(50);
  });
});

describe('BondsStore — unreportedDynamics / markDynamicsReported', () => {
  it('returns unreported dynamics joined with tier + remark, newest first', () => {
    const s = freshStore();
    s.setTier('ALICE', 'close', 'manual');
    s.setKnowledge('ALICE', { remarkName: '阿青' });
    s.addDynamic('ALICE', { ts: 100, summary: 'shipped', isMilestone: false });
    s.addDynamic('ALICE', { ts: 200, summary: 'raised fund', isMilestone: true });
    const rows = s.unreportedDynamics();
    expect(rows.map((r) => r.summary)).toEqual(['raised fund', 'shipped']);
    expect(rows[0]).toMatchObject({ popclawId: 'ALICE', tier: 'close', remarkName: '阿青', isMilestone: true });
  });

  it('markDynamicsReported flips reported so they stop showing', () => {
    const s = freshStore();
    s.ensure('ALICE');
    s.addDynamic('ALICE', { ts: 100, summary: 'x', isMilestone: false });
    const before = s.unreportedDynamics();
    expect(before).toHaveLength(1);
    s.markDynamicsReported([before[0]!.id]);
    expect(s.unreportedDynamics()).toHaveLength(0);
  });

  it('markDynamicsReported([]) is a no-op', () => {
    const s = freshStore();
    expect(() => s.markDynamicsReported([])).not.toThrow();
  });
});

// Review finding: dream writeback can be replayed (partial batch failure retains the token, then the agent resubmits the whole batch).
// A plain INSERT would add identical rows to the recent-activity list.
describe('BondsStore.addDynamic — 幂等', () => {
  it('同一人 + 同 ts + 同一句话，重放不再长出重复行', () => {
    const s = freshStore();
    s.addDynamic('ALICE', { ts: 100, summary: '发射成功', isMilestone: true });
    s.addDynamic('ALICE', { ts: 100, summary: '发射成功', isMilestone: true });
    expect(s.recentDynamics('ALICE', 10)).toHaveLength(1);
  });

  it('真正不同的近况照样都记下', () => {
    const s = freshStore();
    s.addDynamic('ALICE', { ts: 100, summary: '发射成功', isMilestone: true });
    s.addDynamic('ALICE', { ts: 100, summary: '换了工作', isMilestone: true }); // Same timestamp, different event.
    s.addDynamic('ALICE', { ts: 200, summary: '发射成功', isMilestone: false }); // Same event, different timestamp.
    expect(s.recentDynamics('ALICE', 10)).toHaveLength(3);
  });
});

// The bond book is the single normalization point for local social assets: resolved nicknames belong here.
// These three cases distinguish this from setNickname (2026-07-29 real-device case: the Cangwu Pavilion row existed but its name was empty).
describe('BondsStore.fillNickname — 只填空、不建行', () => {
  it('名字空着 → 填上，返回 true', () => {
    const s = freshStore();
    s.ensure('CANGWU');
    expect(s.fillNickname('CANGWU', '苍梧小居士')).toBe(true);
    expect(s.get('CANGWU')?.nickname).toBe('苍梧小居士');
  });

  it('名字非空 → 绝不覆盖，返回 false', () => {
    const s = freshStore();
    s.setNickname('CANGWU', '主人叫惯的名');
    expect(s.fillNickname('CANGWU', '灯坊上的名')).toBe(false);
    expect(s.get('CANGWU')?.nickname).toBe('主人叫惯的名');
  });

  it('行不存在 → 不建行（建档是"出手即建档"的职责）', () => {
    const s = freshStore();
    expect(s.fillNickname('STRANGER', '路人甲')).toBe(false);
    expect(s.get('STRANGER')).toBeNull();
  });

  it('空名字 / 纯空白不写', () => {
    const s = freshStore();
    s.ensure('CANGWU');
    expect(s.fillNickname('CANGWU', '   ')).toBe(false);
    expect(s.get('CANGWU')?.nickname).toBe('');
  });

  it('重复写回幂等：第二次 false', () => {
    const s = freshStore();
    s.ensure('CANGWU');
    expect(s.fillNickname('CANGWU', '苍梧小居士')).toBe(true);
    expect(s.fillNickname('CANGWU', '苍梧小居士')).toBe(false);
  });

  // Policy update (2026-07-30): nickname resolution must process ALL rows, not only unnamed ones, because names can change.
  // The local copy is a cache. Selecting only empty names left rows with a handle in the nickname slot permanently outside the worklist.
  it('idsForNicknameSync 列全部行（有名字的也要对）', () => {
    const s = freshStore();
    s.ensure('NAMELESS');
    s.setNickname('NAMED', '有名字的');
    expect(s.idsForNicknameSync(50).sort()).toEqual(['NAMED', 'NAMELESS']);
  });

  it('syncNickname 无条件写；与存量相同则不写（返回 false）', () => {
    const s = freshStore();
    s.setNickname('P', 'owl_scribe_7');
    expect(s.syncNickname('P', 'Blackfeather')).toBe(true);
    expect(s.get('P')?.nickname).toBe('Blackfeather');
    expect(s.syncNickname('P', 'Blackfeather')).toBe(false); // Avoid unnecessary writes.
  });
});
