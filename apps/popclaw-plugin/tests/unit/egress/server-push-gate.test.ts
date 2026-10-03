import { describe, it, expect, vi } from 'vitest';
import { ServerPushEgress } from '../../../src/egress/server-push-egress.js';
const request = vi.hoisted(() => vi.fn());
vi.mock('undici', () => ({ request }));

describe('final push lifecycle boundary', () => {
  it('checks a captured generation at the final send after asynchronous signing', async () => {
    request.mockClear();
    let generation = 1;
    const controller = new AbortController();
    const captured = generation;
    const egress = new ServerPushEgress({ baseUrl: 'https://a.invalid', gate: {
      signal: controller.signal, isActive: () => generation === captured,
    } });
    const signed = Promise.resolve(new Uint8Array([1]));
    generation = 3; // logout then login; the original task remains fenced.
    await expect(egress.push(await signed)).rejects.toThrow('HOUSE_DISABLED');
    expect(request).not.toHaveBeenCalled();
  });

  it('passes cancellation to the actual HTTP request and does not follow redirects', async () => {
    const controller = new AbortController();
    request.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('{"event_id":"ok"}'); } } });
    const egress = new ServerPushEgress({ baseUrl: 'https://a.invalid', gate: {
      signal: controller.signal, isActive: () => !controller.signal.aborted,
    } });
    expect((await egress.push(new Uint8Array([1]))).eventId).toBe('ok');
    expect(request.mock.lastCall?.[1]).toMatchObject({ signal: controller.signal, maxRedirections: 0 });
  });
});


it('rechecks authority after the final protobuf iterator await, even without signal abort', async () => {
  let active = true;
  const controller = new AbortController();
  const body = {
    async *[Symbol.asyncIterator]() { yield Buffer.from([0, 255]); active = false; },
    on: vi.fn(), destroy: vi.fn(),
  };
  request.mockResolvedValueOnce({ statusCode: 200, headers: { 'content-type': 'application/x-protobuf' }, body });
  const egress = new ServerPushEgress({ baseUrl: 'https://a.invalid', gate: { signal: controller.signal, isActive: () => active } });
  await expect(egress.push(new Uint8Array([1]))).rejects.toThrow('HOUSE_DISABLED');
  expect(body.destroy).toHaveBeenCalled();
});

function jsonResponse(raw: string | Uint8Array, statusCode = 200) {
  const body = { async *[Symbol.asyncIterator]() { yield Buffer.from(raw); }, on: vi.fn(), destroy: vi.fn() };
  return { statusCode, headers: { 'content-type': 'application/json' }, body };
}

it.each([null, false, 7, {}, [], '', 'AA', 'AA=', 'AA===', 'AB==', 'AAB=', 'AA==\n', 'AA== ', '-_==', 'AAAA===='])(
  'rejects an invalid receipt_base64 value %j before returning any unsigned success', async receipt => {
    const response = jsonResponse(JSON.stringify({ event_id: 'unsigned-id', receipt_base64: receipt }));
    request.mockResolvedValueOnce(response);
    await expect(new ServerPushEgress({ baseUrl: 'https://a.invalid' }).push(new Uint8Array([1])))
      .rejects.toThrow('SignedActionResult base64 invalid');
    expect(response.body.destroy).toHaveBeenCalled();
  });

it.each([200, 409])('rejects duplicate or malformed JSON carriers on HTTP %s', async status => {
  for (const raw of [
    '{"receipt_base64":"AA==","receipt_base64":"AQ=="}',
    '{"receipt_base64":"AA==","receipt_\\u0062ase64":"AQ=="}',
    '{"receipt_base64":"AA==","metadata":{"same":1,"same":2}}',
    '{"receipt_base64":"AA=="',
    '{"receipt_base64":"AA=="} trailing',
  ]) {
    const response = jsonResponse(raw, status); request.mockResolvedValueOnce(response);
    await expect(new ServerPushEgress({ baseUrl: 'https://a.invalid' }).push(new Uint8Array([1])))
      .rejects.toThrow('Push JSON response invalid');
    expect(response.body.destroy).toHaveBeenCalled();
  }
});

