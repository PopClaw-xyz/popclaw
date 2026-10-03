// Evaluation-order imports: these modules were evaluated BEFORE the stdout
// guard below at 2f857931, when this file still assembled the runtime inline.
// Moving that wiring to runtime/assembly must not shrink or grow the window a
// module-evaluation stdout write could hit; changing it is the maintenance
// item the refactor ruling (2026-09-29 §7) hands to DEV, not part of the move.
import './social-graph/relation-assembly.js';
import { resolve } from 'node:path';
import './ingress/public-feed-display.js';
import './host/storage-maintenance.js';
import './host/execution-store.js';
import { ownerConfirmedWorldInvoke, worldDeclaredActionParameters } from './runtime/world-runtime.js';
import './host/mcp-owner-authorization.js';
import type { McpServerBox } from './host/mcp-owner-authorization.js';
import { createMcpOwnerApproval, ownerApprovalTimeoutFromEnv } from './host/mcp-owner-approval.js';
import './world/world-capabilities.js';
import { createLazyRuntime } from './runtime/lazy-runtime.js';
import { isLocalNotification, notificationOrigin } from './runtime/house-lifecycle/notification-scope.js';
import type { NotificationItem } from './notifier/types.js';
import { assertHouseActionActive } from './runtime/house-lifecycle/action-context.js';
import './runtime/house-lifecycle/house-runtime.js';
/**
 * popclaw MCP server — the THIRD composition root (peer of `index.ts` for
 * OpenClaw and `main.ts` for the dev CLI).
 *
 * Exposes the same ~45 popclaw tools over stdio MCP, so any MCP-capable agent
 * host (Claude Code / Codex / Cursor / Hermes / …) can carry the same passport.
 * Assembly is main.ts's (LocalHostAdapter + PopclawPaths + bootstrapPlugin);
 * the tool surface comes from `registerPopclawTools` fed a COLLECTOR api — the
 * same structural `{ registerTool }` shape the OpenClaw SDK satisfies, so the
 * tools are exported verbatim with zero per-host duplication. Their typebox
 * `parameters` ARE JSON Schema, so they pass straight through as `inputSchema`.
 *
 * ⚠️ STDOUT IS THE PROTOCOL CHANNEL. Anything written to fd 1 that is not a
 * JSON-RPC frame corrupts the session. Two guards, both at the very top of this
 * file, because a per-caller audit can never stay true as dependencies change:
 *   1. `process.stdout.write` is swapped to stderr; the transport keeps the ONLY
 *      handle to the real fd 1 (catches console.log anywhere in the boot path).
 *   2. pino is pointed at fd 2 (it writes via fs.writeSync, bypassing guard 1).
 *
 * v1 scope: no daemon, no cron, no proactive push, no interactive cards.
 */

// GUARD 1 — MUST stay the first import: it runs before every other module is
// evaluated, so an import-time stdout write is caught too.
import { protocolStdout } from './runtime/stdout-to-stderr.js';
import { buildMcpRuntime, type McpPluginRuntime } from './host/mcp-runtime-ports.js';

import pino from 'pino';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { PopclawPaths } from './host/popclaw-paths.js';
import { createDraftReviewFiles } from './host/draft-review-files.js';
import { DRAFT_TTL_MS } from './tools/draft-store.js';
import { pinoHostLogger } from './runtime/logger.js';
import { ownerLang, failureText } from './lexicon/owner-language.js';
import { languageDirective } from './lexicon/directive.js';
import { mountedHouseGuides } from './world/house-handshake.js';
import { ResolveClient } from './world/resolve-client.js';
import { registerPopclawTools } from './tools/register-tools.js';
import { fetchImageOverHttp } from './visual/fetch-image.js';
import { dispatchMcpCall, makeToolCollector, toMcpToolListing, toMcpToolResult } from './tools/mcp-adapter.js';
import { inboundMediaDirsFromEnv } from './notifier/media-staging.js';
import { unreadNotice, makeNotificationsTool } from './notifier/mcp-notice.js';
import type { ProposalLiveness } from './notifier/l2-handoff.js';
import { composeTail } from './onboarding/nudge.js';
import type { NameChain } from './identity/person-name.js';
import type { Notifier } from './notifier/notifier.js';

