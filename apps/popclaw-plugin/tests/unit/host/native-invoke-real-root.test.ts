/**
 * THE COMPOSITION ROOT'S OWN BINDING, MEASURED ON THE ARTIFACT THAT SHIPS.
 *
 * `native-owner-refusal.test.ts` proves the ROUTER: given the three lanes,
 * `nativeWorldInvoke` takes the right one and carries the origin guard's named
 * reason out with whatever the policy lane said. It builds those lanes itself,
 * in the test, the way `src/index.ts` builds them — so it says nothing about
 * whether `src/index.ts` still hands its lanes to that router at all.
 *
 * That seam is the one this lane keeps losing. Six times now the unit under
 * test was correct and the wiring that puts it on the real path was not: a hook
 * registered into the table nothing reads (#374), a subject registry filled in
 * one composition root only (N6), a guard logging into a sink nobody reads,
 * reasons dropped on the MCP path, reasons dropped on the native path, and this
 * binding — known to hold only because someone read `src/index.ts:9` and
 * `:1991`. Every one of those had green tests.
 *
 * So this file asserts it where a person would meet it: it loads
 * `dist/bundled/index.js` — the exact file the OpenClaw gateway `import()`s —
 * calls its `register()`, drives the `before_tool_call` handler THAT
 * REGISTRATION wired so the artifact's own origin guard records a refusal, and
 * then calls the registered `popclaw_world_invoke` tool's own `execute`. If the
 * root stopped routing through `nativeWorldInvoke`, the refusal's name would
 * not be in what comes back, and this goes red.
 *
 * WHAT THE TEST SUPPLIES, AND WHY THAT IS THE HONEST LIMIT. No gateway boots
 * here, so there is no real runtime: the memo the root reads its runtime from
 * (`src/runtime/once.ts`, shared with the bundled copy through `globalThis`)
 * is parked with one whose `worldOwnerApproval` and `nativeWorldExecution` are
 * stated rather than built. Those two are covered against the real modules in
 * `native-owner-refusal.test.ts`. EVERYTHING BETWEEN THEM IS THE BUNDLE'S OWN
 * CODE: the tool registration, the tail wrapper, the `before_tool_call`
 * handler, the origin guard and its refusal record, the routing decision, the
 * note read, and the sentence the agent finally reads.
 *
 * IT ALSO ASSERTS WHAT THE ROOT SAYS OUT LOUD. The reason reaching the agent
 * is not the same as an operator being able to find it: on a real instance a
 * draft was refused in the owner's own chat and there was nothing in the log
 * to grep, because the seam has no logger by design and the registration logs
 * once at boot. The second describe below drives this same artifact and reads
 * the line the host's own logger received — including the values that must NOT
 * be in it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot,
} from 'openclaw/plugin-sdk/runtime-config-snapshot';
import { ensureBundle } from '../../helpers/ensure-bundle.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BUNDLE_PATH = join(PKG_ROOT, 'dist/bundled/index.js');
/** `src/runtime/once.ts`'s singleton table, which the bundled copy shares with
 *  this process because it lives on `globalThis`. */
const RUNTIME_MEMO = '__popclaw_singleton__runtime';
const WORLD_INVOKE = 'popclaw_world_invoke';

/**
 * A REAL HOST SNAPSHOT, because the bundle's hook reads the real default.
 *
 * `ownerApprovalBeforeToolCall` is registered with no readers argument
 * (`src/index.ts:1477`), so inside the artifact the route guard reads
 * `getRuntimeConfigSnapshot()`. A test therefore cannot hand it a config; it
 * has to put one where the host keeps it. The turn below arrives on `+8520`
 * and the only configured target is `+9999`, which is the one refusal that
 * matters operationally: the allowlist matched and the reply address did not.
 */
const HOST_CONFIG = {
  commands: { ownerAllowFrom: ['+8520'] },
  approvals: { plugin: { enabled: true, mode: 'targets', targets: [{ channel: 'whatsapp', to: '+9999' }] } },
};
const turn = (toolCallId: string) => ({
  toolCallId, agentId: 'main', sessionKey: 'agent:main:whatsapp:direct:1', channelId: '+8520',
  requester: { channel: 'whatsapp', senderId: '+8520', senderIsOwner: true },
});
const params = {
  house: 'http://127.0.0.1:18989', kind: 'rangermap.check_in',
  params: { place: 'Pier' }, expected_capability_revision: 'b'.repeat(64),
};

type TypedHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
/** Everything the stub host's logger was handed, per channel. */
type LogLines = { debug: string[]; info: string[]; warn: string[]; error: string[] };
type Tool = { name?: string; execute: (callId: string, value: unknown, signal?: AbortSignal) => Promise<unknown> };
/** The three fields the root reaches for that every scenario shares. */
const baseRuntime = {
  boot: { popclawId: '1'.repeat(32) },
  // The tail wrapper runs every tool body inside this (`src/index.ts:1936`),
  // so the call never reaches the root's binder without it.
  houseRuntime: { runCommand: (work: () => Promise<unknown>) => work() },
  orchestrator: { start: async () => {}, stop: async () => {} },
  shutdown: async () => {},
};

beforeAll(async () => {
  await ensureBundle(PKG_ROOT, BUNDLE_PATH);
}, 300_000);
afterEach(() => {
  clearRuntimeConfigSnapshot();
  delete (globalThis as unknown as Record<string, unknown>)[RUNTIME_MEMO];
});

/**
 * Register the REAL artifact against a stub host, park `runtime`, and hand back
 * the two surfaces production has: the hook the host fires before a tool call,
 * and the tool the agent calls.
 */
async function realRoot(
  runtimeValue: unknown,
  /** A second `info` sink, called after the line is recorded. Only the
   *  throwing-logger scenario supplies one; `register()` itself logs on this
   *  channel, so it arms itself only once registration is over. */
  options: { readonly logInfo?: (message: string) => void } = {},
): Promise<{ hook: TypedHandler; tool: Tool; logs: LogLines }> {
  const mod = (await import(pathToFileURL(BUNDLE_PATH).href)) as {
    default: { register: (api: unknown) => void };
  };
  const typed = new Map<string, TypedHandler>();
  const tools = new Map<string, unknown>();
  const stateDir = mkdtempSync(join(tmpdir(), 'popclaw-native-root-'));
  const logs: LogLines = { debug: [], info: [], warn: [], error: [] };
  const api = {
    registrationMode: 'full',
    // The RAW host logger — what `visibleLogger` hands the host, not what the
    // plugin calls. A line the plugin sends to `warn` has to arrive here on
    // `info`, carrying the prefix; that is the difference between reaching
    // gateway.log and reaching a stderr the gateway points at /dev/null.
    logger: {
      debug: (m: string) => { logs.debug.push(m); },
      info: (m: string) => { logs.info.push(m); options.logInfo?.(m); },
      warn: (m: string) => { logs.warn.push(m); },
      error: (m: string) => { logs.error.push(m); },
    },
    pluginConfig: {}, config: {},
    runtime: {
      state: { resolveStateDir: () => stateDir },
      system: { enqueueSystemEvent: () => true, runHeartbeatOnce: async () => undefined },
    },
    registerCommand() {}, registerService() {}, registerInteractiveHandler() {},
    // The world invoke tool registers in the FACTORY form, because only the
    // native root has a host factory context to bind.
    registerTool: (tool: unknown, opts?: { name?: string }) => {
      const name = opts?.name ?? (typeof tool === 'object' && tool !== null
        ? (tool as { name?: string }).name : undefined);
      if (name) tools.set(name, tool);
    },
    registerHook: (_events: unknown, _handler: unknown, opts?: { name?: string }) => {
      if (!opts?.name?.trim()) throw new Error('hook registration missing name');
    },
    on: (hookName: string, handler: unknown) => { typed.set(hookName, handler as TypedHandler); },
  };
  // Parked AFTER register() so each scenario adopts its own: `register()` does
  // no IO and never touches the memo (ADR-0035), and a fresh lifecycle per
  // registration is what makes the first `runtime()` read this value.
  delete (globalThis as unknown as Record<string, unknown>)[RUNTIME_MEMO];
  mod.default.register(api);
  (globalThis as unknown as Record<string, unknown>)[RUNTIME_MEMO] = Promise.resolve(runtimeValue);

  const hook = typed.get('before_tool_call');
  expect(typeof hook, 'the artifact wires before_tool_call through api.on').toBe('function');
  const factory = tools.get(WORLD_INVOKE);
  expect(typeof factory, 'the artifact registers the world invoke tool as a host factory').toBe('function');
  const tool = (factory as (hostContext: unknown) => unknown)({ agentId: 'main' }) as Tool;
  return { hook: hook!, tool, logs };
}

/** Drive the artifact's own guard on a turn whose reply address is not the
 *  configured target, and confirm it drew no prompt. */
