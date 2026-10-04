/**
 * Onboarding in the runtime assembly: mounted houses, the "already started"
 * test, the world/taste/mark collaborators the orchestrator and the tools
 * share, and the orchestrator itself.
 * Private to `runtime/assembly`; the public interface is `assembleRuntime`.
 */
import type { HostAdapter } from '../../host/host-adapter.js';
import type { PopclawPaths } from '../../host/popclaw-paths.js';
import { hostDbSlug } from '../../ingress/host-slug.js';
import { mountedHouseGuides, readHouseHandshake, readHouseEntry } from '../../world/house-handshake.js';
import { TasteLoader } from '../../taste/taste-loader.js';
import { GuideClient } from '../../world/guide-client.js';
import { WorldSummaryClient } from '../../world/world-summary-client.js';
import { MarksStore } from '../../marks/marks-store.js';
import { MarkService } from '../../marks/mark-service.js';
import { OnboardingStateRepository } from '../../onboarding/state-repository.js';
import { OnboardingStateMachine } from '../../onboarding/state-machine.js';
import { OnboardingOrchestrator, type MountedHouse } from '../../onboarding/orchestrator.js';
import { readOwnerPersonaFromEnv, fetchVerifiedHandles } from '../../onboarding/owner-sources.js';
import { SessionContextIndex } from '../../onboarding/context-index.js';
import { appendPick } from '../../taste/learned-writer.js';
import { uploadCanvas } from '../../egress/canvas-egress.js';
import { errandFollowFrom } from '../../commands/follow.js';
import type { InboxStore } from '../../messaging/inbox-store.js';
import type { HouseRuntime } from '../house-lifecycle/house-runtime.js';
import type { MultiHouseEgress } from '../../egress/multi-house-egress.js';
import type { SqliteNotifier } from '../../notifier/sqlite-notifier.js';
import type { BondsStore } from '../../bonds/bonds-store.js';
import type { SocialGraph } from '../../social-graph/social-graph.js';
import type { KnownFollowersStore } from '../../social-graph/followers-sync.js';
import type { WorldFeedCatalog } from '../../ingress/world-feed-catalog.js';
import type { SocialLogRecorder } from '../../social-log/social-log.js';
import type { NameChain } from '../../identity/person-name.js';
import type { Boot } from './core.js';
import type { AnyRuntimePorts } from './ports.js';

export function mountedHousesOf(boot: Boot, paths: PopclawPaths, inboxStore: InboxStore, houses?: HouseRuntime) {
  /** Mounted houses — name from the handshake billboard, guide from what the
   *  house itself publishes. */
  const mountedHouses = (): MountedHouse[] => {
    const guides = new Map(
      mountedHouseGuides(paths, boot.loreHouseUrls).map((g) => [g.slug, g.guide]),
    );
    return (houses ? houses.commands.knownHouseOrigins().filter(url => houses.publicReadGate(url).isActive()) : boot.loreHouseUrls).map((url) => {
      const slug = hostDbSlug(url);
      const guide = guides.get(slug);
      const entry = readHouseEntry(paths, slug, url);
      return {
        slug,
        name: readHouseHandshake(paths, slug)?.house_name || slug,
        ...(guide ? { guide } : {}),
        ...(entry ? { entry } : {}),
      };
    });
  };
  /** The "already started" test (R1 spec §3): this house's official name has
   *  written to the owner. */
  const houseStarted = (slug: string): boolean =>
    inboxStore.hasIncomingFrom(slug, readHouseHandshake(paths, slug)?.official_ids ?? []);
  return { mountedHouses, houseStarted };
}

