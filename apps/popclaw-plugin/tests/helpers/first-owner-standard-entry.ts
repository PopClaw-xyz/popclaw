/** Synthetic native host, using the registered shipping entry point and normal
 * SDK configuration/session APIs. No channel network, real identity, or send. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
const initial = { commands: { ownerAllowFrom: [`${channel}:${senderId}`] },
  channels: { [channel]: { enabled: true } }, approvals: { exec: { enabled: false } } };
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(initial), { mode: 0o600 });
const config = await import('openclaw/plugin-sdk/config-runtime');
const sessions = await import('openclaw/plugin-sdk/session-store-runtime');
const inbound = await import('openclaw/plugin-sdk/conversation-runtime');
const { putDraft, peekDraftSnapshot } = await import('../../src/tools/draft-store.js');
const { consumeOwnerApproval } = await import('../../src/host/owner-approval.js');
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
  registerService() {}, registerInteractiveHandler() {}, registerTool() {}, registerHook() {},
  on: (name: string, hook: any) => typed.set(name, hook),
  enqueueNextTurnInjection: async (injection: any) => { injections.push(injection); return { enqueued: true }; },
});
let sends = 0;
putDraft('message-1', async () => { sends++; return { text: 'synthetic send' }; },
  { kind: 'dm', recipientId: '1'.repeat(64), recipientLabel: 'Synthetic recipient',
    body: 'Complete original body', attachments: [], preview: null, output: null, house: 'https://synthetic.house.invalid' });
const before = peekDraftSnapshot('message-1');
const ctx = { agentId: 'main', sessionKey, sessionId: entry.sessionId, toolCallId: 'send-first',
  channelId: nativeChannelId, turnSourceTo: target,
  requester: { channel, accountId: 'default', senderId, senderIsOwner: true } };
const event = { toolName: 'popclaw_send_draft', toolCallId: 'send-first', params: { draft_id: 'message-1' } };
const hook = typed.get('before_tool_call')!;
const blocked = await hook(event, ctx);
assert.equal(blocked?.block, true, 'standard first send must provide preparation instead of an unexplained unavailable approval');
assert.equal(writes, 0, 'no approval config may be added before owner setup consent');
const token = blocked.blockReason.match(/\/popclaw approvals confirm ([0-9a-f]{32})/)?.[1];
assert(token);
assert.match(blocked.blockReason, /ALL plugins|所有插件/);
const commandCtx = { agentId: 'main', sessionKey, sessionId: entry.sessionId,
  channel, accountId: 'default', senderId, from: `${channel}:${senderId}`, to: target,
  isAuthorizedSender: true, config: snapshot.config, commandBody: `/popclaw approvals confirm ${token}`,
  args: `approvals confirm ${token}` };
const result = await command.handler(commandCtx);
const saved = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
assert.equal(saved.approvals.plugin.enabled, true);
assert.deepEqual(saved.approvals.exec, initial.approvals.exec);
assert.equal(writes, 1);
// If this isolated host has no live reload owner, apply the persisted config
// just as a gateway reload would, only AFTER the acknowledged SDK write.
let ready = result;
if (!ready.text.includes('message-1')) {
  config.setRuntimeConfigSnapshot(saved, saved);
  ready = await command.handler({ ...commandCtx, args: `approvals resume ${token}` });
}
assert.equal(ready.continueAgent, undefined, 'preparation commands must not promise or fabricate a new owner turn');
assert.match(ready.text, /reply|回复/i);
assert.match(ready.text, /message-1/);
assert.equal(injections.length, 0, 'new or unrelated owner intent must not receive an injected old draft action');
assert.deepEqual(peekDraftSnapshot('message-1'), before);
assert.equal(sends, 0);
// A command only delivered the above reply. A NEW ordinary owner message now
// requests this draft. This synthetic hook boundary does not run a live model.
const ordinaryOwnerMessage = 'continue sending draft message-1';
assert.match(ordinaryOwnerMessage, /message-1/);
await inbound.recordInboundSession({ storePath, sessionKey,
  ctx: { Provider: channel, Surface: channel, From: `${channel}:${senderId}`, To: target,
    AccountId: 'default', ChatType: 'direct', SenderId: senderId, NativeChannelId: nativeChannelId,
    SessionKey: sessionKey, RawBody: ordinaryOwnerMessage, CommandBody: ordinaryOwnerMessage },
  updateLastRoute: { sessionKey, channel, to: target, accountId: 'default' },
  trackSessionMetaTask: task => meta.push(task), onRecordError: error => { throw error; } });
await Promise.all(meta);
const nextSession = sessions.getSessionEntry({ agentId: 'main', sessionKey, readConsistency: 'latest' });
assert.equal(nextSession?.sessionId, entry.sessionId);
assert.deepEqual(peekDraftSnapshot('message-1'), before);
const ask = await hook({ ...event, toolCallId: 'send-fresh' }, { ...ctx, sessionId: nextSession!.sessionId, toolCallId: 'send-fresh' });
assert(ask?.requireApproval, 'the recovered original draft still requires native confirmation');
assert.deepEqual(ask.requireApproval.allowedDecisions, ['allow-once', 'deny']);
assert.match(ask.requireApproval.description, /Complete original body/);
assert.match(ask.requireApproval.description, /Synthetic recipient/);
assert.match(ask.requireApproval.description, /synthetic.house.invalid/);
assert.notEqual(consumeOwnerApproval('popclaw_send_draft', event.params, 'send-fresh').decision, 'approved');
assert.equal(sends, 0);
if (channel === 'feishu') {
  // The later native gate must re-check account authorization, even though an
  // earlier preparation command saved a pinned route. No allowlist is repaired.
  config.setRuntimeConfigSnapshot({ ...saved, channels: { feishu: { enabled: true, allowFrom: ['ou_other'] } } });
  const denied = await hook({ ...event, toolCallId: 'send-after-permission-change' },
    { ...ctx, toolCallId: 'send-after-permission-change' });
  assert.equal(denied?.requireApproval, undefined);
  config.setRuntimeConfigSnapshot(saved, saved);
  await inbound.recordInboundSession({ storePath, sessionKey,
    ctx: { Provider: channel, Surface: channel, From: `${channel}:${senderId}`, To: target,
      AccountId: 'default', ChatType: 'direct', SenderId: senderId, NativeChannelId: 'oc_other', SessionKey: sessionKey },
    updateLastRoute: { sessionKey, channel, to: target, accountId: 'default' },
    trackSessionMetaTask: task => meta.push(task), onRecordError: error => { throw error; } });
  await Promise.all(meta);
  const staleNativeChat = await hook({ ...event, toolCallId: 'send-stale-chat' }, { ...ctx, toolCallId: 'send-stale-chat' });
  assert.equal(staleNativeChat?.requireApproval, undefined);
  assert.deepEqual(peekDraftSnapshot('message-1'), before);
}
console.log(JSON.stringify({ standardEntry: true, channel, initialApprovalConfigAbsent: true,
  sdkSessionBindingVerified: true, sdkWrites: writes, userTriggeredOriginalDraft: true, automaticContinuation: false,
  oldDraftInjections: injections.length, originalHouseRecipientBodyPreserved: true,
  freshNativeApprovalRequired: true, allowedDecisions: ['allow-once', 'deny'], sends, stateDir }));
process.exit(0);
