/**
 * C3 short-reference reply resolution.
 *
 * popclaw_author_latest prints popclaw-native posts as
 * `<webBaseUrl>/post/<first 10 chars of the event_id>`, while
 * popclaw_draft_post's reply_to_event_id / quote_of_event_id used to accept
 * only the full 64-hex event_id — the agent could not naturally close the
 * loop (real-machine acceptance failure: the agent was told to reply, got a
 * short link, found nothing in show_feed, gave up).
 *
 * These tests pin the letter's binding resolution rules end-to-end through
 * the REAL tool handlers:
 *   1. unique match only — 0 or >1 matches → explicit refusal naming the
 *      absence/ambiguity, never pick-first, never guess
 *   2. trusted sources only — the local world-stream cache, PLUS the exact
 *      short-id→event-id mapping popclaw_author_latest itself just observed
 *      (the local cache can be EMPTY while author_latest read from the
 *      server); URLs only against the trusted web base
 *   3. legacy full 64-hex ids keep working unchanged
 *   4. reply/quote mutual exclusion and the draft-confirm gate do not regress
 *      (their existing tests in register-tools.test.ts stay untouched)
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { registerWriteTools } from '../../../src/tools/write-tools.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import { sendDraftApproved } from '../../helpers/owner-approval-script.js';
import {
  _observedPostIdsForTest,
  rememberObservedPostIds,
  resolvePostRef,
} from '../../../src/world/post-ref.js';
import { ownerLang, setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { WorldFeedCatalog, type HouseFeed } from '../../../src/ingress/world-feed-catalog.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { makeCache, bytesOf, item } from '../../helpers/world-feed-cache.js';

// Same pin as register-tools.test.ts / world-tools.test.ts: the refusal copy
// asserts on zh substrings, so pin the process-wide language.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WEB = 'http://localhost:3000';

/** Two full event ids sharing the same 10-char short prefix (collision case). */
const FULL_A = 'abcdef1234' + 'a'.repeat(54);
const FULL_B = 'abcdef1234' + 'b'.repeat(54);
const SHORT_A = FULL_A.slice(0, 10); // 'abcdef1234'

interface FakeSnapshotItem {
  authorPopclawId?: string | null;
  actorNickname?: string | null;
  platform?: string | null;
  textPreview?: string | null;
  platformPostId?: string | null;
  originalUrl?: string | null;
}

/** The post popclaw_author_latest will serve for 'Elon Musk' (server source). */
const ELON_POPCLAW_POST: FakeSnapshotItem = {
  authorPopclawId: 'id_elon',
  actorNickname: 'Elon Musk',
  platform: 'popclaw',
  textPreview: 'mars update',
  platformPostId: FULL_A,
};

function makeSigner(): MasterKeySigner {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = {
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  };
  return new MasterKeySigner(key);
}

/**
 * The local-cache stub for the tool-level tests — a CLASS whose methods read
 * `this`, on purpose (r15 rework): a detached `findFullEventId` call (the
 * receiver-losing bug the Codex probe caught) must throw here, not silently
 * keep working the way the old arrow-closure stub let it.
 */
class LocalCacheStub {
  constructor(private readonly entries: string[]) {}
  findByEventIdPrefix(): { item: null; ambiguous: string[] } {
    return { item: null, ambiguous: [] };
  }
  findFullEventId(prefix: string): { full: string | null; ambiguous: string[] } {
    // Same semantics as WorldFeedCache/WorldFeedCatalog.findFullEventId.
    const uniq = [...new Set(this.entries.filter((id) => id.startsWith(prefix)))];
    return uniq.length === 1
      ? { full: uniq[0]!, ambiguous: [] as string[] }
      : { full: null, ambiguous: uniq.slice(0, 3) };
  }
}

/**
 * Register the real tool surface with fakes at the same seams the composition
 * root uses: snapshotClient = the lore-house server (author_latest's source),
 * worldFeedCache = the LOCAL stream cache (may be empty), boot.webBaseUrl =
 * the trusted web base the short links are printed with.
 */
