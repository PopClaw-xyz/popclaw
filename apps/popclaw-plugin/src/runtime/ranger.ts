import { actionFetch, actionSleep, assertActionActive, runAction, signActionEnvelope, type ActionGate } from './house-lifecycle/action-context.js';
import type { HostAdapter } from '../host/host-adapter.js';
import type { Signer } from '../identity/signer.js';
import type { EventEgress } from '../egress/event-egress.js';
import type { EventIngress } from '../ingress/event-ingress.js';
import { EventDispatcher } from '../ingress/event-dispatcher.js';
import { QuestHandler } from '../quest/quest-handler.js';
import { VerifyInviteHandler, createDefaultMock } from '../quest/verify-invite-handler.js';
import { ScrapeContentHandler } from '../quest/scrape-content-handler.js';
import type { PlatformScraper, PlatformScraperRegistry } from '../scraper/platform-scraper.js';
import { HybridScraper } from '../scraper/hybrid-scraper.js';
import { apifyTwitter } from '../scraper/commercial/apify-twitter.js';
import type { CostObserverCallback } from '../scraper/commercial/apify-actor-scraper.js';
import { TwitterApiIoScraper } from '../scraper/commercial/twitterapi-io-scraper.js';
import {
  DegradationDetector,
  type DegradationLogger,
} from '../scraper/commercial/degradation-detector.js';
import {
  routeInviteVerified,
  type InviteNotifyWiring,
  type InviteVerifiedLike,
} from '../invite/pending-invites.js';
import type { PluginConfig } from '../config/schema.js';
import { WatchRegistry } from '../watch/watch-registry.js';
import { SqliteWatchWatermarkStore } from '../watch/watch-watermark-store.js';
import { WatchLoop, type MirrorPostToPush } from '../watch/watch-loop.js';
import { handleWatchDispatch } from '../watch/watch-dispatch-handler.js';
import { handleWatchCancel } from '../watch/watch-cancel-handler.js';
import { HeartbeatPublisher, type HeartbeatShape } from '../watch/heartbeat-publisher.js';
import { buildMirrorPost, scrapedMediaToInput } from '../watch/feed-builder.js';
import { BudgetGuard } from '../observability/budget-guard.js';

export interface BuildScraperDeps {
  readonly gate?: ActionGate;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly backendOverride: string | undefined;
  readonly apifyToken: string | undefined;
  readonly twitterApiIoKey: string | undefined;
  readonly youtubeApiKey: string | undefined;
  readonly onScrapeComplete?: CostObserverCallback;
  /** Optional filter: only include these platform keys in the result. */
  readonly enabledPlatforms?: readonly string[];
  /** Optional pino-style logger so degradation events emit structured warns. */
  readonly degradationLogger?: DegradationLogger;
}

// TwitterAPI.io's search endpoints went silently empty for
// every handle on 2026-04-27 while /user/info still worked. Wrap the
// provider so consecutive empties trip a circuit and HybridScraper falls
// back to Apify within seconds.
const TWITTERAPI_IO_DEGRADATION_THRESHOLD = 5;
const TWITTERAPI_IO_RECOVERY_MS = 30 * 60_000;

function wrapWithDegradationDetector(
  inner: PlatformScraper,
  providerName: string,
  logger: DegradationLogger | undefined,
): PlatformScraper {
  return new DegradationDetector({
    inner,
    providerName,
    consecutiveEmptyThreshold: TWITTERAPI_IO_DEGRADATION_THRESHOLD,
    recoveryMs: TWITTERAPI_IO_RECOVERY_MS,
    logger,
  });
}

/** Internal: the X-platform scraper selection. Commercial-only: TwitterAPI.io
 *  primary (DegradationDetector-wrapped) with an Apify fallback, or Apify-only.
 *  Returns `undefined` when neither credential is configured. */
