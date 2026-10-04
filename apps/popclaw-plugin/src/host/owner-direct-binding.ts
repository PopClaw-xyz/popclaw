/** Transport-specific proof for first-use preparation. A host owner flag and
 * current direct session are required together; destinations are never inferred
 * from model arguments or group addresses. No host SDK is loaded by MCP import.
 */
import type { OwnerApprovalToolContext } from './owner-approval.js';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

export interface OwnerDirectBinding {
  agentId: string; sessionKey: string; sessionId: string;
  channel: 'telegram' | 'feishu'; accountId: string; to: string; senderId: string;
  nativeChannelId: string;
}
export type DirectToolContext = OwnerApprovalToolContext & { sessionId?: string; turnSourceThreadId?: string | number };
export const field = (value: unknown, key: string): unknown => value && typeof value === 'object'
  ? (value as Record<string, unknown>)[key] : undefined;
export const str = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

export function directIdentity(channel: OwnerDirectBinding['channel'], value: unknown): string | undefined {
  let raw = str(value);
  if (channel === 'telegram') {
    raw = raw?.replace(/^telegram:/, '');
    return raw && /^[1-9][0-9]*$/.test(raw) ? raw : undefined;
  }
  raw = raw?.replace(/^feishu:/, '').replace(/^(user|open_id):/, '');
  return raw && !raw.startsWith('oc_') && /^[A-Za-z0-9_-]+$/.test(raw) ? raw : undefined;
}
export function ownerConfig(cfg: unknown, channel: OwnerDirectBinding['channel']): string | null {
  const entries = field(field(cfg, 'commands'), 'ownerAllowFrom');
  if (!Array.isArray(entries) || entries.length !== 1 || !directIdentity(channel, String(entries[0]))) return null;
  return JSON.stringify(entries);
}
export function bindOwnerTurn(ctx: DirectToolContext): OwnerDirectBinding | null {
  const r = ctx.requester;
  if (r?.senderIsOwner !== true || !['telegram', 'feishu'].includes(r.channel ?? '')
    || !ctx.agentId || !ctx.sessionKey || !ctx.sessionId || !r.accountId || !r.senderId
    || !ctx.channelId || !ctx.turnSourceTo || ctx.turnSourceThreadId !== undefined) return null;
  const channel = r.channel as OwnerDirectBinding['channel'];
  if (directIdentity(channel, r.senderId) !== r.senderId) return null;
  if (channel === 'telegram' && (ctx.channelId !== ctx.turnSourceTo
    || directIdentity(channel, ctx.turnSourceTo) !== r.senderId)) return null;
  // Feishu's host threading adapter exposes the native oc_ chat as channelId,
  // but the actual reply/approval source is the explicit user: sender target.
  if (channel === 'feishu' && (ctx.turnSourceTo !== `user:${r.senderId}`
    || (ctx.channelId !== ctx.turnSourceTo && !/^oc_[A-Za-z0-9_-]+$/.test(ctx.channelId)))) return null;
  return { agentId: ctx.agentId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId,
    channel, accountId: r.accountId, senderId: r.senderId, to: ctx.turnSourceTo, nativeChannelId: ctx.channelId };
}
export function directSessionMatches(b: OwnerDirectBinding, entry: unknown): boolean {
  const d = field(entry, 'delivery'), r = field(d, 'route'), c = field(d, 'context'), o = field(d, 'origin');
  const directTarget = (value: unknown) => b.channel === 'feishu' ? value === b.to : directIdentity(b.channel, value) === b.senderId;
  return field(entry, 'sessionId') === b.sessionId && field(d, 'kind') === 'external'
    && (field(entry, 'chatType') === undefined || field(entry, 'chatType') === 'direct')
    && field(r, 'channel') === b.channel && field(r, 'accountId') === b.accountId && field(r, 'thread') === undefined
    && [undefined, 'direct'].includes(field(field(r, 'target'), 'chatType') as string | undefined)
    && directTarget(field(field(r, 'target'), 'to'))
    && field(c, 'channel') === b.channel && field(c, 'accountId') === b.accountId && field(c, 'threadId') === undefined
    && directTarget(field(c, 'to'))
    && field(o, 'provider') === b.channel && field(o, 'accountId') === b.accountId
    && field(o, 'chatType') === 'direct' && field(o, 'threadId') === undefined
    && directIdentity(b.channel, field(o, 'from')) === b.senderId && directTarget(field(o, 'to'))
    && (b.channel !== 'feishu' || (field(o, 'nativeChannelId') ?? b.to) === b.nativeChannelId);
}
interface FeishuApprovalSdk {
  resolveMergedAccountConfig: typeof import('openclaw/plugin-sdk/account-resolution')['resolveMergedAccountConfig'];
  createChannelApprovalAuth: typeof import('openclaw/plugin-sdk/approval-auth-runtime')['createChannelApprovalAuth'];
}
/** Match v2026.9.4's account-scoped Feishu /approve policy using public SDK
 * merge and authorization helpers. Do not alter channel allowFrom to make a
 * host owner eligible. Empty effective approvers use the SDK same-chat rule.
 */
