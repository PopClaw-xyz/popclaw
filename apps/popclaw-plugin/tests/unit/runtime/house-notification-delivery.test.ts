import { afterEach, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { SqliteNotifier, DM_DELIVERY_LEASE_SECONDS } from '../../../src/notifier/sqlite-notifier.js';
import { RuntimeOwnerNotifier, notifyOwnerNow } from '../../../src/notifier/owner-notifier.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import type { NotificationItem } from '../../../src/notifier/types.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const databases: InMemoryHostDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
const target = { deliveryContext: { channel: 'synthetic', to: 'owner' } };
const immediateTarget = async () => target;

function setup() {
  const db = new InMemoryHostDb();
  databases.push(db);
  runMigrations(db, MIGRATIONS);
  const inbox = new InboxStore(db);
  let now = 1000, ownerEpoch = 1, localOwnerEpoch = 1;
  const generations = new Map([['A', 1], ['B', 1]]), enabled = new Set(['A', 'B']);
  const notifier = new SqliteNotifier(db, () => now);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const failureStore = { get: vi.fn(() => null), set: vi.fn(), clear: vi.fn() };
  const capture = (item: NotificationItem) => {
    const key = String(item.payload.houseSlug);
    if (!enabled.has(key) || localOwnerEpoch !== ownerEpoch) return null;
    const generation = generations.get(key), epoch = ownerEpoch;
    return { key, isActive: () => enabled.has(key) && generations.get(key) === generation && ownerEpoch === epoch && localOwnerEpoch === epoch };
  };
  const queue = () => notifier.deliveryView(capture);
  const enqueue = (house: string, legacy = false, attempts = 0) => {
    const message = legacy ? undefined : inbox.recordReceived({ ts: now, fromPopclawId: 'alice', toPopclawId: 'owner', body: `${house}-${now}`, houseSlug: house, receivedAtMs: now });
    notifier.enqueue({ level: 'L1', kind: legacy ? 'reply' : 'dm', payload: { ...(message ? { messageId: message.item.id } : {}), houseSlug: house, fromPopclawId: 'alice', body: `message from ${house}`, ...(attempts ? { attempts } : {}) } });
  };
  const row = (house: string) => db.queryOne<{ id: number; delivered_at: number | null; delivery_lease_token: string | null; delivery_lease_until: number | null; payload_json: string }>("SELECT * FROM notification_queue WHERE json_extract(payload_json, '$.houseSlug') = ?", [house])!;
  const deliver = (owner: RuntimeOwnerNotifier, view = queue()) => notifyOwnerNow({ notifier: view, owner, resolveTarget: immediateTarget, logger, failureStore, now: () => now });
  return { db, notifier, capture, queue, enqueue, row, deliver, logger, failureStore,
    logout: (house: string) => { enabled.delete(house); generations.set(house, generations.get(house)! + 1); },
    login: (house: string) => { enabled.add(house); generations.set(house, generations.get(house)! + 1); },
    loseOwner: () => { ownerEpoch++; }, becomeOwner: () => { localOwnerEpoch = ownerEpoch; },
    advance: (seconds: number) => { now += seconds; },
  };
}

it('RuntimeOwnerNotifier authorizes after its final await and before invoking the host', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const send = vi.fn(async () => ({ status: 'sent' }));
  const owner = new RuntimeOwnerNotifier(send, {}, async () => { entered.resolve(); await release.promise; return target; }, { info() {}, warn() {} });
  const failure = new Error('captured authority inactive');
  const authorize = vi.fn(() => { throw failure; });
  const work = owner.deliverNow('notice', [], authorize);
  const outcome = work.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  expect(authorize).not.toHaveBeenCalled();
  release.resolve();
  expect(await outcome).toEqual({ error: failure });
  expect(send).not.toHaveBeenCalled();
});

it('selects eligible house rows before claiming, including legacy L1 rows', () => {
  const s = setup();
  s.enqueue('A', true); s.enqueue('B', true); s.logout('A');
  const queue = s.queue();
  expect(queue.count()).toBe(1);
  const batches = queue.claimDelivery!('L1');
  expect(batches).toHaveLength(1);
  expect(batches[0]!.items.map(item => item.payload.houseSlug)).toEqual(['B']);
  expect(s.row('A')).toMatchObject({ delivered_at: null, delivery_lease_token: null });
  expect(s.row('B').delivery_lease_token).toBeTruthy();
  expect(() => queue.drain('L1')).toThrow();
  batches[0]!.cancel!();
  expect(s.row('B')).toMatchObject({ delivered_at: null, delivery_lease_token: null });
});

