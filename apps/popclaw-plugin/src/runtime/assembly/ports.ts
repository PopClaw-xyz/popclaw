/**
 * The ports of the shared runtime assembly (`assembleRuntime`): the ONLY way
 * a composition root tells the assembly what differs about its host.
 *
 * Eight top-level ports, each a named type. A port carries a fact the host
 * owns or a narrow operation only the host can perform; shared business
 * wiring stays inside the assembly. Every difference between the two
 * tool-registering roots (roots difference table, PopClaw-xyz/popclaw @
 * 2f857931, re-anchored in refactor-roots-reanchor-2f857931) enters through
 * one of these ports or through a `DriftPins` field — never through a branch
 * on the host's name.
 *
 * Timing matters more than shape here: every fact a root used to read in the
 * middle of its boot (an environment variable, a path, the host's locale) is
 * a thunk, called by the assembly at the same point the root used to read it,
 * so moving the wiring did not turn a live read into a boot-time snapshot.
 * The same holds for the host's phase operations (`LifecyclePort`): each is
 * called at the one point of the boot or shutdown where that root did the
 * work, with the narrow inputs it used there, and hands nothing back.
 *
 * Types only.
 */
import type { HouseParticipationAdmissionPort } from '../house-lifecycle/participation-admission.js';
import type { CardPresenter } from '../../onboarding/orchestrator.js';
import type { HouseRuntime } from '../house-lifecycle/house-runtime.js';
import type { PopclawPaths } from '../../host/popclaw-paths.js';
import type { WorldRuntime, WorldRuntimeOptions } from '../world-runtime.js';
import type { SqliteNotifier } from '../../notifier/sqlite-notifier.js';
import type { Notifier } from '../../notifier/notifier.js';
import type { OwnerNotifyTargetStore } from '../../notifier/owner-notify-target.js';
import type { NameChain } from '../../identity/person-name.js';
import type { PendingFollowStore } from '../../social-graph/pending-follow-store.js';
import type { ProposalsStore } from '../../bonds/proposals-store.js';
import type { MarksStore } from '../../marks/marks-store.js';
import type { HouseStore } from '../../ingress/world-feed-store.js';

/** Process facts the root resolved, and the one storage operation it owns. */
export interface PlatformPort {
  /** Where the storage-runtime registration and execution stores live (built by the root before its host). */
  readonly storagePaths: PopclawPaths;
  /** The data-root paths object, built at the point the root used to build it (row 1). */
  paths(): PopclawPaths;
  /** Hand back this root's storage participation. Late-bound: the root's
   *  release is assigned inside its host's DB-initialize callback. */
  releaseStorage(): void;
  /** Where the host would put the root without POPCLAW_DATA_ROOT (bootstrapPlugin's second-root notice). */
  defaultStateDir(): string;
  /** POPCLAW_WORLD_STREAM === 'public-v1'. Read twice, where the root read it: HouseRuntime, then the bag. */
  publicWorldStream(): boolean;
  /** POPCLAW_WORLD_STREAM === '1' (row 23). Read once, where the root read it (see `worldStreamReadBeforeHouseStores`). */
  worldStreamMode(): boolean;
  /** The host's configured speech locale (row 22). Absent = this host has no such config; the key is then not passed at all. */
  speechLocale?(): string | null | undefined;
}

type Line = (message: string) => void;

/**
 * Where each boot line goes (row 30). `info`/`warn`/`error` are the root's
 * house lane (`popclaw: ` prefix); `plain` is the unprefixed lane. The named
 * lanes are the call sites where the two roots write to DIFFERENT lanes today;
 * each keeps its root's current choice.
 */
