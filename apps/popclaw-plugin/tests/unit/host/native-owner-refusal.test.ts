/**
 * A REFUSAL ON THE NATIVE LANE HAS TO BE OBSERVABLE BY THE AGENT.
 *
 * `owner-approval-reasons.test.ts` proves every named refusal reaches
 * `consumeOwnerApproval`. On the OpenClaw native host a REFUSED call never
 * reaches `consumeOwnerApproval`: `ownerApprovalRecorded` answers false for it
 * on purpose — so the configured policy lane keeps serving it — and the native
 * root therefore routes it away from the owner lane entirely. Every carefully
 * distinguished reason in `OwnerApprovalOriginRefusal` was therefore computed
 * and discarded — and NOT, as this comment used to say, visible on the MCP root
 * instead: the origin guard runs only in `ownerApprovalBeforeToolCall`, which
 * the MCP root never calls. That is the fifth time in this lane that
 * something was wired, tested green, and did not run.
 *
 * So this file asserts the property a person cares about, not that a function
 * was called: DRIVE THE REGISTERED TOOL'S OWN `execute`, the surface an agent
 * sees, and read what comes back out of it. The chain under test is the
 * production one — `registerPopclawTools` builds the tool,
 * `ownerApprovalBeforeToolCall` is the real hook, `nativeWorldInvoke` is the
 * real router `src/index.ts` binds, and `createOpenClawWorldExecution` is the
 * real policy lane that serves a call the owner was never asked about.
 *
 * WHY IT IS OPERATIONALLY LOAD-BEARING. The spelling of `targets[].to` cannot
 * be settled from the host bundle (the WhatsApp plugin is not in it). The plan
 * for the real instance is to write the bare number first and let the refusal
 * say which value to try next: `OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN` AFTER getting
 * past `senderIsOwner` means the allowlist matched and the reply address did
 * not, so the JID is the next value. If the reason is invisible, that diagnosis
 * is unavailable and whoever sets up the instance is reduced to guessing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { makeToolCollector } from '../../../src/tools/mcp-adapter.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { createOpenClawWorldExecution } from '../../../src/host/openclaw-world-execution.js';
import { nativeWorldInvoke } from '../../../src/host/openclaw-owner-approval.js';
import {
  ownerApprovalBeforeToolCall, ownerApprovalRecorded, resetOwnerApprovals, setOwnerApprovalSurface,
  consumeOwnerApproval, ownerApprovalSubjectRefusalNote, registerOwnerApprovalSubject,
} from '../../../src/host/owner-approval.js';
import { WORLD_INVOKE_TOOL, createWorldInvokeApprovalSubject } from '../../../src/world/world-approval-subject.js';
import type { OwnerApprovalRouteReaders } from '../../../src/host/owner-approval-route.js';
import type { WorldCommandContext } from '../../../src/commands/popclaw-world.js';

const actorId = bs58.encode(new Uint8Array(32).fill(91));
const house = 'http://127.0.0.1:48180';
const CALL = 'host-call-1';
const input = { house, kind: 'rangermap.check_in',
  params: { place: 'Pier' }, expected_capability_revision: 'b'.repeat(64) };
const SCHEMA = { type: 'object', properties: { place: { type: 'string' } } };

/** One owner IM turn, whose own reply address is `+8520`. */
const turn = {
  toolCallId: CALL, agentId: 'main', sessionKey: 'agent:main:whatsapp:direct:1', channelId: '+8520',
  requester: { channel: 'whatsapp', senderId: '+8520', senderIsOwner: true },
};
/** The host snapshot, with the one field each scenario breaks. */
const readers = (plugin: unknown): OwnerApprovalRouteReaders => ({
  readActiveConfig: () => ({ commands: { ownerAllowFrom: ['+8520'] }, approvals: { plugin } }),
  resolveChannel: raw => ({ whatsapp: 'whatsapp', webchat: 'webchat' } as Record<string, string>)[raw],
});
const pinned = { enabled: true, mode: 'targets', targets: [{ channel: 'whatsapp', to: '+8520' }] };

/**
 * The native composition root's own wiring, kept in one place because this is
 * what `src/index.ts` binds: the seam decides the lane, the policy lane is the
 * fall-through, and nothing else sits between the tool body and either.
 */
