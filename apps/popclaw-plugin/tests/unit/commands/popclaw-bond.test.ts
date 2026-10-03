import { withOutcomes } from '../../helpers/with-outcomes.js';
import { describe, expect, it, beforeAll } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { runFollowCommand } from '../../../src/commands/follow.js';
import { runBondCommand } from '../../../src/commands/popclaw-bond.js';
import { ProposalsStore } from '../../../src/bonds/proposals-store.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import type { SocialGraph } from '../../../src/social-graph/social-graph.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S3 rollout slice 4: runBondCommand now renders in `ownerLang()` (S1
// process-wide singleton). Pin zh-CN so this file's pre-lexicon assertions
// stay byte-for-byte unchanged (same fix as status.test.ts / popclaw-bond-remark.test.ts).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

function ctx() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  const bondsStore = new BondsStore(db, () => 1000);
  // runFollowCommand only touches socialGraph.declareFollow; a structural stub
  // is enough (cast to SocialGraph — same convention as follow.test.ts).
  const socialGraph = withOutcomes({
    declareFollow: async () => {},
    revokeFollow: async () => {},
  }) as unknown as SocialGraph;
  return { bondsStore, socialGraph };
}

describe('follow → bonds projection', () => {
  it('following someone creates the bond + sets followed=true + records interaction', async () => {
    const { bondsStore, socialGraph } = ctx();
    await runFollowCommand('ALICE', { socialGraph, bondsStore, ownPopclawId: 'owner-id-that-is-nobody-here' });
    const a = bondsStore.get('ALICE');
    expect(a).not.toBeNull();
    expect(a!.followed).toBe(true);
    expect(a!.lastInteractionTs).toBe(1000);
  });
});

