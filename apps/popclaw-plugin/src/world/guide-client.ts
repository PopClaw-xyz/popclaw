/**
 * GuideClient — S4-T4
 *
 * GET /v1/guide.md (the lore-house's full self-description: frontmatter + body text).
 * Error-handling style follows WorldSummaryClient: network failure / non-2xx →
 * null, never throw — the onboarding lantern act is an experience path, so if
 * the world can't be reached it should degrade gracefully rather than error
 * out (must not block the spine).
 */
import { LORE_HOUSE_TIMEOUT_MS } from './http-timeout.js';

export interface GuideClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class GuideClient {
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly opts: GuideClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  /** Full text of guide.md; any error (network / non-2xx) → null. */
  async fetchGuideText(): Promise<string | null> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1/guide.md`;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS) });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
}
