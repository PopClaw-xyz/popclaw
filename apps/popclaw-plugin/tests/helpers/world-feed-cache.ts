import { popclaw } from '@popclaw/contracts';
import { signedFixtureEnvelope } from './signed-envelope';

const originalEnvelope = popclaw.event.EventEnvelope.encode(signedFixtureEnvelope('')).finish();
import { LocalHostDb } from '../../src/host/local-host-db';
import { WorldFeedCache } from '../../src/ingress/world-feed-cache';
import type { HostDb } from '../../src/host/host-db';

/** In-memory SQLite-backed cache for tests. */
export async function makeCache(): Promise<{ cache: WorldFeedCache; db: HostDb }> {
  const db = new LocalHostDb(':memory:');
  const cache = new WorldFeedCache({ db });
  await cache.start();
  return { cache, db };
}

/** Encode an item to the on-wire bytes the SSE path would deliver. */
export function bytesOf(item: popclaw.event.IWorldFeedItem): Uint8Array {
  return popclaw.event.WorldFeedItem.encode(item).finish() as Uint8Array;
}

export function item(
  over: Partial<popclaw.event.IWorldFeedItem> = {},
): popclaw.event.IWorldFeedItem {
  return {
    envelope: originalEnvelope,
    platform: 'x',
    platformPostId: 'pid-default',
    platformPostCreatedAt: 1_700_000_000,
    authorPopclawId: 'authorA',
    handle: 'h',
    originalUrl: 'https://x.com/h/status/pid-default',
    textPreview: 'hello world',
    ...over,
  } as popclaw.event.IWorldFeedItem;
}
