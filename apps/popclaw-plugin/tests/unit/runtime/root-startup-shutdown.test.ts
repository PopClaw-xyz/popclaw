import { afterEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ runtime: vi.fn() }));
vi.mock('../../../src/runtime/once.js', async original => {
  const real = await original<typeof import('../../../src/runtime/once.js')>();
  return { ...real, getOrCreatePerProcess: (key: string, factory: () => unknown) =>
    key === 'runtime' ? seam.runtime(key, factory) : real.getOrCreatePerProcess(key, factory) };
});
import plugin from '../../../src/index.js';

type Service = { id: string; start(): Promise<void> };
type Hook = () => Promise<void>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function register() {
  const services = new Map<string, Service>();
  const hooks = new Map<string, Hook>();
  const api = {
    registrationMode: 'full', config: {}, pluginConfig: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      state: { resolveStateDir: () => '/private/tmp/popclaw-root-shutdown-test' },
      system: { enqueueSystemEvent: vi.fn(), runHeartbeatOnce: vi.fn() },
    },
    registerCommand: vi.fn(), registerTool: vi.fn(), registerInteractiveHandler: vi.fn(),
    registerService: (service: Service) => services.set(service.id, service),
    on: (name: string, hook: Hook) => hooks.set(name, hook),
  };
  plugin.register!(api as unknown as Parameters<NonNullable<typeof plugin.register>>[0]);
  return {
    start: () => services.get('popclaw-runtime')!.start(),
    stop: () => hooks.get('gateway_stop')!(),
  };
}

afterEach(() => { vi.clearAllMocks(); });

describe('actual OpenClaw root startup and gateway shutdown ordering', () => {
  it('waits for an ignited bootstrap and its cleanup before resolving gateway_stop', async () => {
    const boot = deferred<{ shutdown(): Promise<void> }>();
    const drain = deferred<void>();
    const shutdown = vi.fn(() => drain.promise);
    seam.runtime.mockReturnValue(boot.promise);
    const root = register();
    const starting = root.start().catch(() => undefined);
    // get() schedules construction; the bootstrap is only ignited once the
    // builder's microtask has actually requested the runtime promise.
    await Promise.resolve();
    expect(seam.runtime).toHaveBeenCalledOnce();
    expect(seam.runtime.mock.calls[0]![0]).toBe('runtime');
    let stopped = false;
    const stopping = root.stop().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedBeforeBootstrap = stopped;
    boot.resolve({ shutdown });
    // A root may either resolve startup after cleaning up, or reject it as
    // closing. In both cases every stop caller must await the actual drain.
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedBeforeDrain = stopped;
    const shutdownCalls = shutdown.mock.calls.length;
    drain.resolve();
    await Promise.all([starting, stopping]);
    expect({ stoppedBeforeBootstrap, stoppedBeforeDrain, shutdownCalls }).toEqual({
      stoppedBeforeBootstrap: false, stoppedBeforeDrain: false, shutdownCalls: 1,
    });
  });

  it('keeps all concurrent stop callers waiting for the same runtime cleanup', async () => {
    const drain = deferred<void>();
    const shutdown = vi.fn(() => drain.promise);
    seam.runtime.mockResolvedValue({ shutdown, houseRuntime:{activateInitialMe:vi.fn(async()=>undefined),readHouseGuide:vi.fn(async()=>({status:'unavailable'}))} });
    const root = register();
    await root.start();
    let completed = 0;
    const first = root.stop().then(() => { completed++; });
    const second = root.stop().then(() => { completed++; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const completedBeforeDrain = completed;
    const shutdownCalls = shutdown.mock.calls.length;
    drain.resolve();
    await Promise.all([first, second]);
    expect({ completedBeforeDrain, shutdownCalls, completed }).toEqual({
      completedBeforeDrain: 0, shutdownCalls: 1, completed: 2,
    });
  });

  it('stops a cold registration without constructing a runtime', async () => {
    seam.runtime.mockImplementation(() => { throw new Error('cold stop must not bootstrap'); });
    const root = register();
    await root.stop();
    expect(seam.runtime).not.toHaveBeenCalled();
  });

  it('cancels a queued but unignited bootstrap and resolves gateway_stop without opening resources', async () => {
    seam.runtime.mockImplementation(() => { throw new Error('cancelled startup must not bootstrap'); });
    const root = register();
    const starting = root.start().then(() => 'started', error => (error as Error).message);
    await root.stop();
    expect(await starting).toBe('HOST_RUNTIME_STOPPED');
    expect(seam.runtime).not.toHaveBeenCalled();
  });
});