async function buildScraperForX(deps: BuildScraperDeps): Promise<PlatformScraper | undefined> {
  const { backendOverride, apifyToken, twitterApiIoKey, onScrapeComplete } = deps;

  // TwitterAPI.io is wrapped with a DegradationDetector so a
  // silent provider outage trips into Apify failover within ~5 polls.
  const makeTwitterApiIo = () =>
    wrapWithDegradationDetector(
      new TwitterApiIoScraper({ apiKey: twitterApiIoKey!, onScrapeComplete, fetch: actionFetch(deps.gate, deps.fetch), sleep: actionSleep(deps.gate, deps.sleep) }),
      'twitterapi.io',
      deps.degradationLogger,
    );
  const makeApify = () => apifyTwitter(apifyToken!, onScrapeComplete, { fetch: actionFetch(deps.gate, deps.fetch), sleep: actionSleep(deps.gate, deps.sleep) });

  if (backendOverride === 'twitterapi_io') {
    if (!twitterApiIoKey) throw new Error('backend=twitterapi_io but POPCLAW_TWITTERAPI_IO_KEY not set');
    return makeTwitterApiIo();
  }
  if (backendOverride === 'apify') {
    if (!apifyToken) throw new Error('backend=apify but POPCLAW_APIFY_TOKEN not set');
    return makeApify();
  }
  if (backendOverride !== undefined && backendOverride !== '') {
    throw new Error(
      `unsupported X backend '${backendOverride}' — only twitterapi_io/apify remain`,
    );
  }

  // auto priority:
  //   twitterapi_io → TwitterApiIo  primary + apify fallback (when present)
  //   apify         → apifyTwitter  primary, no fallback
  //   none          → undefined     (no X scraper advertised)
  if (twitterApiIoKey) {
    return new HybridScraper({ primary: makeTwitterApiIo(), fallback: apifyToken ? makeApify() : undefined });
  }
  if (apifyToken) {
    return new HybridScraper({ primary: makeApify() });
  }
  return undefined;
}

export async function buildScraperRegistryFor(deps: BuildScraperDeps): Promise<PlatformScraperRegistry> {
  const { enabledPlatforms } = deps;
  const want = enabledPlatforms ? new Set(enabledPlatforms) : null;
  const includes = (p: string) => !want || want.has(p);

  const reg = new Map<string, PlatformScraper>();

  // X: commercial-only (TwitterAPI.io + Apify). May be undefined when no key.
  if (includes('x')) {
    const x = await buildScraperForX(deps);
    if (x) reg.set('x', x);
  }

  // Instagram: only apify today.
  if (includes('instagram') && deps.apifyToken) {
    const { apifyInstagram } = await import('../scraper/commercial/apify-instagram.js');
    reg.set('instagram', apifyInstagram(deps.apifyToken, deps.onScrapeComplete, { fetch: actionFetch(deps.gate, deps.fetch), sleep: actionSleep(deps.gate, deps.sleep) }));
  }

  // TikTok: only apify today.
  if (includes('tiktok') && deps.apifyToken) {
    const { apifyTiktok } = await import('../scraper/commercial/apify-tiktok.js');
    reg.set('tiktok', apifyTiktok(deps.apifyToken, deps.onScrapeComplete, { fetch: actionFetch(deps.gate, deps.fetch), sleep: actionSleep(deps.gate, deps.sleep) }));
  }

  // YouTube: YouTube Data API key required.
  if (includes('youtube') && deps.youtubeApiKey) {
    const { YoutubeDataApiScraper } = await import('../scraper/commercial/youtube-data-api-scraper.js');
    reg.set('youtube', new YoutubeDataApiScraper({
      apiKey: deps.youtubeApiKey,
      fetch: actionFetch(deps.gate, deps.fetch),
      sleep: actionSleep(deps.gate, deps.sleep),
      onScrapeComplete: deps.onScrapeComplete,
    }));
  }

  return reg;
}

/**
 * Build a `PlatformScraperRegistry` from `process.env`. Optional
 * `onScrapeComplete` callback receives a `CostEvent` per scrape — wire
 * this to your daemon's structured logger to get per-call cost lines.
 * Without a callback, scrape costs are discarded.
 *
 * Optional `degradationLogger` receives degradation/recovery events from
 * the TwitterAPI.io DegradationDetector wrapper. Pass a
 * pino-style logger to surface failover transitions.
 */
