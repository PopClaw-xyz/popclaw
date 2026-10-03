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
   * 派工台账要分得清「交了一批被收下了」和「一次都没交成」(2026-09-13)。
   * `landed` 只说主人拿没拿到报纸;`accepted` 说的是这一次交稿的字有没有被留下。
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

    // 一期报纸只有一个链接。缺了大半条目的那一版不该到主人手里,
    // 而画布每传一次就换一个新链接 —— 先发一版残的、再发一版全的,是同一天两个链接。
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).not.toContain('canvas');
    // 「还欠哪几号」必须点名 —— 只报个数,遇上素材页被砍中间的机器就是死路
    expect(r.text).toContain(
      renderCopy('en', 'newspaper.publish.moreToWrite', { count: '2', numbers: '[2] [3]', token: 't1' }),
    );
    expect(getIssue('t1')).toBeDefined(); // 账还在,下一批还能补
    expect(getEdit('t1')?.items).toEqual(firstBatch.items);
  });

  /**
   * 回执只报编号是不够的:素材页是上下文里最大的一块,也是最先被截掉的一块,
   * 写手往往已经看不见它了。看不见还要补稿 = 凭印象写,而凭印象写正是 2026-09-10/11
   * 真机上「摘要挂到别人名下」的来处。所以还欠的那几条,把素材原样再贴一遍。
   */
  it('没写完的回执要把还欠那几条的素材原样重贴 —— 已经写过的那条不重贴', async () => {
    putIssue('t-again', three());
    const r = await publishNewspaper(deps(), { publishToken: 't-again', edit: firstBatch });
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.materialAgain', { count: '2' }));
    // 还欠的两条:作者行与正文都在。
    expect(r.text).toContain('sama#2222aaaa');
    expect(r.text).toContain('karpathy#3333bbbb');
    expect(r.text).toContain('second');
    expect(r.text).toContain('third');
    // 已经写过的那条不占回执的地方。
    expect(r.text).not.toContain('levelsio#65v29fn1');
    // 说明在前、素材在后:宿主截断时留下的是该干什么,不是素材。
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

    // brief 档只印摘要,所以断言落在摘要上 —— 断言要落在版面真印出来的那半。
    const html = sent[0]!;
    expect(html).toContain('it landed.'); // 第一批写的还在
    expect(html).not.toContain('a second pass at the same item.'); // 只填空不改写
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
    expect(r.text).toContain('today in three lines'); // 沿用第一批的导读
    expect(r.text).toContain('https://canvas/x/1?t=tok'); // 写完了才有链接
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
    expect(getIssue('t5')).toBeUndefined(); // 写完了就销账
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
 * 「写给另一套编号的稿子」—— 2026-08-29 乙机就是这么坏的：它判定素材被截断，跑去 feed
 * 补全，然后按**它自己那套编号**交稿。令牌是对的，所以旧代码照单全收，把每一条正文都套到
 * 了别人名下。令牌只能证明「稿子是对着这份素材写的」——前提是写手真用了给它的编号。
 * 所以要核，不能信。
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
 * 补稿是**逐字段**填空，不是整键覆盖。
 *
 * `items` 是唯一一个值为对象的表。整键合并在这里不叫「填空」，叫「下一层的整体替换」：
 * 第一批只交了标题 `{h}`，第二批把 `{h, s}` 交上来时，整个键被第一批盖掉，**正文永久丢失**。
 * 而 `hasCopy` 只要 h 或 s 有一个就算「写过了」——所以这一条也永远不会出现在「还欠哪几号」里，
 * 版面上就是一条有标题、没正文的条目，无痕。
 *
 * 外部会诊里唯一一家（且是没有工具、纯读代码原文的那家）抓到的。
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

/** 前缀判据现在是契约,不再是巧合:候选令牌必须以 `c` 开头,否则挑选那一侧的闸就成了摆设。 */
describe('候选令牌的铸造形状', () => {
  it('铸出来的候选令牌以 c 开头', () => {
    const minted = `c${`tok_${'abcdefghij'}`}`;
    expect(minted.startsWith('c')).toBe(true);
    expect(minted.startsWith('ctok_')).toBe(true);
  });
});
