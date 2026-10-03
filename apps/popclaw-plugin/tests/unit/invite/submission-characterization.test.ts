import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSubcommands, type SubcommandWiring } from '../../../src/commands/wiring.js';
import { registerInviteTools } from '../../../src/tools/invite-tools.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import { _draftsForTest, DRAFT_TTL_MS } from '../../../src/tools/draft-store.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import type { InviteInitiateResult } from '../../../src/invite/invite-initiator.js';
import { watchInvite } from '../../../src/invite/pending-invites.js';
import { runInviteCommand, type InviteCommandDeps } from '../../../src/commands/invite.js';

// Observe the watcher launch without running its timer loop. The ledger and
// receipt still go through the actual slash and tool entry implementations.
vi.mock('../../../src/invite/pending-invites.js', async (original) => ({
  ...await original<typeof import('../../../src/invite/pending-invites.js')>(),
  watchInvite: vi.fn(),
}));

beforeEach(() => {
  setOwnerLang('en', 'config');
  _draftsForTest.clear();
});
afterEach(() => {
  vi.useRealTimers();
  _draftsForTest.clear();
  setOwnerLang('zh-CN', 'config');
});

interface Scenario {
  status?: number;
  detail?: string;
  taskId?: string;
  proof?: string;
  sync?: boolean;
  replace?: boolean;
  nickname?: string;
  error?: 'initiate' | 'pending' | 'watch';
}
const PROOF = 'https://x.com/blackfeather/status/1234567890';
function harness(s: Scenario = {}) {
  const trace: unknown[] = [];
  let nickname = 'Owner at preview';
  const result: InviteInitiateResult = {
    expectedSigil: 'abcdef', pushedEventId: 'event-1',
    push: { status: s.status ?? 200, eventId: 'event-1', deduplicated: false,
      taskId: s.taskId, detail: s.detail },
  };
  const watchDeps = {};
  vi.mocked(watchInvite).mockImplementation(async (deps, taskId) => {
    expect(deps).toBe(watchDeps);
    trace.push(['watch', taskId]);
    if (s.error === 'watch') throw new Error('watch failed');
    // An unresolved watcher proves receipt completion never waits for it.
    return new Promise<void>(() => {});
  });
  const rt = {
    boot: {
      get nickname() { trace.push(['nickname', nickname]); return nickname; },
      webBaseUrl: 'https://popclaw.me/',
    },
    initiator: { async initiate(opts: unknown) {
      trace.push(['initiate', opts]);
      if (s.error === 'initiate') throw new Error('push failed');
      return result;
    } },
    pendingInvites: { add(entry: unknown) {
      trace.push(['pending', entry]);
      if (s.error === 'pending') throw new Error('ledger failed');
    } },
    inviteWatch: watchDeps,
  };
  const runtime = async () => { trace.push('runtime'); return rt; };
  const slash = buildSubcommands({ runtime, warn: (m: string) => trace.push(['warn', m]) } as unknown as SubcommandWiring).invite;
  let execute!: (id: string, params: unknown) => Promise<{ type: string; text: string }>;
  registerInviteTools({ api: {
    registerTool: (tool: unknown) => { execute = (tool as { execute: typeof execute }).execute; },
    logger: { info: (m: string) => trace.push(['info', m]) },
  }, runtime } as unknown as ToolsCtx);
  const params = { platform: 'Twitter', handle: '@blackfeather', proof_url: s.proof,
    sync: s.sync, replace: s.replace, nickname: s.nickname };
  const flags: Record<string, string> = {};
  if (s.proof !== undefined) flags.proof = s.proof;
  if (s.sync !== undefined) flags.sync = String(s.sync);
  if (s.replace) flags.replace = 'true';
  if (s.nickname !== undefined) flags.nickname = s.nickname;
  return { trace, execute, params, changeNickname: () => { nickname = 'Owner at confirm'; },
    slash: (positional = ['Twitter', '@blackfeather'], overrideFlags = flags) =>
      slash({ args: { positional, flags: overrideFlags } } as unknown as Parameters<typeof slash>[0]),
  };
}
function tokenOf(text: string) { return text.match(/invite-\d+/)![0]; }
function stablePreview(text: string) { return text.replace(/invite-\d+/g, 'invite-TOKEN'); }

