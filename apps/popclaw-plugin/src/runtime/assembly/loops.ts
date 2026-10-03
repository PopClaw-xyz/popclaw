/**
 * House start, DM recovery and the four resident loops. With
 * `LifecyclePort.loops === 'inline'` the assembly starts the loops itself,
 * behind the closing and storage gates; with `'host-services'` the host's own
 * services start and stop them, and the assembly only builds the follower
 * poll (unstarted) for the bag. Which root starts which loop is
 * `runtime/resident-services.ts`; every starter call on either path is in
 * this file.
 * Private to `runtime/assembly`; the public interface is `assembleRuntime`.
 */
import type { HostAdapter } from '../../host/host-adapter.js';
import type { HouseRuntime } from '../house-lifecycle/house-runtime.js';
import { startDefaultHousePinning, type DefaultHousePinningLoop } from '../../social-graph/default-house-pinning.js';
import { createFollowerSync, type FollowerSyncService } from '../../social-graph/follower-sync-service.js';
import { startFollowDoorbell, type FollowDoorbellLoop } from '../../newspaper/follow-doorbell-service.js';
import { startPageStateSync, type PageStateSyncLoop } from '../../canvas/sync-answer-client.js';
import { notifierForOrigin } from '../house-lifecycle/notification-scope.js';
import type { PendingFollowStore } from '../../social-graph/pending-follow-store.js';
import type { FollowerSyncDeps } from '../../social-graph/followers-sync.js';
import type { HouseStore } from '../../ingress/world-feed-store.js';
import type { WorldFeedCatalog } from '../../ingress/world-feed-catalog.js';
import type { SqliteNotifier } from '../../notifier/sqlite-notifier.js';
import type { SocialGraph } from '../../social-graph/social-graph.js';
import type { makeDmNotificationPolicy } from '../dm-notification-policy.js';
import { assertPullDelivery, type Boot } from './core.js';
import type { AnyRuntimePorts } from './ports.js';

export interface InlineLoops {
  housePinning?: DefaultHousePinningLoop;
  followerSync?: FollowerSyncService;
  doorbell?: FollowDoorbellLoop;
  pageState?: PageStateSyncLoop;
}

interface FollowerSyncInput {
  host: HostAdapter; ports: AnyRuntimePorts; houses: HouseRuntime; followerDeps: FollowerSyncDeps;
  houseStores: HouseStore[]; worldFeedCache: WorldFeedCatalog;
}

/**
 * The follower poll — the only writer of the baseline every announcement
 * joins on. Built, not started. Its `houses()` lists the house stores, or the
 * catalog's houses (`DriftPins.followerPollHousesFromCatalog`).
 */
function followerSyncFor(input: FollowerSyncInput): FollowerSyncService {
  const { host, ports, houses, houseStores, worldFeedCache } = input;
  return createFollowerSync({
    db: host.db, deps: input.followerDeps,
    houses: ports.drift.followerPollHousesFromCatalog
      ? () => worldFeedCache.houses().map((h) => ({ slug: h.slug, baseUrl: h.baseUrl }))
      : () => houseStores.map((h) => ({ slug: h.slug, baseUrl: h.baseUrl })),
    runCommand: (work) => houses.runCommand(work),
    captureGate: (origin) => houses.captureGate(origin),
  });
}

/**
 * `host-services`: the follower poll the bag carries for the host's service
 * to start. Built unconditionally, where the root built it (after the
 * follower deps, before the pending-follow store).
 */
export function buildHostServiceFollowerSync(input: FollowerSyncInput): FollowerSyncService {
  return followerSyncFor(input);
}

/**
 * Start the houses (unless the root is already closing) and schedule DM
 * recovery (when storage allows consumers; the closing gate applies too
 * unless `DriftPins.recoveryIgnoresClosing`). With `inline` loops, and behind
 * the same two gates, start the four loops: a root that is already closing,
 * or whose storage is held for recovery, does no network work at all — the
 * next boot is the next chance. Nothing here is awaited: tools answer before
 * any house has replied.
 */
export function startHousesAndLoops(input: {
  host: HostAdapter; boot: Boot; ports: AnyRuntimePorts; houses: HouseRuntime; closing: AbortSignal;
  dmPolicy: ReturnType<typeof makeDmNotificationPolicy>; followerDeps: FollowerSyncDeps; houseStores: HouseStore[];
  worldFeedCache: WorldFeedCatalog; notifier: SqliteNotifier; socialGraph: SocialGraph; pendingFollows: PendingFollowStore;
}): InlineLoops {
  const { host, boot, ports, houses, closing, dmPolicy, notifier, socialGraph, pendingFollows } = input;
  const loops: InlineLoops = {};
  const recoverDms = () => {
    void houses.runCommand(() => dmPolicy.recover()).catch(error => ports.log.warn(`DM recovery: ${String(error)}`));
  };
  const startInlineLoops = (): void => {
    loops.housePinning = startDefaultHousePinning({
      db: host.db, recipientPopclawId: boot.popclawId, origins: boot.loreHouseUrls, warn: ports.log.warn,
      pinning: houses.configuredHousePinning, onParticipationChanged: () => houses.participationChanged(),
    });
    // The only writer of the baseline every announcement joins on.
    loops.followerSync = followerSyncFor(input);
    void loops.followerSync.start();
    // The follow doorbell. Pull delivery has no `deliverNow`: the loop
    // absorbs, enqueues the L2 pointer, and never claims a batch it could
    // not read out — see `DoorbellDeps.deliverNow`. The notifier is
    // house-attributed, or the L2 would be eligible for delivery nowhere
    // and counted by nobody.
    assertPullDelivery(ports, 'doorbell deliverNow');
    loops.doorbell = startFollowDoorbell({
      db: host.db,
      ownerPopclawId: boot.popclawId,
      canvasBaseUrl: boot.canvasBaseUrl,
      signer: boot.signer,
      followsIn: (id) => socialGraph.follows(id),
      notifier: notifierForOrigin(notifier, boot.loreHouseUrl),
      runCommand: (work) => houses.runCommand(work),
      captureGate: (origin) => houses.captureGate(origin),
      houseOrigin: boot.loreHouseUrl,
      observeParticipation: changed => houses.observeParticipation(boot.loreHouseUrl, changed),
      // The same instance the bag carries: the tools that list and confirm
      // these rows must be looking at the rows this loop writes.
      store: pendingFollows,
      logger: { info: ports.log.info, warn: ports.log.warn },
    });
    // And the answer half of the same round trip.
    loops.pageState = startPageStateSync({
      baseUrl: boot.canvasBaseUrl,
      signer: boot.signer,
      stateOf: (id) => (socialGraph.follows(id) ? 'follows' : 'none'),
      logger: { info: ports.log.info },
    });
  };
  const inline = ports.lifecycle.loops === 'inline';
  if (!closing.aborted) houses.start();
  if (ports.drift.recoveryIgnoresClosing) {
    // #7: recovery behind the storage gate only, even when closing fired mid-boot.
    if (houses.storageAllows('consumers')) recoverDms();
    if (inline && !closing.aborted && houses.storageAllows('consumers')) startInlineLoops();
  } else if (!closing.aborted && houses.storageAllows('consumers')) {
    recoverDms();
    if (inline) startInlineLoops();
  }
  return loops;
}