export async function buildScraperRegistry(
  onScrapeComplete?: CostObserverCallback,
  degradationLogger?: DegradationLogger,
  gate?: ActionGate,
): Promise<PlatformScraperRegistry> {
  const backendOverride =
    process.env.POPCLAW_X_BACKEND ?? process.env.POPCLAW_X_SCRAPER_BACKEND;
  return buildScraperRegistryFor({
    gate,
    backendOverride,
    apifyToken: process.env.POPCLAW_APIFY_TOKEN,
    twitterApiIoKey: process.env.POPCLAW_TWITTERAPI_IO_KEY,
    youtubeApiKey: process.env.POPCLAW_YOUTUBE_API_KEY,
    onScrapeComplete,
    degradationLogger,
  });
}

export interface RangerDeps {
  /** Canonical house origin for shared-host SQLite watermark isolation. */
  readonly houseOrigin?: string;
  readonly gate?: ActionGate;
  readonly now?: () => number;
  readonly host: HostAdapter;
  readonly config: PluginConfig;
  readonly signer: Signer;
  readonly nickname: string;
  readonly egress: EventEgress;
  readonly ingress: EventIngress;
  /**
   * ADR-0040 Act 2 wiring: when `invite_verified` arrives → if it's mine, straight to the
   * L1 direct-write channel. Not injected = no notification (CLI / test paths stay as-is).
   *
   * Holder shape (following the socialLogRef convention in index.ts): Ranger's construction
   * point must come before the notification wiring (the ranger needs to be alive before
   * failable startup steps like the world-stream cache — it's a public network role, and the
   * owner's local cache being broken shouldn't take down the verification service), so what's
   * injected is a reference that can be filled in later. Auth events that arrive before the
   * holder is in place: silently dropped, backstopped by the rejected/lazy-lookup polling path.
   */
  readonly inviteNotify?: { readonly current?: InviteNotifyWiring };
}

export class Ranger {
  private watchTickTimer: ReturnType<typeof setInterval> | null = null;
  private watchHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private budgetGuard: BudgetGuard | null = null;

  private readonly stopping = new AbortController();
  private readonly actionGate: ActionGate;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly flights = new Map<string, Promise<void>>();
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;

  constructor(private readonly deps: RangerDeps) {
    this.actionGate = {
      signal: deps.gate ? AbortSignal.any([deps.gate.signal, this.stopping.signal]) : this.stopping.signal,
      isActive: () => !this.stopping.signal.aborted && (deps.gate?.isActive() ?? true),
    };
  }

  private track(task: Promise<void>): Promise<void> {
    this.inFlight.add(task);
    void task.then(() => this.inFlight.delete(task), () => this.inFlight.delete(task));
    return task;
  }

  private launch(key: string, work: () => Promise<void>): void {
    if (!this.actionGate.isActive() || this.flights.has(key)) return;
    const task = this.track(runAction(this.actionGate, work));
    this.flights.set(key, task);
    void task.then(() => this.flights.delete(key), (error) => {
      this.flights.delete(key);
      this.deps.host.logger.info({}, `ranger: ${key} failed: ${String(error)}`);
    });
  }

