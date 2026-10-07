/** Synthetic native host, using the registered shipping entry point and normal
 * SDK configuration/session APIs. No channel network, real identity, or send. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const stateDir = mkdtempSync(join(tmpdir(), 'popclaw-owner-setup-native-'));
const channel = process.argv.includes('--feishu') ? 'feishu' : 'telegram';
const senderId = channel === 'feishu' ? 'ou_synthetic' : '12345';
const target = channel === 'feishu' ? `user:${senderId}` : senderId;
const nativeChannelId = channel === 'feishu' ? 'oc_synthetic' : target;
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = join(stateDir, 'openclaw.json');
process.env.HOME = join(stateDir, 'home');
process.env.POPCLAW_DATA_ROOT = join(stateDir, 'popclaw');
mkdirSync(process.env.HOME);
mkdirSync(join(process.env.POPCLAW_DATA_ROOT, 'config'), { recursive: true });
writeFileSync(join(process.env.POPCLAW_DATA_ROOT, 'config/plugin.json'), JSON.stringify({
  lore_houses: ['http://127.0.0.1:59999'], canvas_base_url: 'http://127.0.0.1:59999',
}));
globalThis.fetch = async () => { throw new Error('fixture forbids network'); };
const initial = { commands: { ownerAllowFrom: [`${channel}:${senderId}`] },
  channels: { [channel]: { enabled: true } }, approvals: { exec: { enabled: false } } };
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(initial), { mode: 0o600 });
const config = await import('openclaw/plugin-sdk/config-runtime');
const sessions = await import('openclaw/plugin-sdk/session-store-runtime');
const inbound = await import('openclaw/plugin-sdk/conversation-runtime');
const {loadDurableNativeSdk} = await import('../../scripts/tests/helpers/durable-native-sdk.mjs');
const {fixtureKey} = await import('./durable-social-process.js');
const {popclaw} = await import('@popclaw/contracts');
const sessionKey = 'agent:main:main';
const storePath = sessions.resolveStorePath(undefined, { agentId: 'main' });
const meta: Promise<unknown>[] = [];
await inbound.recordInboundSession({ storePath, sessionKey, createIfMissing: true,
  ctx: { Provider: channel, Surface: channel, From: `${channel}:${senderId}`, To: target,
    AccountId: 'default', ChatType: 'direct', SenderId: senderId, NativeChannelId: nativeChannelId, SessionKey: sessionKey },
  updateLastRoute: { sessionKey, channel, to: target, accountId: 'default',
    ...(channel === 'telegram' ? { route: { channel, accountId: 'default', target: { to: target, chatType: 'direct' as const } } } : {}) },
  trackSessionMetaTask: task => meta.push(task), onRecordError: error => { throw error; },
});
await Promise.all(meta);
const entry = sessions.getSessionEntry({ agentId: 'main', sessionKey, readConsistency: 'latest' });
assert(entry?.sessionId);
const binding = sessions.getConversationSession({ agentId: 'main', channel, accountId: 'default', kind: 'direct', peerId: senderId });
assert.equal(binding?.sessionKey, sessionKey);
const { snapshot } = await config.readConfigFileSnapshotForWrite();
assert(snapshot.valid);
assert.equal(snapshot.config.approvals?.plugin, undefined);
config.setRuntimeConfigSnapshot(snapshot.config, snapshot.config);
const typed = new Map<string, (event: any, ctx: any) => Promise<any>>();
let command: any;
let sendFactory: any;
let runtimeService: any;
const injections: any[] = [];
let writes = 0;
const bundle = process.env.POPCLAW_APPROVAL_ROOT_BASELINE ?? join(process.cwd(), 'dist/bundled/index.js');
const { default: plugin } = await import(pathToFileURL(bundle).href);
plugin.register({ registrationMode: 'full', pluginConfig: {}, config: snapshot.config,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  runtime: { state: { resolveStateDir: () => stateDir },
    config: { current: config.getRuntimeConfig,
      mutateConfigFile: async (params: any) => { writes++; return config.mutateConfigFile(params); } },
    agent: { session: { getSessionEntry: sessions.getSessionEntry } },
    system: { enqueueSystemEvent: () => true, runHeartbeatOnce: async () => undefined } },
  registerCommand: (definition: any) => { command = definition; },
  registerService: (service: any) => { if (service.id === 'popclaw-runtime') runtimeService = service; },
  registerInteractiveHandler() {}, registerHook() {},
  registerTool: (definition: any, opts: any) => { if (opts?.name === 'popclaw_send_draft') sendFactory = definition; },
  on: (name: string, hook: any) => typed.set(name, hook),
  enqueueNextTurnInjection: async (injection: any) => { injections.push(injection); return { enqueued: true }; },
});
assert.equal(sendFactory?.contextVersion, 2);
assert.equal(typeof sendFactory.create, 'function');
assert(runtimeService);
// Shipping entry hooks/configuration above remain under test. The positive
// draft/send uses the same source registrations through the official SDK
// wrapper, real SQLite and signing, with only final egress synthetic.
// Never inject an in-memory send closure as proof of a durable manuscript.
let current = true;
const assertCurrent = () => {if (!current) throw new Error('SYNTHETIC_INVOCATION_REVOKED');};
const sdk = await loadDurableNativeSdk({root: process.cwd(), box: mkdtempSync(join(tmpdir(), 'popclaw-first-entry-sdk-')),
  env: {...process.env}, context: {config: snapshot.config, agentId: 'main', sessionKey,
    sessionId: entry.sessionId, requesterSenderId: senderId, senderIsOwner: false}});
const tools = sdk.tools(assertCurrent);
const draftTool = tools.find((tool: any) => tool.name === 'popclaw_draft_message')!;
const draft = await draftTool.execute('real-preparation', {recipient: fixtureKey(5).id, body: 'Complete original body'});
const resultText = (r: any): string => r.text ?? r.content?.find((part: any) => part.type === 'text')?.text;
const draftId = /draft_id: (\S+)/.exec(resultText(draft))![1]!;
const before = sdk.runtime.manuscript(draftId);
assert(before?.output);
const ctx = { agentId: 'main', sessionKey, sessionId: entry.sessionId, toolCallId: 'send-first',
  channelId: nativeChannelId, turnSourceTo: target,
  requester: { channel, accountId: 'default', senderId, senderIsOwner: true } };
const event = { toolName: 'popclaw_send_draft', toolCallId: 'send-first', params: { draft_id: draftId } };
const hook = typed.get('before_tool_call')!;
assert.equal(await hook(event, ctx), undefined, 'ordinary social sends do not request a second native approval');
const commandCtx = { agentId: 'main', sessionKey, sessionId: entry.sessionId,
  channel, accountId: 'default', senderId, from: `${channel}:${senderId}`, to: target,
  isAuthorizedSender: true, config: snapshot.config };
for (const args of ['approvals', `approvals confirm ${'0'.repeat(32)}`, `approvals resume ${'0'.repeat(32)}`]) {
  const result = await command.handler({ ...commandCtx, args, commandBody: `/popclaw ${args}` });
  assert.match(result.text, /one manuscript review and confirmation|原对话/);
  assert.equal(result.continueAgent, undefined, 'retired commands must not fabricate a new owner turn');
}
const saved = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
assert.deepEqual(saved, initial);
assert.equal(writes, 0, 'ordinary sends and retired commands must not enable approvals for all plugins');
assert.equal(injections.length, 0, 'new or unrelated owner intent must not receive an injected old draft action');
assert.deepEqual(sdk.runtime.manuscript(draftId), before);
assert.equal(sdk.runtime.effects(), 0);
// A NEW ordinary owner message requests the original manuscript. The host
// admission and owner facts below are synthetic; no live model or IM auth runs.
const ordinaryOwnerMessage = `continue sending draft ${draftId}`;
assert(ordinaryOwnerMessage.includes(draftId));
await inbound.recordInboundSession({ storePath, sessionKey,
  ctx: { Provider: channel, Surface: channel, From: `${channel}:${senderId}`, To: target,
    AccountId: 'default', ChatType: 'direct', SenderId: senderId, NativeChannelId: nativeChannelId,
    SessionKey: sessionKey, RawBody: ordinaryOwnerMessage, CommandBody: ordinaryOwnerMessage },
  updateLastRoute: { sessionKey, channel, to: target, accountId: 'default' },
  trackSessionMetaTask: task => meta.push(task), onRecordError: error => { throw error; } });
await Promise.all(meta);
const nextSession = sessions.getSessionEntry({ agentId: 'main', sessionKey, readConsistency: 'latest' });
assert.equal(nextSession?.sessionId, entry.sessionId);
assert.deepEqual(sdk.runtime.manuscript(draftId), before);
assert.equal(await hook({ ...event, toolCallId: 'send-fresh' }, { ...ctx, toolCallId: 'send-fresh' }), undefined);
const invocation = { agentId: 'main', sessionKey, sessionId: nextSession!.sessionId,
  requesterSenderId: senderId, senderIsOwner: false,
  assertInvocationCurrent: assertCurrent };
const sendTool = (context: any) => {
  const {assertInvocationCurrent, ...scope} = context;
  return sdk.tools(assertInvocationCurrent, scope).find((tool: any) => tool.name === 'popclaw_send_draft')!;
};
const send = (context: unknown) => sendTool(context).execute('send-fresh', event.params);
const text = (result: any): string => result.text ?? result.content?.find((item: any) => item.type === 'text')?.text;
for (const change of [{ messageChannel: 'another-channel' }, { agentAccountId: 'another-account' }, { assertInvocationCurrent: undefined },
  { sessionId: 'other-session' }, { sessionKey: 'agent:main:other' },
  { agentId: 'other-agent' }, { requesterSenderId: 'other-owner' }]) {
  if ('assertInvocationCurrent' in change) await assert.rejects(send({ ...invocation, ...change }), /authority is unavailable outside an admitted run or request/);
  else assert(!text(await send({ ...invocation, ...change })).includes('event_id:'));
  assert.equal(sdk.runtime.effects(), 0);
  assert.deepEqual(sdk.runtime.manuscript(draftId), before);
}
const staleTool = sendTool(invocation);
current = false;
await assert.rejects(staleTool.execute('stale-confirmation', event.params), /SYNTHETIC_INVOCATION_REVOKED/);
assert.equal(sdk.runtime.effects(), 0);
assert.deepEqual(sdk.runtime.manuscript(draftId), before);
current = true;
assert.match(text(await send(invocation)), /event_id:/);
assert.equal(sdk.runtime.effects(), 1);
const effect = sdk.runtime.effectsData()[0];
assert.equal(effect.house, before.house);
const signed = popclaw.identity.SignedPayload.decode(effect.bytes);
const sentEnvelope = popclaw.event.EventEnvelope.decode(signed.payload);
assert.equal(sentEnvelope.directMessage?.toPopclawId, before.recipientId);
assert.deepEqual(fixtureKey(5).signer.openDm(sentEnvelope.directMessage!, fixtureKey(3).id),
  {ok: true, plaintext: before.body, plaintextBytes: new TextEncoder().encode(before.body)});
assert.equal(sdk.runtime.manuscript(draftId), null);
assert(!text(await send(invocation)).includes('event_id:'));
assert.equal(sdk.runtime.effects(), 1, 'a consumed draft must never be sent twice');
assert.equal(writes, 0);
assert.equal(injections.length, 0);
assert.deepEqual(JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8')), initial);
await runtimeService.stop();
await sdk.close();
console.log(JSON.stringify({ standardEntry: true, channel, initialApprovalConfigAbsent: true,
  sdkSessionBindingVerified: true, sdkWrites: writes, userTriggeredOriginalDraft: true, automaticContinuation: false,
  oldDraftInjections: injections.length, originalHouseRecipientBodyPreserved: true,
  secondNativeApprovalAbsent: true, currentInvocationRequired: true, rejectedInvocationsPreserveDraft: true,
  singleUseVerified: true, sends: 1, durablePreparationThroughSdk: true, sdkWrapperVerified: true,
  fixtureBoundary: 'shipping entry hooks plus product registrations under official SDK; synthetic egress, no live channel', stateDir }));
process.exit(0);
