import { afterEach, expect, it, vi } from 'vitest';
import { cidFromCanonical } from '@popclaw/algorithms';
import plugin from '../../../src/index.js';
import { clearPerProcess, getOrCreatePerProcess } from '../../../src/runtime/once.js';
import { createWorldOwnerApproval } from '../../../src/host/openclaw-owner-approval.js';
import { consumeOwnerApproval, resetOwnerApprovals, ownerApprovalRecorded } from '../../../src/host/owner-approval.js';
import { WORLD_INVOKE_TOOL } from '../../../src/world/world-approval-subject.js';

const HOUSE = 'http://127.0.0.1:19863';
const ACTOR = '1'.repeat(32);
const KIND = 'rangermap.check_in';
const guideBytes = new TextEncoder().encode('Use rangermap.check_in to save a check-in.');
const manifestBytes = new TextEncoder().encode(JSON.stringify({
  world_interaction: { version: 1,
    actions: { status_endpoint: '/v1/world-actions/status', result_authority_pubkey: ACTOR,
      kinds: [KIND], attachments: [] },
    guide: { path: '/v1/guide.md', sha256: cidFromCanonical(guideBytes), revision: 'guide_1' } },
  intent_kinds: [{ kind: KIND, schema_version: 1, transport: 'typed', signer: 'user',
    description: 'Save check-in', params_schema: { type: 'object', properties: {
      latitude: { type: 'string' }, longitude: { type: 'string' }, place: { type: 'string' }, status: { type: 'string' } } },
    result_schema: { type: 'object' }, result_attachments: { allowed: [], required_on_success: [] }, consistency: 'none' }],
}));
const input = { house: HOUSE, expected_capability_revision: cidFromCanonical(manifestBytes), kind: KIND,
  params: { latitude: '0.0000', longitude: '0.0000', place: 'Synthetic-test', status: 'THREE-EFD-20261003-OC' } };
function verifiedView() {
  const valid = { validation: 'valid', detail: '', support: 'unsupported', ready: false } as const;
  return { verified: { house: { origin: HOUSE, houseKey: ACTOR, incarnation: 'house_1' },
    capabilityRevision: input.expected_capability_revision, manifestBytes, guideBytes,
    proofBytes: new Uint8Array([1, 2, 3]), pinProvenance: 'configured_pin' },
  actions: { ...valid, kinds: { [KIND]: valid } }, guide: valid, publicStream: valid,
  privateMessages: { ...valid, kinds: {} }, executionClosure: valid };
}
function runtimeFixture() {
  const owner = createWorldOwnerApproval();
  return { boot: { popclawId: ACTOR }, host: { db: { open: true } },
    orchestrator: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
    houseRuntime: { runCommand: async <T>(work: () => Promise<T>) => work() },
    worldRuntime: { readCapabilities: vi.fn<() => unknown>(() => verifiedView()) },
    worldOwnerApproval: owner,
    shutdown: vi.fn(async () => { owner.stop(); clearPerProcess('runtime'); }),
  };
}
type Handler = (...args: never[]) => unknown;
type Service = { id: string; start(): Promise<void>; stop(): Promise<void> };
function register(mode: 'full' | 'discovery') {
  const services = new Map<string, Service>();
  const hooks = new Map<string, Handler>();
  const api = { registrationMode: mode, config: {}, pluginConfig: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: { state: { resolveStateDir: () => '/tmp/popclaw-unused-lifecycle-test' } },
    registerService: (value: Service) => services.set(value.id, value), registerTool() {}, registerCommand() {},
    on: (name: string, handler: Handler) => hooks.set(name, handler),
  };
  plugin.register!(api as unknown as Parameters<NonNullable<typeof plugin.register>>[0]);
  return { services, stop: () => hooks.get('gateway_stop')!(),
    ask: (callId: string, params: unknown = input, senderIsOwner = true) => hooks.get('before_tool_call')!(
      { toolName: WORLD_INVOKE_TOOL, params, toolCallId: callId } as never,
      { toolCallId: callId, requester: { channel: 'tui', senderIsOwner } } as never) as Promise<{
        requireApproval: { onResolution(decision: string): void } } | undefined> };
}
afterEach(() => { clearPerProcess('runtime'); resetOwnerApprovals(); });

