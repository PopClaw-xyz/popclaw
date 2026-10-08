/**
 * The shared runtime assembly: ONE entry, `assembleRuntime`, that builds the
 * runtime bag a tool-registering composition root hands `registerPopclawTools`.
 *
 * The root owns what only it can own — its host adapter (built, with the
 * storage check before it, by the root), the process facts it reads, its
 * protocol wiring — and passes the rest as `RuntimePorts`. Everything two
 * roots used to type twice lives in the private builders beside this file
 * (core, feeds, relations, notifications, dm, onboarding, loops); tests go
 * through this entry only.
 *
 * ADR-0035: importing this module does nothing — no IO, no env read, no
 * timer, no host SDK. It runs only inside a root's lazy build callback.
 *
 * ONE statement order serves both roots (C2 moved the MCP root in its own
 * order; C3 the gateway root, ruling 2026-09-29 13:23 / 14:14). Where the two
 * roots' orders differ observably, each keeps its own through a named
 * `DriftPins` field (cadence vs social graph, score-cache read, follow
 * backfill); every other difference is a pure construction
 * moved within the boot (epoch table, refactor-assembly-c3-epoch-table). A
 * host's own work runs as a `LifecyclePort` phase operation at the point that
 * root did it, and the L2 slots are handed out at their own anchors
 * (`L2Expose`). Relation reception opens (and may start its drain timer)
 * before houses start, and a boot that fails runs the host's synchronous
 * cleanup step first, then drains, closes in reverse, releases storage and
 * closes the host DB, or throws STORAGE_BOOT_CLEANUP_FAILED.
 */
import type { HostAdapter } from '../../host/host-adapter.js';
import type { PopclawPaths } from '../../host/popclaw-paths.js';
import type { SqliteNotifier } from '../../notifier/sqlite-notifier.js';
import type { InviteWatchDeps } from '../../invite/pending-invites.js';
import type { FollowerSyncService } from '../../social-graph/follower-sync-service.js';
import type { PluginRuntime } from '../plugin-runtime.js';
import { PublicFeedDisplay } from '../../ingress/public-feed-display.js';
import { InboxStore } from '../../messaging/inbox-store.js';
import { VerifiedFollowersCache } from '../../identity/verified-followers-cache.js';
import { makeBondContext } from '../../bonds/bond-context.js';
import { PendingFollowStore } from '../../social-graph/pending-follow-store.js';
import { ScoreCache } from '../../recommend/score-cache.js';
import { OwnerNotifyTargetStore } from '../../notifier/owner-notify-target.js';
import { ProposalsStore } from '../../bonds/proposals-store.js';
import { uploadCanvas } from '../../egress/canvas-egress.js';
import { captureNotificationScopes } from '../house-lifecycle/notification-scope.js';
import {
  bootIdentity, buildHouses, buildSharedStores, loadOwnerCadence, registerOwnerLangSignals,
  firstErrorAbortsShutdown, guardedShutdown, type FailedBoot,
} from './core.js';
import { openStores, registerStoreCloses, buildCatalog, reportSubscribedCaches, configureHouseResources } from './feeds.js';
import { buildNameChain, buildSocialGraph, backfillFollowsFromGraph, followerDeps, openReception } from './relations.js';
import { buildQueues, inviteWiring, replyPingRoute } from './notifications.js';
import { buildDmConsumer } from './dm.js';
import { mountedHousesOf, buildCollaborators, buildOnboarding, buildOnboardingState } from './onboarding.js';
import { startHousesAndLoops, buildHostServiceFollowerSync } from './loops.js';
import type { AnyRuntimePorts, LoopsMode, RuntimePorts } from './ports.js';

export type {
  RuntimePorts, PlatformPort, LogPort, WorldPort, WorldLane, DeliveryPort, AgentPort, RangerPort, LifecyclePort, DriftPins,
  PushOpenInput, PushLeg, L2Expose, GuardedShutdownHostOps, LoopsMode, AnyRuntimePorts,
} from './ports.js';

/**
 * The assembled bag: the shared contract, the host's world-lane slots (`S`)
 * and push-leg slots (`P`), the queue, shutdown — and, when the host's
 * services run the resident loops, the unstarted follower poll they start.
 */
