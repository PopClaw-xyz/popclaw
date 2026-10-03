import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { OnboardingStateRepository } from '../../../src/onboarding/state-repository.js';
import { OnboardingStateMachine } from '../../../src/onboarding/state-machine.js';
import { OnboardingOrchestrator, type OnboardingOrchestratorDeps } from '../../../src/onboarding/orchestrator.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { SessionContextIndex } from '../../../src/onboarding/context-index.js';
import { fallbackName } from '../../../src/onboarding/fallback-name.js';
import { persistNickname } from '../../../src/onboarding/identity-writer.js';
import { bumpNamecardDeclaredAt, signMyNamecard } from '../../../src/messaging/my-namecard.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { noDmCrypto } from '../../helpers/test-signer.js';

vi.mock('../../../src/onboarding/identity-writer.js', async (original) => {
  const mod = await original<typeof import('../../../src/onboarding/identity-writer.js')>();
  return { ...mod, persistNickname: vi.fn(mod.persistNickname) };
});
vi.mock('../../../src/messaging/my-namecard.js', async (original) => {
  const mod = await original<typeof import('../../../src/messaging/my-namecard.js')>();
  return { ...mod, bumpNamecardDeclaredAt: vi.fn(mod.bumpNamecardDeclaredAt), signMyNamecard: vi.fn(mod.signMyNamecard) };
});

const PID = '11111111111111111111111111111111';
const CANDIDATES = ['First', 'Second', 'Third'];
const evidence: Record<string, unknown> = {};
const hosts: InMemoryHostAdapter[] = [];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function setup(arrival: Record<string, unknown> = { candidates: CANDIDATES, blind: false }) {
  const host = new InMemoryHostAdapter({ now: new Date(1700000000000) });
  hosts.push(host);
  const repo = new OnboardingStateRepository(host.db, () => 1700000000);
  const sm = new OnboardingStateMachine(repo);
  sm.ensureStarted(PID);
  repo.updateStage(PID, 'arrival', { drafts: { arrival } });
  const trace: unknown[][] = [];
  const record = (kind: string, ...args: unknown[]) => trace.push(clone([kind, ...args]));
  const identity = await vi.importActual<typeof import('../../../src/onboarding/identity-writer.js')>('../../../src/onboarding/identity-writer.js');
  const namecard = await vi.importActual<typeof import('../../../src/messaging/my-namecard.js')>('../../../src/messaging/my-namecard.js');
  vi.mocked(persistNickname).mockImplementation(async (...args) => { record('nickname', args[1], args[2]); await identity.persistNickname(...args); });
  vi.mocked(bumpNamecardDeclaredAt).mockImplementation(async (...args) => { record('declared-at'); return namecard.bumpNamecardDeclaredAt(...args); });
  vi.mocked(signMyNamecard).mockImplementation((...args) => { record('sign-namecard', args[1]); return namecard.signMyNamecard(...args); });
  const save = host.config.saveJson.bind(host.config);
  vi.spyOn(host.config, 'saveJson').mockImplementation(async (name, value) => { record('config', name, value); await save(name, value); });
  const controls = { draftWrites: 0, failWrite: 0 };
  const setDrafts = sm.setDrafts.bind(sm);
  vi.spyOn(sm, 'setDrafts').mockImplementation((id, drafts) => {
    record('draft-write', drafts);
    if (++controls.draftWrites === controls.failWrite) throw new Error(`draft write ${controls.failWrite} failed`);
    setDrafts(id, drafts);
    record('draft-written', sm.drafts(PID));
  });
  const transition = sm.transition.bind(sm);
  vi.spyOn(sm, 'transition').mockImplementation((id, stage, options) => { record('transition', stage, options ?? {}); transition(id, stage, options); });
  const deps: OnboardingOrchestratorDeps = {
    host, stateMachine: sm, identity: { popclawId: PID },
    notifier: { enqueue() { throw new Error('unexpected notification'); }, drain: () => [], count: () => 0 },
    presenter: { async present(card) { record('present', card); } },
    signer: { ...noDmCrypto, publicKey: async () => new Uint8Array(32), sign: async (bytes) => { record('sign', Array.from(bytes)); return new Uint8Array(64); }, popclawId: async () => PID },
    egress: { async push(bytes) { record('push', Array.from(bytes)); return { status: 201, body: new Uint8Array() }; } }, houseOrigins: [],
    llm: null, tasteRoot: '/unused-arrival-taste',
    readOwnerPersona: async () => { record('persona'); return undefined; },
    fetchVerifiedHandles: async () => { record('handles'); return []; },
    guideClient: { async fetchGuideText() { throw new Error('unexpected guide'); } },
    summaryClient: { async fetchSummary() { throw new Error('unexpected summary'); } },
    snapshotClient: { async fetchSnapshot() { throw new Error('unexpected snapshot'); } },
    tasteLoader: { async enabledSources() { throw new Error('unexpected taste'); } },
    learnedWriter: { async appendPick() { throw new Error('unexpected learned write'); } },
    markService: { async mark() { throw new Error('unexpected mark'); } },
    contextIndex: new SessionContextIndex(), webBaseUrl: 'https://web.test', houses: () => [{ slug: 'home', name: 'Home' }],
  };
  let orch = new OnboardingOrchestrator(deps);
  async function capture(label: string, action: 'next' | 'skip' = 'next', answer?: string) {
    let result: unknown;
    try { result = await orch.handleAdvance(action, answer); } catch (error) { result = { error: (error as Error).message }; }
    record('result', label, result, repo.get(PID), await host.config.loadJson('plugin'), orch.hasPendingName());
    return result;
  }
  return { host, sm, repo, trace, controls, record, capture, get orch() { return orch; }, restart() { record('restart'); orch = new OnboardingOrchestrator(deps); } };
}

