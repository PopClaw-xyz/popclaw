import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runPopclawMarkCommand,
  runPopclawUnmarkCommand,
  runPopclawMarksCommand,
  resolveMarkTarget,
} from '../../../src/commands/popclaw-mark.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { MarksStore } from '../../../src/marks/marks-store.js';
import type { CachedFeedItem } from '../../../src/ingress/world-feed-cache.js';
import type { MarkResult } from '../../../src/marks/mark-service.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
// MarkResult is imported from mark-service; the command uses a structural interface (MarkServiceLike)

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const VALID_EVENT_ID = 'abcdef' + '0'.repeat(58);

function freshStore(): MarksStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return new MarksStore(db);
}

// ── Fake cache ──────────────────────────────────────────────────────────────

class FakeCache {
  private byKey = new Map<string, CachedFeedItem>();
  private byEventId = new Map<string, CachedFeedItem>();

  add(item: CachedFeedItem): void {
    this.byKey.set(`${item.platform}|${item.platformPostId}`, item);
    if (item.eventId) this.byEventId.set(item.eventId, item);
  }

  lookup(platform: string, postId: string): CachedFeedItem | null {
    return this.byKey.get(`${platform}|${postId}`) ?? null;
  }

  findByEventIdPrefix(prefix: string): { item: CachedFeedItem | null; ambiguous: string[] } {
    const matches: CachedFeedItem[] = [];
    for (const [eid, item] of this.byEventId) {
      if (eid.startsWith(prefix)) {
        matches.push(item);
        if (matches.length > 3) break;
      }
    }
    if (matches.length === 1) return { item: matches[0]!, ambiguous: [] };
    return { item: null, ambiguous: matches.slice(0, 3).map((m) => m.eventId) };
  }
}

function makeItem(over: Partial<CachedFeedItem> = {}): CachedFeedItem {
  return {
    platform: 'x',
    platformPostId: '1234567890',
    eventId: VALID_EVENT_ID,
    platformPostCreatedAt: 1_700_000_000,
    authorPopclawId: 'AUTH12345678',
    handle: 'testhandle',
    originalUrl: 'https://x.com/testhandle/status/1234567890',
    textPreview: 'hello world',
    ...over,
  };
}

// ── Fake MarkService ─────────────────────────────────────────────────────────

interface FakeMarkServiceOpts {
  markResult?: Partial<MarkResult>;
  unmarkResult?: Partial<MarkResult & { wasMarked: boolean }>;
}

class FakeMarkService {
  markedItems: CachedFeedItem[] = [];
  unmarkedIds: string[] = [];

  constructor(private readonly opts: FakeMarkServiceOpts = {}) {}

  async mark(item: CachedFeedItem): Promise<MarkResult> {
    this.markedItems.push(item);
    return { pushed: true, ...this.opts.markResult };
  }

  async unmark(eventId: string): Promise<MarkResult & { wasMarked: boolean }> {
    this.unmarkedIds.push(eventId);
    return { pushed: true, wasMarked: true, ...this.opts.unmarkResult };
  }
}

// ── resolveMarkTarget ────────────────────────────────────────────────────────

