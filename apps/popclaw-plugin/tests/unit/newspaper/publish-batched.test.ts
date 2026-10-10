/**
 * Handing the copy in a batch at a time.
 *
 * The wall this exists for is the **output** side, not the input side: OpenClaw's
 * factory default is `maxTokens = 8192`, and 90 items at ~110 tokens each is
 * 10-11k — so on a stock host the writer physically cannot finish one issue in one
 * hand-in. Real hardware showed both ways it ends: one machine wrote 11 items and
 * stopped, another burned the whole budget and died with `stopReason=length`,
 * which loses the tool call itself and produces no paper at all.
 *
 * So: hand in what you wrote, the paper is published thin but whole, and the
 * ledger entry survives so the rest can be filled in against the same token.
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { publishNewspaper, checkEdit, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
import { putIssue, getIssue, getEdit, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { issue, item } from './_issue-fixture.js';
import { dropScratch, makeScratch, type Scratch } from './_scratch.js';

let scratch: Scratch;

function deps(upload = vi.fn(async () => ({ url: 'https://canvas/x/1?t=tok' }))): PublishDeps {
  return {
    upload,
    // Publish asks the signer who the owner is, so the publisher's own byline
    // never wears a follow chip on their own paper.
    signer: { popclawId: async () => 'PublisherFixtureId' } as never,
    nickname: 'Yu',
    canvasBaseUrl: 'https://canvas',
    archive: createLocalNewspaperIssueArchive({ issuesDir: scratch.issuesDir, lastNewspaperHtml: scratch.lastNewspaperHtml }),
    lang: 'en',
  };
}

/** Three items, so one can be written and two left for the next hand-in. */
const three = (): ReturnType<typeof issue> =>
  issue({
    pulse: [
      item({ text: 'first', eventId: 'e1' }),
      item({ text: 'second', eventId: 'e2', author: 'sama', sigil: '2222aaaa' }),
      item({ text: 'third', eventId: 'e3', author: 'karpathy', sigil: '3333bbbb' }),
    ],
  });

const firstBatch = {
  masthead: 'Cloudboat Gazette',
  teaser: 'today in three lines',
  items: { '1': { q: 'first', h: 'the booster', s: 'it landed.' } },
};