function setup(o: {
  /** 64-hex popclaw platformPostIds held in the LOCAL cache (default: none). */
  cacheEntries?: string[];
  /** What the lore-house snapshot serves author_latest. */
  authorItems?: FakeSnapshotItem[];
}) {
  const pushed: Uint8Array[] = [];
  const runtime = vi.fn(async () => ({
    boot: { signer: makeSigner(), nickname: 'TestUser', webBaseUrl: WEB },
    egress: {
      push: async (bytes: Uint8Array) => {
        pushed.push(bytes);
        return { status: 200, eventId: 'deadbeef' + 'f'.repeat(56) };
      },
    },
    worldFeedCache: new LocalCacheStub(o.cacheEntries ?? []),
  })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'];

  const worldDeps = {
    guideClient: { fetchGuideText: async () => null },
    summaryClient: {
      fetchSummary: async () => ({
        window_hours: 24,
        generated_at_ms: 0,
        total_posts: 1,
        distinct_authors: 1,
        authors: { id_elon: { nickname: 'Elon Musk' } },
        hot_posts: [],
      }),
    },
    snapshotClient: {
      fetchSnapshot: async (_q: { limit?: number; author?: string }) =>
        o.authorItems ?? [ELON_POPCLAW_POST],
    },
    resolveClient: { resolve: async () => [] },
    webBaseUrl: WEB,
  };

  const tools: Array<{
    name: string;
    execute: (callId: string, params: unknown) => Promise<{ type: string; text: string }>;
  }> = [];
  const push = (tool: { name?: unknown; execute?: unknown }) => {
    if (typeof tool?.name === 'string' && typeof tool.execute === 'function') {
      tools.push(tool as (typeof tools)[number]);
    }
  };
  // Handles BOTH registration shapes (same as register-tools.test.ts): the
  // draft tools register as factories (they read the session tool context for
  // the current-turn direct preview, 2026-09-06), so a collector that only
  // accepted objects would silently drop them and weaken this suite.
  const api = {
    registerTool: (tool: unknown) => {
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({}) : tool;
      if (Array.isArray(resolved)) resolved.forEach((t) => push(t as { name?: unknown; execute?: unknown }));
      else push(resolved as { name?: unknown; execute?: unknown });
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];

  registerPopclawTools({ api, runtime, getWorldDeps: async () => worldDeps });
  return { tools, pushed };
}

function findTool(
  tools: ReturnType<typeof setup>['tools'],
  name: string,
): (typeof tools)[number] {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

/** A REAL WorldFeedCache whose read layer is broken (a sqlite hiccup) — used by the unverifiable scenarios. */
function brokenDbCache(): WorldFeedCache {
  const brokenDb = {
    execute: () => ({ changes: 0, lastInsertRowid: 0 }),
    queryAll: () => {
      throw new Error('sqlite: disk I/O error');
    },
    queryOne: () => null,
    transaction: (fn: (tx: unknown) => unknown) => fn(brokenDb),
    close: () => {},
  } as unknown as HostDb;
  return new WorldFeedCache({ db: brokenDb });
}

/** Register the real tool surface with an explicit cache object (the r15 real-class scenarios). */
function setupWithCache(cache: WorldFeedCache): { tools: ReturnType<typeof setup>['tools'] } {
  const tools: Array<{
    name: string;
    execute: (callId: string, params: unknown) => Promise<{ type: string; text: string }>;
  }> = [];
  const push = (tool: { name?: unknown; execute?: unknown }) => {
    if (typeof tool?.name === 'string' && typeof tool.execute === 'function') {
      tools.push(tool as (typeof tools)[number]);
    }
  };
  // Factory-aware collector, same reason as setup() above.
  const api = {
    registerTool: (tool: unknown) => {
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({}) : tool;
      if (Array.isArray(resolved)) resolved.forEach((t) => push(t as { name?: unknown; execute?: unknown }));
      else push(resolved as { name?: unknown; execute?: unknown });
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  const runtime = vi.fn(async () => ({
    boot: { signer: makeSigner(), nickname: 'TestUser', webBaseUrl: WEB },
    egress: { push: async () => ({ status: 200, eventId: 'deadbeef' }) },
    worldFeedCache: cache,
  }));
  registerPopclawTools({
    api,
    runtime: runtime as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    // The draft path never needs world deps here; the world tools simply
    // aren't exercised by these scenarios.
    getWorldDeps: undefined,
  });
  return { tools };
}

/** The wire proof: the pushed SignedPayload's envelope prev_event_id (= reply/quote target). */
function pushedPrevEventId(bytes: Uint8Array): string {
  const sp = popclaw.identity.SignedPayload.decode(bytes);
  return popclaw.event.EventEnvelope.decode(sp.payload).prevEventId;
}

/** The full chain the letter's regression list asks for: author_latest reads the author from the server first. */
async function readLatest(tools: ReturnType<typeof setup>['tools']): Promise<string> {
  const r = await findTool(tools, 'popclaw_author_latest').execute('cid', {
    name: 'Elon Musk',
  });
  expect(r.text).toContain(`${WEB}/post/${SHORT_A}`);
  return r.text;
}

beforeEach(() => {
  _draftsForTest.clear();
  _observedPostIdsForTest.clear();
});

// ---------------------------------------------------------------------------
// 1 + 2: author_latest's short link closes the reply chain
// ---------------------------------------------------------------------------

describe('C3: author_latest short link → draft_post reply → send_draft', () => {
  it('bare 10-char short id resolves and the sent envelope carries the full event_id (both sources present)', async () => {
    const { tools, pushed } = setup({ cacheEntries: [FULL_A] });
    await readLatest(tools);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    expect(draft.text).toMatch(/Draft reply post/);
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1]!;

    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token);
    expect(sent.text).toMatch(/已回复/);
    // The receipt's "→ #<target10>" proves the short ref resolved to FULL_A.
    expect(sent.text).toContain(`#${SHORT_A}`);

    // The wire proof: the signed envelope's prev_event_id IS the full 64-hex.
    expect(pushedPrevEventId(pushed[0]!)).toBe(FULL_A);
  });

  it('full URL form resolves too — with the LOCAL cache EMPTY (author_latest read it from the server)', async () => {
    // The letter's emphasized scenario: show_feed is 0 rows; the resolution
    // must still work off what author_latest itself just observed.
    const { tools, pushed } = setup({ cacheEntries: [] });
    await readLatest(tools);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: `${WEB}/post/${SHORT_A}`,
    });
    expect(draft.text).toMatch(/Draft reply post/);
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1]!;

    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token);
    expect(sent.text).toMatch(/已回复/);
    expect(pushedPrevEventId(pushed[0]!)).toBe(FULL_A);
  });

  it('bare short id also works with the LOCAL cache EMPTY (observed mapping alone)', async () => {
    const { tools } = setup({ cacheEntries: [] });
    await readLatest(tools);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1]!;
    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token);
    expect(sent.text).toMatch(/已回复/);
  });

  it('quote_of_event_id accepts the same short forms (same family)', async () => {
    const { tools, pushed } = setup({ cacheEntries: [] });
    await readLatest(tools);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'look at this',
      quote_of_event_id: SHORT_A,
    });
    expect(draft.text).toMatch(/Draft quote post/);
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1]!;

    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token);
    expect(sent.text).toMatch(/已引用/);
    expect(pushedPrevEventId(pushed[0]!)).toBe(FULL_A);
  });

  it('draft preview shows the resolved target in canonical short form', async () => {
    const { tools } = setup({ cacheEntries: [] });
    await readLatest(tools);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    expect(draft.text).toContain(`reply_to: #${SHORT_A}`);
  });
});

