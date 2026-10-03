/**
 * The MCP root's `RuntimePorts`: what differs about the stdio MCP host,
 * handed to the shared runtime assembly (`runtime/assembly`).
 *
 * Built inside the root's lazy build, never at import or tools/list
 * (ADR-0035). Every environment fact is read by a thunk, at the point of boot
 * where `buildRuntime` used to read it. No `node:*` import here: the one fact
 * that needs the filesystem path API (the notification consumer id) is passed
 * in by `mcp.ts`.
 */
import { PopclawPaths } from './popclaw-paths.js';
import { createMcpOwnerAuthorization, type McpOwnerAuthorization, type McpServerBox } from './mcp-owner-authorization.js';
import { worldDuplicateLookup } from '../runtime/world-runtime.js';
import { buildLLMClient } from '../recommend/llm-factory.js';
import type { LLMClient } from '../recommend/llm-client.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import type { pinoHostLogger } from '../runtime/logger.js';
import type { CardPresenter } from '../onboarding/orchestrator.js';
import { assembleRuntime, type AssembledRuntime, type DriftPins, type RuntimePorts } from '../runtime/assembly/index.js';
import { LocalHostAdapter } from './local-host-adapter.js';
import { assertStorageBootstrap, registerStorageRuntime } from './storage-maintenance.js';

/** The MCP-only bag slot: the adapter that asks the owner for a world action. */
export interface McpWorldSlots {
  readonly worldOwnerAuthorization: McpOwnerAuthorization;
}

/**
 * How the iron law of "borrow the host's model" plays out under MCP: MCP has
 * no agent-runtime, so the only leg left is the direct `config/llm.json`
 * connection. When neither leg is available it **must not crash** — throw a
 * human-readable error instead. Each tool's own try/catch degrades to
 * "materials only"; anything uncaught is caught by CallTool's error result
 * (the server is never taken down).
 */
const NO_LLM_MESSAGE = (): string => renderCopy(ownerLang(), 'mcp.noLlm');

function buildMcpLLM(paths: PopclawPaths): (prompt: string) => Promise<string> {
  let cached: LLMClient | null = null;
  const client = (): LLMClient => {
    cached ??= buildLLMClient({
      llmConfigPath: paths.configFile('llm'),
      fallback: () => ({
        complete: async (): Promise<string> => {
          throw new Error(NO_LLM_MESSAGE());
        },
      }),
    });
    return cached;
  };
  return (prompt: string) => client().complete(prompt);
}

/**
 * The MCP root's current values for every drift pin (see `DriftPins` for the
 * table row, owner and deletion condition of each). They reproduce this
 * root's behaviour at 2f857931 exactly; flipping one is a maintenance change,
 * not a refactor.
 */
export const MCP_DRIFT_PINS: DriftPins = Object.freeze({
  followerDisplayNameAbsent: true,
  followerBondContextAbsent: true,
  followerStoreOwnInstance: true,
  replyPingBondContextAbsent: true,
  inviteNotifierUnattributed: true,
  rangerInviteNotifyAbsent: true,
  refreshMs: undefined,
  recoveryIgnoresClosing: false,
  ownerLangSignalsLate: true,
  shutdown: 'first-error-aborts',
});

