import { registerOpenClawPromptHooks } from './host/openclaw-prompt-hooks.js';
import { assertStorageBootstrap, registerStorageRuntime } from './host/storage-maintenance.js';
import { ownerConfirmedWorldInvoke, worldDeclaredActionParameters } from './runtime/world-runtime.js';
import type { createOpenClawWorldExecution } from './host/openclaw-world-execution.js';
import { nativeWorldInvoke } from './host/openclaw-owner-approval.js';
import { registerOpenClawOwnerApprovalHooks } from './host/openclaw-owner-approval-hooks.js';
import { getRuntimeConfigSnapshot } from 'openclaw/plugin-sdk/runtime-config-snapshot';
import { createLazyRuntime } from './runtime/lazy-runtime.js';
import { createDrainingService } from './runtime/draining-service.js';
import { notifierForOrigin } from './runtime/house-lifecycle/notification-scope.js';
import { assertActionActive } from './runtime/house-lifecycle/action-context.js';
import { assembleRuntime } from './runtime/assembly/index.js';
import { readNativeSetupEvidence, type LocalSetupEvidence } from './host/local-participation.js';
import { gatewayRuntimePorts } from './host/openclaw-runtime-ports.js';
/**
 * OpenClaw composition root. register() attaches host surfaces synchronously;
 * runtime() lazily boots the process singleton through assembleRuntime.
 * The root owns L2 slots, full-only services, backups and shutdown coordination.
 * Prompt sequencing belongs to registerOpenClawPromptHooks; normal tools and
 * commands are registered through registerPopclawTools and buildSubcommands.
 * See ../docs/runtime-architecture.md for the ownership and lifecycle map.
 */

import { join } from 'node:path';
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
  type PluginCommandContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import type { Notifier } from './notifier/notifier.js';
import type { NameChain } from './identity/person-name.js';
import {
  noteInboundTurn,
  routingStats,
} from './routing/stats.js';
import { createOpenClawHostAdapter } from './host/openclaw-host-adapter.js';
import type { SubagentSurface } from './newspaper/dedicated-session.js';
import { PopclawPaths } from './host/popclaw-paths.js';
import { buildSubcommands } from './commands/wiring.js';
import type { OpenClawPluginRuntime } from './runtime/gateway-runtime.js';
import { ResolveClient } from './world/resolve-client.js';
import type { ProposalsStore } from './bonds/proposals-store.js';
import { runDailyBackup } from './host/daily-backup.js';
import { verifyOpenDatabaseVisibility } from './host/local-host-db.js';
import type { OnboardingOrchestrator } from './onboarding/orchestrator.js';
import { claimOnboardingInbound } from './onboarding/inbound-claim.js';
import { mountedHouseGuides } from './world/house-handshake.js';
import {
  hostInboundMediaDir,
} from './notifier/media-staging.js';
import { adoptOrRebootRuntime, peekCurrentRuntime, runtimeMemoCurrent, isClosedRuntime } from './runtime/stale-runtime-memo.js';
import { peekPerProcess } from './runtime/once.js';
import { CapturedWorldActionParameters } from './world/world-approval-subject.js';
import { buildLLMClient } from './recommend/llm-factory.js';
import { runtimeCompletionText, type LLMClient } from './recommend/llm-client.js';
import { timeContext } from './time/time-context.js';
import {
  observeOwnerText,
  ownerLang,
} from './lexicon/owner-language.js';
import { renderCopy } from './lexicon/index.js';
import type { FollowerSyncService } from './social-graph/follower-sync-service.js';
import { fetchImageOverHttp } from './visual/fetch-image.js';
import type { PendingFollowStore } from './social-graph/pending-follow-store.js';
import {
  startDefaultHousePinning,
  type DefaultHousePinningLoop,
} from './social-graph/default-house-pinning.js';
import { startPageStateSync, type PageStateSyncLoop } from './canvas/sync-answer-client.js';
import {
  startFollowDoorbell,
  type FollowDoorbellLoop,
} from './newspaper/follow-doorbell-service.js';
import { routeSubcommand } from './commands/popclaw-router.js';
import { runtimeToolNoticeContext } from './notifier/tool-notice.js';
import { registerPopclawTools } from './tools/register-tools.js';
import { visibleLogger } from './runtime/visible-logger.js';
import { unsupportedNodeReason } from './runtime/node-support.js';

// Build provenance. esbuild replaces `__POPCLAW_BUILD__` with a literal at
// bundle time (scripts/bundle.mjs: version + UTC build time + git sha/branch).
// `tsx` dev runs leave it undefined → reported as "dev". Logged at boot so an
// installed plugin self-reports which build it is (no need to grep the bundle).
declare const __POPCLAW_BUILD__: string;
const POPCLAW_BUILD =
  typeof __POPCLAW_BUILD__ !== 'undefined' ? __POPCLAW_BUILD__ : 'dev (unbundled)';


