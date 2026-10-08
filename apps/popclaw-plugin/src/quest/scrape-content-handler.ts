import { assertActionActive, questAction, rethrowActionCancellation, runAction, signActionEnvelope, type ActionGate } from '../runtime/house-lifecycle/action-context.js';
/**
 * ScrapeContentHandler.
 *
 * When a `scraper: PlatformScraper` is injected, fetch up to `maxItems`
 * posts newer than `since_timestamp`, emit one mirror Post (Post+Origin) per
 * post via `egress.push`, then a single terminal QuestResultPayload
 * summarizing the run.
 *
 * Without a scraper (stub), skip mirror Post emission entirely
 * and just push a single APPROVE QuestResult. This preserves the
 * dispatcher-plumbing tests from S-B1/S-B2/S-B4.
 *
 * Evidence policy:
 *   - evidence_hash = SHA-256(sorted tweet-id list joined by ",")
 *   - evidence_sample = first pushed tweet's text (capped 16 KB)
 */

import { createHash } from 'node:crypto';
import type { Signer } from '../identity/signer.js';
import type { EventEgress } from '../egress/event-egress.js';
import type { InboundEnvelope } from '../ingress/event-ingress.js';
import {
  canonicalPlatform,
  type PlatformScraperRegistry,
  type ScrapedPost,
} from '../scraper/platform-scraper.js';
import { buildMirrorPost, scrapedMediaToInput } from '../watch/feed-builder.js';

const EVIDENCE_SAMPLE_MAX_BYTES = 16_384;
const OUTCOME_APPROVE = 1;
const OUTCOME_ABSTAIN = 3;

export interface ScrapeContentHandlerDeps {
  readonly gate?: ActionGate;
  readonly now?: () => number;
  readonly signer: Signer;
  readonly egress: EventEgress;
  readonly scraperRegistry?: PlatformScraperRegistry;
  readonly loggerInfo?: (msg: string) => void;
}

export class ScrapeContentHandler {
  constructor(private readonly deps: ScrapeContentHandlerDeps) {}

  async handle(dispatchEnv: InboundEnvelope, payload: Record<string, unknown>): Promise<void> {
    const dispatch = dispatchEnv.envelope['questDispatch'] as Record<string, unknown> | undefined;
    await runAction(questAction(this.deps.gate, dispatch?.['expiresAt'], this.deps.now), () => this.handleActive(dispatchEnv, payload));
  }

  private async handleActive(dispatchEnv: InboundEnvelope, payload: Record<string, unknown>): Promise<void> {
    assertActionActive(this.deps.gate);
    const envelope = dispatchEnv.envelope;
    const dispatch = envelope['questDispatch'] as { taskId?: string } | undefined;
    const taskId = dispatch?.taskId ?? '';
    const platform = (payload['platform'] as string) ?? '';
    const handle = (payload['handle'] as string) ?? '';
    const sinceTs = Number(payload['sinceTimestamp'] ?? 0);
    const maxItems = Number(payload['maxItems'] ?? 20);

    if (!this.deps.scraperRegistry) {
      // stub mode: emit only a terminal APPROVE QuestResult, no feeds.
      this.deps.loggerInfo?.(`scrape-content stub: task=${taskId} (no feed emission)`);
      assertActionActive(this.deps.gate);
      await this.pushQuestResult(taskId, platform, OUTCOME_APPROVE, new Uint8Array(32), null);
      assertActionActive(this.deps.gate);
      return;
    }

    const scraper = this.deps.scraperRegistry.get(canonicalPlatform(platform));
    if (!scraper) {
      this.deps.loggerInfo?.(
        `scrape-content: no scraper for platform '${platform}' (handle='${handle}'); returning empty`,
      );
      assertActionActive(this.deps.gate);
      await this.pushQuestResult(taskId, platform, OUTCOME_APPROVE, new Uint8Array(32), null);
      assertActionActive(this.deps.gate);
      return;
    }

    let posts: ScrapedPost[] = [];
    try {
      assertActionActive(this.deps.gate);
      posts = await scraper.scrapeTimeline(handle, new Date(sinceTs * 1000), maxItems);
      assertActionActive(this.deps.gate);
    } catch (err) {
      rethrowActionCancellation(err);
      this.deps.loggerInfo?.(`scrape-content: task=${taskId} fetch failed: ${String(err)}`);
      assertActionActive(this.deps.gate);
      await this.pushQuestResult(taskId, platform, OUTCOME_ABSTAIN, new Uint8Array(32), null, `scrape failed: ${String(err).slice(0, 200)}`);
      assertActionActive(this.deps.gate);
      return;
    }

    this.deps.loggerInfo?.(`scrape-content: task=${taskId} fetched ${posts.length} posts`);

    // Emit one mirror Post (Post+Origin) per scraped item (best-effort;
    // individual failures don't abort the run).
    for (const post of posts) {
      try {
        assertActionActive(this.deps.gate);
        await this.pushMirrorPost(platform, post);
        assertActionActive(this.deps.gate);
      } catch (err) {
        rethrowActionCancellation(err);
        this.deps.loggerInfo?.(`scrape-content: task=${taskId} push mirror post ${post.id} failed: ${String(err)}`);
      }
    }

    // Terminal QuestResult: APPROVE with evidence derived from the ids.
    const sortedIds = posts.map((p) => p.id).sort();
    const evidenceHash = new Uint8Array(
      createHash('sha256').update(sortedIds.join(',')).digest(),
    );
    const sampleText = posts[0]?.text ?? '';
    const evidenceSample =
      sampleText.length > 0
        ? new TextEncoder().encode(sampleText).slice(0, EVIDENCE_SAMPLE_MAX_BYTES)
        : null;
    assertActionActive(this.deps.gate);
    await this.pushQuestResult(taskId, platform, OUTCOME_APPROVE, evidenceHash, evidenceSample);
    assertActionActive(this.deps.gate);
  }

