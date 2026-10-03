/**
 * T2: WorldSummaryClient 单元测试
 */
import { describe, it, expect } from 'vitest';
import { WorldSummaryClient } from '../../../src/world/world-summary-client.js';
import type { WorldSummaryResponse } from '../../../src/world/world-summary-client.js';
import { deriveSigil } from '../../../src/invite/sigil.js';

const BASE = 'http://localhost:8080';

function makeValidResponse(): WorldSummaryResponse {
  return {
    window_hours: 24,
    generated_at_ms: 1_718_000_000_000,
    total_posts: 42,
    distinct_authors: 5,
    authors: {
      'AAAA1111': { nickname: 'mrbeast' },
      'BBBB2222': { nickname: 'alixearle' },
    },
    hot_posts: [
      {
        event_id: 'abcdef1234',
        author: 'AAAA1111',
        platform: 'youtube',
        body_preview: 'Last to leave wins $100k',
        reply_count: 10,
        quote_count: 2,
        created_at_ms: 1_718_000_000_000,
      },
      {
        event_id: 'fedcba5678',
        author: 'BBBB2222',
        platform: 'instagram',
        body_preview: 'Morning routine ✨',
        reply_count: 3,
        quote_count: 0,
        created_at_ms: 1_717_999_000_000,
      },
    ],
  };
}

function jsonFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

function throwingFetch(message = 'network error'): typeof globalThis.fetch {
  return (() => Promise.reject(new Error(message))) as unknown as typeof globalThis.fetch;
}

describe('WorldSummaryClient', () => {
  it('fetches /v1/world-summary and returns typed response on 200', async () => {
    const body = makeValidResponse();
    const client = new WorldSummaryClient({ baseUrl: BASE, fetch: jsonFetch(200, body) });
    const result = await client.fetchSummary();

    expect(result).not.toBeNull();
    expect(result!.window_hours).toBe(24);
    expect(result!.total_posts).toBe(42);
    expect(result!.distinct_authors).toBe(5);
    expect(result!.authors['AAAA1111']!.nickname).toBe('mrbeast');
    expect(result!.hot_posts).toHaveLength(2);
    expect(result!.hot_posts[0]!.platform).toBe('youtube');
  });

  it('passes v2 fields through (world_state / notable_people / summary_note), all optional', async () => {
    const body: WorldSummaryResponse = {
      ...makeValidResponse(),
      world_state: {
        identities_total: 56,
        namecards_total: 2,
        verified_accounts_total: 8,
        native_posts_total: 7,
      },
      notable_people: [
        {
          popclaw_id: 'AAAA1111',
          nickname: 'mrbeast',
          accounts: [{ platform: 'youtube', handle: 'mrbeast', follower_count: 220_000_000 }],
          followers_total: 220_000_000,
        },
      ],
      summary_note: '精华——回应、引用与新近度的混合排序，附江湖状态与认证名人',
    };
    const client = new WorldSummaryClient({ baseUrl: BASE, fetch: jsonFetch(200, body) });
    const result = await client.fetchSummary();

    expect(result!.world_state!.identities_total).toBe(56);
    expect(result!.notable_people![0]!.accounts[0]!.handle).toBe('mrbeast');
    expect(result!.summary_note).toContain('混合排序');
  });

  it('tolerates an old server response without v2 fields (fields stay undefined)', async () => {
    const client = new WorldSummaryClient({
      baseUrl: BASE,
      fetch: jsonFetch(200, makeValidResponse()),
    });
    const result = await client.fetchSummary();

    expect(result).not.toBeNull();
    expect(result!.world_state).toBeUndefined();
    expect(result!.notable_people).toBeUndefined();
    expect(result!.summary_note).toBeUndefined();
  });

  it('sends window_hours param when provided', async () => {
    const calls: string[] = [];
    const fetchMock: typeof globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(makeValidResponse()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const client = new WorldSummaryClient({ baseUrl: BASE, fetch: fetchMock });
    await client.fetchSummary(48);
    expect(calls[0]).toContain('window_hours=48');
  });

  it('omits window_hours param when not provided', async () => {
    const calls: string[] = [];
    const fetchMock: typeof globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(makeValidResponse()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const client = new WorldSummaryClient({ baseUrl: BASE, fetch: fetchMock });
    await client.fetchSummary();
    expect(calls[0]).not.toContain('window_hours');
  });

  it('returns null on HTTP 500', async () => {
    const client = new WorldSummaryClient({ baseUrl: BASE, fetch: jsonFetch(500, { error: 'oops' }) });
    const result = await client.fetchSummary();
    expect(result).toBeNull();
  });

  it('returns null on HTTP 404', async () => {
    const client = new WorldSummaryClient({ baseUrl: BASE, fetch: jsonFetch(404, { error: 'not found' }) });
    const result = await client.fetchSummary();
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const client = new WorldSummaryClient({ baseUrl: BASE, fetch: throwingFetch() });
    const result = await client.fetchSummary();
    expect(result).toBeNull();
  });

  it('handles missing authors map gracefully (empty object)', async () => {
    const body: WorldSummaryResponse = {
      ...makeValidResponse(),
      authors: {},
      hot_posts: [
        {
          event_id: 'xyz123',
          author: 'UNKNOWN99',
          platform: 'x',
          body_preview: 'hello',
          reply_count: 1,
          quote_count: 0,
          created_at_ms: 1_718_000_000_000,
        },
      ],
    };
    const client = new WorldSummaryClient({ baseUrl: BASE, fetch: jsonFetch(200, body) });
    const result = await client.fetchSummary();
    expect(result).not.toBeNull();
    // author not found in map — hot_post still present with no nickname
    expect(result!.hot_posts[0]!.author).toBe('UNKNOWN99');
    expect(result!.authors['UNKNOWN99']).toBeUndefined();
  });

  it('nicknameFor returns popclaw_id prefix when author not in map', async () => {
    const body = makeValidResponse();
    const client = new WorldSummaryClient({ baseUrl: BASE, fetch: jsonFetch(200, body) });
    const result = await client.fetchSummary();
    expect(result).not.toBeNull();
    // nicknameFor on unknown id → first 8 chars of id
    // 名册查无只报印信，不是 id 前缀 —— 这串是给主人看的（ADR-0032）。
    expect(WorldSummaryClient.nicknameFor(result!, 'ZZZZ9999abcdef')).toBe(
      `#${deriveSigil('ZZZZ9999abcdef')}`,
    );
    // nicknameFor on known id → nickname
    expect(WorldSummaryClient.nicknameFor(result!, 'AAAA1111')).toBe('mrbeast');
  });
});
