import { describe, expect, it } from 'vitest';
import { bindOwnerTurn, directIdentity, directSessionMatches, feishuOwnerCanApprove, ownerConfig } from '../../../src/host/owner-direct-binding.js';
import { resolveMergedAccountConfig } from 'openclaw/plugin-sdk/account-resolution';
import { createChannelApprovalAuth } from 'openclaw/plugin-sdk/approval-auth-runtime';

const ctx = { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'session-1',
  channelId: 'oc_private', turnSourceTo: 'user:ou_owner',
  requester: { channel: 'feishu', accountId: 'work', senderId: 'ou_owner', senderIsOwner: true } };
const binding = bindOwnerTurn(ctx)!;
const entry = () => ({ sessionId: 'session-1', chatType: 'direct', delivery: { kind: 'external',
  route: { channel: 'feishu', accountId: 'work', target: { to: 'user:ou_owner' } },
  context: { channel: 'feishu', accountId: 'work', to: 'user:ou_owner' },
  origin: { provider: 'feishu', accountId: 'work', from: 'feishu:ou_owner', to: 'user:ou_owner',
    nativeChannelId: 'oc_private', chatType: 'direct' } } });

describe('fresh Feishu direct owner binding', () => {
  it('separates the SDK native chat from its explicit user approval target', () => {
    expect(binding).toMatchObject({ nativeChannelId: 'oc_private', to: 'user:ou_owner', senderId: 'ou_owner' });
    expect(directSessionMatches(binding, entry())).toBe(true);
  });
  it.each([
    { ...ctx, sessionId: undefined }, { ...ctx, turnSourceThreadId: 'topic' },
    { ...ctx, turnSourceTo: 'chat:oc_private' }, { ...ctx, turnSourceTo: 'user:ou_other' },
    { ...ctx, channelId: 'chat:oc_private' },
    { ...ctx, requester: { ...ctx.requester, senderIsOwner: false } },
  ])('refuses an incomplete or ambiguous host tool context', changed => {
    expect(bindOwnerTurn(changed)).toBeNull();
  });
  it.each([
    (e: any) => { e.sessionId = 'new-session'; },
    (e: any) => { e.chatType = 'group'; },
    (e: any) => { e.delivery.route.target.to = 'user:ou_other'; },
    (e: any) => { e.delivery.route.accountId = 'other-account'; },
    (e: any) => { e.delivery.route.target.chatType = 'group'; },
    (e: any) => { e.delivery.route.thread = 'topic'; },
    (e: any) => { e.delivery.context.to = 'chat:oc_private'; },
    (e: any) => { e.delivery.context.accountId = 'other-account'; },
    (e: any) => { e.delivery.context.threadId = 'topic'; },
    (e: any) => { e.delivery.origin.from = 'feishu:ou_other'; },
    (e: any) => { e.delivery.origin.to = 'user:ou_other'; },
    (e: any) => { e.delivery.origin.nativeChannelId = 'oc_other'; },
    (e: any) => { delete e.delivery.origin.nativeChannelId; },
    (e: any) => { e.delivery.origin.chatType = 'group'; },
    (e: any) => { e.delivery.origin.threadId = 'topic'; },
  ])('refuses contradictory fresh session metadata', change => {
    const current = entry(); change(current);
    expect(directSessionMatches(binding, current)).toBe(false);
  });
  it.each(['oc_private', 'chat:ou_owner', 'feishu:chat:ou_owner', '*', 'ou_owner:topic'])('does not infer a user identity from %s', raw => {
    expect(directIdentity('feishu', raw)).toBeUndefined();
    expect(ownerConfig({ commands: { ownerAllowFrom: [raw] } }, 'feishu')).toBeNull();
  });
  it.each([
    { allowFrom: ['ou_other'], accounts: { work: { allowFrom: ['ou_owner'] } }, allowed: true },
    { allowFrom: ['ou_owner'], accounts: { work: { allowFrom: ['ou_other'] } }, allowed: false },
    { allowFrom: ['ou_other'], accounts: { work: { allowFrom: [] } }, allowed: true },
    { allowFrom: ['ou_owner'], accounts: { work: {} }, allowed: true },
    { allowFrom: [' LARK:OPEN_ID:OU_OWNER '], allowed: true },
    { allowFrom: ['ou_other'], allowed: false },
    { allowFrom: ['user_id_only'], allowed: true },
    { allowFrom: ['*'], allowed: true },
    { allowFrom: [], enabled: false, allowed: false },
  ])('uses current account approval authorization without rewriting its allowlist', ({ allowed, ...channelConfig }) => {
    const cfg = { channels: { feishu: channelConfig } };
    const before = structuredClone(cfg);
    expect(feishuOwnerCanApprove(binding, cfg, { resolveMergedAccountConfig, createChannelApprovalAuth })).toBe(allowed);
    expect(cfg).toEqual(before);
  });
});
