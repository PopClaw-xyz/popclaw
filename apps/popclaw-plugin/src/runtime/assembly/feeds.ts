/**
 * Feeds of the runtime assembly: the per-house world-stream stores, the
 * cross-house catalog, and the house lifecycle's resource wiring (streams,
 * reply pings, inbox hand-off, Ranger, handshake refresh).
 * Private to `runtime/assembly`; the public interface is `assembleRuntime`.
 */
import type { HostAdapter } from '../../host/host-adapter.js';
import type { PopclawPaths } from '../../host/popclaw-paths.js';
import type { ExecutionStoreCatalog } from '../../host/execution-store.js';
import type { HouseRuntime } from '../house-lifecycle/house-runtime.js';
import type { HouseGate } from '../house-lifecycle/manager.js';
import type { EventIngress } from '../../ingress/event-ingress.js';
import { openHouseStores, openWorldFeedStore, type HouseStore } from '../../ingress/world-feed-store.js';
import { WorldFeedClient } from '../../ingress/world-feed-client.js';
import { WorldFeedCatalog } from '../../ingress/world-feed-catalog.js';
import { Ranger } from '../ranger.js';
import { ServerPushEgress } from '../../egress/server-push-egress.js';
import { refreshHouseHandshake, readHouseHandshake } from '../../world/house-handshake.js';
import { loadMyNamecard, signMyNamecard } from '../../messaging/my-namecard.js';
import { announceNamecardToHouses } from '../../messaging/announce-namecard.js';
import { notifierForOrigin } from '../house-lifecycle/notification-scope.js';
import type { InviteNotifyWiring } from '../../invite/pending-invites.js';
import type { SqliteNotifier } from '../../notifier/sqlite-notifier.js';
import type { MultiHouseEgress } from '../../egress/multi-house-egress.js';
import type { InboxConsumer } from './dm.js';
import type { ReplyPingRoute } from './notifications.js';
import type { Boot, FailedBoot } from './core.js';
import type { AnyRuntimePorts } from './ports.js';

/**
 * Per-house world-stream cache (P-005 / ADR-0024) + live SSE subscription:
 * the feed/search/dream/newspaper tools all read THIS cache, never the wire.
 *
 * Deliberately not an async helper: the caller awaits `openHouseStores`
 * itself, so the stores' close registration, the L2 notifier slot, the
 * catalog and the name chain all run in the continuation of that one await
 * — no helper return continuation in between (ruling 2026-09-29 14:14 ①).
 */
export function openStores(boot: Boot, paths: PopclawPaths, ports: AnyRuntimePorts,
  executionStores: ExecutionStoreCatalog): Promise<HouseStore[]> {
  return openHouseStores(boot.loreHouseUrls, paths, {executionStores,
    debug: ports.log.info,
    onError: (url, err) => ports.log.error(`world-feed store open failed for ${url} — ${String(err)}`),
  });
}

export function registerStoreCloses(houseStores: HouseStore[], fail: FailedBoot): void {
  fail.closes.push(() => { for (const house of houseStores) house.db.close(); });
}

/** The cross-house merged view every reader recognizes (one object, both names on the bag). */
export function buildCatalog(paths: PopclawPaths, houses: HouseRuntime, ports: AnyRuntimePorts,
  houseStores: HouseStore[]): WorldFeedCatalog {
  return new WorldFeedCatalog(
    houseStores.map((h) => ({ ...h, snapshot: new WorldFeedClient({ baseUrl: h.baseUrl, fetch: ports.world.snapshotFetch(houses, h.baseUrl), isOfficialActor: id => readHouseHandshake(paths, h.slug)?.official_ids.includes(id) ?? false }) })),
    { warn: ports.log.warn },
  );
}

/** The per-house "cache subscribed" report line, on roots that write it (`LogPort.bootReport`). */
export function reportSubscribedCaches(ports: AnyRuntimePorts, houseStores: HouseStore[]): void {
  const report = ports.log.bootReport;
  if (!report) return;
  for (const h of houseStores) report(`world-feed cache subscribed [${h.slug}]; cache_db=${h.dbPath}`);
}

export function configureHouseResources(input: {
  host: HostAdapter; boot: Boot; paths: PopclawPaths; ports: AnyRuntimePorts; houses: HouseRuntime;
  executionStores: ExecutionStoreCatalog; egress: MultiHouseEgress; houseStores: HouseStore[];
  worldFeedCache: WorldFeedCatalog; worldStreamMode: boolean;
  receptionHooks: Partial<Parameters<HouseRuntime['configureResources']>[0]>;
  routeReplyPing: ReplyPingRoute; onInbox: InboxConsumer;
  rangerEnabled: boolean; inviteNotify: InviteNotifyWiring; notifier: SqliteNotifier;
}): void {
  const { host, boot, paths, ports, houses, executionStores, egress, houseStores, worldFeedCache, notifier, inviteNotify } = input;
  const { onInbox } = input;
  houses.configureResources({host, recipientPopclawId: boot.popclawId, worldStreamMode: input.worldStreamMode,
    ...input.receptionHooks,
    stores: houseStores, openStore: origin => openWorldFeedStore(origin, paths, ports.log.lateStoreOpen, executionStores),
    onStore: house => {
      houseStores.push(house);
      worldFeedCache.mount({...house, snapshot: new WorldFeedClient({baseUrl: house.baseUrl, fetch: ports.world.snapshotFetch(houses, house.baseUrl), isOfficialActor: id => readHouseHandshake(paths, house.slug)?.official_ids.includes(id) ?? false})});
    },
    isOfficialActor: (house, id) => readHouseHandshake(paths, house.slug)?.official_ids.includes(id) ?? false,
    onContent: (house, item) => input.routeReplyPing(house, item),
    onInbox: (house, _gate, dm, bytes, nickname, authenticatedPlain) => onInbox(dm, house.slug, bytes, nickname, authenticatedPlain),
    ...(input.rangerEnabled ? {createRanger: (house: HouseStore, gate: HouseGate, ingress: EventIngress) =>
      new Ranger({host, config: boot.config, signer: boot.signer, nickname: boot.nickname,
        houseOrigin: house.baseUrl, gate, ingress,
        ...(ports.drift.rangerInviteNotifyAbsent ? {} : { inviteNotify: { get current() {
          return {...inviteNotify, notifier: notifierForOrigin(notifier, house.baseUrl)};
        } } }),
        egress: new ServerPushEgress({baseUrl: house.baseUrl, gate})})} : {}),
    ...(ports.drift.refreshMs !== undefined ? { refreshMs: ports.drift.refreshMs } : {}),
    refresh: async (house, gate) => {
      const hsLog = ports.log.handshake;
      await refreshHouseHandshake(house.baseUrl, {paths, logger: hsLog, fetch: houses.houseFetch(house.baseUrl, gate),
        guideFetch: houses.documentFetch(house.baseUrl, gate)});
      if (!gate.isActive()) return;
      const card = await loadMyNamecard({host, now: () => Math.floor(Date.now() / 1000)});
      if (!card || !gate.isActive()) return;
      const signed = await signMyNamecard(boot.signer, card);
      if (!gate.isActive()) return;
      await announceNamecardToHouses([house.baseUrl], {card, signedBytes: signed.signedPayloadBytes,
        popclawId: boot.popclawId, pushTo: (slug, bytes) => egress.pushTo(slug, bytes), logger: hsLog, fetch: houses.houseFetch(house.baseUrl, gate)});
    },
    log: ports.log.warn,
  });
}
