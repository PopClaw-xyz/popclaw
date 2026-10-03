/**
 * Plan 11.2 — popclaw owns its LLM connectivity.
 *
 * Plan 11.1 routed /popclaw-recommend through OpenClaw's plugin agent
 * runtime (`prepareSimpleCompletionModelForAgent`). Live verification
 * showed that runtime's provider registry does not recognize `ollama`,
 * so the user's `ollama/glm-5.1:cloud` setup throws on every call. We
 * can't change OpenClaw core, so popclaw gets its own thin client that
 * POSTs directly to the provider's HTTP API.
 *
 * See `docs/popclaw-direct-llm.md` for the full design.
 *
 * Surface kept narrow on purpose: a single `complete(prompt)` method.
 * The factory in `llm-factory.ts` adapts it to the `LLMCompleteFn`
 * shape consumed by `score-against-taste.ts`.
 */

export interface LLMClient {
  complete(prompt: string): Promise<string>;
}

/** The optional host runtime is an external boundary, not a trusted text-block type. */
export function runtimeCompletionText(reply: unknown): string {
  if (typeof reply !== 'object' || reply === null || !('content' in reply) || !Array.isArray(reply.content)) return '';
  return reply.content.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text') return [];
    return 'text' in block && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n');
}

export interface OllamaCloudClientOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Override the endpoint, mostly for tests. */
  readonly endpoint?: string;
}

/**
 * Direct client for ollama.com cloud, OpenAI-compatible /v1/chat/completions endpoint.
 */
export class OllamaCloudClient implements LLMClient {
  private readonly endpoint: string;

  constructor(private readonly opts: OllamaCloudClientOptions) {
    this.endpoint = opts.endpoint ?? 'https://ollama.com/v1/chat/completions';
  }

  async complete(prompt: string): Promise<string> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = JSON.stringify(await res.json()).slice(0, 500);
      } catch {
        // ignore
      }
      throw new Error(`OllamaCloud HTTP ${res.status}: ${detail}`);
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return j.choices?.[0]?.message?.content ?? '';
  }
}
