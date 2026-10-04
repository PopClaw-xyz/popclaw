/**
 * Relations in the runtime assembly: the single name chain, the relation
 * producer and social graph, the follower deps, and relation reception.
 * Private to `runtime/assembly`; the public interface is `assembleRuntime`.
 */
import type { HostAdapter } from '../../host/host-adapter.js';
import type { PopclawPaths } from '../../host/popclaw-paths.js';
import { makeNameChain } from '../../identity/person-name.js';
import { makeRelationProducer } from '../../social-graph/relation-assembly.js';
import { SocialGraph } from '../../social-graph/social-graph.js';
import { KnownFollowersStore, announceVerifiedFollowers, type FollowerSyncDeps } from '../../social-graph/followers-sync.js';
import { openRelationReception } from '../../social-graph/relation-reception.js';
import { backfillFollows } from '../../bonds/backfill-follows.js';
import { hostDbSlug } from '../../ingress/host-slug.js';
import { houseOfficialHouseName } from '../../world/house-handshake.js';
import type { BondsStore } from '../../bonds/bonds-store.js';
import type { BondContext } from '../../bonds/bond-context.js';
import type { WorldFeedCatalog } from '../../ingress/world-feed-catalog.js';
import type { HouseStore } from '../../ingress/world-feed-store.js';
import type { HouseRuntime } from '../house-lifecycle/house-runtime.js';
import type { MultiHouseEgress } from '../../egress/multi-house-egress.js';
import type { SqliteNotifier } from '../../notifier/sqlite-notifier.js';
import type { SocialLogRecorder, SocialLogWriter } from '../../social-log/social-log.js';
import type { VerifiedFollowersCache } from '../../identity/verified-followers-cache.js';
import type { houseReadAuthority } from '../../identity/read-authority.js';
import type { Boot } from './core.js';
import type { AnyRuntimePorts } from './ports.js';

/**
 * **The single name chain**: alias > self-declared name > world-feed handle > ''.
 * Entirely local, zero network. Anywhere a popclaw_id becomes a name the owner
 * recognizes, it comes from here.
 */
export function buildNameChain(boot: Boot, paths: PopclawPaths, bondsStore: BondsStore, worldFeedCache: WorldFeedCatalog) {
  return makeNameChain({
    bond: (id) => bondsStore.get(id),
    handleFromFeed: (id) => worldFeedCache.byAuthor(id, 1)[0]?.handle,
    houseOfficialName: (id) => houseOfficialHouseName(id, paths, boot.loreHouseUrls),
  });
}

/**
 * The relation producer and the social graph, started. The follow backfill
 * (a real bonds write) runs right after the start unless this root runs it
 * later (`DriftPins.followBackfillLate`; then `backfillFollowsFromGraph` is
 * called at that later point instead).
 */
export async function buildSocialGraph(input: {
  host: HostAdapter; boot: Boot; ports: AnyRuntimePorts; egress: MultiHouseEgress;
  worldFeedCache: WorldFeedCatalog; bondsStore: BondsStore;
}) {
  const { host, boot, ports, egress, worldFeedCache, bondsStore } = input;
  // Held by name so the drain tick can run its resend sweep: it re-sends
  // ORIGINALS whose push never landed — same stored bytes, same sequence
  // number, no re-signing.
  const relationProducer = makeRelationProducer({
    db: host.db,
    signer: boot.signer,
    get houses() { return boot.loreHouseUrls.map((u) => ({ slug: hostDbSlug(u), origin: u })); },
    pushTo: (slug, bytes) => egress.pushTo(slug, bytes),
    logger: {
      info: ports.log.info,
      warn: ports.log.warn,
    },
  });
  const socialGraph = new SocialGraph({
    db: host.db,
    signer: boot.signer,
    // The ONE thing that can write a relation, from the same factory every root uses.
    relationProducer,
    egressPush: async (bytes, houseSlug) => {
      await egress.pushTo(houseSlug, bytes);
    },
    houseOf: (id) => worldFeedCache.byAuthor(id, 1)[0]?.houseSlug,
    primaryHouse: egress.slugs()[0],
    logger: { info: ports.log.info, warn: ports.log.warn, error: ports.log.error },
  });
  await socialGraph.start();
  // Only a root that writes this report reads the following list for it.
  const report = ports.log.bootReport;
  if (report) report(`social-graph loaded — following ${socialGraph.following().length}`);
  if (!ports.drift.followBackfillLate) backfillFollowsFromGraph(bondsStore, socialGraph, ports);
  return { relationProducer, socialGraph };
}