declare const __POPCLAW_BUILD__: string;
const POPCLAW_BUILD =
  typeof __POPCLAW_BUILD__ !== 'undefined' ? __POPCLAW_BUILD__ : 'dev (unbundled)';

// ───────────────────────────────────────────────────────────────────────────
// Composition root plumbing (mirrors main.ts / index.ts; node:* lives here).
// ───────────────────────────────────────────────────────────────────────────

function notificationConsumerId(): string {
  return process.env['POPCLAW_NOTIFICATION_CONSUMER'] || `mcp:${resolve(process.cwd())}`;
}

function mcpRoot(): string {
  const root = process.env['POPCLAW_DATA_ROOT'];
  if (!root || resolve(root) !== root) throw new Error('Set POPCLAW_DATA_ROOT to an absolute vault root before using PopClaw MCP');
  return root;
}

/**
 * The MCP root's lazy build. Everything this root used to type inline is the
 * shared runtime assembly now (`runtime/assembly`), fed this root's ports
 * (`host/mcp-runtime-ports.ts`); what stays here are the two facts that need
 * `node:path` — the data root and the notification consumer.
 */
async function buildRuntime(logger: ReturnType<typeof pinoHostLogger>, closing: AbortSignal, serverBox: McpServerBox,
  approvalWindowMs: number | undefined): Promise<McpPluginRuntime> {
  return buildMcpRuntime({ logger, closing, serverBox, approvalWindowMs, dataRoot: mcpRoot(), consumerId: notificationConsumerId });
}

