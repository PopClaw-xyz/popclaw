import { describe, expect, it, vi } from 'vitest';
import { consumePublicSse, consumeScopedSse, scopedBase64 } from '../../../src/world/scoped-sse.js';
import { ScopedWorldStreamClient, type ScopedWorldStreamOptions } from '../../../src/ingress/scoped-world-stream-client.js';
const response = (text: string) => new Response(new TextEncoder().encode(text));
describe('strict public SSE framing', () => {
  it('preserves bytes across CRLF and arbitrary network chunks', async () => {
    const bytes = new TextEncoder().encode(': heartbeat\r\nevent: public_frame\r\ndata: YW\r\ndata: Jj\r\n\r\n');
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
    const seen: unknown[] = [];
    await consumePublicSse(new Response(stream), new AbortController().signal, event => { seen.push({ ...event, raw: [...scopedBase64(event.data)] }); });
    expect(seen).toEqual([{ type: 'public_frame', data: 'YW\nJj', raw: [97, 98, 99] }]);
  });
  it.each([
    'id: 1\nevent: public_frame\ndata: YQ==\n\n',
    'event: public_frame\nevent: public_gap\ndata: YQ==\n\n',
    'data: YQ==\n\n', 'event: message\ndata: YQ==\n\n',
    'retry: 1\nevent: public_frame\ndata: YQ==\n\n',
    'event: public_boundary\n\n', 'event: public_frame\ndata: YQ==',
    'event: public_frame\ndata: YQ==\n',
    'event: public_frame\ndata: YQ==\nunknown: ignored\n\n',
  ])('rejects ambiguous or incomplete framing %j', async text => {
    const consume = vi.fn();
    await expect(consumePublicSse(response(text), new AbortController().signal, consume)).rejects.toThrow();
    expect(consume).not.toHaveBeenCalled();
  });
  it('rejects invalid UTF-8 and oversized blocks', async () => {
    await expect(consumePublicSse(new Response(Uint8Array.of(255)), new AbortController().signal, vi.fn())).rejects.toThrow();
    await expect(consumePublicSse(response('event: public_frame\ndata: ' + 'x'.repeat(1048577)), new AbortController().signal, vi.fn())).rejects.toThrow('PUBLIC_SSE_SIZE_LIMIT');
  });
  it('closes before a later frame when a durable callback fails', async () => {
    const consume = vi.fn(() => { throw new Error('transaction_failed'); });
    await expect(consumePublicSse(response('event: public_frame\ndata: YQ==\n\nevent: public_checkpoint\ndata: Yg==\n\n'), new AbortController().signal, consume)).rejects.toThrow('transaction_failed');
    expect(consume).toHaveBeenCalledOnce();
  });
  it('aborts a pending read and joins underlying cancellation', async () => {
    const gate = new AbortController(); let release!: () => void;
    const cancelled = new Promise<void>(resolve => { release = resolve; });
    const cancel = vi.fn(() => cancelled);
    const consume = consumePublicSse(new Response(new ReadableStream({ cancel })), gate.signal, vi.fn());
    let done = false; const settled = consume.catch(() => {}).then(() => { done = true; });
    gate.abort(); await Promise.resolve(); expect(done).toBe(false); release(); await settled;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('retains legacy parser behavior for explicit old consumers', async () => {
    const consume = vi.fn(async () => {});
    await consumeScopedSse(response('data: YQ==\n\n'), new AbortController().signal, consume);
    expect(consume).toHaveBeenCalledWith({ type: 'message', data: 'YQ==' });
  });
});
it('disables old scoped construction before storage writes or a second socket', () => {
  const db = { execute: vi.fn(), queryOne: vi.fn(), queryAll: vi.fn(), transaction: vi.fn() }; const fetch = vi.fn();
  expect(() => new ScopedWorldStreamClient({ db, fetch } as unknown as ScopedWorldStreamOptions)).toThrow('WORLD_SCOPED_TRANSPORT_UNSUPPORTED');
  for (const method of Object.values(db)) expect(method).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
