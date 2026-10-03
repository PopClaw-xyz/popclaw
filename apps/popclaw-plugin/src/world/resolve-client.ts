/**
 * ResolveClient — typed client for lore-house `GET /v1/resolve` (identity resolution, ADR-0028).
 *
 * Same shape/contract as WorldSummaryClient: inject fetch + baseUrl; any
 * network failure / non-2xx → `null` (never throws). An empty-but-OK response
 * is `[]` (person not found), distinct from `null` (lore-house unreachable).
 */
import type { ResolveCandidate } from '../identity/follow-resolution.js';
import { LORE_HOUSE_TIMEOUT_MS } from './http-timeout.js';

interface WireProfile {
  platform: string;
  handle: string;
  follower_count: number;
}
interface WireCandidate {
  popclaw_id: string;
  nickname: string;
  sigil: string;
  profiles?: WireProfile[];
}
interface WireResponse {
  candidates?: WireCandidate[];
}

export interface ResolveClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class ResolveClient {
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly opts: ResolveClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async resolve(q: { sigil?: string; name?: string }): Promise<ResolveCandidate[] | null> {
    const qs = new URLSearchParams();
    if (q.sigil) qs.set('sigil', q.sigil);
    if (q.name) qs.set('name', q.name);
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1/resolve?${qs.toString()}`;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS) });
      if (!res.ok) return null;
      const json = (await res.json()) as WireResponse;
      return (json.candidates ?? []).map((c) => ({
        popclawId: c.popclaw_id,
        nickname: c.nickname,
        sigil: c.sigil,
        profiles: (c.profiles ?? []).map((p) => ({
          platform: p.platform,
          handle: p.handle,
          followerCount: p.follower_count,
        })),
      }));
    } catch {
      return null;
    }
  }
}