describe('resolveMarkTarget', () => {
  it('hex prefix unique hit → returns item', () => {
    const cache = new FakeCache();
    cache.add(makeItem({ eventId: VALID_EVENT_ID }));
    const r = resolveMarkTarget('abcdef', cache);
    expect('item' in r).toBe(true);
    expect((r as { item: CachedFeedItem }).item.eventId).toBe(VALID_EVENT_ID);
  });

  it('hex prefix ambiguous → lists first 3 event_id prefixes', () => {
    const cache = new FakeCache();
    cache.add(makeItem({ platformPostId: 'p1', eventId: 'abc123aaa' + '0'.repeat(55) }));
    cache.add(makeItem({ platformPostId: 'p2', eventId: 'abc123bbb' + '0'.repeat(55) }));
    cache.add(makeItem({ platformPostId: 'p3', eventId: 'abc123ccc' + '0'.repeat(55) }));

    const r = resolveMarkTarget('abc123', cache);
    expect('error' in r).toBe(true);
    const err = (r as { error: string }).error;
    expect(err).toContain('ambiguous prefix');
    // Should list all 3 matches (first 10 chars each)
    expect(err).toContain('abc123aaa0');
    expect(err).toContain('abc123bbb0');
    expect(err).toContain('abc123ccc0');
  });

  it('platform:postId format → resolves via lookup', () => {
    const cache = new FakeCache();
    cache.add(makeItem({ platform: 'youtube', platformPostId: 'vidabc', eventId: VALID_EVENT_ID }));
    const r = resolveMarkTarget('youtube:vidabc', cache);
    expect('item' in r).toBe(true);
  });

  it('cache miss → shows tip message', () => {
    const cache = new FakeCache();
    const r = resolveMarkTarget('nonexistent', cache);
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('tip:');
    expect((r as { error: string }).error).toContain('/popclaw feed');
  });

  it('eventId empty → shows refresh feed message', () => {
    const cache = new FakeCache();
    cache.add(makeItem({ eventId: '' }));
    const r = resolveMarkTarget('x:1234567890', cache);
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('event_id is missing');
    expect((r as { error: string }).error).toContain('/popclaw feed');
  });

  it('all-digit id not a known eventId prefix but is a cached x post → resolves via fallback', () => {
    // A 19-digit X post ID — passes HEX_PREFIX (/^[0-9a-f]{6,64}$/) but has no matching event_id.
    // It should fall through and resolve via cache.lookup('x', id).
    const xPostId = '1234567890123456789';
    const cache = new FakeCache();
    // Add with a totally different event_id so the prefix search misses (zero ambiguous matches)
    cache.add(makeItem({ platformPostId: xPostId, eventId: VALID_EVENT_ID }));
    // The prefix 'abcdef...' won't match xPostId as event_id prefix, so findByEventIdPrefix misses.
    // But we search for xPostId itself — cache.lookup('x', xPostId) should succeed.
    const r = resolveMarkTarget(xPostId, cache);
    expect('item' in r).toBe(true);
    expect((r as { item: CachedFeedItem }).item.platformPostId).toBe(xPostId);
  });
});

// ── runPopclawMarkCommand ────────────────────────────────────────────────────

describe('runPopclawMarkCommand', () => {
  it('no arg → usage', async () => {
    const cache = new FakeCache();
    const markService = new FakeMarkService();
    const r = await runPopclawMarkCommand({ positional: [] }, { cache, markService });
    expect(r.text).toContain('usage:');
  });

  it('hex prefix unique hit → success message', async () => {
    const cache = new FakeCache();
    cache.add(makeItem({ eventId: VALID_EVENT_ID }));
    const markService = new FakeMarkService();
    const r = await runPopclawMarkCommand({ positional: ['abcdef'] }, { cache, markService });
    expect(r.text).toContain('✓ marked @testhandle');
    expect(r.text).toContain('the lore-house got a +1 signed by you');
    expect(markService.markedItems).toHaveLength(1);
  });

  it('push fail → shows rerun message', async () => {
    const cache = new FakeCache();
    cache.add(makeItem({ eventId: VALID_EVENT_ID }));
    const markService = new FakeMarkService({ markResult: { pushed: false, error: 'connection refused' } });
    const r = await runPopclawMarkCommand({ positional: ['abcdef'] }, { cache, markService });
    expect(r.text).toContain('◐ marked');
    expect(r.text).toContain('lore-house push failed');
    expect(r.text).toContain('connection refused');
    expect(r.text).toContain('rerun');
  });

  it('no handle falls back to the sigil, never a bare popclaw_id prefix', async () => {
    const cache = new FakeCache();
    cache.add(makeItem({ handle: '', authorPopclawId: 'AUTHOR01234567', eventId: VALID_EVENT_ID }));
    const markService = new FakeMarkService();
    const r = await runPopclawMarkCommand({ positional: ['abcdef'] }, { cache, markService });
    expect(r.text).toContain(`#${deriveSigil('AUTHOR01234567')}`);
    expect(r.text).not.toContain('AUTHOR01');
  });
});

// ── runPopclawUnmarkCommand ──────────────────────────────────────────────────