export function buildCollaborators(input: {
  host: HostAdapter; boot: Boot; paths: PopclawPaths; ports: AnyRuntimePorts; houses: HouseRuntime; egress: MultiHouseEgress;
}) {
  const { host, boot, paths, ports, houses, egress } = input;
  const tasteRoot = paths.tasteDir();
  const tasteLoader = new TasteLoader({ tasteDir: tasteRoot, logger: { warn: ports.log.warn } });
  const guideClient = new GuideClient({ baseUrl: boot.loreHouseUrl, fetch: ports.world.clientFetch(houses, boot.loreHouseUrl) });
  const summaryClient = new WorldSummaryClient({ baseUrl: boot.loreHouseUrl, fetch: ports.world.clientFetch(houses, boot.loreHouseUrl) });
  const marksStore = new MarksStore(host.db);
  const markService = new MarkService({
    store: marksStore,
    signer: boot.signer,
    egress,
    get nickname() { return boot.nickname; },
    taste: { tasteRoot },
  });
  const llmComplete = ports.agent.llm(paths);
  return { tasteRoot, tasteLoader, guideClient, summaryClient, marksStore, markService, llmComplete };
}

export function buildOnboarding(input: {
  host: HostAdapter; boot: Boot; paths: PopclawPaths; ports: AnyRuntimePorts; houses: HouseRuntime; egress: MultiHouseEgress;
  notifier: SqliteNotifier; collaborators: ReturnType<typeof buildCollaborators>; worldFeedCache: WorldFeedCatalog;
  nameOf: NameChain; mountedHouses: () => MountedHouse[]; houseStarted: (slug: string) => boolean;
  bondsStore: BondsStore; socialGraph: SocialGraph; knownFollowers: KnownFollowersStore; socialLog: SocialLogRecorder;
  stateRepo: OnboardingStateRepository;
}) {
  const { host, boot, paths, ports, houses, egress, notifier, worldFeedCache, nameOf } = input;
  const { tasteRoot, tasteLoader, guideClient, summaryClient, markService, llmComplete } = input.collaborators;
  // Onboarding: same orchestrator on every root; the presenter is the host's.
  const { stateRepo } = input;
  const presenter = ports.agent.presenter;
  const orchestrator = new OnboardingOrchestrator({
    stateMachine: new OnboardingStateMachine(stateRepo),
    notifier,
    presenter,
    identity: { popclawId: boot.popclawId },
    host,
    signer: boot.signer,
    egress,
    houseOrigins: boot.loreHouseUrls,
    fetch: houses.fetchHouse,
    llm: { complete: llmComplete },
    tasteRoot,
    readOwnerPersona: () => readOwnerPersonaFromEnv(),
    fetchVerifiedHandles: () =>
      fetchVerifiedHandles({ loreHouseUrl: boot.loreHouseUrl, popclawId: boot.popclawId, fetchImpl: houses.fetchHouse }),
    guideClient,
    summaryClient,
    snapshotClient: worldFeedCache,
    tasteLoader,
    learnedWriter: { appendPick: (p) => appendPick({ tasteRoot }, p) },
    markService,
    contextIndex: new SessionContextIndex(),
    nameOf,
    webBaseUrl: boot.webBaseUrl,
    houses: input.mountedHouses,
    houseStarted: input.houseStarted,
    // Canvas: the passport page / the world-at-a-glance. Upload never throws; a
    // failed one costs the link line and nothing else (spec §3).
    canvas: {
      uploadCanvas,
      canvasBaseUrl: boot.canvasBaseUrl,
      signer: boot.signer,
      get nickname() { return boot.nickname; },
      logger: ports.log.onboardingCanvas,
    },
    // The errand act's person-resolution + follow — the same commands/follow.ts
    // chain every root uses.
    followPerson: errandFollowFrom({
      bondsStore: input.bondsStore,
      socialGraph: input.socialGraph,
      knownFollowers: input.knownFollowers,
      worldFeedCache,
      socialLog: input.socialLog,
      nameOf,
      loreHouseUrl: boot.loreHouseUrl,
      ownPopclawId: boot.popclawId,
      fetch: houses.fetchHouse,
      paths,
      loreHouseUrls: boot.loreHouseUrls,
    }),
  });
  return { orchestrator };
}

/**
 * The onboarding state repository, built on its own: the install notice
 * (`LifecyclePort.announceInstall`) reads it before the orchestrator exists.
 */
export function buildOnboardingState(host: HostAdapter): OnboardingStateRepository {
  return new OnboardingStateRepository(host.db);
}
