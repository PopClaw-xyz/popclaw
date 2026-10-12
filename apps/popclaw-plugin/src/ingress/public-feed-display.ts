/** Local public display only: no receiver, cache writer or business consumer. */
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import type { VerifiedPublicStreamCapability } from '../world/world-capabilities.js';
import { type VerifiedPublicProducerPolicy } from '../world/scoped-stream-journal.js';
import { readPublicJournal, readPublicJournalSnapshot } from './public-journal-reader.js';
import { numberOrZero } from './feed-item-projection.js';
import type { WorldFeedQuery } from './world-feed-client.js';

export interface PublicDisplayCapture {
  readonly executionDb: HostDb;
  readonly capability: VerifiedPublicStreamCapability;
  readonly producerPolicy: VerifiedPublicProducerPolicy;
  readonly history: boolean;
  assertCurrent(): void;
}
export interface PublicDisplaySource {
  readonly protocol?: 'ordinary-snapshot' | 'public-v1';
  readonly origin: string;
  readonly slug: string;
  readonly capabilityRevision: string;
  readonly logIncarnation: string;
  readonly history: boolean;
  readonly incomplete: boolean;
  readonly unavailable: boolean;
  readonly truncated: boolean;
  readonly observedAt: number | null;
  /** Remote coverage cutoff read with the items; null means no checkpoint yet. */
  readonly checkpointHighWater?: string | null;
  readonly code?: string;
}
export interface PublicDisplayItem {
  readonly item: popclaw.event.IWorldFeedItem;
  readonly body: string;
  readonly kind: string;
  readonly media?: readonly { kind: string; url: string }[];
  readonly bodyUnavailable?: boolean;
  readonly relaySnapshot: boolean;
  readonly mirrorSigner: boolean;
  readonly source: { readonly origin: string; readonly slug: string; readonly observedAt: number; readonly sequence: string; readonly logIncarnation: string; readonly frameDigest?: string };
  readonly alsoInHouses?: readonly string[];
}
export interface PublicDisplayResult {
  readonly items: readonly PublicDisplayItem[];
  readonly sources: readonly PublicDisplaySource[];
  readonly truncated: boolean;
}
export interface PublicDisplayQuery extends WorldFeedQuery {
  readonly includeThreads?: boolean;
  /** Internal full candidate acquisition. A later read cannot enlarge a prepared window. */
  readonly completeWindow?: boolean;
  readonly ownProjection?: boolean;
}
export interface PreparedPublicSource {
  readonly origin: string;
  readonly slug: string;
  readonly status: PublicDisplaySource;
  readonly items: readonly PublicDisplayItem[];
  assertCurrent(): void;
}
export interface PublicFeedDisplayOptions {
  sources(): readonly { origin: string; slug: string; capture(): PublicDisplayCapture }[];
}
function time(value: unknown): number { const n = numberOrZero(value); return Number.isSafeInteger(n) && n >= 0 && n <= 253402300799 ? n : 0; }
function unavailable(source: { origin: string; slug: string }, capture: PublicDisplayCapture | undefined, error: unknown): PublicDisplaySource {
  return { origin: source.origin, slug: source.slug, capabilityRevision: capture?.capability.capabilityRevision ?? '',
    logIncarnation: capture?.capability.publicStream.log_incarnation ?? '', history: capture?.history ?? true,
    incomplete: true, unavailable: true, truncated: false, observedAt: null, checkpointHighWater: null,
    code: error instanceof Error ? error.message : 'PUBLIC_DISPLAY_UNAVAILABLE' };
}

/** Preserve protobuf int64 values and absent fields while giving each caller owned bytes. */
export function clonePublicDisplayItem(hit: PublicDisplayItem): PublicDisplayItem {
  const { item, ...fields } = hit;
  const cloned: popclaw.event.IWorldFeedItem = popclaw.event.WorldFeedItem.toObject(
    popclaw.event.WorldFeedItem.decode(popclaw.event.WorldFeedItem.encode(item).finish()));
  if (cloned.envelope) cloned.envelope = new Uint8Array(cloned.envelope);
  return { ...structuredClone(fields), item: cloned };
}

