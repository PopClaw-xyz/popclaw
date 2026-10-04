/** Owner-confirmed preparation of the host's GLOBAL plugin notification route.
 * No send decision is issued here. Only a host-recognized owner tool turn can
 * stage a proposal; a native command from that same identity/session accepts it.
 * Command contexts need not expose senderIsOwner: their authenticated identity
 * is compared to the previously host-verified owner, with unchanged owner config.
 */
import type { OpenClawPluginApi, PluginCommandContext } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { getConversationSession } from 'openclaw/plugin-sdk/session-store-runtime';
import { resolveMergedAccountConfig } from 'openclaw/plugin-sdk/account-resolution';
import { createChannelApprovalAuth } from 'openclaw/plugin-sdk/approval-auth-runtime';
import { draftDigest, peekDraftSnapshot } from '../tools/draft-store.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { resolveOwnerApprovalRoute } from './owner-approval-route.js';
import type { OwnerApprovalToolContext, OwnerApprovalToolEvent } from './owner-approval.js';
import { bindOwnerTurn, directIdentity, directSessionMatches, feishuOwnerCanApprove, field, str, ownerConfig as owners,
  type OwnerDirectBinding as Binding } from './owner-direct-binding.js';

type SetupToolContext = OwnerApprovalToolContext & { sessionId?: string; turnSourceThreadId?: string | number };
type SetupCommandContext = Pick<PluginCommandContext, 'agentId' | 'sessionKey' | 'sessionId' | 'channel' | 'accountId'
  | 'senderId' | 'to' | 'isAuthorizedSender' | 'messageThreadId'>;
export interface ApprovalSetupPorts {
  current(): unknown;
  readSnapshot(): Promise<{ config: unknown; hash: string }>;
  session(agentId: string, sessionKey: string): unknown;
  conversation?(binding: Binding): boolean;
  canApprove(binding: Binding, config: unknown): boolean;
  draft(id: string): string | null;
  mutate(baseHash: string, mutate: (draft: OpenClawConfig) => void): Promise<void>;
  route(binding: Binding, config?: unknown): Promise<{ pinned: boolean }>;
  now?(): number;
  nonce?(): string;
}
interface Pending {
  binding: Binding; hash: string; owners: string; draftId: string; draft: string;
  expiresAt: number; written: boolean; busy: boolean;
}
const plugin = (cfg: unknown) => field(field(cfg, 'approvals'), 'plugin');
function candidate(b: Binding): NonNullable<NonNullable<OpenClawConfig['approvals']>['plugin']> {
  return { enabled: true, mode: 'targets', agentFilter: [b.agentId],
    sessionFilter: [`^${b.sessionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`],
    targets: [{ channel: b.channel, accountId: b.accountId, to: b.to }] };
}