async function main(): Promise<void> {
  const logger = pinoHostLogger(
    (process.env['LOG_LEVEL'] as pino.Level | undefined) ?? 'info',
    // GUARD 2: pino writes with fs.writeSync(fd), bypassing guard 1 entirely.
    pino.destination(2),
  );
  logger.info({ build: POPCLAW_BUILD, data_root: mcpRoot() }, 'popclaw-mcp starting');

  // Boot is lazy for the same reason index.ts's is (ADR-0035): listing tools
  // must be cheap. A client that only calls tools/list opens no socket.
  // Late-bound on purpose: the tool surface is registered before `new Server(...)`.
  const serverBox: McpServerBox = {};
  // Read once, here, and handed to BOTH owner dialogs so they cannot disagree.
  const approvalWindowMs = ownerApprovalTimeoutFromEnv(process.env, logger);
  const lifecycle = createLazyRuntime((signal) => buildRuntime(logger, signal, serverBox, approvalWindowMs).catch(error => {
    logger.error({}, `popclaw: bootstrap failed — ${String(error)}`);
    throw error;
  }));
  const runtime = () => lifecycle.get();
  const stop = () => {
    void lifecycle.stop().then(() => process.exit(0), error => {
      logger.error({}, `popclaw: shutdown failed — ${String(error)}`);
      process.exit(1);
    });
  };
  // Install before connect or the first tool can begin initialization.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
  process.stdin.once('end', stop);

  const { api, tools } = makeToolCollector((m) => logger.info({}, m));
  registerPopclawTools({
    api,
    runtime,
    runCommand: async work => (await runtime()).houseRuntime.runCommand(work),
    getHouseCommandContext: async () => { const rt = await runtime(); return {coordinator: () => rt.houseRuntime.commands, lang: ownerLang,
        readAgentContext: (origin: string, sessionId: string) => rt.houseRuntime.readAgentContext(origin, rt.boot.popclawId, {}, sessionId)}; },
    // The same host capability the OpenClaw gateway injects (index.ts). Without it
    // the newspaper's avatar deps are never assembled at all, and an MCP-published
    // paper is the one that still has to reach a third party for its faces. Injected
    // rather than reached for, so a unit test that wires nothing stays off the network.
    fetchImage: fetchImageOverHttp,
    // #585: the bridge has no host convention to derive an inbound-media path
    // from, so whoever runs it can name the directories
    // (POPCLAW_INBOUND_MEDIA_DIRS). Unset is fine — popclaw_recent_attachments
    // registers either way and says which case it is.
    inboundMediaDirs: inboundMediaDirsFromEnv(process.env),
    // Long drafts' read-only review copies (tools/draft-review.ts): this root
    // only, because a chat link to a local file is what the MCP desktop host
    // was shown to open. Built at this root's first draft, never at
    // initialize (ADR-0035: tools/list touches no disk), and then once:
    // building it clears stale copies an earlier process left (older than a
    // draft can live). A directory that cannot be made leaves this root
    // without copies (long drafts then get the whole-text dialog, as before)
    // rather than stopping the root.
    draftReviewFiles: ((): (() => ReturnType<typeof createDraftReviewFiles> | null) => {
      let built: { files: ReturnType<typeof createDraftReviewFiles> | null } | undefined;
      return () => {
        if (built) return built.files;
        try {
          built = { files: createDraftReviewFiles(new PopclawPaths(mcpRoot()).draftReviewDir(), {
            staleAfterMs: DRAFT_TTL_MS, warn: (message) => logger.warn({}, message),
          }) };
        } catch (error) {
          logger.warn({}, `popclaw: draft review directory unavailable — ${String(error)}`);
          built = { files: null };
        }
        return built.files;
      };
    })(),
    getOrchestrator: () => runtime().then((rt) => rt.orchestrator),
    getWorldCommandContext: async () => (await runtime()).worldRuntime,
    // The peer of index.ts's own source. This root has no cheap live handle,
    // and it does not need one: asking is already asynchronous here (the root
    // awaits the elicitation before it dispatches the body), and the body is
    // about to resolve the very same runtime a moment later.
    declaredWorldActionParameters: async (house, kind) => {
      const rt = await runtime();
      return worldDeclaredActionParameters(rt.worldRuntime, rt.boot.popclawId)(house, kind);
    },
    // The MCP peer of index.ts's `bindNativeWorldInvoke`: one tool call, one
    // owner confirmation, one per-call command context that dies with the call.
    bindMcpWorldInvoke: () => async (callId, input, signal, work) => {
      const rt = await runtime();
      // Both joints live in world-runtime.ts, exported and tested: this file is
      // imported by no test, so a wrong slice or a wrong input passed here used
      // to be caught by nothing.
      return ownerConfirmedWorldInvoke(rt.worldOwnerAuthorization, rt.worldRuntime)(callId, input, signal, work);
    },
    getWorldDeps: async () => {
      const rt = await runtime();
      return {
        guideClient: rt.guideClient,
        summaryClient: rt.summaryClient,
        snapshotClient: rt.worldFeedCache,
        resolveClient: new ResolveClient({ baseUrl: rt.boot.loreHouseUrl, fetch: rt.houseRuntime.houseReadFetch(rt.boot.loreHouseUrl) }),
        webBaseUrl: rt.boot.webBaseUrl,
        // ADR-0041: the primary house's guide ([0]) is pulled live via
        // guideClient; every other mounted house reads the handshake cache.
        // Without this slot only the primary house is ever described — every
        // other mounted house reads as if it were never mounted (which is how
        // the MCP side has always behaved).
        mountedGuides: () => mountedHouseGuides(rt.paths, rt.boot.loreHouseUrls.slice(1)),
      };
    },
  });
  // L2 in-code half: a first-class notifications tool. Sourced from the same
  // runtime notifier the piggyback reads, so both agree on "unread".
  const getNotifier = async (): Promise<Notifier> => {
    const rt = await runtime();
    if (!rt.houseRuntime.storageAllows('notifications')) throw new Error('STORAGE_RECOVERY_HELD: notifications; local inbox history remains available');
    return rt.notifier;
  };
  // The single name chain: alias > self-reported name > handle. Notification
  // rendering must use the **current** form of address, not one baked in at
  // the moment it was queued (an alias the owner adds later must also
  // count). Fall back to the name in the payload if it can't be resolved.
  const getNameOf = async (): Promise<NameChain | undefined> => {
    try {
      return (await runtime()).nameOf;
    } catch {
      return undefined;
    }
  };
  // The settled-proposal drop: a bond_proposal
  // decided between enqueue and hand-off must not reach the owner as a fresh
  // suggestion. Unreachable store → no liveness check, items as-is.
  const getProposals = async (): Promise<ProposalLiveness | undefined> => {
    try {
      return (await runtime()).proposalsStore;
    } catch {
      return undefined;
    }
  };
  // `popclaw_notifications` / `popclaw_acknowledge_notifications` are MCP-surface
  // ONLY: they exist because inside an MCP host PopClaw cannot push anything and
  // has to be pulled by the agent. On the OpenClaw surface the plugin delivers
  // notices itself, so these two have no `registerTool` counterpart — and they are
  // therefore deliberately absent from `openclaw.plugin.json` `contracts.tools`,
  // which declares the OpenClaw plugin surface only. Declaring them there would put
  // two tools into the model's table that no registration ever backs (the inverse of
  // the three-tables rule: a manifest entry with no registration is dead config the
  // host's plugins doctor will flag). Pinned by tests/unit/tools/register-tools-count.test.ts.
  tools.push(makeNotificationsTool(getNotifier, getNameOf, getProposals, { id: notificationConsumerId(), store: async () => (await runtime()).notifier }));
  tools.push({
    name: 'popclaw_acknowledge_notifications',
    description: 'Acknowledge only the notification IDs already handed to this session. This records a host handoff, never human read or request completion.',
    parameters: { type: 'object', properties: { notification_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 100 } }, required: ['notification_ids'] },
    execute: async (_id, params) => {
      const ids = (params as { notification_ids?: unknown }).notification_ids;
      if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid notification IDs');
      const acknowledged = (await runtime()).notifier.acknowledgeFor(notificationConsumerId(), ids);
      return { type: 'text', text: JSON.stringify({ acknowledged, consumer_id: notificationConsumerId() }) };
    },
  });

  // The host-specific notification tools join the same shutdown drain as the
  // shared business tools, including their asynchronous context lookups.
  for (const [index, tool] of tools.entries()) {
    if (!['popclaw_notifications', 'popclaw_acknowledge_notifications'].includes(tool.name)) continue;
    const execute = tool.execute.bind(tool);
    tools[index] = {...tool, execute: async (id, params) => (await runtime()).houseRuntime.runCommand(() => execute(id, params))};
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  logger.info({ tools: tools.length }, 'popclaw-mcp tool surface ready');

  const server = new Server(
    { name: 'popclaw', version: POPCLAW_BUILD },
    {
      capabilities: { tools: {} },
      // §3.5 L2 "session-opening injection" via the one hook MCP itself gives us: initialize's
      // `instructions`. Per-host session-start recipes (Claude Code SessionStart
      // hook, Codex AGENTS.md, Hermes on_session_start) are DOCUMENTATION for a
      // later step — see workplan §3.5 — not written here.
      // LLM-facing (the host agent reads it), so English is the only source —
      // languageDirective is what makes it speak to the owner in their language.
      // These sentences are the canonical copy: an MCP host may never load the
      // plugin's SKILL.md at all, so this string stays self-contained and the
      // skill quotes it (skills/popclaw-social/SKILL.md, "If you are on an MCP
      // host"). tests/unit/skills/skill-md.test.ts fails if the two drift apart
      // — edit here and the skill in the same change.
      instructions:
        'popclaw is the owner\'s social steward. At the start of a session, call ' +
        'popclaw_notifications first to pull whatever is waiting and relay it to the owner. After that, ' +
        'whenever a tool result carries the "📬 … pending" reminder line, call popclaw_notifications again ' +
        'and pass the contents on — inside an MCP host popclaw cannot push anything itself, it depends on ' +
        'you to relay.\n\n' +
        languageDirective(),
    },
  );
  // From here on the adapter can reach the connected client's capabilities.
  serverBox.current = server;
  // The owner-approval seam's MCP backend: this root asks BEFORE it dispatches
  // a body, which is the same event order the OpenClaw host produces by
  // suspending the call. Installed here, after the client is reachable,
  // because whether we can ask at all depends on the client's capabilities.
  // It serves tools that registered a subject. `popclaw_world_invoke` is NOT
  // one of them on this root, and that is deliberate rather than incidental:
  // it asks the owner itself, inside its body, through its own reviewed
  // elicitation route, so a subject registered here would show the owner two
  // dialogs for one action — and because that body never calls
  // `consumeOwnerApproval`, the answer to the first one would decide nothing.
  // `src/tools/world-interaction-tools.ts` therefore declares that subject on
  // the native root only, and says why at the registration itself. A body
  // that takes an answer and consumes nothing is now REPORTED by this
  // backend rather than passing silently.
  //
  // THE WINDOW is the seam's default unless the owner set
  // `POPCLAW_OWNER_APPROVAL_TIMEOUT_SECONDS` (bounded; a bad value is logged
  // and ignored). AND `onerror` IS SET for one reason: an answer that arrives
  // after the window closed is otherwise dropped by the SDK without a trace.
  // It is reported, content-free, and never honoured.
  const approvals = createMcpOwnerApproval({ server: serverBox, logger, elicitTimeoutMs: approvalWindowMs });
  server.onerror = (error) => approvals.noteProtocolError(error);
  // Each entry carries its MCP ToolAnnotations (src/tools/tool-annotations.ts),
  // which is what a host's permission heuristics read before a call.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(toMcpToolListing) }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return { content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }], isError: true };
    }
    try {
      const rt = await runtime();
      // ONE call identity, derived once and used by both halves. The tool body
      // is given its id by `dispatchMcpCall`, which rebuilds it from
      // `requestId`; handing that call the id we already derived is what makes
      // the two provably the same string. Deriving it twice would diverge the
      // moment a host sends an id the sanitiser rejects, because the fallback
      // is a timestamp — and every approval would then fail to be found.
      const callRef = approvals.callRef(extra);
      const requestId = callRef.slice('mcp_'.length);
      const dispatch = async () => {
        // Asks only if this tool registered a subject, then dispatches; a tool
        // with no subject is dispatched with no prompt at all. The ORDER lives
        // inside `aroundDispatch` because no test can import this file.
        const result = await approvals.aroundDispatch(tool.name, req.params.arguments, callRef, extra.signal,
          () => dispatchMcpCall(tool, req.params.arguments, { requestId, signal: extra.signal }));
        const response = toMcpToolResult(result);
        const content = response.content;
        // L1 piggyback: a SEPARATE content block appended after the tool's own
        // result — the primary block stays byte-identical. Reflects (count), never
        // clears (drain). Unread = L1 ∪ L2; L3 (recommendations) rides the paper.
        // The tool already booted the runtime, so getNotifier() is already resolved.
        //
        // Routed through the shared `composeTail` (R1 spec §4) for a single decision
        // surface across both host faces — the "by the way" nudge itself is already handled inside
        // `registerPopclawTools`' own tail wrapper (folded into the primary block's
        // `text`), so `nudgeLine` here is always null: this call is pass-through,
        // never a second nudge.
        try {
          const notices = rt.notifier;
          const eligible = (item: NotificationItem) => {
            if (!rt.houseRuntime.storageAllows('notifications')) return false;
            if (isLocalNotification(item)) return true;
            const origin = notificationOrigin(item, rt.houseRuntime);
            if (!origin) return false;
            try { assertHouseActionActive(origin); return true; } catch { return false; }
          };
          const notice = unreadNotice(notices.countFor(notificationConsumerId(), 'L1', eligible), notices.countFor(notificationConsumerId(), 'L2', eligible));
          const tail = composeTail({ unreadLine: notice, toolName: tool.name, toolOk: true, nudgeLine: null });
          if (tail) content.push({ type: 'text' as const, text: tail });
        } catch (err) {
          logger.warn({ tool: tool.name }, `popclaw: unread piggyback skipped — ${String(err)}`);
        }
        return response;
      };
      return await rt.houseRuntime.runCommand(dispatch);
    } catch (err) {
      // A throwing tool becomes an MCP tool error — never a dead server.
      logger.warn({ tool: tool.name }, `popclaw: tool failed — ${String(err)}`);
      return {
        content: [{ type: 'text' as const, text: failureText(tool.name, err instanceof Error ? err.message : err) }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport(process.stdin, protocolStdout));
  logger.info({}, 'popclaw-mcp connected on stdio');
  if (process.env['POPCLAW_RECEIVE_ON_START'] === '1') void runtime().catch(() => {});
}

// Unconditional: this module IS the `popclaw-mcp` bin's entry point and is never
// imported (the unit-testable half lives in tools/mcp-adapter.ts — importing this
// file would install the process-wide stdout guard). No main.ts-style
// `import.meta.url === argv[1]` check: on macOS /tmp is a symlink to /private/tmp,
// so that comparison silently fails and the server exits 0 having done nothing.
main().catch((err) => {
  process.stderr.write(`popclaw-mcp fatal: ${String(err)}\n`);
  process.exit(1);
});