const scenarios: Array<[string, Scenario]> = [
  ['accepted, sync off', { taskId: 'task-1' }],
  ['accepted proof, sync and replacement', { taskId: 'task-1', proof: PROOF, sync: true, replace: true, nickname: 'Kaito' }],
  ['accepted, explicit sync false', { taskId: 'task-1', sync: false }],
  ['old house without task id', {}],
  ['already verified', { status: 409, detail: 'already verified as @old' }],
  ['rate limited', { status: 429, detail: 'pending invite' }],
  ['watch failure', { taskId: 'task-1', error: 'watch' }],
  ['push throws', { error: 'initiate' }],
  ['ledger throws', { taskId: 'task-1', error: 'pending' }],
];

describe('invite entry behavior before submission extraction', () => {
  for (const [name, scenario] of scenarios) {
    it(`slash: ${name}`, async () => {
      const h = harness(scenario);
      const receipt = await h.slash();
      expect({ receipt, trace: h.trace }).toMatchSnapshot();
    });
    it(`tool: ${name}`, async () => {
      const h = harness(scenario);
      const preview = await h.execute('preview', h.params);
      expect(h.trace).toEqual([]); // no runtime or default-name read at preview
      h.changeNickname();
      const receipt = await h.execute('confirm', { confirm_token: tokenOf(preview.text) });
      expect({ preview: stablePreview(preview.text), receipt, trace: h.trace }).toMatchSnapshot();
    });
  }
  it('preflight outputs and zero runtime on both entries', async () => {
    const h = harness();
    const output = [await h.slash([]), await h.slash(undefined, { proof: '' }),
      await h.execute('missing', { platform: 'x' }),
      await h.execute('bad-proof', { platform: 'x', handle: 'blackfeather', proof_url: '' })];
    expect({ output, trace: h.trace }).toMatchSnapshot();
  });
  it('concurrent confirms consume before awaiting runtime, then refuse reuse', async () => {
    const h = harness({ taskId: 'task-1' });
    const preview = await h.execute('preview', h.params);
    const confirm = { confirm_token: tokenOf(preview.text) };
    const receipts = await Promise.all([h.execute('first', confirm), h.execute('second', confirm)]);
    const reused = await h.execute('third', confirm);
    expect({ receipts: receipts.map(r => stablePreview(r.text)), reused: stablePreview(reused.text), trace: h.trace }).toMatchSnapshot();
  });
  it('expired confirmation does not boot runtime', async () => {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    const h = harness();
    const preview = await h.execute('preview', h.params);
    vi.setSystemTime(1_000 + DRAFT_TTL_MS + 1);
    const receipt = await h.execute('expired', { confirm_token: tokenOf(preview.text) });
    expect({ receipt: stablePreview(receipt.text), trace: h.trace }).toMatchSnapshot();
  });
  it('Chinese receipt still uses the same shared rendering boundary', async () => {
    setOwnerLang('zh-CN', 'config');
    const h = harness({ taskId: 'task-1' });
    expect({ receipt: await h.slash(), trace: h.trace }).toMatchSnapshot();
  });
});

describe('dev CLI retains its separate synchronous profile polling protocol', () => {
  for (const outcome of ['approved', 'timeout', 'rejected', 'proof'] as const) {
    it(outcome, async () => {
      const trace: unknown[] = [];
      let now = 0;
      const result = await runInviteCommand({
        initiator: { initiate: async (opts: unknown) => {
          trace.push(['initiate', opts]);
          return { expectedSigil: 'abcdef', pushedEventId: 'event-1',
            push: { status: outcome === 'rejected' ? 429 : 200, taskId: 'task-1' } };
        } },
        signer: { popclawId: async () => 'OWNER' }, loreHouseUrl: 'https://house.test/',
        fetch: async (url: unknown) => {
          trace.push(['profile-fetch', url]);
          return new Response(JSON.stringify({ profiles: outcome === 'timeout' ? [] : [{ platform: 'x', handle: '@blackfeather' }] }));
        },
        logger: { info: (m: string) => trace.push(['info', m]), warn: (m: string) => trace.push(['warn', m]) },
        now: () => now, sleepMs: async (ms: number) => { trace.push(['sleep', ms]); now += ms; },
      } as unknown as InviteCommandDeps, {
        platform: 'x', handle: '@blackfeather', nickname: 'Owner', mirrorOptin: true,
        proofUrl: outcome === 'proof' ? PROOF : undefined, pollTimeoutSec: 0.01, pollIntervalMs: 10,
      });
      expect({ result, trace }).toMatchSnapshot();
    });
  }
});