function nativeRoot() {
  const collector = makeToolCollector();
  const active = { plugins: { entries: { popclaw: { config: {} } } } };
  const hostContext = { agentId: 'main', getRuntimeConfig: () => active };
  const execution = createOpenClawWorldExecution({ actorId, readActiveConfig: () => active });
  const lanes = { owner: 0, ran: 0 };
  registerPopclawTools({
    api: { ...collector.api,
      registerTool: (tool: unknown) => collector.api.registerTool(
        typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)(hostContext) : tool) },
    runtime: async () => ({}) as never,
    getWorldCommandContext: async () => ({}) as never,
    declaredWorldActionParameters: () => SCHEMA,
    bindNativeWorldInvoke: (ctx: unknown) => {
      let bound: ReturnType<typeof execution.bindFactory> | undefined;
      return <T>(callId: string, value: never, signal: AbortSignal | undefined,
        work: (context: WorldCommandContext, ref?: string) => Promise<T>): Promise<T> =>
        nativeWorldInvoke(callId, {
          asked: () => ownerApprovalRecorded(WORLD_INVOKE_TOOL, callId),
          owner: () => { lanes.owner += 1; return work({} as WorldCommandContext, 'ref'); },
          policy: running => {
            bound ??= execution.bindFactory(ctx);
            return bound.withInvocation(callId, value, signal, () => {
              lanes.ran += 1; running();
              return work({ client: () => { throw new Error('NO_CLIENT'); } } as unknown as WorldCommandContext);
            });
          },
        });
    },
  } as unknown as Parameters<typeof registerPopclawTools>[0]);
  const tool = collector.tools.find(candidate => candidate.name === WORLD_INVOKE_TOOL)!;
  return { lanes, invoke: (params: unknown = input, callId = CALL) =>
    (tool.execute as (id: string, value: unknown) => Promise<unknown>)(callId, params) };
}

beforeEach(() => { resetOwnerApprovals({ now: () => 1_789_000_000_000 }); });
afterEach(() => { resetOwnerApprovals(); });

describe('the native lane says why the owner was never asked', () => {
  /** Two refusals, not one: the point of the vocabulary is that a reader can
   *  tell the wrong reply address from a switched-off forwarding block. */
  const scenarios = [
    ['OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN', { ...pinned, targets: [{ channel: 'whatsapp', to: '+9999' }] }],
    ['OWNER_ROUTE_MODE_NOT_TARGETS', { ...pinned, mode: 'session' }],
  ] as const;

  for (const [reason, plugin] of scenarios) {
    it(`puts ${reason} in the result the agent reads, beside what the policy lane said`, async () => {
      const root = nativeRoot();
      setOwnerApprovalSurface(true);
      // The real hook, on a turn the route guard refuses.
      expect(await ownerApprovalBeforeToolCall(
        { toolName: WORLD_INVOKE_TOOL, params: input, toolCallId: CALL }, turn, readers(plugin),
      )).toBeUndefined();
      // The agent's own surface. Both facts, in one sentence: the lane that
      // refused, and why the other lane was never offered.
      await expect(root.invoke()).rejects.toThrow(
        new RegExp(`NATIVE_POLICY_REQUIRED[\\s\\S]*${reason}`));
      // …and nothing was admitted by naming it.
      expect(ownerApprovalRecorded(WORLD_INVOKE_TOOL, CALL)).toBe(false);
      expect(root.lanes.owner).toBe(0);
    });
  }

  it('leaves a call the guard never refused with the policy lane\'s own words', async () => {
    const root = nativeRoot();
    setOwnerApprovalSurface(true);
    // No hook run at all: there is no note, so there is nothing to add.
    const error = await root.invoke().catch((thrown: unknown) => thrown) as Error;
    expect(error.message).toContain('NATIVE_POLICY_REQUIRED');
    expect(error.message).not.toMatch(/OWNER_ROUTE_/);
  });

  it('still takes the owner lane when the owner really was asked', async () => {
    const root = nativeRoot();
    setOwnerApprovalSurface(true);
    // A pinned route: the hook builds a prompt, so `asked` is true and the
    // policy lane must not be entered at all.
    expect(await ownerApprovalBeforeToolCall(
      { toolName: WORLD_INVOKE_TOOL, params: input, toolCallId: CALL }, turn, readers(pinned),
    )).toBeDefined();
    await root.invoke().catch(() => undefined);
    expect(root.lanes.owner).toBe(1);
    expect(root.lanes.ran).toBe(0);
  });
});