export function parseArgs(raw: string | undefined): {
  positional: string[];
  flags: Record<string, string>;
} {
  // Greedy consumption (GNU-style): --key consumes the next token as its value
  // unless that token starts with `--` or input ends. This means schema-less:
  // `--bool-flag 30` attaches `30` to the flag, not to positional. Callers that
  // need a positional after a "boolean" flag should put it BEFORE the flag, or
  // use `--key=value` explicitly. Matches `git log --author foo` semantics.
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const tokens = (raw ?? '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // noUncheckedIndexedAccess: tokens[i] types as string|undefined even inside
    // the bounded loop — this guard narrows tok to string for tsc, not a runtime
    // defense.
    if (tok === undefined) continue;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq > 0) {
        // --key=value form
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        // --key form: consume next token as value if it's not another flag,
        // otherwise treat as boolean (value="true").
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[tok.slice(2)] = next;
          i++; // skip the consumed value token
        } else {
          flags[tok.slice(2)] = 'true';
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}


/**
 * The subcommand name list and the `/popclaw help` table both live with the
 * wiring they describe (`commands/wiring.ts`); re-exported here because that is
 * where the help-parity test and every other reader have always found them.
 */
export { SUBCOMMAND_NAMES, HELP_SUBS } from './commands/wiring.js';

// Explicit return type: `definePluginEntry`'s `DefinedPluginEntry` is not on
// the SDK's export surface, and `declaration: true` requires the .d.ts to name
// the type (TS2742). `OpenClawPluginDefinition` is its public supertype, and
// that shape is what the host loader recognizes anyway.
const popclawPlugin: OpenClawPluginDefinition = definePluginEntry({
  id: 'popclaw',
  name: 'PopClaw',
  description:
    'Federated social-feed ranger: verify-by-quorum, cross-platform identity, workload ledger.',

  // OpenClaw requires synchronous, cheap registration (ADR-0035). Boot remains
  // lazy: services and command/tool execution reach runtime() when needed.
  register(rawApi: OpenClawPluginApi) {
    // The host writes plugin warn/error to console → stderr, and the gateway's
    // steady state has `fd 2 → /dev/null` (verified with lsof on real hardware).
    // Swap the logger at the entry point, and the ~26 `api.logger.warn/error`
    // call sites in the function body all land in gateway.log without touching
    // one of them. Rationale and tradeoffs in runtime/visible-logger.ts.
    const api: OpenClawPluginApi = { ...rawApi, logger: visibleLogger(rawApi.logger) };
    // The convention the host lives under (OpenClaw) — tools and prompt
    // injection share the same one.
    const inboundMediaDirsForHost = [hostInboundMediaDir(api.runtime.state.resolveStateDir())];
    // Where the agent writes large files (the full-page newspaper HTML). Also
    // a host convention, living under the host's assembly root.
    // `register()` runs in **every process that loads the plugin**, not just the
    // gateway: `plugins install` / `plugins list` / `plugins inspect` / CLI help /
    // ephemeral side-agents all run it. OpenClaw uses `api.registrationMode` to
    // spell out which one it is (only `full` is a "live runtime"; the rest are
    // read-only inventory passes like discovery / cli-metadata). The official rule:
    //
    //   > Keep top-level imports side-effect-free and put sockets, clients,
    //   > workers, and services behind "full"-only paths.
    //   > (docs.openclaw.ai/plugins/sdk-entrypoints)
    //
    // popclaw used to ignore this: bootstrap was an immediately-invoked IIFE, so
    // `plugins install` would also open 3 sqlite databases + a long-lived SSE
    // connection to the lore-house, whose socket kept the event loop alive →
    // **the install process never exited**, and it also conjured a second
    // popclaw runtime out of thin air (violating P-006 §3, singular resources).
    // Fix below in `runtime()`: boot is now lazy, and only the `full` branch is
    // triggered by the service.
    api.logger.info(`popclaw: register mode=${api.registrationMode}`);
    /** The data root, resolved on demand — never at register() time (ADR-0035). */
    const gatewayPaths = (): PopclawPaths =>
      new PopclawPaths(PopclawPaths.resolveRoot(process.env, api.runtime.state.resolveStateDir()));
    // Process singleton (P-006 §3): register() runs once per plugin-load (the
    // gateway AND ephemeral side-agents like popclaw-recommend). Caching the
    // runtime on globalThis makes EVERY load share ONE runtime — so the live
    // inbox notification gate and the /popclaw follow command hold the SAME
    // socialGraph. Without this, a follow updated a different socialGraph than
    // the gate read, so it didn't take effect on notifications until a restart.
    // L2's delivery leg reads these from the prompt-build hook (issue #221).
    // Declared out here so the hook can READ what the runtime boot writes —
    // never the other way round: cold-starting the runtime from inside a
    // prompt-build hook would make the owner's first turn pay for the whole
    // boot, and a hook that blocks the conversation is worse than one that
    // skips a batch. Undefined until boot = skip, nothing lost.
    let l2NotifierForTurn: (() => Notifier) | undefined;
    let l2NameOf: NameChain | undefined;
    // The proposals store, same pattern: assigned where the runtime builds it
    // (a few hundred lines below), read by the L2 leg at drain time for the
    // settled-proposal drop. Undefined until
    // boot = no liveness check, items delivered as-is.
    let l2Proposals: ProposalsStore | undefined;
    // Same pattern, same reason: the follow doorbell's store, assigned where
    // the runtime builds it, read by the prompt-build hook below (the L2-leg
    // mutex claim at the drain site + the fifth passenger). MUST be the one
    // instance the timer leg claims through — the shared row is the entire
    // L1/L2 mutex (doorbell spec §6.4). Undefined until boot = skip both.
    let pendingFollowsForHook: PendingFollowStore | undefined;

    const storageBackupTasks = new Set<Promise<void>>();
    let storageShuttingDown = false;
    /**
     * The gateway's lazy boot: the checks that come before any host, this
     * host's adapter (its DB-initialize callback yields the storage release),
     * then this root's ports into the shared runtime assembly
     * (`runtime/assembly`, ports in `host/openclaw-runtime-ports.ts`). The
     * register() scope lends the boot only what it owns: the four L2 slots
     * the prompt-build hook reads, the storage-shutdown flag and the backup
     * tasks the daily-backup service keeps.
     */
    let initialEvidence: LocalSetupEvidence | undefined;
    const bootRuntime = async (closing: AbortSignal): Promise<OpenClawPluginRuntime> => {
      storageShuttingDown = false;
      api.logger.info(`popclaw: build ${POPCLAW_BUILD}`);
      // Install-time self-check: is the host's Node above the supported floor?
      // `engines` is only advisory for npm — nothing enforces it on the tarball
      // install path OpenClaw uses — and running below the floor, the first
      // symptom is usually not "won't install," it's a wrong answer nobody
      // notices a few hours later (issue #332). Warn only, never block startup:
      // it's already installed, and locking the person out only makes it harder
      // for them to figure out why.
      const nodeIssue = unsupportedNodeReason();
      if (nodeIssue) {
        api.logger.warn(
          `popclaw: ⚠️ ${nodeIssue} Upgrade Node — below the floor, dates and native modules go wrong quietly.`,
        );
      }
      const storagePaths = new PopclawPaths(PopclawPaths.resolveRoot(process.env, api.runtime.state.resolveStateDir()));
      assertStorageBootstrap(storagePaths);
      let releaseStorage!: () => void;
      const host = createOpenClawHostAdapter(api, db => (releaseStorage = registerStorageRuntime(db, storagePaths)));
      return assembleRuntime(host, gatewayRuntimePorts({
        initialEvidence: () => initialEvidence, api, host, build: POPCLAW_BUILD, storagePaths, releaseStorage: () => releaseStorage(), llmComplete,
        favoritesFile: (paths) => join(paths.data(), 'favorites.jsonl'),
        root: {
          l2: {
            // Assigned at the one place each is built, so the hook can never
            // see a half-built runtime; cleared first by a boot that fails.
            notifier: (forTurn) => { l2NotifierForTurn = forTurn; },
            nameOf: (nameOf) => { l2NameOf = nameOf; },   // the same name chain the owner sees everywhere else (#221)
            pendingFollows: (store) => { pendingFollowsForHook = store; },
            proposals: (store) => { l2Proposals = store; },
            clear: () => { l2NotifierForTurn = undefined; l2NameOf = undefined; l2Proposals = undefined; pendingFollowsForHook = undefined; },
          },
          markStorageShuttingDown: () => { storageShuttingDown = true; },
          snapshotStorageBackups: () => [...storageBackupTasks],
        },
      }), closing);
    };

    /**
     * **Only boots the first time it's actually needed** — this line is the
     * entire distinction between `register()` being cheap or not.
     *
     * The per-process memo only calls the factory when the entry is absent,
     * so wrapping the call in this closure turns the whole bootstrap (3 sqlite
     * databases + a long-lived SSE connection + world/inbox streams) from
     * "happens the moment the plugin loads" into "happens only when someone
     * uses it." Still the same single instance within a process (P-006 §3,
     * singular resources, unchanged).
     */
    const lifecycle = createLazyRuntime((closing) => {
      if (closing.aborted) return Promise.reject(new Error('HOST_RUNTIME_STOPPED'));
      return adoptOrRebootRuntime(
        'runtime',
        () => {
          const pending = bootRuntime(closing);
          pending.catch(error => api.logger.error(`popclaw: bootstrap failed — ${String(error)}`));
          return pending;
        },
        // Upgrading from a build whose shutdown did NOT clear the memo: what
        // is parked on globalThis is a corpse, not a runtime (issue #582).
        () => api.logger.info('popclaw: stale runtime memo from a previous registration detected — booting again'),
        closing,
      );
    });
    const runtime = () => lifecycle.get();


    // The ignition switch for the runtime. **Only the gateway ever starts this
    // service** — sockets, clients, workers and services stay behind
    // 'full'-only paths. CLI inspection registers declarations without booting
    // this runtime. On 2026.9.8, native installation can also apply the plugin
    // in a running Gateway, which then owns actual service activation.
    //
    // Gateway-side behavior is exactly the same as before (boot happens at
    // startup); the only difference is who pulls the trigger. If tool-discovery
    // does end up executing a tool in a non-full mode, `runtime()`'s laziness
    // still backstops it.
    // The SDK service signature is `start(ctx)` / `stop(ctx)` — **no handle is
    // passed**. Anything stop() must clean up (timers, the orchestrator) stays
    // in register()'s closure.
    api.registerService({
      id: 'popclaw-runtime',
      start: async (ctx) => {
        initialEvidence = readNativeSetupEvidence({stateDir:api.runtime.state.resolveStateDir(),serviceStateDir:ctx?.stateDir ?? '',
          rootDir:api.rootDir ?? '',source:api.source,enabled:ctx?.config?.plugins?.entries?.popclaw?.enabled === true});
        const rt = await runtime();
        const result = await rt.houseRuntime.activateInitialMe();
        if (result) api.logger.info(`popclaw: initial me participation ${JSON.stringify(result)}`);
        await rt.houseRuntime.readHouseGuide('https://house.popclaw.me');
      },
      stop: () => lifecycle.stop(),
    });

    // O-3b: register the onboarding orchestrator as a long-running service.
    // `start` resolves the runtime promise (so bootstrap finishes first), then
    // calls orchestrator.start() and returns the handle for OpenClaw to stop
    // on shutdown.
    //
    // The hard-gate switch also lives here: `liveRuntime` only gets a value once
    // the gateway has actually started this service, so the before_dispatch
    // handler naturally satisfies "orchestrator not started → don't claim it,"
    // and an inbound message will never boot the runtime on its own (ADR-0035:
    // a load/bypass process must stay cheap).
    let liveRuntime: OpenClawPluginRuntime | null = null;
    let liveOrchestrator: OnboardingOrchestrator | null = null;
    try {
      api.on('llm_input', event => { liveRuntime?.houseRuntime.markGuidesInAgentInput(JSON.stringify(event.historyMessages)); });
    } catch (err) {
      api.logger.error(`popclaw: guide delivery hook registration failed — ${String(err)}`);
    }
    // gateway_stop keeps its own handle: `liveRuntime` is already cleared
    // inside the service stop (claim-gate semantics), while closing streams
    // and databases happens later — it must remain closable after the clear.
    api.registerService({
      id: 'onboarding-orchestrator',
      start: async () => {
        const rt = await runtime();
        await rt.orchestrator.start();
        liveOrchestrator = rt.orchestrator;

        liveRuntime = rt;
      },
      stop: async () => {
        liveRuntime = null;
        const orch = liveOrchestrator;
        liveOrchestrator = null;
        await orch?.stop();
      },
    });

    // Hard gate (2026-07-29, the host-c incident): while onboarding is in
    // progress, the plugin directly claims the owner's short closed-set replies
    // (a bare number / skip / you decide / mark N …), the agent doesn't run
    // this turn, and picking a name is no longer hijacked by a question the
    // agent itself left pending. Free-text is always passed through. See
    // onboarding/inbound-claim.ts for details.
    //
    // ⚠️ Two hook tables (#374, 2026-07-31): `api.on` is the typed-hook
    // registration surface (`registry.typedHooks` → hookRunner), while
    // `api.registerHook` goes into the other, internal-hook table
    // (`registry.hooks`) — a handler registered there is **never called**,
    // with no error, and `openclaw hooks info` still reports ✓ Ready. Never
    // use registerHook (eslint has it welded shut).
    try {
      api.on('before_dispatch', (event) => {
        // Control group: this hook is known to work. It fired for several
        // rounds while before_prompt_build never fired once = that chain is
        // broken (the #374 failure mode). Log it once, don't spam; **must be
        // info** — in this repo, the host sends warn/error to /dev/null.
        if (noteInboundTurn()) {
          api.logger.info(
            `popclaw: routing registered but NEVER fired after ${routingStats().inboundCount} inbound turns — hook chain broken`,
          );
        }
        return claimOnboardingInbound(event, {
          stage: () =>
            liveRuntime === null
              ? null
              : (liveRuntime.onboardingState.get(liveRuntime.boot.popclawId)?.stage ?? null),
          namePending: () => liveRuntime?.orchestrator.hasPendingName() === true,
          advance: (action, answer) => {
            const rt = liveRuntime;
            if (rt === null) throw new Error('onboarding runtime not started');
            return rt.orchestrator.handleAdvance(action, answer);
          },
          log: (msg) => api.logger.info(msg),
        });
      });
    } catch (err) {
      // register() must not throw (ADR-0035: every loading process runs it).
      // If this fails to attach we only lose the onboarding hard gate; the
      // soft layer (briefing voice + tool descriptions) survives.
      api.logger.error(`popclaw: before_dispatch hook registration failed — ${String(err)}`);
    }

    // The owner-approval seam's OpenClaw backend (before_tool_call asks the
    // owner; after_tool_call only reports) — host/openclaw-owner-approval-hooks.ts.
    registerOpenClawOwnerApprovalHooks(api);

    // Gateway shutdown: hand back the SSE connections and SQLite handles
    // (`deactivate` is its deprecated alias, removed 2026-08-16 — don't use
    // it). Reads only an already-ignited runtime — **never** boot one just to
    // shut it down (ADR-0035: register and hooks must both stay cheap); if it
    // never started there is nothing to do.
    try {
      api.on('gateway_stop', async () => {
        await lifecycle.stop();
      });
    } catch (err) {
      api.logger.error(`popclaw: gateway_stop hook registration failed — ${String(err)}`);
    }

    // Dreaming is no longer a setInterval inside the plugin — the scheduled
    // branch is handed off to OpenClaw cron, which the owner asks the agent to
    // schedule with a single sentence (spec 2026-07-26 §1; cron has
    // `openclaw cron runs` history you can look up, satisfying ADR-0012's
    // Correction, "only something whose success/failure can be reported is fit
    // to hold responsibility"). The plugin keeps only two tools: popclaw_dream
    // fetches raw material / popclaw_record_dream writes the result back.
    //
    // Backup is a **mechanical action**, not part of dreaming (spec §3
    // explicitly excludes backup/prune from dreaming).
    //
    // Note: keeping a setInterval here does NOT contradict "delete
    // DreamerService's setInterval" — the one that was deleted was responsible
    // for **thinking** (needs an LLM, needs to report success/failure → belongs
    // to cron); this one just copies a local file. The bond book is cumulative
    // knowledge that **only exists locally** — corruption means permanent loss,
    // and it can't go a whole month without a backup just because "the owner
    // never scheduled a cron job" (caught in review: that was the one real
    // guarantee lost by deleting the timer).
    // Every run publishes a distinct verified component set; retention counts local days.
    // An incomplete run never replaces a previous complete set.
    //
    // Uses registerService rather than directly `await runtime()` inside
    // register(): **only the gateway ever starts a service** (ADR-0035), and
    // CLI processes like `plugins install` / `plugins list` only register,
    // never start — they shouldn't incidentally back up the owner's database.
    // Shared-root admission may be committed by MCP. Presentation therefore
    // observes the durable L1 queue independently of this process's receiver.
    // This gateway-owned retry loop also covers a crash after enqueue and never
    // promotes L2/L3 to an interruption. It adds no independent process.
    api.registerService({
      id: 'popclaw-l1-delivery',
      ...createDrainingService(async () => {
        const rt = await runtime();
        await rt.retryDmNotifications?.();
      }, error => api.logger.warn(`popclaw: L1 delivery retry failed: ${String(error)}`), 5_000),
    });

    const BACKUP_TICK_MS = 6 * 60 * 60 * 1000;
    let backupTimer: ReturnType<typeof setInterval> | null = null;
    api.registerService({
      id: 'popclaw-daily-backup',
      start: async () => {
        const once = async () => {
          try {
            const rt = await runtime();
            if (storageShuttingDown) return;
            // The existing periodic storage tick, reused rather than a timer of
            // its own: are this process's databases still the ones at their
            // paths? A `-wal` unlinked underneath a live connection makes every
            // later write invisible to every other process on this data root
            // and loses it on kill -9, and nothing else notices. Each affected
            // database says so exactly once per process
            // (host/local-host-db.ts); this line only makes the once-per-boot
            // check happen again while the gateway stays up.
            verifyOpenDatabaseVisibility();
            const task = runDailyBackup({
              paths: rt.paths,
              actorId: rt.boot.popclawId,
              installationId: rt.host.db.queryOne<{value: string}>("SELECT value FROM house_lifecycle_meta WHERE key='installation_id'")?.value ?? null,
              codeVersion: POPCLAW_BUILD,
              date: timeContext(Math.floor(Date.now() / 1000)).ymd, // The owner's local date (ADR-0045: only with keep=7 does this match the owner's mental "last 7 days")
              keep: 7,
            });
            storageBackupTasks.add(task);
            try { await task; } finally {storageBackupTasks.delete(task);}
          } catch (err) {
            api.logger.warn(`popclaw: daily backup failed (non-fatal): ${String(err)}`);
          }
        };
        await once(); // Run once at boot
        backupTimer = setInterval(() => void once(), BACKUP_TICK_MS);
        // Backup isn't worth keeping the process alive for (same discipline as ADR-0035).
        if (typeof backupTimer.unref === 'function') backupTimer.unref();
      },
      stop: () => {
        if (backupTimer) clearInterval(backupTimer);
        backupTimer = null;
      },
    });

    // Trust the configured houses, so a fresh install has a pinned binding
    // to read as. Runs on EVERY boot, which is also how the first run is
    // covered: identity is established in `bootstrapPlugin`, and `runtime()`
    // is what this awaits. A house that was unreachable during onboarding is
    // picked up by a later boot (and, within this one, by the bounded retry).
    //
    // A service, never register() (ADR-0035: `plugins install` / `plugins
    // list` must not open a socket), and the first pass is deliberately NOT
    // awaited — gateway startup does not wait on a network round trip.
    let housePinning: DefaultHousePinningLoop | null = null;
    api.registerService({
      id: 'popclaw-default-house-pinning',
      start: async () => {
        const rt = await runtime();
        // Behind the same gate as DM recovery: storage held for recovery
        // means this root reaches for nothing, and the next boot retries.
        if (!rt.houseRuntime.storageAllows('consumers')) return;
        housePinning = startDefaultHousePinning({
          db: rt.host.db,
          pinning: rt.houseRuntime.configuredHousePinning,
          onParticipationChanged: () => rt.houseRuntime.participationChanged(),
          recipientPopclawId: rt.boot.popclawId,
          origins: rt.boot.loreHouseUrls,
          warn: (line) => api.logger.warn(`popclaw: ${line}`),
        });
      },
      stop: () => {
        housePinning?.stop();
        housePinning = null;
      },
    });

    // New-follower notifications (spec 2026-07-27, slices ②③). The poll diffs
    // `GET /followers/:me`, and it is also the only writer of the baseline
    // that every announcement path — this one and the personal stream's —
    // joins on. The 30-minute interval doubles as the L2 batching window
    // (ADR-0012 amendment 2026-07-27): new followers found in one pass are
    // combined into a single "N people followed you in the last 30 minutes"
    // message, grouped by house for multi-house setups.
    // Runs once at boot first — the first run only establishes a baseline and
    // doesn't notify (existing followers shouldn't flood in as "new").
    // The loop itself is the shared one (social-graph/follower-sync-service.ts)
    // the MCP host and the daemon start too; this block only supplies the
    // gateway's service lifecycle (ADR-0035).
    let followerSync: FollowerSyncService | null = null;
    api.registerService({
      id: 'popclaw-follower-sync',
      start: async () => {
        try {
          followerSync = (await runtime()).followerSync;
        } catch (err) {
          api.logger.warn(`popclaw: follower sync failed (non-fatal): ${String(err)}`);
          return;
        }
        await followerSync.start();
      },
      stop: () => {
        followerSync?.stop();
        followerSync = null;
      },
    });

    // Follow doorbell pull loop (doorbell spec §6.2) and page-state sync
    // (the canvas round-trip that lets a chip say anything true), as the two
    // shared starters every resident root calls — `startFollowDoorbell` and
    // `startPageStateSync` own their own pacing, their own gate and their own
    // unref'd timer, so the MCP host and the dev daemon run byte-identical
    // loops. This block supplies only the gateway's service lifecycle
    // (ADR-0035: registration is cheap, and only the gateway ever starts a
    // service).
    //
    // Both are behind the same storage gate as DM recovery and the pin above:
    // storage held for recovery means this root reaches for nothing, and the
    // next boot retries.
    let doorbell: FollowDoorbellLoop | null = null;
    api.registerService({
      id: 'popclaw-follow-doorbell',
      start: async () => {
        const rt = await runtime();
        if (!rt.houseRuntime.storageAllows('consumers')) return;
        doorbell = startFollowDoorbell({
          db: rt.host.db,
          ownerPopclawId: rt.boot.popclawId,
          canvasBaseUrl: rt.boot.canvasBaseUrl,
          signer: rt.boot.signer,
          // Person-level, house-agnostic on purpose: the question is "do I
          // already know them", not "do they get follow weighting in this
          // house". `followsIn(id)` with no house reads the always-empty ''
          // bucket and would answer false for everyone — see follows().
          followsIn: (id) => rt.socialGraph.follows(id),
          notifier: notifierForOrigin(rt.notifier, rt.boot.loreHouseUrl),
          // The one root with a push leg. The L1 summary is the only place the
          // pending names are ever said out loud.
          deliverNow: (text) => rt.ownerNotifier.deliverNow(text, undefined, () => assertActionActive()),
          runCommand: (work) => rt.houseRuntime.runCommand(work),
          captureGate: (origin) => rt.houseRuntime.captureGate(origin),
          houseOrigin: rt.boot.loreHouseUrl,
          observeParticipation: changed => rt.houseRuntime.observeParticipation(rt.boot.loreHouseUrl, changed),
          // The SAME instance the L2 injection passenger claims through: that
          // shared row is the entire L1/L2 mutex.
          store: rt.pendingFollows,
          logger: {
            info: (m: string) => api.logger.info(m),
            warn: (m: string) => api.logger.warn(m),
          },
        });
      },
      stop: () => {
        doorbell?.stop();
        doorbell = null;
      },
    });

    let pageState: PageStateSyncLoop | null = null;
    api.registerService({
      id: 'popclaw-page-state-sync',
      start: async () => {
        const rt = await runtime();
        if (!rt.houseRuntime.storageAllows('consumers')) return;
        pageState = startPageStateSync({
          baseUrl: rt.boot.canvasBaseUrl,
          signer: rt.boot.signer,
          // `unknown` has no producer yet: the projection always has an
          // answer. The seam is where a reader whose own relation log has an
          // open gap for that house should say so, because `none` would lie.
          stateOf: (id) => (rt.socialGraph.follows(id) ? 'follows' : 'none'),
          logger: { info: (m: string) => api.logger.info(m) },
        });
      },
      stop: () => {
        pageState?.stop();
        pageState = null;
      },
    });

    // Newspaper (L3) scheduled 8am auto-delivery is deferred to Plan 2: it wakes the
    // agent to render (popclaw can't call an LLM on subscription hosts — spec
    // 2026-06-18). The interactive paths (slash command + NL via the
    // popclaw_newspaper / popclaw_publish_newspaper tools) work now.

    class OpenClawRuntimeLLMClient implements LLMClient {
      constructor(private readonly api: OpenClawPluginApi) {}
      async complete(prompt: string): Promise<string> {
        const cfg = this.api.config;
        // openclaw 2026.8.2 removed prepareSimpleCompletionModelForAgent /
        // completeWithPreparedSimpleCompletionModel from the plugin-facing
        // agent-runtime subpath (no public subpath re-exposes them — checked
        // all 324 export entries). Import untyped and probe at runtime: on
        // hosts that still have them (7.1-2) this behaves exactly as before;
        // on 8.2+ it fails with the honest, actionable error instead of a
        // TypeError on undefined. The direct-llm path (llm.json) is the
        // supported configuration going forward.
        const runtime = (await import('openclaw/plugin-sdk/agent-runtime')) as unknown as {
          prepareSimpleCompletionModelForAgent?: (a: unknown) => Promise<unknown>;
          completeWithPreparedSimpleCompletionModel?: (a: unknown) => Promise<unknown>;
        };
        const {
          prepareSimpleCompletionModelForAgent: prepare,
          completeWithPreparedSimpleCompletionModel: completeWith,
        } = runtime;
        if (typeof prepare !== 'function' || typeof completeWith !== 'function') {
          throw new Error(
            "this host's openclaw no longer ships the runtime-LLM fallback (removed in 2026.8.2); configure the direct path (llm.json, see docs/popclaw-direct-llm.md)",
          );
        }
        const prepareSimpleCompletionModelForAgent = prepare;
        const completeWithPreparedSimpleCompletionModel = completeWith;
        const prepared = (await prepareSimpleCompletionModelForAgent({
          cfg,
          agentId: 'popclaw-recommend',
        })) as { error?: string; model?: unknown; auth?: unknown };
        if ('error' in prepared) {
          throw new Error(
            `OpenClaw agent 'popclaw-recommend' not available: ${prepared.error}`,
          );
        }
        const reply = await completeWithPreparedSimpleCompletionModel({
          model: prepared.model,
          auth: prepared.auth,
          context: {
            messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
          },
        });
        return runtimeCompletionText(reply);
      }
    }
    let cachedClient: LLMClient | null = null;
    function getLLMClient(): LLMClient {
      if (cachedClient) return cachedClient;
      const paths = new PopclawPaths(
        PopclawPaths.resolveRoot(process.env, api.runtime.state.resolveStateDir()),
      );
      cachedClient = buildLLMClient({
        llmConfigPath: paths.configFile('llm'),
        fallback: () => new OpenClawRuntimeLLMClient(api),
      });
      return cachedClient;
    }
    async function llmComplete(prompt: string): Promise<string> {
      return getLLMClient().complete(prompt);
    }

    // Plan 11.1.2: scoring is now batched. score-against-taste builds the
    // matrix prompt itself; we just hand it `llmComplete`. Same fn for
    // render. Total ≈ 2 LLM calls per /popclaw-recommend invocation,
    // regardless of pool size — was N×M before.

    // ---------------------------------------------------------------------------
    // P-001: Single /popclaw slash command with sub-router (Task 6, Plan A).
    // ---------------------------------------------------------------------------

    // `/popclaw doctor`'s tool-registration verdict needs "how many tools did THIS process
    // actually register" — only known once registerPopclawTools() below has run.
    // Set once at registration time; read later by the doctor subcommand closure
    // (both live inside this same register() call, so no TDZ issue — the closure
    // only executes after registration has finished).
    let toolsRegisteredCount: number | null = null;

    // The 36 subcommand closures themselves live in `commands/wiring.ts`.
    // Building the map is cheap by construction (ADR-0035): everything below is
    // a thunk, so nothing is opened, read or constructed until a handler runs.
    const SUBCOMMANDS = buildSubcommands({
      runtime,
      getHouseCommandContext: async () => { const rt = await runtime(); return {coordinator: () => rt.houseRuntime.commands, recovery: rt.houseRuntime.recovery, lang: ownerLang,
        readHouseGuide: origin => rt.houseRuntime.readHouseGuide(origin),
        readAgentContext: (origin: string, sessionId: string) => rt.houseRuntime.readAgentContext(origin, rt.boot.popclawId, {}, sessionId)}; },
      paths: gatewayPaths,
      picksFile: () => join(gatewayPaths().tasteDir(), 'learned', 'picks.jsonl'),
      warn: (m) => api.logger.warn(m),
      llmComplete,
      toolsRegisteredCount: () => toolsRegisteredCount,
      buildStamp: POPCLAW_BUILD,
    });

    api.registerCommand({
      name: 'popclaw',
      // The `/` menu entry. `description` is the last-resort fallback for any
      // locale we have not hand-checked (English, per the decision doc's
      // "human-proofread only" red line); the localizations below are the two
      // languages we do proofread. Telegram matches on the two-letter code,
      // Discord on the full tag — hence `zh` and `zh-CN` both (decision doc
      // section 10.3, command-menu row).
      description: renderCopy('en', 'command.popclaw.description'),
      descriptionLocalizations: {
        'en': renderCopy('en', 'command.popclaw.description'),
        'en-US': renderCopy('en', 'command.popclaw.description'),
        'zh': renderCopy('zh-CN', 'command.popclaw.description'),
        'zh-CN': renderCopy('zh-CN', 'command.popclaw.description'),
      },
      acceptsArgs: true,
      handler: async (ctx: PluginCommandContext) => {
        const parsed = parseArgs(ctx.args);
        const command = parsed.positional[0];
        // Retired route preparation is a read-only compatibility response.
        if (command === 'approvals') return {text: renderCopy(ownerLang(), 'socialSend.approvalsRetired')};
        if (!command || command === 'help' || !(command in SUBCOMMANDS) || parsed.flags['help']) {
          return routeSubcommand(SUBCOMMANDS, {args: {positional: parsed.positional, flags: parsed.flags}});
        }
        // O-9: capture the owner's stable sessionKey AND routable delivery
        // address (channel/to/…) so background L1 pushes reach the exact channel
        // the owner last used. The deliveryContext is load-bearing: without it
        // the heartbeat queues the line but can't render it (M1.4 live bug).
        // Best-effort; degrades gracefully when no session is known yet.
        //
        // The ONE shared auto-capture point: every /popclaw subcommand routes
        // through here, so pinning the notify target here makes it zero-config
        // (captureIfUnset never overwrites an existing pin). Awaited, not
        // fire-and-forget, so `notify-here` — dispatched below — can't race the
        // capture and get its explicit pin clobbered by the auto one.
        // Agent-tool invocations are NOT covered: popclaw registers tools as
        // plain objects via api.registerTool, and only the factory form
        // (OpenClawPluginToolFactory) receives a ctx carrying deliveryContext.
        const sessionKey = ctx.sessionKey;
        const deliveryContext = {
          channel: ctx.channel,
          to: ctx.to,
          accountId: ctx.accountId,
          threadId: ctx.messageThreadId,
        };
        try {
          // The fallback entry point for the live language signal: when the
          // host has allowPromptInjection turned off, before_prompt_build never
          // fires, and typing a command is the only place we can still see the
          // owner's actual words.
          observeOwnerText(ctx.args);
          const rt = await runtime();
          // Stash the full address so `notify-here` can pin this channel and
          // `status` can say "this channel". Stamped unconditionally: both read it as
          // "where this very command came from", so a stale value would lie.
          rt.lastCommandAddress = { sessionKey, ...deliveryContext };
          if (sessionKey) {
            rt.ownerSession.set(sessionKey, deliveryContext);
            await rt.ownerNotifyTargetStore.captureIfUnset({ sessionKey, deliveryContext });
          }
        } catch {
          // A boot failure must not swallow the command (/popclaw help still
          // works); the subcommand itself surfaces the real error.
        }
        const result = await routeSubcommand(SUBCOMMANDS, {
          args: { positional: parsed.positional, flags: parsed.flags },
        });
        return result;
      },
    });

    // Register typed tools for OpenClaw main-agent natural-language invocation
    // (P-001). Base tools always registered (read + newspaper + canvas + bond
    // surface + stubs + write-class draft/confirm + mark + set-name + review),
    // plus 3 onboarding tools (S3-T5) and 4 world tools (S4.1-T3 + S4.2-T3
    // follow) when their lazy deps are provided. Authoritative count =
    // `total` + `extras` in register-tools.ts.
    //
    // Orchestrator lift: register() must be synchronous (OpenClaw constraint),
    // so we pass a lazy getter `() => runtimePromise.then(rt => rt.orchestrator)`
    // that resolves the same singleton already constructed inside runtimePromise.
    // This guarantees tools and registerService share exactly one instance.
    // getWorldDeps follows the same lazy pattern: the world tools consume the
    // exact same guide/summary/snapshot clients as the orchestrator's act2
    // wiring (same source, same criteria).
    // The runtime() lexical closure is the lazy ignition path in register().
    toolsRegisteredCount = registerPopclawTools({
      socialSendHost: 'native',
      nativeToolNotices: true,
      getToolNoticeContext: async signal => { const rt = await runtime(); return runtimeToolNoticeContext(rt, `native:${rt.boot.popclawId}`, signal, true); },
      api: api as unknown as Parameters<typeof registerPopclawTools>[0]['api'],
      runtime,
      runCommand: async work => (await runtime()).houseRuntime.runCommand(work),
      getHouseCommandContext: async () => { const rt = await runtime(); return {coordinator: () => rt.houseRuntime.commands, recovery: rt.houseRuntime.recovery, lang: ownerLang,
        readHouseGuide: origin => rt.houseRuntime.readHouseGuide(origin),
        readAgentContext: (origin: string, sessionId: string) => rt.houseRuntime.readAgentContext(origin, rt.boot.popclawId, {}, sessionId)}; },
      // The host's plugin-runtime subagent surface, which is what lets
      // popclaw_newspaper dispatch the paper into a dedicated workshop session
      // (2026-09-03 cut 1). LAZY: the surface is request-scoped, so it may only
      // be touched inside a tool execute — handing over the getter, never the
      // result, is what keeps that discipline mechanical.
      getSubagent: () => (api.runtime as { subagent?: SubagentSurface }).subagent,
      // The workshop's model profile (cut 2, 2026-09-03): plugin config
      // `newspaper.model`, empty/absent = the host's default model. Lazy like
      // getOwnerPush — the parsed config only exists once the runtime has
      // booted. Normalized here so the tool layer only ever sees a real model
      // name or undefined.
      getNewspaperModel: async () => {
        const model = (await runtime()).boot.config.newspaper?.model;
        return typeof model === 'string' && model.trim() ? model.trim() : undefined;
      },
      // The workshop dispatch's belt-and-braces channel push. ownerNotifier is a
      // gateway-only slot (kept out of the shared PluginRuntime contract on
      // purpose), so it enters through this lazy dep instead of the bag.
      getOwnerPush: async () => (await runtime()).ownerNotifier,
      // OpenClaw's convention lives under OpenClaw's own assembly root — tools
      // recognize no host path directly.
      inboundMediaDirs: inboundMediaDirsForHost,
      // Fetching a picture is a host capability, injected here rather than reached
      // for inside the tools — which is also what keeps their unit tests off the network.
      fetchImage: fetchImageOverHttp,
      getOrchestrator: () => runtime().then((rt) => rt.orchestrator),
      getWorldCommandContext: async () => (await runtime()).worldRuntime,
      // Discovery re-registers the shared subject without starting its local
      // services. Read the process memo, never the onboarding closure and
      // never runtime(): a hook must not boot anything (ADR-0035). Missing or
      // stopped runtime and unverified house evidence still refuse the schema.
      declaredWorldActionParameters: async (house, kind) => {
        const memo = peekPerProcess<Promise<OpenClawPluginRuntime>>('runtime');
        const rt = await peekCurrentRuntime<OpenClawPluginRuntime>('runtime');
        const beforeAsk = (): string | null => {
          if (!rt || !runtimeMemoCurrent('runtime', memo) || isClosedRuntime(rt)) return 'WORLD_ACTION_SCHEMA_UNAVAILABLE';
          try { rt.worldOwnerApproval.assertActive(); } catch { return 'WORLD_ACTION_SCHEMA_UNAVAILABLE'; }
          return null;
        };
        if (beforeAsk() !== null || !rt) return null;
        return new CapturedWorldActionParameters(
          worldDeclaredActionParameters(rt.worldRuntime, rt.boot.popclawId)(house, kind), beforeAsk);
      },
      bindNativeWorldInvoke: hostContext => {
        let bound: ReturnType<ReturnType<typeof createOpenClawWorldExecution>['bindFactory']> | undefined;
        return async (callId, input, signal, work) => {
          const rt = await runtime();
          // Two authorizations, and which one applies is decided by whether the
          // owner was ASKED about this exact call — never by which one would say
          // yes. A call the seam never asked about (no approval surface, or an
          // origin the route guard refused) falls through to the policy lane
          // exactly as it did before any of this existed, and a refusal now
          // says WHY on the way past. Both arguments live in
          // `nativeWorldInvoke`; this root only supplies the two lanes, because
          // it is the only place that holds a host factory context.
          return nativeWorldInvoke(callId, {
            asked: () => rt.worldOwnerApproval.asked(callId),
            owner: () => ownerConfirmedWorldInvoke(rt.worldOwnerApproval, rt.worldRuntime)(callId, input, signal, work),
            policy: running => {
              bound ??= rt.nativeWorldExecution.bindFactory(hostContext);
              return bound.withInvocation(callId, input, signal, permit => {
                // The permit exists: from here on a failure is about the
                // ACTION, and owes no sentence about an owner dialog.
                running();
                return work(rt.worldRuntime.nativeCommandContext(permit));
              });
            },
          });
        };
      },
      getWorldDeps: () =>
        runtime().then((rt) => ({
          guideClient: rt.guideClient,
          summaryClient: rt.summaryClient,
          snapshotClient: rt.worldFeedClient,
          resolveClient: new ResolveClient({ baseUrl: rt.boot.loreHouseUrl, fetch: rt.houseRuntime.fetchHouse }),
          webBaseUrl: rt.boot.webBaseUrl,
          // ADR-0041: the primary house's ([0]) guide is fetched live via
          // guideClient; every other mounted house reads from the handshake
          // cache instead — one disk read, and a guide is still available even
          // if that house is down.
          mountedGuides: () => mountedHouseGuides(rt.paths, rt.boot.loreHouseUrls.slice(1)),
        })),
    });

    registerOpenClawPromptHooks(api, {
      routingPaths: gatewayPaths,
      runtimeConfig: getRuntimeConfigSnapshot,
      inboundMediaDirs: inboundMediaDirsForHost,
      notifierForTurn: () => l2NotifierForTurn?.(),
      proposalsForTurn: () => l2Proposals,
      namesForTurn: () => l2NameOf,
      pendingFollowsForTurn: () => pendingFollowsForHook,
    });

    api.logger.info(
      `popclaw: 1 slash command with ${Object.keys(SUBCOMMANDS).length} subcommands available (use /popclaw help)`,
    );
  },
});

export default popclawPlugin;
