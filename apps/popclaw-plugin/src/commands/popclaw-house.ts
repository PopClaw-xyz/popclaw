import { boundWorldAgentContext, type WorldAgentContextResult } from '../world/world-agent-context.js';
/**
 * ADR-0051 S3 — `/popclaw login <host>` / `/popclaw logout <host>` (and the
 * status readout). The shared business implementation is the coordinator +
 * manager; this file only parses arguments and formats results — CLI, slash
 * and MCP all call the same `runHouseLoginCommand` / `runHouseLogoutCommand`
 * (work order §3: natural language only picks the tool; nobody duplicates the
 * HTTP logic).
 */

import type { HouseCommandPort } from '../runtime/house-lifecycle/command-bus.js';
import { normalizeHouseOrigin } from '../runtime/house-lifecycle/control-client.js';
import { renderCopy, type Lang } from '../lexicon/index.js';

export interface HouseCommandContext {
  readonly coordinator: () => HouseCommandPort;
  /** The host's language lane (roots pass theirs; defaults to zh-CN). */
  readonly lang?: () => Lang;
  readonly readAgentContext?: (origin: string, sessionId: string) => WorldAgentContextResult | Promise<WorldAgentContextResult>;
}

/** Shared login implementation. `input` is a bare host or origin. */
export async function runHouseLoginCommand(ctx: HouseCommandContext, input: string): Promise<string> {
  const origin = normalizeHouseOrigin(input);
  const result = await ctx.coordinator().loginHouse(origin);
  const lang = ctx.lang?.() ?? 'zh-CN';
  switch (result.status) {
    case 'connected': {
      const message = renderCopy(lang, 'house.login.connected', { origin, scope: result.scope, session: result.sessionId.slice(0, 8) });
      if (!ctx.readAgentContext) return message;
      let agentContext: WorldAgentContextResult;
      try { agentContext = await ctx.readAgentContext(origin, result.sessionId); }
      catch { agentContext = {status: 'unavailable', code: 'HOUSE_CONTEXT_UNAVAILABLE'}; }
      // Material retrieval is separate from the already committed login result.
      const render = (material: WorldAgentContextResult) => message + '\n' + JSON.stringify({login_status: 'connected', agent_context: material});
      return render(boundWorldAgentContext(agentContext, render));
    }
    case 'unsupported':
      return renderCopy(lang, 'house.login.unsupported', { origin })
        + (result.legacyAvailable === undefined ? '' : '\n' + renderCopy(lang,result.legacyAvailable ? 'house.login.legacyAvailable' : 'house.login.legacyUnavailable',{origin}))
        + (result.legacyRefusal ? '\n' + renderCopy(lang,'house.login.legacyRefusal',{origin,code:result.legacyRefusal}) : '');
    default:
      if (result.errorCode) {
        return renderCopy(lang, 'house.login.error', { origin, code: result.errorCode });
      }
      if (result.operationId) {
        return renderCopy(lang, 'house.login.queued', { origin, operation: result.operationId.slice(0, 8) });
      }
      return renderCopy(lang, 'house.login.connecting', { origin });
  }
}

/** Shared logout implementation. Local-first: the local result is final
 * regardless of the remote leave's eventual confirmation. */
export async function runHouseLogoutCommand(ctx: HouseCommandContext, input: string): Promise<string> {
  const origin = normalizeHouseOrigin(input);
  const result = await ctx.coordinator().logoutHouse(origin);
  const lang = ctx.lang?.() ?? 'zh-CN';
  const remoteKey =
    result.remoteStatus === 'confirmed'
      ? 'house.logout.remote.confirmed'
      : result.remoteStatus === 'unsupported'
        ? 'house.logout.remote.unsupported'
        : 'house.logout.remote.pending';
  return renderCopy(lang, 'house.logout.done', {
    origin,
    scope: result.scope,
    operation: result.operationId.slice(0, 8),
    remote: renderCopy(lang, remoteKey, {}),
  });
}

/** Shared status readout (one house, or every known house when input is
 * empty). Wording goes through i18n resources at the root; this returns the
 * structured summary the roots render. */
export async function runHouseStatusCommand(
  ctx: HouseCommandContext,
  input: string,
): Promise<
  Array<{
    origin: string;
    desired: string;
    phase: string;
    sessionId: string;
    remoteStatus: string;
    gateActive: boolean;
  }>
> {
  const coordinator = ctx.coordinator();
  const origin = input ? normalizeHouseOrigin(input) : '';
  const targets = origin ? [origin] : coordinator.knownHouseOrigins();
  const out = [];
  for (const target of targets) {
    const status = await coordinator.getHouseStatus(target);
    out.push({
      origin: status.origin,
      desired: status.desired,
      phase: status.phase,
      sessionId: status.sessionId,
      remoteStatus: status.remoteStatus,
      gateActive: status.gateActive,
    });
  }
  return out;
}
