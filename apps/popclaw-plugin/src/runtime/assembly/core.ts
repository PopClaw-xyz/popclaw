/**
 * Core of the runtime assembly: identity, storage, the house lifecycle and
 * world runtime, the shared stores, the owner's cadence, and the teardown.
 * Private to `runtime/assembly`; the public interface is `assembleRuntime`.
 */
import type { HostAdapter } from '../../host/host-adapter.js';
import type { PopclawPaths } from '../../host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../host/execution-store.js';
import { bootstrapPlugin, extendBoot } from '../plugin-bootstrap.js';
import { actionSigner } from '../house-lifecycle/action-context.js';
import { HouseRuntime } from '../house-lifecycle/house-runtime.js';
import { WorldRuntime } from '../world-runtime.js';
import { readHouseCapabilityView } from '../../world/world-capabilities.js';
import { houseReadAuthority } from '../../identity/read-authority.js';
import { EventBuilder } from '../../event/event-builder.js';
import { InviteInitiator } from '../../invite/invite-initiator.js';
import { BondsStore } from '../../bonds/bonds-store.js';
import { KnownFollowersStore } from '../../social-graph/followers-sync.js';
import { SocialLogWriter, type SocialLogRecorder } from '../../social-log/social-log.js';
import { CadenceLoader } from '../../cadence/cadence-loader.js';
import { setOwnerTz } from '../../time/time-context.js';
import { setOwnerLang, useOwnerLangSignals } from '../../lexicon/owner-language.js';
import type { HouseStore } from '../../ingress/world-feed-store.js';
import type { AnyRuntimePorts, GuardedShutdownHostOps, LogPort, LoopsMode, PlatformPort, RuntimePorts, WorldLane } from './ports.js';
import type { InlineLoops } from './loops.js';

/**
 * A pull-only choice with no push branch — today only the inline doorbell's
 * missing `deliverNow` — calls this where it is made, so a push leg can never
 * silently inherit it. (Push with inline loops is refused up front by
 * `assertAssembled`; the push-aware sites key on `delivery.kind` instead.)
 */
export function assertPullDelivery(ports: AnyRuntimePorts, where: string): void {
  if (ports.delivery.kind !== 'pull') throw new Error(`RUNTIME_ASSEMBLY_UNWIRED: delivery.kind (${where})`);
}

/** What a boot that fails part-way has to undo, filled in as resources come up. */
export interface FailedBoot {
  drain: () => Promise<void>;
  readonly closes: Array<() => void>;
}

export type Boot = Awaited<ReturnType<typeof bootIdentity>>['boot'];

export async function bootIdentity(host: HostAdapter, ports: AnyRuntimePorts, fail: FailedBoot) {
  const rawBoot = await bootstrapPlugin(host, ports.platform.defaultStateDir());
  const executionStores = new ExecutionStoreCatalog({db: host.db, paths: ports.platform.storagePaths, actorId: rawBoot.popclawId});
  fail.closes.push(() => executionStores.close());
  const boot = extendBoot(rawBoot, {signer: actionSigner(rawBoot.signer)});
  // A freshly minted identity must never look like a normal restore; the
  // root's identity lane says which (info, never warn: see keystore.ts).
  ports.log.identity(boot);
  return { executionStores, boot };
}

