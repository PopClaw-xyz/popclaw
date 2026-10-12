/**
 * Progress stages in the dispatch ledger are recorded by the tool entry points themselves
 * (2026-09-13).
 *
 * `dedicated-session.test.ts` tests consumption of this table; this file tests how it is populated.
 * Each stage is marked by the tool that actually completed the work, at completion, without reading
 * child-session logs or treating the model's explanation of its failure as a system diagnosis.
 * Otherwise, a model's claim that the host truncated it becomes recorded fact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { putIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { todayDateLabel } from '../../../src/newspaper/issue.js';
import { NewspaperOutcomeStore, NewspaperStageStore, childSessionKey } from '../../../src/newspaper/dedicated-session.js';
import { issue, item } from './_issue-fixture.js';

let dir: string;
const child = childSessionKey('stage-wiring');

const candidateIssue = (): ReturnType<typeof issue> =>
  issue({
    dateLabel: todayDateLabel(),
    pulse: [item({ eventId: 'sw1' }), item({ eventId: 'sw2', author: '乙', sigil: 'bbbb0002' })],
  });

/** The two newspaper tools, built for one session key. */
function tools(sessionKey: string): Map<string, (p: unknown) => Promise<{ text: string }>> {
  const found = new Map<string, (p: unknown) => Promise<{ text: string }>>();
  const api = {
    registerTool: (tool: unknown): void => {
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({ sessionKey }) : tool;
      const t = resolved as { name?: string; execute?: (c: string, p: unknown) => Promise<{ text: string }> };
      if (t?.name && typeof t.execute === 'function') found.set(t.name, (p) => t.execute!('c1', p));
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  registerPopclawTools({
    api,
    runtime: (async () => ({
      // Enough of a boot for publish to reach its happy path: no publisher, so the
      // paper is written to disk and nothing is uploaded — no network in this suite.
      boot: { loreHouseUrls: [], signer: {}, nickname: 'Yu', canvasBaseUrl: null },
      paths: {
        newspaperDir: () => join(dir, 'newspaper'),
        newspaperIssuesDir: () => join(dir, 'newspaper', 'issues'),
        lastNewspaperHtml: () => join(dir, 'newspaper', 'last-newspaper.html'),
        newspaperManifestsDir: () => dir,
        tasteDir: () => join(dir, 'taste'),
        houseGuideFile: (s: string) => join(dir, 'lorehouses', `${s}.guide.md`),
      },
      uploadCanvas: async () => {
        throw new Error('no publisher is configured in this suite');
      },
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
  });
  return found;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-stage-wiring-'));
  _resetIssuesForTest();
  NewspaperStageStore.clear();
  NewspaperOutcomeStore.clear();
});
afterEach(() => {
  _resetIssuesForTest(dir);
  NewspaperStageStore.clear();
  NewspaperOutcomeStore.clear();
});

describe('工具入口自己记下走到哪一步', () => {
  it('素材页发出去了 → materialPage,别的格子一律不动', async () => {
    putIssue('ctok_stage0001', candidateIssue(), dir);
    await tools(child).get('popclaw_newspaper')!({ candidate_token: 'ctok_stage0001', picks_flat: [1] });
    expect(NewspaperStageStore.take(child)).toEqual({
      candidatePage: false,
      materialPage: true,
      publishCalled: false,
      publishAccepted: false,
    });
  });

  it('picks 被拒(拿不出凭证)→ 一格都不记:那一步没有做成', async () => {
    putIssue('ctok_stage0002', candidateIssue(), dir);
    await tools(child).get('popclaw_newspaper')!({ picks_flat: [1] }); // no provenance
    expect(NewspaperStageStore.take(child)).toBeUndefined();
  });

  it('进了 publish 就记 publishCalled —— 交稿被拒和从没交稿是两种失败', async () => {
    await tools(child).get('popclaw_publish_newspaper')!({ edit: {} });
    const stage = NewspaperStageStore.take(child);
    expect(stage?.publishCalled).toBe(true);
    expect(stage?.publishAccepted).toBe(false);
  });

  it('主人自己的会话不进这张表 —— 那里根本没有台账行可挂', async () => {
    putIssue('ctok_stage0003', candidateIssue(), dir);
    const own = 'agent:main:telegram:12345';
    await tools(own).get('popclaw_newspaper')!({ candidate_token: 'ctok_stage0003', picks_flat: [1] });
    expect(NewspaperStageStore.take(own)).toBeUndefined();
  });
});

/**
 * The other thing the workshop's tool entry fills for the dispatcher: the run's
 * OUTCOME. The dispatcher reads only the last value, and this tool's own
 * description tells the writer to call again while items are still unwritten —
 * so a second call after a landed receipt is ordinary, not perverse. That call
 * is refused (the issue token is consumed by the paper that already landed), and
 * the refusal used to overwrite the success: the owner was told the edition
 * failed while its HTML and its link already existed, and asked for another one.
 */
describe('a landed paper is the run\'s outcome — a later refusal does not unsay it', () => {
  const body = 'the booster landed on the pad.';
  /** One item, so one complete hand-in really finishes the issue. */
  const outcomeIssue = (): ReturnType<typeof issue> =>
    issue({ dateLabel: todayDateLabel(), pulse: [item({ eventId: 'ow1', text: body })] });
  const edit = {
    basis: 'tok_outcome0001',
    masthead: 'Cloudboat Gazette',
    teaser: 'today in one line',
    items: { '1': { q: body, h: 'it came back', s: 'the booster is on the pad again.' } },
  };

  it('publish → published; publish again → refused to the writer, but the receipt still stands', async () => {
    putIssue('tok_outcome0001', outcomeIssue(), dir);
    const publish = tools(child).get('popclaw_publish_newspaper')!;

    const first = await publish({ edit });
    const landed = NewspaperOutcomeStore.get(child);
    expect(landed).toEqual({ ok: true, receiptText: first.text });

    const second = await publish({ edit });
    // The writer is still told, in full, that this hand-in went nowhere...
    expect(second.text).not.toBe(first.text);
    expect(second.text).toContain('tok_outcome0001');
    // ...and the dispatcher still has the paper that DID come out.
    expect(NewspaperOutcomeStore.get(child)).toEqual(landed);
  });
});
