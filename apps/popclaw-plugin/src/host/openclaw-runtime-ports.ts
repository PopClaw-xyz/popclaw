/**
 * The OpenClaw gateway root's `RuntimePorts`: what differs about the gateway
 * host, handed to the shared runtime assembly (`runtime/assembly`).
 *
 * Built inside the root's lazy boot, never at register() or tools/list
 * (ADR-0035). Every host fact is a thunk read where `bootRuntime` used to read
 * it, and every gateway-only piece of the boot — the boot markers, the scraper
 * report, the owner push leg, the install notice, the integrity check, the
 * legacy migrations, the guarded shutdown's host steps and tail — is a phase
 * operation the assembly calls at the point the root used to do that work,
 * with the lines moved here verbatim (index.ts @ e3c8cfd6).
 *
 * This file may import the OpenClaw SDK (the assembly may not). No `node:*`
 * import: the one path join the migrations need is passed in by `index.ts`,
 * and so is the register-scope state the root keeps (the L2 slots, the
 * storage-shutdown flag, the backup tasks).
 */
import { resolveReceiveMode, type ReceiveMode } from '../runtime/receive-mode.js';
import { localDatabasePath } from './local-host-db.js';
import { localParticipationPort, type LocalSetupEvidence } from './local-participation.js';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { getRuntimeConfigSnapshot } from 'openclaw/plugin-sdk/runtime-config-snapshot';
import { sendDurableMessageBatch } from 'openclaw/plugin-sdk/channel-outbound';
import type { HostAdapter } from './host-adapter.js';
import { PopclawPaths } from './popclaw-paths.js';
import { createOpenClawWorldExecution } from './openclaw-world-execution.js';
import { createWorldOwnerApproval } from './openclaw-owner-approval.js';
import { resetOwnerApprovals } from './owner-approval.js';
import { ensureSentinelReadmes } from './sentinels.js';
import { markIntegrityAnnounced, integrityAlertText } from './integrity-check.js';
import { runIntegrityChecksInProcess } from './integrity-process.js';
import { recordBuildOnBoot, readLastBuild, markBuildAnnounced } from '../runtime/last-build.js';
import { decideInstallNotice } from '../runtime/install-notice.js';
import { appendSocialLog } from '../social-log/social-log.js';
import { BudgetGuard } from '../observability/budget-guard.js';
import { buildScraperRegistry } from '../runtime/ranger.js';
import { OwnerSession } from '../notifier/owner-session.js';
import { RuntimeOwnerNotifier, notifyOwnerNow } from '../notifier/owner-notifier.js';
import { fileDeliveryFailure } from '../notifier/delivery-failure.js';
import { dmMediaStagingDir, stageMediaForSend } from '../notifier/media-staging.js';
import { captureNotificationScopes } from '../runtime/house-lifecycle/notification-scope.js';
import { migrateFavoritesJsonl } from '../marks/favorites-migration.js';
import { migrateStyleNotesToVault } from '../visual/style-notes.js';
import { clearPerProcess } from '../runtime/once.js';
import { NewspaperDispatchRegistry } from '../newspaper/dedicated-session.js';
import { ownerLang } from '../lexicon/owner-language.js';
import type { CardPresenter } from '../onboarding/orchestrator.js';
import type { DriftPins, L2Expose } from '../runtime/assembly/index.js';
import type { GatewayRuntimePorts } from '../runtime/gateway-runtime.js';

// Retain the existing type import surface without owning a second declaration.
export type { GatewayWorldSlots, GatewayPushSlots, GatewayRuntimePorts } from '../runtime/gateway-runtime.js';

/**
 * The gateway root's current values for every drift pin (see `DriftPins` for
 * the row, owner and deletion condition of each). They reproduce this root's
 * behaviour at e3c8cfd6 exactly; flipping one is a maintenance change, not a
 * refactor.
 */