describe('runBondCommand', () => {
  function deps(following: Array<{ popclawId: string; since: number }> = []) {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const socialGraph = {
      following: () =>
        following.map((f) => ({ ...f, followType: 'PUBLIC' as const, tasteSubscribed: false, houseSlug: '' })),
    };
    const bondsStore = new BondsStore(db, () => 1000);
    return {
      bondsStore,
      socialGraph,
      nameOf: (id: string) => {
        const b = bondsStore.get(id);
        return b?.remarkName || b?.nickname || '';
      },
    };
  }
  it('add sets tier=friend (manual)', async () => {
    const d = deps();
    const r = await runBondCommand({ positional: ['add', 'ALICE'] }, d);
    expect(r.text).toContain('好友');
    expect(d.bondsStore.get('ALICE')!.tier).toBe('friend');
    expect(d.bondsStore.get('ALICE')!.tierSource).toBe('manual');
  });

  // /popclaw bond 的设档路径与工具路径同规——
  // 回执走「#印信」名字链（绝不裸 id 前缀），直接设档 settle 该人 pending 提议。
  it('add（直接设档）回执走「#印信」，并 settle 命中的 pending 提议', async () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const bondsStore = new BondsStore(db, () => 1000);
    const proposalsStore = new ProposalsStore(db, () => 1000);
    // bond_proposals has an FK to bonds — the person must exist before the proposal.
    bondsStore.setTier('ALICE', 'acquaintance', 'manual');
    proposalsStore.add({ popclawId: 'ALICE', fromTier: 'acquaintance', toTier: 'friend', rationale: '' });
    const r = await runBondCommand(
      { positional: ['add', 'ALICE'] },
      {
        bondsStore,
        socialGraph: { following: () => [] } as unknown as SocialGraph,
        proposalsStore,
        nameOf: () => '',
      },
    );
    expect(r.text).toContain(`#${deriveSigil('ALICE')}`);
    expect(r.text).not.toContain('ALICE');
    expect(bondsStore.get('ALICE')!.tier).toBe('friend');
    expect(proposalsStore.listPending()).toHaveLength(0);
    expect(proposalsStore.lastFor('ALICE', 'friend')!.status).toBe('accepted');
  });

  it('settle 抛错不拦设档回执（档位已动，回执如实；结算可重试）', async () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const bondsStore = new BondsStore(db, () => 1000);
    const r = await runBondCommand(
      { positional: ['add', 'ALICE'] },
      {
        bondsStore,
        socialGraph: { following: () => [] } as unknown as SocialGraph,
        proposalsStore: {
          settlePendingForManualTier: () => {
            throw new Error('db locked');
          },
        },
        nameOf: () => '',
      },
    );
    expect(bondsStore.get('ALICE')!.tier).toBe('friend');
    expect(r.text).toContain('好友');
  });
  it('block sets tier=blocked, reject sets tier=reject', async () => {
    const d = deps();
    await runBondCommand({ positional: ['block', 'BOB'] }, d);
    await runBondCommand({ positional: ['reject', 'CAROL'] }, d);
    expect(d.bondsStore.get('BOB')!.tier).toBe('blocked');
    expect(d.bondsStore.get('CAROL')!.tier).toBe('reject');
  });
  it('list renders tiered bonds', async () => {
    const d = deps();
    await runBondCommand({ positional: ['add', 'ALICE'] }, d);
    const r = await runBondCommand({ positional: ['list'] }, d);
    expect(r.text).toContain('ALICE');
  });

  it('list prepends a summary line: 关注 X · 好友 Z, agreeing with the rows below it', async () => {
    const d = deps();
    await runBondCommand({ positional: ['add', 'ALICE'] }, d); // friend
    await runBondCommand({ positional: ['close', 'BOB'] }, d); // close (>= friend)
    await runBondCommand({ positional: ['reject', 'CAROL'] }, d); // not following, below friend anyway
    // Setting a tier is not following: the header's "following" counter and
    // each row's "· 关注" marker both come from bonds.followed, so only
    // marking ALICE/BOB followed here makes either of them count.
    d.bondsStore.setFollowed('ALICE', true);
    d.bondsStore.setFollowed('BOB', true);
    const r = await runBondCommand({ positional: ['list'] }, d);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('关注 2 · 好友 2');
    expect(lines[1]).toContain('交情本（3）');
    const markedRows = lines.slice(2).filter((l) => l.includes('·关注'));
    expect(markedRows).toHaveLength(2);
  });

  it('list summary line shows 0 when nobody in the bond book is followed', async () => {
    const d = deps();
    const r = await runBondCommand({ positional: ['list'] }, d);
    expect(r.text.split('\n')[0]).toBe('关注 0 · 好友 0');
    expect(r.text).toContain('交情本还是空的。');
  });

  describe('header "following" count agrees with the row markers (bug: header used to read a different source than the rows)', () => {
    it('k of N followed → header shows k and exactly k rows carry the marker (zh-CN)', async () => {
      const d = deps();
      d.bondsStore.setFollowed('ALICE', true);
      d.bondsStore.setFollowed('BOB', true);
      d.bondsStore.setTier('CAROL', 'acquaintance', 'auto'); // in the book, not followed
      const r = await runBondCommand({ positional: ['list'] }, d);
      const lines = r.text.split('\n');
      expect(lines[0]).toBe('关注 2 · 好友 0');
      const markedRows = lines.slice(2).filter((l) => l.includes('·关注'));
      expect(markedRows).toHaveLength(2);
    });

    it('k of N followed → header shows k and exactly k rows carry the marker (en)', async () => {
      setOwnerLang('en', 'config');
      try {
        const d = deps();
        d.bondsStore.setFollowed('ALICE', true);
        d.bondsStore.setTier('BOB', 'acquaintance', 'auto'); // in the book, not followed
        const r = await runBondCommand({ positional: ['list'] }, d);
        const lines = r.text.split('\n');
        expect(lines[0]).toBe('following 1 · 0 friends');
        const markedRows = lines.slice(2).filter((l) => l.includes('· following'));
        expect(markedRows).toHaveLength(1);
      } finally {
        setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
      }
    });

    it('k=0: nobody followed → header shows 0 and no row carries the marker', async () => {
      const d = deps();
      d.bondsStore.setTier('ALICE', 'friend', 'manual');
      d.bondsStore.setTier('BOB', 'acquaintance', 'auto');
      const r = await runBondCommand({ positional: ['list'] }, d);
      const lines = r.text.split('\n');
      expect(lines[0]).toBe('关注 0 · 好友 1');
      expect(lines.slice(2).some((l) => l.includes('·关注'))).toBe(false);
    });

    it('followed but name not yet resolved: row shows —#sigil and still carries the marker and the header count', async () => {
      const d = deps();
      d.bondsStore.setFollowed('ALICE', true); // no nickname set — resolution never landed a name
      const r = await runBondCommand({ positional: ['list'] }, d);
      const lines = r.text.split('\n');
      expect(lines[0]).toBe('关注 1 · 好友 0');
      const row = lines.find((l) => l.includes(`#${deriveSigil('ALICE')}`));
      expect(row).toContain(`—#${deriveSigil('ALICE')}`);
      expect(row).toContain('·关注');
    });
  });

  it('follows lists all followed people, one per line, newest first', async () => {
    const d = deps([
      { popclawId: 'ALICE', since: 1 },
      { popclawId: 'BOB', since: 2 },
    ]);
    d.bondsStore.setNickname('BOB', '小波');
    const r = await runBondCommand({ positional: ['follows'] }, d);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('关注（2）：');
    // newest (since desc) first: BOB then ALICE
    expect(lines[1]).toContain('小波#');
    expect(lines[2]).toContain('—#'); // ALICE has no nickname/feed handle → 查无 dash
  });

  // 认人（ADR-0028 修订）：列人输出补机器字段——显示仍人话，钥匙给 agent。
  it('list/follows carry the FULL popclaw_id next to 名号#印信', async () => {
    const longId = 'ALICE' + 'x'.repeat(30); // 前 10 位 ≠ 完整 id
    const d = deps([{ popclawId: longId, since: 1 }]);
    d.bondsStore.setNickname(longId, '阿丽');
    await runBondCommand({ positional: ['add', longId] }, d);

    const list = await runBondCommand({ positional: ['list'] }, d);
    expect(list.text).toContain('阿丽#');
    expect(list.text).toContain(longId);

    const follows = await runBondCommand({ positional: ['follows'] }, d);
    expect(follows.text).toContain('阿丽#');
    expect(follows.text).toContain(longId);
  });

  it('follows: empty state is a friendly one-liner', async () => {
    const d = deps();
    const r = await runBondCommand({ positional: ['follows'] }, d);
    expect(r.text).toBe('还没关注任何人。');
  });

  // S3 rollout slice 4 — en lane.
  it('renders in en when set', async () => {
    setOwnerLang('en', 'config');
    const d = deps([{ popclawId: 'ALICE', since: 1 }]);
    await runBondCommand({ positional: ['add', 'ALICE'] }, d);
    d.bondsStore.setFollowed('ALICE', true);
    const list = await runBondCommand({ positional: ['list'] }, d);
    expect(list.text).toContain('following 1');
    expect(list.text).toContain('friend');
    expect(list.text).toContain('Bond book (1):');
    const setTier = await runBondCommand({ positional: ['close', 'BOB'] }, d);
    expect(setTier.text).toContain(`Set #${deriveSigil('BOB')} to "close friend".`);
    const emptyFollows = await runBondCommand({ positional: ['follows'] }, { ...d, socialGraph: { following: () => [] } });
    expect(emptyFollows.text).toBe('Not following anyone yet.');
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });
});