// ---------------------------------------------------------------------------
// 1 (binding): unique match only — ambiguity and absence are refused
// ---------------------------------------------------------------------------

describe('C3: unique-or-refuse', () => {
  it('same-prefix collision (observed vs cached) → explicit refusal naming both, no draft_id', async () => {
    // author_latest observed FULL_A; the local cache holds FULL_B — both
    // share the 10-char short id. Neither may be picked.
    const { tools } = setup({ cacheEntries: [FULL_B] });
    await readLatest(tools);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });

    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('撞了');
    // Both colliding short ids are named — the agent can tell the owner.
    expect(draft.text).toContain(`#${FULL_A.slice(0, 10)}`);
    expect(draft.text).toContain(`#${FULL_B.slice(0, 10)}`);
  });

  it('nonexistent short id → explicit refusal, no draft_id, never a guess', async () => {
    const { tools } = setup({ cacheEntries: [] });
    await readLatest(tools); // observed: FULL_A only

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: '1111222233',
    });

    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('受信任来源里查不到');
    expect(draft.text).toContain('1111222233');
  });

  it('malformed reference (not hex, not a URL) → refusal', async () => {
    const { tools } = setup({});
    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: 'not-a-ref!!',
    });
    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('不是有效的帖子引用');
  });

  it('cross-site URL → refusal (only the trusted web base counts)', async () => {
    const { tools } = setup({});
    await readLatest(tools);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: `https://evil.example.com/post/${SHORT_A}`,
    });
    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('只接受本站链接');
    expect(draft.text).toContain(WEB);
  });

  it('shorter than 6 hex chars → refusal as too short', async () => {
    const { tools } = setup({});
    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: 'abc',
    });
    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('至少要 6 位');
  });

  it('longer than 64 hex chars → refusal as too long', async () => {
    const { tools } = setup({});
    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: 'a'.repeat(65),
    });
    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('最多 64 位');
  });

  it('a mirror post on an external platform never poisons the mapping (external ids are not popclaw event ids)', async () => {
    // author_latest serves an x mirror post whose platformPostId happens to
    // look like FULL_A — it must NOT become resolvable as a popclaw event.
    const { tools } = setup({
      cacheEntries: [],
      authorItems: [
        {
          authorPopclawId: 'id_elon',
          actorNickname: 'Elon Musk',
          platform: 'x',
          textPreview: 'mirror',
          platformPostId: FULL_A,
          originalUrl: 'https://x.com/elonmusk/status/1',
        },
      ],
    });
    const latest = await findTool(tools, 'popclaw_author_latest').execute('cid', {
      name: 'Elon Musk',
    });
    // The mirror row renders its source link — no /post/ link is printed for it.
    expect(latest.text).not.toContain('/post/');

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('受信任来源里查不到');
  });
});