  private async pushMirrorPost(platform: string, post: ScrapedPost): Promise<void> {
    assertActionActive(this.deps.gate);
    const popclawId = await this.deps.signer.popclawId();
    assertActionActive(this.deps.gate);
    const { post: postBody } = buildMirrorPost({
      platform,
      platformPostId: post.id,
      platformPostCreatedAt: Math.floor(post.createdAt.getTime() / 1000),
      originalUrl: post.originalUrl,
      text: post.text ?? '',
      media: (post.media ?? []).map(scrapedMediaToInput),
    });
    const env: Record<string, unknown> = {
      actor: { popclawId },
      // lorehouse: omit (proto3 default "" = "the house you're talking to", ADR-0025 task 4.5b)
      timestamp: Math.floor(post.createdAt.getTime() / 1000),
      post: postBody,
    };
    const signed = await signActionEnvelope(this.deps.signer, env);
    assertActionActive(this.deps.gate);
    const receipt = await this.deps.egress.push(signed.signedPayloadBytes);
    assertActionActive(this.deps.gate);
    // A non-2xx receipt from lore-house is a PERMANENT drop, not a transient
    // failure — the same bytes will hit the same validator answer on any retry,
    // and this run never sees the post again (no per-post retry queue). Leave a
    // trace so a rejected mirror post is not silently lost.
    if (receipt.status < 200 || receipt.status >= 300) {
      this.deps.loggerInfo?.(
        `scrape-content: mirror post ${post.id} permanently rejected by house — ` +
          `HTTP ${receipt.status}${receipt.detail ? `: ${receipt.detail}` : ''}`,
      );
    }
  }

  private async pushQuestResult(
    taskId: string,
    platform: string,
    outcome: number,
    evidenceHash: Uint8Array,
    evidenceSample: Uint8Array | null,
    reason?: string,
  ): Promise<void> {
    const questResult: Record<string, unknown> = {
      taskId,
      outcome,
      evidenceHash,
    };
    if (evidenceSample && evidenceSample.length > 0) {
      questResult['evidenceSample'] = evidenceSample;
    }
    if (reason) {
      questResult['reason'] = reason;
    }
    const env: Record<string, unknown> = {
      actor: { popclawId: await this.deps.signer.popclawId() },
      // lorehouse: omit (proto3 default "" = "the house you're talking to", ADR-0025 task 4.5b)
      // Note: `platform` parameter here is the social platform (e.g. "x"), not the lorehouse.
      timestamp: Math.floor(Date.now() / 1000),
      questResult,
    };
    const signed = await signActionEnvelope(this.deps.signer, env);
    assertActionActive(this.deps.gate);
    await this.deps.egress.push(signed.signedPayloadBytes);
    assertActionActive(this.deps.gate);
  }
}
