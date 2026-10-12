import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import type { Signer } from '../../../src/identity/signer.js';
import { INBOX_TOKEN_HEADER } from '../../../src/identity/read-credential.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { HouseGate } from '../../../src/runtime/house-lifecycle/manager.js';
import { ActionInactiveError, withAction, withHouseActions } from '../../../src/runtime/house-lifecycle/action-context.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';

const ORIGIN = 'https://house.invalid';
const URL = `${ORIGIN}/document`;
const lanes = ['houseReadFetch', 'houseFetch', 'documentFetch'] as const;
const publicLanes = ['houseReadFetch', 'documentFetch'] as const;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function gate(): HouseGate & { close(): void } {
  let active = true;
  return { origin: ORIGIN, generation: 1, signal: new AbortController().signal,
    isActive: () => active, close: () => { active = false; } };
}

// Exercise the public runtime facades while substituting only authority and
// HTTP. Real database/HTTP gate behavior remains covered by house-runtime-push.
function fixture() {
  const db = new InMemoryHostDb();
  const runtime = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor,
    db, origins: [ORIGIN], signer: {} as Signer });
  cleanup.push(() => { db.close(); });
  cleanup.push(() => runtime.stop());
  const current = gate();
  const houseGate = vi.spyOn(runtime, 'captureGate').mockReturnValue(current);
  const publicGate = vi.spyOn(runtime, 'publicReadGate').mockReturnValue(current);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetch);
  return { runtime, current, houseGate, publicGate, fetch };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe.each(lanes)('%s public entry characterization', lane => {
  it('normalizes synchronously without capturing authority or fetching', async () => {
    const f = fixture();
    expect(() => f.runtime[lane]('//house.invalid')).toThrow('protocol-relative');
    const fetch = f.runtime[lane]('https://HOUSE.invalid/path');
    expect(f.houseGate).not.toHaveBeenCalled();
    expect(f.publicGate).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    await fetch(URL);
    expect(lane === 'houseReadFetch' ? f.publicGate : f.houseGate).toHaveBeenCalledWith(ORIGIN);
  });

  it('captures fresh authority for each request made by one fetch factory', async () => {
    const f = fixture();
    const fetch = f.runtime[lane](ORIGIN);
    await fetch(URL);
    const next = gate();
    f.current.close();
    const capture = lane === 'houseReadFetch' ? f.publicGate : f.houseGate;
    capture.mockReturnValue(next);
    await fetch(URL);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('resolves the global fetch at each dispatch after factory creation', async () => {
    const f = fixture();
    const fetch = f.runtime[lane](ORIGIN);
    const first = vi.fn<typeof globalThis.fetch>(async () => new Response('first'));
    vi.stubGlobal('fetch', first);
    expect(await (await fetch(URL)).text()).toBe('first');
    const second = vi.fn<typeof globalThis.fetch>(async () => new Response('second'));
    vi.stubGlobal('fetch', second);
    expect(await (await fetch(URL)).text()).toBe('second');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('rejects request errors asynchronously and checks command scope before its gate', async () => {
    const f = fixture();
    const fetch = f.runtime[lane](ORIGIN);
    let result!: Promise<Response>;
    expect(() => { result = withHouseActions(new Map(), () => fetch('bad-url')); }).not.toThrow();
    await expect(result).rejects.toBeInstanceOf(ActionInactiveError);
    expect(f.houseGate).not.toHaveBeenCalled();
    expect(f.publicGate).not.toHaveBeenCalled();
    f.current.close();
    await expect(fetch('bad-url', { method: 'POST', headers: { cookie: 'x' } })).rejects.toBeInstanceOf(ActionInactiveError);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('forwards the original Request and combines both caller signals', async () => {
    const f = fixture();
    const requestAbort = new AbortController(), initAbort = new AbortController();
    const request = new Request(URL, { method: 'HEAD', signal: requestAbort.signal });
    await f.runtime[lane](ORIGIN)(request, { method: 'GET', signal: initAbort.signal, redirect: 'follow' });
    const [input, init] = f.fetch.mock.calls[0]!;
    expect(input).toBe(request);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.signal?.aborted).toBe(false);
    requestAbort.abort();
    expect(init?.signal?.aborted).toBe(true);
    // Each input signal independently closes the combined request signal.
    const secondRequest = new Request(URL, { signal: new AbortController().signal });
    await f.runtime[lane](ORIGIN)(secondRequest, { signal: initAbort.signal });
    const secondSignal = f.fetch.mock.calls[1]![1]?.signal;
    expect(secondSignal?.aborted).toBe(false);
    initAbort.abort();
    expect(secondSignal?.aborted).toBe(true);
  });

  it('rechecks authority after headers arrive and preserves ordinary transport failures', async () => {
    const f = fixture(), pending = deferred<Response>();
    f.fetch.mockImplementationOnce(() => pending.promise);
    const result = f.runtime[lane](ORIGIN)(URL);
    const rejected = expect(result).rejects.toBeInstanceOf(ActionInactiveError);
    f.current.close(); pending.resolve(new Response('old'));
    await rejected;
    const next = gate();
    f.houseGate.mockReturnValue(next); f.publicGate.mockReturnValue(next);
    const error = new Error('transport failed');
    f.fetch.mockRejectedValueOnce(error);
    await expect(f.runtime[lane](ORIGIN)(URL)).rejects.toBe(error);
  });
});

describe.each(['houseFetch', 'documentFetch'] as const)('%s captured authority', lane => {
  it('retains the supplied gate instead of substituting fresh authority', async () => {
    const f = fixture(), captured = gate();
    const fetch = f.runtime[lane](ORIGIN, captured);
    await fetch(URL);
    captured.close();
    await expect(fetch(URL)).rejects.toBeInstanceOf(ActionInactiveError);
    expect(f.houseGate).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it('preserves the existing acceptance of a caller-supplied gate origin', async () => {
    const f = fixture();
    await f.runtime[lane](ORIGIN, { ...gate(), origin: 'https://other.invalid' })(URL);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});

describe.each(publicLanes)('%s public request policy', lane => {
  it.each(['authorization', 'cookie', INBOX_TOKEN_HEADER])('refuses %s from either header list even when init replaces Request headers', async name => {
    const f = fixture(), fetch = f.runtime[lane](ORIGIN);
    await expect(fetch(new Request(URL, { headers: { [name]: 'secret' } }),
      { headers: { accept: 'text/plain' } })).rejects.toThrow('HOUSE_READ_CREDENTIAL_REFUSED');
    await expect(fetch(new Request(URL, { headers: { accept: 'text/plain' } }),
      { headers: { [name]: 'secret' } })).rejects.toThrow('HOUSE_READ_CREDENTIAL_REFUSED');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('uses init method before Request method and forces public credentials and redirect policy', async () => {
    const f = fixture(), fetch = f.runtime[lane](ORIGIN);
    await fetch(new Request(URL, { method: 'POST' }), { method: 'head', credentials: 'include', redirect: 'follow' });
    expect(f.fetch.mock.calls[0]![1]).toMatchObject({ method: 'HEAD', credentials: 'omit', redirect: 'error' });
    await expect(fetch(new Request(URL, { method: 'POST' }))).rejects.toThrow('HOUSE_READ_METHOD_NOT_ALLOWED');
    await expect(fetch(URL, { method: 'POST', headers: { cookie: 'x' } })).rejects.toThrow('HOUSE_READ_METHOD_NOT_ALLOWED');
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});

it('keeps URL, address, method and header refusal priority', async () => {
  const f = fixture();
  await expect(f.runtime.houseReadFetch(ORIGIN)('https://elsewhere.invalid',
    { method: 'POST', headers: { cookie: 'x' } })).rejects.toThrow('HOUSE_AUDIENCE_MISMATCH');
  const document = f.runtime.documentFetch(ORIGIN);
  await expect(document('ftp://127.0.0.1/doc', { method: 'POST' })).rejects.toThrow('HOUSE_DOCUMENT_URL_REFUSED');
  await expect(document('http://127.0.0.1/doc', { method: 'POST', headers: { cookie: 'x' } })).rejects.toThrow('HOUSE_DOCUMENT_ADDRESS_REFUSED');
  expect(f.fetch).not.toHaveBeenCalled();
});

it('keeps same-origin credentials and method on the ordinary house lane', async () => {
  const f = fixture(), request = new Request(URL, { method: 'POST', headers: { authorization: 'secret' } });
  await f.runtime.houseFetch(ORIGIN)(request, { credentials: 'include', headers: { cookie: 'a=b' } });
  expect(f.fetch.mock.calls[0]![0]).toBe(request);
  expect(f.fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'include', headers: { cookie: 'a=b' }, redirect: 'error' });
  expect(f.fetch.mock.calls[0]![1]).not.toHaveProperty('method');
  expect(request.headers.get('authorization')).toBe('secret');
});

it('keeps fetchHouse URL failures synchronous and valid requests delegated to the house lane', async () => {
  const f = fixture();
  expect(() => f.runtime.fetchHouse('bad-url')).toThrow(TypeError);
  await f.runtime.fetchHouse(new Request(URL));
  expect(f.houseGate).toHaveBeenCalledWith(ORIGIN);
  expect(f.fetch).toHaveBeenCalledOnce();
});

const decoders = ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const;
describe.each(decoders)('deferred %s decoder', decoder => {
  it('rejects stale authority before starting body decoding', async () => {
    const f = fixture(), body = new Response('field=value', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const decode = vi.spyOn(body, decoder);
    f.fetch.mockResolvedValue(body);
    const response = await f.runtime.houseReadFetch(ORIGIN)(URL);
    f.current.close();
    await expect(response[decoder]()).rejects.toBeInstanceOf(ActionInactiveError);
    expect(decode).not.toHaveBeenCalled();
  });

  it('rejects authority revoked while body decoding is pending', async () => {
    const f = fixture(), body = new Response(), pending = deferred<never>();
    const decode = vi.spyOn(body, decoder).mockImplementation(() => pending.promise);
    f.fetch.mockResolvedValue(body);
    const response = await f.runtime.houseReadFetch(ORIGIN)(URL);
    const result = response[decoder]();
    const rejected = expect(result).rejects.toBeInstanceOf(ActionInactiveError);
    expect(decode).toHaveBeenCalledOnce();
    f.current.close(); pending.resolve(undefined as never);
    await rejected;
  });
});

it('retains the enclosing action scope captured when the decoder is first read', async () => {
  const f = fixture(), parent = gate();
  const response = await f.runtime.documentFetch(ORIGIN)(URL);
  const decode = withAction(parent, () => response.text);
  parent.close();
  expect(() => decode()).toThrow(ActionInactiveError);
});