describe('the explanation is attached to a refusal, never to a failed action', () => {
  /** The marker is the whole precision of this: a policy that ADMITTED the
   *  call and then failed downstream owes no sentence about an owner dialog,
   *  and getting that wrong would make every unrelated error misleading. */
  const refused = async (callId: string) => {
    // The subject has to be DECLARED before the guard runs at all — the hook
    // returns on an unregistered tool before it ever reaches the origin check,
    // so there would be no note to find. `nativeRoot` is the production
    // declaration path, which is why it is called here rather than reaching
    // into the registry.
    nativeRoot();
    await ownerApprovalBeforeToolCall(
      { toolName: WORLD_INVOKE_TOOL, params: input, toolCallId: callId },
      { ...turn, toolCallId: callId },
      readers({ ...pinned, targets: [{ channel: 'whatsapp', to: '+9999' }] }));
  };

  it('says nothing about the route when the action itself failed after the permit', async () => {
    setOwnerApprovalSurface(true);
    await refused('after');
    await expect(nativeWorldInvoke<void>('after', {
      asked: () => false,
      owner: async () => { throw new Error('OWNER_LANE_TAKEN'); },
      policy: async running => { running(); throw new Error('HOUSE_UNREACHABLE'); },
    })).rejects.toThrow(/^HOUSE_UNREACHABLE$/);
  });

  it('says it when the policy lane refused before the action ran', async () => {
    setOwnerApprovalSurface(true);
    await refused('before');
    await expect(nativeWorldInvoke<void>('before', {
      asked: () => false,
      owner: async () => { throw new Error('OWNER_LANE_TAKEN'); },
      policy: async () => { throw new Error('NATIVE_POLICY_REQUIRED'); },
    })).rejects.toThrow(/NATIVE_POLICY_REQUIRED.*OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN/);
  });

  it('keeps the original failure reachable as the cause', async () => {
    setOwnerApprovalSurface(true);
    await refused('cause');
    const original = new Error('NATIVE_POLICY_REQUIRED');
    const thrown = await nativeWorldInvoke<void>('cause', {
      asked: () => false,
      owner: async () => { throw new Error('OWNER_LANE_TAKEN'); },
      policy: async () => { throw original; },
    }).catch((error: unknown) => error);
    expect((thrown as { cause?: unknown }).cause).toBe(original);
  });
});

describe('same-call subject refusal diagnostics', () => {
  const missing = 'WORLD_ACTION_SCHEMA_UNAVAILABLE';
  async function refuseSubject(reason?: string) {
    setOwnerApprovalSurface(true);
    const descriptor = createWorldInvokeApprovalSubject(() => null);
    registerOwnerApprovalSubject(WORLD_INVOKE_TOOL, reason
      ? { ...descriptor, describe: () => ({ kind: 'refuse', reason }) } : descriptor);
    expect(await ownerApprovalBeforeToolCall({ toolName: WORLD_INVOKE_TOOL, params: input, toolCallId: CALL },
      { toolCallId: CALL, requester: { channel: 'tui', senderIsOwner: true } })).toBeUndefined();
  }
  function run(callId = CALL, started = false) {
    return nativeWorldInvoke(callId, {
      asked: () => ownerApprovalRecorded(WORLD_INVOKE_TOOL, callId),
      owner: async () => { throw new Error('OWNER_LANE_TAKEN'); },
      policy: async running => { if (started) running(); throw new Error('NATIVE_POLICY_REQUIRED'); },
    });
  }
  it('reports the fixed schema refusal twice without consuming, changing asked or altering its outcome', async () => {
    await refuseSubject();
    expect(ownerApprovalRecorded(WORLD_INVOKE_TOOL, CALL)).toBe(false);
    await expect(run()).rejects.toThrow(`OWNER_APPROVAL_UNAVAILABLE: SUBJECT_REFUSED: ${missing}`);
    await expect(run()).rejects.toThrow(`OWNER_APPROVAL_UNAVAILABLE: SUBJECT_REFUSED: ${missing}`);
    expect(ownerApprovalRecorded(WORLD_INVOKE_TOOL, CALL)).toBe(false);
    expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, CALL)).toEqual({
      decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: missing });
  });
  it('never borrows a note from another call or writes one on a missing call', async () => {
    await refuseSubject();
    await expect(run('other-call')).rejects.toThrow(/^NATIVE_POLICY_REQUIRED$/);
    expect(ownerApprovalSubjectRefusalNote(WORLD_INVOKE_TOOL, 'other-call', [missing])).toBeNull();
    expect(ownerApprovalSubjectRefusalNote('another-tool', CALL, [missing])).toBeNull();
    expect(ownerApprovalSubjectRefusalNote(WORLD_INVOKE_TOOL, '', [missing])).toBeNull();
    expect(ownerApprovalRecorded(WORLD_INVOKE_TOOL, 'other-call')).toBe(false);
  });
  it('does not attach a subject note after policy execution starts', async () => {
    await refuseSubject();
    await expect(run(CALL, true)).rejects.toThrow(/^NATIVE_POLICY_REQUIRED$/);
  });
  it('never prints a custom refusal message or private parameter content', async () => {
    await refuseSubject('PRIVATE_TOKEN_IN_CUSTOM_DESCRIPTOR');
    const error = await run().catch((thrown: unknown) => thrown) as Error;
    expect(error.message).toBe('NATIVE_POLICY_REQUIRED (OWNER_APPROVAL_UNAVAILABLE: SUBJECT_REFUSED)');
    expect(error.message).not.toContain('PRIVATE_TOKEN');
    expect(error.message).not.toContain(input.params.place);
  });
});
