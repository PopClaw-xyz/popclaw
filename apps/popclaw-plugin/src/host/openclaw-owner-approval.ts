/**
 * The world lane's half of the owner-approval seam: it turns ONE consumed
 * approval into the same `OwnerGrant` the MCP elicitation adapter produces, so
 * everything downstream — the reservation, the receipt journal,
 * `popclaw_world_action_status` — is the path that already exists rather than
 * a second permission system beside it.
 *
 * This is deliberately NOT where permission is decided. `consumeOwnerApproval`
 * decides, in `owner-approval.ts`, from an answer only the host can produce.
 * All this does is refuse to proceed on anything that is not `approved`, and
 * hold the resulting grant to the life of the tool call.
 *
 * ## The one intended widening, stated plainly
 *
 * Before this, a world action on the OpenClaw native host could only be
 * authorized by a configured `worldExecution` policy; with none, it refused
 * with `NATIVE_POLICY_REQUIRED` and there was no way for a person to say yes.
 * Now a single host-verified owner approval is a second accepted
 * authorization, and these are the invariants that keep it honest:
 *
 *   - issuable ONLY by the host approval flow. `requireApproval` is producible
 *     only by a plugin hook return value, and resolving one is gated on sender
 *     identity, never on message content. No model input reaches it.
 *   - single use, and bound to ONE CALL: the seam keys the answer on the
 *     host's own call identity and spends it once.
 *   - bound to the exact canonical action bytes, re-derived here from the
 *     input the runtime is about to act on rather than trusted from earlier.
 *   - expiring with the call: the grant's `assertCurrent` fails the moment
 *     `withInvocation` returns, the call aborts, or the adapter stops.
 *   - never reconstructible from model input: there is no field, flag or
 *     parameter a model can set that produces any of the above.
 *
 * The existing policy lane is untouched. A call the seam never asked about
 * falls through to it exactly as before, which is what keeps this additive.
 */
import { canonicalActionJson } from '../world/action-receipt-journal.js';
import { captureWorldCommandInput } from '../commands/popclaw-world.js';
import { WORLD_INVOKE_TOOL, worldApprovalReference } from '../world/world-approval-subject.js';
import {
  consumeOwnerApproval, ownerApprovalOriginRefusalNote, ownerApprovalRecorded, ownerApprovalSurfacePresent,
} from './owner-approval.js';
import type { WorldInvokeInput } from '../world/action-client.js';

/** One accepted confirmation: one job, therefore exactly one request slot.
 *  Structurally identical to `mcp-owner-authorization.ts`'s `OwnerGrant`, on
 *  purpose — both feed the same reservation sequence. */
export interface OwnerGrant {
  readonly jobId: string;
  readonly expiresAt: number;
  assertCurrent(): void;
}
/** What the runtime's per-call command context asks, plus the short string the
 *  owner just read, which the tool result repeats so a person can tie the
 *  prompt they approved to the receipt they read afterwards. */
export interface OwnerInvocation {
  readonly reference: string;
  authorize(input: Readonly<WorldInvokeInput>): Promise<OwnerGrant>;
}

export const WORLD_OWNER_APPROVAL_REASONS = Object.freeze({
  /** The owner said no. Its own word, because it is the one outcome that is a
   *  person's decision rather than a property of the machinery. */
  declined: 'OWNER_APPROVAL_DECLINED',
  /** The prompt timed out, was cancelled, or was never answered. */
  timeout: 'OWNER_APPROVAL_TIMEOUT',
  /** No usable approval, with the seam's own reason appended so the situations
   *  that owe different sentences stay apart. How many there are is not written
   *  here: `OWNER_APPROVAL_UNAVAILABLE_REASONS` is the vocabulary, and a count
   *  copied into prose is a fact with no owner. */
  unavailable: 'OWNER_APPROVAL_UNAVAILABLE',
  /** The grant outlived its tool call, or the adapter stopped. */
  inactive: 'OWNER_APPROVAL_INACTIVE',
  /** The grant's deadline passed while the action was still in flight. */
  expired: 'OWNER_APPROVAL_EXPIRED',
  /** The runtime re-asked with something other than the approved action. */
  mismatch: 'OWNER_APPROVAL_INPUT_MISMATCH',
  /** One invocation, one ask. */
  busy: 'OWNER_APPROVAL_BUSY',
  invalidCall: 'OWNER_APPROVAL_INVOCATION_INVALID',
  clockRollback: 'OWNER_APPROVAL_CLOCK_ROLLBACK',
} as const);

/** The human answer is excluded from execution validity: the clock starts when
 *  the answer is consumed, and 240 is under the store's 300 s reservation cap.
 *  Same number the MCP lane uses, so a grant means the same thing on both. */
const GRANT_SECONDS = 240;
/** Same shape the native execution gate accepts, so one call id is one call id
 *  on both lanes. */
const CALL_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

function fail(code: string): never { throw new Error(code); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function nonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}