async function refusedByTheGuard(hook: TypedHandler, callId: string): Promise<void> {
  expect(await hook({ toolName: WORLD_INVOKE, params, toolCallId: callId }, turn(callId))).toBeUndefined();
}
const failure = (result: Promise<unknown>): Promise<string> =>
  result.then(() => 'NO_FAILURE', (error: unknown) => (error instanceof Error ? error.message : String(error)));

describe('the shipped artifact routes its native world invoke through the router', () => {
  it('carries the origin guard\'s named reason out of the real bundle\'s own tool', async () => {
    setRuntimeConfigSnapshot(HOST_CONFIG as never);
    const { hook, tool } = await realRoot({
      ...baseRuntime,
      worldOwnerApproval: { asked: () => false },
      worldRuntime: { nativeCommandContext: () => ({}) },
      // Refuses BEFORE a permit exists, which is what the measured instance
      // shape (`plugins.entries.popclaw.config = {}`) does.
      nativeWorldExecution: {
        bindFactory: () => ({ withInvocation: async () => { throw new Error('NATIVE_POLICY_REQUIRED'); } }),
      },
    });
    await refusedByTheGuard(hook, 'real-root-refused');

    // Both facts in one sentence, out of the file the gateway loads: the lane
    // that refused, and why the other lane was never offered. Reading
    // `src/index.ts` is what used to be the only evidence for this.
    expect(await failure(tool.execute('real-root-refused', params)))
      .toBe('NATIVE_POLICY_REQUIRED (OWNER_APPROVAL_UNAVAILABLE: OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN)');
  }, 300_000);

  it('says nothing about the route when the root\'s own permit marker fired', async () => {
    setRuntimeConfigSnapshot(HOST_CONFIG as never);
    const { hook, tool } = await realRoot({
      ...baseRuntime,
      worldOwnerApproval: { asked: () => false },
      // `src/index.ts` calls `running()` and THEN builds the command context,
      // so a throw from here is a failure of the ACTION, after the permit.
      worldRuntime: { nativeCommandContext: () => { throw new Error('HOUSE_UNREACHABLE'); } },
      nativeWorldExecution: {
        bindFactory: () => ({
          withInvocation: async (_callId: string, _input: unknown, _signal: unknown,
            run: (permit: unknown) => Promise<unknown>) => run({ permit: true }),
        }),
      },
    });
    await refusedByTheGuard(hook, 'real-root-permitted');

    // A refusal was recorded for this very call, and it must still not be
    // appended: once the action ran, "the owner was never asked because …"
    // would make every unrelated error misleading. This is the root's own
    // `running()` call site, which nothing else exercises.
    expect(await failure(tool.execute('real-root-permitted', params))).toBe('HOUSE_UNREACHABLE');
  }, 300_000);

  it('still hands a call the owner was asked about to the owner lane', async () => {
    setRuntimeConfigSnapshot(HOST_CONFIG as never);
    const { hook, tool } = await realRoot({
      ...baseRuntime,
      worldOwnerApproval: {
        asked: () => true,
        withInvocation: async (_callId: string, _input: unknown, _signal: unknown,
          ask: (invocation: { reference: string }) => Promise<unknown>) => ask({ reference: 'REF-1' }),
      },
      worldRuntime: {
        ownerCommandContext: () => { throw new Error('OWNER_LANE_TAKEN'); },
        nativeCommandContext: () => { throw new Error('POLICY_LANE_TAKEN'); },
      },
      // Entering the policy lane at all is a failure with its own name, so a
      // root that stopped asking cannot look like a root that asked.
      nativeWorldExecution: { bindFactory: () => { throw new Error('POLICY_LANE_BOUND'); } },
    });
    await refusedByTheGuard(hook, 'real-root-owner');

    expect(await failure(tool.execute('real-root-owner', params))).toBe('OWNER_LANE_TAKEN');
  }, 300_000);
});

/** What an operator greps for. Deliberately free of apostrophes and of any
 *  value from the call, so the anchor itself can be typed at a shell. */
const GREP = 'owner approval refused the origin';
/** The refused call's own values, spelled so that a leak is unmistakable and
 *  cannot be a coincidence of some unrelated line. */
