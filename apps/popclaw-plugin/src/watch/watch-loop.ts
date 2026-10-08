import { assertActionActive, rethrowActionCancellation, runAction, type ActionGate } from '../runtime/house-lifecycle/action-context.js';
/**
 * tokio-style tick driver. Every tick:
 *   1. Ask registry for due entries.
 *   2. For each, call scraper.scrapeTimeline(handle=targetPopclawId, since=lastSeenCreatedAt, maxItems).
 *   3. Sort posts ascending by createdAt so newest ends up the lastSeenCreatedAt.
 *   4. Push one MirrorPostToPush per post; per-post push errors logged but non-fatal.
 *   5. Update registry tier state (hit=true with newest createdAt, hit=false otherwise).
 *
 * Per-slice scraper failures are logged but do not abort the tick.
 *
 * MVP shortcut: `handle` = `targetPopclawId`. In practice lore-house will resolve
 * popclaw_id → handle via verified_profiles and pass the handle via WatchDispatch;
 * Task 14 wiring carries the right string through.
 */

import { canonicalPlatform, type PlatformScraperRegistry, type ScrapedMedia, type ScrapedPost } from '../scraper/platform-scraper.js';
import type { WatchRegistry } from './watch-registry.js';

export interface MirrorPostToPush {
  platform: string;
  authorPopclawId: string;
  platformPostId: string;
  platformPostCreatedAt: number;   // seconds since epoch
  originalUrl: string;
  text: string;
  /** Media attachments (image/video thumbs) from the scrape; absent/empty = text-only. */
  media?: readonly ScrapedMedia[];
  /** ADR-0025: platform-native parent post id when this post is a reply; "" = not a reply. */
  inReplyToId: string;
}

/**
 * Optional cost guard. When `isTripped()` returns true, the
 * watch loop short-circuits this entry's poll to a miss (no scraper call,
 * no cost) so the tier state machine drives it down to COLD/SLEEP. Pass
 * `null` to disable.
 */
export interface BudgetGuardLike {
  isTripped(): boolean;
}

export interface WatchLoopDeps {
  gate?: ActionGate;
  registry: WatchRegistry;
  scraperRegistry: PlatformScraperRegistry;
  push: (mirror: MirrorPostToPush) => Promise<void> | void;
  maxScanItems: number;
  loggerInfo?: (msg: string) => void;
  loggerWarn?: (msg: string) => void;
  budgetGuard?: BudgetGuardLike;
}

export class WatchLoop {
  private ticking: Promise<void> | undefined;
  constructor(private readonly deps: WatchLoopDeps) {}

  tick(nowMs: number): Promise<void> {
    if (this.ticking) return this.ticking;
    const task = runAction(this.deps.gate, async () => {
      const due = this.deps.registry.due(nowMs);
      // allSettled keeps every started SDK call in the drain, even if one fails.
      const outcomes = await Promise.allSettled(due.map((entry) => this.pollOne(entry, nowMs)));
      const failure = outcomes.find((item) => item.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    this.ticking = task;
    void task.then(() => { this.ticking = undefined; }, () => { this.ticking = undefined; });
    return task;
  }

  private async pollOne(
    entry: ReturnType<WatchRegistry['all']>[number],
    nowMs: number,
  ): Promise<void> {
    // A watch cancel/replacement invalidates internal scraper and signer
    // awaits too, not just the outer loop's final watermark check.
    return runAction({
      signal: this.deps.gate?.signal ?? new AbortController().signal,
      isActive: () => (this.deps.gate?.isActive() ?? true) && this.deps.registry.all().includes(entry),
    }, () => this.pollActive(entry, nowMs));
  }

  private async pollActive(
    entry: ReturnType<WatchRegistry['all']>[number],
    nowMs: number,
  ): Promise<void> {
    const check = () => {
      assertActionActive(this.deps.gate);
      return this.deps.registry.all().includes(entry);
    };
    if (!check()) return;
    // budget tripped → count as miss without scraping. Tier
    // state machine drives the entry down to COLD/SLEEP; recovers when
    // older cost events age out and the guard untrips.
    if (this.deps.budgetGuard?.isTripped()) {
      this.deps.registry.updateAfterPoll(entry.watchId, false, 0, nowMs);
      return;
    }

    const scraper = this.deps.scraperRegistry.get(canonicalPlatform(entry.platform));
    if (!scraper) {
      this.deps.loggerWarn?.(
        `watch-loop: no scraper for platform '${entry.platform}' (target=${entry.handle}); skipping`,
      );
      return;
    }

    const since = new Date((entry.state.lastSeenCreatedAt || 0) * 1000);
    let posts: ScrapedPost[] = [];
    try {
      // pass the verified handle, NOT the base58 popclaw_id —
      // the scraper calls platform APIs that expect a native username.
      posts = await scraper.scrapeTimeline(
        entry.handle,
        since,
        this.deps.maxScanItems,
        // Exact "newer than this post" cursor. Without it the provider ships
        // (and bills for) a full page of already-seen posts on every quiet
        // poll — 94% of the 2026-08 spend went that way.
        entry.state.lastSeenPlatformPostId,
      );
    } catch (err) {
      rethrowActionCancellation(err);
      if (!check()) return;
      this.deps.loggerWarn?.(
        `watch-loop: scrapeTimeline(${entry.handle}/${entry.platform}) failed: ${String(err)}`,
      );
      this.deps.registry.updateAfterPoll(entry.watchId, false, 0, nowMs);
      return;
    }

    if (!check()) return;
    if (posts.length === 0) {
      this.deps.registry.updateAfterPoll(entry.watchId, false, 0, nowMs);
      return;
    }

    const sorted = [...posts].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    for (const post of sorted) {
      if (!check()) return;
      const secs = Math.floor(post.createdAt.getTime() / 1000);
      const mirror: MirrorPostToPush = {
        platform: entry.platform,
        authorPopclawId: entry.targetPopclawId,
        platformPostId: post.id,
        platformPostCreatedAt: secs,
        originalUrl: post.originalUrl,
        text: post.text,
        media: post.media ?? [],
        inReplyToId: post.inReplyToId ?? '',
      };
      try {
        await this.deps.push(mirror);
        if (!check()) return;
      } catch (err) {
        rethrowActionCancellation(err);
        if (!check()) return;
        this.deps.loggerWarn?.(
          `watch-loop: push(${entry.platform}/${post.id}) failed: ${String(err)}`,
        );
      }
    }

    // Hit only when the batch contains content strictly newer than what we
    // already saw. Defense-in-depth: even if a scraper hands back the
    // boundary post (its createdAt == lastSeenCreatedAt), don't treat it as
    // new — otherwise consecutive_hits stays high and the entry is pinned
    // in HOT (30s) tier, burning API budget on echoes.
    const newest = sorted[sorted.length - 1]!;
    const newestSecs = Math.floor(newest.createdAt.getTime() / 1000);
    const isHit = newestSecs > entry.state.lastSeenCreatedAt;
    if (!check()) return;
    this.deps.registry.updateAfterPoll(entry.watchId, isHit, newestSecs, nowMs, newest.id);
  }
}
