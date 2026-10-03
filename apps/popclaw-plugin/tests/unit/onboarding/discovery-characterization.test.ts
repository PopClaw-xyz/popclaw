import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { OnboardingStateRepository } from '../../../src/onboarding/state-repository.js';
import { OnboardingStateMachine } from '../../../src/onboarding/state-machine.js';
import { OnboardingOrchestrator, type OnboardingOrchestratorDeps, type MountedHouse } from '../../../src/onboarding/orchestrator.js';
import { SessionContextIndex } from '../../../src/onboarding/context-index.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import type { WorldSummaryResponse } from '../../../src/world/world-summary-client.js';
import { appendCorePrivate } from '../../../src/taste/taste-writer.js';
import { noDmCrypto } from '../../helpers/test-signer.js';

vi.mock('../../../src/taste/taste-writer.js', async (original) => {
  const mod = await original<typeof import('../../../src/taste/taste-writer.js')>();
  return { ...mod, appendCorePrivate: vi.fn(mod.appendCorePrivate) };
});

const PID = '11111111111111111111111111111111';
const evidence: Record<string, unknown> = {};
const roots: string[] = [];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'discovery-characterization-'));
  roots.push(root);
  const host = new InMemoryHostAdapter({ now: new Date(1700000000000) });
  const repo = new OnboardingStateRepository(host.db, () => 1700000000);
  const sm = new OnboardingStateMachine(repo);
  sm.ensureStarted(PID);
  repo.updateStage(PID, 'lantern', { drafts: {} });
  const trace: unknown[][] = [];
  const record = (kind: string, ...args: unknown[]) => trace.push(clone([kind, ...args]));
  const tasteWriter = await vi.importActual<typeof import('../../../src/taste/taste-writer.js')>(
    '../../../src/taste/taste-writer.js',
  );
  vi.mocked(appendCorePrivate).mockImplementation(async (options, text) => {
    record('taste-write', text);
    await tasteWriter.appendCorePrivate(options, text);
    record('taste-written');
  });
  const summary: WorldSummaryResponse = {
    window_hours: 24, generated_at_ms: 1700000000000, total_posts: 10, distinct_authors: 6,
    authors: { a: { nickname: 'Alice' }, b: { nickname: 'Bob' } },
    hot_posts: Array.from({ length: 10 }, (_, i) => ({
      event_id: `event-${i}`, author: i % 2 ? 'b' : 'a', platform: 'popclaw',
      body_preview: `Post ${i} ${'long preview '.repeat(15)}`, reply_count: i,
      quote_count: 0, created_at_ms: 1700000000000 - i,
    })),
  };
  const controls = {
    summary: summary as WorldSummaryResponse | null, rejectSummary: false,
    rejectSources: false, rejectGuide: false, rejectSnapshot: false,
    rejectLearned: false, rejectMark: false, pushed: true, rejectCanvas: false,
    rejectPresenter: false, rejectHouses: false, rejectRank: false,
    sources: [] as Array<{ path: string; content: string }>,
    houses: [{ slug: 'home', name: 'Home' }] as MountedHouse[],
    rank: '{"order":[3,1,2]}',
  };
  const index = new SessionContextIndex();
  const register = index.register.bind(index);
  vi.spyOn(index, 'register').mockImplementation((items) => { record('index', items); register(items); });
  const setDrafts = sm.setDrafts.bind(sm);
  vi.spyOn(sm, 'setDrafts').mockImplementation((id, drafts) => { record('drafts', drafts); setDrafts(id, drafts); });
  const transition = sm.transition.bind(sm);
  vi.spyOn(sm, 'transition').mockImplementation((id, stage, options) => { record('transition', stage, options ?? {}); transition(id, stage, options); });
  const deps: OnboardingOrchestratorDeps = {
    host, stateMachine: sm, identity: { popclawId: PID },
    notifier: { enqueue() { throw new Error('unexpected notification'); }, drain: () => [], count: () => 0 },
    presenter: { async present(card) { record('present', card); if (controls.rejectPresenter) throw new Error('present failed'); } },
    signer: { ...noDmCrypto, publicKey: async () => new Uint8Array(32), sign: async () => new Uint8Array(64), popclawId: async () => PID },
    egress: { async push() { throw new Error('unexpected push'); } }, houseOrigins: [],
    llm: { async complete(prompt) { record('rank', prompt); if (controls.rejectRank) throw new Error('rank failed'); return controls.rank; } },
    tasteRoot: root, readOwnerPersona: async () => undefined, fetchVerifiedHandles: async () => [],
    guideClient: { async fetchGuideText() { record('guide'); if (controls.rejectGuide) throw new Error('guide failed'); return '# Guide\n\nLive guide paragraph'; } },
    summaryClient: { async fetchSummary(hours) { record('summary', hours); if (controls.rejectSummary) throw new Error('summary failed'); return controls.summary; } },
    snapshotClient: { async fetchSnapshot(query) { record('snapshot', query); if (controls.rejectSnapshot) throw new Error('snapshot failed'); return []; } },
    tasteLoader: { async enabledSources() { record('sources'); if (controls.rejectSources) throw new Error('sources failed'); return controls.sources; } },
    learnedWriter: { async appendPick(pick) { record('learned', pick); if (controls.rejectLearned) throw new Error('learned failed'); } },
    markService: { async mark(item) { record('mark', item); if (controls.rejectMark) throw new Error('mark failed'); return { pushed: controls.pushed }; } },
    contextIndex: index, webBaseUrl: 'https://web.test',
    houses: () => { record('houses'); if (controls.rejectHouses) throw new Error('houses failed'); return controls.houses; },
    canvas: {
      uploadCanvas: async (request) => { record('canvas', { title: request.title, html: request.html, ttlHours: request.ttlHours }); if (controls.rejectCanvas) throw new Error('canvas failed'); return { url: 'https://canvas.test/p/glimpse' }; },
      canvasBaseUrl: 'https://canvas.test',
      signer: { ...noDmCrypto, publicKey: async () => new Uint8Array(32), sign: async () => new Uint8Array(64), popclawId: async () => PID },
      nickname: 'Owner',
    },
  };
  const orch = new OnboardingOrchestrator(deps);
  async function capture(label: string, run: () => Promise<unknown>) {
    let result: unknown;
    try { result = await run(); } catch (error) { result = { error: (error as Error).message }; }
    record('result', label, result, repo.get(PID), index.lastBatch());
    return result;
  }
  return { orch, deps, sm, repo, index, controls, trace, root, capture, record };
}

