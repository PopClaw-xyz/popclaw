import { describe, expect, it } from 'vitest';
import { consumeScopedSse, scopedBase64 } from '../../../src/world/scoped-sse.js';

function response(chunks: (string | Uint8Array)[]) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    controller.close();
  }}));
}
const signal = () => new AbortController().signal;
describe('scoped SSE framing', () => {
  it('parses split CRLF, lone CR, multiline data and UTF-8 in sequential order', async () => {
    const values: unknown[] = []; let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const done = consumeScopedSse(response([': comment\revent: world_boundary\r', '\ndata: YQ==\r\n\r', '\ndata: Yg==\ndata: Yw==\n\nevent: discarded\ndata: partial']), signal(), async event => {
      values.push(event); if (values.length === 1) await hold;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(values).toEqual([{ type: 'world_boundary', data: 'YQ==' }]);
    release(); await done;
    expect(values).toEqual([{ type: 'world_boundary', data: 'YQ==' }, { type: 'message', data: 'Yg==\nYw==' }]);
    const utf8 = new TextEncoder().encode('data: 文\n\n');
    const unicode: string[] = [];
    await consumeScopedSse(response([...utf8].map(byte => Uint8Array.of(byte))), signal(), async event => { unicode.push(event.data); });
    expect(unicode).toEqual(['文']);
  });
  it.each(['id: 1\n', 'id\n'])('rejects Last-Event-ID state: %s', async id => {
    await expect(consumeScopedSse(response([id, 'data: YQ==\n\n']), signal(), async () => {})).rejects.toThrow('SCOPED_SSE_ID_REJECTED');
  });
  it('rejects malformed UTF-8, oversized lines and oversized multiline events', async () => {
    await expect(consumeScopedSse(response([Uint8Array.of(0xc3)]), signal(), async () => {})).rejects.toThrow();
    await expect(consumeScopedSse(response(['x'.repeat(1048577)]), signal(), async () => {})).rejects.toThrow('SCOPED_SSE_SIZE_LIMIT');
    await expect(consumeScopedSse(response(['data: ' + 'x'.repeat(600000) + '\ndata: ' + 'x'.repeat(600000) + '\n']), signal(), async () => {})).rejects.toThrow('SCOPED_SSE_SIZE_LIMIT');
  });
  it('cancels a blocked reader on abort', async () => {
    const controller = new AbortController(); let cancelled = false;
    const done = consumeScopedSse(new Response(new ReadableStream({ cancel() { cancelled = true; } })), controller.signal, async () => {});
    controller.abort(); await expect(done).rejects.toThrow('SCOPED_STREAM_ABORTED'); expect(cancelled).toBe(true);
  });
  it('accepts only canonical base64 with optional SSE line breaks', () => {
    expect([...scopedBase64('Y\nQ==')]).toEqual([97]);
    for (const bad of ['', 'YQ', 'Y Q==', 'YQ===', 'YR==', 'YWJ=']) expect(() => scopedBase64(bad)).toThrow('SCOPED_BASE64_INVALID');
  });
});