export function mcpRuntimePorts(input: {
  logger: ReturnType<typeof pinoHostLogger>;
  dataRoot: string;
  storagePaths: PopclawPaths;
  /** Late-bound: assigned inside the host's DB-initialize callback. */
  releaseStorage: () => void;
  serverBox: McpServerBox;
  approvalWindowMs: number | undefined;
  consumerId: () => string;
}): RuntimePorts<McpWorldSlots> {
  const { logger, dataRoot, serverBox, approvalWindowMs } = input;
  const line = (m: string) => logger.info({}, `popclaw: ${m}`);
  const warn = (m: string) => logger.warn({}, `popclaw: ${m}`);
  const presenter: CardPresenter = {
    async present(card) {
      line(`onboarding card presented blocks=${card.blocks.length}`);
    },
  };
  return {
    platform: {
      storagePaths: input.storagePaths,
      paths: () => new PopclawPaths(dataRoot),
      releaseStorage: () => input.releaseStorage(),
      defaultStateDir: () => './.data',
      publicWorldStream: () => process.env['POPCLAW_WORLD_STREAM'] === 'public-v1',
      worldStreamMode: () => process.env['POPCLAW_WORLD_STREAM'] === '1',
      // No host config under MCP, so no speechLocale — the env signals still apply.
    },
    log: {
      info: line,
      warn,
      error: (m: string) => logger.error({}, `popclaw: ${m}`),
      plain: { info: (m) => logger.info({}, m), warn: (m) => logger.warn({}, m) },
      identity: (boot) => {
        // On stderr, but it MUST survive. info, not warn: this host's
        // warn/error go nowhere the owner can read (see keystore.ts).
        if (boot.identityGenerated) {
          logger.info(
            { popclaw_id: boot.popclawId },
            '★★★ NEW IDENTITY CREATED — no master.key existed; expected ONLY on first run. ' +
              'Otherwise check POPCLAW_DATA_ROOT: the old identity cannot be recovered or revoked.',
          );
        } else {
          logger.info({ popclaw_id: boot.popclawId }, 'identity loaded (restored existing key)');
        }
      },
      // Row 30: this root logs both levels of the relation chain as info.
      relation: { info: (m: string) => line(m), warn: (m: string) => line(m) },
      bootMigration: warn,
      dmPolicy: warn,
      handshake: { info: line, warn },
      inviteWatch: { info: line },
      onboardingCanvas: { warn },
      lateStoreOpen: line,
    },
    world: {
      // The owner confirmation lane. The adapter is the presence flag the
      // runtime's capability projection reads; the grant itself is per tool
      // call (`bindMcpWorldInvoke` in mcp.ts). The Server does not exist yet —
      // the box is filled right after `new Server(...)`. The duplicate check
      // comes from the runtime's own owner-action ledger, read lazily. The
      // SAME window as the send-approval dialog: read once in `main`.
      lane: ({ actorId, worlds }) => {
        const ownerAuthorization = createMcpOwnerAuthorization({ actorId, server: serverBox,
          elicitTimeoutMs: approvalWindowMs,
          duplicates: worldDuplicateLookup(worlds) });
        return { ownerAuthorization, stop: () => ownerAuthorization.stop(), slots: { worldOwnerAuthorization: ownerAuthorization } };
      },
      // Row 23: the MCP root reads the world over the public read lane.
      snapshotFetch: (houses, origin) => houses.houseReadFetch(origin),
      clientFetch: (houses, origin) => houses.houseReadFetch(origin),
    },
    // No proactive push under MCP: notifications are pulled on the spot by
    // `popclaw_notifications` under this consumer.
    delivery: { kind: 'pull', consumerId: input.consumerId },
    agent: { llm: buildMcpLLM, presenter },
    ranger: {
      // The ranger role is **off by default** (owner's ruling, 2026-07-28). A
      // ranger is a public role on the network: once up, it accepts
      // verification/scraping tasks dispatched by the lore-house, and (under
      // ranger_mode) heartbeat-broadcasts its own capacity. An MCP session has
      // neither scraping credentials nor a stable lifetime — it lives and dies
      // with the chat window — so accepting tasks can only fail or abstain.
      // **Capacity you don't have, you don't advertise.** Running a
      // credentialed ranger inside an MCP session is a rare but legitimate use
      // case → enable it with an explicit env var. fail-closed: only the
      // literal 'true' counts.
      decide: () => {
        const rangerEnabled = process.env['POPCLAW_MCP_ENABLE_RANGER'] === 'true';
        line(rangerEnabled ? 'mode=ranger — house lifecycle owns task resources' : 'mode=citizen (consumer-only)');
        return rangerEnabled;
      },
    },
    lifecycle: { loops: 'inline' },
    drift: MCP_DRIFT_PINS,
  };
}

/** The MCP root's runtime bag: the assembled runtime with this root's world slot. */
export type McpPluginRuntime = AssembledRuntime<McpWorldSlots>;

/**
 * The MCP root's lazy build: the storage check BEFORE the host exists, the
 * host whose DB-initialize callback yields the storage release, then this
 * root's ports into the shared assembly. `src/mcp.ts` `buildRuntime` is this
 * call and nothing else; it resolves the two facts that need `node:path`
 * (the data root and the notification consumer) and passes them in.
 */
export async function buildMcpRuntime(input: {
  logger: ReturnType<typeof pinoHostLogger>;
  closing: AbortSignal;
  serverBox: McpServerBox;
  approvalWindowMs: number | undefined;
  /** Absolute POPCLAW_DATA_ROOT, validated by the root. */
  dataRoot: string;
  consumerId: () => string;
}): Promise<McpPluginRuntime> {
  const { logger, dataRoot } = input;
  const storagePaths = new PopclawPaths(dataRoot);
  assertStorageBootstrap(storagePaths);
  let releaseStorage!: () => void;
  const host = new LocalHostAdapter({ dataRoot, logger,
    beforeDbInitialize: db => (releaseStorage = registerStorageRuntime(db, storagePaths)) });
  return assembleRuntime(host, mcpRuntimePorts({ logger, dataRoot, storagePaths, releaseStorage: () => releaseStorage(),
    serverBox: input.serverBox, approvalWindowMs: input.approvalWindowMs, consumerId: input.consumerId }), input.closing);
}