export const GATEWAY_DRIFT_PINS: DriftPins = Object.freeze({
  followerDisplayNameAbsent: false,
  followerBondContextAbsent: false,
  followerStoreOwnInstance: false,
  replyPingBondContextAbsent: false,
  inviteNotifierUnattributed: false,
  rangerInviteNotifyAbsent: false,
  // 6 h.
  refreshMs: 21_600_000,
  recoveryIgnoresClosing: true,
  ownerLangSignalsLate: false,
  shutdown: 'guarded',
  ownerCadenceBeforeSocialGraph: true,
  scoreCacheLoadedBeforeReception: true,
  followBackfillLate: true,
  followerPollHousesFromCatalog: true,
  receptionHouseLookupFromCatalog: true,
});

/** What the gateway root's register() scope owns and lends the boot. */
export interface GatewayRootState {
  /** The four L2 slots the prompt-build hook reads, and their failed-boot reset. */
  readonly l2: L2Expose & { clear(): void };
  /** The daily-backup service stops starting backups once this is set. */
  markStorageShuttingDown(): void;
  /** The backup tasks in flight. */
  snapshotStorageBackups(): readonly Promise<void>[];
}

export function gatewayRuntimePorts(input: {
  receiveMode?: ReceiveMode;
  initialEvidence?: () => LocalSetupEvidence | undefined;
  /** The register-scope api, logger already swapped to the visible one. */
  api: OpenClawPluginApi;
  host: HostAdapter;
  build: string;
  storagePaths: PopclawPaths;
  /** Late-bound: assigned inside the host's DB-initialize callback. */
  releaseStorage: () => void;
  /** The register-scope completion function (llm.json → OpenClaw fallback), shared with the subcommands. */
  llmComplete: (prompt: string) => Promise<string>;
  /** Where the retired favorites.jsonl lives under this data root (a path join, done by the root). */
  favoritesFile: (paths: PopclawPaths) => string;
  root: GatewayRootState;
}): GatewayRuntimePorts {
  const { api, host, build, root } = input;
  const receiveMode = resolveReceiveMode(input.receiveMode ?? process.env['POPCLAW_WORLD_STREAM']);
  const line = (m: string) => api.logger.info(`popclaw: ${m}`);
  const warn = (m: string) => api.logger.warn(`popclaw: ${m}`);
  // The owner notifier the push leg opens; the install notice and the
  // integrity alert (both after the leg, by the assembly's order) deliver through it.
  let ownerNotifier: RuntimeOwnerNotifier | undefined;
  const integrityAbort = new AbortController();
  let integrityTask: Promise<void> | undefined;
  // MVP presenter: log the card. Real interactive card delivery is via
  // registerInteractiveHandler's response payload + the OpenClaw
  // interactive runtime; the orchestrator also returns the card's text
  // fallback so the slash-command response shows something usable.
  const presenter: CardPresenter = {
    async present(card) {
      api.logger.info(
        `popclaw: onboarding card presented blocks=${card.blocks.length} actions=${card.actions?.length ?? 0}`,
      );
    },
  };
  return {
    participation:localParticipationPort(input.initialEvidence ?? (() => undefined)),
    platform: {
      storagePaths: input.storagePaths,
      // Single source of truth for every on-disk path: one root, one PopclawPaths.
      // Same root the host adapter uses (createOpenClawHostAdapter resolves it the
      // same way), so identity/db/config and all business data share one tree.
      paths: () => new PopclawPaths(PopclawPaths.resolveRoot(process.env, api.runtime.state.resolveStateDir())),
      releaseStorage: () => input.releaseStorage(),
      defaultStateDir: () => api.runtime.state.resolveStateDir(),
      receiveMode: () => receiveMode,
      // Plus the locale signals the host already has (speechLocale / OPENCLAW_LOCALE
      // / LANG) — priority order lives in useOwnerLangSignals.
      speechLocale: () => api.config?.talk?.speechLocale,
    },
    log: {
      info: line,
      warn,
      error: (m: string) => api.logger.error(`popclaw: ${m}`),
      plain: { info: (m) => api.logger.info(m), warn: (m) => api.logger.warn(m) },
      identity: (boot) => {
        // The gateway's own logger is what an operator reads — the HostAdapter's
        // pino goes to stdout and gets lost. "restored" vs "just minted" MUST be
        // distinguishable here, or a wrong data root silently costs an identity.
        if (boot.identityGenerated) {
          // info, not warn: the gateway sends plugin warn/error to /dev/null (see keystore.ts).
          api.logger.info(
            `popclaw: ★★★ NEW IDENTITY CREATED popclaw_id=${boot.popclawId} — no master.key existed, ` +
              `so a brand-new one was just generated. Expected ONLY on first run. If you have used ` +
              `popclaw before, STOP: check POPCLAW_DATA_ROOT — the old identity cannot be recovered or revoked.`,
          );
        } else {
          api.logger.info(`popclaw: identity loaded (restored existing key) popclaw_id=${boot.popclawId}`);
        }
      },
      // Row 30: the gateway's relation chain logs at the real levels, unprefixed.
      relation: { info: (m: string) => api.logger.info(m), warn: (m: string) => api.logger.warn(m) },
      // Row 30: boot migrations and the backfill go to console.warn on this root.
      bootMigration: (m: string) => console.warn(`popclaw: ${m}`),
      dmPolicy: (m: string) => api.logger.warn(m),
      handshake: { info: (m: string) => api.logger.info(m), warn: (m: string) => api.logger.warn(m) },
      inviteWatch: { info: (m: string) => api.logger.info(m) },
      onboardingCanvas: { warn: (m: string) => api.logger.warn(m) },
      bootReport: line,
      replyPing: line,
    },
    world: {
      // Same lane HouseRuntime's own refusals take: a world action refused for
      // want of authorization has to leave one line behind, or there is
      // nothing in `logs/` to start reading from.
      lane: ({ actorId }) => {
        const nativeWorldExecution = createOpenClawWorldExecution({ actorId, readActiveConfig: getRuntimeConfigSnapshot,
          log: message => api.logger.warn(`popclaw: ${message}`) });
        // The owner lane on this host. It is a PRESENCE flag for the capability
        // projection and a grant issuer per call; it holds no policy and can
        // only ever turn one consumed host answer into one short-lived grant.
        const worldOwnerApproval = createWorldOwnerApproval({});
        return {
          nativeAuthorization: nativeWorldExecution,
          ownerAuthorization: worldOwnerApproval,
          stop: () => { worldOwnerApproval.stop(); nativeWorldExecution.stop(); },
          slots: { nativeWorldExecution, worldOwnerApproval },
        };
      },
      // Row 23: the gateway reads the world over the owner lane.
      snapshotFetch: (houses, origin) => houses.houseFetch(origin),
      clientFetch: (houses) => houses.fetchHouse,
    },
    delivery: {
      kind: 'push',
      open: ({ notifier, houses, paths, ownerNotifyTargetStore }) => {
        // Commands and normal SDK owner tools capture the same last-active
        // session and route for direct background L1 channel delivery.
        const ownerSession = new OwnerSession();
        // Delivery target precedence: pinned channel → in-memory routable
        // last-active → null (defer to inbox-on-next-interaction).
        const resolveNotifyTarget = async () => {
          const pinned = await ownerNotifyTargetStore.get();
          if (pinned?.deliveryContext?.channel && pinned.deliveryContext.to) {
            return { sessionKey: pinned.sessionKey, deliveryContext: pinned.deliveryContext };
          }
          const last = ownerSession.get();
          if (last?.deliveryContext?.channel && last.deliveryContext.to) {
            return { sessionKey: last.sessionKey, deliveryContext: last.deliveryContext };
          }
          return null;
        };
        const owner = new RuntimeOwnerNotifier(
          // The SDK's `cfg` is `OpenClawConfig`; the notifier-side port
          // deliberately accepts only `unknown` (the notifier must not know the
          // host config type). The real type is restored here in the host
          // ports, so neither side lies and no cast is needed — the `params.cfg`
          // handed in is the same `api.config` anyway.
          (params) => sendDurableMessageBatch({ ...params, cfg: api.config }),
          api.config,
          resolveNotifyTarget,
          {
            info: (m: string) => api.logger.info(m),
            warn: (m: string) => api.logger.warn(m),
          },
        );
        ownerNotifier = owner;
        // Outbound staging directory for notifications with images: the host will
        // only send local files under its allowed root, and our originals live in
        // popclaw's own data/dm-media (evidence and rationale in the header
        // comment of media-staging.ts).
        const stagingDir = dmMediaStagingDir(api.runtime.state.resolveStateDir());
        // #236: where "why did nothing arrive" gets written down.
        const deliveryFailure = fileDeliveryFailure(paths.deliveryFailureFile());
        const deliverL1 = (dmOnly = false): Promise<void> => {
          // Capture every house before the first target lookup. Queue delivery
          // is independently authorized per batch, including the owner epoch.
          let capture: ReturnType<typeof captureNotificationScopes>;
          try { capture = captureNotificationScopes(houses); }
          catch (error) { api.logger.warn(`popclaw: notification capture failed: ${String(error)}`); return Promise.resolve(); }
          return houses.runCommand(() => notifyOwnerNow({
            notifier: notifier.deliveryView(capture, {dmOnly}),
            owner,
            resolveTarget: resolveNotifyTarget,
            logger: {
              info: (m: string) => api.logger.info(m),
              warn: (m: string) => api.logger.warn(m),
            },
            stageMedia: (p) =>
              stageMediaForSend(p, stagingDir, (err) =>
                api.logger.warn(`popclaw: notify media staging failed (${p}): ${String(err)} — sending the text anyway`),
              ),
            failureStore: deliveryFailure,
          })).then(() => {}).catch((err) => api.logger.warn(`popclaw: notify level=queued reason=threw (${String(err)})`));
        };
        // Fire-and-forget — the SSE / inbox callbacks must never wait on a channel round-trip.
        const pushL1ToOwner = () => { void deliverL1(); };
        return {
          pushL1ToOwner,
          slots: {
            ownerSession,
            ownerNotifier: owner,
            // Exposed as functions so the read happens AFTER the retry, never
            // off a stale snapshot.
            drainNotifications: async () => { await deliverL1(); },
            retryDmNotifications: async () => { await deliverL1(true); },
            notifyBacklog: () => {
              const f = deliveryFailure.get();
              return {
                count: notifier.count(),
                ...(f ? { lastFailureAt: f.at, lastFailureReason: f.reason } : {}),
              };
            },
          },
        };
      },
    },
    agent: {
      // The register-scope client: llm.json → OpenClaw runtime fallback, built
      // lazily on the first completion (the `paths` argument is not needed).
      llm: () => (prompt: string) => input.llmComplete(prompt),
      presenter,
    },
    // A Ranger on every house, always (row 25).
    ranger: { decide: () => true },
    lifecycle: {
      loops: 'host-services',
      // A boot that never finished must not leave its slots behind, nor be
      // memoized: the rejected promise would make the failure permanent for
      // the life of the process. Synchronously, before the drain begins.
      beforeFailedBootCleanup: () => {
        integrityAbort.abort();
        root.l2.clear();
        clearPerProcess('runtime');
      },
      expose: {
        notifier: (forTurn) => root.l2.notifier(forTurn),
        nameOf: (nameOf) => root.l2.nameOf(nameOf),
        pendingFollows: (store) => root.l2.pendingFollows(store),
        proposals: (store) => root.l2.proposals(store),
      },
      recordBootMarkers: (paths) => {
        // Install credential (see the header comment in runtime/last-build.ts):
        // `plugins install` restarts the gateway and kills the agent turn mid-flight,
        // leaving it fragmented — the machine needs a trace saying "popclaw was just
        // installed/upgraded." Written directly with appendSocialLog rather than
        // through the social-log recorder (this event has no actor, so tier_then
        // doesn't apply).
        // Sentinel READMEs (see host/sentinels.ts): intercept the prospector's
        // `find` / `ls` route. Left alone when already present. This is the lazy
        // boot path, not register() (ADR-0035: load ≠ enable).
        try {
          ensureSentinelReadmes(paths);
        } catch (err) {
          api.logger.warn(`popclaw: sentinel README write failed (non-fatal): ${String(err)}`);
        }
        recordBuildOnBoot(paths.lastBuildFile(), build, (from, to) => {
          api.logger.info(`popclaw: plugin upgraded ${from.build} → ${to.build}`);
          appendSocialLog(paths.socialLogDir(), {
            kind: 'plugin_upgraded',
            text: `${from.build} → ${to.build}`,
          });
        });
      },
      reportScrapers: async () => {
        // Plan 10.13: route scrape costs into OpenClaw's structured logger.
        // Plan 10.13.x: surface DegradationDetector failover events via a
        // pino-shape logger adapter (OpenClaw's logger is single-string-arg).
        // Plan 10.14: feed each cost event into BudgetGuard.record() for the
        // soft daily-budget alarm + auto-throttle.
        const pinoStyleLogger = {
          warn: (obj: Record<string, unknown>, msg: string) =>
            api.logger.warn(`popclaw: ${msg} ${JSON.stringify(obj)}`),
          error: (obj: Record<string, unknown>, msg: string) =>
            api.logger.error(`popclaw: ${msg} ${JSON.stringify(obj)}`),
          info: (obj: Record<string, unknown>, msg: string) =>
            api.logger.info(`popclaw: ${msg} ${JSON.stringify(obj)}`),
        };
        const budgetGuard = BudgetGuard.fromEnv(pinoStyleLogger);
        const scraperRegistry = await buildScraperRegistry(
          (event) => {
            api.logger.info(
              `popclaw: cost ${event.providerName} platform=${event.platform} ` +
              `results=${event.resultsCount} usd=${event.estimatedCostUsd.toFixed(6)} ` +
              `latency=${event.latencyMs}ms`,
            );
            budgetGuard.record(event);
          },
          pinoStyleLogger,
        );
        // Plan 10.11 hotfix: tell the operator at startup which platforms the
        // ranger can scrape (drives advertised capabilities + the watch loop).
        // Env vars must be exported BEFORE `openclaw tui` for the plugin's
        // register() to see them — exporting after-the-fact requires a TUI
        // restart. Surfacing this at boot time lets users notice missing creds.
        const platforms = Array.from(scraperRegistry.keys()).sort();
        api.logger.info(
          `popclaw: scraper registry — ${platforms.length === 0 ? '(empty)' : platforms.join(', ')}`,
        );
        const missing: string[] = [];
        if (!process.env.POPCLAW_TWITTERAPI_IO_KEY && !process.env.POPCLAW_APIFY_TOKEN) {
          missing.push('X (set POPCLAW_TWITTERAPI_IO_KEY or POPCLAW_APIFY_TOKEN)');
        }
        if (!process.env.POPCLAW_APIFY_TOKEN) {
          missing.push('Instagram + TikTok (set POPCLAW_APIFY_TOKEN)');
        }
        if (!process.env.POPCLAW_YOUTUBE_API_KEY) {
          missing.push('YouTube (set POPCLAW_YOUTUBE_API_KEY)');
        }
        if (missing.length > 0) {
          api.logger.warn(
            `popclaw: missing scraper creds for: ${missing.join('; ')}. ` +
            `Export the env vars BEFORE starting OpenClaw and restart for scraping to work.`,
          );
        }
      },
      announceInstall: ({ paths, identityGenerated, onboardingCompleted }) => {
        // Install/upgrade echo (issue #270): follows the install credential
        // (recordBootMarkers); evaluated only once both the owner notifier (can
        // deliver) and the onboarding state (knows whether onboarding finished)
        // exist. Fire-and-forget, not awaited: the header note on ADR-0035
        // requires register to stay cheap, and boot completion shouldn't wait on
        // a channel delivery that might hang. Once-only gate =
        // markBuildAnnounced is written back only after actual delivery succeeds
        // (deliverNow returns true); if it doesn't deliver, the next boot retries.
        void (async () => {
          try {
            const lastBuildFile = paths.lastBuildFile();
            const record = readLastBuild(lastBuildFile);
            const text = decideInstallNotice({
              record,
              identityGenerated,
              onboardingCompleted: onboardingCompleted(),
            });
            if (text === null || record === null) return;
            const delivered = await ownerNotifier!.deliverNow(text);
            if (delivered) markBuildAnnounced(lastBuildFile, record.build);
          } catch (err) {
            api.logger.warn(`popclaw: install notice failed (non-fatal): ${String(err)}`);
          }
        })();
      },
      checkIntegrity: ({ paths, houseStores }) => {
        // Boot integrity check (see host/integrity-check.ts): only after every
        // core database is open are all the handles reachable, and the owner
        // notifier is in place by then too — same once-only dedupe as the
        // install echo (the marker is only written back on a real delivery; an
        // undelivered alert retries on the next boot). Equally fire-and-forget:
        // one possibly-hanging channel delivery must not stall boot (ADR-0035).
        void (async () => {
          try {
            const integrityFile = paths.dbIntegrityFile();
            const scan = runIntegrityChecksInProcess({
              dbs: [
                { label: 'social', path: localDatabasePath(host.db) ?? paths.socialDb() },
                ...houseStores.map((h) => ({ label: `lorehouse:${h.slug}`, path: localDatabasePath(h.db) ?? paths.lorehouseDb(h.slug) })),
              ],
              signal: integrityAbort.signal,
              onMeasured: ({pid, results}) => api.logger.info(`popclaw: integrity process ${pid}: ${results.map(row => `${row.label}=${row.elapsedMs.toFixed(1)}ms`).join(', ')}`),
              stateFile: integrityFile,
              build,
              onError: (label, err) =>
                api.logger.warn(`popclaw: integrity check skipped [${label}]: ${String(err)}`),
            });
            // Only the scanner owns a DB-drain resource. Owner-channel delivery
            // stays fire-and-forget, as before; an unavailable channel must not
            // hold shutdown after the child has closed its read handles.
            integrityTask = scan.then(() => undefined, () => undefined)
              .finally(() => { integrityTask = undefined; });
            const findings = await scan;
            if (integrityAbort.signal.aborted || findings.length === 0) return;
            const text = integrityAlertText(findings, paths.backupsDir(), ownerLang());
            // The host's warn/error land on stderr → /dev/null; info is the
            // only channel proven to reach gateway.log (visible-logger.ts). This
            // line must leave a trace, so it goes straight to info.
            api.logger.info(`popclaw: ⚠️ DB INTEGRITY ALERT — ${text.replace(/\n/g, ' | ')}`);
            const delivered = await ownerNotifier!.deliverNow(text);
            if (delivered && !integrityAbort.signal.aborted) markIntegrityAnnounced(integrityFile, findings);
          } catch (err) {
            api.logger.warn(`popclaw: integrity check failed (non-fatal): ${String(err)}`);
          }
        })();
      },
      migrateLegacyFiles: ({ paths, marksStore }) => {
        // One-shot migration: retire favorites.jsonl → marks table (ADR-0019).
        // Guarded: a cosmetic migration failure (e.g. read-only data dir) must
        // not brick plugin boot; the un-renamed file simply retries next start.
        try {
          migrateFavoritesJsonl(input.favoritesFile(paths), marksStore);
        } catch (err) {
          console.warn(`popclaw: favorites.jsonl migration failed (will retry next boot): ${String(err)}`);
        }
        // One-shot migration: canvas-style.md data/ → vault/taste/ (P-004: taste
        // signals belong in the precious tier). Same-style guard: failing to move
        // it must not block startup — retry next boot.
        try {
          migrateStyleNotesToVault(paths.legacyCanvasStyleFile(), paths.canvasStyleFile());
        } catch (err) {
          console.warn(`popclaw: canvas-style.md → vault migration failed (will retry next boot): ${String(err)}`);
        }
      },
      guardedShutdown: {
        markStorageShuttingDown: () => { integrityAbort.abort(); root.markStorageShuttingDown(); },
        resetOwnerApprovals: () => resetOwnerApprovals(),
        snapshotStorageBackups: () => [...root.snapshotStorageBackups(), ...(integrityTask ? [integrityTask] : [])],
      },
      afterShutdown: () => {
        // Hand back what outlives this lifecycle. `openclaw gateway restart`
        // re-registers the plugin in the same process: whatever is still
        // parked on globalThis is what the next registration inherits.
        // The runtime memo would hand it these closed handles (issue #582),
        // and the dispatch table would hand it a paper nobody is writing.
        clearPerProcess('runtime');
        NewspaperDispatchRegistry.clear();
        api.logger.info('popclaw: shutdown complete (streams closed, sqlite handles released)');
      },
    },
    drift: GATEWAY_DRIFT_PINS,
  };
}
