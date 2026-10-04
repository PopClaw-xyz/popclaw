import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenClawApprovalSetup, type ApprovalSetupPorts } from '../../../src/host/openclaw-approval-setup.js';
import { feishuOwnerCanApprove } from '../../../src/host/owner-direct-binding.js';
import { resolveMergedAccountConfig } from 'openclaw/plugin-sdk/account-resolution';
import { createChannelApprovalAuth } from 'openclaw/plugin-sdk/approval-auth-runtime';

const owner = { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'session-1', channelId: '12345',
  turnSourceTo: '12345', requester: { channel: 'telegram', accountId: 'default', senderId: '12345', senderIsOwner: true } };
const event = { toolName: 'popclaw_send_draft', params: { draft_id: 'message-1' }, toolCallId: 'send-1' };
const command = { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'session-1',
  channel: 'telegram', accountId: 'default', senderId: '12345', to: '12345', isAuthorizedSender: true };
const entry = () => ({ sessionId: 'session-1', delivery: { kind: 'external',
  route: { channel: 'telegram', accountId: 'default', target: { to: '12345', chatType: 'direct' } },
  context: { channel: 'telegram', accountId: 'default', to: '12345' },
  origin: { provider: 'telegram', accountId: 'default', from: 'telegram:12345', to: '12345', chatType: 'direct' } } });
let cfg: any, session: any, hash: string, draft: string | null, now: number;
let ports: ApprovalSetupPorts;
let setup: ReturnType<typeof createOpenClawApprovalSetup>;
beforeEach(() => {
  cfg = { commands: { ownerAllowFrom: ['telegram:12345'] }, approvals: { exec: { enabled: false } } };
  session = entry(); hash = 'initial'; draft = 'original recipient and complete body'; now = 1000;
  ports = { current: () => cfg, readSnapshot: async () => ({ config: structuredClone(cfg), hash }),
    session: () => session, draft: () => draft, now: () => now, nonce: () => 'a'.repeat(32),
    conversation: b => b.agentId === 'main' && b.sessionKey === 'agent:main:main' && b.sessionId === 'session-1',
    canApprove: (b, config) => feishuOwnerCanApprove(b, config, { resolveMergedAccountConfig, createChannelApprovalAuth }),
    mutate: vi.fn(async (baseHash, mutate) => { if (hash !== baseHash) throw new Error('drift');
      const next = structuredClone(cfg); mutate(next); cfg = next; hash = 'written'; }),
    route: async (_b, planned) => ({ pinned: (planned ?? cfg).approvals?.plugin?.enabled === true }),
  };
  setup = createOpenClawApprovalSetup(ports);
});
const token = 'a'.repeat(32);
async function prepare() { return setup.before(event, owner); }
async function confirm(ctx = command) { return setup.command(['confirm', token], ctx); }

