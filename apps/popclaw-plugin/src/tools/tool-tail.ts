import { isLocalInviteCall } from '../invite/local-invite-call.js';
/**
 * The tail every tool result goes through: the unread-pings line, or else at
 * most one settling nudge. `withTail` wraps an api so each registered tool's
 * result gets it appended.
 */

import { houseGuideContextKey } from '../world/house-guide-context.js';
import { optionalWorldOffer } from '../onboarding/optional-world.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { canAppendToolNotice, type ToolNoticeContext } from '../notifier/tool-notice.js';
import { fileLastRun } from '../runtime/last-run.js';
import type { MountedHouse } from '../onboarding/orchestrator.js';
import { isDreamStale } from '../commands/status.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import type { HostAdapter } from '../host/host-adapter.js';
import { listGaps, readBailedAt, tasteSeededOf } from '../onboarding/settling-gaps.js';
import { readNameSource } from '../onboarding/identity-writer.js';
import {
  composeTail,
  isExcludedFromNudge,
  pickNudge,
  readNudgeLedger,
  recordNudgeSent,
  type NudgeCtx,
} from '../onboarding/nudge.js';
import type { RegisterToolsDeps } from './tools-context.js';

/** The minimal surface the tail computation needs from runtime — consistent shape across both hosts (OpenClaw / MCP) is enough. */
interface TailRuntime {
  readonly houseRuntime?: import('../runtime/house-lifecycle/house-runtime.js').HouseRuntime;
  readonly host: HostAdapter;
  readonly boot: { popclawId: string };
  readonly replyPings?: { unreadCount(): number };
  readonly onboardingState?: {
    get(id: string): { stage: string; completed_at: number | null } | null;
  };
  readonly socialGraph?: { following(): readonly unknown[] };
  readonly tasteLoader?: { enabledSources(): Promise<Array<{ path: string; content: string }>> };
  readonly paths?: PopclawPaths;
  readonly houses?: () => readonly MountedHouse[];
  readonly houseStarted?: (slug: string) => boolean;
}

/**
 * Nudge candidate (R1 spec §4): assemble the local facts `listGaps` needs
 * (config / DB counts / file timestamps, zero network, zero LLM), then let
 * `pickNudge` choose one. If any input is missing (test stubs often supply
 * only a minimal runtime) → silently degrades to "no nudge", never breaks the tool itself.
 *
 * `no_verify` needs a live query to the lore-house `/v1/profile` (the path
 * status.ts uses), which conflicts with the "zero network" bar here — the
 * nudge path **does not detect this gap** (`loreHouseReachable: false` keeps
 * it permanently off), and `/popclaw status` still does the network-path
 * detection through its existing route.
 */
async function pickNudgeFor(
  runtime: RegisterToolsDeps['runtime'],
  nowSec: number,
): Promise<{ key: string; line: string } | null> {
  try {
    const rt = (await runtime()) as TailRuntime | undefined;
    if (!rt) return null;
    const row = rt.onboardingState?.get(rt.boot.popclawId) ?? null;
    const ctx: NudgeCtx = { stage: row?.stage ?? null, graduatedAt: row?.completed_at ?? null };
    const [bailedAt, tasteSeeded, nameSource, ledger] = await Promise.all([
      readBailedAt(rt.host),
      tasteSeededOf(rt.tasteLoader),
      readNameSource(rt.host).catch(() => null),
      readNudgeLedger(rt.host),
    ]);
    const dreamStale = rt.paths ? isDreamStale(fileLastRun(rt.paths.dreamerStateFile()).get(), nowSec) : false;
    const gaps = listGaps({
      bailedAt,
      followingCount: rt.socialGraph?.following().length ?? 0,
      tasteSeeded,
      loreHouseReachable: false, // The nudge path is zero-network (see above): no_verify never fires.
      externalVerifiedCount: 0,
      pendingInvitesCount: 0,
      dreamStale,
      nameSource,
      houses: rt.houses?.(),
      houseStarted: rt.houseStarted,
    });
    return pickNudge(gaps, ledger, nowSec, ctx);
  } catch {
    return null;
  }
}

/**
 * The single exit point for the tail (spec §4/§7): unread pings take priority,
 * the nudge only fires when no unread pings surfaced and gates ⑤⑥ both pass.
 * Automatic notices use a sixty-second consumer cooldown, not a turn ID. Wraps all tools in one place, instead of writing
 * this out in each of the 36 execute functions. Any failure in the tail itself
 * is always swallowed: the prompt must never break the real work. Only a nudge
 * that's actually emitted gets recorded (`recordNudgeSent`) — a candidate that
 * was picked but never made it into the returned text doesn't count.
 *
 * Handles BOTH registration shapes. The object form is what most tools use; the
 * factory form `(toolCtx) => toolDef` is what the newspaper pair uses (they read
 * `toolCtx.sessionKey` to tell the dedicated workshop session from the owner's
 * chat, 2026-09-03 cut 1). A factory is resolved here and each tool it yields
 * gets the same tail wrapping — switching a tool to the factory form must never
 * silently cost it the unread-pings line.
 */
