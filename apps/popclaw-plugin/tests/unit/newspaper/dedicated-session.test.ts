/**
 * Dedicated newspaper session (cut 1 of the 2026-09-03 proposal).
 *
 * The paper is heavy material + heavy output, and it used to be produced inside
 * the owner's chat session, on the model the owner picked for chatting. Two
 * machines died of that on 2026-09-02 (151k input on one, reasoning eating 93%
 * of the output budget on the other). The fix: the main session DISPATCHES the
 * whole job into a throwaway child session, waits, and hands back whatever the
 * child published — plus an honest failure receipt when nothing came out
 * (2026-09-03 07:00: a cron run "succeeded" for 167s with zero output and
 * nobody knew; silent non-delivery is the arch-enemy).
 *
 * These tests drive the orchestration with injected fakes only — no host, no
 * filesystem, no clock.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEDICATED_SESSION_MARKER,
  DEFAULT_DISPATCH_INLINE_WAIT_MS,
  DEFAULT_DISPATCH_TIMEOUT_MS,
  MODEL_OVERRIDE_REFUSALS,
  NewspaperDispatchRegistry,
  NewspaperOutcomeStore,
  NewspaperStageStore,
  agentIdOf,
  childSessionKey,
  defaultIssueHint,
  isDedicatedSession,
  isModelOverrideRefusal,
  runDedicatedNewspaper,
  type NewspaperDispatchRecord,
  type SubagentSurface,
} from '../../../src/newspaper/dedicated-session.js';
import { _resetBudgetForTest, noteContextTokenBudget } from '../../../src/newspaper/host-budget.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';

// The receipts render in the owner's language; pin zh so the assertions below
// are byte-stable (same discipline as register-tools.test.ts).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const L = (key: string, vars: Record<string, string> = {}): string =>
  renderCopy('zh-CN', `newspaper.dispatch.${key}`, vars);

/**
 * Cut 2: every owner-facing receipt the dispatch composes now ends with the
 * model honesty clause — the default-model wording here, since these tests
 * dispatch without a profile.
 */
const withModelNote = (text: string): string => `${text}\n${L('modelUsed.default')}`;

/**
 * `waitUntil` (dedicated-session.ts) samples the deadline with one `Date.now()`
 * call and, a moment later — after a synchronous `Math.min`/`Math.max`, nothing
 * that should cost real time — turns it back into a budget with a SECOND,
 * separately-sampled `Date.now()` call. No clock is injected on this path (the
 * module intentionally has none for this calculation), so under a loaded
 * full-suite run the scheduler can land a millisecond or more between those two
 * samples, shaving that much off the observed budget. An exact `.toBe(expected)`
 * flakes on that; this absorbs the jitter while still requiring the budget to
 * land at (or a hair under) the right constant — the constants this is used
 * with are thousands of ms apart, so the tolerance below cannot mask a wrong one.
 */