export interface WorldOwnerApprovalOptions { now?(): number }

export function createWorldOwnerApproval(options: WorldOwnerApprovalOptions = {}) {
  let stopped = false, highWater = 0;
  function clock(): number {
    if (stopped) return fail(WORLD_OWNER_APPROVAL_REASONS.inactive);
    const now = options.now?.() ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || now < highWater) return fail(WORLD_OWNER_APPROVAL_REASONS.clockRollback);
    highWater = now; return now;
  }
  return Object.freeze({
    /** Adapter-level presence only, read by the runtime's capability
     *  projection. It grants nothing: a kind reports ready because a person
     *  COULD be asked, and `withInvocation` still decides every actual call. */
    assertActive(): void {
      if (stopped) return fail(WORLD_OWNER_APPROVAL_REASONS.inactive);
      if (!ownerApprovalSurfacePresent()) return fail(`${WORLD_OWNER_APPROVAL_REASONS.unavailable}: APPROVAL_SURFACE_ABSENT`);
    },
    stop(): void { stopped = true; },
    /**
     * Whether this call belongs to the owner-approval lane at all.
     *
     * TRUE means the owner was asked about this exact call — so whatever they
     * answered governs it, and a deny must NOT then fall through to a
     * configured policy that would have sent it anyway. FALSE means this host
     * never asked, and the call keeps whatever authorization it had before
     * this seam existed.
     *
     * A SUBJECT THE SEAM REFUSED ANSWERS FALSE. No prompt was built and no
     * human saw anything, so there is no answer to obey — and routing those
     * calls here took away a configured policy that would have served them
     * before this seam existed, which is a regression the seam caused rather
     * than a decision anyone made. See `ownerApprovalRecorded`.
     */
    asked(callId: unknown): boolean {
      return typeof callId === 'string' && ownerApprovalRecorded(WORLD_INVOKE_TOOL, callId);
    },
    /**
     * One tool call, one consumed answer, one grant that dies with the call —
     * the same contract `mcp-owner-authorization.ts` offers, which is why the
     * shared `ownerConfirmedWorldInvoke` joint drives both.
     */
    async withInvocation<T>(callId: string, input: unknown, signal: AbortSignal | undefined,
      callback: (ask: OwnerInvocation) => Promise<T>): Promise<T> {
      if (typeof callId !== 'string' || !CALL_ID.test(callId)) return fail(WORLD_OWNER_APPROVAL_REASONS.invalidCall);
      if (stopped) return fail(WORLD_OWNER_APPROVAL_REASONS.inactive);
      // The seam is handed the input the runtime is ABOUT TO ACT ON, and
      // re-derives the approved bytes from it. Nothing here supplies a digest.
      const outcome = consumeOwnerApproval(WORLD_INVOKE_TOOL, input, callId);
      if (outcome.decision === 'denied') return fail(WORLD_OWNER_APPROVAL_REASONS.declined);
      if (outcome.decision === 'timeout') return fail(WORLD_OWNER_APPROVAL_REASONS.timeout);
      if (outcome.decision !== 'approved') {
        return fail(`${WORLD_OWNER_APPROVAL_REASONS.unavailable}: ${outcome.reason}`
          + (outcome.detail ? ` (${outcome.detail})` : ''));
      }
      const captured = freeze(captureWorldCommandInput('invoke', input));
      const approved = canonicalActionJson(captured);
      const token = nonce();
      const expiresAt = clock() + GRANT_SECONDS;
      let active = true, asked = false;
      try {
        return await callback({
          reference: worldApprovalReference(approved),
          authorize: async candidate => {
            // One confirmation per invocation: one job, one request slot.
            if (asked) return fail(WORLD_OWNER_APPROVAL_REASONS.busy);
            asked = true;
            if (!active || stopped || signal?.aborted) return fail(WORLD_OWNER_APPROVAL_REASONS.inactive);
            // The runtime re-asks with its own captured copy. It must still be
            // the approved action, compared by bytes and never by identity.
            if (canonicalActionJson(captureWorldCommandInput('invoke', candidate)) !== approved) {
              return fail(WORLD_OWNER_APPROVAL_REASONS.mismatch);
            }
            if (clock() >= expiresAt) return fail(WORLD_OWNER_APPROVAL_REASONS.expired);
            return freeze({
              jobId: `openclaw-owner:${token}`,
              expiresAt,
              assertCurrent: (): void => {
                if (!active || stopped || signal?.aborted) return fail(WORLD_OWNER_APPROVAL_REASONS.inactive);
                if (clock() >= expiresAt) return fail(WORLD_OWNER_APPROVAL_REASONS.expired);
              },
            });
          },
        });
      } finally {
        // A returned grant must die with its call, so a stale one fails assertCurrent.
        active = false;
      }
    },
  });
}
export type WorldOwnerApproval = ReturnType<typeof createWorldOwnerApproval>;

