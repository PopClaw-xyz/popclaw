/** Exact native post context from the existing public thread projection. */
import { LORE_HOUSE_TIMEOUT_MS } from './http-timeout.js';
import {ActionInactiveError} from '../runtime/house-lifecycle/action-context.js';

/** Failure metadata only: no request credentials, parent body or exception text. */
export interface NativePostLookupFailure {
  readonly origin?: string;
  readonly houseSlug: string;
  readonly stage: 'target' | 'request' | 'gate' | 'http' | 'decode' | 'schema' | 'ambiguous' | 'truncated';
  readonly httpStatus?: number;
  readonly gateCode?: ActionInactiveError['code'];
}

export interface NativePostSource {
  readonly eventId: string;
  readonly authorPopclawId: string;
  readonly handle: string;
  readonly textPreview: string;
  readonly houseSlug?: string;
  readonly originalUrl?: string;
}
export type PublicPostLookup =
  | { readonly ok: true; readonly sources: readonly NativePostSource[] }
  | { readonly ok: false; readonly reason: 'unavailable' | 'ambiguous' };

/** The caller supplies captured trusted houses and their existing public read lane. */
export async function lookupThreadPost(
  prefix: string,
  targets: readonly { readonly slug: string; readonly origin?: string; readonly assertCurrent?: () => void }[],
  fetchFor: (origin: string) => typeof globalThis.fetch,
  onFailure?: (failure: NativePostLookupFailure) => void,
): Promise<PublicPostLookup> {
  if (!/^[0-9a-f]{6,64}$/.test(prefix) || targets.length === 0) return {ok: false, reason: 'unavailable'};
  const results = await Promise.all(targets.map(async (target): Promise<PublicPostLookup> => {
    const failed = (stage: NativePostLookupFailure['stage'], httpStatus?: number, gateCode?: ActionInactiveError['code']): PublicPostLookup => {
      try { onFailure?.({origin: target.origin, houseSlug: target.slug, stage,
        ...(httpStatus === undefined ? {} : {httpStatus}), ...(gateCode === undefined ? {} : {gateCode})}); } catch { /* Diagnostics cannot change resolution. */ }
      return {ok: false, reason: stage === 'ambiguous' ? 'ambiguous' : 'unavailable'};
    };
    if (!target.origin) return failed('target');
    let stage: NativePostLookupFailure['stage'] = 'request';
    try {
      target.assertCurrent?.();
      const res = await fetchFor(target.origin)(`${target.origin}/v1/thread/${prefix}?limit=1000`, {
        signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS),
      });
      target.assertCurrent?.();
      if (res.status === 404) return {ok: true, sources: []};
      if (!res.ok) {
        if (res.status === 400) {
          stage = 'decode';
          const body = await res.json() as {error?: unknown};
          if (typeof body.error === 'string' && body.error.includes('ambiguous')) return failed('ambiguous', res.status);
        }
        return failed('http', res.status);
      }
      stage = 'decode';
      const body = await res.json() as {nodes?: unknown; truncated?: unknown};
      target.assertCurrent?.();
      stage = 'schema';
      if (!Array.isArray(body.nodes) || body.nodes.length > 1000) return failed('schema');
      // root_event_id is the ancestor, not necessarily the requested node.
      const matches: NativePostSource[] = [];
      for (const value of body.nodes) {
        if (!value || typeof value !== 'object') return failed('schema');
        const node = value as {event_id?: unknown; actor?: {popclaw_id?: unknown; nickname?: unknown; handle?: unknown}; body_text?: unknown};
        if (typeof node.event_id !== 'string' || !/^[0-9a-f]{64}$/.test(node.event_id)) return failed('schema');
        if (!node.event_id.startsWith(prefix)) continue;
        if (typeof node.actor?.popclaw_id !== 'string' || !node.actor.popclaw_id
          || typeof node.actor.nickname !== 'string' || typeof node.actor.handle !== 'string'
          || typeof node.body_text !== 'string') return failed('schema');
        matches.push({eventId: node.event_id, authorPopclawId: node.actor.popclaw_id,
          handle: node.actor.nickname || node.actor.handle, textPreview: node.body_text, houseSlug: target.slug});
      }
      if (matches.length > 1) return failed('ambiguous');
      if (matches.length === 0 && body.truncated === true) return failed('truncated');
      return {ok: true, sources: matches};
    } catch (error) { return error instanceof ActionInactiveError ? failed('gate', undefined, error.code) : failed(stage); }
  }));
  for (const target of targets) {
    try { target.assertCurrent?.(); }
    catch (error) {
      try { onFailure?.({origin: target.origin, houseSlug: target.slug, stage: 'gate',
        ...(error instanceof ActionInactiveError ? {gateCode: error.code} : {})}); } catch { /* Diagnostics only. */ }
      return {ok: false, reason: 'unavailable'};
    }
  }
  if (results.some(r => !r.ok && r.reason === 'ambiguous')) return {ok: false, reason: 'ambiguous'};
  if (results.some(r => !r.ok)) return {ok: false, reason: 'unavailable'};
  return {ok: true, sources: results.flatMap(r => r.ok ? [...r.sources] : [])};
}