const expectBudgetMs = (actual: number | undefined, expected: number, toleranceMs = 50): void => {
  expect(actual).toBeLessThanOrEqual(expected);
  expect(actual).toBeGreaterThan(expected - toleranceMs);
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type RunParams = Parameters<SubagentSurface['run']>[0];
type WaitResult = { status: 'ok' | 'error' | 'timeout' | 'pending'; error?: string };

/**
 * A fake subagent surface. waitForRun resolves immediately (the orchestration
 * under test decides what a timeout IS, not how long it takes), and onRun
 * lets a test play the child session: it receives the sessionKey the child
 * runs under, and whatever it leaves in the outcome store is the child's
 * publish result. `waitSteps` replays a sequence (openclaw 8.2 can answer
 * `pending` before the run starts); `runSessionKey` plays 8.2's canonical-key
 * answer from run().
 */
function makeSurface(opts: {
  wait?: WaitResult;
  waitSteps?: WaitResult[];
  runThrows?: Error;
  runSessionKey?: string;
  onRun?: (sessionKey: string) => void;
}) {
  const runs: RunParams[] = [];
  const waits: Array<{ runId: string; timeoutMs?: number }> = [];
  const deleted: string[] = [];
  const steps = [...(opts.waitSteps ?? [])];
  const surface: SubagentSurface = {
    run: async (params) => {
      if (opts.runThrows) throw opts.runThrows;
      runs.push(params);
      opts.onRun?.(params.sessionKey);
      return {
        runId: 'run-1',
        ...(opts.runSessionKey ? { sessionKey: opts.runSessionKey } : {}),
      };
    },
    waitForRun: async (params) => {
      waits.push(params);
      return steps.shift() ?? opts.wait ?? { status: 'ok' };
    },
    deleteSession: async (params) => {
      deleted.push(params.sessionKey);
    },
  };
  return { surface, runs, waits, deleted };
}

function makeDeps(surface: SubagentSurface, overrides: Partial<Parameters<typeof runDedicatedNewspaper>[0]> = {}) {
  const delivered: string[] = [];
  const log = vi.fn();
  const deps = {
    subagent: surface,
    deliverNow: async (text: string) => {
      delivered.push(text);
      return true;
    },
    makeIssueHint: () => 'test-issue',
    // These tests are about the orchestration, not the inline/background split
    // (#575): waiting inline for the whole budget is the behaviour they were
    // written against. The split has its own describe below, which sets a small
    // inline budget on purpose.
    inlineWaitMs: DEFAULT_DISPATCH_TIMEOUT_MS,
    log,
    ...overrides,
  };
  return { deps, delivered, log };
}

// ---------------------------------------------------------------------------

describe('isDedicatedSession', () => {
  it('detects the marker anywhere in the sessionKey', () => {
    expect(isDedicatedSession('popclaw-newspaper:abc')).toBe(true);
    // The host may namespace child keys; the marker is a substring, not a prefix requirement.
    expect(isDedicatedSession(`agent:main:${DEDICATED_SESSION_MARKER}20260903-1`)).toBe(true);
  });

  it('a normal chat session is not one', () => {
    expect(isDedicatedSession('agent:main:telegram:12345')).toBe(false);
    expect(isDedicatedSession('agent:popclaw-recommend')).toBe(false);
  });

  it('no sessionKey at all (plain-object hosts, tests) is not one', () => {
    expect(isDedicatedSession(undefined)).toBe(false);
    expect(isDedicatedSession('')).toBe(false);
  });
});

describe('childSessionKey', () => {
  it('carries the marker and stays unique per issue hint', () => {
    const a = childSessionKey('20260903-0700');
    const b = childSessionKey('20260903-1900');
    expect(a).toContain(DEDICATED_SESSION_MARKER);
    expect(a).not.toBe(b);
    expect(isDedicatedSession(a)).toBe(true);
    expect(isDedicatedSession(b)).toBe(true);
  });

  it('the default hint mints distinct keys call after call', () => {
    const seen = new Set([defaultIssueHint(), defaultIssueHint(), defaultIssueHint(), defaultIssueHint()]);
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('NewspaperOutcomeStore', () => {
  beforeEach(() => NewspaperOutcomeStore.clear());

  it('round-trips a success receipt', () => {
    const key = childSessionKey('x');
    NewspaperOutcomeStore.set(key, { ok: true, receiptText: '导读\n链接' });
    expect(NewspaperOutcomeStore.get(key)).toEqual({ ok: true, receiptText: '导读\n链接' });
  });

  it('round-trips a failure reason', () => {
    const key = childSessionKey('y');
    NewspaperOutcomeStore.set(key, { ok: false, reason: '没写成' });
    expect(NewspaperOutcomeStore.get(key)).toEqual({ ok: false, reason: '没写成' });
  });

  it('clear(key) removes one entry; clear() removes everything', () => {
    const a = childSessionKey('a');
    const b = childSessionKey('b');
    NewspaperOutcomeStore.set(a, { ok: true, receiptText: 't' });
    NewspaperOutcomeStore.set(b, { ok: true, receiptText: 't' });
    NewspaperOutcomeStore.clear(a);
    expect(NewspaperOutcomeStore.get(a)).toBeUndefined();
    expect(NewspaperOutcomeStore.get(b)).toBeDefined();
    NewspaperOutcomeStore.clear();
    expect(NewspaperOutcomeStore.get(b)).toBeUndefined();
  });

  it('survives a plugin reload (process-level, not module-level)', async () => {
    // Same mechanism the draft table needs (2026-07-27): the host re-registers
    // the plugin dozens of times a day and each registration is a fresh module
    // instance. The dispatching session and the publishing child must agree on
    // ONE store or every outcome is orphaned.
    const key = childSessionHint();
    NewspaperOutcomeStore.set(key, { ok: true, receiptText: 'kept' });
    vi.resetModules();
    const fresh = await import('../../../src/newspaper/dedicated-session.js');
    expect(fresh.NewspaperOutcomeStore.get(key)).toEqual({ ok: true, receiptText: 'kept' });
    function childSessionHint(): string {
      return 'reload';
    }
  });
});

// Cut 2 review fix: the host refuses a model override in TWO families. Family
// 1 is the request-scope check; families 2-4 are the FALLBACK path — what
// cron/background wakeups hit (the newspaper's main scheduled route), with
// entirely different wording. Each example below is the host's real message
// shape (prefixes/suffixes and all, as emitted by the 7.1-2/8.2 dists), and
// the matcher must hit every one of them.
describe('isModelOverrideRefusal', () => {
  const REFUSALS = [
    'Error: provider/model override is not authorized for this plugin subagent run.',
    'Error: session agent:main:cron-123 is not trusted for fallback provider/model override requests. See https://docs.openclaw.ai/plugins/sdk-runtime#api-runtime-subagent and search for: plugins.entries.<id>.subagent.allowModelOverride',
    'Error: provider ollama model glm-4.6 is not allowlisted for plugin "popclaw"',
    'Error: this route requires plugin identity in fallback subagent runs.',
  ];

  it('matches every refusal string in the table (both families, both host generations)', () => {
    expect(REFUSALS).toHaveLength(MODEL_OVERRIDE_REFUSALS.length);
    for (const message of REFUSALS) {
      expect(isModelOverrideRefusal(new Error(message))).toBe(true);
    }
  });

  it('does NOT match unrelated dispatch failures — those keep the generic degrade', () => {
    expect(isModelOverrideRefusal(new Error('OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE'))).toBe(false);
    expect(isModelOverrideRefusal(new Error('provider 429'))).toBe(false);
  });
});

describe('runDedicatedNewspaper', () => {
  beforeEach(() => NewspaperOutcomeStore.clear());

  it('success: run → wait → outcome ok → receipt returned, started + receipt delivered, session deleted', async () => {
    const receipt = '今天的导读\n\n全文：\nhttps://canvas/v/1';
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: receipt });
      },
    });
    const { deps, delivered } = makeDeps(fx.surface);
    const text = await runDedicatedNewspaper(deps);

    // Dispatched to a dedicated child session, light context, nothing delivered by the child itself.
    expect(fx.runs).toHaveLength(1);
    expect(fx.runs[0]!.sessionKey).toBe(childSessionKey('test-issue'));
    expect(fx.runs[0]!.lightContext).toBe(true);
    expect(fx.runs[0]!.deliver).toBe(false);
    // Default dispatch: the "today, call with no arguments" directive, verbatim.
    expect(fx.runs[0]!.message).toBe(L('childDirective'));
    expect(fx.runs[0]!.extraSystemPrompt).toContain('popclaw_publish_newspaper');
    // Waited with the default timeout budget.
    expect(fx.waits[0]!.runId).toBe('run-1');
    expectBudgetMs(fx.waits[0]!.timeoutMs, 12 * 60 * 1000);
    // The owner hears "started" first, then the paper itself (cron-wake: the main
    // session's own reply may go nowhere, so the receipt must not live only there).
    // Cut 2: both carry the model clause (default wording — no profile set).
    expect(delivered[0]).toBe(withModelNote(L('started', { minutes: '12' })));
    expect(delivered[1]).toBe(withModelNote(receipt));
    // The tool receipt IS the stored publish receipt (plus the model clause).
    expect(text).toBe(withModelNote(receipt));
    // The child session is torn down no matter what.
    expect(fx.deleted).toEqual([childSessionKey('test-issue')]);
    // The consumed outcome does not linger in the table.
    expect(NewspaperOutcomeStore.get(childSessionKey('test-issue'))).toBeUndefined();
  });

  it('timeout: no outcome → honest failure receipt, delivered, session deleted', async () => {
    const fx = makeSurface({ wait: { status: 'timeout' } });
    const { deps, delivered } = makeDeps(fx.surface);
    const text = await runDedicatedNewspaper(deps);

    const failure = L('failed', { reason: L('reason.timeout', { minutes: '12' }) });
    expect(text).toBe(failure);
    expect(text).toContain('这期没出成');
    expect(delivered[delivered.length - 1]).toBe(failure);
    expect(fx.deleted).toEqual([childSessionKey('test-issue')]);
  });

  it('run errored: the host error is quoted verbatim in the failure receipt', async () => {
    const fx = makeSurface({ wait: { status: 'error', error: 'provider 429' } });
    const { deps, delivered } = makeDeps(fx.surface);
    const text = await runDedicatedNewspaper(deps);

    expect(text).toBe(L('failed', { reason: 'provider 429' }));
    expect(delivered[delivered.length - 1]).toBe(text);
    expect(fx.deleted).toHaveLength(1);
  });

  it('child finished but never published → failure names that, not a bare timeout', async () => {
    const fx = makeSurface({ wait: { status: 'ok' } }); // no outcome written
    const { deps } = makeDeps(fx.surface);
    const text = await runDedicatedNewspaper(deps);
    expect(text).toBe(L('failed', { reason: L('reason.noReceipt') }));
  });

  it('child published nothing but left a failure reason → that reason reaches the owner', async () => {
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: false, reason: '素材没挑成' });
      },
    });
    const { deps } = makeDeps(fx.surface);
    const text = await runDedicatedNewspaper(deps);
    expect(text).toBe(L('failed', { reason: '素材没挑成' }));
  });

  it('deleteSession runs on EVERY path, including when the dispatch itself throws', async () => {
    const fx = makeSurface({ runThrows: new Error('OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE') });
    const { deps } = makeDeps(fx.surface);
    // The throw propagates so the caller can degrade to the in-session flow —
    // but the half-open child session must not be left behind.
    await expect(runDedicatedNewspaper(deps)).rejects.toThrow('OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE');
    expect(fx.deleted).toEqual([childSessionKey('test-issue')]);
  });

  it('a failed delivery never masks the receipt (best-effort channel, honest log)', async () => {
    const receipt = '导读 + 链接';
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: receipt });
      },
    });
    const { deps, log } = makeDeps(fx.surface, {
      deliverNow: async () => {
        throw new Error('no routable target');
      },
    });
    const text = await runDedicatedNewspaper(deps);
    expect(text).toBe(withModelNote(receipt));
    expect(log).toHaveBeenCalled();
  });

  it('no deliverNow at all (no notifier wired) → still dispatches and still returns the receipt', async () => {
    const receipt = 'only the tool sees this';
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: receipt });
      },
    });
    const { deps } = makeDeps(fx.surface, { deliverNow: undefined });
    const text = await runDedicatedNewspaper(deps);
    expect(text).toBe(withModelNote(receipt));
  });

  it('the wait budget is the injected one, not the default', async () => {
    const fx = makeSurface({ wait: { status: 'timeout' } });
    const { deps } = makeDeps(fx.surface, { timeoutMs: 5_000 });
    await runDedicatedNewspaper(deps);
    expectBudgetMs(fx.waits[0]!.timeoutMs, 5_000);
    // And the timeout receipt quotes the budget it actually waited.
  });

  it('a rolling-window dispatch teaches the child to pass hours itself — one self-consistent directive (review round)', async () => {
    // Review 2026-09-03: "produce TODAY's paper, call with NO arguments" plus a
    // trailing "window: the last N hours" line taught the child two different
    // jobs. The window now selects the window directive, verbatim, alone.
    const fx = makeSurface({ wait: { status: 'timeout' } });
    const { deps } = makeDeps(fx.surface, { hours: 48 });
    await runDedicatedNewspaper(deps);
    expect(fx.runs[0]!.message).toBe(L('childDirectiveWindow', { hours: '48' }));
    expect(fx.runs[0]!.message).not.toContain(L('childDirective'));
  });

  // -------------------------------------------------------------------------
  // openclaw 8.2 compatibility (review round 2): `pending` patience and the
  // canonical session key. The repo pins 7.1-2 in node_modules; real machines
  // run 8.2 — both generations must load and both must behave.
  // -------------------------------------------------------------------------

  it('pending → ok: a queued run that finally starts still delivers the paper', async () => {
    const receipt = '排队之后才开工，也照常交货';
    const fx = makeSurface({
      waitSteps: [{ status: 'pending' }, { status: 'ok' }],
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: receipt });
      },
    });
    const { deps } = makeDeps(fx.surface);
    const text = await runDedicatedNewspaper(deps);

    expect(text).toBe(withModelNote(receipt));
    // The wait kept going with the REMAINING budget — the deadline never moved.
    expect(fx.waits.length).toBe(2);
    expect(fx.waits[1]!.timeoutMs).toBeLessThanOrEqual(fx.waits[0]!.timeoutMs!);
    expect(fx.deleted).toEqual([childSessionKey('test-issue')]);
  });

  it('pending at the deadline → an honest queued failure, never "finished with no receipt"', async () => {
    const fx = makeSurface({ wait: { status: 'pending' } }); // queued forever
    const { deps } = makeDeps(fx.surface, { timeoutMs: 100 });
    const text = await runDedicatedNewspaper(deps);

    const failure = L('failed', { reason: L('reason.queued') });
    expect(text).toBe(failure);
    expect(text).toContain('没排上队');
    // And the still-queued session is still torn down — the dispatch is over either way.
    expect(fx.deleted).toEqual([childSessionKey('test-issue')]);
  });

  it('8.2 canonical sessionKey: every subsequent step keys by what run() answered', async () => {
    const receipt = 'the child wrote its outcome under its OWN canonical key';
    const canonical = 'agent:main:popclaw-newspaper:20260903-normalized-by-host';
    const fx = makeSurface({
      runSessionKey: canonical,
      wait: { status: 'ok' },
    });
    // The child's tool context carries the canonical key on 8.2 — so that is
    // the key its publish writes the outcome under, whatever we asked for.
    NewspaperOutcomeStore.set(canonical, { ok: true, receiptText: receipt });
    const { deps } = makeDeps(fx.surface);
    const text = await runDedicatedNewspaper(deps);

    expect(text).toBe(withModelNote(receipt));
    expect(fx.deleted).toEqual([canonical]); // teardown follows the canonical key too
    expect(NewspaperOutcomeStore.get(canonical)).toBeUndefined(); // consumed under that key
    // The constructed key was only ever the REQUEST.
    expect(fx.runs[0]!.sessionKey).toBe(childSessionKey('test-issue'));
  });

  // -------------------------------------------------------------------------
  // Cut 2 (2026-09-03): the workshop's model profile. The model key is sent
  // ONLY when set — the host's override-authorization gate (7.1-2/8.2) trips
  // on presence, not on emptiness — and both owner-facing receipts name the
  // machine that writes the edition (boss ruling: honesty over silence).
  // -------------------------------------------------------------------------

  it('a configured model rides on run() verbatim, and both receipts name it', async () => {
    const receipt = '导读 + 链接';
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: receipt });
      },
    });
    const { deps, delivered } = makeDeps(fx.surface, { model: 'glm-4.6' });
    const text = await runDedicatedNewspaper(deps);

    expect(fx.runs[0]!.model).toBe('glm-4.6');
    const note = L('modelUsed.model', { model: 'glm-4.6' });
    // Started: "will use" — the clause rides from the first push.
    expect(delivered[0]).toBe(`${L('started', { minutes: '12' })}\n${note}`);
    // Success: "used" — appended dispatcher-side (the child cannot know its
    // session's profile), on the channel push and the tool receipt alike.
    expect(delivered[delivered.length - 1]).toBe(`${receipt}\n${note}`);
    expect(text).toBe(`${receipt}\n${note}`);
    expect(text).not.toContain(L('modelUsed.default'));
  });

  it('no model → run() carries NO model key at all, and the receipts say host default', async () => {
    const receipt = '成品回执';
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: receipt });
      },
    });
    const { deps, delivered } = makeDeps(fx.surface);
    const text = await runDedicatedNewspaper(deps);

    // Absent, not empty: an empty-string model would trip the host's
    // authorization gate exactly like a real one (openclaw checks presence).
    expect('model' in fx.runs[0]!).toBe(false);
    expect(text).toBe(`${receipt}\n${L('modelUsed.default')}`);
    expect(delivered[0]).toBe(`${L('started', { minutes: '12' })}\n${L('modelUsed.default')}`);
  });

  it('an empty or whitespace model is unset — same as absent', async () => {
    const receipt = '空模型当未配置';
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: receipt });
      },
    });
    const { deps } = makeDeps(fx.surface, { model: '   ' });
    const text = await runDedicatedNewspaper(deps);
    expect('model' in fx.runs[0]!).toBe(false);
    expect(text).toBe(`${receipt}\n${L('modelUsed.default')}`);
  });

  it('a failure receipt stays the failure receipt — no model clause to misread as a cause', async () => {
    // The refusal the owner can act on (a model the host declined) is named by
    // the TOOL layer's degrade note (see register-tools.test.ts), not by
    // stuffing the model line into an unrelated failure.
    const fx = makeSurface({ wait: { status: 'timeout' } });
    const { deps } = makeDeps(fx.surface, { model: 'glm-4.6' });
    const text = await runDedicatedNewspaper(deps);
    expect(text).toBe(L('failed', { reason: L('reason.timeout', { minutes: '12' }) }));
    expect(text).not.toContain('glm-4.6');
  });

  // -----------------------------------------------------------------------
  // Flash-completion batch mandate (2026-09-03 night ruling): the product
  // MUST complete on deepseek-v4-flash-class models, and model swap is NOT
  // the fix path. On the real machine (host A) that night, the child gathered
  // today's materials fine, then died 3× with "Agent run ended before
  // producing a complete result" — writing a whole ~30-item issue in ONE
  // model output burns the output budget mid-generation (earlier telemetry:
  // 14.5k of 15.7k output tokens was reasoning). The repo already had batch
  // submission (popclaw_publish_newspaper partial edits, the "more to write"
  // receipt); the directive simply never told the child to use it.
  // -----------------------------------------------------------------------

  it('dispatches with the sweep hook before anything else runs (clean slate per workshop)', async () => {
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: '导读' });
      },
    });
    const sweepStaleIssues = vi.fn();
    const { deps } = makeDeps(fx.surface, { sweepStaleIssues });
    await runDedicatedNewspaper(deps);
    expect(sweepStaleIssues).toHaveBeenCalledTimes(1);
  });

  it('a sweep that throws never blocks the dispatch — logged, non-fatal', async () => {
    const receipt = '扫不动存货也照常出报';
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: receipt });
      },
    });
    const sweepStaleIssues = vi.fn(() => {
      throw new Error('manifests dir unreadable');
    });
    const { deps, log } = makeDeps(fx.surface, { sweepStaleIssues });
    const text = await runDedicatedNewspaper(deps);
    expect(sweepStaleIssues).toHaveBeenCalledTimes(1);
    expect(text).toBe(withModelNote(receipt));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sweep'));
  });

  it('no sweep hook wired (old assemblies, test rigs) → dispatch unchanged', async () => {
    const fx = makeSurface({ wait: { status: 'timeout' } });
    const { deps } = makeDeps(fx.surface);
    await expect(runDedicatedNewspaper(deps)).resolves.toContain('这期没出成');
  });
});

