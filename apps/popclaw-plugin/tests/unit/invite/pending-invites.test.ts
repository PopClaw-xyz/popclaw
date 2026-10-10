/**
 * ADR-0040: verification-request ledger and two notification paths (SSE approval / polling rejection).
 *
 * Key invariant: both share the notified idempotency gate; the first resolution notifies and the other stays silent.
 */
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { runMigrations } from '../../../src/host/migrations';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier';
import { setOwnerLang } from '../../../src/lexicon/owner-language';
import {
  PendingInvitesStore,
  routeInviteVerified,
  checkInviteOnce,
  checkPendingInvites,
  watchInvite,
  type InviteWatchDeps,
} from '../../../src/invite/pending-invites';

// S13 slice: failReason()/EXPIRED_REASON now render in `ownerLang()` (default
// en-US) instead of hardcoded zh — pin zh-CN so the existing assertions stay meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const OWNER_BYTES = new Uint8Array(32).fill(7);
const OWNER = bs58.encode(OWNER_BYTES);
const STRANGER_BYTES = new Uint8Array(32).fill(8);

function harness(now = () => 1000) {
  const db = new LocalHostDb(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const pending = new PendingInvitesStore(db, now);
  const notifier = new SqliteNotifier(db, now);
  const notifyOwner = vi.fn();
  return { db, pending, notifier, notifyOwner };
}

function watchDeps(
  h: ReturnType<typeof harness>,
  fetchImpl: typeof globalThis.fetch,
): InviteWatchDeps {
  return {
    ownerPopclawId: OWNER,
    pending: h.pending,
    notifier: h.notifier,
    notifyOwner: h.notifyOwner,
    profileUrl: 'https://popclaw.me/blackfeather_ai/abcd1234',
    fetch: fetchImpl,
    loreHouseUrl: 'http://lore.test',
  };
}

function jsonFetch(body: unknown, ok = true): typeof globalThis.fetch {
  return (async () =>
    ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof globalThis.fetch;
}

describe('PendingInvitesStore', () => {
  it('records a submitted invite and lists it as 进行中', () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai', sigil: 'abcd1234' });
    expect(h.pending.listPending()).toEqual([
      { taskId: 't1', platform: 'x', handle: 'blackfeather_ai', sigil: 'abcd1234', createdAt: 1000 },
    ]);
  });

  it('drops申请 older than the 48h TTL from 进行中 (过期零惩罚，也不再显示)', () => {
    const h = harness(() => 1000);
    h.pending.add({ taskId: 'old', platform: 'x', handle: 'blackfeather_ai' });
    const later = new PendingInvitesStore(h.db, () => 1000 + 49 * 3600);
    expect(later.listPending()).toEqual([]);
  });

  it('claimResolved is the idempotency gate: only the first caller wins', () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    expect(h.pending.claimResolved('t1', 'approved')).toBe(true);
    expect(h.pending.claimResolved('t1', 'rejected')).toBe(false);
    expect(h.pending.listPending()).toEqual([]);
  });

  it('claimResolved seeds a missing row (申请发自别处 / 账本被清)', () => {
    const h = harness();
    expect(h.pending.claimResolved('ghost', 'approved', { platform: 'x', handle: 'blackfeather_ai' })).toBe(true);
    expect(h.pending.get('ghost')?.handle).toBe('blackfeather_ai');
  });
});

