import { describe, expect, it, vi } from 'vitest';
import { buildSubcommands, HELP_SUBS, type SubcommandWiring } from '../../../src/commands/wiring.js';
import { routeSubcommand } from '../../../src/commands/popclaw-router.js';
import type { HouseCommandContext } from '../../../src/commands/popclaw-house.js';
import type { HouseCommandPort } from '../../../src/runtime/house-lifecycle/command-bus.js';
import { EN } from '../../../src/lexicon/en.js';
import { ZH_CN } from '../../../src/lexicon/zh-CN.js';

vi.mock('../../../src/lexicon/owner-language.js', async (original) => ({
  ...await original<typeof import('../../../src/lexicon/owner-language.js')>(),
  ownerLang: () => 'en',
}));

function fixture(getContext?: () => HouseCommandContext | Promise<HouseCommandContext>) {
  const unexpected = vi.fn(() => { throw new Error('unexpected runtime access'); });
  const wiring = {
    runtime: unexpected, paths: unexpected, picksFile: unexpected,
    warn: vi.fn(), llmComplete: unexpected, toolsRegisteredCount: () => 0,
    buildStamp: 'test', getHouseCommandContext: getContext,
  } as SubcommandWiring;
  return { map: buildSubcommands(wiring), unexpected };
}

const route = (map: ReturnType<typeof buildSubcommands>, ...positional: string[]) =>
  routeSubcommand(map, { args: { positional } });

describe('real /popclaw house command wiring', () => {
  it('lists both commands with English and Chinese usage and examples', () => {
    for (const name of ['login', 'logout']) {
      expect(HELP_SUBS).toContainEqual({ name, usage: true, examples: true });
      for (const copy of [EN.copy, ZH_CN.copy]) {
        for (const suffix of ['summary', 'usage', 'examples']) {
          expect((copy as Record<string, string>)[`help.${name}.${suffix}`]).toBeTruthy();
        }
      }
    }
  });

  it('construction, unknown commands and missing/extra targets do not resolve context', async () => {
    const getContext = vi.fn(() => { throw new Error('must stay lazy'); });
    const { map, unexpected } = fixture(getContext);
    await route(map, 'nonesuch');
    for (const name of ['login', 'logout']) {
      expect((await route(map, name)).text).toContain(`/popclaw ${name} <host>`);
      expect((await route(map, name, 'a.example', 'b.example')).text).toContain(`/popclaw ${name} <host>`);
    }
    expect(getContext).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalled();
  });

  it('reports missing host binding without opening the general runtime', async () => {
    const { map, unexpected } = fixture();
    expect((await route(map, 'login', 'a.example')).text).toContain('HOUSE_LIFECYCLE_UNSUPPORTED');
    expect((await route(map, 'logout', 'a.example')).text).toContain('HOUSE_LIFECYCLE_UNSUPPORTED');
    expect(unexpected).not.toHaveBeenCalled();
  });

  it('routes through the shared command core and an asynchronously resolved port', async () => {
    const loginHouse = vi.fn(async (origin: string) => ({
      scope: 'local_installation' as const, origin, status: 'connecting' as const,
      sessionId: '', operationId: 'queued-operation-id',
    }));
    const logoutHouse = vi.fn(async (origin: string) => ({
      scope: 'local_installation' as const, origin, operationId: 'leave-operation-id',
      remoteStatus: 'pending' as const,
    }));
    const port = { loginHouse, logoutHouse } as unknown as HouseCommandPort;
    const getContext = vi.fn(async (): Promise<HouseCommandContext> => ({ coordinator: () => port, lang: () => 'en' }));
    const { map, unexpected } = fixture(getContext);
    expect(getContext).not.toHaveBeenCalled();
    const login = await route(map, 'LOGIN', 'a.example');
    expect(loginHouse).toHaveBeenCalledWith('https://a.example');
    expect(login.text).toContain('queued-o');
    expect(login.text).toContain('queued');
    expect(login.text).not.toContain('local intent saved');
    const logout = await route(map, 'logout', 'https://a.example');
    expect(logoutHouse).toHaveBeenCalledWith('https://a.example');
    expect(logout.text).toContain('server leave pending confirmation');
    expect(getContext).toHaveBeenCalledTimes(2);
    expect(unexpected).not.toHaveBeenCalled();
  });
});
