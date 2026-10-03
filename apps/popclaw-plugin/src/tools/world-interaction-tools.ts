import {
  captureWorldCommandInput, WORLD_COMMAND_SCHEMAS, runWorldCapabilitiesCommand, runWorldInvokeCommand,
  runWorldPrivateMessagesCommand, runWorldActionStatusCommand,
} from '../commands/popclaw-world.js';
import { structuredToolResult } from './mcp-adapter.js';
import { registerOwnerApprovalSubject } from '../host/owner-approval.js';
import { WORLD_INVOKE_TOOL, createWorldInvokeApprovalSubject } from '../world/world-approval-subject.js';
import type { ToolsCtx } from './tools-context.js';

/** One registration table. Getter presence advertises the lane; registration never resolves it. */
export function registerWorldInteractionTools({ api, deps }: ToolsCtx): void {
  const getContext = deps.getWorldCommandContext;
  if (!getContext) return;
  /*
   * WHAT ONE `popclaw_world_invoke` CALL MEANS TO THE PERSON WHO OWNS THIS
   * INSTALL — declared HERE, beside the tool it speaks for.
   *
   * It lived in `src/index.ts` for one round, because this file belonged to
   * another thread. That made it reachable from the OpenClaw gateway root and
   * NOWHERE ELSE: `src/mcp.ts` never imports it, so in the MCP process the
   * subject registry was empty and the whole owner-approval backend built for
   * Claude Code and Codex was wired but inert — a world invoke there would
   * have been answered `SUBJECT_NOT_REGISTERED`. Both roots call
   * `registerPopclawTools`, so both reach this line and only this line. Do not
   * add a second call site: a registry written from two places is the next
   * silent divergence.
   *
   * The unit suite could not see the old defect because its tests write the
   * registry directly; the test that pins this drives a root's own tool
   * registration and then looks the subject up.
   *
   * ON THE NATIVE HOST ONLY, AND THE CONDITION IS LOAD-BEARING.
   *
   * "Registration lives beside the tool" is the rule; this is the one host
   * condition on it, and it is here because of what happens without it. The
   * MCP root wraps EVERY tool in `approvals.aroundDispatch` (`src/mcp.ts`),
   * so a registered subject is asked about there, before the body runs — and
   * `popclaw_world_invoke` asks the owner itself, inside its body, through
   * its own reviewed elicitation (`mcp-owner-authorization.ts`). Registering
   * unconditionally therefore showed the owner TWO dialogs for one action.
   *
   * The duplicate was not the dangerous half. The world MCP path never calls
   * `consumeOwnerApproval`, so the answer to the seam's dialog decided
   * nothing: deny it, approve the second, and the action was signed and
   * pushed. A recorded refusal must never fall on the floor. (It never
   * loosened execution — the reviewed gate still decided — but the seam
   * cannot claim an invariant it does not keep.)
   *
   * `bindNativeWorldInvoke` is the honest test for "this is the OpenClaw
   * gateway root": only that root binds host factory context, and only there
   * does the host suspend the call between the `before_tool_call` hook and
   * the tool body, which is what makes ONE dialog the whole story. Unifying
   * the world's MCP path onto `consumeOwnerApproval` is the recorded
   * follow-up; until it is taken, the two dialogs must not both exist, and
   * `mcp-owner-approval.ts`'s own SCOPE note says the same thing from the
   * other side. A second registered subject that DOES consume is served by
   * the MCP backend exactly as built.
   *
   * Pure declaration — it acquires nothing and does no IO (ADR-0035).
   */
  if (deps.bindNativeWorldInvoke) {
    registerOwnerApprovalSubject(WORLD_INVOKE_TOOL, createWorldInvokeApprovalSubject(
      // No source means this root cannot say what the house declared, and a
      // dialog it cannot bound is a dialog it must not draw.
      deps.declaredWorldActionParameters ?? (() => null)));
  }
  const definitions = [
    ['capabilities', 'popclaw_world_capabilities', 'Read the same verified House context received during login: server guide pages, declared action schemas, readiness and protocol limits. Optional kind selects an action; small schemas are complete objects. For omitted large schemas, use kind plus schema=params or result and schema_offset to read JSON text fragments; concatenate all pages and verify length/hash before treating them as a schema. guide_offset reads another guide page. Optional event_kind explains one declared event (description, signer, proto/schema availability, local validation); when its explanation reports a validated body schema, event_kind plus schema=body and schema_offset pages that exact declared JSON the same way. Carry expected_capability_revision and expected_session_id from the read reference and restart reading if either changes. Never fetches another guide, logs in, or grants permission. A missing schema is not an empty schema; never guess action parameters.', runWorldCapabilitiesCommand],
    ['private_messages', 'popclaw_world_private_messages', 'Read authenticated private material (world-action and House-session messages) or current state from the logged-in House local cache. This is NOT the owner\'s ordinary DM inbox: a DM someone sent the owner never lands here — for that, including any "sent you a DM (#id)" notice, use popclaw_show_inbox. First page accepts house and optional limit (1..100). For every cursor, message_id or state_ref read, carry expected_capability_revision and expected_session_id from the prior result; restart if either changes. Select at most one of cursor, message_id and state_ref. Returns only bounded authenticated material and local source facts. Does not fetch, consume messages, change policy, invoke actions or grant permission. This is for private messages inside a house only — never for public posts or a house\'s recent content; use popclaw_show_feed for that.', runWorldPrivateMessagesCommand],
    ['invoke', 'popclaw_world_invoke', 'Perform one action requested by the owner in a logged-in House. Take kind, params and expected_capability_revision from its server-authored guide and exact action schema returned by login or popclaw_world_capabilities. Uses independently injected trusted authority. Model arguments cannot create permission or session context. Each call asks the owner to confirm in the host\'s own dialog and creates a NEW action; it is never an idempotent retry of an earlier call, and this release resends nothing across calls. Do not retry automatically after a decline, a timeout or an unknown outcome. To find out what happened to a request already sent, call popclaw_world_action_status with its request_id; invoke again only when the owner means to create a second action that may duplicate the first.', runWorldInvokeCommand],
    ['action_status', 'popclaw_world_action_status', 'Read the signed status of an existing world request, preserving its exact result and optional subscription progress. Never creates a new action. This is the tool to call when popclaw_world_invoke returned an unknown outcome: it queries that same request rather than starting another one.', runWorldActionStatusCommand],
  ] as const;
  for (const [command, name, description, run] of definitions) {
    // Either host binder means the same thing: this call's context is supplied
    // by the host, not by the shared getter. The native root passes its factory
    // context through; the MCP root has none and ignores the argument.
    const bindInvoke = command !== 'invoke' ? undefined
      : deps.bindNativeWorldInvoke ?? (deps.bindMcpWorldInvoke ? (_hostContext: unknown) => deps.bindMcpWorldInvoke!() : undefined);
    if (bindInvoke) {
      api.registerTool((hostContext: unknown) => {
        const invoke = bindInvoke(hostContext);
        return { name, description, parameters: WORLD_COMMAND_SCHEMAS.invoke,
          captureParameters: (params: unknown) => captureWorldCommandInput('invoke', params),
          execute: async (callId: string, params: unknown, signal?: AbortSignal) => {
            const input = captureWorldCommandInput('invoke', params);
            // `owner_confirmation_ref` is the short string the owner just read
            // in the confirmation dialog. Repeating it here is what lets a
            // person tie the dialog they approved to this receipt; the native
            // lane shows no dialog and so supplies none.
            return invoke(callId, input, signal, async (context, ownerConfirmationRef) => structuredToolResult({
              ...await runWorldInvokeCommand(context, input),
              ...(ownerConfirmationRef ? { owner_confirmation_ref: ownerConfirmationRef } : {}),
            }));
          },
        };
      }, { name });
      continue;
    }
    api.registerTool({ name, description, parameters: WORLD_COMMAND_SCHEMAS[command],
      captureParameters: (params: unknown) => captureWorldCommandInput(command, params),
      execute: async (_callId: string, params: unknown) => {
        const input = captureWorldCommandInput(command, params);
        const result = structuredToolResult(await run(await getContext(), input));
        // Native and MCP return both text and structured data. Count the entire
        // serialized wrapper, including the second JSON escaping of the text.
        if (command === 'private_messages' && new TextEncoder().encode(JSON.stringify(result)).length > 16384) {
          return structuredToolResult({ status: 'unavailable', code: 'SIZE_LIMIT' });
        }
        return result;
      },
    });
  }
}