it.each([false, true])('logout during target resolution cancels only A without attempts or loss (legacy=%s)', async legacy => {
  const s = setup(), entered = deferred<void>(), release = deferred<void>();
  s.enqueue('A', legacy); s.enqueue('B', legacy);
  const originalId = s.row('A').id;
  const send = vi.fn(async (_params: { payloads: { text: string }[] }) => ({ status: 'sent' }));
  let targets = 0;
  const owner = new RuntimeOwnerNotifier(send, {}, async () => { if (++targets === 1) { entered.resolve(); await release.promise; } return target; }, s.logger);
  const work = s.deliver(owner);
  await entered.promise;
  s.logout('A'); release.resolve();
  expect(await work).toBe('channel');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0].payloads[0]!.text).toContain('message from B');
  expect(send.mock.calls[0]![0].payloads[0]!.text).not.toContain('message from A');
  expect(s.row('A')).toMatchObject({ id: originalId, delivered_at: null, delivery_lease_token: null, delivery_lease_until: null });
  expect(JSON.parse(s.row('A').payload_json).attempts).toBeUndefined();
  expect(s.row('B').delivered_at).toBe(1000);
  expect(s.failureStore.set).not.toHaveBeenCalled();
});

it('does not replace the captured generation after logout and login during an await', async () => {
  const s = setup(), entered = deferred<void>(), release = deferred<void>();
  s.enqueue('A');
  const send = vi.fn(async () => ({ status: 'sent' }));
  const owner = new RuntimeOwnerNotifier(send, {}, async () => { entered.resolve(); await release.promise; return target; }, s.logger);
  const work = s.deliver(owner);
  await entered.promise;
  s.logout('A'); s.login('A'); release.resolve();
  expect(await work).toBe('inactive');
  expect(send).not.toHaveBeenCalled();
  expect(s.row('A').delivery_lease_token).toBeNull();
});

it('owner loss cancels claimed notifications and prevents a reader from claiming new ones', async () => {
  const s = setup(), entered = deferred<void>(), release = deferred<void>();
  s.enqueue('A'); s.enqueue('B');
  const send = vi.fn(async () => ({ status: 'sent' }));
  const owner = new RuntimeOwnerNotifier(send, {}, async () => { entered.resolve(); await release.promise; return target; }, s.logger);
  const work = s.deliver(owner);
  await entered.promise;
  s.loseOwner(); release.resolve();
  expect(await work).toBe('inactive');
  expect(send).not.toHaveBeenCalled();
  expect(s.queue().claimDelivery!('L1')).toEqual([]);
  expect(s.row('A').delivery_lease_token).toBeNull();
  expect(s.row('B').delivery_lease_token).toBeNull();
  expect(s.failureStore.set).not.toHaveBeenCalled();
});

it.each([false, true])('expired claim cannot send or release a replacement claim (reclaimed=%s)', async reclaimed => {
  const s = setup(), entered = deferred<void>(), release = deferred<void>();
  s.enqueue('A');
  const send = vi.fn(async () => ({ status: 'sent' }));
  const owner = new RuntimeOwnerNotifier(send, {}, async () => { entered.resolve(); await release.promise; return target; }, s.logger);
  const old = s.deliver(owner);
  await entered.promise;
  const oldToken = s.row('A').delivery_lease_token;
  s.advance(DM_DELIVERY_LEASE_SECONDS + 1);
  const replacement = reclaimed ? s.queue().claimDelivery!('L1')[0] : undefined;
  if (reclaimed) expect(s.row('A').delivery_lease_token).not.toBe(oldToken);
  const replacementToken = s.row('A').delivery_lease_token;
  release.resolve();
  expect(await old).toBe('inactive');
  expect(send).not.toHaveBeenCalled();
  expect(s.row('A').delivery_lease_token).toBe(reclaimed ? replacementToken : null);
  replacement?.cancel!();
  expect(s.failureStore.set).not.toHaveBeenCalled();
});