describe('first owner approval preparation', () => {
  it('does not promise automatic Telegram continuation after a reply-only native command', async () => {
    await prepare();
    const result = await confirm();
    expect(result.continueAgent).toBeUndefined();
    expect(result.text).toContain('message-1');
    expect(result.text).toMatch(/reply|回复/i);
  });
  it('explains unimplemented channel preparation with a concrete owner UI alternative', async () => {
    const blocked = await setup.before(event, { ...owner, requester: { ...owner.requester, channel: 'slack' } });
    expect(blocked?.blockReason).toMatch(/Control UI/);
    expect(blocked?.blockReason).toContain('message-1');
    expect(blocked?.blockReason).toMatch(/not implemented|尚未实现/);
    expect(blocked?.blockReason).not.toContain('confirm ');
    expect(ports.mutate).not.toHaveBeenCalled();
  });
  it('standard missing config pauses the native send without preconfiguring approvals', async () => {
    const blocked = await prepare();
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.blockReason).toContain(`/popclaw approvals confirm ${token}`);
    expect(blocked?.blockReason).toMatch(/all plugins|所有插件/i);
    expect(ports.mutate).not.toHaveBeenCalled();
    expect(draft).toBe('original recipient and complete body');
  });
  it('a trusted owner command prepares one exact route and preserves the original draft', async () => {
    await prepare();
    const result = await confirm();
    expect(result.continueAgent).toBeUndefined();
    expect(result.text).toContain('message-1');
    expect(cfg.approvals.plugin).toEqual({ enabled: true, mode: 'targets', agentFilter: ['main'],
      sessionFilter: ['^agent:main:main$'], targets: [{ channel: 'telegram', accountId: 'default', to: '12345' }] });
    expect(cfg.approvals.exec).toEqual({ enabled: false });
    expect(result.text).toMatch(/one-time|一次/);
    expect((await confirm()).continueAgent).not.toBe(true);
  });
  it('reuses correct existing settings without writing or staging another owner confirmation', async () => {
    cfg.approvals.plugin = { enabled: true, mode: 'targets', targets: [{ channel: 'telegram', to: '12345' }] };
    expect(await prepare()).toBeNull(); expect(ports.mutate).not.toHaveBeenCalled();
  });
  it.each([false, true])('preserves any explicitly configured block (enabled=%s)', async enabled => {
    cfg.approvals.plugin = { enabled, mode: 'both', targets: [{ channel: 'slack', to: 'other' }] };
    const before = structuredClone(cfg);
    expect(await prepare()).toBeNull(); expect(cfg).toEqual(before); expect(ports.mutate).not.toHaveBeenCalled();
  });
  it.each([
    { ...owner, requester: { ...owner.requester, senderIsOwner: false } },
    { ...owner, requester: { ...owner.requester, accountId: 'wrong' } },
    { ...owner, sessionKey: 'agent:other:main' },
    { ...owner, turnSourceTo: '67890' },
    { ...owner, turnSourceThreadId: 'topic' },
  ])('does not offer preparation on an untrusted or mismatched origin', async ctx => {
    const blocked = await setup.before(event, ctx);
    expect(blocked?.blockReason).not.toContain('confirm '); expect(ports.mutate).not.toHaveBeenCalled();
  });
  it.each(['group', 'channel'])('refuses %s metadata even for a host-recognized owner', async type => {
    session.delivery.origin.chatType = type; session.delivery.route.target.chatType = type;
    expect((await prepare())?.blockReason).not.toContain('confirm ');
  });
  it('refuses ambiguous owners and missing trusted delivery', async () => {
    cfg.commands.ownerAllowFrom.push('67890'); expect((await prepare())?.blockReason).not.toContain('confirm ');
    cfg.commands.ownerAllowFrom.pop(); session.delivery = { kind: 'none' };
    expect((await prepare())?.blockReason).not.toContain('confirm ');
  });
  it.each([
    { ...command, senderId: '67890' }, { ...command, accountId: 'wrong' },
    { ...command, sessionKey: 'agent:other:main' }, { ...command, sessionId: 'new-session' },
    { ...command, messageThreadId: 'topic' }, { ...command, isAuthorizedSender: false },
  ])('refuses stolen setup tokens from another identity, account, or session', async ctx => {
    await prepare(); expect((await confirm(ctx)).continueAgent).not.toBe(true); expect(ports.mutate).not.toHaveBeenCalled();
  });
  it('rejects config drift without overwriting concurrent changes', async () => {
    await prepare(); cfg.approvals.plugin = { enabled: false }; hash = 'concurrent';
    expect((await confirm()).continueAgent).not.toBe(true); expect(cfg.approvals.plugin).toEqual({ enabled: false });
  });
  it('keeps drafts after a write failure and never resumes', async () => {
    await prepare(); ports.mutate = vi.fn(async () => { throw new Error('sdk denied'); });
    expect((await confirm()).text).toMatch(/failed|失败/);
    expect(draft).not.toBeNull();
  });
  it('waits for active routing, then reports preparation ready without another write', async () => {
    ports.route = async (_b, planned) => ({ pinned: planned !== undefined }); await prepare();
    expect((await confirm()).text).toMatch(/not yet verified|尚未核实/);
    ports.route = async () => ({ pinned: true });
    expect((await setup.command(['resume', token], command)).text).toContain('message-1');
    expect(ports.mutate).toHaveBeenCalledTimes(1);
  });
  it.each([null, 'different content'])('never restores an expired, consumed, or replaced draft (%s)', async changed => {
    await prepare(); draft = changed;
    expect((await confirm()).continueAgent).not.toBe(true); expect(ports.mutate).not.toHaveBeenCalled();
  });
  it('expires preparation without extending the draft', async () => {
    await prepare(); now += 301_000;
    expect((await confirm()).continueAgent).not.toBe(true); expect(ports.mutate).not.toHaveBeenCalled();
  });
  it('does not prepare MCP/world calls or calls with invalid drafts', async () => {
    expect(await setup.before({ ...event, toolName: 'popclaw_world_invoke' }, owner)).toBeNull();
    draft = null; expect(await prepare()).toBeNull();
  });
  it.each(['webchat', 'tui'])('keeps the existing %s approval surface', async channel => {
    expect(await setup.before(event, { ...owner, requester: { ...owner.requester, channel } })).toBeNull();
  });
  it('does not claim installation or explicit configuration proves send readiness', async () => {
    expect((await setup.command([], command)).text).toMatch(/does not make private sending ready/);
    cfg.approvals.plugin = { enabled: false };
    expect((await setup.command([], command)).text).toMatch(/does not prove.*ready/);
    expect(ports.mutate).not.toHaveBeenCalled();
  });
  it('rejects missing runtime config and a failing snapshot reader', async () => {
    ports.current = () => { throw new Error('snapshot unavailable'); };
    expect((await prepare())?.block).toBe(true);
    ports.current = () => cfg;
    ports.readSnapshot = async () => { throw new Error('read denied'); };
    expect((await prepare())?.blockReason).not.toContain('confirm ');
    expect(ports.mutate).not.toHaveBeenCalled();
  });
  it('does not infer a binding when the SDK refuses its session read', async () => {
    ports.session = () => { throw new Error('session denied'); };
    expect((await prepare())?.blockReason).not.toContain('confirm ');
  });
  it('refuses an old owner binding after owner configuration changes', async () => {
    await prepare(); cfg.commands.ownerAllowFrom = ['telegram:67890'];
    expect((await confirm()).continueAgent).not.toBe(true);
    expect(ports.mutate).not.toHaveBeenCalled();
  });
  it('does not offer a plan rejected by the host route preflight', async () => {
    ports.route = async () => ({ pinned: false });
    expect((await prepare())?.blockReason).not.toContain('confirm ');
  });
  it('serializes duplicate setup confirmations', async () => {
    await prepare();
    let complete!: () => void;
    ports.mutate = vi.fn(async (_base, mutate) => { await new Promise<void>(r => { complete = r; }); mutate(cfg); });
    const first = confirm();
    expect((await confirm()).continueAgent).not.toBe(true);
    complete(); expect((await first).text).toContain('message-1');
    expect(ports.mutate).toHaveBeenCalledTimes(1);
  });
});

