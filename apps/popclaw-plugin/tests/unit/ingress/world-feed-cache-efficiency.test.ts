import { afterEach, describe, expect, it } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { item, bytesOf } from '../../helpers/world-feed-cache.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const db = new InMemoryHostDb(); cleanup.push(() => db.close());
  const cache = new WorldFeedCache({ db }); await cache.start();
  const changes = () => db.queryOne<{ count: number }>('SELECT total_changes() AS count')!.count;
  return { db, cache, changes };
}

describe('WorldFeedCache repeated observations', () => {
  it('does not write when all persisted bytes, projections and observation time are unchanged', async () => {
    const f = await fixture(), original = item({ eventId: 'e'.repeat(64), platformPostId: 'stable' });
    f.cache.record(original, undefined, 100);
    const before = f.changes();
    f.cache.record(original, bytesOf(original), 100);
    expect(f.changes() - before).toBe(0);
    expect(f.cache.recent(10)).toHaveLength(1);
  });

  it('refreshes received_at on a later observation without losing retention freshness', async () => {
    const f = await fixture(), original = item({ platformPostId: 'observed-again' });
    f.cache.record(original, undefined, 100);
    const before = f.changes(); f.cache.record(original, undefined, 200);
    expect(f.changes() - before).toBe(1);
    expect(f.db.queryOne('SELECT received_at FROM world_feed')).toEqual({ received_at: 200 });
  });

  it.each([
    { handle: 'new-handle' }, { textPreview: 'new-preview' }, { actorNickname: 'new-nickname' },
    { actorVerified: [{ platform: 'x', handle: 'verified', followerCount: 20 }] },
    { replyCount: 3 }, { markCount: 4 }, { platformPostCreatedAt: 42 },
    { origin: { platform: 'x', postId: 'source', url: 'https://example.test/source', createdAt: 41 } },
    { replyToPlatform: 'popclaw', replyToPostId: 'reply-parent', replyToAuthorPopclawId: 'parent-author' },
    { quotedEventId: 'b'.repeat(64) }, { authorPopclawId: 'new-author' }, { eventId: 'c'.repeat(64) },
  ] satisfies Array<Partial<popclaw.event.IWorldFeedItem>>)('updates changed metadata with the same envelope: %j', async metadata => {
    const f = await fixture(), original = item({ platformPostId: 'metadata' });
    f.cache.record(original, undefined, 100);
    const updated = { ...original, ...metadata }, before = f.changes();
    f.cache.record(updated, undefined, 100);
    expect(f.changes() - before).toBe(1);
    expect(Buffer.from(f.db.queryOne<{ raw: Uint8Array }>('SELECT raw FROM world_feed')!.raw)).toEqual(Buffer.from(bytesOf(updated)));
  });

  it('repairs a stale SQL projection even when retained bytes match', async () => {
    const f = await fixture(), original = item({ platformPostId: 'repair', textPreview: 'retained preview' });
    f.cache.record(original, undefined, 100);
    f.db.execute("UPDATE world_feed SET text_preview='stale projection'");
    const before = f.changes(); f.cache.record(original, undefined, 100);
    expect(f.changes() - before).toBe(1);
    expect(f.cache.recent(1)[0]?.textPreview).toBe('retained preview');
  });

  it('compares the retained carrier rather than an unrelated caller projection', async () => {
    const f = await fixture(), original = item({ platformPostId: 'raw-authority' });
    const raw = bytesOf(original); f.cache.record(original, raw, 100);
    const before = f.changes(); f.cache.record({ ...original, textPreview: 'ignored caller projection' }, raw, 100);
    expect(f.changes() - before).toBe(0);
    expect(f.cache.recent(1)[0]?.textPreview).toBe(original.textPreview);
  });
});
