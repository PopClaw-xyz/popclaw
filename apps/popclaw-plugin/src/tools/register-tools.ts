/**
 * Register all popclaw tools with the OpenClaw plugin SDK so the main
 * agent can invoke them via natural-language reasoning. Each tool is a
 * thin wrapper around the corresponding runXxxCommand handler.
 *
 * For write-class tools (reply/message/decide), tool returns a draft +
 * draft_token; agent must call popclaw_send_draft after explicit
 * user confirmation to execute.
 *
 * This module is the INDEX: the tools themselves live in the per-domain
 * `*-tools.ts` modules next to it, and the call order below IS the
 * registration order the agent sees (pinned by a test — do not reorder).
 *
 * See: docs/superpowers/specs/2026-05-17-popclaw-command-surface-design.md
 */

import { type RegisterToolsDeps, type ToolsCtx } from './tools-context.js';
import { registerNotificationTools } from './notification-tools.js';
import { withNativeToolNotice } from './mcp-adapter.js';
import { withTail } from './tool-tail.js';
import { registerReadTools } from './read-tools.js';
import { registerStubTools, registerMoreStubTools } from './stub-tools.js';
import { registerWriteTools } from './write-tools.js';
import { registerOnboardingAgentTools } from './onboarding-agent-tools.js';
import { registerWorldTools } from './world-tools.js';
import { registerInviteTools } from './invite-tools.js';
import { registerMarkTools } from './mark-tools.js';
import { registerNameTasteTools } from './name-taste-tools.js';
import { registerFeedbackCadenceTools } from './feedback-cadence-tools.js';
import { registerHouseTools } from './house-tools.js';
import { registerWorldInteractionTools } from './world-interaction-tools.js';
import { registerHouseEntryTools } from './house-entry-tools.js';

/**
 * Hidden tools (ADR-0044 §3): flagged as `toolMetadata.<tool>.optional = true`
 * in the manifest, the host only puts them into the model's tool table when a
 * session's `toolsAllow` explicitly names them. No functionality is lost —
 * every one of them has its own slash-command fallback — they just no longer
 * take up an attention slot in everyday conversation.
 *
 * This list must match openclaw.plugin.json's toolMetadata word-for-word
 * (pinned down by a unit test), and LEXICON entries must never point at them:
 * a routing hint pointing at a tool the model can't see just teaches it to
 * make things up (ADR-0044 §8's revision of ADR-0043).
 */
export const OPTIONAL_TOOLS: readonly string[] = [
  'popclaw_list_pending_proposals',
  'popclaw_show_dream_review',
  'popclaw_search_feed',
  'popclaw_mark',
  'popclaw_unmark',
  'popclaw_show_marks',
  'popclaw_set_name',
];

/**
 * Every register<Domain>Tools call, in the exact order the agent's tool
 * listing follows — pinned by tests/unit/tools/register-tools.test.ts. Do
 * not reorder. Single source of truth so the counting pass below (which
 * runs this same sequence against a throwaway api) can never drift from the
 * real one.
 */
const REGISTER_STEPS: ReadonlyArray<(ctx: ToolsCtx) => void> = [
  registerReadTools,
  registerStubTools,
  registerWriteTools,
  registerMoreStubTools,
  registerOnboardingAgentTools,
  registerWorldTools,
  registerInviteTools,
  registerMarkTools,
  registerNameTasteTools,
  registerFeedbackCadenceTools,
  registerHouseTools,
  registerWorldInteractionTools,
  // Gated on nothing: minting a home-entry link needs the owner's key, the
  // host database and the mounted-house list, all of which every
  // tool-registering root already has. A gate here would mean the tool is
  // absent on some root while `contracts.tools` still declares it — and the
  // agent would improvise a link instead of hearing a refusal.
  registerHouseEntryTools,
  registerNotificationTools,
];

/**
 * Counts what a registration pass actually pushes through `registerTool`,
 * unwrapping array/factory forms the same way mcp-adapter.ts's
 * makeToolCollector does (a factory is resolved with an empty context —
 * under MCP there is no sessionKey either, and the newspaper pair already
 * treats that as "not a workshop session"). Registration is required to stay
 * I/O-free (ADR-0035), so running the whole sequence twice — once to count,
 * once for real — is cheap.
 */
function countRegistrations(deps: RegisterToolsDeps): number {
  let count = 0;
  const countingApi: RegisterToolsDeps['api'] = {
    registerTool: (tool: unknown, opts?: unknown) => {
      // A factory registered with a name hint is one tool; counting it from the
      // hint keeps the pass free of side effects (a world-invoke factory binds
      // native authority to the host's real context the moment it resolves).
      const hinted = (opts as { name?: unknown } | undefined)?.name;
      if (typeof hinted === 'string' && (typeof tool === 'function' || (tool as {contextVersion?: number})?.contextVersion === 2)) {
        count += 1;
        return;
      }
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({}) : tool;
      for (const item of Array.isArray(resolved) ? resolved : [resolved]) {
        const t = item as { name?: unknown; execute?: unknown } | null;
        if (typeof t?.name === 'string' && typeof t.execute === 'function') count += 1;
      }
    },
  };
  // `deps.api` too: feed-tools' local-display helper registers on the raw api
  // (bypassing the tail wrapper on purpose), and the count must see that path
  // as well — and must never touch the real api during the counting pass.
  const ctx: ToolsCtx = { api: countingApi, runtime: deps.runtime, deps: { ...deps, api: countingApi }, total: 0 };
  for (const step of REGISTER_STEPS) step(ctx);
  return count;
}

/** Returns the number of tools actually registered this process (varies with
 *  which lazy deps — onboarding/world/house — were provided). `/popclaw doctor`'s
 *  verdict table reads this
 *  back via the caller's captured return value (see index.ts), and
 *  popclaw_feedback's doctor report reads it via ctx.total — a real
 *  per-process count of what registerTool was actually called with, not a
 *  decorative constant. */
export function registerPopclawTools(deps: RegisterToolsDeps): number {
  const { runtime } = deps;
  const total = countRegistrations(deps);
  const registrationApi = deps.nativeToolNotices && deps.getToolNoticeContext
    ? withNativeToolNotice(deps.api, deps.getToolNoticeContext) : deps.api;
  const api = withTail(registrationApi, runtime, deps.runCommand, deps.getToolNoticeContext);
  const ctx: ToolsCtx = { api, runtime, deps: {...deps, api: registrationApi}, total };

  for (const step of REGISTER_STEPS) step(ctx);

  api.logger?.info(`popclaw: registered ${total} typed tools with OpenClaw main agent`);
  return total;
}