export interface LogPort {
  info: Line;
  warn: Line;
  error: Line;
  readonly plain: { info: Line; warn: Line };
  /** The "new identity / restored identity" boot line (row 2). */
  identity(boot: { readonly identityGenerated: boolean; readonly popclawId: string }): void;
  /** Follower deps + relation reception (rows 15/16/30: MCP logs both levels as house-lane info). */
  readonly relation: { info: Line; warn: Line };
  /** One-shot boot migrations and backfills that must not stop boot (row 30). */
  bootMigration: Line;
  /** The DM notification policy's warnings. */
  dmPolicy: Line;
  /** Handshake refresh + namecard announce (row 24). */
  readonly handshake: { info: Line; warn: Line };
  /** The invitation watch the bag carries. */
  readonly inviteWatch: { info: Line };
  /** The onboarding canvas deps. */
  readonly onboardingCanvas: { warn: Line };
  /** Debug lane for a house store opened after boot (openStore). Absent = not passed. */
  lateStoreOpen?: Line;
  /**
   * Mid-boot report lines only one root writes (new, found in C3): "world-feed
   * cache subscribed" per house, "social-graph loaded — following N" (which
   * reads the following list to say so), "score-cache loaded". Absent = the
   * root writes none of them, and nothing is read for them.
   */
  bootReport?: Line;
  /** The reply-ping outcome line (`reply-ping <outcome> [<slug>]`, new, found in C3). Absent = not logged. */
  replyPing?: Line;
}

/** The owner lane of the world runtime, as the host builds it (row 8). */
export interface WorldLane<S extends object> {
  readonly ownerAuthorization?: WorldRuntimeOptions['ownerAuthorization'];
  readonly nativeAuthorization?: WorldRuntimeOptions['nativeAuthorization'];
  /** Stops every authorization adapter this lane built, in the host's order. */
  stop(): void;
  /** Host slots the bag carries for this lane (MCP: `worldOwnerAuthorization`). */
  readonly slots: S;
}

export interface WorldPort<S extends object> {
  /**
   * Build the host's owner lane. `worlds` is the runtime about to be
   * constructed; only read lazily (a dialog's duplicate lookup), never here.
   */
  lane(input: { actorId: string; worlds: Pick<WorldRuntime, 'unresolvedOwnerRequests'> }): WorldLane<S>;
  /** Which lane world reads ride (row 23): the snapshot client per house store… */
  snapshotFetch(houses: HouseRuntime, origin: string): typeof globalThis.fetch;
  /** …and the guide / summary clients on the home house. */
  clientFetch(houses: HouseRuntime, origin: string): typeof globalThis.fetch;
}

/** What the assembly hands a host opening its push leg: these four and nothing else. */
export interface PushOpenInput {
  readonly notifier: SqliteNotifier;
  readonly houses: HouseRuntime;
  readonly paths: PopclawPaths;
  /** The one target store: the host's target resolver and the bag hold this same instance. */
  readonly ownerNotifyTargetStore: OwnerNotifyTargetStore;
}

/** The push leg a host opens. */
export interface PushLeg<P extends object> {
  /**
   * Deliver what is queued to the owner now, fire-and-forget. The three
   * shared callers are the DM policy's `onQueued`, the invitation outcome's
   * `notifyOwner` and a first reply to the owner's post.
   */
  pushL1ToOwner(): void;
  /** Host slots the bag carries for this leg. */
  readonly slots: P;
}

/**
 * How notifications reach the owner (rows 9/10/17/18/26).
 *
 * `pull`: nothing is pushed; the agent pulls with `popclaw_notifications`
 * under `consumerId`. No proactive delivery, no claim, no retry leg is built.
 * `push`: the host opens its push leg once, at the point the gateway root
 * built its owner notifier (after the score cache, before the invitation
 * wiring and the DM policy). A push port without `open` has no leg and is
 * refused (RUNTIME_ASSEMBLY_UNWIRED).
 */
export type DeliveryPort<P extends object = Record<never, never>> =
  | { readonly kind: 'pull'; consumerId(): string }
  | { readonly kind: 'push'; open?(input: PushOpenInput): PushLeg<P> };

