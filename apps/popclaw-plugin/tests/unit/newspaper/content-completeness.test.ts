import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginReading, readNewspaperPage } from '../../../src/newspaper/reading-page.js';
import { runNewspaperCall } from '../../../src/tools/newspaper-call.js';
import { publishNewspaper } from '../../../src/newspaper/publish-newspaper.js';
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { gatherNewspaperMaterials, weightedChars, type GatherDeps } from '../../../src/newspaper/gather-materials.js';
import { collectNewspaperMaterials } from '../../../src/newspaper/collect-materials.js';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { getIssue, putIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { noteContextTokenBudget, pageBudgetNow, _resetBudgetForTest } from '../../../src/newspaper/host-budget.js';
import { item, issue } from './_issue-fixture.js';

beforeEach(() => { _resetIssuesForTest(); _resetBudgetForTest(); });

function materials(count: number, body = '原文'.repeat(1200)): GatherDeps {
  const rows = Array.from({ length: count }, (_, n) => ({
    eventId: `event-${n}`, authorPopclawId: `person-${n}`, actorNickname: `作者${n}`,
    actorVerified: [], platform: 'popclaw', platformPostId: `post-${n}`, platformPostCreatedAt: 99000,
    body: `${body}尾文${n}`, textPreview: 'preview', handle: '', originalUrl: '', media: [],
    replyToAuthorHandle: '', replyCount: 0, markCount: 0,
  }));
  return { cache: { recentForReading: (n) => rows.slice(0, n) as never }, inbox: { recent: () => [] },
    ownerNickname: '主人', webBaseUrl: 'https://popclaw.me', now: () => 100000,
    mintToken: () => 'tok_complete', isFollowing: () => false, readContentRules: () => '' };
}

it('retains every available item in the requested window and its complete original body', () => {
  const r = collectNewspaperMaterials(materials(1007), { hours: 24 });
  expect(r.kind).toBe('collected');
  if (r.kind === 'empty') throw new Error(r.message);
  expect(r.draft.pulse).toHaveLength(1007);
  expect(r.draft.pulse[0]!.text).toBe('原文'.repeat(1200) + '尾文0');
});

function bodyOf(page: string): string {
  return page.slice(page.indexOf('\n\n') + 2, page.lastIndexOf('\n\n['));
}
const nextOf = (page: string): string | undefined => /page_cursor="([^"]+)"/.exec(page)?.[1];

it('reads a single long source byte-for-byte across processes and receiving host budgets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newspaper-complete-'));
  const source = '  原文𠀀🙂\r\n'.repeat(10000) + '最后一个字\n';
  putIssue('ctok_long', issue({ pulse: [item({ text: source })] }), dir, 'author');
  noteContextTokenBudget('first', 32000);
  let page = beginReading('ctok_long', source, { manifestDir: dir, sessionKey: 'first' });
  let all = bodyOf(page), cursor = nextOf(page), reads = 0;
  expect(cursor).toBeDefined();
  _resetIssuesForTest(); // Drop the whole in-process ledger; disk alone must carry the next page.
  const validate = vi.fn();
  while (cursor) {
    const sessionKey = reads++ % 2 ? 'first' : 'larger';
    noteContextTokenBudget('larger', 100000);
    const out = await runNewspaperCall({
      api: {}, deps: {}, toolCtx: { sessionKey }, runtime: async () => ({ paths: { newspaperManifestsDir: () => dir } }),
    } as never, { page_cursor: cursor });
    page = out.text;
    expect(weightedChars(page)).toBeLessThanOrEqual(pageBudgetNow(sessionKey));
    all += bodyOf(page); cursor = nextOf(page);
    expect(reads).toBeLessThan(100);
  }
  expect(Buffer.from(all)).toEqual(Buffer.from(source));
  const again = beginReading('ctok_long', source, { manifestDir: dir });
  readNewspaperPage(nextOf(again)!, { manifestDir: dir, validateMaterials: validate });
  expect(validate).toHaveBeenCalledOnce();
});

it('refuses cross-issue, changed-content and expired cursors without resampling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newspaper-cursor-'));
  putIssue('ctok_cursor', issue(), dir);
  const cursor = nextOf(beginReading('ctok_cursor', '原文'.repeat(10000), { manifestDir: dir }))!;
  putIssue('ctok_other', issue(), dir);
  expect(() => readNewspaperPage(cursor.replace('ctok_cursor.', 'ctok_other.'), { manifestDir: dir })).toThrow('not found');
  const f = join(dir, 'ctok_cursor.json');
  const raw = JSON.parse(readFileSync(f, 'utf8'));
  raw.reading[Object.keys(raw.reading)[0]!] += '篡改';
  writeFileSync(f, JSON.stringify(raw)); _resetIssuesForTest();
  expect(() => readNewspaperPage(cursor, { manifestDir: dir })).toThrow('version changed');
  raw.created_at = Date.now() - 3 * 60 * 60 * 1000;
  writeFileSync(f, JSON.stringify(raw));
  expect(() => readNewspaperPage(cursor, { manifestDir: dir })).toThrow('expired');
  const rt = vi.fn(async () => ({}));
  const r = await runNewspaperCall({ api: {}, deps: {}, toolCtx: {}, runtime: rt } as never,
    { page_cursor: cursor, picks_flat: [1] });
  expect(r.text).toContain('supplied alone');
  expect(rt).not.toHaveBeenCalled();
});

