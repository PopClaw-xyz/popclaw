import { describe, expect, it, vi } from 'vitest';
import { Ranger } from '../../../src/runtime/ranger.js';
import { WatchLoop } from '../../../src/watch/watch-loop.js';
import { WatchRegistry, defaultEntry } from '../../../src/watch/watch-registry.js';
import { QuestHandler } from '../../../src/quest/quest-handler.js';
import { EventDispatcher } from '../../../src/ingress/event-dispatcher.js';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { PluginConfig } from '../../../src/config/schema.js';
import { noDmCrypto } from '../../helpers/test-signer.js';
import type { VerifyInviteHandler } from '../../../src/quest/verify-invite-handler.js';
import type { ScrapeContentHandler } from '../../../src/quest/scrape-content-handler.js';
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function gate() { const controller = new AbortController(); return { signal: controller.signal, isActive: () => !controller.signal.aborted, close: () => controller.abort() }; }
const signer = { publicKey: async () => new Uint8Array(32), sign: async () => new Uint8Array(64), popclawId: async () => 'self', ...noDmCrypto };
describe('Ranger captured lifecycle boundaries', () => {
  it('drains pending startup without starting ingress after stop', async () => {
    const identity = deferred<string>(); const called = deferred<void>(); const g = gate();
    const startIngress = vi.fn();
    const ranger = new Ranger({ host: new InMemoryHostAdapter(), config: PluginConfig.parse({ lore_houses: ['https://house.invalid'] }), signer: { ...signer, popclawId: () => { called.resolve(); return identity.promise; } }, nickname: 'test', egress: { push: vi.fn() }, ingress: { start: startIngress, stop: vi.fn() }, gate: g } as ConstructorParameters<typeof Ranger>[0]);
    const starting = ranger.start(); await called.promise;
    let stopped = false; const stopping = ranger.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve(); expect(stopped).toBe(false);
    identity.resolve('self'); await starting; await stopping;
    expect(startIngress).not.toHaveBeenCalled();
    await ranger.start(); expect(startIngress).not.toHaveBeenCalled();
  });
  it('does not push or persist a delayed watch result after logout', async () => {
    const result = deferred<import('../../../src/scraper/platform-scraper.js').ScrapedPost[]>(); const g = gate(); const save = vi.fn();
    const registry = new WatchRegistry({ load: () => null, save }); registry.add('w', 'target', 'handle', 'x', defaultEntry(-1_000_000));
    const push = vi.fn(); const loop = new WatchLoop({ registry, scraperRegistry: new Map([['x', { fetchVerificationTargets: vi.fn(), scrapeTimeline: () => result.promise }]]), push, maxScanItems: 20, gate: g } as ConstructorParameters<typeof WatchLoop>[0]);
    const ticking = loop.tick(1000); g.close(); result.resolve([{ id: 'p', text: 'post', createdAt: new Date(2000000), originalUrl: 'https://content.invalid/p' }]); await ticking;
    expect(push).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('does not route an expired authenticated quest', async () => {
    const dispatcher = new EventDispatcher(); const verify = { handle: vi.fn() }; const scrape = { handle: vi.fn() };
    const handler = new QuestHandler({ dispatcher, signer, verifyInvite: verify as unknown as VerifyInviteHandler, scrapeContent: scrape as unknown as ScrapeContentHandler, gate: gate(), now: () => 2000 } as ConstructorParameters<typeof QuestHandler>[0]);
    await handler.start(); await dispatcher.dispatch({ eventId: 'event', envelope: { target: { targetIds: ['self'] }, questDispatch: { taskId: 'task', kind: 1, expiresAt: '1', verifyInvite: {} } } });
    expect(verify.handle).not.toHaveBeenCalled();
  });
});

// The wire identity is valid; slow signing below is intentionally uncancellable.
const wireSigner = { ...signer, popclawId: async () => '11111111111111111111111111111111' };
const questEnv = () => ({ eventId: 'q', envelope: { questDispatch: { taskId: 'task', expiresAt: '100' } } });
describe('quest asynchronous stage boundaries', () => {
  it('does not fall back to search after a proof request settles after logout', async () => {
    const { VerifyInviteHandler } = await import('../../../src/quest/verify-invite-handler.js');
    const proof = deferred<import('../../../src/scraper/platform-scraper.js').FetchedPost>(); const entered = deferred<void>(); const g = gate();
    const fetchVerificationTargets = vi.fn(); const fetchAuthorProfile = vi.fn(); const push = vi.fn();
    const handler = new VerifyInviteHandler({ gate: g, now: () => 1000, signer: wireSigner, egress: { push }, scraperRegistry: new Map([['x', { scrapeTimeline: vi.fn(), fetchVerificationTargets, fetchAuthorProfile, fetchPostById: () => { entered.resolve(); return proof.promise; } }]]) });
    const work = handler.handle(questEnv(), { platform: 'x', handle: 'tester', expectedSigil: 'sigil', proofUrl: 'https://proof.invalid/status/123' });
    await entered.promise; g.close(); proof.resolve({ post: null, rawBytes: new Uint8Array() }); await work;
    expect(fetchVerificationTargets).not.toHaveBeenCalled(); expect(fetchAuthorProfile).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
  });
  it('does not initiate an outer signature or push when a quest expires during signing', async () => {
    const { VerifyInviteHandler } = await import('../../../src/quest/verify-invite-handler.js');
    const signature = deferred<Uint8Array>(); const entered = deferred<void>(); let now = 1000;
    const sign = vi.fn(() => { entered.resolve(); return signature.promise; }); const push = vi.fn();
    const handler = new VerifyInviteHandler({ gate: gate(), now: () => now, signer: { ...wireSigner, sign }, egress: { push }, mock: { decide: () => 'APPROVE' } });
    const work = handler.handle(questEnv(), {}); await entered.promise; now = 100000; signature.resolve(new Uint8Array(64)); await work;
    expect(sign).toHaveBeenCalledTimes(1); expect(push).not.toHaveBeenCalled();
  });
  it('does not send a second mirror or terminal result after logout during the first push', async () => {
    const { ScrapeContentHandler } = await import('../../../src/quest/scrape-content-handler.js');
    const receipt = deferred<import('../../../src/egress/event-egress.js').PushResult>(); const entered = deferred<void>(); const g = gate();
    const push = vi.fn(() => { entered.resolve(); return receipt.promise; });
    const posts = ['one', 'two'].map((id) => ({ id, text: id, originalUrl: `https://content.invalid/${id}`, createdAt: new Date(1000) }));
    const handler = new ScrapeContentHandler({ gate: g, now: () => 1000, signer: wireSigner, egress: { push }, scraperRegistry: new Map([['x', { fetchVerificationTargets: vi.fn(), scrapeTimeline: async () => posts }]]) });
    const work = handler.handle(questEnv(), { platform: 'x', handle: 'tester' }); await entered.promise; g.close(); receipt.resolve({ status: 200, deduplicated: false }); await work;
    expect(push).toHaveBeenCalledTimes(1);
  });
  it('does not turn cancelled scraping into an ABSTAIN result', async () => {
    const { ScrapeContentHandler } = await import('../../../src/quest/scrape-content-handler.js');
    const result = deferred<void>(); const g = gate(); const push = vi.fn();
    const handler = new ScrapeContentHandler({ gate: g, now: () => 1000, signer: wireSigner, egress: { push }, scraperRegistry: new Map([['x', { fetchVerificationTargets: vi.fn(), scrapeTimeline: async () => { await result.promise; throw new Error('late provider failure'); } }]]) });
    const work = handler.handle(questEnv(), { platform: 'x', handle: 'tester' }); g.close(); result.resolve(); await work;
    expect(push).not.toHaveBeenCalled();
  });
});

describe('per-house Ranger resources', () => {
  it('isolates identical watch IDs in shared SQLite and leaves legacy watermarks intact', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); vi.stubEnv('POPCLAW_TWITTERAPI_IO_KEY', 'fake-key');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ tweets: [{ type: 'tweet', id: 'new-post', text: 'new', url: 'https://content.invalid/new', createdAt: new Date(2000000).toISOString(), author: { userName: 'tester' } }], has_next_page: false })));
    vi.stubGlobal('fetch', fetch);
    const host = new InMemoryHostAdapter();
    host.db.execute('INSERT INTO watch_watermarks (watch_id, last_seen_created_at, last_seen_platform_post_id) VALUES (?, ?, ?)', ['shared', 1, 'legacy']);
    const rangers: Ranger[] = [];
    try {
      for (const origin of ['https://a.invalid', 'https://b.invalid']) {
        let deliver!: (event: import('../../../src/ingress/event-ingress.js').InboundEnvelope) => Promise<void> | void;
        const ranger = new Ranger({ host, houseOrigin: origin, gate: gate(), config: PluginConfig.parse({ lore_houses: [origin], ranger_mode: true }), signer: wireSigner, nickname: 'test', egress: { push: async () => ({ status: 200, deduplicated: false }) }, ingress: { start: async (handler) => { deliver = handler; }, stop: async () => {} } });
        rangers.push(ranger); await ranger.start();
        await deliver({ eventId: 'dispatch', envelope: { watchDispatch: { watchId: 'shared', targetPopclawId: 'target', platform: 'x', handle: 'tester', since: 1 } } });
      }
      await vi.advanceTimersByTimeAsync(300001);
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const origin of ['https://a.invalid', 'https://b.invalid']) {
        expect(host.db.queryOne<{ last_seen_platform_post_id: string }>('SELECT last_seen_platform_post_id FROM watch_watermarks WHERE watch_id = ?', [JSON.stringify([origin, 'shared'])])?.last_seen_platform_post_id).toBe('new-post');
      }
      expect(host.db.queryOne<{ last_seen_platform_post_id: string }>('SELECT last_seen_platform_post_id FROM watch_watermarks WHERE watch_id = ?', ['shared'])?.last_seen_platform_post_id).toBe('legacy');
      await rangers[0]!.stop();
      fetch.mockImplementation(async () => new Response(JSON.stringify({ tweets: [{ type: 'tweet', id: 'b-continues', text: 'newer', url: 'https://content.invalid/next', createdAt: new Date(4000000).toISOString(), author: { userName: 'tester' } }], has_next_page: false })));
      await vi.advanceTimersByTimeAsync(300001);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(host.db.queryOne<{ last_seen_platform_post_id: string }>('SELECT last_seen_platform_post_id FROM watch_watermarks WHERE watch_id = ?', [JSON.stringify(['https://a.invalid', 'shared'])])?.last_seen_platform_post_id).toBe('new-post');
      expect(host.db.queryOne<{ last_seen_platform_post_id: string }>('SELECT last_seen_platform_post_id FROM watch_watermarks WHERE watch_id = ?', [JSON.stringify(['https://b.invalid', 'shared'])])?.last_seen_platform_post_id).toBe('b-continues');
    } finally {
      await Promise.all(rangers.map((ranger) => ranger.stop())); host.db.close();
      vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
    }
  });
});