it('allows an already invoked host send to settle after logout and then confirms its receipt', async () => {
  const s = setup(), entered = deferred<void>(), release = deferred<void>();
  s.enqueue('A');
  const owner = new RuntimeOwnerNotifier(async () => { entered.resolve(); await release.promise; return { status: 'sent' }; }, {}, immediateTarget, s.logger);
  let settled = false;
  const work = s.deliver(owner).finally(() => { settled = true; });
  await entered.promise;
  s.logout('A'); s.loseOwner();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(s.row('A').delivered_at).toBeNull();
  release.resolve();
  expect(await work).toBe('channel');
  expect(s.row('A')).toMatchObject({ delivered_at: 1000, delivery_lease_token: null });
});

it('presentation filtering consumes only active-house L2 while explicit consumer history remains available', () => {
  const s = setup();
  s.notifier.bindConsumer('reader');
  for (const house of ['A', 'B']) s.notifier.enqueue({ level: 'L2', kind: 'general_reply', payload: { houseSlug: house } });
  s.logout('A');
  const eligible = (item: NotificationItem) => s.capture(item)?.isActive() ?? false;
  const view = s.notifier.presentationView(eligible);
  expect(view.count('L2')).toBe(1);
  expect(view.drain('L2').map(item => item.payload.houseSlug)).toEqual(['B']);
  expect(s.row('A').delivered_at).toBeNull();
  expect(s.row('B').delivered_at).toBe(1000);
  expect(s.notifier.peekFor('reader').map(item => item.payload.houseSlug)).toEqual(['A', 'B']);
});

it('automatic per-consumer counts filter inactive houses without acknowledging explicit history', () => {
  const s = setup();
  s.notifier.bindConsumer('reader');
  s.enqueue('A'); s.enqueue('B'); s.logout('A');
  const eligible = (item: NotificationItem) => s.capture(item)?.isActive() ?? false;
  expect(s.notifier.countFor('reader', 'L1', eligible)).toBe(1);
  expect(s.notifier.countFor('reader', 'L1')).toBe(2);
  const history = s.notifier.peekFor('reader', 'L1');
  expect(history.map(item => item.payload.houseSlug)).toEqual(['A', 'B']);
  expect(s.notifier.acknowledgeFor('reader', history.map(item => item.id))).toHaveLength(2);
});

it('a failed A send preserves retry policy while successful B still receives its own receipt', async () => {
  const s = setup();
  s.enqueue('A'); s.enqueue('B');
  const originalId = s.row('A').id;
  const owner = new RuntimeOwnerNotifier(async params => ({ status: params.payloads[0]!.text.includes('message from A') ? 'failed' : 'sent' }), {}, immediateTarget, s.logger);
  expect(await s.deliver(owner)).toBe('queued');
  expect(s.row('A')).toMatchObject({ id: originalId, delivered_at: null, delivery_lease_token: null });
  expect(JSON.parse(s.row('A').payload_json)).toMatchObject({ attempts: 1, retryAfter: 1030 });
  expect(s.row('B').delivered_at).toBe(1000);
  expect(s.failureStore.set).toHaveBeenCalledTimes(1);
  expect(s.failureStore.clear).not.toHaveBeenCalled();
  expect(s.queue().count()).toBe(0);
  s.advance(31);
  expect(s.queue().count()).toBe(1);
});

it('an exhausted legacy notification is retired without leaving a retryable claim', async () => {
  const s = setup();
  s.enqueue('A', true, 2);
  const owner = new RuntimeOwnerNotifier(async () => ({ status: 'failed' }), {}, immediateTarget, s.logger);
  expect(await s.deliver(owner)).toBe('queued');
  expect(s.row('A')).toMatchObject({ delivered_at: 1000, delivery_lease_token: null });
  s.advance(DM_DELIVERY_LEASE_SECONDS + 1);
  expect(s.queue().count()).toBe(0);
  expect(s.failureStore.set).toHaveBeenCalledTimes(1);
});