const LEAKY = {
  house: 'https://house.invalid/hs-7f3c-secret',
  kind: 'rangermap.check_in',
  params: { place: 'Pier-of-the-Seven-Winds', note: 'draft-body-nobody-may-log' },
  expected_capability_revision: 'd'.repeat(64),
};
/**
 * THE ABSENCE THIS FILE ASSERTS, VALUE BY VALUE.
 *
 * A redaction test that only checks what the line INCLUDES passes a line that
 * also carries everything else, so each of these is a specific string that was
 * really present in the refused call: the house, the action kind, both
 * parameter values, the capability revision the caller pinned, the owner's own
 * address (`turn()`'s `channelId` and `senderId`), the address the approval
 * would have been routed to (`HOST_CONFIG`'s target), and the session key.
 */
const MUST_NOT_APPEAR = [
  LEAKY.house, 'hs-7f3c-secret', LEAKY.kind,
  LEAKY.params.place, LEAKY.params.note, LEAKY.expected_capability_revision,
  '+8520', '+9999', 'agent:main:whatsapp:direct:1',
];
/** The policy lane of the measured instance shape: it refuses before any
 *  permit exists, which is what leaves the guard's reason to be reported. */
const refusingRuntime = {
  ...baseRuntime,
  worldOwnerApproval: { asked: () => false },
  worldRuntime: { nativeCommandContext: () => ({}) },
  nativeWorldExecution: {
    bindFactory: () => ({ withInvocation: async () => { throw new Error('NATIVE_POLICY_REQUIRED'); } }),
  },
};
const refusalLines = (logs: LogLines): string[] => logs.info.filter(line => line.includes(GREP));

describe('the shipped artifact writes a refused origin where an operator can find it', () => {
  it('logs one line carrying the tool, the call ref and the named reason', async () => {
    setRuntimeConfigSnapshot(HOST_CONFIG as never);
    const { hook, logs } = await realRoot(refusingRuntime);
    await refusedByTheGuard(hook, 'refusal-visible-1');

    // Exact equality, on the `info` channel: one line, those three facts, and
    // the `popclaw[warn]:` prefix that proves it went through `visibleLogger`
    // rather than past it.
    expect(refusalLines(logs)).toEqual([
      `popclaw[warn]: popclaw: owner approval refused the origin of ${WORLD_INVOKE} — `
      + 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN (tool_call_id refusal-visible-1)',
    ]);
    // Not on the host's warn/error channels — those are the ones the gateway
    // sends to a stderr that goes nowhere, which is how a guard once spent a
    // release logging into a sink nobody reads.
    expect([...logs.warn, ...logs.error, ...logs.debug].filter(l => l.includes(GREP))).toEqual([]);
  }, 300_000);

  it('keeps the refused call\'s parameters, house and addresses out of the log', async () => {
    setRuntimeConfigSnapshot(HOST_CONFIG as never);
    const { hook, logs } = await realRoot(refusingRuntime);
    expect(await hook(
      { toolName: WORLD_INVOKE, params: LEAKY, toolCallId: 'refusal-visible-2' },
      turn('refusal-visible-2'),
    )).toBeUndefined();

    // Measure the variable, not a lookalike: a build that logs NOTHING would
    // satisfy every absence below, so the line has to be there first.
    const [line, ...extra] = refusalLines(logs);
    expect(line, 'no refusal line was written, so the absences below prove nothing').toBeDefined();
    expect(extra, 'one refusal, one line').toEqual([]);
    for (const secret of MUST_NOT_APPEAR) {
      expect(line, `the refusal line carries ${secret}`).not.toContain(secret);
      // And not on a neighbouring line either — a leak moved one line over is
      // the same leak in the same file.
      expect(logs.info.join('\n'), `some logged line carries ${secret}`).not.toContain(secret);
    }
  }, 300_000);

  it('lets a throwing host logger lose the report and nothing else', async () => {
    setRuntimeConfigSnapshot(HOST_CONFIG as never);
    let armed = false;
    const { hook, tool, logs } = await realRoot(refusingRuntime, {
      logInfo: () => { if (armed) throw new Error('LOGGER_DOWN'); },
    });
    armed = true;

    // The hook answers the host exactly as it did before: `undefined`, not a
    // rejected promise. A report that became a thrown hook would take down
    // the call it was only supposed to describe.
    await refusedByTheGuard(hook, 'refusal-visible-3');
    // And the refusal itself survived the failed report — the agent's own
    // sentence still names it.
    expect(await failure(tool.execute('refusal-visible-3', params)))
      .toBe('NATIVE_POLICY_REQUIRED (OWNER_APPROVAL_UNAVAILABLE: OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN)');
    // The throwing sink really was reached: without this, a build that stopped
    // logging would pass this test too.
    expect(refusalLines(logs)).toHaveLength(1);
  }, 300_000);
});