  start(): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.resolve();
    return this.startPromise ??= this.track(runAction(this.actionGate, () => this.startActive()));
  }

  private async startActive(): Promise<void> {
    assertActionActive(this.actionGate);
    // EventDispatcher routes inbound events by payload oneof; QuestHandler
    // intercepts quest_dispatch and handles self-addressed VERIFY_INVITE /
    // SCRAPE_CONTENT quests through their registered handlers.
    const dispatcher = new EventDispatcher();
    // Build a platform-keyed scraper registry from env. Capabilities derived
    // from its keys are advertised in ranger_registration — a ranger only
    // advertises platforms it can actually scrape.
    //
    // thread a cost-observer callback that emits one structured
    // log line per scrape so operators can `just popclaw-cost-summary` to
    // tally daily/monthly burn.
    // pino-shaped logger to DegradationDetector — surfaces
    //   provider failover transitions (TwitterAPI.io → Apify on outage).
    // each cost event also feeds BudgetGuard for the soft
    //   daily-budget alarm + auto-throttle.
    const budgetGuard = BudgetGuard.fromEnv(this.deps.host.logger);
    const registry = await buildScraperRegistry(
      (event) => {
        this.deps.host.logger.info(
          {
            providerName: event.providerName,
            platform: event.platform,
            resultsCount: event.resultsCount,
            estimatedCostUsd: event.estimatedCostUsd,
            latencyMs: event.latencyMs,
          },
          'commercial scrape cost',
        );
        budgetGuard.record(event);
      },
      this.deps.host.logger,
      this.actionGate,
    );
    assertActionActive(this.actionGate);
    // Stash for use in startWatchLoop without changing its signature.
    this.budgetGuard = budgetGuard;
    const verifyInvite = new VerifyInviteHandler({
      gate: this.deps.gate,
      now: this.deps.now,
      signer: this.deps.signer,
      egress: this.deps.egress,
      mock: createDefaultMock(), // env-stub still takes precedence for E2E determinism
      scraperRegistry: registry,
      loggerInfo: (msg) => this.deps.host.logger.info({}, msg),
    });
    const scrapeContent = new ScrapeContentHandler({
      gate: this.deps.gate,
      now: this.deps.now,
      signer: this.deps.signer,
      egress: this.deps.egress,
      scraperRegistry: registry,
      loggerInfo: (msg) => this.deps.host.logger.info({}, msg),
    });
    // ADR-0040 Act 2: the echo of a passed verification. The classifier has long recognized
    // `invite_verified`; all that was missing was this hook — previously this event was
    // dropped on arrival, and the owner would never know they'd passed.
    const inviteNotifyRef = this.deps.inviteNotify;
    if (inviteNotifyRef) {
      dispatcher.on('invite_verified', async (_inbound, payload) => {
        // Arrives before the holder is in place (startup window): drop this one,
        // the polling/lazy-lookup path backstops it.
        assertActionActive(this.actionGate);
        const wiring = inviteNotifyRef.current;
        if (!wiring) return;
        // routeInviteVerified kicks the delivery channel itself when it enqueues.
        const outcome = routeInviteVerified(wiring, payload as InviteVerifiedLike);
        this.deps.host.logger.info({}, `ranger: invite_verified → ${outcome}`);
      });
    }

    const questHandler = new QuestHandler({
      dispatcher,
      gate: this.deps.gate,
      now: this.deps.now,
      signer: this.deps.signer,
      verifyInvite,
      scrapeContent,
      loggerWarn: (msg) => this.deps.host.logger.warn({}, msg),
    });
    await questHandler.start();
    assertActionActive(this.actionGate);

    // Install every handler before start: durable ingresses can synchronously
    // replay pending events and mark them done before start() returns.
    const announceAfterStart = this.deps.config.ranger_mode === true
      ? this.startWatchLoop(dispatcher, registry)
      : undefined;

    // Keep the Scope A "received event" info log, then route through the dispatcher.
    await this.deps.ingress.start((inbound) => this.track(runAction(this.actionGate, async () => {
      this.deps.host.logger.info(
        { event_id: inbound.eventId },
        'ranger: received event from house',
      );
      await dispatcher.dispatch(inbound);
    })));
    assertActionActive(this.actionGate);

    // Connection-aware ingresses announce from onConnected. Legacy transports
    // without that hook retain their one-time announcement after startup.
    if (announceAfterStart) await announceAfterStart();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping.abort();
    if (this.watchTickTimer !== null) clearInterval(this.watchTickTimer);
    if (this.watchHeartbeatTimer !== null) clearInterval(this.watchHeartbeatTimer);
    this.watchTickTimer = this.watchHeartbeatTimer = null;
    this.stopPromise = (async () => {
      // Drain actual promises, including uncancellable signer / SDK operations.
      // Stopping admission first prevents a pending startup from reviving them.
      try { await this.deps.ingress.stop(); }
      finally { while (this.inFlight.size) await Promise.allSettled([...this.inFlight]); }
    })();
    return this.stopPromise;
  }

  private startWatchLoop(
    dispatcher: EventDispatcher,
    scraperRegistry: PlatformScraperRegistry,
  ): (() => Promise<void>) | undefined {
    assertActionActive(this.actionGate);
    // #181: cursor written through to SQLite so a restart resumes on the exact
    // since_id instead of re-buying a page per target.
    const watermarks = new SqliteWatchWatermarkStore(this.deps.host.db, (msg) => this.deps.host.logger.warn({}, msg));
    const watermarkKey = (watchId: string) => this.deps.houseOrigin
      ? JSON.stringify([this.deps.houseOrigin, watchId]) : watchId;
    const registry = new WatchRegistry({
      load: (watchId) => watermarks.load(watermarkKey(watchId)),
      save: (watchId, state) => {
        assertActionActive(this.actionGate);
        watermarks.save(watermarkKey(watchId), state);
      },
    });

    // Route inbound watch events via the dispatcher.
    dispatcher.on('watch_dispatch', async (inbound) => {
      assertActionActive(this.actionGate);
      handleWatchDispatch(inbound, {
        registry,
        now: () => Date.now(),
        loggerInfo: (msg) => this.deps.host.logger.info({}, msg),
      });
    });
    dispatcher.on('watch_cancel', async (inbound) => {
      assertActionActive(this.actionGate);
      handleWatchCancel(inbound, {
        registry,
        loggerInfo: (msg) => this.deps.host.logger.info({}, msg),
      });
    });

    // Build + sign + push a Post+Origin envelope for each new post the
    // watch loop surfaces (ADR-0025, Task 4.2). Delegates layout to
    // feed-builder (Invariant #1 compliant).
    //
    // ADR-0025 I-1 guard: origin.platform MUST NOT be "popclaw"; origin.post_id
    // and origin.url MUST be non-empty. The ranger scrapes real external
    // platforms so these should always be populated — but if a scrape result
    // is malformed (empty post_id or url), skip it with a warning rather than
    // emit a malformed Origin that lore-house would reject.
    const pushFeedFromWatch = async (feed: MirrorPostToPush): Promise<void> => {
      assertActionActive(this.actionGate);
      // ADR-0025 I-1 validation.
      if (feed.platform === 'popclaw') {
        this.deps.host.logger.warn(
          {},
          `ranger: skipping mirror post with platform="popclaw" (ADR-0025 I-1 violation); watchId target=${feed.authorPopclawId}`,
        );
        return;
      }
      if (!feed.platformPostId) {
        this.deps.host.logger.warn(
          {},
          `ranger: skipping mirror post with empty platformPostId for platform=${feed.platform} target=${feed.authorPopclawId}`,
        );
        return;
      }
      if (!feed.originalUrl) {
        this.deps.host.logger.warn(
          {},
          `ranger: skipping mirror post with empty originalUrl for platform=${feed.platform} postId=${feed.platformPostId}`,
        );
        return;
      }

      const { post } = buildMirrorPost({
        platform: feed.platform,
        platformPostId: feed.platformPostId,
        platformPostCreatedAt: feed.platformPostCreatedAt,
        originalUrl: feed.originalUrl,
        text: feed.text,
        media: (feed.media ?? []).map(scrapedMediaToInput),
        inReplyToId: feed.inReplyToId,
      });
      // The public envelope carries no top-level platform (author boundary:
      // unknown fields are rejected before signing); buildMirrorPost's Origin
      // is where the source platform lives.
      const env: Record<string, unknown> = {
        actor: { popclawId: await this.deps.signer.popclawId() },
        timestamp: Math.floor(Date.now() / 1000),
        post,
      };
      const signed = await signActionEnvelope(this.deps.signer, env, this.actionGate);
      // A non-2xx receipt from lore-house is a PERMANENT drop, not a transient
      // failure — the same bytes will hit the same validator answer on any
      // retry. Leave a trace so a rejected mirror post is not silently lost
      // (same rule the quest scrape-content handler follows).
      assertActionActive(this.actionGate);
      const receipt = await this.deps.egress.push(signed.signedPayloadBytes);
      if (receipt.status < 200 || receipt.status >= 300) {
        this.deps.host.logger.warn(
          {},
          `ranger: mirror post ${feed.platform}/${feed.platformPostId} permanently rejected by lore-house (HTTP ${receipt.status}) — not retried`,
        );
      }
    };

    const watchConfig = this.deps.config.watch;

    const watchLoop = new WatchLoop({
      gate: this.actionGate,
      registry,
      scraperRegistry,
      push: pushFeedFromWatch,
      maxScanItems: watchConfig.max_scan_items,
      loggerInfo: (msg) => this.deps.host.logger.info({}, msg),
      loggerWarn: (msg) => this.deps.host.logger.warn({}, msg),
      budgetGuard: this.budgetGuard ?? undefined,
    });

    this.watchTickTimer = setInterval(() => {
      this.launch('watch tick', () => watchLoop.tick((this.deps.now ?? Date.now)()));
    }, watchConfig.tick_interval_ms);

    // Invariant #1: elide activeSince=0 / recentHits=0 on the wire.
    const emitHeartbeat = async (hb: HeartbeatShape): Promise<void> => {
      assertActionActive(this.actionGate);
      const watchHeartbeat: Record<string, unknown> = { watchId: hb.watchId };
      if (hb.activeSince !== 0) watchHeartbeat.activeSince = hb.activeSince;
      if (hb.recentHits !== 0) watchHeartbeat.recentHits = hb.recentHits;
      const env: Record<string, unknown> = {
        actor: { popclawId: await this.deps.signer.popclawId() },
        timestamp: Math.floor(Date.now() / 1000),
        watchHeartbeat,
      };
      const signed = await signActionEnvelope(this.deps.signer, env, this.actionGate);
      assertActionActive(this.actionGate);
      await this.deps.egress.push(signed.signedPayloadBytes);
    };

    const heartbeatPub = new HeartbeatPublisher({
      registry,
      emit: emitHeartbeat,
      now: () => Date.now(),
      loggerInfo: (msg) => this.deps.host.logger.info({}, msg),
    });
    this.watchHeartbeatTimer = setInterval(() => {
      this.launch('heartbeat', () => heartbeatPub.tick());
    }, watchConfig.heartbeat_interval_ms);

    // Finally, announce this ranger's capabilities. Capabilities are derived
    // from the scraper registry — a ranger only advertises platforms it can
    // actually scrape. Sort for deterministic wire bytes (important for
    // evidence hashing / reproducibility). Invariant #1: availabilityScore=0
    // (default) is elided; capabilities is a repeated field, never elided.
    const capabilities = Array.from(scraperRegistry.keys()).sort();
    const announce = async (): Promise<void> => {
      assertActionActive(this.actionGate);
      const regEnv: Record<string, unknown> = {
        actor: { popclawId: await this.deps.signer.popclawId() },
        timestamp: Math.floor(Date.now() / 1000),
        rangerRegistration: { capabilities },
      };
      const signedReg = await signActionEnvelope(this.deps.signer, regEnv, this.actionGate);
      assertActionActive(this.actionGate);
      await this.deps.egress.push(signedReg.signedPayloadBytes);
    };

    // #144: registering is what makes the lore-house re-emit WatchDispatch for
    // rows already pinned to us — and that re-emission rides the very stream we
    // are subscribing to. Announced once at startup, it races the subscription:
    // registration goes out over HTTP while `ingress.start()` has only *begun*
    // opening the stream, so the house can answer into a socket nobody is
    // listening on yet. The envelopes are dropped, `last_heartbeat_at` has
    // already been refreshed so the rows look healthy for the 5-minute grace,
    // and then they go stalled and stay dead until the process restarts.
    //
    // Tying the announcement to stream-open fixes both that startup race and
    // every later reconnect: the house only ever answers into a live stream.
    // Server-side it is idempotent (capabilities upsert + idempotent re-emit),
    // so re-asking costs nothing but makes recovery eventually-delivered.
    if (this.deps.ingress.onConnected) {
      this.deps.ingress.onConnected(() => {
        this.launch('re-registration', announce);
      });
    } else {
      // An ingress with no connection to speak of (tests, future transports):
      // ask once after ingress.start(), exactly as before.
      return announce;
    }
  }
}