it('legacy drain and a second scoped observer cannot consume an outstanding claim', () => {
  const s = setup();
  s.enqueue('A', true);
  const first = s.queue().claimDelivery!('L1');
  expect(first).toHaveLength(1);
  expect(s.notifier.drain('L1')).toEqual([]);
  expect(s.queue().claimDelivery!('L1')).toEqual([]);
  expect(s.row('A').delivered_at).toBeNull();
  first[0]!.cancel!();
  expect(s.queue().claimDelivery!('L1')).toHaveLength(1);
});

it('a final claim-read error cancels before host invocation without consuming retry budget', async () => {
  const s = setup(), entered = deferred<void>(), release = deferred<void>();
  s.enqueue('A');
  const send = vi.fn(async () => ({ status: 'sent' }));
  const owner = new RuntimeOwnerNotifier(send, {}, async () => { entered.resolve(); await release.promise; return target; }, s.logger);
  const work = s.deliver(owner);
  await entered.promise;
  const query = s.db.queryOne.bind(s.db);
  let fail = true;
  vi.spyOn(s.db, 'queryOne').mockImplementation((sql, params) => {
    if (fail && sql.includes('delivery_lease_until >')) { fail = false; throw new Error('SQLITE_BUSY'); }
    return query(sql, params) as never;
  });
  release.resolve();
  expect(await work).toBe('inactive');
  expect(send).not.toHaveBeenCalled();
  expect(s.row('A').delivery_lease_token).toBeNull();
  expect(JSON.parse(s.row('A').payload_json).attempts).toBeUndefined();
  expect(s.failureStore.set).not.toHaveBeenCalled();
});

it('a replacement can deliver an expired claim without a resumed old observer sending again', async () => {
  const s = setup(), entered = deferred<void>(), release = deferred<void>();
  s.enqueue('A');
  const sends: string[] = [];
  const oldOwner = new RuntimeOwnerNotifier(async () => { sends.push('old'); return { status: 'sent' }; }, {}, async () => { entered.resolve(); await release.promise; return target; }, s.logger);
  const oldWork = s.deliver(oldOwner);
  await entered.promise;
  s.advance(DM_DELIVERY_LEASE_SECONDS + 1);
  const nextOwner = new RuntimeOwnerNotifier(async () => { sends.push('new'); return { status: 'sent' }; }, {}, immediateTarget, s.logger);
  expect(await s.deliver(nextOwner)).toBe('channel');
  release.resolve();
  expect(await oldWork).toBe('inactive');
  expect(sends).toEqual(['new']);
  expect(s.row('A')).toMatchObject({ delivered_at: 1301, delivery_lease_token: null });
});

it('the retry observer claims only eligible durable DMs and leaves legacy L1 untouched', () => {
  const s = setup();
  s.enqueue('A', true); s.enqueue('B');
  const retry = s.notifier.deliveryView(s.capture, { dmOnly: true });
  expect(retry.count()).toBe(1);
  const batches = retry.claimDelivery!('L1');
  expect(batches.flatMap(batch => batch.items).map(item => item.payload.houseSlug)).toEqual(['B']);
  expect(s.row('A')).toMatchObject({ delivered_at: null, delivery_lease_token: null });
  for (const batch of batches) batch.cancel!();
});

it('an eligibility error cannot partially consume or claim earlier rows', () => {
  const s = setup();
  s.enqueue('A', true); s.enqueue('B', true);
  const failure = new Error('authority read unavailable');
  const eligible = (item: NotificationItem) => { if (item.payload.houseSlug === 'B') throw failure; return true; };
  expect(() => s.notifier.presentationView(eligible).drain('L1')).toThrow(failure);
  expect(() => s.notifier.deliveryView(item => { eligible(item); return s.capture(item); }).claimDelivery!('L1')).toThrow(failure);
  expect(s.row('A')).toMatchObject({ delivered_at: null, delivery_lease_token: null });
  expect(s.row('B')).toMatchObject({ delivered_at: null, delivery_lease_token: null });
});