describe('first Feishu owner preparation', () => {
  const feishuOwner = { ...owner, channelId: 'oc_private', turnSourceTo: 'user:ou_owner',
    requester: { ...owner.requester, channel: 'feishu', senderId: 'ou_owner' } };
  const feishuCommand = { ...command, channel: 'feishu', senderId: 'ou_owner', to: 'user:ou_owner' };
  beforeEach(() => {
    cfg.commands.ownerAllowFrom = ['feishu:ou_owner'];
    session = { sessionId: 'session-1', chatType: 'direct', delivery: { kind: 'external',
      route: { channel: 'feishu', accountId: 'default', target: { to: 'user:ou_owner' } },
      context: { channel: 'feishu', accountId: 'default', to: 'user:ou_owner' },
      origin: { provider: 'feishu', accountId: 'default', from: 'feishu:ou_owner', to: 'user:ou_owner',
        nativeChannelId: 'oc_private', chatType: 'direct' } } };
  });
  it('keeps native chat provenance while preparing the current owner user target', async () => {
    expect((await setup.before(event, feishuOwner))?.blockReason).toContain('confirm ');
    expect(ports.mutate).not.toHaveBeenCalled();
    expect((await confirm(feishuCommand)).text).toContain('message-1');
    expect(cfg.approvals.plugin.targets).toEqual([{ channel: 'feishu', accountId: 'default', to: 'user:ou_owner' }]);
    expect(ports.mutate).toHaveBeenCalledTimes(1);
  });
  it('refuses a command after the native direct chat changes within the same session key', async () => {
    await setup.before(event, feishuOwner); session.delivery.origin.nativeChannelId = 'oc_other';
    await confirm(feishuCommand); expect(ports.mutate).not.toHaveBeenCalled();
  });
  it('refuses a stale conversation registry binding before preparing', async () => {
    ports.conversation = () => false;
    expect((await setup.before(event, feishuOwner))?.blockReason).not.toContain('confirm ');
    expect(ports.mutate).not.toHaveBeenCalled();
  });
  it('does not prepare an owner whom the current Feishu account forbids from approving', async () => {
    cfg.channels = { feishu: { dmPolicy: 'open', allowFrom: ['ou_other'] } };
    expect((await setup.before(event, feishuOwner))?.blockReason).not.toContain('confirm ');
    expect(ports.mutate).not.toHaveBeenCalled();
    expect(cfg.channels.feishu.allowFrom).toEqual(['ou_other']);
  });
  it('rejects approval permission changes between preparation and confirmation', async () => {
    await setup.before(event, feishuOwner);
    cfg.channels = { feishu: { allowFrom: ['ou_other'] } };
    await confirm(feishuCommand); expect(ports.mutate).not.toHaveBeenCalled();
  });
});
