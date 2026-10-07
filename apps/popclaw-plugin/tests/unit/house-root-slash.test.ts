import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seam = vi.hoisted(() => ({ runtime: vi.fn() }));
vi.mock('../../src/runtime/once.js', async (original) => {
  const actual = await original<typeof import('../../src/runtime/once.js')>();
  return {
    ...actual,
    getOrCreatePerProcess: (key: string, factory: () => unknown) =>
      key === 'runtime' ? seam.runtime() : actual.getOrCreatePerProcess(key, factory),
  };
});
vi.mock('../../src/lexicon/owner-language.js', async (original) => ({
  ...await original<typeof import('../../src/lexicon/owner-language.js')>(),
  ownerLang: () => 'en', observeOwnerText: vi.fn(),
}));
import plugin from '../../src/index.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})); vi.clearAllMocks(); });

function register() {
  const state = mkdtempSync(join(tmpdir(), 'house-slash-root-')); roots.push(state);
  const commands: Array<{name: string; handler(ctx: {args: string}): Promise<{text: string}>}> = [];
  type Tool = { name: string };
  type Factory = (context: unknown) => Tool | Tool[] | null | undefined;
  const tools: Tool[] = [];
  const hostContext = { agentId: 'main', getRuntimeConfig: () => ({}) };
  const api = {
    registrationMode: 'full', config: {}, pluginConfig: {},
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    runtime: {state: {resolveStateDir: () => state}, system: {enqueueSystemEvent: vi.fn(), runHeartbeatOnce: vi.fn()}},
    registerCommand: (command: typeof commands[number]) => commands.push(command),
    // SDK 9.8 accepts both function factories and v2 descriptors. Resolve
    // their returned tools; Function.name is not the discoverable tool name.
    registerTool: (registration: Tool | Factory | { contextVersion: 2; create: Factory }, options?: { name?: string; names?: string[] }) => {
      const resolved = typeof registration === 'function' ? registration(hostContext)
        : 'contextVersion' in registration ? registration.create(hostContext) : registration;
      for (const tool of Array.isArray(resolved) ? resolved : resolved ? [resolved] : []) {
        if (options?.names) expect(options.names).toContain(tool.name);
        else expect(tool.name).toBe(options?.name);
        tools.push(tool);
      }
    },
    registerService: vi.fn(), registerInteractiveHandler: vi.fn(), on: vi.fn(),
  };
  plugin.register!(api as unknown as Parameters<NonNullable<typeof plugin.register>>[0]);
  expect(commands.map(c => c.name)).toEqual(['popclaw']);
  return { invoke: (args: string) => commands[0]!.handler({args}), tools };
}

describe('house commands through the actual plugin register callback', () => {
  it('registers discoverable house tools and keeps help/unknown out of runtime', async () => {
    seam.runtime.mockImplementation(() => { throw new Error('metadata must not bootstrap'); });
    const {invoke, tools} = register();
    for (const name of ['popclaw_house_login', 'popclaw_house_logout']) {
      expect(tools.filter(tool => tool.name === name)).toHaveLength(1);
    }
    for (const args of ['', 'help', 'not-a-command']) {
      const reply = await invoke(args);
      expect(reply.text).toBeTruthy();
      if (args !== 'not-a-command') expect(reply.text).toContain('login');
    }
    expect(seam.runtime).not.toHaveBeenCalled();
  });

  it('dispatches login/logout from the registered slash callback to the runtime port', async () => {
    const loginHouse = vi.fn(async (origin: string) => ({origin, scope: 'local_installation', status: 'connecting', sessionId: '', operationId: 'queued-operation'}));
    const logoutHouse = vi.fn(async (origin: string) => ({origin, scope: 'local_installation', remoteStatus: 'pending', operationId: 'leave-operation'}));
    seam.runtime.mockResolvedValue({houseRuntime: {commands: {loginHouse, logoutHouse}}});
    const {invoke} = register();
    expect(seam.runtime).not.toHaveBeenCalled();
    expect((await invoke('login http://127.0.0.1:19991')).text).toContain('queued locally');
    expect(loginHouse).toHaveBeenCalledOnce();
    expect(loginHouse).toHaveBeenCalledWith('http://127.0.0.1:19991');
    expect((await invoke('logout http://127.0.0.1:19991')).text).toContain('server leave pending confirmation');
    expect(logoutHouse).toHaveBeenCalledOnce();
    expect(logoutHouse).toHaveBeenCalledWith('http://127.0.0.1:19991');
    expect(seam.runtime).toHaveBeenCalled();
  });
});
