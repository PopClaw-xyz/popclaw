/** Complete House guide reads, with shared runtime cache or standalone conditional GET. */
import { readBoundedGuide, type HouseGuideResult } from './house-guide-context.js';
import { entryDigest } from '../runtime/house-lifecycle/participation-journal.js';
import type { ReadRequestScope } from '../runtime/read-request-scope.js';
import { currentActionSignal } from '../runtime/house-lifecycle/action-context.js';
import { remoteReadFailure } from './house-read-diagnostic.js';
import { LORE_HOUSE_TIMEOUT_MS } from './http-timeout.js';
import { type HouseReadFailure, type HouseReadDiagnostic } from '../runtime/house-lifecycle/read-failure.js';

export type GuideTextResult = { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly failure: HouseReadFailure };

export interface GuideClientOptions {
  readonly baseUrl: string;
  /** Runtime callers retain their host read gate and share the bound House cache. */
  readonly readGuide?: () => Promise<HouseGuideResult>;
  /** Standalone cache reuse requires a known current subject generation. */
  readonly readGeneration?: () => ReadRequestScope | undefined;
  readonly fetch?: typeof globalThis.fetch;
}

export class GuideClient {
  private cached?: {text: string; digest: string; generation: ReadRequestScope};
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly opts: GuideClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async fetchGuideText(): Promise<string | null> {
    const result = await this.fetchGuideResult();
    return result.ok ? result.text : null;
  }

  /** A representation is not a permission receipt. Standalone reads always
   * traverse their fetch gate, including conditional requests and 304 reuse. */
  async fetchGuideResult(): Promise<GuideTextResult> {
    const origin = this.opts.baseUrl;
    const startedAt = performance.now(), actionSignal = currentActionSignal();
    let phase: HouseReadDiagnostic['phase'] = this.opts.readGuide ? 'delegate' : 'before-fetch';
    let deadline: AbortSignal | undefined;
    const stale = (): GuideTextResult => {
      this.cached = undefined;
      return {ok:false,failure:{code:'HOUSE_ACTION_STALE',origin}};
    };
    try {
      if (this.opts.readGuide) {
        const result = await this.opts.readGuide();
        return result.status === 'available' ? {ok:true,text:result.guide}
          : {ok:false,failure:result.failure ?? {code:'HOUSE_REMOTE_UNKNOWN',origin}};
      }
      const generation = this.opts.readGeneration?.();
      const current = () => !generation || generation.isCurrent();
      if (!current()) return stale();
      if (!generation || this.cached?.generation.token !== generation.token || !this.cached.generation.isCurrent()) this.cached = undefined;
      const cached = this.cached;
      const url = `${origin.replace(/\/$/, '')}/v1/guide.md`;
      const request = (conditional: boolean) => {
        phase = 'fetch'; deadline = AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS);
        return this.fetchFn(url, {redirect:'error',signal:deadline,
          headers:conditional && cached ? {'If-None-Match':`"${cached.digest}"`} : {}});
      };
      let response = await request(!!cached);
      if (!current()) { await response.body?.cancel(); return stale(); }
      if (response.status === 304 && cached) return {ok:true,text:cached.text};
      if (response.status === 304) response = await request(false);
      if (!current()) { await response.body?.cancel(); return stale(); }
      if (!response.ok) {
        await response.body?.cancel();
        return {ok:false,failure:{code:'HOUSE_REMOTE_HTTP',origin,status:response.status}};
      }
      phase = 'body';
      const text = await readBoundedGuide(response);
      if (!current()) return stale();
      if (generation) this.cached = {text,digest:entryDigest(text),generation};
      return {ok:true,text};
    } catch (error) {
      return {ok:false,failure:remoteReadFailure(error,origin,{phase,deadline,timeoutMs:LORE_HOUSE_TIMEOUT_MS,startedAt,actionSignal})};
    }
  }
}