/** The two authorizations one native world invoke can take, plus the marker
 *  that says the second one actually let the action start. Supplied by the
 *  native composition root (`src/index.ts`), which is the only place that
 *  holds a host factory context. */
export interface NativeWorldInvokeLanes<T> {
  /** Was the owner ASKED about this exact call — never "would they say yes". */
  asked(): boolean;
  /** The owner-approval lane, already joined to the runtime. */
  owner(): Promise<T>;
  /** The lane this call had before the seam existed. `running` must be called
   *  at the moment the policy granted a permit and the action is about to run,
   *  and never otherwise: it is what tells a refusal apart from a failure. */
  policy(running: () => void): Promise<T>;
}

/**
 * WHICH AUTHORIZATION APPLIES, AND — WHEN NEITHER DOES — WHY.
 *
 * The routing half is unchanged and deliberately ordered: whether the owner was
 * ASKED decides the lane, never which lane would say yes. If a person was shown
 * this action and declined it, a configured policy must not then send it anyway;
 * a call the seam never asked about keeps whatever authorization it had before
 * this seam existed.
 *
 * THE HALF THIS FUNCTION EXISTS FOR. A call the ORIGIN GUARD refused answers
 * `asked() === false`, so it lands in the policy lane — and until this existed,
 * the guard's named reason died there. On an instance with no `worldExecution`
 * policy (the measured shape: `plugins.entries.popclaw.config = {}`) the person
 * setting it up read `NATIVE_POLICY_REQUIRED` and nothing else, while the seam
 * privately knew the owner dialog had been refused for, say,
 * `OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN` — the one fact that says the allowlist
 * matched and the reply address did not. EVERY NAME IN
 * `OwnerApprovalOriginRefusal` was in that position: the whole of
 * `OWNER_APPROVAL_ROUTE_REFUSALS`, plus `OWNER_ALLOWLIST_UNCONFIGURED` and
 * `ORIGIN_NOT_OWNER_DIRECT`. No count is written here, on purpose — an earlier
 * draft put one in prose, it was already wrong on the day it was written, and
 * it drifted again when a reason was added. The array is the type; a reader who
 * wants the number reads it off the array, where it cannot disagree with
 * itself.
 *
 * AND NONE OF THEM WAS EVER VISIBLE ON THE MCP ROOT, which the same draft
 * claimed. The guard has exactly one caller — `ownerApprovalBeforeToolCall`
 * (`owner-approval.ts:628-631`), registered as the `before_tool_call` hook at
 * `index.ts:1477` — and it is the only writer of the note this function reads.
 * The MCP root asks through `askOwnerApprovalBeforeDispatch`
 * (`owner-approval.ts:784`), which goes straight to `prepare` and never runs
 * the guard. So the names were computed on this host and discarded on this
 * host; there was no second surface already showing them.
 *
 * THAT ABSENCE IS BY DESIGN, AND HERE IS THE PREMISE IT RESTS ON — written
 * down because a "by design" that hides its assumption is how stale reasoning
 * outlives the change that invalidates it. What the guard screens is a CHANNEL
 * ORIGIN: did this turn arrive on the owner's own surface, and would the
 * approval be delivered back to that same address. The MCP root has no such
 * origin to screen — the dialog is elicited on the connected client itself
 * (`mcp-owner-approval.ts`, `elicit`), the terminal the person is already
 * sitting at, and never goes through the host's approval forwarding. THE
 * PREMISE: that the MCP client process belongs to the owner. This plugin
 * assumes that; nothing here proves it, and it is what makes the missing guard
 * correct rather than a hole. WHAT WOULD END IT: an MCP root that acquires a
 * remote delivery surface — a client that relays the elicitation to somewhere
 * the owner is not — at which point this reasoning has to be re-examined and
 * an origin screen wanted on that root too. Until then, do not "fix" it.
 *
 * So a refusal now carries both sentences. NOTHING IS ADMITTED BY IT: the note
 * is read-only, only a call that ALREADY failed is touched, and the message is
 * the only thing that changes. The failure itself is kept as `cause`.
 *
 * ATTACHED TO A REFUSAL, NEVER TO A FAILED ACTION. Once the policy lane has
 * granted a permit, whatever goes wrong afterwards is about the action, and
 * appending "the owner was never asked because …" to a house timeout would make
 * every unrelated error misleading. That is what `running` marks.
 */
export async function nativeWorldInvoke<T>(callId: string, lanes: NativeWorldInvokeLanes<T>): Promise<T> {
  if (lanes.asked()) return lanes.owner();
  let started = false;
  try {
    return await lanes.policy(() => { started = true; });
  } catch (error) {
    const refusal = started ? null : ownerApprovalOriginRefusalNote(WORLD_INVOKE_TOOL, callId);
    if (refusal === null) throw error;
    const said = error instanceof Error ? error.message : String(error);
    throw new Error(`${said} (${WORLD_OWNER_APPROVAL_REASONS.unavailable}: ${refusal})`, { cause: error });
  }
}
