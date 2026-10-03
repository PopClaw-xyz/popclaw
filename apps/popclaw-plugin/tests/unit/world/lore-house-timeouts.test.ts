/**
 * Every read leg to a lore-house must hand its fetch an AbortSignal.
 *
 * Node's `fetch` has no default timeout, so a house that accepts the TCP
 * connection and then says nothing hangs the caller forever: a command with
 * no answer, timer ticks stacking up behind each other. One test per client
 * so a new leg added without a signal shows up here rather than on a machine.
 *
 * The undici legs (ServerPushEgress / uploadCanvas) can't be checked this way
 * — they take no injected fetch — so they get real hanging-server tests in
 * their own files.
 */
import { describe, it, expect, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { WorldFeedClient } from '../../../src/ingress/world-feed-client';
import { ResolveClient } from '../../../src/world/resolve-client';
import { GuideClient } from '../../../src/world/guide-client';
import { WorldSummaryClient } from '../../../src/world/world-summary-client';
import { fetchFollowers } from '../../../src/social-graph/followers-sync';
import { grantedReadAuthority } from '../../helpers/read-authority.js';
import { ensureNamecardOnHouse } from '../../../src/messaging/announce-namecard';
import { LORE_HOUSE_TIMEOUT_MS } from '../../../src/world/http-timeout';

/** A fetch that records its `init` and answers whatever the caller needs. */
function spyFetch(body: unknown = {}, bytes?: Uint8Array) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => {
      const src = bytes ?? new Uint8Array();
      const ab = new ArrayBuffer(src.byteLength);
      new Uint8Array(ab).set(src);
      return ab;
    },
  })) as unknown as ReturnType<typeof vi.fn>;
}

function signalOf(fetch: ReturnType<typeof vi.fn>): AbortSignal | undefined {
  const [, init] = (fetch.mock.calls[0] ?? []) as [string, RequestInit | undefined];
  return init?.signal ?? undefined;
}

describe('lore-house read legs carry an abort signal', () => {
  it('WorldFeedClient.fetchSnapshot', async () => {
    const snap = popclaw.event.WorldFeedSnapshot.encode({ items: [] }).finish() as Uint8Array;
    const fetch = spyFetch({}, snap);
    await new WorldFeedClient({
      baseUrl: 'http://h',
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).fetchSnapshot({});
    expect(signalOf(fetch)).toBeInstanceOf(AbortSignal);
  });

  it('ResolveClient.resolve', async () => {
    const fetch = spyFetch({ candidates: [] });
    await new ResolveClient({
      baseUrl: 'http://h',
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).resolve({ sigil: 'abcdef' });
    expect(signalOf(fetch)).toBeInstanceOf(AbortSignal);
  });

  it('GuideClient.fetchGuideText', async () => {
    const fetch = spyFetch({});
    await new GuideClient({
      baseUrl: 'http://h',
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).fetchGuideText();
    expect(signalOf(fetch)).toBeInstanceOf(AbortSignal);
  });

  it('WorldSummaryClient.fetchSummary', async () => {
    const fetch = spyFetch({});
    await new WorldSummaryClient({
      baseUrl: 'http://h',
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).fetchSummary();
    expect(signalOf(fetch)).toBeInstanceOf(AbortSignal);
  });

  it('fetchFollowers', async () => {
    const fetch = spyFetch([]);
    await fetchFollowers(fetch as unknown as typeof globalThis.fetch, 'http://h', 'ME', grantedReadAuthority);
    expect(signalOf(fetch)).toBeInstanceOf(AbortSignal);
  });

  it('ensureNamecardOnHouse (the "does the house already have my card" probe)', async () => {
    const fetch = spyFetch({ card: { declared_at_ms: 9_000_000_000_000 } });
    await ensureNamecardOnHouse('http://h', {
      card: { nickname: 'x', declaredAt: 1 } as never,
      signedBytes: new Uint8Array(),
      popclawId: 'ME',
      pushTo: async () => ({ status: 200 }),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(signalOf(fetch)).toBeInstanceOf(AbortSignal);
  });

  // The budget itself: a wedged house must not hold a read leg longer than this.
  it('the read budget is 10s', () => {
    expect(LORE_HOUSE_TIMEOUT_MS).toBe(10_000);
  });
});