export type AssembledRuntime<S extends object, P extends object = Record<never, never>, L extends LoopsMode = 'inline'> =
  PluginRuntime & S & P & {
    readonly notifier: SqliteNotifier;
    shutdown(): Promise<void>;
  } & (L extends 'host-services' ? { readonly followerSync: FollowerSyncService } : unknown);

/** Port combinations this assembly does not assemble; refusing is better than a half-wired root. */
function assertAssembled(ports: AnyRuntimePorts): void {
  const { delivery, lifecycle, drift } = ports;
  const unwired = [
    delivery.kind === 'push' && !delivery.open && 'delivery.kind (push without a leg)',
    // The inline doorbell has no push `deliverNow`.
    delivery.kind === 'push' && lifecycle.loops === 'inline' && 'delivery.kind (push with inline loops)',
    drift.shutdown === 'guarded' && !lifecycle.guardedShutdown && 'drift.shutdown (guarded without its host steps)',
    // The guarded sequence stops no loop: the host's services own them.
    drift.shutdown === 'guarded' && lifecycle.loops === 'inline' && 'drift.shutdown (guarded with inline loops)',
  ].filter(Boolean);
  if (unwired.length > 0) throw new Error(`RUNTIME_ASSEMBLY_UNWIRED: ${unwired.join(', ')}`);
}

/** The score-cache file snapshot, and its report line on roots that write one. */
function loadScoreCache(paths: PopclawPaths, ports: AnyRuntimePorts): ScoreCache {
  const scoreCache = ScoreCache.load(paths.scoreCacheFile());
  const report = ports.log.bootReport;
  if (report) report(`score-cache loaded (${scoreCache.size()} entries)`);
  return scoreCache;
}