it('rejects invalid UTF-8 without repairing the original JSON receipt carrier', async () => {
  const response = jsonResponse(new Uint8Array([...Buffer.from('{"receipt_base64":"'), 255, ...Buffer.from('"}')]));
  request.mockResolvedValueOnce(response);
  await expect(new ServerPushEgress({ baseUrl: 'https://a.invalid' }).push(new Uint8Array([1]))).rejects.toThrow('Push JSON response invalid');
});

it('rechecks authority after JSON EOF even when the AbortSignal remains open', async () => {
  let active = true; const controller = new AbortController();
  const body = { async *[Symbol.asyncIterator]() { yield Buffer.from('{"receipt_base64":"AA=="}'); active = false; }, on: vi.fn(), destroy: vi.fn() };
  request.mockResolvedValueOnce({ statusCode: 200, headers: { 'content-type': 'application/json' }, body });
  await expect(new ServerPushEgress({ baseUrl: 'https://a.invalid', gate: { signal: controller.signal, isActive: () => active } })
    .push(new Uint8Array([1]))).rejects.toThrow('HOUSE_DISABLED');
  expect(body.destroy).toHaveBeenCalled();
});

it('fences a JSON response returned after the captured gate changes during request()', async () => {
  let active = true; const controller = new AbortController(), response = jsonResponse('{"receipt_base64":"AA=="}');
  request.mockImplementationOnce(async () => { active = false; return response; });
  await expect(new ServerPushEgress({ baseUrl: 'https://a.invalid', gate: { signal: controller.signal, isActive: () => active } })
    .push(new Uint8Array([1]))).rejects.toThrow('HOUSE_DISABLED');
  expect(response.body.destroy).toHaveBeenCalled();
});

it('retains legacy success metadata alongside opaque JSON bytes without trusting accepted=true', async () => {
  request.mockResolvedValueOnce(jsonResponse(JSON.stringify({ accepted: true, receipt_base64: 'AP8=', event_id: 'event', deduplicated: true, task_id: 'task' })));
  expect(await new ServerPushEgress({ baseUrl: 'https://a.invalid' }).push(new Uint8Array([1])))
    .toEqual({ status: 200, signedActionResultBase64: 'AP8=', eventId: 'event', deduplicated: true, taskId: 'task' });
});

it('retains a non-2xx error reason alongside its opaque JSON receipt', async () => {
  request.mockResolvedValueOnce(jsonResponse(JSON.stringify({ error: 'application rejected', receipt_base64: 'AP8=' }), 409));
  expect(await new ServerPushEgress({ baseUrl: 'https://a.invalid' }).push(new Uint8Array([1])))
    .toEqual({ status: 409, signedActionResultBase64: 'AP8=', detail: 'application rejected' });
});

it.each(['', ' \r\n\t'])('preserves non-2xx empty-body behavior for %j', async raw => {
  request.mockResolvedValueOnce(jsonResponse(raw, 503));
  expect(await new ServerPushEgress({ baseUrl: 'https://a.invalid' }).push(new Uint8Array([1])))
    .toEqual({ status: 503, detail: undefined });
});

it('preserves legacy JSON with unrelated fractional metadata', async () => {
  request.mockResolvedValueOnce(jsonResponse('{"event_id":"legacy-ok","elapsed":0.5}'));
  expect(await new ServerPushEgress({ baseUrl: 'https://a.invalid' }).push(new Uint8Array([1])))
    .toMatchObject({ status: 200, eventId: 'legacy-ok' });
});

it.each([200, 409])('preserves HTTP %s JSON receipt bytes with standard JSON metadata', async status => {
  request.mockResolvedValueOnce(jsonResponse('{"receipt_base64":"AP8=","outcome":{"retry_after":0.5,"exponent":1e30,"__proto__":{"polluted":true},"constructor":"metadata","prototype":"literal"}}', status));
  expect(await new ServerPushEgress({ baseUrl: 'https://a.invalid' }).push(new Uint8Array([1])))
    .toMatchObject({ status, signedActionResultBase64: 'AP8=' });
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});