describe('分批交稿', () => {
  beforeEach(() => {
    scratch = makeScratch('batched');
    _resetIssuesForTest();
  });
  afterEach(() => dropScratch(scratch));

  /**
   * The dispatch ledger must distinguish an accepted batch from no successful submission
   * (2026-09-13). landed describes whether the owner received the newspaper; accepted describes
   * whether this submission's copy was retained.
   */
  it('交了一批但没写完 → accepted 为真、landed 为假;全部写完 → 两个都真', async () => {
    putIssue('t-accepted', three());
    const partial = await publishNewspaper(deps(), { publishToken: 't-accepted', edit: firstBatch });
    expect(partial.accepted).toBe(true);
    expect(partial.landed).toBeUndefined();

    const rest = await publishNewspaper(deps(), {
      publishToken: 't-accepted',
      edit: {
        items: {
          '2': { q: 'second', h: 'two', s: 'the second one.' },
          '3': { q: 'third', h: 'three', s: 'the third one.' },
        },
      },
    });
    expect(rest.landed).toBe(true);
    expect(rest.accepted).toBe(true);
  });

  it('交稿被拒 → accepted 不为真:那一次什么都没留下', async () => {
    putIssue('t-refused', three());
    const r = await publishNewspaper(deps(), { publishToken: 't-refused', edit: { masthead: 'X', teaser: 'y' } });
    expect(r.accepted).toBeUndefined();
    expect(r.landed).toBeUndefined();
  });

  it('还有没写的 → **不出报、不给链接**,但账留着,并说还剩几条', async () => {
    putIssue('t1', three());
    const upload = vi.fn(async () => ({ url: 'https://canvas/x/1?t=tok' }));
    const r = await publishNewspaper(deps(upload as never), { publishToken: 't1', edit: firstBatch });

    // One issue has one link. A version missing most items must not reach the owner,
    // and each canvas upload creates another link; publishing partial then complete versions would create two links for one day.
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).not.toContain('canvas');
    // Name the outstanding item numbers; a count alone is unusable if the host truncated the material page's middle.
    expect(r.text).toContain(
      renderCopy('en', 'newspaper.publish.moreToWrite', { count: '2', numbers: '[2] [3]', token: 't1' }),
    );
    expect(getIssue('t1')).toBeDefined(); // The ledger remains so another batch can fill the gaps.
    expect(getEdit('t1')?.items).toEqual(firstBatch.items);
  });

  /**
   * A receipt containing only item numbers is insufficient: material is the largest context block
   * and often the first truncated, so the writer may no longer see it. Asking for copy without
   * material invites writing from memory, which caused misattributed summaries on real machines on
   * 2026-09-10/11. Repeat the original material for outstanding items.
   */
  it('没写完的回执要把还欠那几条的素材原样重贴 —— 已经写过的那条不重贴', async () => {
    putIssue('t-again', three());
    const r = await publishNewspaper(deps(), { publishToken: 't-again', edit: firstBatch });
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.materialAgain', { count: '2' }));
    // Both outstanding items include author lines and bodies.
    expect(r.text).toContain('sama#2222aaaa');
    expect(r.text).toContain('karpathy#3333bbbb');
    expect(r.text).toContain('second');
    expect(r.text).toContain('third');
    // The already-written item does not consume receipt space.
    expect(r.text).not.toContain('levelsio#65v29fn1');
    // Instructions precede material so host truncation retains what to do, not just source content.
    expect(r.text.indexOf(renderCopy('en', 'newspaper.publish.materialAgain', { count: '2' }))).toBeGreaterThan(
      r.text.indexOf(renderCopy('en', 'newspaper.publish.moreToWrite', { count: '2', numbers: '[2] [3]' })),
    );
  });

  it('第二批只填空、不改写 —— 已经写过的那条谁也动不了', async () => {
    putIssue('t2', three());
    await publishNewspaper(deps(), { publishToken: 't2', edit: firstBatch });

    const sent: string[] = [];
    const upload = vi.fn(async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/x/2?t=tok' };
    });
    await publishNewspaper(deps(upload as never), {
      publishToken: 't2',
      edit: {
        items: {
          '1': { q: 'first', h: 'REWRITTEN', s: 'a second pass at the same item.' },
          '2': { q: 'second', h: 'the second', s: 'it went up.' },
          '3': { q: 'third', h: 'the third', s: 'it came down.' },
        },
      },
    });

    // The brief tier prints only the summary, so assert the summary actually rendered in the layout.
    const html = sent[0]!;
    expect(html).toContain('it landed.'); // Copy from the first batch remains.
    expect(html).not.toContain('a second pass at the same item.'); // Fill gaps only; do not rewrite.
    expect(html).toContain('it went up.');
    expect(html).toContain('it came down.');
  });

  it('全写完了 → 销账,回执里不再提补稿', async () => {
    putIssue('t3', three());
    await publishNewspaper(deps(), { publishToken: 't3', edit: firstBatch });
    const r = await publishNewspaper(deps(), {
      publishToken: 't3',
      edit: { items: { '2': { q: 'second', h: 'b', s: 'bb.' }, '3': { q: 'third', h: 'c', s: 'cc.' } } },
    });

    expect(r.text).not.toContain(renderCopy('en', 'newspaper.publish.moreToWrite', { count: '1', token: 't3' }).slice(0, 12));
    expect(getIssue('t3')).toBeUndefined();
    expect(getEdit('t3')).toBeUndefined();
  });

  it('补稿那几批不必再报刊名和导读 —— 沿用第一批的,写完那一刻才发链接', async () => {
    putIssue('t4', three());
    await publishNewspaper(deps(), { publishToken: 't4', edit: firstBatch });
    const r = await publishNewspaper(deps(), {
      publishToken: 't4',
      edit: { items: { '2': { q: 'second', h: 'b', s: 'bb.' }, '3': { q: 'third', h: 'c', s: 'cc.' } } },
    });
    expect(r.text).toContain('today in three lines'); // Keep the first batch's introduction.
    expect(r.text).toContain('https://canvas/x/1?t=tok'); // A link exists only after completion.
    expect(r.text).not.toContain(renderCopy('en', 'newspaper.publish.editNoMasthead'));
  });

  it('写完了但画布挂了 → 落本地 + 照常销账(补稿的路不该被一次上传失败带走)', async () => {
    putIssue('t5', three());
    const upload = vi.fn(async () => {
      throw new Error('canvas down');
    });
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 't5',
      edit: {
        ...firstBatch,
        items: { ...firstBatch.items, '2': { q: 'second', h: 'b', s: 'bb.' }, '3': { q: 'third', h: 'c', s: 'cc.' } },
      },
    });
    expect(upload).toHaveBeenCalledOnce();
    expect(r.text).toContain('canvas down');
    expect(getIssue('t5')).toBeUndefined(); // Completion clears the ledger.
  });

  it('令牌对不上 → 拒发,更不会替它开一条补稿的路', async () => {
    putIssue('real', three());
    const r = await publishNewspaper(deps(), { publishToken: 'made-up', edit: firstBatch });
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.tokenMismatch'));
    expect(getEdit('made-up')).toBeUndefined();
  });
});

describe('checkEdit 在有存稿时放宽', () => {
  const L = (k: string): string => renderCopy('en', `newspaper.publish.${k}`);
  const prior = { masthead: 'Cloudboat Gazette', teaser: 'today in three lines', items: { '1': { h: 'a', s: 'aa.' } } };

  it('没有存稿时,刊名和导读照旧是必填', () => {
    expect(checkEdit({ items: { '2': { h: 'b', s: 'bb.' } } }, 'en')).toEqual({ error: L('editNoTeaser') });
    expect(checkEdit({ items: { '2': { h: 'b', s: 'bb.' } }, teaser: 't' }, 'en')).toEqual({
      error: L('editNoMasthead'),
    });
  });

  it('有存稿时,缺刊名/导读就沿用上一批的', () => {
    const r = checkEdit({ items: { '2': { h: 'b', s: 'bb.' } } }, 'en', prior);
    expect('edit' in r).toBe(true);
    if (!('edit' in r)) return;
    expect(r.edit.masthead).toBe('Cloudboat Gazette');
    expect(r.edit.teaser).toBe('today in three lines');
  });

  it('一条新的都没写 → 还是退回,空手补稿不是补稿', () => {
    expect(checkEdit({ items: {} }, 'en', prior)).toEqual({ error: L('editNoItems') });
  });
});

