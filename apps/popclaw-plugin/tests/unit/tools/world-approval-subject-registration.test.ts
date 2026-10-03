import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeToolCollector } from '../../../src/tools/mcp-adapter.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import {
  consumeOwnerApproval, ownerApprovalBeforeToolCall, resetOwnerApprovals, setOwnerApprovalSurface,
} from '../../../src/host/owner-approval.js';
import { WORLD_INVOKE_TOOL, WORLD_PARAMETER_ROW_PREFIX } from '../../../src/world/world-approval-subject.js';
import { WORLD_ACTION_SCHEMA_UNAVAILABLE } from '../../../src/world/action-declared-parameters.js';

/**
 * WHICH ROOT DECLARES THE WORLD SUBJECT — AND WHY IT IS EXACTLY ONE.
 *
 * N6: `registerOwnerApprovalSubject(WORLD_INVOKE_TOOL, …)` used to be called
 * from `src/index.ts` alone, which `src/mcp.ts` never imports, so the MCP
 * process ran with an EMPTY registry and its whole owner-approval backend was
 * inert. The registration moved beside the tool, where both roots reach it.
 *
 * That fixed the native host and broke the MCP one in the other direction.
 * The MCP root wraps every tool in `approvals.aroundDispatch`, so a
 * registered subject is asked about THERE as well as inside the world tool's
 * own reviewed elicitation: one action, two dialogs — and since the world MCP
 * body never calls `consumeOwnerApproval`, the seam's answer decided nothing,
 * so a deny could be re-asked into a push.
 *
 * So the subject is declared by the NATIVE root only, and this file pins both
 * halves: the native root fills the registry, the MCP root leaves it empty.
 * The suite cannot see either property from the seam's own tests, which write
 * the registry directly — that proves the seam works and proves nothing about
 * whether a real root fills it.
 */
const house = 'http://127.0.0.1:18989';
const params = { place: 'Registered by the root', latitude: '30.2700', longitude: '120.1500' };
const input = { house, kind: 'rangermap.check_in', params, expected_capability_revision: 'b'.repeat(64) };
const SCHEMA = { type: 'object', properties: {
  place: { type: 'string' }, latitude: { type: 'string' }, longitude: { type: 'string' } } };
const owner = { toolCallId: 'root-1', requester: { channel: 'tui', senderId: 'me', senderIsOwner: true } };

/** The deps each composition root hands `registerPopclawTools`, cut down to
 *  the slots that decide whether the world tools register at all. */
function registerAs(root: 'mcp' | 'native', declared?: (h: string, k: string) => unknown) {
  const c = makeToolCollector();
  registerPopclawTools({
    api: c.api,
    runtime: async () => ({}) as never,
    getOrchestrator: async () => ({}) as never,
    getWorldDeps: async () => ({}) as never,
    getWorldCommandContext: async () => ({}) as never,
    ...(declared ? { declaredWorldActionParameters: declared } : {}),
    // The one structural difference between the roots on this path: the native
    // root binds host factory context, the MCP root binds a per-call ask.
    ...(root === 'native'
      ? { bindNativeWorldInvoke: () => async () => undefined as never }
      : { bindMcpWorldInvoke: () => async () => undefined as never }),
  } as unknown as Parameters<typeof registerPopclawTools>[0]);
  return c;
}

beforeEach(() => { resetOwnerApprovals(); });
afterEach(() => { resetOwnerApprovals(); });

describe('which roots reach the world action approval subject', () => {
  it('is unregistered until a root registers its tools', () => {
    expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'root-1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_NOT_REGISTERED' });
  });

  it('finds a descriptor after the native root\'s tool registration has run', () => {
    const c = registerAs('native');
    setOwnerApprovalSurface(true);
    expect(c.tools.map(t => t.name)).toContain(WORLD_INVOKE_TOOL);
    // NOT `SUBJECT_NOT_REGISTERED`: a descriptor exists, and the seam got
    // past the registry into the subject's own canonicalize. The reason it
    // lands on instead is only "nobody was asked about THIS call".
    expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'root-1'))
      .toEqual({ decision: 'unavailable', reason: 'ORIGIN_NOT_OWNER_DIRECT' });
  });

  /** The MCP root registers the TOOL and not the SUBJECT. Its own dispatch
   *  wrapper would otherwise raise a second dialog for the same action, and
   *  answer it into a record nothing on that path ever consumes. */
  it('registers the world tool on the mcp root but leaves the subject registry empty', () => {
    const c = registerAs('mcp', () => SCHEMA);
    setOwnerApprovalSurface(true);
    expect(c.tools.map(t => t.name)).toContain(WORLD_INVOKE_TOOL);
    expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'root-1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_NOT_REGISTERED' });
  });

  it('carries the root\'s own declaration source into the dialog it draws', async () => {
    registerAs('native', () => SCHEMA);
    setOwnerApprovalSurface(true);
    const shown = (await ownerApprovalBeforeToolCall(
      { toolName: WORLD_INVOKE_TOOL, params: input, toolCallId: 'root-1' }, owner))!.requireApproval;
    expect(shown.description).toContain(`house: ${house}`);
    for (const key of Object.keys(params)) {
      expect(shown.description).toContain(`${WORLD_PARAMETER_ROW_PREFIX}${key}: `);
    }
  });

  /** A root that cannot say what the house declared draws no dialog at all —
   *  an unknown schema is not an empty constraint. */
  it('refuses by name when a root supplies no declaration source', async () => {
    registerAs('native');
    setOwnerApprovalSurface(true);
    expect(await ownerApprovalBeforeToolCall(
      { toolName: WORLD_INVOKE_TOOL, params: input, toolCallId: 'root-1' }, owner)).toBeUndefined();
    expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'root-1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: WORLD_ACTION_SCHEMA_UNAVAILABLE });
  });
});
