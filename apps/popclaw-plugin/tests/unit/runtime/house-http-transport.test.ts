import { describe, expect, it, vi } from 'vitest';
import { createHouseHttpTransport } from '../../../src/runtime/house-lifecycle/house-http-transport.js';
import { ActionInactiveError, withHouseActions, type ActionGate } from '../../../src/runtime/house-lifecycle/action-context.js';

const ORIGIN = 'https://house.invalid';
const lanes = ['houseReadFetch', 'houseFetch', 'documentFetch'] as const;
function fixture() {
  let active = true;
  const gate: ActionGate = { signal: new AbortController().signal, isActive: () => active };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('ok'));
  const deps = { getPublicReadGate: vi.fn(() => gate), getHouseGate: vi.fn(() => gate), currentFetch: vi.fn(() => fetch) };
  return { deps, fetch, close: () => { active = false; } };
}

describe.each(lanes)('%s transport dependencies', lane => {
  it('does not read dependencies during construction or fetch-factory creation', async () => {
    const f = fixture(), transport = createHouseHttpTransport(f.deps);
    const fetch = transport[lane]('https://HOUSE.invalid/path');
    expect(f.deps.getPublicReadGate).not.toHaveBeenCalled();
    expect(f.deps.getHouseGate).not.toHaveBeenCalled();
    expect(f.deps.currentFetch).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    await fetch(`${ORIGIN}/document`);
    expect(lane === 'houseReadFetch' ? f.deps.getPublicReadGate : f.deps.getHouseGate).toHaveBeenCalledWith(ORIGIN);
    expect(f.deps.currentFetch).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it('does not resolve the leaf fetch before authority and URL checks succeed', async () => {
    const f = fixture(), fetch = createHouseHttpTransport(f.deps)[lane](ORIGIN);
    await expect(withHouseActions(new Map(), () => fetch('bad-url'))).rejects.toBeInstanceOf(ActionInactiveError);
    expect(f.deps.getPublicReadGate).not.toHaveBeenCalled();
    expect(f.deps.getHouseGate).not.toHaveBeenCalled();
    await expect(fetch('bad-url')).rejects.toBeInstanceOf(TypeError);
    expect(f.deps.currentFetch).not.toHaveBeenCalled();
    f.close();
    await expect(fetch('bad-url')).rejects.toBeInstanceOf(ActionInactiveError);
    expect(f.deps.currentFetch).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('uses the dependency selected for each actual dispatch', async () => {
    const f = fixture(), fetch = createHouseHttpTransport(f.deps)[lane](ORIGIN);
    await fetch(`${ORIGIN}/document`);
    const second = vi.fn<typeof globalThis.fetch>(async () => new Response('second'));
    f.deps.currentFetch.mockReturnValue(second);
    expect(await (await fetch(`${ORIGIN}/document`)).text()).toBe('second');
    expect(f.deps.currentFetch).toHaveBeenCalledTimes(2);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});

it.each(['houseReadFetch', 'documentFetch'] as const)('%s resolves no leaf fetch for a refused method or credential', async lane => {
  const f = fixture(), fetch = createHouseHttpTransport(f.deps)[lane](ORIGIN);
  await expect(fetch(ORIGIN, { method: 'POST' })).rejects.toThrow('HOUSE_READ_METHOD_NOT_ALLOWED');
  await expect(fetch(ORIGIN, { headers: { cookie: 'secret' } })).rejects.toThrow('HOUSE_READ_CREDENTIAL_REFUSED');
  expect(f.deps.currentFetch).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});