describe('routeInviteVerified (幕二: SSE 通过)', () => {
  it('reads the owner address when the notice is built, not when the wiring was assembled', () => {
    // The wiring is assembled at boot; a rename can land before the approval.
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    let name = 'ranger-3gkVcd';
    const wiring = {
      ownerPopclawId: OWNER,
      pending: h.pending,
      notifier: h.notifier,
      notifyOwner: h.notifyOwner,
      profileUrl: () => `https://popclaw.me/${name}/abcd1234`,
    };
    name = 'CanaryMe-26e2';
    routeInviteVerified(wiring, { taskId: 't1', applicantPopclawId: OWNER_BYTES, platform: 'x', handle: 'blackfeather_ai' });
    expect(h.notifier.drain('L1')[0]!.payload).toMatchObject({ profileUrl: 'https://popclaw.me/CanaryMe-26e2/abcd1234' });
  });

  it("someone else's verification is not mine — nothing enqueued", () => {
    const h = harness();
    const out = routeInviteVerified(
      { ownerPopclawId: OWNER, pending: h.pending, notifier: h.notifier, notifyOwner: h.notifyOwner },
      { taskId: 't1', applicantPopclawId: STRANGER_BYTES, platform: 'x', handle: 'someone' },
    );
    expect(out).toBe('not-mine');
    expect(h.notifier.count('L1')).toBe(0);
  });

  it('my verification enqueues one L1 ranger_verify_done with the snapshot follower count', () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    const out = routeInviteVerified(
      {
        ownerPopclawId: OWNER,
        pending: h.pending,
        notifier: h.notifier,
        notifyOwner: h.notifyOwner,
        profileUrl: 'https://popclaw.me/blackfeather_ai/abcd1234',
      },
      { taskId: 't1', applicantPopclawId: OWNER_BYTES, platform: 'x', handle: 'blackfeather_ai', followerCount: 30281 },
    );
    expect(out).toBe('notified');
    const items = h.notifier.drain('L1');
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('ranger_verify_done');
    expect(items[0]!.payload).toMatchObject({
      platform: 'x',
      handle: 'blackfeather_ai',
      followerCount: 30281,
      profileUrl: 'https://popclaw.me/blackfeather_ai/abcd1234',
    });
    // The enqueueing path triggers direct delivery itself, symmetric with checkInviteOnce; callers need not trigger it again.
    expect(h.notifyOwner).toHaveBeenCalledOnce();
  });

  it('an event with no task_id is dropped — one malformed envelope must not latch the ledger', () => {
    const h = harness();
    const deps = {
      ownerPopclawId: OWNER,
      pending: h.pending,
      notifier: h.notifier,
      notifyOwner: h.notifyOwner,
    };
    const ev = { applicantPopclawId: OWNER_BYTES, platform: 'x', handle: 'blackfeather_ai' };
    expect(routeInviteVerified(deps, ev)).toBe('not-mine');
    expect(h.notifier.count('L1')).toBe(0);
    expect(h.pending.get('')).toBeNull(); // no '' row was seeded/latched
    // …and the NEXT, well-formed event still gets through.
    expect(routeInviteVerified(deps, { ...ev, taskId: 't1' })).toBe('notified');
    expect(h.notifier.count('L1')).toBe(1);
  });

  it('the same event redelivered (SSE 重连回补) notifies exactly once', () => {
    const h = harness();
    const deps = {
      ownerPopclawId: OWNER,
      pending: h.pending,
      notifier: h.notifier,
      notifyOwner: h.notifyOwner,
    };
    const ev = { taskId: 't1', applicantPopclawId: OWNER_BYTES, platform: 'x', handle: 'blackfeather_ai' };
    expect(routeInviteVerified(deps, ev)).toBe('notified');
    expect(routeInviteVerified(deps, ev)).toBe('duplicate');
    expect(h.notifier.count('L1')).toBe(1);
  });
});

describe('两条腿交错 (SSE × 轮询共用同一道闸)', () => {
  // No lock is needed: better-sqlite3 is synchronous, and claimResolved's
  // UPDATE … WHERE notified = 0 is one statement in one transaction; changes reports this claim's
  // result. Both paths run on the same Node event loop, interleaving only at await
  // boundaries. This UPDATE has no await, so sequential calls represent the actual worst interleaving.
  it('SSE 先落定、轮询随后到货 → 第二次认领失败，只喊一次', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    const deps = watchDeps(h, jsonFetch({ state: 'APPROVED', follower_count: 30281 }));

    // Path one: SSE.
    expect(
      routeInviteVerified(deps, {
        taskId: 't1',
        applicantPopclawId: OWNER_BYTES,
        platform: 'x',
        handle: 'blackfeather_ai',
        followerCount: 30281,
      }),
    ).toBe('notified');
    // Path two: polling resolves (the LoreHouse also reports APPROVED).
    expect(await checkInviteOnce(deps, 't1')).toBe(true);

    expect(h.notifier.count('L1')).toBe(1);
    expect(h.notifyOwner).toHaveBeenCalledOnce();
    expect(h.pending.claimResolved('t1', 'approved')).toBe(false);
  });
});