/** The agent-facing collaborators the host supplies. */
export interface AgentPort {
  /** The completion function the orchestrator and the bag carry (row 19). */
  llm(paths: PopclawPaths): (prompt: string) => Promise<string>;
  readonly presenter: CardPresenter;
}

/** The Ranger role (row 25). */
export interface RangerPort {
  /** Whether this root builds a Ranger per house. Called once, where the root used to decide. */
  decide(): boolean;
}

/**
 * The four L2 slots a host's prompt-build hook reads (row 29; ruling
 * 2026-09-29 12:00 §3.4). Each is called ONCE, at its own anchor, with the
 * same instance the bag carries: `notifier` right after the house stores are
 * registered for close and before the world-feed catalog is built (a thunk,
 * evaluated per hook call); `nameOf` in the same synchronous segment as the
 * catalog, immediately after it (ruling 14:14 ①); `pendingFollows` then
 * `proposals` after the follower deps, before the legacy-file migrations and
 * the onboarding orchestrator — all before relation reception's await.
 */
export interface L2Expose {
  notifier(forTurn: () => Notifier): void;
  nameOf(nameOf: NameChain): void;
  pendingFollows(store: PendingFollowStore): void;
  proposals(store: ProposalsStore): void;
}

/**
 * The guarded shutdown's host steps (P7, ruling 14:14 ②): the root's own
 * state and one host-global reset, nothing else. The assembly owns the order.
 */
export interface GuardedShutdownHostOps {
  /** First, right after the shutdown marks itself done: storage work the root schedules (its backups) stops starting. */
  markStorageShuttingDown(): void;
  /** After the bare lane/world stops, before relation reception stops. Not part of the failed-boot drain. */
  resetOwnerApprovals(): void;
  /** The backup tasks in flight now; the shutdown waits on each snapshot until one comes back empty. */
  snapshotStorageBackups(): readonly Promise<void>[];
}

export type LoopsMode = 'inline' | 'host-services';

/**
 * Lifecycle phases that belong to the host (rows 4, 5, 26–29).
 *
 * `loops`: `inline` = the assembly starts the four resident loops itself
 * behind the closing and storage gates and its shutdown stops them;
 * `host-services` = the host's own services start/stop them, and the
 * assembly only builds the follower poll (unstarted) for the bag.
 *
 * Every other member is a host phase operation, called at the anchor its
 * comment names and nowhere else (epoch table P1–P7). Absent = that root does
 * no such work. None of them receives the runtime.
 */
export interface LifecyclePort<L extends LoopsMode = LoopsMode> {
  readonly loops: L;
  /** Synchronous step run first in the failed-boot path, before any drain. A
   *  throw here is a cleanup failure (STORAGE_BOOT_CLEANUP_FAILED) and skips the rest. */
  beforeFailedBootCleanup?(): void;
  /** Where the four L2 slots are handed to the host. Absent = this host has no L2 hook. */
  readonly expose?: L2Expose;
  /** P1 (row 4): after the data-root paths exist, before the house lifecycle is built. */
  recordBootMarkers?(paths: PopclawPaths): void;
  /** P2 (row 25): the boot-time scraper report; after the world runtime and its drain, before the queues. Awaited. */
  reportScrapers?(): Promise<void>;
  /** P4a (row 4): the install/upgrade notice, right after the onboarding state repository. Fire-and-forget. */
  announceInstall?(input: { paths: PopclawPaths; identityGenerated: boolean; onboardingCompleted(): boolean }): void;
  /** P4b (row 5): the database integrity check, right after P4a. Fire-and-forget. */
  checkIntegrity?(input: { paths: PopclawPaths; houseStores: readonly HouseStore[] }): void;
  /** P5: one-shot legacy-file migrations, after the pending/proposals slots, before the orchestrator. */
  migrateLegacyFiles?(input: { paths: PopclawPaths; marksStore: MarksStore }): void;
  /** P7: required by the `guarded` shutdown (refused without it). */
  readonly guardedShutdown?: GuardedShutdownHostOps;
  /** P6: the `guarded` shutdown's last step, reached only when nothing before it threw. */
  afterShutdown?(): void;
}