export function feishuOwnerCanApprove(b: OwnerDirectBinding, cfg: unknown, sdk: FeishuApprovalSdk): boolean {
  if (b.channel !== 'feishu') return true;
  try {
    const channelConfig = field(field(cfg, 'channels'), 'feishu') as Record<string, unknown> | undefined;
    const merged = sdk.resolveMergedAccountConfig({ channelConfig,
      accounts: field(channelConfig, 'accounts') as Record<string, Record<string, unknown>> | undefined,
      accountId: b.accountId, omitKeys: ['defaultAccount'], nestedObjectKeys: ['tools'] });
    if (field(channelConfig, 'enabled') === false || merged.enabled === false) return false;
    const normalizeApprover = (value: string | number) => {
      const normalized = String(value).trim().replace(/^(feishu|lark):/i, '').trim()
        .replace(/^(chat|group|channel|user|dm|open_id):/i, '').trim().toLowerCase();
      return normalized.startsWith('ou_') ? normalized : undefined;
    };
    const auth = sdk.createChannelApprovalAuth({ channelLabel: 'Feishu', normalizeApprover,
      resolveInputs: () => ({ allowFrom: merged.allowFrom as readonly (string | number)[] | undefined }) });
    return auth.approvalAuth.authorizeActorAction({ cfg: cfg as OpenClawConfig, accountId: b.accountId,
      senderId: b.senderId, action: 'approve', approvalKind: 'plugin' }).authorized;
  } catch { return false; }
}
/** Narrow exception to the generic hook channelId/turnSourceTo equality gate.
 * The normal SDK's latest session and canonical conversation both attest the
 * same direct owner. Failure keeps the original refusal; no routing is changed.
 */
export async function verifiedFeishuApprovalTarget(ctx: DirectToolContext): Promise<string | null> {
  const b = bindOwnerTurn(ctx);
  if (!b || b.channel !== 'feishu') return null;
  try {
    const [config, sessions, accounts, approvals] = await Promise.all([
      import('openclaw/plugin-sdk/runtime-config-snapshot'), import('openclaw/plugin-sdk/session-store-runtime'),
      import('openclaw/plugin-sdk/account-resolution'), import('openclaw/plugin-sdk/approval-auth-runtime'),
    ]);
    const cfg = config.getRuntimeConfigSnapshot();
    const owners = ownerConfig(cfg, b.channel);
    if (!owners || directIdentity(b.channel, JSON.parse(owners)[0]) !== b.senderId) return null;
    if (!feishuOwnerCanApprove(b, cfg, { ...accounts, ...approvals })) return null;
    if (!directSessionMatches(b, sessions.getSessionEntry({ agentId: b.agentId, sessionKey: b.sessionKey, readConsistency: 'latest' }))) return null;
    const bound = sessions.getConversationSession({ agentId: b.agentId, channel: b.channel,
      accountId: b.accountId, kind: 'direct', peerId: b.senderId });
    return bound?.sessionKey === b.sessionKey && bound.sessionId === b.sessionId ? b.to : null;
  } catch { return null; }
}
