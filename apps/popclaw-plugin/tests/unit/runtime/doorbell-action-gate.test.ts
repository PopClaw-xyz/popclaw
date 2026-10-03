import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { makeIntentPullClient, type FetchJson } from '../../../src/canvas/intent-pull-client.js';
import { createDoorbellService, DOORBELL_HOT_TICK_MS, type DoorbellDeps } from '../../../src/newspaper/follow-doorbell-service.js';
import { PendingFollowStore, type FollowIntentRow } from '../../../src/social-graph/pending-follow-store.js';
import { withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
import type { Signer } from '../../../src/identity/signer.js';
import { noDmCrypto } from '../../helpers/test-signer.js';

vi.mock('undici', () => ({ request: vi.fn() }));
const NOW = 1_750_000_000_000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function gate() {
  const controller = new AbortController();
  return { signal: controller.signal, isActive: () => !controller.signal.aborted, close: () => controller.abort() };
}
function signer(): Signer {
  return { publicKey: async () => new Uint8Array(32), popclawId: vi.fn(async () => 'self'),
    sign: vi.fn(async () => new Uint8Array(64)), ...noDmCrypto };
}
function intent(): FollowIntentRow {
  return { owner_popclaw_id: 'self', followee_popclaw_id: 'author', followee_label: 'untrusted',
    first_ts: NOW - 30 * 60_000, latest_ts: NOW - 25 * 60_000, click_count: 1 };
}
const hosts: InMemoryHostAdapter[] = [];
beforeEach(() => { vi.mocked(request).mockReset(); });
afterEach(() => { for (const host of hosts.splice(0)) host.db.close(); });
function service(over: Partial<DoorbellDeps> = {}) {
  const host = new InMemoryHostAdapter(); hosts.push(host);
  const store = new PendingFollowStore(host.db, () => NOW / 1000);
  const pull = vi.fn<DoorbellDeps['pull']>(async () => []);
  const enqueue = vi.fn(); const deliverNow = vi.fn(async () => true);
  const info = vi.fn(); const warn = vi.fn();
  const svc = createDoorbellService({
    ownerPopclawId: 'self', store, pull, followsIn: () => false,
    readFollowableAuthors: () => [{ issue_date: '2026-09-07', popclaw_id: 'author', display_name: 'Author',
      descriptor: null, expires_at: NOW + 48 * 60 * 60_000 }],
    notifier: { enqueue }, deliverNow, clock: () => NOW, localHour: () => 12,
    logger: { info, warn }, ...over,
  });
  return { svc, store, pull, enqueue, deliverNow, info, warn };
}

describe('canvas pull retains the enclosing action through signer and HTTP awaits', () => {
  it('stops before signing when identity lookup finishes after logout', async () => {
    const identity = deferred<string>(); const s = signer(); s.popclawId = vi.fn(() => identity.promise);
    const fetchJson = vi.fn<FetchJson>(async () => ({ status: 200, text: '{"intents":[]}' }));
    const client = makeIntentPullClient({ baseUrl: 'https://canvas.invalid', signer: s, fetchJson });
    const g = gate(); const work = withAction(g, () => client.pull('self', 0));
    const rejected = expect(work).rejects.toThrow('no longer active');
    g.close(); identity.resolve('self'); await rejected;
    expect(s.sign).not.toHaveBeenCalled(); expect(fetchJson).not.toHaveBeenCalled();
  });

  it('stops before the final HTTP send when signing finishes after logout', async () => {
    const signed = deferred<Uint8Array>(); const signing = deferred<void>(); const s = signer();
    s.sign = vi.fn(() => { signing.resolve(); return signed.promise; });
    const fetchJson = vi.fn<FetchJson>(async () => ({ status: 200, text: '{"intents":[]}' }));
    const client = makeIntentPullClient({ baseUrl: 'https://canvas.invalid', signer: s, fetchJson });
    const g = gate(); const work = withAction(g, () => client.pull('self', 0));
    const rejected = expect(work).rejects.toThrow('no longer active');
    await signing.promise; g.close(); signed.resolve(new Uint8Array(64)); await rejected;
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('passes the action signal to undici and rejects a late response body', async () => {
    const body = deferred<string>(); const reading = deferred<void>(); const destroy = vi.fn();
    vi.mocked(request).mockResolvedValue({ statusCode: 200, body: {
      text: () => { reading.resolve(); return body.promise; }, destroy, once: vi.fn(),
    } } as unknown as Awaited<ReturnType<typeof request>>);
    const client = makeIntentPullClient({ baseUrl: 'https://canvas.invalid', signer: signer() });
    const g = gate(); const work = withAction(g, () => client.pull('self', 0));
    const rejected = expect(work).rejects.toThrow('no longer active');
    await reading.promise; g.close(); body.resolve(JSON.stringify({ intents: [intent()] })); await rejected;
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(request).mock.calls[0]?.[1]?.signal).toBe(g.signal);
    expect(g.signal.aborted).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('doorbell cancellation leaves pending facts and delivery ownership intact', () => {
  it('does not absorb, sweep, notify, or advance cursor after a late pull', async () => {
    const response = deferred<FollowIntentRow[]>(); const pulled = deferred<void>();
    const pull = vi.fn<DoorbellDeps['pull']>(() => { pulled.resolve(); return response.promise; });
    const h = service({ pull }); const absorb = vi.spyOn(h.store, 'absorb'); const sweep = vi.spyOn(h.store, 'expireOlderThan');
    const g = gate(); const work = withAction(g, () => h.svc.tick());
    await pulled.promise; g.close(); response.resolve([intent()]);
    expect(await work).toBe(DOORBELL_HOT_TICK_MS);
    expect(absorb).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.deliverNow).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
    pull.mockResolvedValue([]);
    await withAction(gate(), () => h.svc.tick());
    expect(pull.mock.calls.map(([, after]) => after)).toEqual([0, 0]);
    expect(h.store.listPending()).toEqual([]);
  });

  it('does not touch the database or pull if cancellation happens before tick starts', async () => {
    const h = service(); const sweep = vi.spyOn(h.store, 'expireOlderThan'); const g = gate();
    await withAction(g, () => { g.close(); return h.svc.tick(); });
    expect(h.pull).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.deliverNow).not.toHaveBeenCalled();
  });

  it('waits for an already-started host delivery and never repeats the claim', async () => {
    const delivered = deferred<boolean>(); const started = deferred<void>();
    const deliverNow = vi.fn(() => { started.resolve(); return delivered.promise; });
    const h = service({ deliverNow });
    h.store.absorb([intent()], { authors: new Map([['author', { display_name: 'Author', descriptor: null, issue_date: '2026-09-07' }]]), followsIn: () => false });
    const g = gate(); let settled = false;
    const work = withAction(g, () => h.svc.tick()).finally(() => { settled = true; });
    await started.promise; g.close();
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
    expect(h.store.listPending()[0]?.first_surfaced_ts).not.toBeNull();
    delivered.resolve(true); await work;
    expect(h.info).not.toHaveBeenCalled(); expect(h.warn).not.toHaveBeenCalled();
    await withAction(gate(), () => h.svc.tick());
    expect(deliverNow).toHaveBeenCalledTimes(1);
  });

  it('still absorbs and enqueues an active pull without changing wire fields', async () => {
    const fetchJson = vi.fn<FetchJson>(async () => ({ status: 200, text: JSON.stringify({ intents: [intent()] }) }));
    const client = makeIntentPullClient({ baseUrl: 'https://canvas.invalid', signer: signer(), fetchJson });
    const h = service({ pull: client.pull }); const g = gate();
    expect(await withAction(g, () => h.svc.tick())).toBe(DOORBELL_HOT_TICK_MS);
    expect(h.store.listPending()).toHaveLength(1); expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(fetchJson.mock.calls[0]?.[0]).toBe('https://canvas.invalid/v1/follow-intents?owner=self&after=0');
    expect(Object.keys(fetchJson.mock.calls[0]?.[1] ?? {}).sort()).toEqual(['X-Nonce', 'X-Popclaw-Id', 'X-Signature', 'X-Ts']);
  });
});