/** A publication owns its rows. Authority is checked again on every use. */
function publishSource(source: PreparedPublicSource): PreparedPublicSource {
  let status = { ...source.status }, items = source.items;
  try { source.assertCurrent(); }
  catch (error) {
    items = []; status = { ...status, unavailable: true, incomplete: true,
      code: error instanceof Error ? error.message : 'PUBLIC_DISPLAY_UNAVAILABLE' };
  }
  return { ...source, status, items: items.map(clonePublicDisplayItem) };
}
function querySources(sources: readonly PreparedPublicSource[], query: PublicDisplayQuery, completeWindow: boolean, search = ''): PublicDisplayResult {
  const limit = completeWindow && query.completeWindow ? Infinity
    : Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 100) : 20;
  const merged = new Map<string, PublicDisplayItem>();
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  for (const source of sources) {
    for (const hit of source.items) {
      const item = hit.item;
      if (query.includeThreads === false && item.replyToPostId && !item.quotedEventId) continue;
      if (query.author && item.authorPopclawId !== query.author) continue;
      if (query.platform && item.platform !== query.platform) continue;
      const text = [hit.kind, hit.body, item.textPreview, item.handle, item.actorNickname, item.originalUrl, item.origin?.url].join(' ').toLocaleLowerCase();
      if (terms.some(term => !text.includes(term))) continue;
      const id = item.eventId!, first = merged.get(id);
      if (first) merged.set(id, { ...first, alsoInHouses: [...(first.alsoInHouses ?? []), source.slug] });
      else merged.set(id, hit);
    }
  }
  const items = [...merged.values()].sort((a, b) => time(b.item.platformPostCreatedAt) - time(a.item.platformPostCreatedAt)
    || String(a.item.platformPostId).localeCompare(String(b.item.platformPostId)));
  return { items: items.slice(0, limit), sources: sources.map(source => source.status),
    truncated: items.length > limit || sources.some(source => source.status.truncated) };
}

/** The sources callback follows later mounts without opening a House or using HTTP. */
export class PublicFeedDisplay {
  constructor(private readonly options: PublicFeedDisplayOptions) {}
  /** Only a prepared display exposes an invocation's fixed source evidence. */
  get publicSources(): readonly PreparedPublicSource[] { return []; }
  async prepare(query: PublicDisplayQuery = {}): Promise<PublicFeedDisplay> {
    return new PreparedPublicFeedDisplay(this.captureSources(query), query.completeWindow === true);
  }
  read(query: PublicDisplayQuery = {}): PublicDisplayResult {
    return querySources(this.captureSources(query).map(publishSource), query, query.completeWindow === true);
  }
  search(query: string, limit = 10): PublicDisplayResult {
    return querySources(this.captureSources({}).map(publishSource), { limit }, false, query);
  }
  private captureSources(query: PublicDisplayQuery): PreparedPublicSource[] {
    const houses: PreparedPublicSource[] = [];
    for (const source of this.options.sources()) {
      let capture: PublicDisplayCapture | undefined;
      try {
        capture = source.capture();
        if (capture.capability.house.origin !== source.origin || capture.producerPolicy.house.origin !== source.origin
          || capture.producerPolicy.house.houseKey !== capture.capability.house.houseKey
          || capture.producerPolicy.house.incarnation !== capture.capability.house.incarnation
          || capture.producerPolicy.capabilityRevision !== capture.capability.capabilityRevision) throw new Error('PUBLIC_DISPLAY_CAPTURE_MISMATCH');
        capture.assertCurrent();
        const captured = capture;
        const result = readPublicJournalSnapshot(captured.executionDb, tx => readPublicJournal(tx, captured, source,
          { completeWindow: query.completeWindow, ownProjection: query.ownProjection }));
        captured.assertCurrent();
        houses.push({ origin: source.origin, slug: source.slug, ...result, assertCurrent: () => captured.assertCurrent() });
      } catch (error) {
        houses.push({ origin: source.origin, slug: source.slug, status: unavailable(source, capture, error), items: [], assertCurrent() {} });
      }
    }
    return houses;
  }
}

class PreparedPublicFeedDisplay extends PublicFeedDisplay {
  constructor(private readonly captured: readonly PreparedPublicSource[], private readonly completeWindow: boolean) { super({ sources: () => [] }); }
  override get publicSources(): readonly PreparedPublicSource[] { return this.captured.map(publishSource); }
  override async prepare(): Promise<PublicFeedDisplay> { return this; }
  override read(query: PublicDisplayQuery = {}): PublicDisplayResult { return querySources(this.publicSources, query, this.completeWindow); }
  override search(query: string, limit = 10): PublicDisplayResult { return querySources(this.publicSources, { limit }, false, query); }
}