describe('checkInviteOnce (幕三: 被拒轮询)', () => {
  it('REJECTED → resolved + one L1 ranger_verify_fail with a reason + delivery kick', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    const done = await checkInviteOnce(
      watchDeps(h, jsonFetch({ state: 'REJECTED', platform: 'x', handle: 'blackfeather_ai', reject_count: 3 })),
      't1',
    );
    expect(done).toBe(true);
    const items = h.notifier.drain('L1');
    expect(items[0]!.kind).toBe('ranger_verify_fail');
    expect(String(items[0]!.payload.reason)).toContain('3 位游侠');
    expect(h.notifyOwner).toHaveBeenCalledOnce();
    expect(h.pending.listPending()).toEqual([]);
  });

  it('PENDING → not resolved, nothing said', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    const done = await checkInviteOnce(watchDeps(h, jsonFetch({ state: 'PENDING' })), 't1');
    expect(done).toBe(false);
    expect(h.notifier.count('L1')).toBe(0);
  });

  it('APPROVED already announced by SSE → poll stays silent (notified 幂等闸)', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    h.pending.claimResolved('t1', 'approved'); // SSE arrives first.
    const done = await checkInviteOnce(watchDeps(h, jsonFetch({ state: 'APPROVED' })), 't1');
    expect(done).toBe(true);
    expect(h.notifier.count('L1')).toBe(0);
    expect(h.notifyOwner).not.toHaveBeenCalled();
  });

  it('APPROVED with no SSE (misses happen) → the poll is the one that tells the owner', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    await checkInviteOnce(
      watchDeps(h, jsonFetch({ state: 'APPROVED', platform: 'x', handle: 'blackfeather_ai', follower_count: 7 })),
      't1',
    );
    const items = h.notifier.drain('L1');
    expect(items[0]!.kind).toBe('ranger_verify_done');
    expect(items[0]!.payload.followerCount).toBe(7);
  });

  // Scene five: the LoreHouse expiry scan writes state=EXPIRED / outcome=INCONCLUSIVE, while
  // /v1/invites prioritizes outcome, so the owner sees timeout as INCONCLUSIVE.
  it('INCONCLUSIVE past expires_at → 幕五「超时了，重发即可」而不是「游侠没凑齐」', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    const expired = new Date(Date.now() - 60_000).toISOString();
    await checkInviteOnce(
      watchDeps(h, jsonFetch({ state: 'INCONCLUSIVE', expires_at: expired })),
      't1',
    );
    const reason = String(h.notifier.drain('L1')[0]!.payload.reason);
    expect(reason).toContain('超时');
    expect(reason).toContain('印信还是同一枚');
  });

  it('INCONCLUSIVE still inside expires_at → 真的是游侠们没凑齐', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    const alive = new Date(Date.now() + 3_600_000).toISOString();
    await checkInviteOnce(
      watchDeps(h, jsonFetch({ state: 'INCONCLUSIVE', expires_at: alive })),
      't1',
    );
    const reason = String(h.notifier.drain('L1')[0]!.payload.reason);
    expect(reason).toContain('没能凑齐');
  });

  it('灯坊 unreachable (non-ok / throw) → not resolved, never fabricates an outcome', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    expect(await checkInviteOnce(watchDeps(h, jsonFetch({}, false)), 't1')).toBe(false);
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    expect(await checkInviteOnce(watchDeps(h, boom), 't1')).toBe(false);
    expect(h.pending.listPending()).toHaveLength(1);
  });
});

describe('watchInvite / checkPendingInvites', () => {
  it('polls until resolved, then stops', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => (calls < 3 ? { state: 'PENDING' } : { state: 'REJECTED', reject_count: 1 }),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    let clock = 0;
    await watchInvite(watchDeps(h, fetchImpl), 't1', {
      intervalMs: 1,
      maxMs: 100,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(calls).toBe(3);
    expect(h.notifier.count('L1')).toBe(1);
  });

  it('gives up at the cap (转懒查) without inventing a result', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'blackfeather_ai' });
    let clock = 0;
    await watchInvite(watchDeps(h, jsonFetch({ state: 'PENDING' })), 't1', {
      intervalMs: 10,
      maxMs: 30,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(h.notifier.count('L1')).toBe(0);
    expect(h.pending.listPending()).toHaveLength(1);
  });

  it('checkPendingInvites sweeps every open 申请 (进程重启后的补偿)', async () => {
    const h = harness();
    h.pending.add({ taskId: 't1', platform: 'x', handle: 'a' });
    h.pending.add({ taskId: 't2', platform: 'x', handle: 'b' });
    await checkPendingInvites(watchDeps(h, jsonFetch({ state: 'REJECTED', reject_count: 2 })));
    expect(h.notifier.count('L1')).toBe(2);
    expect(h.pending.listPending()).toEqual([]);
  });
});
