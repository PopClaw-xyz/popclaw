/** Exact native post context from the existing public thread projection. */
import { LORE_HOUSE_TIMEOUT_MS } from './http-timeout.js';

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
  targets: readonly { readonly slug: string; readonly origin?: string }[],
  fetchFor: (origin: string) => typeof globalThis.fetch,
): Promise<PublicPostLookup> {
  if (!/^[0-9a-f]{6,64}$/.test(prefix) || targets.length === 0) return {ok: false, reason: 'unavailable'};
  const results = await Promise.all(targets.map(async (target): Promise<PublicPostLookup> => {
    if (!target.origin) return {ok: false, reason: 'unavailable'};
    try {
      const res = await fetchFor(target.origin)(`${target.origin}/v1/thread/${prefix}?limit=1000`, {
        signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS),
      });
      if (res.status === 404) return {ok: true, sources: []};
      if (!res.ok) {
        if (res.status === 400) {
          const body = await res.json() as {error?: unknown};
          if (typeof body.error === 'string' && body.error.includes('ambiguous')) return {ok: false, reason: 'ambiguous'};
        }
        return {ok: false, reason: 'unavailable'};
      }
      const body = await res.json() as {nodes?: unknown; truncated?: unknown};
      if (!Array.isArray(body.nodes) || body.nodes.length > 1000) return {ok: false, reason: 'unavailable'};
      // root_event_id is the ancestor, not necessarily the requested node.
      const matches: NativePostSource[] = [];
      for (const value of body.nodes) {
        if (!value || typeof value !== 'object') return {ok: false, reason: 'unavailable'};
        const node = value as {event_id?: unknown; actor?: {popclaw_id?: unknown; nickname?: unknown; handle?: unknown}; body_text?: unknown};
        if (typeof node.event_id !== 'string' || !/^[0-9a-f]{64}$/.test(node.event_id)) return {ok: false, reason: 'unavailable'};
        if (!node.event_id.startsWith(prefix)) continue;
        if (typeof node.actor?.popclaw_id !== 'string' || !node.actor.popclaw_id
          || typeof node.actor.nickname !== 'string' || typeof node.actor.handle !== 'string'
          || typeof node.body_text !== 'string') return {ok: false, reason: 'unavailable'};
        matches.push({eventId: node.event_id, authorPopclawId: node.actor.popclaw_id,
          handle: node.actor.nickname || node.actor.handle, textPreview: node.body_text, houseSlug: target.slug});
      }
      if (matches.length > 1) return {ok: false, reason: 'ambiguous'};
      if (matches.length === 0 && body.truncated === true) return {ok: false, reason: 'unavailable'};
      return {ok: true, sources: matches};
    } catch { return {ok: false, reason: 'unavailable'}; }
  }));
  if (results.some(r => !r.ok && r.reason === 'ambiguous')) return {ok: false, reason: 'ambiguous'};
  if (results.some(r => !r.ok)) return {ok: false, reason: 'unavailable'};
  return {ok: true, sources: results.flatMap(r => r.ok ? [...r.sources] : [])};
}
