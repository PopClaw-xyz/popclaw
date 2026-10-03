/**
 * ADR-0019 — the single point in the mark execution chain (shared by commands / agent tools /
 * onboarding).
 * Order: local snapshot → taste signal → sign → push. Persisting locally first is the technical
 * basis for the action being "light": it takes effect with zero network round-trips; a push
 * failure is honestly reported as an error, and the server's UPSERT is idempotent so resending
 * is safe.
 */
import type { CachedFeedItem } from '../ingress/world-feed-cache.js';
import { appendPick, type LearnedWriterOptions } from '../taste/learned-writer.js';

/** Minimum surface MarkService needs to mark an item. Onboarding/migrated items need not fabricate unused fields (e.g. platformPostCreatedAt). */
export type MarkableItem = Pick<CachedFeedItem, 'eventId' | 'platform' | 'platformPostId' | 'authorPopclawId' | 'handle' | 'textPreview' | 'originalUrl' | 'houseSlug'>;
import { signMark, signMarkRevoked } from '../messaging/sign-mark.js';
import { pushRouted } from '../egress/event-egress.js';
import type { Signer } from '../identity/signer.js';
import type { MarksStore } from './marks-store.js';

interface EgressLike {
  push(bytes: Uint8Array): Promise<unknown>;
  pushTo?(houseSlug: string | undefined, bytes: Uint8Array): Promise<unknown>;
}

export interface MarkServiceDeps {
  store: MarksStore;
  signer: Signer;
  egress: EgressLike;
  nickname: string;
  taste: LearnedWriterOptions;
  now?: () => number;
}

export interface MarkResult { pushed: boolean; error?: string; }

export class MarkService {
  constructor(private readonly deps: MarkServiceDeps) {}

  async mark(item: MarkableItem): Promise<MarkResult> {
    const ts = Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
    const summaryLine = item.textPreview.replace(/\s+/g, ' ').slice(0, 120);
    this.deps.store.upsert({
      eventId: item.eventId, platform: item.platform, platformPostId: item.platformPostId,
      authorPopclawId: item.authorPopclawId, handle: item.handle,
      summaryLine, bodySnapshot: item.textPreview, sourceUrl: item.originalUrl,
      markedAt: ts,
    });
    await appendPick(this.deps.taste, { ts, eventId: item.eventId, signal: 'saved', summaryLine });
    // Spec B slice ③: the mark lands on the marked content's source house. The server hard-rejects
    // a misrouted mark with 403 (storage/marks.rs) — only correct routing keeps that guard from
    // misfiring on a legitimate cross-house mark.
    return this.push(item.houseSlug, () => signMark(this.deps.signer, { markedEventId: item.eventId, nickname: this.deps.nickname, ts }));
  }

  /** `houseSlug` = the source house of the marked content (the house it was originally marked on); default → the home house. */
  async unmark(eventId: string, houseSlug?: string): Promise<MarkResult & { wasMarked: boolean }> {
    const wasMarked = this.deps.store.has(eventId);
    this.deps.store.delete(eventId);
    const ts = Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
    const r = await this.push(houseSlug, () => signMarkRevoked(this.deps.signer, { markedEventId: eventId, nickname: this.deps.nickname, ts }));
    return { ...r, wasMarked };
  }

  private async push(houseSlug: string | undefined, sign: () => Promise<{ signedPayloadBytes: Uint8Array }>): Promise<MarkResult> {
    try {
      const signed = await sign();
      await pushRouted(this.deps.egress, houseSlug, signed.signedPayloadBytes);
      return { pushed: true };
    } catch (err) {
      return { pushed: false, error: String(err) };
    }
  }
}