beforeEach(() => {
  setOwnerLang('en', 'config');
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  vi.mocked(appendCorePrivate).mockClear();
});
afterEach(async () => { setOwnerLang(undefined); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
afterAll(async () => {
  // Optional fixed-base/head replay evidence: full cards, HTML, drafts and ordered effects.
  const dir = process.env.ONBOARDING_TRACE_DIR;
  if (dir) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'discovery.json'), JSON.stringify(evidence, null, 2)); }
});

describe('discovery behavior at the orchestrator interface', () => {
  it('preserves full material, feedback effects, persisted batch, rerank and read-only replay', async () => {
    const h = await setup();
    await h.capture('lantern', () => h.orch.handleStartCommand());
    expect(h.trace.map((e) => e[0])).toEqual(['guide', 'summary', 'snapshot', 'sources', 'index', 'houses', 'houses', 'canvas', 'drafts', 'present', 'result']);
    const draft = h.sm.drafts(PID);
    expect((draft.lantern as { entries: unknown[] }).entries).toHaveLength(8);
    await h.capture('expand', () => h.orch.handleAdvance('next', '2'));
    await h.capture('mark', () => h.orch.handleAdvance('next', 'mark 2'));
    h.controls.pushed = false;
    await h.capture('mark-local', () => h.orch.handleAdvance('next', 'mark 1'));
    await h.capture('meh', () => h.orch.handleAdvance('next', 'meh 3'));
    await h.capture('invalid', () => h.orch.handleAdvance('next', '99'));
    await h.capture('attune', () => h.orch.handleAdvance('next'));
    expect(h.sm.drafts(PID).attune).toEqual(draft.lantern);
    const before = h.trace.length;
    const rerank = await h.capture('taste', () => h.orch.handleAdvance('next', 'I enjoy software'));
    expect(h.trace.slice(before).map((e) => e[0])).toEqual(['taste-write', 'taste-written', 'rank', 'index', 'present', 'transition', 'houses', 'present', 'result']);
    expect(h.index.byOrdinal(1)?.eventId).toBe('event-2');
    expect(h.sm.current(PID)).toBe('errand');
    expect(rerank).toHaveProperty('text');
    h.record('taste-file', await readFile(join(h.root, 'core/private.md'), 'utf8'));
    h.record('manifest', JSON.parse(await readFile(join(h.root, 'manifest.json'), 'utf8')));
    evidence.normal = h.trace;
  });

  it('hands the persisted batch to attune synchronously before another answer arrives', async () => {
    const h = await setup();
    await h.orch.handleStartCommand();
    const first = h.capture('enter-attune', () => h.orch.handleAdvance('next'));
    expect(h.sm.current(PID)).toBe('attune');
    const second = h.capture('empty-attune', () => h.orch.handleAdvance('next'));
    await Promise.all([first, second]);
    expect(h.sm.current(PID)).toBe('errand');
    evidence.synchronousHandoff = h.trace;
  });

  it('retries summary failure without replacing the old presentation cache, and cascades skip', async () => {
    const h = await setup();
    await h.capture('initial', () => h.orch.handleStartCommand());
    const old = await h.orch.currentCardText();
    h.controls.rejectSummary = true;
    await h.capture('failed-refresh', () => h.orch.handleStartCommand());
    expect(h.sm.drafts(PID)).toEqual({ lantern: 'degraded' });
    expect(await h.orch.currentCardText()).toBe(old);
    h.controls.rejectSummary = false;
    await h.capture('retry', () => h.orch.handleAdvance('next', 'mark 1'));
    expect(h.trace.filter((e) => e[0] === 'mark')).toHaveLength(0);
    await h.capture('skip', () => h.orch.handleAdvance('skip'));
    expect(h.sm.current(PID)).toBe('errand');
    await h.orch.handleAdvance('skip');
    await h.capture('graduation', () => h.orch.handleAdvance('skip'));
    evidence.retrySkip = h.trace;
  });

  it('keeps feedback available when learned writes fail and reports mark failures honestly', async () => {
    const h = await setup();
    await h.orch.handleStartCommand();
    h.controls.rejectLearned = h.controls.rejectMark = true;
    h.trace.length = 0;
    await h.capture('expand-failed-learned', () => h.orch.handleAdvance('next', '1'));
    await h.capture('meh-failed-learned', () => h.orch.handleAdvance('next', 'meh 1'));
    await h.capture('mark-failed', () => h.orch.handleAdvance('next', 'mark 1'));
    expect(h.sm.current(PID)).toBe('lantern');
    expect(h.trace.map((e) => e[0])).toEqual(['learned', 'present', 'result', 'learned', 'result', 'mark', 'result']);
    evidence.feedbackFailure = h.trace;
  });

  it('stops before ranking and transition if the sovereign taste write fails', async () => {
    const h = await setup();
    await h.orch.handleStartCommand();
    await h.orch.handleAdvance('next');
    await writeFile(join(h.root, 'core'), 'blocks directory creation');
    h.trace.length = 0;
    await expect(h.orch.handleAdvance('next', 'I enjoy software')).rejects.toThrow();
    expect(h.trace).toEqual([['taste-write', 'I enjoy software']]);
    expect(h.sm.current(PID)).toBe('attune');
    h.record('state', h.repo.get(PID), await h.orch.currentCardText());
    evidence.tasteFailure = h.trace;
  });

  it('commits lantern drafts/cache before presentation, and rerank index/cache before transition', async () => {
    const h = await setup();
    h.controls.rejectPresenter = true;
    await h.capture('lantern-present-failed', () => h.orch.handleStartCommand());
    expect(h.sm.drafts(PID).lantern).toHaveProperty('entries');
    const text = await h.orch.currentCardText();
    expect(text).toContain('Post 0');
    h.controls.rejectPresenter = false;
    await h.orch.handleAdvance('next');
    h.controls.rejectPresenter = true;
    await h.capture('attune-present-failed', () => h.orch.handleAdvance('next', 'I enjoy software'));
    expect(h.sm.current(PID)).toBe('attune');
    expect(h.index.byOrdinal(1)?.eventId).toBe('event-2');
    const count = h.trace.length;
    h.record('readonly', await h.orch.currentCardText());
    expect(h.trace.length).toBe(count + 1);
    evidence.presenterFailure = h.trace;
  });

  it('keeps presentation cache within the instance through stop/start and reads answers from persisted drafts', async () => {
    const h = await setup();
    await h.orch.handleStartCommand();
    const text = await h.orch.currentCardText();
    h.trace.length = 0;
    await h.orch.start(); await h.orch.stop(); await h.orch.start();
    expect(await h.orch.currentCardText()).toBe(text);
    const other = new OnboardingOrchestrator(h.deps);
    expect(await other.currentCardText()).not.toBe(text);
    expect(h.trace).toEqual([]);
    const drafts = h.sm.drafts(PID) as { lantern: { entries: Array<{ bodyPreview: string }> } };
    drafts.lantern.entries[0]!.bodyPreview = 'Persisted replacement';
    h.sm.setDrafts(PID, drafts);
    await h.capture('expand-new-instance', () => other.handleAdvance('next', '1'));
    expect(h.trace.find((e) => e[0] === 'present')).toBeDefined();
    h.record('readonly-original', await h.orch.currentCardText());
    evidence.isolation = h.trace;
  });

  it('retains duplicate-event last-entry lookup during reranking', async () => {
    const h = await setup();
    h.controls.summary!.hot_posts[2] = { ...h.controls.summary!.hot_posts[2]!, event_id: 'event-0' };
    await h.orch.handleStartCommand();
    await h.orch.handleAdvance('next');
    await h.capture('duplicates', () => h.orch.handleAdvance('next', 'I enjoy software'));
    expect(h.index.lastBatch().slice(0, 2).map((item) => item.summaryLine)).toEqual([
      expect.stringContaining('Post 2'), expect.stringContaining('Post 2'),
    ]);
    evidence.duplicates = h.trace;
  });

  it('reads replacement stamps after real passport reissues on the same orchestrator', async () => {
    const h = await setup();
    h.controls.houses = [{ slug: 'home', name: 'Home' }, { slug: 'other', name: 'Other' }];
    await h.deps.host.config.saveJson('plugin', { ranger_profile: { nickname: 'Owner' } });
    let otherAccepted = false;
    h.deps.egress.broadcastEach = async () => {
      h.record('passport-push', otherAccepted);
      return [
        { slug: 'home', result: { status: 201 } },
        { slug: 'other', result: { status: otherAccepted ? 201 : 503 } },
      ];
    };
    await h.capture('first-passport', () => h.orch.handleAdvance('next', 'reissue passport'));
    const first = await h.orch.handleStartCommand();
    expect(first.text).toContain('Home (has your namecard ✓)');
    expect(first.text).not.toContain('Other (has your namecard ✓)');
    otherAccepted = true;
    await h.capture('accepted-reissue', () => h.orch.handleAdvance('next', 'reissue passport'));
    const second = await h.capture('after-reissue', () => h.orch.handleStartCommand());
    expect(second).toHaveProperty('text', expect.stringContaining('Other (has your namecard ✓)'));

    // A refresh already fetching material must also observe the newly replaced
    // stamp map when it eventually builds house lines.
    let release!: () => void;
    const pendingSummary = new Promise<void>((resolve) => { release = resolve; });
    const fetchSummary = h.deps.summaryClient.fetchSummary.bind(h.deps.summaryClient);
    vi.spyOn(h.deps.summaryClient, 'fetchSummary').mockImplementation(async (hours) => {
      await pendingSummary;
      return fetchSummary(hours);
    });
    const refreshing = h.capture('refresh-after-replacement', () => h.orch.handleStartCommand());
    otherAccepted = false;
    await h.capture('failed-other-reissue', () => h.orch.handleAdvance('next', 'reissue passport'));
    release();
    const third = await refreshing;
    expect(third).toHaveProperty('text', expect.not.stringContaining('Other (has your namecard ✓)'));
    expect(h.sm.current(PID)).toBe('lantern');
    evidence.stampReplacement = h.trace;
  });

  it.each(['sources', 'canvas', 'houses', 'guide-snapshot', 'rank', 'learned-only', 'core'])('preserves %s degradation and cold-start behavior', async (mode) => {
    const h = await setup();
    h.controls.sources = [{ path: mode === 'learned-only' ? 'learned/a.md' : 'core/private.md', content: 'software' }];
    h.controls.rejectSources = mode === 'sources';
    h.controls.rejectCanvas = mode === 'canvas';
    h.controls.rejectHouses = mode === 'houses';
    h.controls.rejectGuide = h.controls.rejectSnapshot = mode === 'guide-snapshot';
    h.controls.rejectRank = mode === 'rank';
    await h.capture(mode, () => h.orch.handleStartCommand());
    expect(h.sm.drafts(PID).lantern).toHaveProperty('entries');
    expect(h.trace.some((e) => e[0] === 'rank')).toBe(!['sources', 'learned-only'].includes(mode));
    // Houses are read live again when replaying the stage, including catch fallback.
    h.controls.rejectHouses = false;
    h.controls.houses = [{ slug: 'new', name: 'New house', blurb: 'New blurb' }];
    await h.capture('live-houses', () => h.orch.handleStartCommand());
    evidence[mode] = h.trace;
  });
});

