/**
 * Direct messages in the runtime assembly: the notification policy and the
 * ONE `makeInboxOnMessage` call site (tests/unit/messaging/dm-handler-parity).
 * Private to `runtime/assembly`; the public interface is `assembleRuntime`.
 */
import { makeDmNotificationPolicy } from '../dm-notification-policy.js';
import { makeInboxOnMessage } from '../inbox-consumer.js';
import { personVerdict } from '../../butler/person-verdict.js';
import { deriveSigil } from '../../invite/sigil.js';
import { readHouseHandshake } from '../../world/house-handshake.js';
import { defaultCadence } from '../../cadence/cadence-loader.js';
import type { PopclawPaths } from '../../host/popclaw-paths.js';
import type { HouseRuntime } from '../house-lifecycle/house-runtime.js';
import type { InboxStore } from '../../messaging/inbox-store.js';
import type { SqliteNotifier } from '../../notifier/sqlite-notifier.js';
import type { SocialGraph } from '../../social-graph/social-graph.js';
import type { BondsStore } from '../../bonds/bonds-store.js';
import type { BondContext } from '../../bonds/bond-context.js';
import type { VerifiedFollowersCache } from '../../identity/verified-followers-cache.js';
import type { NameChain } from '../../identity/person-name.js';
import type { SocialLogRecorder } from '../../social-log/social-log.js';
import type { CadenceLoader } from '../../cadence/cadence-loader.js';
import type { Boot } from './core.js';
import type { AnyRuntimePorts } from './ports.js';

export type InboxConsumer = ReturnType<typeof makeInboxOnMessage>;

export function buildDmConsumer(input: {
  boot: Boot; paths: PopclawPaths; ports: AnyRuntimePorts; houses: HouseRuntime; inboxStore: InboxStore;
  notifier: SqliteNotifier; socialGraph: SocialGraph; bondsStore: BondsStore; verifiedFollowers: VerifiedFollowersCache;
  bootCadence: Awaited<ReturnType<CadenceLoader['load']>> | null; nameOf: NameChain; bondContext: BondContext;
  socialLog: SocialLogRecorder;
  /** The push leg's delivery (push delivery): a DM the policy queues is pushed to the owner. Absent on a pull root. */
  onQueued: (() => void) | undefined;
}) {
  const { boot, paths, ports, houses, inboxStore, notifier, socialGraph, bondsStore, verifiedFollowers, bootCadence, nameOf } = input;
  const dmPolicy = makeDmNotificationPolicy({
    gateForHouse: slug => houses.gateForSlug(slug),
    inbox: inboxStore, notifier, graph: socialGraph,
    verdictOf: (id, slug) => personVerdict(id, {
      bondOf: (who) => bondsStore.get(who), verifiedFollowersOf: (who) => verifiedFollowers.getFresh(who, slug ? houses.originForSlug(slug) : undefined),
    }),
    isOfficial: (id, slug) => houses.gateForSlug(slug).isActive() && (readHouseHandshake(paths, slug)?.official_ids.includes(id) ?? false),
    vipThreshold: bootCadence?.notifications.vipExternalFollowerThreshold ?? defaultCadence().notifications.vipExternalFollowerThreshold,
    refresh: (id, slug) => verifiedFollowers.refresh(id, slug ? houses.originForSlug(slug) : undefined), nameOf,
    bondContext: input.bondContext,
    // Pull delivery: a queued DM is not pushed (no `onQueued` key at all).
    ...(input.onQueued ? { onQueued: input.onQueued } : {}),
    warn: ports.log.dmPolicy,
  });
  const onInbox = makeInboxOnMessage({
      signer: boot.signer,
      inboxStore,
      socialLog: input.socialLog,
      dmMediaDir: () => paths.dmMediaDir(),
      // The saved filename carries the name (so the owner recognizes it) with
      // the sigil as the fallback.
      mediaNaming: { sigilOf: deriveSigil, nameOf: (id) => nameOf(id) },
      info: ports.log.plain.info,
      warn: ports.log.plain.warn,
      onPlainDm: ({ item }) => dmPolicy.handle(item),
    });
  return { dmPolicy, onInbox };
}