export function buildHouses<S extends object>(host: HostAdapter, boot: Boot, ports: RuntimePorts<S, object, LoopsMode>,
  executionStores: ExecutionStoreCatalog, fail: FailedBoot) {
  // One read authority for this root: the inbox lane, the follower catch-up
  // and the relation chain all ask the same question the same way.
  const readAuthorityFor = (origin: string) => houseReadAuthority(
    { db: host.db, signer: boot.signer },
    origin,
  );
  const houses = new HouseRuntime({db: host.db, signer: boot.signer, origins: boot.loreHouseUrls, log: ports.log.warn,
    readAuthorityFor, participation: ports.participation, actorId: boot.popclawId,
    onJoined: async origin => {
      const raw = await host.config.loadJson('plugin') as Record<string,unknown> | null;
      const configured = raw && Array.isArray(raw.lore_houses) ? raw.lore_houses as string[] : boot.loreHouseUrls.slice();
      const joined = host.db.queryAll<{house_origin:string}>("SELECT house_origin FROM house_participation WHERE desired='enabled' AND phase='connected' ORDER BY house_origin").map(row => row.house_origin);
      const urls = [...new Set([...configured,origin,...joined])];
      await host.config.saveJson('plugin',{...raw,lore_houses:urls});
      const live = boot.loreHouseUrls as string[];
      for (const url of urls) if (!live.includes(url)) live.push(url);
    },
    publicV1Mode: ports.platform.publicWorldStream(), executionStores});
  fail.drain = () => houses.stop();
  // The owner lane. Its duplicate lookup reads `worlds` lazily — only while a
  // dialog is being built, long after the next statement constructed it.
  const lane: WorldLane<S> = ports.world.lane({ actorId: boot.popclawId,
    worlds: { unresolvedOwnerRequests: (actor, input) => worlds.unresolvedOwnerRequests(actor, input) } });
  const worlds = new WorldRuntime({mode: 'commands', houses, signer: boot.signer, actorId: boot.popclawId,
    ...(lane.nativeAuthorization ? { nativeAuthorization: lane.nativeAuthorization } : {}),
    ownerAuthorization: lane.ownerAuthorization, readCapabilities: origin => readHouseCapabilityView(host.db, origin)});
  fail.drain = async () => { lane.stop(); worlds.stop(); await houses.stop(); await worlds.whenIdle(); };
  const egress = houses.egress;
  const eventBuilder = new EventBuilder(boot.signer, () => boot.nickname);
  const initiator = new InviteInitiator({ signer: boot.signer, eventBuilder, egress });
  return { readAuthorityFor, houses, lane, worlds, egress, initiator };
}

export function buildSharedStores(host: HostAdapter, paths: PopclawPaths, ports: AnyRuntimePorts) {
  const bondsStore = new BondsStore(host.db);
  // The known-followers set. Written here (the follower poll and the relation
  // bridge) as well as read (person resolution's third source).
  const knownFollowers = new KnownFollowersStore(host.db);
  const socialLogRef: { current?: SocialLogWriter } = {};
  const socialLog: SocialLogRecorder = { record: (e) => socialLogRef.current?.record(e) };
  socialLogRef.current = new SocialLogWriter({
    dir: paths.socialLogDir(),
    warn: ports.log.warn,
    bondTierOf: (id) => bondsStore.get(id)?.tier ?? null,
  });
  return { bondsStore, knownFollowers, socialLogRef, socialLog };
}

export async function loadOwnerCadence(paths: PopclawPaths, ports: AnyRuntimePorts) {
  const cadenceLoader = new CadenceLoader({ cadenceDir: paths.cadenceDir(), logger: { warn: ports.log.warn } });
  // Register the timezone once; every display point after this goes through ownerTz() (ADR-0045).
  const bootCadence = await cadenceLoader.load().catch(() => null);
  setOwnerTz(bootCadence?.delivery.timezone);
  // Same for language (S1): only what's explicitly written on disk counts; a default value doesn't count as the owner's word.
  if (bootCadence?.explicitDelivery?.includes('primaryLanguage') === true) {
    setOwnerLang(bootCadence.delivery.primaryLanguage);
  }
  if (!ports.drift.ownerLangSignalsLate) registerOwnerLangSignals(paths, ports);
  return { cadenceLoader, bootCadence };
}

/** When there's no explicit config, pick up the last-observed language (a small
 *  state file under data/, not cadence.json), plus the host's locale signals. */
export function registerOwnerLangSignals(paths: PopclawPaths, ports: AnyRuntimePorts): void {
  const speechLocale = ports.platform.speechLocale;
  useOwnerLangSignals(speechLocale
    ? { speechLocale: speechLocale(), file: paths.ownerLanguageFile() }
    : { file: paths.ownerLanguageFile() });
}