/**
 * One-shot: every currently-followed popclaw_id gets a bond row with
 * followed=true. Needs the started graph (`following()` materialized).
 * Guarded: a backfill failure must not brick boot — it simply retries next
 * start (idempotent).
 */
export function backfillFollowsFromGraph(bondsStore: BondsStore, socialGraph: SocialGraph, ports: AnyRuntimePorts): void {
  try {
    backfillFollows(bondsStore, socialGraph.following().map((f) => f.popclawId));
  } catch (err) {
    ports.log.bootMigration(`bonds follow-backfill failed (will retry next boot): ${String(err)}`);
  }
}

/**
 * The deps both follower paths (the poll and relation reception) announce
 * through. The bridge writes the follower row with `announced_at` NULL and
 * announces nothing inside the apply transaction; whichever root holds a
 * notifier sweeps the unannounced rows afterwards.
 */
export function followerDeps(input: {
  host: HostAdapter; boot: Boot; ports: AnyRuntimePorts; houses: HouseRuntime; notifier: SqliteNotifier;
  socialGraph: SocialGraph; knownFollowers: KnownFollowersStore; readAuthorityFor: (origin: string) => ReturnType<typeof houseReadAuthority>;
  bondsStore: BondsStore; verifiedFollowers: VerifiedFollowersCache; socialLogRef: { current?: SocialLogWriter };
  nameOf: (id: string) => string; bondContext: BondContext;
}): FollowerSyncDeps {
  const { host, boot, ports, houses, notifier, socialGraph, readAuthorityFor, bondsStore, verifiedFollowers, socialLogRef } = input;
  const drift = ports.drift;
  return {
    ownerPopclawId: boot.popclawId,
    store: drift.followerStoreOwnInstance ? new KnownFollowersStore(host.db) : input.knownFollowers,
    notifier,
    socialGraph,
    fetch: houses.fetchHouse,
    readAuthorityFor: (house) => readAuthorityFor(house.baseUrl),
    // Supplied deliberately, not because the type demands it: without it a
    // person the owner has BLOCKED would ring the bell on one root while
    // staying silent on the other — the same install behaving two ways.
    bondOf: (id) => bondsStore.get(id),
    verifiedFollowers,
    ...(socialLogRef.current ? { socialLog: socialLogRef.current as SocialLogRecorder } : {}),
    ...(drift.followerDisplayNameAbsent ? {} : { displayName: input.nameOf }),
    ...(drift.followerBondContextAbsent ? {} : { bondContext: input.bondContext }),
    logger: ports.log.relation,
  };
}

export async function openReception(input: {
  host: HostAdapter; boot: Boot; ports: AnyRuntimePorts; houses: HouseRuntime;
  readAuthorityFor: (origin: string) => ReturnType<typeof houseReadAuthority>;
  relationProducer: ReturnType<typeof makeRelationProducer>; deps: FollowerSyncDeps; houseStores: HouseStore[];
  worldFeedCache: WorldFeedCatalog;
}) {
  const { host, boot, ports, houses, readAuthorityFor, relationProducer, deps, houseStores, worldFeedCache } = input;
  // Which list maps a follower's house slug to its origin (DriftPins.receptionHouseLookupFromCatalog).
  const lookupHouses: () => ReadonlyArray<{ slug: string; baseUrl: string }> = ports.drift.receptionHouseLookupFromCatalog
    ? () => worldFeedCache.houses() : () => houseStores;
  return openRelationReception({
    db: host.db,
    signer: boot.signer,
    recipientPopclawId: boot.popclawId,
    // Every read at a house proves who is asking with that house's own
    // declared scheme, or does not go out at all.
    readAuthorityFor,
    fetch: houses.fetchHouse,
    resendRelations: (stillValid) => relationProducer.resendPending({ stillValid }),
    onMessage: () => {},
    notifyNewFollowers: (news) => announceVerifiedFollowers(
      deps, news,
      (slug: string) => lookupHouses().find((h) => h.slug === slug)?.baseUrl,
    ),
    log: ports.log.relation,
  });
}