/**
 * Current behaviour the roots differ on WITHOUT a stated reason, pinned so the
 * move changes nothing. Internal fixed configuration, not a user switch and
 * never an environment variable. Each field names ONE behaviour; the table row
 * lives in the comment (rows are re-anchored, names are not).
 *
 * Fixed base for every value below: PopClaw-xyz/popclaw @ 2f857931 (mcp.ts is
 * byte-identical to a609cc96 / 83185fa0; index.ts is identical at e3c8cfd6).
 * Delete a field once the maintenance fix it waits on has been carried over
 * and no root passes the old value.
 *
 * The optional fields were added in C3. Absent means `false`, the MCP root's
 * value (its pin set is pinned exactly by its own test and predates them).
 */
export interface DriftPins {
  /**
   * #16 (displayName half) — follower deps carry no `displayName`.
   * gateway false (nameOf) · MCP true. Verified; C1 correction: the delivered
   * notice is still rendered through nameOf, so this is NOT "bare sigil".
   * Owner: DEV maintenance (MCP bond line). Delete when both roots pass false.
   */
  readonly followerDisplayNameAbsent: boolean;
  /**
   * #16 (bondContext half) — follower deps carry no `bondContext`: the
   * follow notice loses its bond line. gateway false · MCP true. Verified.
   * Owner: DEV maintenance. Delete when both roots pass false.
   */
  readonly followerBondContextAbsent: boolean;
  /**
   * #16 (store instance) — follower deps get their own `KnownFollowersStore`
   * instead of the bag's. gateway false · MCP true. Suspected equivalent
   * (same table, no in-memory state known). Owner: unassigned. Delete with #16.
   */
  readonly followerStoreOwnInstance: boolean;
  /**
   * #17 — reply-ping routing gets no `bondContext` (no bond-context trailer).
   * gateway false · MCP true. Suspected. Owner: DEV maintenance, with #16.
   * Delete when both roots pass false.
   */
  readonly replyPingBondContextAbsent: boolean;
  /**
   * #18 — the invitation outcome notifier is the bare queue, not attributed
   * to the home house (auto-unread count misses it; explicit pull still
   * returns it — C2 correction). gateway false · MCP true. Verified.
   * Owner: DEV maintenance. Delete when both roots pass false.
   */
  readonly inviteNotifierUnattributed: boolean;
  /**
   * #25 (inviteNotify half) — a Ranger is built without the invite-notify
   * wiring. gateway false · MCP true (only reachable with the MCP Ranger
   * opt-in). Suspected. Owner: unassigned. Delete when both pass false.
   */
  readonly rangerInviteNotifyAbsent: boolean;
  /**
   * #24 — handshake/guide/namecard refresh interval. gateway 6 h · MCP
   * undefined (key not passed → resource-set default 60 s). Suspected.
   * Owner: unassigned. Delete once one value is ruled for both.
   */
  readonly refreshMs: number | undefined;
  /**
   * #7 — DM recovery is scheduled even when the closing signal fired mid-boot
   * (only the storage gate applies). gateway true · MCP false. Suspected.
   * Owner: unassigned. Delete once one behaviour is ruled.
   */
  readonly recoveryIgnoresClosing: boolean;
  /**
   * #22 (timing) — owner-language signals are registered at the end of boot,
   * after the resident loops started, instead of right after the cadence.
   * gateway false · MCP true. Suspected; the late position sits after the
   * reception await (epoch table §6.5). Owner: unassigned. Delete once one
   * position is ruled.
   */
  readonly ownerLangSignalsLate: boolean;
  /**
   * #28 — the normal shutdown sequence.
   * `first-error-aborts` (MCP today): loops, owner lane, worlds, houses,
   * world idle, house-store DBs, execution stores, release, host DB — the
   * first throw aborts the rest; relation reception is not stopped; memoized
   * as one shared task.
   * `guarded` (gateway today): bare stops, then drop()-caught steps, release
   * only when clean, host DB after, then the host's tail; memoized by a flag
   * (a second call returns at once). Needs `LifecyclePort.guardedShutdown`.
   * Suspected. Owner: unassigned. Delete once one sequence is ruled.
   */
  readonly shutdown: 'first-error-aborts' | 'guarded';
  /**
   * New, found in C3 (keep-original order, ruling 13:23 §3) — the owner's
   * cadence (timezone, language, language signals) is loaded BEFORE the
   * social graph starts, not after it. gateway true · MCP absent. A hook
   * that observes owner text while the root waits on either step decides the
   * owner language differently (controlled-order characterization,
   * root-order-gateway pin 2). Owner: unassigned. Delete once one order is ruled.
   */
  readonly ownerCadenceBeforeSocialGraph?: boolean;
  /**
   * New, found in C3 (keep-original order, ruling 13:23 §3) — the score cache
   * file is read right after the social graph starts, before relation
   * reception's await, instead of when the bag is returned. gateway true ·
   * MCP absent. Two different file snapshots (root-order-gateway pin 3).
   * Owner: unassigned. Delete once one read point is ruled.
   */
  readonly scoreCacheLoadedBeforeReception?: boolean;
  /**
   * New, found in C3 (keep-original order, ruling 13:23 §3) — the follow
   * backfill (a real bonds write) runs after the owner notices (install,
   * integrity) instead of right after the social graph started. gateway true
   * · MCP absent (root-order-gateway pin 4). Owner: unassigned. Delete once
   * one position is ruled.
   */
  readonly followBackfillLate?: boolean;
  /**
   * New, found in C3 (G32; ruling 14:14 "keep the gateway's read point") —
   * `worldStreamMode()` is read before the house stores open, not after.
   * gateway true · MCP absent. Owner: unassigned. Delete once one read point
   * is ruled.
   */
  readonly worldStreamReadBeforeHouseStores?: boolean;
  /**
   * New, found in C3 (epoch table §7) — the follower poll's `houses()` lists
   * the world-feed catalog's houses instead of the house-store list. gateway
   * true · MCP absent. Suspected equivalent (both grow in `onStore`, but the
   * catalog de-duplicates and may throw on a clash, the list does not).
   * Owner: unassigned. Delete once one source is ruled.
   */
  readonly followerPollHousesFromCatalog?: boolean;
  /**
   * New, found in C3 (epoch table §7) — relation reception maps a follower's
   * house slug to its origin through the world-feed catalog instead of the
   * house-store list. gateway true · MCP absent. Same suspicion as above.
   * Owner: unassigned. Delete with `followerPollHousesFromCatalog`.
   */
  readonly receptionHouseLookupFromCatalog?: boolean;
}

/**
 * Everything a composition root hands the assembly. Eight ports.
 * `S`: the owner lane's bag slots; `P`: the push leg's bag slots; `L`: who starts the resident loops.
 */
export interface RuntimePorts<S extends object, P extends object = Record<never, never>, L extends LoopsMode = 'inline'> {
  readonly participation?: HouseParticipationAdmissionPort;
  readonly platform: PlatformPort;
  readonly log: LogPort;
  readonly world: WorldPort<S>;
  readonly delivery: DeliveryPort<P>;
  readonly agent: AgentPort;
  readonly ranger: RangerPort;
  readonly lifecycle: LifecyclePort<L>;
  readonly drift: DriftPins;
}

/** The ports as the private builders take them: any host's slots, any loops mode. */
export type AnyRuntimePorts = RuntimePorts<object, object, LoopsMode>;
