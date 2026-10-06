/**
 * Every long-running thing a popclaw process starts, and which of the three
 * composition roots must start it.
 *
 * This table exists because the same defect has now landed three times, and
 * each time it was invisible: a service assembled inline in `index.ts`'s
 * `register()` is a service the MCP host and the dev daemon simply do not
 * have, and every one of these legs is written to early-return politely when
 * its material is missing. Nothing throws, nothing is logged as wrong, and the
 * capability is just absent — being followed never announced itself on an MCP
 * host, the first follower poll ate a real follower, and the follow doorbell
 * pulled nothing while readers' ➕ clicks expired at the canvas.
 *
 * So divergence between the roots stops being a thing you can do by accident.
 * A root that must NOT start something says why, here, in one line; a root
 * that must says so by starting it, and the guard
 * (tests/unit/runtime/resident-services.test.ts) reads the roots' real wiring
 * back and fails when the two disagree — including when a brand-new service
 * appears in one root with no row here at all.
 *
 * `starter` names the module that OWNS the concern and the function every root
 * calls to start it. `null` means the gateway's own `registerService` body is
 * the whole implementation, which is only ever right for something no other
 * root could run (see each row's reason).
 */

/** The three composition roots. */
export type RootId = 'gateway' | 'mcp' | 'daemon';

/**
 * Where each root's resident-loop wiring lives, relative to `src/`. An entry
 * ending in `/` is a directory: every `.ts` file under it counts. The MCP root
 * starts its loops inline through the shared runtime assembly
 * (`LifecyclePort.loops === 'inline'`), so its starters are called somewhere
 * in the assembly, not in `mcp.ts` itself. The gateway starts three from its
 * own services in `index.ts`; the fourth, the follower poll, is built by the
 * assembly (`loops: 'host-services'`) and only started by its service.
 */
export const ROOT_SOURCES: Readonly<Record<RootId, readonly string[]>> = {
  gateway: ['index.ts', 'host/openclaw-runtime-ports.ts', 'runtime/assembly/'],
  mcp: ['mcp.ts', 'host/mcp-runtime-ports.ts', 'runtime/assembly/'],
  daemon: ['main.ts'],
};

export interface StarterRef {
  /** Module path relative to `src/`, without extension. */
  readonly module: string;
  /** The exported function a root calls. */
  readonly export: string;
}

export interface ResidentService {
  /** The `registerService` id the gateway knows it by — the one name for it. */
  readonly id: string;
  readonly starter: StarterRef | null;
  /**
   * Per root: `true` = this root must start it. A string = this root must NOT,
   * and the string is the reason, which is the only thing that keeps a gap
   * deliberate rather than forgotten.
   */
  readonly roots: Readonly<Record<RootId, true | string>>;
}