it('independent probe: answer arriving immediately after rerank presentation completes', async () => {
  const h = await setup();
  h.deps.followPerson = async (ref) => { h.record('follow', ref); return { kind: 'followed', display: 'Alice' }; };
  let stageAtAnswer = '';
  await h.orch.handleStartCommand();
  await h.orch.handleAdvance('next');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const presenting = new Promise<void>((resolve) => { entered = resolve; });
  const original = h.deps.presenter.present.bind(h.deps.presenter);
  let first = true;
  vi.spyOn(h.deps.presenter, 'present').mockImplementation((card) => {
    if (!first) return original(card);
    first = false;
    h.record('gated-present', card);
    entered();
    return gate;
  });
  h.trace.length = 0;
  const taste = h.capture('first-taste', () => h.orch.handleAdvance('next', 'I enjoy software'));
  await presenting;
  release();
  const second = new Promise<void>((resolve, reject) => {
    queueMicrotask(() => {
      stageAtAnswer = h.sm.current(PID);
      h.record('stage-after-rerank-presentation', stageAtAnswer);
      h.capture('immediate-number-answer', () => h.orch.handleAdvance('next', '1')).then(() => resolve(), reject);
    });
  });
  await Promise.all([taste, second]);
  h.record('taste-file', await readFile(join(h.root, 'core/private.md'), 'utf8'));
  evidence.independentOverlap = h.trace;
  expect(stageAtAnswer).toBe('errand');
  expect(h.trace.filter((e) => e[0] === 'follow')).toHaveLength(1);
  expect(h.sm.current(PID)).toBe('cadence');
  expect(h.trace.filter((e) => e[0] === 'transition' && e[1] === 'errand')).toHaveLength(1);
  for (const result of h.trace.filter((e) => e[0] === 'result')) {
    expect(result[2]).not.toHaveProperty('error');
  }
});