// ---------------------------------------------------------------------------
// 3: legacy 64-hex ids keep working unchanged
// ---------------------------------------------------------------------------

describe('C3: legacy full 64-hex ids', () => {
  it('a 64-hex id present in NO trusted source still drafts and sends (passthrough, no source check)', async () => {
    const { tools, pushed } = setup({ cacheEntries: [] });
    const UNSEEN = '9'.repeat(64);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: UNSEEN,
    });
    expect(draft.text).toMatch(/Draft reply post/);
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1]!;

    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token);
    expect(sent.text).toMatch(/已回复/);
    expect(pushedPrevEventId(pushed[0]!)).toBe(UNSEEN);
  });

  it('a trusted-base URL carrying the full 64-hex passes through like the bare form', async () => {
    const { tools, pushed } = setup({ cacheEntries: [] });
    const UNSEEN = '9'.repeat(64);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: `${WEB}/post/${UNSEEN}`,
    });
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1]!;
    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token);
    expect(sent.text).toMatch(/已回复/);
    expect(pushedPrevEventId(pushed[0]!)).toBe(UNSEEN);
  });
});

// ---------------------------------------------------------------------------
// 4: mutual exclusion + confirm gate must not regress
// ---------------------------------------------------------------------------

describe('C3: mutual exclusion and the confirm gate', () => {
  it('both reply and quote supplied (both resolvable) → still refused as mutually exclusive at send, nothing pushed', async () => {
    const { tools, pushed } = setup({ cacheEntries: [] });
    await readLatest(tools);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
      quote_of_event_id: FULL_B,
    });
    // The draft itself still issues (preview informational); the real
    // mutual-exclusion error surfaces at send — pre-existing behavior.
    expect(draft.text).toMatch(/Draft reply post/);
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1]!;

    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token);
    expect(sent.text).toMatch(/只能二选一/);
    expect(pushed).toHaveLength(0);
  });

  it('a refused short ref issues no draft_id, so there is nothing to confirm (gate intact)', async () => {
    const { tools, pushed } = setup({ cacheEntries: [] });
    await readLatest(tools);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: '1111222233',
    });
    expect(draft.text).not.toMatch(/draft_id/);

    // Nothing was parked behind any token — a blind send finds nothing.
    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, 'post-999');
    expect(sent.text).toBe(`${renderCopy(ownerLang(), 'draft.expiredToken', { token: 'post-999' })} (reason: SUBJECT_REFUSED/DRAFT_UNKNOWN_OR_EXPIRED)`);
    expect(pushed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// r15 rework: receiver-bound cache lookup — REAL classes, not arrow stubs.
//
// The Codex probe caught `candidatesFor` destructuring `findFullEventId` off
// its cache and calling it bare: on the real path (WorldFeedCache reads
// `this.opts.db`, WorldFeedCatalog reads `this.feeds`) every call threw, the
// catch swallowed it, and the cache source silently became "no matches" —
// so a mapping-observed A would be called unique while the cache held a
// colliding B it was never really asked about. These regressions use the
// real cache (in-memory SQLite), the real catalog, and a real cache over a
// broken db — no arrow-closure stand-ins.
// ---------------------------------------------------------------------------

describe('C3 r15: receiver-bound cache lookup (real WorldFeedCache / WorldFeedCatalog)', () => {
  /** Write one popclaw-native row into a real cache (the SSE write path). */
  const recPopclaw = (cache: WorldFeedCache, id: string) => {
    const it = item({ platform: 'popclaw', platformPostId: id, originalUrl: '' });
    cache.record(it, bytesOf(it), 1);
  };

  /** A real single-house catalog over a real cache (same shape as world-feed-catalog.test.ts). */
  const house = async (
    slug: string,
  ): Promise<HouseFeed & { cache: WorldFeedCache }> => {
    const { cache } = await makeCache();
    return {
      slug,
      baseUrl: `https://${slug}`,
      cache,
      dbPath: ':memory:',
      snapshot: { fetchSnapshot: async () => [] },
    };
  };

  it('① real catalog cache alone resolves the short id', async () => {
    const h = await house('popclaw-me');
    recPopclaw(h.cache, FULL_B);
    const r = resolvePostRef(SHORT_A, { webBaseUrl: WEB, cache: new WorldFeedCatalog([h]) });
    expect(r).toEqual({ ok: true, eventId: FULL_B });
  });

  it('② observed A + cached B share the prefix → refusal naming the collision (the probe scenario)', async () => {
    const h = await house('popclaw-me');
    recPopclaw(h.cache, FULL_B);
    rememberObservedPostIds([{ platform: 'popclaw', platformPostId: FULL_A }]);
    const r = resolvePostRef(SHORT_A, { webBaseUrl: WEB, cache: new WorldFeedCatalog([h]) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.text).toContain('撞了');
      expect(r.text).toContain('2'); // BOTH candidates are counted — the cache leg really ran
      expect(r.text).toContain('abcdef1234');
    }
  });

  it('③ both houses and the observed mapping hold the same A → deduped, resolves', async () => {
    const h1 = await house('popclaw-me');
    const h2 = await house('popclaw-world');
    recPopclaw(h1.cache, FULL_A);
    recPopclaw(h2.cache, FULL_A); // same event relayed by two houses
    rememberObservedPostIds([{ platform: 'popclaw', platformPostId: FULL_A }]);
    const r = resolvePostRef(SHORT_A, { webBaseUrl: WEB, cache: new WorldFeedCatalog([h1, h2]) });
    expect(r).toEqual({ ok: true, eventId: FULL_A });
  });

  it('④ real cache over a broken db → UNVERIFIABLE refusal, never absent, never a mapping-only "unique"', async () => {
    // A real WorldFeedCache whose read layer is broken (a sqlite hiccup). The
    // class itself must propagate the throw; resolution must treat it as
    // "cannot verify", not as "no matches".
    const cache = brokenDbCache();
    rememberObservedPostIds([{ platform: 'popclaw', platformPostId: FULL_A }]);
    const r = resolvePostRef(SHORT_A, { webBaseUrl: WEB, cache });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.text).toContain('没法核验');
      expect(r.text).not.toContain('查不到'); // not the absent copy
    }
  });

  it('④-b tool level: a cache hiccup at draft time refuses without a draft_id (no unverifiable send)', async () => {
    // Same broken-db cache, but through the real draft_post handler: the
    // refusal must come at draft time with no draft_id — the owner is never
    // asked to confirm a reply whose uniqueness could not be verified.
    const { tools } = setupWithCache(brokenDbCache());
    rememberObservedPostIds([{ platform: 'popclaw', platformPostId: FULL_A }]);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('没法核验');
  });
});

