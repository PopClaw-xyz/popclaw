/**
 * The owner-approval seam's two OpenClaw typed hooks, as host wiring only:
 * `before_tool_call` (ask the owner; the surface flag is claimed only once the
 * host accepted the handler) and `after_tool_call` (report-only). The seam's
 * rules — grants, origins, records — stay in host/owner-approval.ts; this is
 * the OpenClaw counterpart of the MCP root's approval backend.
 *
 * Takes the plugin api object itself and calls `api.on(...)` on it, so the
 * host sees the same receiver as before. `api.logger` must be the
 * visibleLogger-wrapped one index.ts builds.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import {
  ownerApprovalAfterToolCall,
  ownerApprovalBeforeToolCall,
  reportOwnerApprovalOriginRefusal,
  setOwnerApprovalSurface,
} from './owner-approval.js';

export function registerOpenClawOwnerApprovalHooks(api: Pick<OpenClawPluginApi, 'on' | 'logger'>): void {
  // The owner-approval seam's OpenClaw backend: one typed hook.
  //
  // The subject it asks about is declared beside the world tool itself
  // (`src/tools/world-interaction-tools.ts`), the one place BOTH composition
  // roots reach. It was declared here for one round, and that is exactly why
  // the MCP root's registry was empty and its backend inert. Do not move it
  // back, and do not add a second call site.
  //
  // ⚠️ SAME TWO-TABLE TRAP as #374 (the note on before_dispatch in index.ts): `api.on` is the typed-hook surface
  // (`registry.typedHooks`), `api.registerHook` is the other, internal table
  // whose handlers are NEVER called, with no error and a cheerful ✓ Ready in
  // `openclaw hooks info`. `before_tool_call` is in `PluginHookName`
  // (`dist/agent-harness-runtime-BvaKEkqR.d.ts:1269`) and is emitted only
  // through the typed runner — so this MUST stay `api.on`.
  //
  // The surface flag is set only AFTER the host accepted the handler.
  // Nothing else is allowed to claim this host can ask a human: an
  // unregistered hook that advertised itself would report actions ready and
  // then refuse every one of them at the gate.
  try {
    api.on('before_tool_call', async (event, ctx) => {
      const request = await ownerApprovalBeforeToolCall(event, ctx);
      // THE ONE PLACE A REFUSED ORIGIN BECOMES VISIBLE TO AN OPERATOR.
      // The guard's named reason reaches the agent (`nativeWorldInvoke`
      // appends it to whatever the policy lane said) and reached nobody
      // else: the seam and the route module hold NO logger, on purpose,
      // and the registration line below is written once at boot, never per
      // call. So a draft refused in the owner's own chat left nothing in
      // gateway.log to grep, and the only account of it was the agent's.
      //
      // `api.logger` here is the `visibleLogger`-wrapped one (index.ts `register()` builds it):
      // `warn` is re-emitted on `info` with a `popclaw[warn]:` prefix,
      // because the gateway's stderr goes to /dev/null and `info` is the
      // only channel confirmed to reach the log file. Do not reach past it
      // for `rawApi.logger`, and do not write to stderr.
      //
      // Three facts, assembled by the seam: tool, call id, named reason.
      // The event this closure is holding carries the parameters and the
      // body; none of that is passed on, and a test asserts their absence.
      reportOwnerApprovalOriginRefusal(event, ctx, message => api.logger.warn(message));
      return request;
    });
    setOwnerApprovalSurface(true);
    api.logger.info('popclaw: owner approval wired via api.on(before_tool_call)');
  } catch (err) {
    // register() must not throw (ADR-0035). Losing this costs the owner
    // confirmation lane and nothing else: world actions fall back to a
    // configured native policy exactly as before.
    setOwnerApprovalSurface(false);
    api.logger.error(`popclaw: before_tool_call hook registration failed — ${String(err)}`);
  }

  // The seam's other half on this host: a REPORT-ONLY guard that names a
  // grant the tool body never consumed.
  //
  // The MCP root has checked this since the guard was built; the native host
  // was written up as having "no after-dispatch moment" and left silent,
  // which was wrong. `after_tool_call` is on this same typed table
  // (`PluginHookName`, `dist/plugin-entry-Cc00OvUf.d.ts:7107`), the embedded
  // agent runner emits it for every completed tool call, and its event
  // carries the `toolCallId` the seam keys records on
  // (`dist/plugin-entry-Cc00OvUf.d.ts:7587`). So the two hosts now answer
  // the same question: was a grant taken and never spent?
  //
  // ⚠️ CITE FILE AND LINE TOGETHER. `PluginHookName` is declared identically
  // in three bundled entries and only the line numbers differ — `:7107` in
  // `plugin-entry-Cc00OvUf.d.ts`, `:19918` in `plugin-entry-C9jaZrZv.d.ts`,
  // `:1269` in `agent-harness-runtime-BvaKEkqR.d.ts` (the one index.ts's #374
  // note cites). A bare `:1269` was once carried onto the wrong file name
  // here; the number alone does not identify anything.
  //
  // ⚠️ SAME TWO-TABLE TRAP as before_tool_call's — `api.on`, never `api.registerHook`.
  //
  // It NEVER refuses and never touches a tool's result: the hook returns
  // `void`, and although the typed runner DOES await each handler
  // (`hook-runner-global-BhDCl4qm.mjs:783-797`) it also catches what the
  // handler throws (`handleHookError`, `:700-707`, fail-open), on top of the
  // seam's own reporter swallowing a throwing logger. Losing this
  // registration costs visibility and nothing else, which is why it does NOT
  // touch the surface flag: this host can still ask, and every gate still
  // decides exactly as before.
  try {
    api.on('after_tool_call', (event, ctx) => {
      ownerApprovalAfterToolCall(event, ctx, message => api.logger.error(message));
    });
  } catch (err) {
    // register() must not throw (ADR-0035).
    api.logger.error(`popclaw: after_tool_call hook registration failed — ${String(err)}`);
  }
}