describe('runPopclawUnmarkCommand', () => {
  it('no arg → usage', async () => {
    const store = freshStore();
    const cache = new FakeCache();
    const markService = new FakeMarkService();
    const r = await runPopclawUnmarkCommand({ positional: [] }, { cache, markService, store });
    expect(r.text).toContain('usage:');
  });

  it('local prefix resolve → uses stored eventId', async () => {
    const store = freshStore();
    store.upsert({
      eventId: VALID_EVENT_ID, platform: 'x', platformPostId: '1234567890',
      authorPopclawId: '', handle: 'tuser', summaryLine: 'test', bodySnapshot: '',
      sourceUrl: '', markedAt: 1000,
    });
    const cache = new FakeCache();
    const markService = new FakeMarkService();
    const r = await runPopclawUnmarkCommand({ positional: ['abcdef'] }, { cache, markService, store });
    expect(r.text).toContain('✓ unmarked');
    expect(markService.unmarkedIds[0]).toBe(VALID_EVENT_ID);
  });

  it('local prefix ambiguous → reports ambiguity', async () => {
    const store = freshStore();
    store.upsert({
      eventId: 'abcdef1111' + '0'.repeat(54), platform: 'x', platformPostId: 'p1',
      authorPopclawId: '', handle: 'u1', summaryLine: '', bodySnapshot: '',
      sourceUrl: '', markedAt: 1,
    });
    store.upsert({
      eventId: 'abcdef2222' + '0'.repeat(54), platform: 'x', platformPostId: 'p2',
      authorPopclawId: '', handle: 'u2', summaryLine: '', bodySnapshot: '',
      sourceUrl: '', markedAt: 2,
    });
    const cache = new FakeCache();
    const markService = new FakeMarkService();
    const r = await runPopclawUnmarkCommand({ positional: ['abcdef'] }, { cache, markService, store });
    expect(r.text).toContain('ambiguous prefix');
    expect(markService.unmarkedIds).toHaveLength(0);
  });

  it('wasMarked:false → shows idempotent message', async () => {
    const store = freshStore();
    const cache = new FakeCache();
    cache.add(makeItem({ eventId: VALID_EVENT_ID }));
    const markService = new FakeMarkService({ unmarkResult: { wasMarked: false, pushed: true } });
    const r = await runPopclawUnmarkCommand({ positional: ['abcdef'] }, { cache, markService, store });
    expect(r.text).toContain('was not marked locally');
    expect(r.text).toContain('idempotent');
  });

  it('push fail suffix added', async () => {
    const store = freshStore();
    const cache = new FakeCache();
    cache.add(makeItem({ eventId: VALID_EVENT_ID }));
    const markService = new FakeMarkService({ unmarkResult: { wasMarked: true, pushed: false, error: 'timeout' } });
    const r = await runPopclawUnmarkCommand({ positional: ['abcdef'] }, { cache, markService, store });
    expect(r.text).toContain('lore-house push failed');
    expect(r.text).toContain('rerun');
  });

  it('3-char arg skips local prefix scan, falls through to resolveMarkTarget', async () => {
    // A short arg (<6 chars) does NOT pass HEX_PREFIX, so local prefix scan is bypassed.
    // The fallback resolveMarkTarget path is taken instead.
    const store = freshStore();
    // Pre-populate store with an event that starts with "abc" to prove it's NOT matched locally
    store.upsert({
      eventId: 'abcdef1111' + '0'.repeat(54), platform: 'x', platformPostId: 'p99',
      authorPopclawId: '', handle: 'localuser', summaryLine: 'local only', bodySnapshot: '',
      sourceUrl: '', markedAt: 1,
    });
    const cache = new FakeCache();
    // Cache has a platform:postId entry for 'abc' as a raw x postId
    cache.add(makeItem({ platformPostId: 'abc', eventId: VALID_EVENT_ID }));
    const markService = new FakeMarkService();
    const r = await runPopclawUnmarkCommand({ positional: ['abc'] }, { cache, markService, store });
    // Should not report ambiguity from local store (which has 1 entry starting with 'abc')
    // Should resolve via cache fallback and succeed
    expect(r.text).not.toContain('ambiguous prefix');
    expect(markService.unmarkedIds).toHaveLength(1);
    expect(markService.unmarkedIds[0]).toBe(VALID_EVENT_ID);
  });
});

// ── runPopclawMarksCommand ───────────────────────────────────────────────────