export function withTail(
  api: RegisterToolsDeps['api'],
  runtime: RegisterToolsDeps['runtime'],
  runCommand?: RegisterToolsDeps['runCommand'],
  noticeContext?: RegisterToolsDeps['getToolNoticeContext'],
  currentGuideReadScope?: RegisterToolsDeps['currentGuideReadScope'],
): RegisterToolsDeps['api'] {
  /** One tool object with its execute tail-wrapped (non-tools pass through). */
  const wrapToolObject = (tool: unknown): unknown => {
    const t = tool as { name?: unknown; execute?: unknown; captureParameters?: unknown };
    if (typeof t?.execute !== 'function') return tool;
    const inner = t.execute as (...args: unknown[]) => Promise<unknown>;
    const toolName = typeof t.name === 'string' ? t.name : '';
    // Internal opt-in capture runs before an asynchronous command wrapper or
    // lazy runtime getter. Do not expose this function in the host registration.
    const { captureParameters, ...registration } = t;
    return {
      ...registration,
      execute: async (...args: unknown[]): Promise<unknown> => {
        if (isLocalInviteCall(toolName, args[1])) return inner(...args);
        const capturedArgs = typeof captureParameters === 'function'
          ? [args[0], captureParameters(args[1]), ...args.slice(2)] : args;
        const invoke = async (): Promise<unknown> => {
        let result = await inner(...capturedArgs);
        if (!canAppendToolNotice('', result)) return result;
        let context: ToolNoticeContext | undefined;
        try { context = await noticeContext?.(args[2] instanceof AbortSignal ? args[2] : undefined); } catch { /* notice unavailable */ }
        const text = (result as { text?: unknown } | null)?.text;
        if (typeof text === 'string') {
        try {
          let envelope: Record<string, unknown> | undefined;
          try { const parsed = JSON.parse(text); if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') envelope = parsed; } catch { /* ordinary text */ }
          const rt = (await runtime()) as TailRuntime | undefined;
          const guideScope = currentGuideReadScope?.();
          const present = currentGuideReadScope ? guideScope?.isCurrent() ? guideScope.presentGuideKeys : new Set<string>() : undefined;
          const candidates = await rt?.houseRuntime?.pendingHouseGuides(present);
          const pendingNotice = context ? context.store.hasNoticeFor(context) : false;
          const unreadLine = null;
          const nowSec = Math.floor(Date.now() / 1000);
          const pick =
            !pendingNotice && !isExcludedFromNudge(toolName) ? await pickNudgeFor(runtime, nowSec) : null;
          const tail = composeTail({
            unreadLine,
            toolName,
            toolOk: true, // See nudge.ts: composeTail is only called when inner() didn't throw.
            nudgeLine: pick?.line ?? null,
          });
          if (tail && pick && tail === pick.line) {
            const rt = (await runtime()) as TailRuntime | undefined;
            if (rt) await recordNudgeSent(rt.host, pick.key, nowSec);
          }
          // Native scopes defer the final choice until every outer wrapper has
          // finished. Only the consumer that can return commits presence.
          const baseText = text;
          const render = (known: ReadonlySet<string>) => {
            const guides = candidates?.filter(guide => !known.has(houseGuideContextKey(guide)));
            const payload = envelope ? {...envelope} : undefined;
            let output = baseText;
            if (guides?.length) {
              if (payload) {
                payload.house_guide_contexts = guides;
                if (!rt?.houseRuntime?.publicReadGate('https://house.popclaw.world').isActive()) payload.optional_world_offer = optionalWorldOffer(ownerLang());
              } else {
                output += '\n' + JSON.stringify({house_guide_contexts:guides});
                if (!rt?.houseRuntime?.publicReadGate('https://house.popclaw.world').isActive()) output += '\n' + optionalWorldOffer(ownerLang());
              }
            }
            if (payload && tail) payload.tool_tail = tail;
            return {text: payload ? JSON.stringify(payload) : tail ? `${output}\n\n${tail}` : output,
              keys: guides?.map(houseGuideContextKey) ?? []};
          };
          const current = guideScope?.isCurrent() === true;
          const rendered = render(current ? guideScope.presentGuideKeys : new Set<string>());
          result = { ...(result as object), text: rendered.text };
          if (current && rendered.keys.length) {
            if (guideScope.stageGuideEmission) guideScope.stageGuideEmission(rendered.text, render);
            else guideScope.recordEmittedGuideKeys(rendered.keys);
          }
        } catch { /* preserve business result */ }
        }
        return result;
        };
        // Control commands must remain able to enable or disable a house.
        if (toolName === 'popclaw_house_login' || toolName === 'popclaw_house_logout') return invoke();
        return runCommand ? runCommand(invoke) : invoke();
      },
    };
  };
  return {
    ...api,
    registerTool: (tool: unknown, opts?: unknown) => {
      const descriptor = tool as {contextVersion?: number; create?: (ctx: unknown) => unknown};
      if (descriptor?.contextVersion === 2 && typeof descriptor.create === 'function') {
        api.registerTool({...descriptor, create: (ctx: unknown) => {
          const resolved = descriptor.create!(ctx);
          return Array.isArray(resolved) ? resolved.map(wrapToolObject) : wrapToolObject(resolved);
        }}, opts);
        return;
      }
      if (typeof tool !== 'function') {
        api.registerTool(wrapToolObject(tool), opts);
        return;
      }
      const factory = tool as (ctx: unknown) => unknown;
      api.registerTool(
        (ctx: unknown): unknown => {
          const resolved = factory(ctx);
          return Array.isArray(resolved) ? resolved.map(wrapToolObject) : wrapToolObject(resolved);
        },
        opts,
      );
    },
  };
}