it('full then unstarted discovery still asks from the same verified runtime, without starting discovery services', async () => {
  const rt = runtimeFixture();
  getOrCreatePerProcess('runtime', () => Promise.resolve(rt));
  const full = register('full');
  await full.services.get('onboarding-orchestrator')!.start();
  expect(await full.ask('full-call')).toBeDefined();
  const discovery = register('discovery');
  const prompt = await full.ask('second-call');
  expect(prompt).toBeDefined();
  expect(await discovery.ask('discovery-call')).toBeDefined();
  expect(rt.orchestrator.start).toHaveBeenCalledTimes(1);
  // Unstarted discovery shutdown must not revoke the serving registration.
  await discovery.stop();
  expect(await full.ask('after-discovery-stop')).toBeDefined();
  prompt!.requireApproval.onResolution('allow-once');
  expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'wrong-call')).toMatchObject({ reason: 'CALL_MISMATCH' });
  expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, { ...input, params: { ...input.params, status: 'changed' } }, 'second-call'))
    .toMatchObject({ reason: 'SUBJECT_CHANGED' });
  expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'second-call')).toEqual({ decision: 'approved' });
  expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'second-call')).toMatchObject({ reason: 'ALREADY_CONSUMED' });
  expect(await full.ask('wrong-owner', input, false)).toBeUndefined();
  rt.worldRuntime.readCapabilities.mockReturnValue(null);
  expect(await full.ask('null-schema')).toBeUndefined();
  rt.worldRuntime.readCapabilities.mockReturnValue({ ...verifiedView(), guide: { validation: 'invalid' } });
  expect(await full.ask('untrusted-schema')).toBeUndefined();
});

it('shutdown revokes lookup before draining and restart uses only the new runtime', async () => {
  const first = runtimeFixture();
  let finish!: () => void;
  first.shutdown.mockImplementation(() => new Promise<void>(resolve => {
    finish = () => { first.worldOwnerApproval.stop(); clearPerProcess('runtime'); resolve(); };
  }));
  getOrCreatePerProcess('runtime', () => Promise.resolve(first));
  const full = register('full');
  await full.services.get('popclaw-runtime')!.start();
  register('discovery');
  const stopped = full.stop();
  expect(await full.ask('during-shutdown')).toBeUndefined();
  expect(first.worldRuntime.readCapabilities).not.toHaveBeenCalled();
  await Promise.resolve(); finish(); await stopped;
  const second = runtimeFixture();
  getOrCreatePerProcess('runtime', () => Promise.resolve(second));
  const next = register('full');
  await next.services.get('popclaw-runtime')!.start();
  expect(await next.ask('after-restart')).toBeDefined();
  expect(first.worldRuntime.readCapabilities).not.toHaveBeenCalled();
});

it('register-only, failed and stopped runtimes cannot publish an approval schema or boot from the hook', async () => {
  const discovery = register('discovery');
  expect(await discovery.ask('register-only')).toBeUndefined();
  const failed = Promise.reject(new Error('BOOT_FAILED'));
  failed.catch(() => {});
  getOrCreatePerProcess('runtime', () => failed);
  expect(await discovery.ask('failed-runtime')).toBeUndefined();
  clearPerProcess('runtime');
  const stopped = runtimeFixture();
  stopped.worldOwnerApproval.stop();
  getOrCreatePerProcess('runtime', () => Promise.resolve(stopped));
  expect(await discovery.ask('stopped-adapter')).toBeUndefined();
  expect(stopped.worldRuntime.readCapabilities).not.toHaveBeenCalled();
  expect(stopped.orchestrator.start).not.toHaveBeenCalled();
});