/**
 * The normal shutdown, `first-error-aborts` (DriftPins.shutdown, row 28):
 * memoized; the first throwing step aborts every later one; relation
 * reception is not stopped here.
 */
export function firstErrorAbortsShutdown(input: {
  host: HostAdapter; ports: AnyRuntimePorts; loops: InlineLoops; lane: WorldLane<object>;
  worlds: WorldRuntime; houses: HouseRuntime; houseStores: HouseStore[]; executionStores: ExecutionStoreCatalog;
}): () => Promise<void> {
  const { host, ports, loops, lane, worlds, houses, houseStores, executionStores } = input;
  let closeTask: Promise<void> | undefined;
  return (): Promise<void> => closeTask ??= (async () => {
    loops.housePinning?.stop();
    loops.followerSync?.stop();
    loops.doorbell?.stop();
    loops.pageState?.stop();
    lane.stop();
    worlds.stop();
    await houses.stop();
    await worlds.whenIdle();
    for (const house of houseStores) house.db.close();
    executionStores.close(); ports.platform.releaseStorage(); host.db.close();
  })();
}

/**
 * The normal shutdown, `guarded` (DriftPins.shutdown, row 28): the gateway
 * root's own sequence (index.ts:1281–1313 @ e3c8cfd6), copied, not
 * generalised (ruling 2026-09-29 12:00 §3.3, 14:14 ②):
 *
 * - memoized by a flag, per boot: a second call returns at once — even while
 *   the first is still running, or after it rejected — and never retries.
 *   (The host's own stop wrapper may still share one in-flight promise.)
 * - bare, unawaited, uncaught: the owner lane's stops (approval, then native),
 *   the world stop, the host's approval reset, relation reception's stop.
 *   A throw there rejects the shutdown and nothing after it runs.
 * - each later step is caught on its own (`drop`): a failure is logged, the
 *   rest still runs, and storage is then NOT released.
 * - between the house-store closes and the execution-store close, every
 *   backup task in flight is waited out, snapshot after snapshot, until a
 *   snapshot comes back empty (settled, so a failed backup is not a failed
 *   shutdown); an empty first snapshot adds no await.
 * - the release is a bare call (a throw stops the host DB close and the
 *   tail); the host DB close is caught; the host's tail runs last, and only
 *   when nothing before it threw — it is not a `finally`.
 */
export function guardedShutdown(input: {
  host: HostAdapter; platform: PlatformPort; log: LogPort; hostOps: GuardedShutdownHostOps; afterShutdown?: () => void;
  lane: WorldLane<object>; worlds: WorldRuntime; reception: { stop(): void }; houses: HouseRuntime;
  houseStores: HouseStore[]; executionStores: ExecutionStoreCatalog;
}): () => Promise<void> {
  const { host, platform, log, hostOps, lane, worlds, reception, houses, houseStores, executionStores } = input;
  let shutdownDone = false;
  return async (): Promise<void> => {
    if (shutdownDone) return;
    shutdownDone = true; hostOps.markStorageShuttingDown();
    let shutdownFailed = false;
    const drop = async (what: string, fn: () => void | Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        shutdownFailed = true;
        log.warn(`shutdown ${what} failed (non-fatal): ${String(err)}`);
      }
    };
    // Disconnect before closing the DB: the other way round, a frame
    // mid-write would hit an already-closed handle.
    lane.stop(); worlds.stop();
    hostOps.resetOwnerApprovals();
    reception.stop();
    await drop('house lifecycle', () => houses.stop());
    await drop('world runtime', () => worlds.whenIdle());
    for (const h of houseStores) await drop(`lorehouse db [${h.slug}]`, () => h.db.close());
    for (let tasks = hostOps.snapshotStorageBackups(); tasks.length > 0; tasks = hostOps.snapshotStorageBackups()) {
      await Promise.allSettled(tasks);
    }
    await drop('execution stores', () => executionStores.close());
    if (!shutdownFailed) platform.releaseStorage();
    await drop('host db', () => host.db.close());
    input.afterShutdown?.();
  };
}