export async function assembleRuntime<S extends object, P extends object = Record<never, never>, L extends LoopsMode = 'inline'>(
  host: HostAdapter, ports: RuntimePorts<S, P, L>, closing: AbortSignal): Promise<AssembledRuntime<S, P, L>> {
  const fail: FailedBoot = { drain: async () => {}, closes: [] };
  const { lifecycle, drift } = ports;
  try {
  // Inside the failed-boot path: the root's host already holds the DB and
  // this root's storage participation, so a refusal releases both like any
  // other boot that cannot finish.
  assertAssembled(ports);
  const { executionStores, boot } = await bootIdentity(host, ports, fail);

  const paths = ports.platform.paths();
  // P1: the host's boot markers, before the house lifecycle exists.
  lifecycle.recordBootMarkers?.(paths);
  const { readAuthorityFor, houses, lane, worlds, egress, initiator } = buildHouses(host, boot, ports, executionStores, fail);
  // P2: awaited, with the world and house drain already registered.
  if (lifecycle.reportScrapers) await lifecycle.reportScrapers();

  const rangerEnabled = ports.ranger.decide();

  const { notifier, replyPings, pendingInvites } = buildQueues(host, ports);
  const { bondsStore, knownFollowers, socialLogRef, socialLog } = buildSharedStores(host, paths, ports);

  const houseStores = await openStores(boot, paths, ports, executionStores);
  registerStoreCloses(houseStores, fail);
  // L2 slot: the queue as the host's prompt-build hook reads it. A thunk, so
  // each hook call captures the house scopes and builds its view then.
  lifecycle.expose?.notifier(() => {
    const capture = captureNotificationScopes(houses);
    return notifier.presentationView(item => capture(item)?.isActive() ?? false);
  });
  const worldFeedCache = buildCatalog(paths, houses, ports, houseStores);
  // The single name chain, from THIS catalog, handed out in the same
  // synchronous segment that built the catalog (ruling 14:14 ①).
  const nameOf = buildNameChain(boot, paths, bondsStore, worldFeedCache);
  lifecycle.expose?.nameOf(nameOf);
  reportSubscribedCaches(ports, houseStores);

  const inboxStore = new InboxStore(host.db);
  const { mountedHouses, houseStarted } = mountedHousesOf(boot, paths, inboxStore, houses);
  // The owner's cadence and the social graph, each root in its own relative
  // order (DriftPins.ownerCadenceBeforeSocialGraph): a hook observing owner
  // text while the root waits on either decides the owner language differently.
  const graphInput = { host, boot, ports, egress, worldFeedCache, bondsStore };
  let owner: Awaited<ReturnType<typeof loadOwnerCadence>>;
  let graph: Awaited<ReturnType<typeof buildSocialGraph>>;
  if (drift.ownerCadenceBeforeSocialGraph === true) {
    owner = await loadOwnerCadence(paths, ports);
    graph = await buildSocialGraph(graphInput);
  } else {
    graph = await buildSocialGraph(graphInput);
    owner = await loadOwnerCadence(paths, ports);
  }
  const { cadenceLoader, bootCadence } = owner;
  const { relationProducer, socialGraph } = graph;
  // The score-cache file snapshot: here, or when the bag is returned (DriftPins.scoreCacheLoadedBeforeReception).
  const scoreCacheReadEarly = drift.scoreCacheLoadedBeforeReception === true ? loadScoreCache(paths, ports) : undefined;

  const verifiedFollowers = new VerifiedFollowersCache({ loreHouseUrl: boot.loreHouseUrl, fetch: houses.fetchHouse });
  const bondContext = makeBondContext({ bond: (id) => bondsStore.get(id), lastIncomingTs: (id, ts) => inboxStore.lastIncomingTs(id, ts) });
  // One target store: the push leg's target resolver and the bag hold this instance.
  const ownerNotifyTargetStore = new OwnerNotifyTargetStore(host.storage);
  // P3: the host's push leg, opened once. Pull delivery opens nothing, and
  // its three owner-push callers below get no push.
  const delivery = ports.delivery;
  const push = delivery.kind === 'push' && delivery.open
    ? delivery.open({ notifier, houses, paths, ownerNotifyTargetStore }) : undefined;
  const pushToOwner = push ? () => push.pushL1ToOwner() : undefined;

  const inviteNotify = inviteWiring(boot, ports, pendingInvites, notifier, pushToOwner);
  const { dmPolicy, onInbox } = buildDmConsumer({ boot, paths, ports, houses, inboxStore, notifier, socialGraph, bondsStore,
    verifiedFollowers, bootCadence, nameOf, bondContext, socialLog, onQueued: pushToOwner });

  const stateRepo = buildOnboardingState(host);
  // P4a/P4b: fire-and-forget — the boot never waits on a channel delivery.
  lifecycle.announceInstall?.({ paths, identityGenerated: boot.identityGenerated,
    onboardingCompleted: () => stateRepo.get(boot.popclawId)?.stage === 'completed' });
  lifecycle.checkIntegrity?.({ paths, houseStores });

  const collaborators = buildCollaborators({ host, boot, paths, ports, houses, egress });
  const { tasteLoader, guideClient, summaryClient, marksStore, markService, llmComplete } = collaborators;

  if (drift.followBackfillLate === true) backfillFollowsFromGraph(bondsStore, socialGraph, ports);

  // A resident root that follows but is never told it was followed is the
  // asymmetry hardest to notice, because nothing fails.
  const relationFollowerDeps = followerDeps({ host, boot, ports, houses, notifier, socialGraph, knownFollowers,
    readAuthorityFor, bondsStore, verifiedFollowers, socialLogRef, nameOf, bondContext });
  const followerSync = lifecycle.loops === 'host-services'
    ? buildHostServiceFollowerSync({ host, ports, houses, followerDeps: relationFollowerDeps, houseStores, worldFeedCache })
    : undefined;
  /**
   * The doorbell's pending rows, built here rather than inside the starter so
   * the runtime bag can carry it — unconditional, and before the gates: the
   * bag must hold it whether or not the loops ran (`popclaw_show_dream_review`
   * lists these rows and `popclaw_follow` graduates one to `confirmed`). The
   * host's L2 hook claims through this same instance.
   */
  const pendingFollows = new PendingFollowStore(host.db);
  lifecycle.expose?.pendingFollows(pendingFollows);
  const proposalsStore = new ProposalsStore(host.db);
  lifecycle.expose?.proposals(proposalsStore);
  // P5: one-shot legacy-file migrations.
  lifecycle.migrateLegacyFiles?.({ paths, marksStore });

  const { orchestrator } = buildOnboarding({ host, boot, paths, ports, houses, egress, notifier, collaborators,
    worldFeedCache, nameOf, mountedHouses, houseStarted, bondsStore, socialGraph, knownFollowers, socialLog, stateRepo });

  const relationReception = await openReception({ host, boot, ports, houses, readAuthorityFor, relationProducer,
    deps: relationFollowerDeps, houseStores, worldFeedCache });
  configureHouseResources({ host, boot, paths, ports, houses, executionStores, egress, houseStores, worldFeedCache,
    receptionHooks: relationReception.hooks,
    routeReplyPing: replyPingRoute({ boot, ports, replyPings, notifier, socialLog, bondContext, pushOnFirstReply: pushToOwner }),
    onInbox, rangerEnabled, inviteNotify, notifier });
  const loops = startHousesAndLoops({ host, boot, ports, houses, closing, dmPolicy, followerDeps: relationFollowerDeps,
    houseStores, worldFeedCache, notifier, socialGraph, pendingFollows });
  const guardedHostOps = drift.shutdown === 'guarded' ? lifecycle.guardedShutdown : undefined;
  const shutdown = guardedHostOps
    ? guardedShutdown({ host, platform: ports.platform, log: ports.log, hostOps: guardedHostOps,
      afterShutdown: () => lifecycle.afterShutdown?.(), lane, worlds, reception: relationReception, houses, houseStores, executionStores })
    : firstErrorAbortsShutdown({ host, ports, loops, lane, worlds, reception:relationReception, houses, houseStores, executionStores });

  if (drift.ownerLangSignalsLate) registerOwnerLangSignals(paths, ports);

  const bag = {
    shutdown,
    houseRuntime: houses,
        ...(ports.platform.receiveMode() === 'public-v1' ? { publicFeedDisplay: new PublicFeedDisplay({
          sources: () => houseStores.map(house => ({ origin: house.baseUrl, slug: house.slug, capture: () => houses.capturePublicDisplay(house) })),
        }) } : {}),
    worldRuntime: worlds,
    ...lane.slots,
    ...push?.slots,
    host,
    boot,
    egress,
    initiator,
    paths,
    worldFeedClient: worldFeedCache,
    worldFeedCache,
    tasteLoader,
    cadenceLoader,
    socialGraph,
    knownFollowers,
    pendingFollows,
    scoreCache: scoreCacheReadEarly ?? loadScoreCache(paths, ports),
    notifier,
    inboxStore,
    replyPings,
    pendingInvites,
    inviteWatch: {
      ...inviteNotify,
      fetch: houses.fetchHouse,
      loreHouseUrl: boot.loreHouseUrl,
      logger: ports.log.inviteWatch,
    } satisfies InviteWatchDeps,
    ownerNotifyTargetStore,
    uploadCanvas,
    orchestrator,
    // R1 spec §4: the house-gap closure used by the "settling-in" line and the
    // one the orchestrator recognizes are the same pair of closures.
    houses: mountedHouses,
    houseStarted,
    onboardingState: stateRepo,
    guideClient,
    summaryClient,
    marksStore,
    markService,
    bondsStore,
    nameOf,
    socialLog,
    proposalsStore,
    llmComplete,
    ...(followerSync ? { followerSync } : {}),
  };
  // The shared contract is checked here; the host slots and the follower
  // poll are typed by the ports that supplied them.
  return (bag satisfies PluginRuntime & { readonly notifier: SqliteNotifier; shutdown(): Promise<void> }) as AssembledRuntime<S, P, L>;
  } catch (error) {
    try {
      // The host's synchronous step runs first, before any await; if it
      // throws, cleanup stops there like any other failed cleanup step.
      lifecycle.beforeFailedBootCleanup?.();
      await fail.drain();
      for (const close of fail.closes.reverse()) close();
      ports.platform.releaseStorage();
      host.db.close();
    } catch (cleanupError) {
      // Retain participation when a failed drain cannot prove the root quiescent.
      throw new AggregateError([error, cleanupError], 'STORAGE_BOOT_CLEANUP_FAILED');
    }
    throw error;
  }
}