export function createOpenClawApprovalSetup(ports: ApprovalSetupPorts) {
  const pending = new Map<string, Pending>();
  const now = () => ports.now?.() ?? Date.now();
  const copy = (key: string, values: Record<string, string> = {}) => renderCopy(ownerLang(), `approvalSetup.${key}`, values);
  const reply = (key: string, values: Record<string, string> = {}) => ({ text: copy(key, values) });
  function prune(): void { for (const [token, p] of pending) if (now() >= p.expiresAt) pending.delete(token); }
  function direct(b: Binding): boolean {
    try {
    return directSessionMatches(b, ports.session(b.agentId, b.sessionKey))
      && (ports.conversation?.(b) ?? true);
    } catch { return false; }
  }
  function valid(p: Pending): boolean {
    return now() < p.expiresAt && ports.draft(p.draftId) === p.draft && direct(p.binding)
      && owners(ports.current(), p.binding.channel) === p.owners && ports.canApprove(p.binding, ports.current());
  }
  function sameCommand(b: Binding, ctx: SetupCommandContext): boolean {
    return ctx.isAuthorizedSender === true && ctx.agentId === b.agentId && ctx.sessionKey === b.sessionKey
      && ctx.sessionId === b.sessionId && ctx.channel === b.channel && ctx.accountId === b.accountId
      && ctx.senderId === b.senderId && directIdentity(b.channel, ctx.to) === b.senderId && ctx.messageThreadId === undefined;
  }
  return {
    async before(event: OwnerApprovalToolEvent, ctx: SetupToolContext): Promise<{ block: true; blockReason: string } | null> {
      if (event.toolName !== 'popclaw_send_draft') return null;
      let cfg: unknown;
      try { cfg = ports.current(); } catch { return { block: true, blockReason: copy('failed') }; }
      if (!cfg) return { block: true, blockReason: copy('failed') };
      if (plugin(cfg) !== undefined) return null;
      if (ctx.requester?.channel === 'webchat' || ctx.requester?.channel === 'tui') return null;
      const id = str(field(event.params, 'draft_id'));
      const draft = id ? ports.draft(id) : null;
      if (!id || draft === null) return null;
      if (ctx.requester?.senderIsOwner === true && !['telegram', 'feishu'].includes(ctx.requester.channel ?? '')) {
        return { block: true, blockReason: copy('unsupported', { draft: id }) };
      }
      const refuse = () => ({ block: true as const, blockReason: copy('untrusted') });
      const binding = bindOwnerTurn(ctx);
      if (!binding) return refuse();
      const ownerConfig = owners(cfg, binding.channel);
      if (!ownerConfig || directIdentity(binding.channel, JSON.parse(ownerConfig)[0]) !== binding.senderId
        || !direct(binding)) return refuse();
      if (!ports.canApprove(binding, cfg)) return { block: true, blockReason: copy('cannotApprove') };
      try {
        const snapshot = await ports.readSnapshot();
        if (plugin(snapshot.config) !== undefined || owners(snapshot.config, binding.channel) !== ownerConfig
          || !ports.canApprove(binding, snapshot.config)) return refuse();
        const planned = structuredClone(snapshot.config) as OpenClawConfig;
        planned.approvals = { ...planned.approvals, plugin: candidate(binding) };
        if (!(await ports.route(binding, planned)).pinned || !direct(binding) || ports.draft(id) !== draft) return refuse();
        prune();
        for (const [token, p] of pending) {
          if (!p.busy && !p.written && p.hash === snapshot.hash && p.draftId === id
            && JSON.stringify(p.binding) === JSON.stringify(binding) && valid(p)) {
            return { block: true, blockReason: copy('required', { command: `/popclaw approvals confirm ${token}` }) };
          }
        }
        while (pending.size >= 64) pending.delete(pending.keys().next().value!);
        const token = ports.nonce?.() ?? [...crypto.getRandomValues(new Uint8Array(16))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        pending.set(token, { binding, hash: snapshot.hash, owners: ownerConfig, draftId: id, draft,
          expiresAt: now() + 300_000, written: false, busy: false });
        return { block: true, blockReason: copy('required', { command: `/popclaw approvals confirm ${token}` }) };
      } catch { return { block: true, blockReason: copy('failed') }; }
    },
    async command(args: readonly string[], ctx: SetupCommandContext): Promise<{ text: string; continueAgent?: boolean }> {
      if (args.length === 0) {
        try { return reply(plugin(ports.current()) === undefined ? 'statusMissing' : 'statusConfigured'); }
        catch { return reply('failed'); }
      }
      prune();
      const [action, token] = args;
      const p = token ? pending.get(token) : undefined;
      if (!p || args.length !== 2 || !['confirm', 'resume'].includes(action!) || p.busy
        || !sameCommand(p.binding, ctx)) return reply('invalid');
      p.busy = true;
      try {
        if (!valid(p)) { pending.delete(token!); return reply('invalid'); }
        if (!p.written) {
          if (action !== 'confirm') return reply('invalid');
          await ports.mutate(p.hash, cfg => {
            if (!valid(p) || plugin(cfg) !== undefined || owners(cfg, p.binding.channel) !== p.owners
              || !ports.canApprove(p.binding, cfg)) throw new Error('APPROVAL_SETUP_DRIFT');
            cfg.approvals = { ...cfg.approvals, plugin: candidate(p.binding) };
          });
          p.written = true;
        }
        if (!valid(p)) { pending.delete(token!); return reply('invalid'); }
        if (!(await ports.route(p.binding)).pinned) return reply('loading', { command: `/popclaw approvals resume ${token}` });
        if (!valid(p)) { pending.delete(token!); return reply('invalid'); }
        // Telegram native commands only reply; continueAgent is ignored.
        // Keep the original draft and ask for an ordinary owner message carrying
        // its ID. Do not schedule a turn or inject an old action into new intent.
        pending.delete(token!);
        return reply('ready', { draft: p.draftId });
      } catch { pending.delete(token!); return reply('failed'); }
      finally { p.busy = false; }
    },
  };
}

/** Native API composition only. No files/DBs are opened at registration. */
export function openClawApprovalSetup(api: Pick<OpenClawPluginApi, 'runtime'>) {
  return createOpenClawApprovalSetup({
    current: () => api.runtime.config.current(),
    canApprove: (binding, config) => feishuOwnerCanApprove(binding, config, { resolveMergedAccountConfig, createChannelApprovalAuth }),
    readSnapshot: async () => {
      const { readConfigFileSnapshotForWrite } = await import('openclaw/plugin-sdk/config-mutation');
      const { snapshot } = await readConfigFileSnapshotForWrite();
      if (!snapshot.valid || !snapshot.hash) throw new Error('APPROVAL_SETUP_CONFIG_UNAVAILABLE');
      return { config: snapshot.config, hash: snapshot.hash };
    },
    session: (agentId, sessionKey) => api.runtime.agent.session.getSessionEntry({ agentId, sessionKey, readConsistency: 'latest' }),
    conversation: b => {
      const bound = getConversationSession({ agentId: b.agentId, channel: b.channel,
        accountId: b.accountId, kind: 'direct', peerId: b.senderId });
      return bound?.sessionKey === b.sessionKey && bound.sessionId === b.sessionId;
    },
    draft: id => { const snapshot = peekDraftSnapshot(id); return snapshot ? draftDigest(JSON.stringify(snapshot)) : null; },
    mutate: async (baseHash, mutate) => { await api.runtime.config.mutateConfigFile({ base: 'runtime', baseHash,
      afterWrite: { mode: 'auto' }, mutate }); },
    route: (b, config) => resolveOwnerApprovalRoute({ channel: b.channel, accountId: b.accountId,
      to: b.to, turnSourceTo: b.to, agentId: b.agentId, sessionKey: b.sessionKey },
    config === undefined ? {} : { readActiveConfig: () => config }),
  });
}