// ---------------------------------------------------------------------------
// Flash-completion batch mandate (2026-09-03 night ruling): the child
// directive must ORDER batch-wise submission. The copy below is pinned
// byte-exact in both languages — it is the contract the workshop runs on.
// ---------------------------------------------------------------------------
describe('child directive — batch mandate copy (flash completion)', () => {
  // 2026-09-06 r7: the mandate gained its basis sentence — every edit carries the
  // material page's printed `basis` verbatim (the batch selector the scrubbing
  // host cannot wash). Both languages re-pinned byte-exact below.
  const ZH_DIRECTIVE =
    '出一期今天的报纸。流程：先调 popclaw_newspaper（不带参数）拿候选页；挑好属于主人的条目后，' +
    '带上 picks 再调一次拿素材页。交稿必须分批：第一批 ≤12 条，且必须带上 masthead、edition、weather、' +
    'leads、teaser 等结构字段；每批都用 popclaw_publish_newspaper 提交，回执说还有未写条目就继续下一批' +
    '（每批同样 ≤12 条），直到回执确认整期完成。一次只写一批是硬要求——单次大输出会在轻量模型上中途失败。' +
    '每次交的 edit 还必须把素材页上印的 `basis` 行原样抄进 edit 对象——publish 靠它把你的条目编号绑到你' +
    '真正看过的那页素材上。' +
    '发布回执（导读和链接）就是你的最终答复，原样交回来即可；除它之外，什么都不要另行投递。';
  const ZH_WINDOW =
    '出一期近 48 小时的报纸。流程：先调 popclaw_newspaper（带上参数 hours=48）拿候选页；' +
    '挑好属于主人的条目后，带上 picks 再调一次拿素材页。交稿必须分批：第一批 ≤12 条，且必须带上 masthead、' +
    'edition、weather、leads、teaser 等结构字段；每批都用 popclaw_publish_newspaper 提交，' +
    '回执说还有未写条目就继续下一批（每批同样 ≤12 条），直到回执确认整期完成。' +
    '一次只写一批是硬要求——单次大输出会在轻量模型上中途失败。' +
    '每次交的 edit 还必须把素材页上印的 `basis` 行原样抄进 edit 对象——publish 靠它把你的条目编号绑到你' +
    '真正看过的那页素材上。' +
    '发布回执（导读和链接）就是你的最终答复，原样交回来即可；除它之外，什么都不要另行投递。';
  const EN_TAIL =
    'Handing in the copy must be batch-wise: the first batch is ≤12 items and must carry the structure ' +
    'fields (masthead, edition, weather, leads, teaser); submit every batch with popclaw_publish_newspaper, ' +
    'and while the receipt says items are still unwritten, keep handing in the next batch (each likewise ' +
    '≤12 items), until the receipt confirms the whole issue is done. One batch per output is a hard ' +
    'requirement — a single large output dies mid-way on light models. Every edit you hand in must also ' +
    'carry the `basis` field copied verbatim from the material page — it is how publish binds your item ' +
    'numbers to the exact materials you saw. The publish receipt (teaser and ' +
    'link) is your final answer — hand it back verbatim; deliver nothing else yourself.';

  it('zh: both directives carry the mandate byte-exact', () => {
    expect(L('childDirective')).toBe(ZH_DIRECTIVE);
    expect(L('childDirectiveWindow', { hours: '48' })).toBe(ZH_WINDOW);
  });

  it('en: both directives carry the mandate byte-exact', () => {
    const today = renderCopy('en', 'newspaper.dispatch.childDirective');
    const window = renderCopy('en', 'newspaper.dispatch.childDirectiveWindow', { hours: '48' });
    expect(today).toContain(EN_TAIL);
    expect(window).toContain(EN_TAIL);
    expect(today).toContain("Produce today's paper.");
    expect(window).toContain('Produce the paper for the last 48 hours.');
  });

  it('the batch mandate phrases exist in every variant (≤12 / 分批 / batch)', () => {
    for (const text of [
      L('childDirective'),
      L('childDirectiveWindow', { hours: '24' }),
      renderCopy('en', 'newspaper.dispatch.childDirective'),
      renderCopy('en', 'newspaper.dispatch.childDirectiveWindow', { hours: '24' }),
    ]) {
      expect(text).toContain('≤12');
    }
    // zh says it as 分批, en as batch — each language's own word for the mandate.
    expect(L('childDirective')).toContain('分批');
    expect(L('childDirectiveWindow', { hours: '24' })).toContain('分批');
    expect(renderCopy('en', 'newspaper.dispatch.childDirective')).toContain('batch');
    expect(renderCopy('en', 'newspaper.dispatch.childDirectiveWindow', { hours: '24' })).toContain('batch');
    expect(L('childDirective')).toContain('轻量模型');
  });
});