export const RESIDENT_SERVICES: readonly ResidentService[] = [
  {
    // The ignition switch for the gateway's lazy runtime memo, and nothing
    // else: its whole body is `await runtime()`. It exists because
    // `registerService` is how an OpenClaw plugin says "we are in full mode"
    // — `plugins install` / `plugins list` register without starting, so they
    // never open a socket (ADR-0035). The other two roots have no such
    // distinction: the MCP server boots its runtime on the first tool call and
    // the daemon boots it in `runDaemonMode` before anything else.
    id: 'popclaw-runtime',
    starter: null,
    roots: {
      gateway: true,
      mcp: 'nothing to ignite: buildRuntime IS the MCP root, booted on the first tool call',
      daemon: 'nothing to ignite: runDaemonMode boots its runtime inline',
    },
  },
  {
    // `start()` is `stateMachine.ensureStarted(ownerPopclawId)` and nothing
    // more — no timer, no socket. The other roots reach the same row lazily
    // and idempotently (onboarding/orchestrator.ts's `handleAdvance` /
    // `handleStartCommand` both call `ensureStarted` first, precisely because
    // "under MCP nothing ever does").
    id: 'onboarding-orchestrator',
    starter: null,
    roots: {
      gateway: true,
      mcp: 'ensureStarted is idempotent and every MCP entry point calls it first',
      daemon: 'the daemon offers no onboarding surface at all',
    },
  },
  {
    // Retries the durable DM queue THROUGH the owner push channel
    // (`notifyOwnerNow({ owner: ownerNotifier })`). `RuntimeOwnerNotifier` is
    // built from OpenClaw's `sendDurableMessageBatch` + `api.config`; no other
    // root has either. Nothing is pushed on the other roots, so "not delivered
    // yet" is their normal resting state and a retry leg would have nothing to
    // retry (runtime/plugin-runtime.ts says the same about
    // `drainNotifications`).
    id: 'popclaw-l1-delivery',
    starter: null,
    roots: {
      gateway: true,
      mcp: 'no push channel: the agent pulls with popclaw_notifications, so nothing is ever in flight',
      daemon: 'no push channel: the daemon has no owner-facing delivery leg',
    },
  },
  {
    // A delayed startup pass plus a six-hourly check. A verified complete
    // component set for the owner's current day skips recopying the root.
    id: 'popclaw-daily-backup',
    starter: null,
    roots: {
      gateway: true,
      mcp: 'session-lifetime root: a boot pass here writes one backup set per chat session, and popclaw_record_dream already runs one on any root',
      daemon: 'not wired: the daemon is the house-ranger container role, whose data root the operator snapshots — revisit if it ever becomes an owner-facing resident',
    },
  },
  {
    // Trust the houses the config already names, so a fresh install has a
    // pinned binding to read as. Every identity-bearing read needs one.
    id: 'popclaw-default-house-pinning',
    starter: { module: 'social-graph/default-house-pinning', export: 'startDefaultHousePinning' },
    roots: { gateway: true, mcp: true, daemon: true },
  },
  {
    // The only writer of `known_followers_baseline`, which every announcement
    // path joins on. A root without it applies a follow, records it, and tells
    // the owner nothing.
    id: 'popclaw-follower-sync',
    starter: { module: 'social-graph/follower-sync-service', export: 'createFollowerSync' },
    roots: { gateway: true, mcp: true, daemon: true },
  },
  {
    // The only thing that collects a reader's ➕ from the canvas. Intents are
    // credited to the READER who clicked, so this machine's own clicks are
    // waiting on other people's papers too — a root that never pulls lets them
    // expire at the canvas and the follow never happens.
    id: 'popclaw-follow-doorbell',
    starter: { module: 'newspaper/follow-doorbell-service', export: 'startFollowDoorbell' },
    roots: { gateway: true, mcp: true, daemon: true },
  },
  {
    // The only answer to "which of the people on this page do I follow": the
    // canvas cannot ask a house any more, so a root that does not answer is a
    // root whose published pages show chips that never colour.
    id: 'popclaw-page-state-sync',
    starter: { module: 'canvas/sync-answer-client', export: 'startPageStateSync' },
    roots: { gateway: true, mcp: true, daemon: true },
  },
];

/**
 * Every starter this table knows about, whichever root calls it. The guard
 * intersects a root's imports with THIS set: a root that calls a starter it
 * was told not to is as much a divergence as one that skips a starter it owes.
 */
export const ALL_STARTERS: readonly StarterRef[] = RESIDENT_SERVICES.flatMap((s) =>
  s.starter ? [s.starter] : [],
);

/** The ids `root` must start. */
export function servicesStartedBy(root: RootId): readonly string[] {
  return RESIDENT_SERVICES.filter((s) => s.roots[root] === true).map((s) => s.id);
}

/** The starters `root` must call — the ids above, minus the gateway-body-only ones. */
export function startersCalledBy(root: RootId): readonly StarterRef[] {
  return RESIDENT_SERVICES.filter((s) => s.roots[root] === true && s.starter !== null).map(
    (s) => s.starter!,
  );
}