it('stopping during pending startup suppresses the late schema but still drains that runtime', async () => {
  const rt = runtimeFixture();
  let resolve!: (value: typeof rt) => void;
  getOrCreatePerProcess('runtime', () => new Promise<typeof rt>(done => { resolve = done; }));
  const full = register('full');
  const starting = full.services.get('popclaw-runtime')!.start();
  await Promise.resolve();
  const asking = full.ask('pending-startup');
  const stopping = full.stop();
  resolve(rt);
  await starting;
  expect(await asking).toBeUndefined();
  await stopping;
  expect(rt.shutdown).toHaveBeenCalledOnce();
  expect(rt.worldRuntime.readCapabilities).not.toHaveBeenCalled();
});

it.each(['shutdown', 'memo-replaced'])('refuses %s after schema read, before final hook return, without an asked record', async change => {
  const rt = runtimeFixture();
  const replacement = runtimeFixture();
  getOrCreatePerProcess('runtime', () => Promise.resolve(rt));
  const full = register('full');
  await full.services.get('popclaw-runtime')!.start();
  register('discovery');
  let stopping: unknown;
  rt.worldRuntime.readCapabilities.mockImplementation(() => {
    queueMicrotask(() => {
      if (change === 'shutdown') stopping = full.stop();
      else {
        clearPerProcess('runtime');
        getOrCreatePerProcess('runtime', () => Promise.resolve(replacement));
      }
    });
    return verifiedView();
  });
  expect(await full.ask('late-call')).toBeUndefined();
  await stopping;
  expect(ownerApprovalRecorded(WORLD_INVOKE_TOOL, 'late-call')).toBe(false);
  expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'late-call').decision).not.toBe('approved');
  expect(replacement.worldRuntime.readCapabilities).not.toHaveBeenCalled();
});

it('does not spend an old prompt answer in a replacement runtime', async () => {
  const rt = runtimeFixture();
  getOrCreatePerProcess('runtime', () => Promise.resolve(rt));
  const full = register('full');
  await full.services.get('popclaw-runtime')!.start();
  const prompt = await full.ask('approved-old-runtime');
  expect(prompt).toBeDefined();
  clearPerProcess('runtime');
  getOrCreatePerProcess('runtime', () => Promise.resolve(runtimeFixture()));
  prompt!.requireApproval.onResolution('allow-once');
  expect(ownerApprovalRecorded(WORLD_INVOKE_TOOL, 'approved-old-runtime')).toBe(true);
  expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'approved-old-runtime'))
    .toMatchObject({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'WORLD_ACTION_SCHEMA_UNAVAILABLE' });
  expect(ownerApprovalRecorded(WORLD_INVOKE_TOOL, 'approved-old-runtime')).toBe(true);
  expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'approved-old-runtime')).toMatchObject({ reason: 'ALREADY_CONSUMED' });
});

it('rechecks after prepare has recorded the subject, before the outer native hook returns', async () => {
  const rt = runtimeFixture();
  getOrCreatePerProcess('runtime', () => Promise.resolve(rt));
  const full = register('full');
  await full.services.get('popclaw-runtime')!.start();
  let checks = 0;
  let stopping: unknown;
  const active = rt.worldOwnerApproval.assertActive.bind(rt.worldOwnerApproval);
  rt.worldOwnerApproval = { ...rt.worldOwnerApproval, assertActive: () => {
    active();
    // Root lookup is #1; prepare's pre-record captured check is #2.
    if (++checks === 2) queueMicrotask(() => { stopping = full.stop(); });
  } };
  expect(await full.ask('stop-after-prepared')).toBeUndefined();
  await stopping;
  expect(checks).toBe(2);
  expect(ownerApprovalRecorded(WORLD_INVOKE_TOOL, 'stop-after-prepared')).toBe(false);
  expect(consumeOwnerApproval(WORLD_INVOKE_TOOL, input, 'stop-after-prepared').decision).not.toBe('approved');
});
