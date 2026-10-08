import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { buildNewspaperPrompt } from '../../../src/newspaper/build-newspaper-prompt.js';
import { renderNewspaper } from '../../../src/newspaper/render-newspaper.js';
import { publishNewspaper, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
import { putIssue, getIssue, getEdit, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { DEFAULT_STYLE } from '../../../src/newspaper/newspaper-style.js';
import { noteContextTokenBudget, _resetBudgetForTest } from '../../../src/newspaper/host-budget.js';
import { issue, item } from './_issue-fixture.js';
import { dropScratch, makeScratch, type Scratch } from './_scratch.js';

const opts = { mintToken: () => 'tok_stable', contentRules: '', leadMax: 3, perAuthorMax: 6, floor: 0, topUpTo: 0 };
const candidates = (count = 4) => issue({ language: 'en', pulse: Array.from({ length: count }, (_, i) => item({
  author: `Author${i + 1}`, authorPopclawId: `person${i + 1}`, sigil: `sig${i + 1}`, eventId: `event${i + 1}`,
  text: `SOURCE_${i + 1}`, url: `https://x.com/Author${i + 1}/status/${i + 1}`, tier: 'card',
  postPageUrl: `https://post.test/${i + 1}`, media: [`https://image.test/${i + 1}.jpg`],
})) });
let scratch: Scratch;
const deps = (upload = vi.fn(async () => ({ url: 'https://canvas.test/verified' }))): PublishDeps => ({
  upload, signer: { popclawId: async () => 'PublisherFixtureId' } as never, nickname: 'Test', canvasBaseUrl: 'https://canvas.test',
  archive: createLocalNewspaperIssueArchive({ issuesDir: scratch.issuesDir, lastNewspaperHtml: scratch.lastNewspaperHtml }), lang: 'en',
});
const first = { basis: 'tok_stable', masthead: 'Test paper', teaser: 'Test teaser' };

beforeEach(() => { scratch = makeScratch('candidate-id'); _resetIssuesForTest(); _resetBudgetForTest(); });
afterEach(() => dropScratch(scratch));

describe('candidate IDs survive selection and every hand-in', () => {
  it('keeps sparse candidate numbers on the material page, stored issue and rendered author/source/copy/media', async () => {
    putIssue('c_stable', candidates());
    const picked = buildIssueFromPicks('c_stable', [2, 3, 4], opts);
    expect(picked.kind).toBe('ready');
    if (picked.kind !== 'ready') return;
    const chosen = getIssue('tok_stable')!;
    expect(chosen.pulse.map(p => p.itemNumber)).toEqual([2, 3, 4]);
    for (const n of [2, 3, 4]) expect(picked.payload).toContain(`[${n}] author: Author${n}`);
    const upload = vi.fn(async () => ({ url: 'https://canvas.test/verified' }));
    const partial = await publishNewspaper(deps(upload), { edit: { ...first, items: { '2': { q: 'SOURCE_2', h: 'COPY_2', s: 'BODY_2' } } } });
    expect(partial.text).toContain('[3] [4]');
    expect(upload).not.toHaveBeenCalled();
    expect(Object.keys(getEdit('tok_stable')!.items!)).toEqual(['2']);
    const edit = { ...first, leads: [2], items: { '2': { q: 'SOURCE_2', h: 'COPY_2', s: 'BODY_2' }, '3': { q: 'SOURCE_3', h: 'COPY_3', s: 'BODY_3' }, '4': { q: 'SOURCE_4', h: 'COPY_4', s: 'BODY_4' } }, pulls: { '3': 'SOURCE_3' }, xrefs: { '4': 'RELATED_4' }, topics: { '4': 'TOPIC_4' } };
    const page = renderNewspaper(chosen, edit, DEFAULT_STYLE, 'en');
    expect([...page.headsByNumber]).toEqual([[2, 'COPY_2'], [3, 'COPY_3'], [4, 'COPY_4']]);
    expect(page.unwrittenNumbers).toEqual([]);
    expect(page.notes.some(n => n.includes('no item'))).toBe(false);
    for (const n of [2, 3, 4]) {
      // Cover both the lead and the cards. Copy, author, source and unique
      // image must travel together even when selected IDs are sparse.
      const article = page.html.match(/<article\b[\s\S]*?<\/article>/g)?.find(block => block.includes(`status/${n}"`));
      for (const text of [`Author${n}`, `COPY_${n}`, `BODY_${n}`, `https://post.test/${n}`, `https://image.test/${n}.jpg`]) {
        expect(article).toContain(text);
      }
      for (const other of [2, 3, 4].filter(other => other !== n)) {
        expect(article).not.toContain(`BODY_${other}`);
        expect(article).not.toContain(`https://image.test/${other}.jpg`);
      }
    }
    const recordFollowable = vi.fn();
    expect((await publishNewspaper({ ...deps(upload), recordFollowable }, { edit })).landed).toBe(true);
    expect(upload).toHaveBeenCalledOnce();
    expect(recordFollowable).toHaveBeenCalledOnce();
    expect(recordFollowable.mock.calls[0]![0].map((row: { display_name: string; descriptor: string }) => [row.display_name, row.descriptor]))
      .toEqual([[ 'Author2#sig2', 'COPY_2' ], [ 'Author3#sig3', 'COPY_3' ], [ 'Author4#sig4', 'COPY_4' ]]);
  });

  it('retains IDs after author caps and heat top-up', () => {
    const source = candidates(8);
    source.pulse[0]!.authorPopclawId = 'same'; source.pulse[1]!.authorPopclawId = 'same';
    putIssue('c_caps', source);
    buildIssueFromPicks('c_caps', [1, 2, 8], { ...opts, perAuthorMax: 1, floor: 4, topUpTo: 4 });
    const chosen = getIssue('tok_stable')!;
    expect(chosen.pulse).toHaveLength(4);
    expect(chosen.pulse.some(p => p.eventId === 'event2')).toBe(true);
    for (const p of chosen.pulse) expect(p.itemNumber).toBe(Number(p.eventId.slice(5)));
  });

  it('retains sparse IDs after material-budget trimming', () => {
    const source = candidates(40);
    for (const p of source.pulse) p.text = p.text.repeat(200);
    putIssue('c_budget', source);
    noteContextTokenBudget('small', 1000);
    buildIssueFromPicks('c_budget', Array.from({ length: 20 }, (_, i) => (i + 1) * 2), { ...opts, sessionKey: 'small' });
    const chosen = getIssue('tok_stable')!;
    expect(chosen.pulse.length).toBe(20);
    expect(chosen.pulse.map(p => p.itemNumber)).toEqual(chosen.pulse.map(p => Number(p.eventId.slice(5))));
  });

  it.each(['items', 'leads', 'pulls', 'xrefs', 'topics'])('rejects one unknown %s reference before upload or partial save', async (field) => {
    putIssue('c_stable', candidates());
    buildIssueFromPicks('c_stable', [2, 3, 4], opts);
    const valid = { '2': { q: 'SOURCE_2', h: 'COPY_2' }, '3': { q: 'SOURCE_3', h: 'COPY_3' }, '4': { q: 'SOURCE_4', h: 'COPY_4' } };
    const bad = field === 'items' ? { ...valid, '99': { h: 'WRONG' } } : field === 'leads' ? [2, 99] : { '99': 'WRONG' };
    const upload = vi.fn();
    const result = await publishNewspaper(deps(upload), { edit: { ...first, items: valid, [field]: bad } });
    expect(upload).not.toHaveBeenCalled();
    expect(result.landed).toBeUndefined();
    expect(getIssue('tok_stable')).toBeDefined();
    expect(getEdit('tok_stable')).toBeUndefined();
    expect(result.text).toContain('99');
  });

  it('does not contaminate an earlier good batch when a later batch has an unknown ID', async () => {
    putIssue('c_stable', candidates());
    buildIssueFromPicks('c_stable', [2, 3, 4], opts);
    await publishNewspaper(deps(), { edit: { ...first, items: { '2': { q: 'SOURCE_2', h: 'GOOD_2' } } } });
    const prior = getEdit('tok_stable');
    const upload = vi.fn();
    await publishNewspaper(deps(upload), { edit: { basis: 'tok_stable', items: { '3': { q: 'SOURCE_3', h: 'GOOD_3' }, '99': { q: 'SOURCE_4', h: 'WRONG' } } } });
    expect(getEdit('tok_stable')).toEqual(prior);
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps legacy unnumbered manifests positional without renumbering them', async () => {
    const legacy = candidates(2);
    putIssue('tok_legacy', legacy);
    const result = await publishNewspaper(deps(), { publishToken: 'tok_legacy', edit: { masthead: 'Legacy', teaser: 'Legacy', items: { '1': { q: 'SOURCE_1', h: 'FIRST' }, '2': { q: 'SOURCE_2', h: 'SECOND' } } } });
    expect(result.landed).toBe(true);
    expect(legacy.pulse.every(p => p.itemNumber === undefined)).toBe(true);
  });

  it.each([[2, 2], [2, undefined], [0, 3], [2.5, 3]])('refuses corrupt/mixed stored IDs %j', async (a, b) => {
    const malformed = candidates(2);
    malformed.pulse[0]!.itemNumber = a; malformed.pulse[1]!.itemNumber = b;
    putIssue('tok_corrupt', malformed);
    const upload = vi.fn();
    const result = await publishNewspaper(deps(upload), { publishToken: 'tok_corrupt', edit: { masthead: 'Bad', teaser: 'Bad', items: { '1': { q: 'SOURCE_1', h: 'ONE' }, '2': { q: 'SOURCE_2', h: 'TWO' } } } });
    expect(result.landed).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
    expect(getIssue('tok_corrupt')).toBeDefined();
    expect(getEdit('tok_corrupt')).toBeUndefined();
    expect(() => buildNewspaperPrompt(malformed, { ...opts, publishToken: 'tok_corrupt', pickedCount: 2, overBudget: false })).toThrow();
  });
});