// ---------------------------------------------------------------------------
// r17 rework: runtime failure is UNVERIFIABLE, not "no cache host".
//
// The Codex probe caught write-tools' resolveRef catching a runtime() throw
// and falling back to `refSources = {}` — which resolvePostRef reads as
// "unwired" (a host with no cache, the lenient case). A runtime failure is
// "the cache CANNOT be checked right now": the local cache may hold a
// colliding id that is invisible exactly like r15's unreadable case, so a
// short id must NOT be signed off the observed mapping alone. All three
// scenarios go through the REAL registerWriteTools registration.
// ---------------------------------------------------------------------------

describe('C3 r17: runtime failure is unverifiable (tool-initialization layer)', () => {
  /** Real write-tools registration with a fully controlled runtime. */
  const setupWriteTools = (runtime: unknown): { tools: ReturnType<typeof setup>['tools'] } => {
    const tools: Array<{
      name: string;
      execute: (callId: string, params: unknown) => Promise<{ type: string; text: string }>;
    }> = [];
    const push = (tool: { name?: unknown; execute?: unknown }) => {
      if (typeof tool?.name === 'string' && typeof tool.execute === 'function') {
        tools.push(tool as (typeof tools)[number]);
      }
    };
    // Factory-aware collector, same reason as setup() above.
    const api = {
      registerTool: (tool: unknown) => {
        const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({}) : tool;
        if (Array.isArray(resolved)) resolved.forEach((t) => push(t as { name?: unknown; execute?: unknown }));
        else push(resolved as { name?: unknown; execute?: unknown });
      },
    } as Parameters<typeof registerPopclawTools>[0]['api'];
    registerWriteTools({
      api,
      runtime: runtime as Parameters<typeof registerWriteTools>[0]['runtime'],
      deps: {} as Parameters<typeof registerWriteTools>[0]['deps'],
      total: 4,
    });
    return { tools };
  };

  /** A healthy runtime: real boot fields + a working cache. */
  const healthyRuntime = (cache: unknown) =>
    vi.fn(async () => ({
      boot: { signer: makeSigner(), nickname: 'TestUser', webBaseUrl: WEB },
      egress: { push: async () => ({ status: 200, eventId: 'deadbeef' }) },
      worldFeedCache: cache,
    }));

  it('① runtime throws + observed mapping → unverifiable refusal, no draft_id (never a mapping-only signature)', async () => {
    rememberObservedPostIds([{ platform: 'popclaw', platformPostId: FULL_A }]);
    const { tools } = setupWriteTools(
      vi.fn(async () => {
        throw new Error('runtime not up');
      }),
    );

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('没法核验'); // the unverifiable copy, not the absent one
    expect(draft.text).not.toContain('查不到');
  });

  it('② same registration, runtime RECOVERS on the next draft → resolves on real evidence; a colliding cache refuses — failure does not stick', async () => {
    rememberObservedPostIds([{ platform: 'popclaw', platformPostId: FULL_A }]);
    // One mutable runtime, ONE registration: down → up-with-A → up-with-B.
    let nowHolding: 'down' | 'A' | 'B' = 'down';
    const runtime = vi.fn(async () => {
      if (nowHolding === 'down') throw new Error('runtime not up');
      return {
        boot: { signer: makeSigner(), nickname: 'TestUser', webBaseUrl: WEB },
        egress: { push: async () => ({ status: 200, eventId: 'deadbeef' }) },
        worldFeedCache: new LocalCacheStub(nowHolding === 'A' ? [FULL_A] : [FULL_B]),
      };
    });
    const { tools } = setupWriteTools(runtime);

    // down → refused, no draft_id
    const down = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    expect(down.text).not.toMatch(/draft_id/);

    // recovered, cache holds the SAME A → resolves (dedupe), draft + send chain
    nowHolding = 'A';
    const ok = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    const token = ok.text.match(/draft_id: (post-[0-9]+)/)![1]!;
    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token);
    expect(sent.text).toMatch(/已回复/);

    // recovered, cache holds a COLLIDING B → explicit ambiguity refusal
    nowHolding = 'B';
    const collide = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    expect(collide.text).not.toMatch(/draft_id/);
    expect(collide.text).toContain('撞了');
    expect(collide.text).toContain('2');
  });

  it('③ runtime up but the cache has no findFullEventId (unwired) → observed mapping alone still resolves (lenient case unchanged)', async () => {
    rememberObservedPostIds([{ platform: 'popclaw', platformPostId: FULL_A }]);
    const { tools } = setupWriteTools(
      healthyRuntime({ findByEventIdPrefix: () => ({ item: null, ambiguous: [] }) }),
    );

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: SHORT_A,
    });
    expect(draft.text).toMatch(/Draft reply post/);
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1]!;
    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token);
    expect(sent.text).toMatch(/已回复/);
  });

  it('③-b runtime throws but the ref is a full 64-hex → legacy path unaffected (drafts, sends)', async () => {
    const { tools } = setupWriteTools(
      vi.fn(async () => {
        throw new Error('runtime not up');
      }),
    );
    const UNSEEN = '9'.repeat(64);

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', {
      body: 'ack',
      reply_to_event_id: UNSEEN,
    });
    expect(draft.text).toMatch(/Draft reply post/);
  });
});