// ---------------------------------------------------------------------------
// #575 — the host's tool-call timeout is ~60s, the dispatch waits up to 12 min
// ---------------------------------------------------------------------------

/**
 * A claude-cli-backed host, 2026-09-11: one "give me the paper" produced THREE papers.
 * The parent tool call blocked for twelve minutes, the claude-cli host gave up
 * on it at sixty seconds with "The operation timed out", the assistant read
 * that as a failure and asked again — twice — while all three children kept
 * writing and each published minutes later.
 *
 * So the tool call stops being the thing that waits. It waits inline only as
 * long as a host will hold a tool call, then hands the rest to a background
 * wait and returns a receipt that says so. The paper still arrives: the
 * notifier delivers it, which is the same channel the cron path has always
 * used.
 */
describe('runDedicatedNewspaper — inline wait, then background (#575)', () => {
  beforeEach(() => {
    NewspaperOutcomeStore.clear();
    NewspaperDispatchRegistry.clear();
  });

  const RECEIPT = '今天的导读\n\n全文：\nhttps://canvas/v/2';

  it('the inline budget is 40s by default — a host that drops a tool call at 60s must see an answer', async () => {
    expect(DEFAULT_DISPATCH_INLINE_WAIT_MS).toBe(40_000);
    const fx = makeSurface({
      onRun: (sessionKey) => NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: RECEIPT }),
    });
    const { deps } = makeDeps(fx.surface, { inlineWaitMs: undefined });
    await runDedicatedNewspaper(deps);
    // The first wait is bounded by the INLINE budget, not the 12-minute one.
    expectBudgetMs(fx.waits[0]!.timeoutMs, DEFAULT_DISPATCH_INLINE_WAIT_MS);
  });

  it('finishes inside the inline budget → exactly the old behaviour', async () => {
    const fx = makeSurface({
      onRun: (sessionKey) => NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: RECEIPT }),
    });
    const { deps, delivered } = makeDeps(fx.surface, { inlineWaitMs: 10_000 });
    const text = await runDedicatedNewspaper(deps);

    expect(text).toBe(withModelNote(RECEIPT));
    expect(delivered[delivered.length - 1]).toBe(withModelNote(RECEIPT));
    expect(fx.deleted).toEqual([childSessionKey('test-issue')]);
  });

  it('outruns the inline budget → the tool answers "in flight" now and the paper is delivered later', async () => {
    const fx = makeSurface({
      // The host's waitForRun answers `timeout` when ITS budget elapses — the run
      // is still going. That is the whole point: not a failure, just not done.
      waitSteps: [{ status: 'timeout' }, { status: 'ok' }],
      onRun: (sessionKey) => NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: RECEIPT }),
    });
    const { deps, delivered } = makeDeps(fx.surface, { inlineWaitMs: 5 });
    const text = await runDedicatedNewspaper(deps);

    // The tool call comes back inside the inline budget, with the run named.
    expect(text).toBe(L('inFlight', { minutes: '12', run: 'run-1' }));
    expect(text).toContain('run-1');
    // …and the background wait delivers the paper itself, model clause and all.
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(delivered[1]).toBe(withModelNote(RECEIPT));
    // Teardown waits for the background run — deleting the session at the inline
    // deadline would kill the very run that is still writing.
    await vi.waitFor(() => expect(fx.deleted).toEqual([childSessionKey('test-issue')]));
  });

  it('a background run that fails still says so out loud — the failure receipt is pushed', async () => {
    const fx = makeSurface({ waitSteps: [{ status: 'timeout' }, { status: 'error', error: 'provider 429' }] });
    const { deps, delivered } = makeDeps(fx.surface, { inlineWaitMs: 5 });
    const text = await runDedicatedNewspaper(deps);

    expect(text).toBe(L('inFlight', { minutes: '12', run: 'run-1' }));
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(delivered[1]).toBe(L('failed', { reason: 'provider 429' }));
    await vi.waitFor(() => expect(fx.deleted).toHaveLength(1));
  });

  it('no notifier (MCP roots) → the synchronous wait stands: there is no other way to deliver', async () => {
    const fx = makeSurface({
      waitSteps: [{ status: 'timeout' }, { status: 'ok' }],
      onRun: (sessionKey) => NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: RECEIPT }),
    });
    const { deps, log } = makeDeps(fx.surface, { inlineWaitMs: 5, deliverNow: undefined });
    const text = await runDedicatedNewspaper(deps);

    expect(text).toBe(withModelNote(RECEIPT)); // the receipt itself, not "in flight"
    expect(fx.deleted).toEqual([childSessionKey('test-issue')]);
    // The one thing that must not be silent: we knowingly held the call past the
    // budget a host is expected to allow.
    expect(log.mock.calls.flat().join(' ')).toContain('no notifier');
  });

  /**
   * The retry is what turned one dispatch into three. While a workshop is in
   * flight for this parent, asking again is answered, not obeyed.
   */
  it('a second bare call from the same parent is answered, not dispatched again', async () => {
    const fx = makeSurface({
      waitSteps: [{ status: 'timeout' }, { status: 'ok' }],
      onRun: (sessionKey) => NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: RECEIPT }),
    });
    const { deps, delivered } = makeDeps(fx.surface, {
      inlineWaitMs: 5,
      parentSessionKey: 'agent:main:telegram:12345',
    });
    const first = await runDedicatedNewspaper(deps);
    const second = await runDedicatedNewspaper(deps);

    expect(first).toBe(L('inFlight', { minutes: '12', run: 'run-1' }));
    expect(second).toBe(first); // same answer, naming the run already under way
    expect(fx.runs).toHaveLength(1); // and NO second workshop
    expect(fx.deleted).toHaveLength(0); // the guard must not tear the live child down

    // Once the background settles, the next request dispatches normally again.
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    await vi.waitFor(() => expect(NewspaperDispatchRegistry.inFlight('agent:main:telegram:12345')).toBeUndefined());
    const third = await runDedicatedNewspaper({ ...deps, inlineWaitMs: 10_000 });
    expect(fx.runs).toHaveLength(2);
    expect(third).toBe(withModelNote(RECEIPT));
  });

  it('a dispatch that never started leaves no guard behind', async () => {
    const fx = makeSurface({ runThrows: new Error('OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE') });
    const { deps } = makeDeps(fx.surface, { parentSessionKey: 'agent:main:telegram:1' });
    await expect(runDedicatedNewspaper(deps)).rejects.toThrow();
    expect(NewspaperDispatchRegistry.inFlight('agent:main:telegram:1')).toBeUndefined();
  });

  /**
   * The serial retry above is not the only way one request becomes two papers.
   * Two calls can arrive for the same parent BEFORE either workshop has started:
   * the guard reads an empty table, `run()` is the first await that yields, and
   * the registration was only written after it came back — so both calls passed
   * the guard and both started a workshop. The owner asked once and gets two
   * editions, exactly what the guard exists to prevent.
   */
  it('two calls that arrive together start ONE workshop — the slot is claimed before run() can yield', async () => {
    const parent = 'agent:main:telegram:77';
    // run() never settles on its own: both calls are inside the dispatch, past
    // the guard, with no workshop yet confirmed — the exact window of the race.
    const starts: Array<(v: { runId: string }) => void> = [];
    const surface: SubagentSurface = {
      run: () => new Promise((resolve) => starts.push(resolve)),
      waitForRun: async () => ({ status: 'ok' }),
      deleteSession: async () => {},
    };
    const { deps } = makeDeps(surface, { parentSessionKey: parent, inlineWaitMs: 10_000 });

    const first = runDedicatedNewspaper(deps);
    const second = runDedicatedNewspaper(deps);
    // Both calls have now run as far as they can without a workshop answering.
    await new Promise((resolve) => setImmediate(resolve));

    expect(starts).toHaveLength(1); // ONE workshop, not two
    expect(await second).toBe(L('inFlight', { minutes: '12', run: 'test-issue' }));

    starts[0]!({ runId: 'run-1' });
    await first;
  });

  /**
   * The other half of the same race: `settle` used to delete whatever entry the
   * parent had, so the first run to finish freed a registration that belonged to
   * a second, still-live one — and the next request dispatched again.
   */
  it('settling one dispatch leaves a second, still-live registration alone', () => {
    const parent = 'agent:main:telegram:78';
    const now = Date.now();
    NewspaperDispatchRegistry.start(parent, { runId: 'run-1', startedAt: now, ttlMs: 60_000, dispatchId: 'd1' });
    NewspaperDispatchRegistry.start(parent, { runId: 'run-2', startedAt: now, ttlMs: 60_000, dispatchId: 'd2' });

    NewspaperDispatchRegistry.settle(parent, 'd1'); // the first run finishes late
    expect(NewspaperDispatchRegistry.inFlight(parent)?.runId).toBe('run-2');

    NewspaperDispatchRegistry.settle(parent, 'd2'); // its owner may still clear it
    expect(NewspaperDispatchRegistry.inFlight(parent)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-agent hosts: the child key needs an owner (owner gateway, 2026-09-11/12)
// ---------------------------------------------------------------------------

/**
 * openclaw 2026.8.2 refuses a session key it cannot attribute:
 * `AgentSelectionRequiredError: Multiple agents are configured, but session key
 * "popclaw-newspaper:…" has no explicit owner`. Five occurrences in one night,
 * and every one of them degraded to the in-session flow — which is also why
 * `newspaper.model` silently never applied on that machine.
 */
describe('the child session belongs to an agent', () => {
  beforeEach(() => {
    NewspaperOutcomeStore.clear();
    NewspaperDispatchRegistry.clear();
  });

  it('agentIdOf reads the owner out of a parent key, and falls back to main', () => {
    expect(agentIdOf('agent:main:cron:popclaw-newspaper-0700')).toBe('main');
    expect(agentIdOf('agent:writer:telegram:12345')).toBe('writer');
    expect(agentIdOf('telegram:12345')).toBe('main'); // no prefix at all
    expect(agentIdOf(undefined)).toBe('main');
    expect(agentIdOf('')).toBe('main');
  });

  it('the child key carries an explicit owner and still reads as a workshop', () => {
    expect(childSessionKey('h')).toBe(`agent:main:${DEDICATED_SESSION_MARKER}h`);
    expect(childSessionKey('h', 'writer')).toBe(`agent:writer:${DEDICATED_SESSION_MARKER}h`);
    expect(isDedicatedSession(childSessionKey('h', 'writer'))).toBe(true);
  });

  it('the dispatch runs the child under the PARENT agent, not under nobody', async () => {
    const fx = makeSurface({ wait: { status: 'ok' } });
    const { deps } = makeDeps(fx.surface, { parentSessionKey: 'agent:writer:telegram:12345' });
    await runDedicatedNewspaper(deps);
    expect(fx.runs[0]!.sessionKey).toBe(`agent:writer:${DEDICATED_SESSION_MARKER}test-issue`);
  });

  it('a parent key with no agent prefix still names an owner (main)', async () => {
    const fx = makeSurface({ wait: { status: 'ok' } });
    const { deps } = makeDeps(fx.surface, { parentSessionKey: 'telegram:12345' });
    await runDedicatedNewspaper(deps);
    expect(fx.runs[0]!.sessionKey).toBe(`agent:main:${DEDICATED_SESSION_MARKER}test-issue`);
  });
});

// ---------------------------------------------------------------------------
// The durable dispatch ledger (2026-09-13)
// ---------------------------------------------------------------------------

/**
 * A failed run used to leave one line in a container log that dies with the container, so
 * the failure rate was unmeasurable. Every outcome is now recorded — the published ones
 * included, or there is no denominator — and the recording can never cost the owner a paper.
 */
describe('the dispatch ledger', () => {
  beforeEach(() => {
    NewspaperOutcomeStore.clear();
    NewspaperDispatchRegistry.clear();
    NewspaperStageStore.clear();
    _resetBudgetForTest();
  });

  const recording = (): { records: NewspaperDispatchRecord[]; recordDispatch: (r: NewspaperDispatchRecord) => void } => {
    const records: NewspaperDispatchRecord[] = [];
    return { records, recordDispatch: (r) => records.push(r) };
  };

  it('a published run is recorded — that is the denominator', async () => {
    const fx = makeSurface({
      onRun: (sessionKey) => NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: '导读' }),
    });
    const { records, recordDispatch } = recording();
    const { deps } = makeDeps(fx.surface, { recordDispatch });
    await runDedicatedNewspaper(deps);

    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe('published');
    expect(records[0]!.sessionKey).toBe(childSessionKey('test-issue'));
    expect(records[0]!.runId).toBe('run-1');
    expect(Number.isNaN(Date.parse(records[0]!.at))).toBe(false);
    expect(records[0]!.reason).toBeUndefined();
  });

  it('a run that ends with no receipt is recorded with the reason the owner was given', async () => {
    const fx = makeSurface({ wait: { status: 'ok' } }); // finished, published nothing
    const { records, recordDispatch } = recording();
    const { deps } = makeDeps(fx.surface, { recordDispatch });
    await runDedicatedNewspaper(deps);

    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe('no-receipt');
    expect(records[0]!.reason).toBe(L('reason.noReceipt'));
  });

  it('the three failure shapes are told apart: refused, error, no-receipt', async () => {
    const refused = recording();
    await runDedicatedNewspaper(
      makeDeps(
        makeSurface({
          onRun: (sessionKey) => NewspaperOutcomeStore.set(sessionKey, { ok: false, reason: '素材没挑成' }),
        }).surface,
        { recordDispatch: refused.recordDispatch },
      ).deps,
    );
    expect(refused.records[0]!.outcome).toBe('refused');
    expect(refused.records[0]!.reason).toBe('素材没挑成');

    const errored = recording();
    await runDedicatedNewspaper(
      makeDeps(makeSurface({ wait: { status: 'error', error: 'provider 429' } }).surface, {
        recordDispatch: errored.recordDispatch,
      }).deps,
    );
    expect(errored.records[0]!.outcome).toBe('error');
    expect(errored.records[0]!.reason).toBe('provider 429');

    const timedOut = recording();
    await runDedicatedNewspaper(
      makeDeps(makeSurface({ wait: { status: 'timeout' } }).surface, { recordDispatch: timedOut.recordDispatch }).deps,
    );
    expect(timedOut.records[0]!.outcome).toBe('no-receipt');
  });

  it('carries the budget facts for the CHILD key — which is the measurement itself', async () => {
    // The chat session synced; the workshop never did. That is exactly the 2026-09-13
    // shape, and the record has to be able to say so.
    noteContextTokenBudget('agent:main:telegram:12345', 256_000);
    noteContextTokenBudget(undefined, 256_000);
    const { records, recordDispatch } = recording();
    const { deps } = makeDeps(makeSurface({ wait: { status: 'ok' } }).surface, { recordDispatch });
    await runDedicatedNewspaper(deps);
    expect(records[0]!.budget?.source).toBe('default-bucket');

    // …and when the workshop DOES report, the record says `own` instead.
    _resetBudgetForTest();
    noteContextTokenBudget(childSessionKey('test-issue'), 32_000);
    const own = recording();
    await runDedicatedNewspaper(
      makeDeps(makeSurface({ wait: { status: 'ok' } }).surface, { recordDispatch: own.recordDispatch }).deps,
    );
    expect(own.records[0]!.budget?.source).toBe('own');
    expect(own.records[0]!.budget?.tokens).toBe(32_000);
  });

  it('a ledger write that throws never reaches the owner — the receipt still comes back', async () => {
    const fx = makeSurface({
      onRun: (sessionKey) => NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: '导读' }),
    });
    const { deps, log } = makeDeps(fx.surface, {
      recordDispatch: () => {
        throw new Error('EROFS: read-only file system');
      },
    });
    const text = await runDedicatedNewspaper(deps);
    expect(text).toBe(withModelNote('导读'));
    expect(log.mock.calls.flat().join('\n')).toContain('dispatch record failed (non-fatal)');
  });

  it('an assembly with no ledger dispatches exactly as before', async () => {
    const fx = makeSurface({ wait: { status: 'ok' } });
    const { deps } = makeDeps(fx.surface); // no recordDispatch at all
    await expect(runDedicatedNewspaper(deps)).resolves.toContain('这期没出成');
  });

  /**
   * Where a failed run STOPPED (2026-09-13). The record could say a run produced no
   * receipt; it could not say whether the writer ever saw a material page, or ever
   * reached publish — and those are entirely different failures.
   *
   * The flags come from the plugin's own tool entry points, never from the child's
   * account of itself: the run this was built for reported that the host had truncated
   * its pages, and measurement afterwards said nothing had been. `reason` still means
   * exactly what it meant — the sentence the owner's receipt carries.
   */
  it('records how far the run got: both pages served, publish never called', async () => {
    const child = childSessionKey('test-issue');
    const fx = makeSurface({
      onRun: (sessionKey) => {
        // What the tool entry points would have noted, in the order they run.
        NewspaperStageStore.note(sessionKey, 'candidatePage');
        NewspaperStageStore.note(sessionKey, 'materialPage');
      },
    });
    const { records, recordDispatch } = recording();
    await runDedicatedNewspaper(makeDeps(fx.surface, { recordDispatch }).deps);

    expect(records[0]!.outcome).toBe('no-receipt');
    expect(records[0]!.stage).toEqual({
      candidatePage: true,
      materialPage: true,
      publishCalled: false,
      publishAccepted: false,
    });
    // Consumed with the line it belongs to — the next dispatch starts from nothing.
    expect(NewspaperStageStore.take(child)).toBeUndefined();
  });

  it('tells a refused hand-in from an accepted one — publish called is not publish accepted', async () => {
    const fx = makeSurface({
      onRun: (sessionKey) => {
        NewspaperStageStore.note(sessionKey, 'candidatePage');
        NewspaperStageStore.note(sessionKey, 'materialPage');
        NewspaperStageStore.note(sessionKey, 'publishCalled');
        NewspaperOutcomeStore.set(sessionKey, { ok: false, reason: '每一条的 q 都没锚住' });
      },
    });
    const { records, recordDispatch } = recording();
    await runDedicatedNewspaper(makeDeps(fx.surface, { recordDispatch }).deps);

    expect(records[0]!.outcome).toBe('refused');
    expect(records[0]!.stage?.publishCalled).toBe(true);
    expect(records[0]!.stage?.publishAccepted).toBe(false);
    // The reason is still the receipt's own sentence — never a stage, never the child's
    // diagnosis of why it failed.
    expect(records[0]!.reason).toBe('每一条的 q 都没锚住');
  });

  it('a run that never reached a popclaw tool carries no stage at all — absent, not guessed', async () => {
    const { records, recordDispatch } = recording();
    await runDedicatedNewspaper(
      makeDeps(makeSurface({ wait: { status: 'error', error: 'provider 429' } }).surface, { recordDispatch }).deps,
    );
    expect(records[0]!.outcome).toBe('error');
    expect(records[0]!.stage).toBeUndefined();
  });

  it('the stage table only ever holds workshop sessions', () => {
    NewspaperStageStore.note('agent:main:telegram:12345', 'candidatePage');
    expect(NewspaperStageStore.take('agent:main:telegram:12345')).toBeUndefined();
    const child = childSessionKey('stage-scope');
    NewspaperStageStore.note(child, 'candidatePage');
    expect(NewspaperStageStore.take(child)?.candidatePage).toBe(true);
  });
});