describe('Ranger timer drain', () => {
  it('waits for a running heartbeat signature and never pushes it after stop', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const signature = deferred<Uint8Array>(); const signingHeartbeat = deferred<void>(); let signs = 0;
    const push = vi.fn(async () => ({ status: 200, deduplicated: false }));
    let deliver!: (event: import('../../../src/ingress/event-ingress.js').InboundEnvelope) => Promise<void> | void;
    const host = new InMemoryHostAdapter();
    const ranger = new Ranger({ host, gate: gate(), config: PluginConfig.parse({ lore_houses: ['https://house.invalid'], ranger_mode: true }), signer: { ...wireSigner, sign: async () => { signs++; if (signs > 2) { signingHeartbeat.resolve(); return signature.promise; } return new Uint8Array(64); } }, nickname: 'test', egress: { push }, ingress: { start: async (handler) => { deliver = handler; }, stop: async () => {} } });
    try {
      await ranger.start(); await deliver({ eventId: 'watch', envelope: { watchDispatch: { watchId: 'w', targetPopclawId: 'target', platform: 'x', handle: 'tester' } } });
      await vi.advanceTimersByTimeAsync(60000); await signingHeartbeat.promise;
      let stopped = false; const stopping = ranger.stop().then(() => { stopped = true; });
      await Promise.resolve(); await Promise.resolve(); expect(stopped).toBe(false);
      signature.resolve(new Uint8Array(64)); await stopping;
      await vi.advanceTimersByTimeAsync(300000);
      expect(push).toHaveBeenCalledTimes(1); expect(signs).toBe(3);
    } finally {
      signature.resolve(new Uint8Array(64)); await ranger.stop(); host.db.close(); vi.useRealTimers();
    }
  });
});

describe('Ranger persisted ingress replay', () => {
  it('registers watch handlers before ingress.start delivers its first pending event', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); vi.stubEnv('POPCLAW_TWITTERAPI_IO_KEY', 'fake-key');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ tweets: [], has_next_page: false })));
    vi.stubGlobal('fetch', fetch);
    const host = new InMemoryHostAdapter();
    const ranger = new Ranger({
      host, gate: gate(), houseOrigin: 'https://house.invalid',
      config: PluginConfig.parse({ lore_houses: ['https://house.invalid'], ranger_mode: true }),
      signer: wireSigner, nickname: 'test',
      egress: { push: async () => ({ status: 200, deduplicated: false }) },
      ingress: {
        start: async (handler) => {
          await handler({ eventId: 'persisted-watch', envelope: { watchDispatch: { watchId: 'first', targetPopclawId: 'target', platform: 'x', handle: 'tester', since: 1 } } });
        },
        stop: async () => {},
      },
    });
    try {
      await ranger.start(); await vi.advanceTimersByTimeAsync(300001);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await ranger.stop(); host.db.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
    }
  });
});
