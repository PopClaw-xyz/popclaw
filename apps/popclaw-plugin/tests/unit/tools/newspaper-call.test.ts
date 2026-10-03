/**
 * popclaw_newspaper's call, driven through the real tool entry: which calls are
 * dispatched to the workshop session, which degrade to this session (and what
 * they say about it), and which are refused before anything is read.
 *
 * `dedicated-session.test.ts` covers the dispatch itself; this file covers the
 * decision the tool makes around it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import {
  NewspaperOutcomeStore,
  NewspaperStageStore,
  childSessionKey,
  isDedicatedSession,
  type SubagentSurface,
} from '../../../src/newspaper/dedicated-session.js';
import { _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';

type Deps = Parameters<typeof registerPopclawTools>[0];

let dir: string;
const OWNER_SESSION = 'agent:main:tui:owner';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-newspaper-call-'));
  _resetIssuesForTest();
  NewspaperStageStore.clear();
  NewspaperOutcomeStore.clear();
});
afterEach(() => {
  _resetIssuesForTest(dir);
  NewspaperStageStore.clear();
  NewspaperOutcomeStore.clear();
});

/** A runtime with an empty day: gathering in this session yields the empty-paper note. */
function emptyDayRuntime() {
  return vi.fn(async () => ({
    worldFeedCache: { recentForReading: () => [] },
    inboxStore: { recent: () => [] },
    socialGraph: { followsIn: () => false },
    boot: { nickname: 'Yu', webBaseUrl: 'https://example.invalid', loreHouseUrls: [] },
    paths: {
      newspaperDir: () => join(dir, 'newspaper'),
      newspaperManifestsDir: () => dir,
      tasteDir: () => join(dir, 'taste'),
      houseGuideFile: (s: string) => join(dir, 'lorehouses', `${s}.guide.md`),
    },
  }));
}

/** A workshop that runs and lands `receipt` as the child session's outcome. */
function landingSurface(receipt: string) {
  const runs: string[] = [];
  const surface: SubagentSurface = {
    run: async ({ sessionKey }) => {
      runs.push(sessionKey);
      NewspaperOutcomeStore.set(sessionKey, { ok: true, receiptText: receipt });
      return { runId: 'run-1' };
    },
    waitForRun: async () => ({ status: 'ok' }),
    deleteSession: async () => {},
  };
  return { surface, runs };
}

function newspaperTool(sessionKey: string, extra: Partial<Deps> & { runtime?: Deps['runtime'] } = {}) {
  let execute: ((callId: string, params: unknown) => Promise<{ text: string }>) | undefined;
  const api = {
    registerTool: (tool: unknown): void => {
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({ sessionKey }) : tool;
      const t = resolved as { name?: string; execute?: typeof execute };
      if (t?.name === 'popclaw_newspaper') execute = t.execute;
    },
  } as Deps['api'];
  registerPopclawTools({
    api,
    runtime: emptyDayRuntime() as unknown as Deps['runtime'],
    ...extra,
  });
  return (params: unknown) => execute!('c1', params);
}

const emptyPage = () => renderCopy(ownerLang(), 'newspaper.empty.today');

describe('popclaw_newspaper · dispatch or degrade', () => {
  it('in the owner session, a bare call hands the whole job to the workshop and relays its receipt', async () => {
    const { surface, runs } = landingSurface('PAPER-RECEIPT-1');
    const call = newspaperTool(OWNER_SESSION, { getSubagent: () => surface });
    const out = await call({});
    expect(runs).toHaveLength(1);
    expect(isDedicatedSession(runs[0])).toBe(true);
    expect(out.text).toContain('PAPER-RECEIPT-1');
  });

  it('a configured model the host refuses degrades to this session and names the model on the page', async () => {
    const surface: SubagentSurface = {
      run: async () => {
        throw new Error('provider/model override is not authorized for this plugin subagent run.');
      },
      waitForRun: async () => ({ status: 'ok' }),
      deleteSession: async () => {},
    };
    const call = newspaperTool(OWNER_SESSION, {
      getSubagent: () => surface,
      getNewspaperModel: async () => 'house-model-x',
    });
    const out = await call({});
    const note = renderCopy(ownerLang(), 'newspaper.dispatch.modelIgnored', { model: 'house-model-x' });
    expect(out.text.startsWith(`${note}\n\n`)).toBe(true);
  });

  it('any other dispatch failure degrades silently to this session', async () => {
    const call = newspaperTool(OWNER_SESSION, {
      getSubagent: () => {
        throw new Error('OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE');
      },
    });
    const out = await call({});
    expect(out.text).not.toContain('house-model-x');
    expect(out.text).toContain(emptyPage().split('\n')[0]!);
  });

  it('inside the workshop session it never dispatches again', async () => {
    const getSubagent = vi.fn(() => landingSurface('NEVER').surface);
    const call = newspaperTool(childSessionKey('call-test'), { getSubagent });
    const out = await call({});
    expect(getSubagent).not.toHaveBeenCalled();
    expect(out.text).not.toContain('NEVER');
  });

  it('with no subagent surface it gathers in this session, with no note', async () => {
    const call = newspaperTool(OWNER_SESSION);
    const out = await call({});
    expect(out.text.startsWith(emptyPage().split('\n')[0]!)).toBe(true);
  });
});

describe('popclaw_newspaper · a hand-in whose picks were lost', () => {
  it('is refused before anything is gathered or dispatched, naming what arrived', async () => {
    const recentForReading = vi.fn(() => []);
    const runtime = vi.fn(async () => ({ ...(await emptyDayRuntime()()), worldFeedCache: { recentForReading } }));
    const getSubagent = vi.fn(() => landingSurface('NEVER').surface);
    const call = newspaperTool(OWNER_SESSION, { runtime: runtime as unknown as Deps['runtime'], getSubagent });
    const out = await call({ candidate_basis: 'cabc12345', picks: {} });
    expect(out.text).toContain('Your candidate_basis arrived but the picks did not');
    expect(out.text).toContain('picks=object with no numbers in it');
    expect(recentForReading).not.toHaveBeenCalled();
    expect(getSubagent).not.toHaveBeenCalled();
  });

  it('a bare call carrying no selector is not a lost hand-in', async () => {
    const call = newspaperTool(childSessionKey('call-test'));
    const out = await call({ picks: {} });
    expect(out.text).not.toContain('arrived but the picks did not');
  });
});