it('refuses an old reading-stage cursor after a new saved receipt replaces that document', () => {
  putIssue('tok_stage', issue());
  const cursor = nextOf(beginReading('tok_stage', 'source '.repeat(20000)))!;
  beginReading('tok_stage', 'new unfinished receipt '.repeat(10000));
  expect(() => readNewspaperPage(cursor)).toThrow('not found');
});

it('writes a selected issue over 120 items in batches, paginates the receipt and preserves HTML over 2MiB locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newspaper-batches-'));
  const pulse = Array.from({ length: 125 }, (_, i) => item({ eventId: `event${i}`, itemNumber: i + 1,
    text: `The unique source passage number ${i} ends here.` + (i === 1 ? ' Long complete source.'.repeat(2000) : '') }));
  putIssue('tok_batches', issue({ pulse }), dir);
  noteContextTokenBudget('writer', 32000);
  const upload = vi.fn(async () => { throw new Error('HTTP 413 actual configured publisher'); });
  const deps = { upload, signer: { popclawId: async () => 'owner' }, nickname: '主人',
    manifestDir: dir, sessionKey: 'writer', canvasBaseUrl: 'https://canvas.example',
    archive: createLocalNewspaperIssueArchive({ issuesDir: join(dir, 'issues'), lastNewspaperHtml: join(dir, 'last.html') }),
    fonts: 'system' as const, avatarMode: 'off' as const };
  const first = await publishNewspaper(deps as never, { edit: { basis: 'tok_batches', masthead: '完整报纸', teaser: '完整导读',
    items: { '1': { q: pulse[0]!.text, h: '条目1', s: '正文'.repeat(550000) } } } });
  expect(first.accepted).toBe(true);
  expect(weightedChars(first.text)).toBeLessThanOrEqual(pageBudgetNow('writer'));
  expect(first.text).toContain('page_cursor');
  expect(upload).not.toHaveBeenCalled();
  const items = Object.fromEntries(pulse.slice(1).map((p, i) => [String(i + 2), { q: p.text, h: `条目${i + 2}`, s: `完整摘要${i + 2}` }]));
  const done = await publishNewspaper(deps as never, { edit: { basis: 'tok_batches', items } });
  expect(done.landed).toBe(true);
  expect(upload).toHaveBeenCalledOnce();
  expect(done.text).toContain('413');
  const html = readFileSync(join(dir, 'last.html'), 'utf8');
  expect(Buffer.byteLength(html)).toBeGreaterThan(2 * 1024 * 1024);
  expect(html).toContain('完整摘要125');
  expect(getIssue('tok_batches', dir)).toBeUndefined();
});

it('stores the full candidate set even when one host response cannot contain all candidates', () => {
  noteContextTokenBudget('small', 32000);
  const r = gatherNewspaperMaterials({ ...materials(500), sessionKey: 'small' }, { hours: 24 });
  if (r.kind === 'empty') throw new Error(r.message);
  expect(getIssue(r.candidateToken)!.pulse).toHaveLength(500);
  expect(weightedChars(r.payload)).toBeLessThanOrEqual(pageBudgetNow('small'));
  expect(r.payload).toContain('page_cursor');
});

it('keeps the author selection without caps and reports editorial top-up and retains all selected originals', () => {
  const pulse = Array.from({ length: 140 }, (_, i) => item({ eventId: `e${i}`, text: '完整原文'.repeat(1500) + `尾文${i}` }));
  putIssue('ctok_selected', issue({ pulse }));
  const options = { mintToken: () => 'tok_selected', contentRules: '', leadMax: 3,
    perAuthorMax: 6, floor: 15, topUpTo: 20, sessionKey: 'small' };
  noteContextTokenBudget('small', 32000);
  const r = buildIssueFromPicks('ctok_selected', pulse.map((_, i) => i + 1), options);
  if (r.kind === 'error') throw new Error(r.message);
  expect(getIssue(r.publishToken)!.pulse).toHaveLength(140);
  expect(getIssue(r.publishToken)!.pulse.at(-1)!.itemNumber).toBe(140);
  expect(weightedChars(r.payload)).toBeLessThanOrEqual(pageBudgetNow('small'));
  expect(r.payload).toContain('page_cursor');
  const chosen = buildIssueFromPicks('ctok_selected', [7], { ...options, mintToken: () => 'tok_one' });
  if (chosen.kind === 'error') throw new Error(chosen.message);
  expect(getIssue(chosen.publishToken)!.pulse).toHaveLength(20);
  expect(getIssue(chosen.publishToken)!.pulse.some(p => p.itemNumber === 7)).toBe(true);
  expect(chosen.notes.join(' ')).toContain('19 more added');
});
