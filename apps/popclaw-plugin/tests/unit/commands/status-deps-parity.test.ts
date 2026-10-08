/**
 * The status report reaches `runStatusCommand` from two entrances that hold a
 * runtime: the `/popclaw status` slash command and the `popclaw_check_status`
 * tool. They build the same dependency set from the same runtime, apart from a
 * few fields only one of them has. This pins both halves: every shared field
 * maps to the same value, and the entrance-only fields are exactly these.
 *
 * The dev CLI builds its own, much narrower set from a bootstrap rather than a
 * runtime, and is deliberately not part of this comparison.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: Array<Record<string, unknown>> = [];
vi.mock('../../../src/commands/status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/commands/status.js')>();
  return {
    ...actual,
    runStatusCommand: vi.fn(async (deps: Record<string, unknown>) => {
      captured.push(deps);
      return {popclawId: 'me', sigil: 'abc123', verifiedProfiles: [], following: []};
    }),
  };
});

import { buildSubcommands, type SubcommandWiring } from '../../../src/commands/wiring.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';

const SIGNER = { tag: 'signer' };
const HOST = { tag: 'host' };
const FETCH = vi.fn();
const SOCIAL_GRAPH = { tag: 'socialGraph' };
const NAME_OF = Object.assign(() => 'name', { tag: 'nameOf' });
const BONDS = { tag: 'bonds', get: () => undefined, list: () => [] };
const TASTE = { tag: 'taste', enabledSources: async () => [] };
const WATCH = { tag: 'inviteWatch' };
const DRAIN = vi.fn(async () => {});
const BACKLOG = vi.fn(() => ({ count: 0 }));
const TARGET = { channel: 'telegram', to: 'owner' };

function fakeRuntime() {
  const nowhere = '/nonexistent/popclaw-status-parity';
  return {
    boot: {
      signer: SIGNER,
      loreHouseUrl: 'https://house.example',
      loreHouseUrls: ['https://house.example'],
      nickname: 'Yu',
      webBaseUrl: 'https://web.example',
      popclawId: 'me',
    },
    host: HOST,
    houseRuntime: { houseReadFetch: vi.fn(() => FETCH), runCommand: <T>(fn: () => T) => fn() },
    socialGraph: SOCIAL_GRAPH,
    ownerNotifyTargetStore: { get: async () => TARGET },
    nameOf: NAME_OF,
    bondsStore: BONDS,
    inboxStore: { distinctSenderCount: () => 7 },
    onboardingState: { get: (id: string) => (id === 'me' ? { stage: 'graduated' } : null) },
    tasteLoader: TASTE,
    paths: {
      socialLogDir: () => `${nowhere}/social-log`,
      cadenceDir: () => '/cadence-dir',
      dreamerStateFile: () => `${nowhere}/dreamer.json`,
      newspaperDir: () => `${nowhere}/newspaper`,
      lastBuildFile: () => `${nowhere}/last-build.json`,
    },
    pendingInvites: { listPending: () => [{ platform: 'x', handle: 'yu' }] },
    inviteWatch: WATCH,
    drainNotifications: DRAIN,
    notifyBacklog: BACKLOG,
    lastCommandAddress: { channel: 'telegram' },
  };
}

async function viaSlash(): Promise<Record<string, unknown>> {
  const rt = fakeRuntime();
  const boom = (): never => {
    throw new Error('not used by status');
  };
  const map = buildSubcommands({
    runtime: async () => rt,
    paths: boom,
    picksFile: boom,
    warn: boom,
    llmComplete: boom,
    toolsRegisteredCount: boom,
    buildStamp: 'test-build',
  } as unknown as SubcommandWiring);
  await (map.status as (ctx: unknown) => Promise<unknown>)({ args: { positional: [], flags: {} } });
  return captured.at(-1)!;
}

async function viaTool(rt: Record<string, unknown> = fakeRuntime()): Promise<Record<string, unknown>> {
  let execute: (() => Promise<unknown>) | undefined;
  registerPopclawTools({
    api: {
      registerTool: (tool: unknown) => {
        const t = tool as { name?: string; execute?: () => Promise<unknown> };
        if (t?.name === 'popclaw_check_status') execute = t.execute;
      },
    } as Parameters<typeof registerPopclawTools>[0]['api'],
    runtime: (async () => rt) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
  });
  await execute!();
  return captured.at(-1)!;
}

beforeEach(() => {
  captured.length = 0;
});

describe('status dependencies — slash command and tool', () => {
  it('map every shared field to the same value, and differ only in their own fields', async () => {
    const slash = await viaSlash();
    const tool = await viaTool();
    const slashKeys = new Set(Object.keys(slash));
    const toolKeys = new Set(Object.keys(tool));

    expect([...slashKeys].filter((k) => !toolKeys.has(k)).sort()).toEqual(['currentChannel', 'lastBuildUpgrade']);
    expect([...toolKeys].filter((k) => !slashKeys.has(k)).sort()).toEqual(['audience', 'dreamCron']);

    const shared = [...slashKeys].filter((k) => toolKeys.has(k)).sort();
    expect(shared).toEqual(
      [
        'bondsStore', 'cadenceDir', 'checkPendingInvites', 'configuredHouses', 'dmSenderCount',
        'drainNotifications', 'fetch', 'host', 'lastDreamAt', 'loreHouseUrl', 'logger', 'nameOf',
        'nickname', 'notifyBacklog', 'notifyTarget', 'onboardingStage', 'outdatedNewspaperRules',
        'pendingInvites', 'signer', 'socialGraph', 'socialLog', 'tasteLoader', 'webBaseUrl',
      ].sort(),
    );

    // Values straight from the runtime are the same objects.
    for (const k of [
      'signer', 'host', 'loreHouseUrl', 'fetch', 'configuredHouses', 'socialGraph', 'nickname',
      'webBaseUrl', 'notifyTarget', 'nameOf', 'bondsStore', 'tasteLoader', 'cadenceDir',
      'drainNotifications', 'notifyBacklog', 'lastDreamAt',
    ]) {
      expect(tool[k], k).toStrictEqual(slash[k]);
    }
    // …and each is the runtime's own value, not merely equal across the two
    // entrances (both now come from one builder, so equality alone proves little).
    const expected: Record<string, unknown> = {
      signer: SIGNER,
      host: HOST,
      loreHouseUrl: 'https://house.example',
      fetch: FETCH,
      configuredHouses: ['https://house.example'],
      socialGraph: SOCIAL_GRAPH,
      nickname: 'Yu',
      webBaseUrl: 'https://web.example',
      notifyTarget: TARGET,
      nameOf: NAME_OF,
      bondsStore: BONDS,
      tasteLoader: TASTE,
      cadenceDir: '/cadence-dir',
      drainNotifications: DRAIN,
      notifyBacklog: BACKLOG,
    };
    for (const [k, v] of Object.entries(expected)) {
      expect(slash[k], `slash ${k}`).toStrictEqual(v);
      expect(tool[k], `tool ${k}`).toStrictEqual(v);
    }

    // Closures: same answers when called.
    const call = (deps: Record<string, unknown>, k: string, ...a: unknown[]) =>
      (deps[k] as (...x: unknown[]) => unknown)(...a);
    expect(call(tool, 'dmSenderCount')).toBe(7);
    expect(call(slash, 'dmSenderCount')).toBe(7);
    expect(call(tool, 'onboardingStage', 'me')).toBe(call(slash, 'onboardingStage', 'me'));
    expect(call(tool, 'onboardingStage', 'other')).toBe(null);
    expect(call(tool, 'pendingInvites')).toEqual(call(slash, 'pendingInvites'));
    // An unreadable social log is a quiet week, never an error.
    expect(call(tool, 'socialLog', 0, 1)).toEqual([]);
    expect(call(slash, 'socialLog', 0, 1)).toEqual([]);
    expect(call(tool, 'outdatedNewspaperRules')).toEqual(call(slash, 'outdatedNewspaperRules'));
    expect(typeof tool['checkPendingInvites']).toBe('function');
    expect(typeof slash['checkPendingInvites']).toBe('function');

    // The entrance-only fields.
    expect(slash['currentChannel']).toBe('telegram');
    expect(slash['lastBuildUpgrade']).toBe(null);
    expect(tool['audience']).toBe('agent');
  });

  it('without a house runtime, both fall back to the global fetch', async () => {
    const withoutHouseRuntime = (): Record<string, unknown> => {
      const rt = fakeRuntime() as Record<string, unknown>;
      delete rt['houseRuntime'];
      return rt;
    };
    const slashRt = withoutHouseRuntime();
    const map = buildSubcommands({
      runtime: async () => slashRt,
      buildStamp: 'test-build',
    } as unknown as SubcommandWiring);
    await (map.status as (ctx: unknown) => Promise<unknown>)({ args: { positional: [], flags: {} } });
    expect(captured.at(-1)!['fetch']).toBe(globalThis.fetch);

    const tool = await viaTool(withoutHouseRuntime());
    expect(tool['fetch']).toBe(globalThis.fetch);
  });
});