it('independent graduation probe: cached taste must not delay completion', async () => {
  const h = await setup();
  await h.orch.handleStartCommand();
  await h.orch.handleAdvance('next');
  await h.orch.handleAdvance('next', 'I enjoy software');
  await h.orch.handleAdvance('skip');
  expect(h.sm.current(PID)).toBe('cadence');
  let release!: (value: unknown) => void;
  const gate = new Promise<unknown>((resolve) => { release = resolve; });
  const loadJson = h.deps.host.config.loadJson.bind(h.deps.host.config);
  vi.spyOn(h.deps.host.config, 'loadJson').mockImplementation((key) => key === 'plugin' ? gate : loadJson(key));
  h.trace.length = 0;
  const first = h.capture('first-graduation', () => h.orch.handleAdvance('skip'));
  release({ ranger_profile: { nickname: 'Owner' } });
  let stageAtAnswer = '';
  const second = new Promise<void>((resolve, reject) => {
    queueMicrotask(() => queueMicrotask(() => {
      stageAtAnswer = h.sm.current(PID);
      h.record('stage-after-nickname-read', stageAtAnswer);
      h.capture('immediate-cadence-answer', () => h.orch.handleAdvance('skip')).then(() => resolve(), reject);
    }));
  });
  await Promise.all([first, second]);
  evidence.independentGraduation = h.trace;
  expect(stageAtAnswer).toBe('completed');
  expect(h.trace.filter((e) => e[0] === 'transition' && e[1] === 'completed')).toHaveLength(1);
  for (const result of h.trace.filter((e) => e[0] === 'result')) {
    expect(result[2]).not.toHaveProperty('error');
  }
});
