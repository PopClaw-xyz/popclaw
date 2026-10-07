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
  readonly origin: string;
  readonly slug: string;
  readonly capabilityRevision: string;
  readonly logIncarnation: string;
  readonly history: boolean;
  readonly incomplete: boolean;
  readonly unavailable: boolean;
  readonly truncated: boolean;
  readonly observedAt: number | null;
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
  readonly source: { readonly origin: string; readonly slug: string; readonly observedAt: number; readonly sequence: string; readonly logIncarnation: string };
  readonly alsoInHouses?: readonly string[];
}
export interface PublicDisplayResult {
  readonly items: readonly PublicDisplayItem[];
  readonly sources: readonly PublicDisplaySource[];
  readonly truncated: boolean;
}
export interface PublicDisplayQuery extends WorldFeedQuery { readonly includeThreads?: boolean }
export interface PublicFeedDisplayOptions {
  sources(): readonly { origin: string; slug: string; capture(): PublicDisplayCapture }[];
}
function time(value: unknown): number { const n = numberOrZero(value); return Number.isSafeInteger(n) && n >= 0 && n <= 253402300799 ? n : 0; }
function unavailable(source: { origin: string; slug: string }, capture: PublicDisplayCapture | undefined, error: unknown): PublicDisplaySource {
  return { origin: source.origin, slug: source.slug, capabilityRevision: capture?.capability.capabilityRevision ?? '',
    logIncarnation: capture?.capability.publicStream.log_incarnation ?? '', history: capture?.history ?? true,
    incomplete: true, unavailable: true, truncated: false, observedAt: null,
    code: error instanceof Error ? error.message : 'PUBLIC_DISPLAY_UNAVAILABLE' };
}

/** Every query owns its result. The sources callback follows later mounts but
 * never opens a house itself or borrows the global catalog's snapshot path. */
export class PublicFeedDisplay {
  constructor(private readonly options: PublicFeedDisplayOptions) {}
  read(query: PublicDisplayQuery = {}): PublicDisplayResult { return this.query(query); }
  search(query: string, limit = 10): PublicDisplayResult { return this.query({ limit }, query); }

  private query(query: PublicDisplayQuery, search?: string): PublicDisplayResult {
    const limit = Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 100) : 20;
    const sources: PublicDisplaySource[] = [], merged = new Map<string, PublicDisplayItem>();
    const houses: Array<{ source: { origin: string; slug: string }; capture?: PublicDisplayCapture;
      status: PublicDisplaySource; items: PublicDisplayItem[] }> = [];
    const terms = (search ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
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
        const result = readPublicJournalSnapshot(captured.executionDb, tx => readPublicJournal(tx, captured, source));
        captured.assertCurrent();
        houses.push({ source, capture, ...result });
      } catch (error) {
        houses.push({ source, status: unavailable(source, capture, error), items: [] });
      }
    }
    // A later House may take time to scan. Recheck every earlier capture at
    // publication, before deduplication can retain its body or attribution.
    for (const house of houses) {
      if (house.capture) {
        try { house.capture.assertCurrent(); }
        catch (error) { house.status = unavailable(house.source, house.capture, error); house.items = []; }
      }
      sources.push(house.status);
      for (const hit of house.items) {
        const item = hit.item;
        if (query.includeThreads === false && item.replyToPostId && !item.quotedEventId) continue;
        if (query.author && item.authorPopclawId !== query.author) continue;
        if (query.platform && item.platform !== query.platform) continue;
        const text = [hit.kind, hit.body, item.textPreview, item.handle, item.actorNickname, item.originalUrl, item.origin?.url].join(' ').toLocaleLowerCase();
        if (terms.some(term => !text.includes(term))) continue;
        const id = item.eventId!;
        const first = merged.get(id);
        if (first) merged.set(id, { ...first, alsoInHouses: [...(first.alsoInHouses ?? []), house.source.slug] });
        else merged.set(id, hit);
      }
    }
    const items = [...merged.values()].sort((a, b) => time(b.item.platformPostCreatedAt) - time(a.item.platformPostCreatedAt)
      || String(a.item.platformPostId).localeCompare(String(b.item.platformPostId)));
    return { items: items.slice(0, limit), sources, truncated: items.length > limit || sources.some(source => source.truncated) };
  }


}
