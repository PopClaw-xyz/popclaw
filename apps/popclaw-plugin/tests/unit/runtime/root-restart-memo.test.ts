import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPerProcess, getOrCreatePerProcess } from '../../../src/runtime/once.js';
import { NewspaperDispatchRegistry } from '../../../src/newspaper/dedicated-session.js';
import plugin from '../../../src/index.js';

/**
 * Re-registration in a live process (issue #582): `openclaw gateway restart`
 * runs in-process, so the plugin is registered a second time against the same
 * globalThis. The runtime is memoized there; unless its own shutdown drops the
 * memo, the second registration adopts the already-closed runtime — closed
 * sqlite handles, stopped house manager — and every later call fails with
 * "The database connection is not open" / HOUSE_RUNTIME_STOPPED.
 */

type Service = { id: string; start(): Promise<void>; stop?(): Promise<void> };
type Hook = () => Promise<void>;

const roots: string[] = [];
afterEach(() => {
  clearPerProcess('runtime');
  NewspaperDispatchRegistry.clear();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** One plugin registration against a private data root, as the gateway does it. */
function register(loreHouses: string[]) {
  const state = mkdtempSync(join(tmpdir(), 'popclaw-restart-'));
  roots.push(state);
  mkdirSync(join(state, 'popclaw', 'config'), { recursive: true });
  writeFileSync(join(state, 'popclaw', 'config', 'plugin.json'), JSON.stringify({ lore_houses: loreHouses }));
  return registerAt(state);
}

/** A second registration against the SAME data root — an in-process restart. */
function registerAt(state: string) {
  const services = new Map<string, Service>();
  const hooks = new Map<string, Hook>();
  const logs: string[] = [];
  const log = (message: unknown) => { logs.push(String(message)); };
  const api = {
    registrationMode: 'full', config: {}, pluginConfig: {},
    logger: { debug: log, info: log, warn: log, error: log },
    runtime: {
      state: { resolveStateDir: () => state },
      system: { enqueueSystemEvent: vi.fn(), runHeartbeatOnce: vi.fn() },
    },
    registerCommand: vi.fn(), registerTool: vi.fn(), registerInteractiveHandler: vi.fn(),
    registerService: (service: Service) => services.set(service.id, service),
    on: (name: string, hook: Hook) => hooks.set(name, hook),
  };
  plugin.register!(api as unknown as Parameters<NonNullable<typeof plugin.register>>[0]);
  return {
    state,
    start: () => services.get('popclaw-runtime')!.start(),
    startOnboarding: () => services.get('onboarding-orchestrator')!.start(),
    stop: () => hooks.get('gateway_stop')!(),
    /** Every bootstrap attempt logs the build line exactly once. */
    bootAttempts: () => logs.filter(line => line.startsWith('popclaw: build ')).length,
    shutdownsCompleted: () => logs.filter(line => line.includes('shutdown complete')).length,
    staleMemosDetected: () => logs.filter(line => line.includes('stale runtime memo')).length,
  };
}

const offline = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('UNEXPECTED_NETWORK'); }));

describe('re-registering the plugin in a process that already shut one runtime down', () => {
  it('boots a fresh runtime instead of adopting the closed one', async () => {
    offline();
    const first = register(['http://127.0.0.1:59999']);
    await first.start();
    await first.stop();
    expect(first.shutdownsCompleted()).toBe(1);

    const second = registerAt(first.state);
    await second.start();
    // The memo the first runtime owned must be gone: the second registration
    // has to run the bootstrap itself, not inherit closed sqlite handles.
    expect(second.bootAttempts()).toBe(1);
    await second.stop();
    expect(second.shutdownsCompleted()).toBe(1);
  }, 30_000);

  it('leaves no phantom newspaper dispatch in flight across the restart', async () => {
    offline();
    const root = register(['http://127.0.0.1:59999']);
    await root.start();
    NewspaperDispatchRegistry.start('session-a', { runId: 'run-1', startedAt: Date.now(), ttlMs: 12 * 60 * 1000 });
    await root.stop();
    // Nothing is writing that paper any more — the workshop died with the runtime.
    expect(NewspaperDispatchRegistry.inFlight('session-a')).toBeUndefined();
  }, 30_000);

  it('boots fresh when an OLDER build\'s shutdown left its memo behind', async () => {
    offline();
    const first = register(['http://127.0.0.1:59999']);
    await first.start();
    // An older build (no clearPerProcess on shutdown) closes every handle and
    // leaves the memo parked on globalThis. Re-park what its shutdown released
    // to reproduce exactly the state the upgrading host boots into.
    const corpse = getOrCreatePerProcess<Promise<unknown>>('runtime', () => {
      throw new Error('the first registration should have memoized its runtime');
    });
    await first.stop();
    getOrCreatePerProcess('runtime', () => corpse);

    const second = registerAt(first.state);
    await second.start();
    // Adopting the corpse would fail here with "The database connection is not
    // open" — the onboarding orchestrator is the first thing to touch sqlite.
    await second.startOnboarding();
    expect(second.staleMemosDetected()).toBe(1);
    expect(second.bootAttempts()).toBe(1);
    await second.stop();
    expect(second.shutdownsCompleted()).toBe(1);
  }, 30_000);

  it('does not memoize a failed boot as the process runtime', async () => {
    offline();
    const root = register([]);
    await expect(root.start()).rejects.toBeTruthy();
    await expect(root.start()).rejects.toBeTruthy();
    // A second ignition must really retry; a cached rejection would make the
    // failure permanent for the life of the process.
    expect(root.bootAttempts()).toBe(2);
  }, 30_000);
});
