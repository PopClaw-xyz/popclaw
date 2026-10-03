import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaCloudClient, runtimeCompletionText } from '../../../src/recommend/llm-client';

describe('runtimeCompletionText', () => {
  it.each([null, 42, [], {}, { content: {} }, { content: 'text' }])('handles malformed runtime reply %j', (reply) => {
    expect(runtimeCompletionText(reply)).toBe('');
  });
  it('keeps ordered text blocks only, without coercing malformed data', () => {
    expect(runtimeCompletionText({ content: [
      null, 4, { type: 'image', text: 'not text' }, { type: 'text', text: 42 },
      { type: 'text' }, { type: 'text', text: 'first' }, { type: 'text', text: 'second' },
    ] })).toBe('first\nsecond');
  });
});

describe('OllamaCloudClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs to ollama.com/v1/chat/completions with bearer auth and OpenAI-compatible body', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '[[0.5]]' } }] }),
    });
    const client = new OllamaCloudClient({ apiKey: 'sk-ollama-test', model: 'glm-5.1:cloud' });
    const out = await client.complete('hello');
    expect(out).toBe('[[0.5]]');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://ollama.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer sk-ollama-test');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('glm-5.1:cloud');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('throws with status code on non-2xx response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'invalid api key' } }),
    });
    const client = new OllamaCloudClient({ apiKey: 'bad', model: 'glm-5.1:cloud' });
    await expect(client.complete('hello')).rejects.toThrow(/401/);
  });

  it('returns empty string if response is missing choices', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    });
    const client = new OllamaCloudClient({ apiKey: 'k', model: 'm' });
    const out = await client.complete('hello');
    expect(out).toBe('');
  });

  it('passes through fetch errors as Error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
    const client = new OllamaCloudClient({ apiKey: 'k', model: 'm' });
    await expect(client.complete('hello')).rejects.toThrow(/network down/);
  });
});