describe('runPopclawMarksCommand', () => {
  it('empty list → empty message', async () => {
    const store = freshStore();
    const r = await runPopclawMarksCommand({ flags: {} }, { store });
    expect(r.text).toContain('no marks yet');
    expect(r.text).toContain('/popclaw mark');
  });

  it('sorted output — newest first, with handle + summaryLine + sourceUrl', async () => {
    const store = freshStore();
    store.upsert({
      eventId: 'a'.repeat(64), platform: 'x', platformPostId: 'p1',
      authorPopclawId: '', handle: 'alice', summaryLine: 'first post',
      bodySnapshot: '', sourceUrl: 'https://x.com/alice/1', markedAt: 100,
    });
    store.upsert({
      eventId: 'b'.repeat(64), platform: 'x', platformPostId: 'p2',
      authorPopclawId: '', handle: 'bob', summaryLine: 'second post',
      bodySnapshot: '', sourceUrl: 'https://x.com/bob/2', markedAt: 200,
    });

    const r = await runPopclawMarksCommand({ flags: {} }, { store });
    expect(r.text).toContain('marks (2):');
    const lines = r.text.split('\n');
    // Line 0 is header; first item line (index 1) should be bob (markedAt=200, newest)
    expect(lines[1]).toContain('@bob');
    expect(lines[1]).toContain('second post');
    expect(lines[1]).toContain('https://x.com/bob/2');
    expect(lines[2]).toContain('@alice');
  });

  // A mirrored post's `@handle` versus the owner's alias: the owner wins (single name chain).
  it('备注名盖过镜像帖的 @handle', async () => {
    const store = freshStore();
    store.upsert({
      eventId: 'd'.repeat(64), platform: 'x', platformPostId: 'p4',
      authorPopclawId: 'POPID12345678', handle: 'elonmusk', summaryLine: 'a post',
      bodySnapshot: '', sourceUrl: '', markedAt: 1,
    });
    const nameOf = (): string => '老王';
    const plain = await runPopclawMarksCommand({ flags: {} }, { store });
    expect(plain.text).toContain('@elonmusk');
    const r = await runPopclawMarksCommand({ flags: {} }, { store, nameOf });
    expect(r.text).toContain(`老王#${deriveSigil('POPID12345678')}`);
    expect(r.text).not.toContain('@elonmusk');
  });

  // An empty bond book resolves to the handle itself; retain `@handle` for the most informative display.
  it('没有备注名/自报名号时保留 @handle', async () => {
    const store = freshStore();
    store.upsert({
      eventId: 'e'.repeat(64), platform: 'x', platformPostId: 'p5',
      authorPopclawId: 'POPID12345678', handle: 'elonmusk', summaryLine: 'a post',
      bodySnapshot: '', sourceUrl: '', markedAt: 1,
    });
    const nameOf = (_id: string, serverName?: string): string => serverName ?? '';
    const r = await runPopclawMarksCommand({ flags: {} }, { store, nameOf });
    expect(r.text).toContain('@elonmusk');
  });

  it('no handle → falls back to the sigil, never a bare popclaw_id prefix', async () => {
    const store = freshStore();
    store.upsert({
      eventId: 'c'.repeat(64), platform: 'x', platformPostId: 'p3',
      authorPopclawId: 'POPID12345678', handle: '', summaryLine: 'anon post',
      bodySnapshot: '', sourceUrl: '', markedAt: 1,
    });
    const r = await runPopclawMarksCommand({ flags: {} }, { store });
    expect(r.text).toContain(`#${deriveSigil('POPID12345678')}`);
    expect(r.text).not.toContain('POPID123');
    // No sourceUrl so no trailing URL
    expect(r.text).not.toContain('https://');
  });

  it('--limit N caps output', async () => {
    const store = freshStore();
    for (let i = 0; i < 5; i++) {
      store.upsert({
        eventId: String(i).repeat(64).slice(0, 64), platform: 'x', platformPostId: `p${i}`,
        authorPopclawId: '', handle: `user${i}`, summaryLine: `post ${i}`,
        bodySnapshot: '', sourceUrl: '', markedAt: i,
      });
    }
    const r = await runPopclawMarksCommand({ flags: { limit: '2' } }, { store });
    // Output has header line "marks (2):" + 2 item lines
    const lines = r.text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('marks (2):');
  });

  it('invalid --limit falls back to 20', async () => {
    const store = freshStore();
    // Just checks it doesn't crash and returns (empty) results with default limit
    const r = await runPopclawMarksCommand({ flags: { limit: 'abc' } }, { store });
    expect(r.text).toContain('no marks yet');
  });

  it('negative --limit falls back to 20', async () => {
    const store = freshStore();
    const r = await runPopclawMarksCommand({ flags: { limit: '-5' } }, { store });
    expect(r.text).toContain('no marks yet');
  });
});