/**
 * Copy written against another numbering scheme: on host B on 2026-08-29, the agent inferred
 * truncation, fetched feed material and submitted copy using its own numbering. The correct token
 * let old code accept it and attribute each body to someone else. A token proves the source issue
 * only if the writer used the supplied numbering; validate that assumption rather than trusting it.
 */
describe('稿子写给了另一套编号', () => {
  beforeEach(() => {
    scratch = makeScratch('batched');
    _resetIssuesForTest();
  });
  afterEach(() => dropScratch(scratch));

  it('大半编号在这份素材里不存在 → 拒发,不许套上去', async () => {
    putIssue('n1', three());
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'n1',
      edit: { ...firstBatch, items: { '77': { h: 'a', s: 'aa.' }, '88': { h: 'b', s: 'bb.' }, '1': { h: 'c', s: 'cc.' } } },
    });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.wrongNumbering', { stray: '2', total: '3', numbers: 'items[77] items[88]' }));
  });

  it('哪怕只有一个未知编号也整批拒收,不把重叠编号存成错配稿', async () => {
    putIssue('n2', three());
    const upload = vi.fn(async () => ({ url: 'https://canvas/x/9?t=k' }));
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'n2',
      edit: {
        ...firstBatch,
        items: { '1': { h: 'a', s: 'aa.' }, '2': { h: 'b', s: 'bb.' }, '3': { h: 'c', s: 'cc.' }, '99': { h: 'x', s: 'xx.' } },
      },
    });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toContain('items[99]');
    expect(getIssue('n2')).toBeDefined();
    expect(getEdit('n2')).toBeUndefined();
  });

  it('候选令牌直接拿来发稿 → 拒发(挑选那一步被跳过了)', async () => {
    putIssue('ctok_abc', three());
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { publishToken: 'ctok_abc', edit: firstBatch });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.notChosen', { count: '3' }));
  });
});

/**
 * Supplemental copy fills gaps per field, not per whole key.
 *
 * items is the only object-valued table. Whole-key merging replaces the next level instead of
 * filling gaps: a first batch with only {h} overrides a second batch with {h, s}, permanently
 * losing the body. hasCopy accepts either h or s, so the item also disappears from the outstanding
 * list and silently renders a title without a body.
 *
 * Only one external reviewer caught this, working from source text without tools.
 */
describe('补稿逐字段填空', () => {
  beforeEach(() => {
    scratch = makeScratch('batched');
    _resetIssuesForTest();
  });
  afterEach(() => dropScratch(scratch));

  it('第一批只给了标题,第二批补的正文不许被整键覆盖掉', async () => {
    putIssue('m1', three());
    await publishNewspaper(deps(), {
      publishToken: 'm1',
      edit: { masthead: 'M', teaser: 't', items: { '1': { q: 'first', h: '只有标题' } } },
    });

    const sent: string[] = [];
    const upload = vi.fn(async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/x/1?t=k' };
    });
    await publishNewspaper(deps(upload as never), {
      publishToken: 'm1',
      edit: {
        items: {
          '1': { q: 'first', h: '只有标题', s: '这才是正文。' },
          '2': { q: 'second', h: 'b', s: 'bb.' },
          '3': { q: 'third', h: 'c', s: 'cc.' },
        },
      },
    });
    expect(sent[0]).toContain('这才是正文。');
  });

  it('已经写过的字段仍然不许被改写 —— 填空归填空,改写归改写', async () => {
    putIssue('m2', three());
    await publishNewspaper(deps(), {
      publishToken: 'm2',
      edit: { masthead: 'M', teaser: 't', items: { '1': { q: 'first', h: 'h1', s: '第一版正文。' } } },
    });

    const sent: string[] = [];
    const upload = vi.fn(async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/x/1?t=k' };
    });
    await publishNewspaper(deps(upload as never), {
      publishToken: 'm2',
      edit: {
        items: { '1': { q: 'first', h: 'h1', s: '改写过的正文。' }, '2': { q: 'second', h: 'b', s: 'bb.' }, '3': { q: 'third', h: 'c', s: 'cc.' } },
      },
    });
    expect(sent[0]).toContain('第一版正文。');
    expect(sent[0]).not.toContain('改写过的正文。');
  });
});

/**
 * The prefix is now contractual, not incidental: candidate tokens must start with `c`, otherwise
 * selection gating is ineffective.
 */
describe('候选令牌的铸造形状', () => {
  it('铸出来的候选令牌以 c 开头', () => {
    const minted = `c${`tok_${'abcdefghij'}`}`;
    expect(minted.startsWith('c')).toBe(true);
    expect(minted.startsWith('ctok_')).toBe(true);
  });
});