it('a stalled A target lookup does not delay B host invocation', async () => {
  const s = setup(), entered = deferred<void>(), release = deferred<void>();
  s.enqueue('A'); s.enqueue('B');
  let targets = 0;
  const send = vi.fn(async (_params: { payloads: { text: string }[] }) => ({ status: 'sent' }));
  const owner = new RuntimeOwnerNotifier(send, {}, async () => {
    if (++targets === 1) { entered.resolve(); await release.promise; }
    return target;
  }, s.logger);
  const work = s.deliver(owner);
  await entered.promise;
  try {
    await vi.waitFor(() => expect(send.mock.calls.some(call => call[0].payloads[0]!.text.includes('message from B'))).toBe(true), { timeout: 100 });
  } finally {
    s.logout('A'); release.resolve();
    await work;
  }
  expect(send).toHaveBeenCalledTimes(1);
});

// Record the real SQLite delivery view and original host entry, including exact
// text/media and receipt state, before extracting content from the delivery owner.
it.each(['sent', 'partial_failed', 'failed', 'drop', 'early-inactive', 'late-inactive', 'content-error', 'staging-error'] as const)(
  'preserves complete L1 delivery effects (%s)', async mode => {
    const s = setup();
    const trace: unknown[] = [];
    setOwnerLang('zh-CN', 'config');
    s.enqueue('A', mode === 'drop', mode === 'drop' ? 2 : 0);
    const view = s.queue();
    const queue = { ...view, claimDelivery: view.claimDelivery!, confirmDelivery: view.confirmDelivery!, discardDelivery: view.discardDelivery!, retryDelivery: view.retryDelivery! };
    const claim = queue.claimDelivery!.bind(queue);
    vi.spyOn(queue, 'claimDelivery').mockImplementation(level => {
      trace.push(['claim', level]);
      return claim(level).map(batch => {
        const item = batch.items[0]!;
        item.payload.mediaPath = '/local/photo.png';
        if (mode === 'content-error') Object.defineProperty(item.payload, 'body', { get: () => { throw new Error('body unavailable'); } });
        return { ...batch,
          authorizeSend: () => {
            trace.push('authorize');
            if (mode === 'early-inactive') s.logout('A');
            batch.authorizeSend!();
          },
          cancel: () => { trace.push('cancel'); batch.cancel!(); },
        };
      });
    });
    for (const method of ['confirmDelivery', 'discardDelivery'] as const) {
      const original = queue[method]!.bind(queue);
      vi.spyOn(queue, method).mockImplementation(items => { trace.push([method, items.map(item => item.id)]); original(items); });
    }
    const retry = queue.retryDelivery!.bind(queue);
    vi.spyOn(queue, 'retryDelivery').mockImplementation((item, payload) => { trace.push(['retryDelivery', item.id, payload]); return retry(item, payload); });
    s.failureStore.set.mockImplementation(f => { trace.push(['failure.set', f]); });
    s.failureStore.clear.mockImplementation(() => { trace.push('failure.clear'); });
    s.logger.info.mockImplementation(message => { trace.push(['info', message]); });
    s.logger.warn.mockImplementation(message => { trace.push(['warn', message]); });
    const owner = new RuntimeOwnerNotifier(async params => {
      trace.push(['host', params]);
      // The dropped summary must read the language at failure time, not reuse
      // the content rendered before the host call.
      if (mode === 'drop') setOwnerLang('en', 'config');
      return { status: mode === 'drop' ? 'failed' : mode };
    }, {}, async () => {
      trace.push('target.enter');
      await Promise.resolve();
      trace.push('target.return');
      if (mode === 'late-inactive') s.logout('A');
      return target;
    }, s.logger);
    try {
      const outcome = await notifyOwnerNow({
        notifier: queue, owner, logger: s.logger, failureStore: s.failureStore, now: () => 1000,
        resolveTarget: async () => { trace.push('resolve'); return target; },
        stageMedia: path => {
          trace.push(['stage', path]);
          if (mode === 'staging-error') throw new Error('staging unavailable');
          return '/staged/photo.png';
        },
      }).then(value => ({ value }), error => ({ error: (error as Error).message }));
      const row = s.row('A');
      expect({ outcome, trace, row: { id: row.id, deliveredAt: row.delivered_at, lease: row.delivery_lease_token !== null, leaseUntil: row.delivery_lease_until, payload: JSON.parse(row.payload_json) } }).toMatchSnapshot();
    } finally {
      setOwnerLang(undefined);
    }
  },
);