function expectNoIdentityEffects(trace: unknown[][]) {
  expect(trace.filter(([kind]) => ['nickname', 'declared-at', 'sign-namecard', 'config', 'sign', 'push', 'transition'].includes(kind as string))).toEqual([]);
}

beforeEach(() => { setOwnerLang('en', 'config'); vi.spyOn(Date, 'now').mockReturnValue(1700000000000); });
afterEach(() => { setOwnerLang(undefined); vi.restoreAllMocks(); for (const host of hosts.splice(0)) host.db.close(); });
afterAll(async () => {
  const dir = process.env.ONBOARDING_TRACE_DIR;
  if (dir) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'arrival.json'), JSON.stringify(evidence, null, 2)); }
});

describe('arrival answers through handleAdvance', () => {
  it('persists free text and binds confirmation to that name after a new instance', async () => {
    const h = await setup();
    await h.capture('free-text', 'next', '  my name is Kuroba  ');
    expect(h.sm.drafts(PID)).toEqual({ arrival: { candidates: CANDIDATES, blind: false, pendingName: 'Kuroba' } });
    await h.capture('empty');
    expectNoIdentityEffects(h.trace);
    h.restart();
    await h.capture('confirm', 'next', '1');
    expect(h.sm.current(PID)).toBe('passport');
    expect(h.trace.filter(([kind]) => kind === 'nickname')).toEqual([['nickname', 'Kuroba', 'owner']]);
    expect(h.trace.filter(([kind]) => kind === 'sign')).toHaveLength(2);
    expect(h.trace.filter(([kind]) => kind === 'push')).toHaveLength(1);
    evidence.restartConfirmation = h.trace;
  });

  it('clears old pending before a separate write of its replacement', async () => {
    const h = await setup({ candidates: CANDIDATES, blind: false, pendingName: 'Old' });
    await h.capture('replacement', 'next', 'New');
    expect(h.trace.filter(([kind]) => kind === 'draft-write')).toEqual([
      ['draft-write', { arrival: { candidates: CANDIDATES, blind: false } }],
      ['draft-write', { arrival: { candidates: CANDIDATES, blind: false, pendingName: 'New' } }],
    ]);
    expectNoIdentityEffects(h.trace);
    evidence.replacement = h.trace;
  });

  it.each([1, 2])('stops at pending replacement draft write %i failure', async (failWrite) => {
    const h = await setup({ candidates: CANDIDATES, blind: false, pendingName: 'Old' });
    h.controls.failWrite = failWrite;
    expect(await h.capture('replacement-failure', 'next', 'New')).toEqual({ error: `draft write ${failWrite} failed` });
    expect(h.sm.drafts(PID)).toEqual({ arrival: { candidates: CANDIDATES, blind: false, ...(failWrite === 1 ? { pendingName: 'Old' } : {}) } });
    expect(h.controls.draftWrites).toBe(failWrite);
    expectNoIdentityEffects(h.trace);
    evidence[`replacementFailure${failWrite}`] = h.trace;
  });

  it('voids old pending for out-of-range retry, then adopts a listed candidate', async () => {
    const h = await setup({ candidates: CANDIDATES, blind: false, pendingName: 'Old' });
    await h.capture('out-of-range', 'next', '99');
    expect(h.orch.hasPendingName()).toBe(false);
    expectNoIdentityEffects(h.trace);
    await h.capture('candidate', 'next', 'the second one');
    expect(h.trace.filter(([kind]) => kind === 'nickname')).toEqual([['nickname', 'Second', 'auto']]);
    evidence.retryThenCandidate = h.trace;
  });

  it('clears pending before candidate adoption', async () => {
    const h = await setup({ candidates: CANDIDATES, blind: false, pendingName: 'Old' });
    await h.capture('candidate', 'next', '2');
    expect(h.trace.slice(0, 3).map(([kind]) => kind)).toEqual(['draft-write', 'draft-written', 'nickname']);
    expect(h.trace.filter(([kind]) => kind === 'nickname')).toEqual([['nickname', 'Second', 'auto']]);
    evidence.pendingCandidate = h.trace;
  });

  it('stops before candidate adoption when clearing pending fails', async () => {
    const h = await setup({ candidates: CANDIDATES, blind: false, pendingName: 'Old' });
    h.controls.failWrite = 1;
    expect(await h.capture('clear-failure', 'next', '2')).toEqual({ error: 'draft write 1 failed' });
    expect(h.orch.hasPendingName()).toBe(true);
    expectNoIdentityEffects(h.trace);
    evidence.candidateClearFailure = h.trace;
  });

  it('rejects pending and repeats candidates without generating names again', async () => {
    const h = await setup({ candidates: CANDIDATES, blind: false, pendingName: 'Old' });
    await h.capture('deny', 'next', 'no');
    expect(h.trace.map(([kind]) => kind)).toEqual(['draft-write', 'draft-written', 'present', 'result']);
    expectNoIdentityEffects(h.trace);
    evidence.deny = h.trace;
  });

  it.each(['yes', 'no'])('repeats candidates for %s when nothing is pending', async (answer) => {
    const h = await setup();
    await h.capture(answer, 'next', answer);
    expect(h.trace.map(([kind]) => kind)).toEqual(['present', 'result']);
    expectNoIdentityEffects(h.trace);
    evidence[`bare${answer}`] = h.trace;
  });

  it('honors skip before pending confirmation or invalidation', async () => {
    const h = await setup({ candidates: CANDIDATES, blind: false, pendingName: 'Old' });
    await h.capture('skip', 'skip', '1');
    expect(h.trace[0]).toEqual(['nickname', 'First', 'auto']);
    evidence.skip = h.trace;
  });

  it('offers candidates before interpreting an answer when no list exists', async () => {
    const h = await setup({ candidates: [], blind: false, pendingName: 'Old' });
    await h.capture('offer', 'skip', '1');
    expectNoIdentityEffects(h.trace);
    expect(h.trace.map(([kind]) => kind)).toEqual(['persona', 'handles', 'draft-write', 'draft-written', 'present', 'result']);
    evidence.noCandidates = h.trace;
  });

  it('derives a blind fallback in the current answer language', async () => {
    setOwnerLang(undefined);
    const h = await setup({ candidates: [fallbackName(PID, 'en')], blind: true });
    await h.capture('choose-in-chinese', 'next', '你定');
    expect(h.trace.filter(([kind]) => kind === 'nickname')).toEqual([['nickname', fallbackName(PID, 'zh-CN'), 'auto']]);
    evidence.blindLanguage = h.trace;
  });

  it('routes registered tools through the real persisted confirmation', async () => {
    const h = await setup();
    const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
    const api = { registerTool(tool: { name?: string; execute?: unknown }) { if (tool.name && typeof tool.execute === 'function') tools.push(tool as typeof tools[number]); }, logger: { info: vi.fn() } } as Parameters<typeof registerPopclawTools>[0]['api'];
    registerPopclawTools({ api, runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'], getOrchestrator: async () => h.orch });
    const tool = tools.find((t) => t.name === 'popclaw_onboarding_continue')!;
    h.record('tool-result', await tool.execute('free-text', { answer: 'my name is Kuroba' }));
    expect(h.orch.hasPendingName()).toBe(true);
    expectNoIdentityEffects(h.trace);
    h.restart();
    h.record('tool-result', await tool.execute('confirmation', { answer: 'yes' }));
    expect(h.sm.current(PID)).toBe('passport');
    h.record('state', h.repo.get(PID), await h.host.config.loadJson('plugin'));
    evidence.registeredTool = h.trace;
  });
});
