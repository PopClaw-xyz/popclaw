import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

// Independent bundles reproduce the host loading hooks and tools separately.
// The actual SDK wrapper/broker and actual send tool run; only the final sender
// is synthetic. No product runtime, remote service, or real approval is used.
test('native approval survives separate module loads without widening grants', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const sdk = realpathSync(join(root, 'node_modules/openclaw'));
  assert.equal(JSON.parse(readFileSync(join(sdk, 'package.json'))).version, '2026.9.8');
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'popclaw-native-approval-')));
  symlinkSync(join(root, 'node_modules'), join(box, 'node_modules'), 'dir');
  process.env.HOME = join(box, 'home');
  process.env.OPENCLAW_STATE_DIR = join(box, 'state');
  process.env.OPENCLAW_CONFIG_PATH = join(box, 'state/openclaw.json');
  process.env.POPCLAW_DATA_ROOT = join(box, 'popclaw');
  mkdirSync(process.env.HOME); mkdirSync(process.env.OPENCLAW_STATE_DIR);
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH, '{}');
  const spec = file => JSON.stringify(join(root, 'src', file));
  const entry = `
    import {registerWriteTools} from ${spec('tools/write-tools.ts')};
    import {putDraft,noteDraftToolOutput,peekDraftSnapshot} from ${spec('tools/draft-store.ts')};
    export * from ${spec('host/owner-approval.ts')};
    export {registerOpenClawOwnerApprovalHooks} from ${spec('host/openclaw-owner-approval-hooks.ts')};
    export {peekDraftSnapshot};
    export function makeSendTool() {
      const tools=[]; const runtime=async()=>{throw Error('runtime must not boot');};
      const api={registerTool(tool){tools.push(tool);}};
      registerWriteTools({api,runtime,deps:{api,runtime},total:4});
      return tools.find(t=>t.name==='popclaw_send_draft');
    }
    export function seed(id,sent,body='Synthetic native approval fixture.') {
      putDraft(id,async()=>{sent();return {text:'synthetic sender completed'};},
        {kind:'dm',recipientId:'synthetic-recipient',recipientLabel:'Synthetic recipient',
         house:'house-synthetic',body,attachments:[],preview:null,output:null});
      noteDraftToolOutput(id,body);
    }`;
  await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    absWorkingDir: root, tsconfig: join(root, 'tsconfig.json'), outfile: join(box, 'a.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: ['openclaw', 'openclaw/*', 'better-sqlite3', 'bindings', 'file-uri-to-path'],
    banner: { js: "import {createRequire as __fixtureRequire} from 'node:module';const require=__fixtureRequire(import.meta.url);" },
  });
  writeFileSync(join(box, 'b.mjs'), readFileSync(join(box, 'a.mjs')));
  const a = await import(pathToFileURL(join(box, 'a.mjs')));
  const b = await import(pathToFileURL(join(box, 'b.mjs')));
  const sdkModule = prefix => {
    const files = readdirSync(join(sdk, 'dist')).filter(name => name.startsWith(prefix) && name.endsWith('.mjs'));
    assert.equal(files.length, 1, `one official SDK module for ${prefix}`);
    return import(pathToFileURL(join(sdk, 'dist', files[0])));
  };
  const host = await sdkModule('agent-tools.before-tool-call-');
  const embedded = await sdkModule('embedded-mode-');
  const hooks = await import(pathToFileURL(join(sdk, 'dist/plugins/hook-runner-global.js')));
  embedded.n(true);
  const broker = new host.Y(); host.Z(broker);
  let decision = 'allow-once', beforeDecision = () => {}, sent = 0;
  const countSend = () => sent++;
  const events = [], reports = [];
  broker.subscribe(event => {
    events.push(event);
    if (event.event === 'plugin.approval.requested') queueMicrotask(() => {
      beforeDecision(); broker.resolve(event.payload.id, decision);
    });
  });
  function install(module) {
    const registry = { plugins: [{ id: 'popclaw' }], hooks: [], typedHooks: [], trustedToolPolicies: [] };
    module.registerOpenClawOwnerApprovalHooks({
      on(hookName, handler) { registry.typedHooks.push({ pluginId: 'popclaw', hookName, handler }); },
      logger: { info() {}, warn(message) { reports.push(message); }, error(message) { reports.push(message); } },
    });
    hooks.initializeGlobalHookRunner(registry);
  }
  const ctx = { agentId: 'main', sessionKey: 'agent:main:synthetic', sessionId: 'synthetic-session',
    runId: 'synthetic-run', config: {}, requester: { channel: 'tui', senderId: 'owner', senderIsOwner: true } };
  const native = (tool, call, draft, context = ctx, signal) =>
    host.l(tool, context).execute(call, { draft_id: draft }, signal);
  try {
    a.resetOwnerApprovals(); b.resetOwnerApprovals();
    const toolA = a.makeSendTool(), toolB = b.makeSendTool();
    install(a); a.seed('message-same', countSend);
    assert.equal((await native(toolA, 'native:same', 'message-same')).text, 'synthetic sender completed');
    install(b); a.seed('message-cross', countSend);
    assert.equal((await native(toolA, 'native:cross', 'message-cross')).text, 'synthetic sender completed');
    assert.equal(sent, 2);
    assert.equal(a.peekDraftSnapshot('message-cross'), null);
    assert.equal(reports.some(line => line.includes('granted and never consumed')), false);
    assert.match((await toolA.execute('native:cross', { draft_id: 'message-cross' })).text, /ALREADY_CONSUMED/);
    assert.equal(sent, 2);

    a.seed('message-wrong-call', countSend);
    const request = await b.ownerApprovalBeforeToolCall({ toolName: toolA.name,
      toolCallId: 'native:bound', params: { draft_id: 'message-wrong-call' } }, ctx);
    assert.ok(request); request.requireApproval.onResolution('allow-once');
    assert.match((await native(toolA, 'native:other-session', 'message-wrong-call', {
      ...ctx, sessionId: 'other-session', sessionKey: 'agent:other:synthetic',
      requester: { ...ctx.requester, senderIsOwner: false },
    })).text, /ORIGIN_NOT_OWNER_DIRECT/);
    assert.match((await toolA.execute('native:other-call', { draft_id: 'message-wrong-call' })).text, /CALL_MISMATCH/);
    assert.equal(sent, 2);
    assert.equal((await toolA.execute('native:bound', { draft_id: 'message-wrong-call' })).text, 'synthetic sender completed');

    decision = 'deny'; a.seed('message-denied', countSend);
    await assert.rejects(native(toolA, 'native:deny', 'message-denied'), /Denied by user/);
    assert.equal(sent, 3); assert.ok(a.peekDraftSnapshot('message-denied'));
    decision = 'allow-once'; a.seed('message-changed', countSend);
    beforeDecision = () => a.seed('message-changed', countSend, 'Different synthetic content.');
    assert.match((await native(toolA, 'native:changed', 'message-changed')).text, /SUBJECT_CHANGED/);
    assert.equal(sent, 3); beforeDecision = () => {};
    const abort = new AbortController(); a.seed('message-cancelled', countSend);
    beforeDecision = () => abort.abort(new DOMException('Synthetic run closed', 'AbortError'));
    await assert.rejects(native(toolA, 'native:cancel', 'message-cancelled', ctx, abort.signal), /cancelled|closed/i);
    assert.equal(sent, 3); assert.ok(a.peekDraftSnapshot('message-cancelled')); beforeDecision = () => {};

    // A departing module owns only its records. A late answer cannot revive
    // its removed call, while the other module's current pending call survives.
    install(a); a.seed('message-old', countSend);
    const old = await a.ownerApprovalBeforeToolCall({ toolName: toolA.name, toolCallId: 'native:old',
      params: { draft_id: 'message-old' } }, ctx);
    install(b); b.seed('message-live', countSend);
    const live = await b.ownerApprovalBeforeToolCall({ toolName: toolB.name, toolCallId: 'native:live',
      params: { draft_id: 'message-live' } }, ctx);
    assert.ok(old); assert.ok(live);
    a.resetOwnerApprovals(); a.makeSendTool();
    old.requireApproval.onResolution('allow-once'); live.requireApproval.onResolution('allow-once');
    assert.notEqual((await toolA.execute('native:old', { draft_id: 'message-old' })).text, 'synthetic sender completed');
    assert.equal((await toolB.execute('native:live', { draft_id: 'message-live' })).text, 'synthetic sender completed');
    assert.equal(sent, 4);

    console.log(JSON.stringify({ sdk: '2026.9.8', box, syntheticSends: sent,
      nativeApprovalRequests: events.filter(e => e.event === 'plugin.approval.requested').length }));
  } finally {
    broker.stop(); host.X(broker); embedded.n(false); hooks.resetGlobalHookRunner();
    a.resetOwnerApprovals(); b.resetOwnerApprovals();
  }
});
