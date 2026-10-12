/**
 * Real-host misattribution, 2026-09-10/11, and the gate that can detect it. Material numbering and the
 * writer's numbers were valid, yet Quanta's summary landed at MKBHD [100], MKBHD's at verge [120], and
 * adjacent items [1][2] by one author were swapped. Numeric validation cannot see this because the
 * numbers are valid. Each edit therefore carries `q`, a verbatim passage from its own material body.
 * Publish checks it against that item: refuse only mismatches and accept the rest of the batch. If all
 * anchors fail, save nothing, consume no ledger, and reprint those items' material verbatim. Naming an
 * invisible number in the receipt forces rewriting from memory, the original cause of displacement.
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { publishNewspaper, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
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

/**
 * Three materials, three authors and unrelated bodies, allowing a detectable swap.
 */
const three = (): ReturnType<typeof issue> =>
  issue({
    pulse: [
      item({ eventId: 'e1', author: 'MKBHD', sigil: '1111aaaa', authorPopclawId: 'pid-mkbhd', text: 'The new phone camera is a genuine step up in low light.' }),
      item({ eventId: 'e2', author: 'QuantaMagazine', sigil: '2222bbbb', authorPopclawId: 'pid-quanta', text: 'Mathematicians have finally settled the sphere packing question in dimension seventeen.' }),
      item({ eventId: 'e3', author: 'verge', sigil: '3333cccc', authorPopclawId: 'pid-verge', text: 'The handheld console is getting a second revision with a brighter screen.' }),
    ],
  });

const Q1 = 'a genuine step up in low light';
const Q2 = 'settled the sphere packing question';
const Q3 = 'a second revision with a brighter screen';

const head = { masthead: 'Cloudboat Gazette', teaser: 'today in three lines' };

const refusedCopy = (count: number, numbers: string): string =>
  renderCopy('en', 'newspaper.publish.anchorRefused', { count: String(count), numbers });

/**
 * The receipt must name the reason: indistinguishable failure messages force the writer to guess what
 * to fix.
 */
const why = (reason: string): string => renderCopy('en', `newspaper.publish.anchorReason.${reason}`);
const refused1 = (n: number, reason: string): string => refusedCopy(1, `[${n}] (${why(reason)})`);

/**
 * Adjacent items by one author start with the same @ prefix, matching the real-host swaps of
 * 2026-09-10/11. Anchoring on that shared prefix matches both bodies and lets a swap pass.
 */
const twins = (): ReturnType<typeof issue> =>
  issue({
    pulse: [
      item({ eventId: 'w1', author: 'lauren', sigil: '4444dddd', text: '@TimSweeneyEpic @ParkerThayer the storefront cut is the whole argument.' }),
      item({ eventId: 'w2', author: 'lauren', sigil: '4444dddd', text: '@TimSweeneyEpic @ParkerThayer and the court filing says so too.' }),
    ],
  });

const SHARED = '@TimSweeneyEpic @ParkerThayer';

describe('每条稿子必须引到自己那条素材', () => {
  beforeEach(() => {
    scratch = makeScratch('anchor');
    _resetIssuesForTest();
  });
  afterEach(() => dropScratch(scratch));

  it('q 是本条正文里的话 → 照收', async () => {
    putIssue('a1', three());
    const r = await publishNewspaper(deps(), {
      publishToken: 'a1',
      edit: { ...head, items: { '1': { q: Q1, h: 'the camera', s: 'it sees in the dark.' } } },
    });
    expect(r.text).not.toContain(refused1(1, 'notInBody'));
    expect(getEdit('a1')?.items?.['1']?.s).toBe('it sees in the dark.');
  });

  it('q 抄的是另一条的正文 → 只退这一条,同批其余照存,回执点名并把它的素材重贴一遍', async () => {
    putIssue('a2', three());
    const upload = vi.fn(async () => ({ url: 'https://canvas/x/2?t=tok' }));
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'a2',
      edit: {
        ...head,
        items: {
          '1': { q: Q1, h: 'the camera', s: 'it sees in the dark.' },
          // Real-host shape: a valid number, another item's summary and another item's body quotation.
          '2': { q: Q1, h: 'the camera again', s: 'the phone camera, written under Quanta.' },
          '3': { q: Q3, h: 'the console', s: 'a brighter screen.' },
        },
      },
    });
    expect(r.text).toContain(refused1(2, 'notInBody'));
    // Reprint the refused item's author line and body, so rewriting does not depend on memory.
    expect(r.text).toContain('QuantaMagazine#2222bbbb');
    expect(r.text).toContain('Mathematicians have finally settled the sphere packing question');
    const saved = getEdit('a2')!;
    expect(Object.keys(saved.items!).sort()).toEqual(['1', '3']); // No copy from the displaced item was saved.
    expect(upload).not.toHaveBeenCalled(); // Item 2 remains unwritten, so this issue must not publish.
  });

  it('压根没给 q → 一样退(锚是必填,不是可选的礼貌)', async () => {
    putIssue('a3', three());
    const r = await publishNewspaper(deps(), {
      publishToken: 'a3',
      edit: { ...head, items: { '1': { h: 'the camera', s: 'it sees in the dark.' } } },
    });
    expect(r.text).toContain(refused1(1, 'missing'));
    expect(getEdit('a3')).toBeUndefined();
  });

  it('大小写、标点、空白、表情不同照收 —— 忠实抄写不该输给一个引号', async () => {
    putIssue('a4', three());
    await publishNewspaper(deps(), {
      publishToken: 'a4',
      edit: { ...head, items: { '1': { q: '  A Genuine  “Step Up” in LOW light! 📷 ', h: 'h', s: 's.' } } },
    });
    expect(getEdit('a4')?.items?.['1']).toBeDefined();
  });

  it('中文素材照收 —— 锚是逐字比对,不是英文分词', async () => {
    putIssue('a5', issue({ pulse: [item({ text: '猎鹰九号昨夜完成了第二十次复用发射,助推器直立落回海上平台。' })] }));
    const r = await publishNewspaper(deps(), {
      publishToken: 'a5',
      edit: { ...head, items: { '1': { q: '助推器直立落回海上平台', h: '猎鹰落回了发射台', s: '一次回收成功。' } } },
    });
    expect(r.text).not.toContain(refused1(1, 'notInBody'));
    expect(r.landed).toBe(true);
  });

  it('正文本来就短(一句「Yup」)→ 整句抄下来就算数', async () => {
    putIssue('a6', issue({ pulse: [item({ text: 'Yup' })] }));
    const r = await publishNewspaper(deps(), {
      publishToken: 'a6',
      edit: { ...head, items: { '1': { q: 'Yup', h: 'agreed', s: 'one word, and that is the whole of it.' } } },
    });
    expect(r.landed).toBe(true);
  });

  it('整批都核不上 → 一个字不存、账本不消耗、不上传,素材原样重贴给它', async () => {
    putIssue('a7', three());
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'a7',
      edit: {
        ...head,
        items: {
          '1': { q: Q2, h: 'x', s: 'xx.' },
          '2': { q: Q3, h: 'y', s: 'yy.' },
        },
      },
    });
    expect(upload).not.toHaveBeenCalled();
    expect(r.landed).toBeUndefined();
    expect(r.text).toContain(refusedCopy(2, `[1] (${why('notInBody')}) [2] (${why('notInBody')})`));
    expect(getEdit('a7')).toBeUndefined(); // Nothing was saved.
    expect(getIssue('a7')).toBeDefined(); // The ledger remains; the same edit can be resubmitted.
    // Reprint those two items, not the whole issue.
    expect(r.text).toContain('MKBHD#1111aaaa');
    expect(r.text).toContain('QuantaMagazine#2222bbbb');
    expect(r.text).not.toContain('verge#3333cccc');
  });

  it('被退那条的 pulls/xrefs/topics 一并作废 —— 稿子没落地,配件不许留下;leads 是例外', async () => {
    putIssue('a8', three());
    await publishNewspaper(deps(), {
      publishToken: 'a8',
      edit: {
        ...head,
        leads: [1, 2],
        items: {
          '1': { q: Q1, h: 'the camera', s: 'it sees in the dark.' },
          '2': { q: Q1, h: 'wrong', s: 'somebody else\'s summary.' },
        },
        pulls: { '2': 'a pull quote for an item that never landed' },
        xrefs: { '2': 'a cross-reference for an item that never landed' },
        topics: { '2': 'orphan topic' },
      },
    });
    const saved = getEdit('a8')!;
    expect(saved.pulls).toEqual({});
    expect(saved.xrefs).toEqual({});
    expect(saved.topics).toEqual({});
    // Do not remove leads: layout already ignores front-page slots without copy, and fill-only merge keeps the first nonempty
    // leads. Removing them now permanently removes their front-page placement, even if a later batch supplies the copy.
    expect(saved.leads).toEqual([1, 2]);
  });

  it('下一批带着对的 q 补上被退的那条 → 填进空位,写完就出报', async () => {
    putIssue('a9', three());
    await publishNewspaper(deps(), {
      publishToken: 'a9',
      edit: {
        ...head,
        items: {
          '1': { q: Q1, h: 'the camera', s: 'it sees in the dark.' },
          '2': { q: Q1, h: 'wrong', s: 'somebody else\'s summary.' },
          '3': { q: Q3, h: 'the console', s: 'a brighter screen.' },
        },
      },
    });
    const sent: string[] = [];
    const upload = vi.fn(async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/x/9?t=tok' };
    });
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'a9',
      edit: { items: { '2': { q: Q2, h: 'sphere packing', s: 'dimension seventeen is settled.' } } },
    });
    expect(r.landed).toBe(true);
    expect(sent[0]).toContain('dimension seventeen is settled.');
    expect(sent[0]).not.toContain('somebody else\'s summary.'); // The refused version never existed.
    expect(getIssue('a9')).toBeUndefined(); // Finish the copy and settle the ledger.
  });

  it('锚抄的是两条共有的那段(同一个人相邻两条的 @ 开头)→ 两条都退,对调不许蒙混过去', async () => {
    putIssue('b1', twins());
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'b1',
      // The edits are swapped, but both q anchors match; a match-only gate would accept them.
      edit: {
        ...head,
        items: {
          '1': { q: SHARED, h: 'the filing', s: 'the court filing says so too.' },
          '2': { q: SHARED, h: 'the cut', s: 'the storefront cut is the whole argument.' },
        },
      },
    });
    expect(upload).not.toHaveBeenCalled();
    // The same passage matches both items; the reason must be shared with another item, not absent from the body.
    expect(r.text).toContain(refusedCopy(2, `[1] (${why('ambiguous')}) [2] (${why('ambiguous')})`));
    expect(getEdit('b1')).toBeUndefined();
  });

  it('同两条,各自抄只有自己有的那段 → 照收出报', async () => {
    putIssue('b2', twins());
    const r = await publishNewspaper(deps(), {
      publishToken: 'b2',
      edit: {
        ...head,
        items: {
          '1': { q: 'the storefront cut is the whole argument', h: 'the cut', s: 'the storefront cut.' },
          '2': { q: 'and the court filing says so too', h: 'the filing', s: 'the filing agrees.' },
        },
      },
    });
    expect(r.landed).toBe(true);
  });

  it('两条正文逐字相同(转发、同一句发两遍)→ 整句抄下来就算数,不算含糊', async () => {
    const same = '@TimSweeneyEpic @ParkerThayer the storefront cut is the whole argument.';
    putIssue('b3', issue({ pulse: [item({ eventId: 'r1', text: same }), item({ eventId: 'r2', author: 'b', sigil: '5555eeee', text: same })] }));
    const r = await publishNewspaper(deps(), {
      publishToken: 'b3',
      edit: { ...head, items: { '1': { q: same, h: 'h1', s: 's1.' }, '2': { q: same, h: 'h2', s: 's2.' } } },
    });
    expect(r.landed).toBe(true);
  });

  /**
   * The refused item stays in leads: fill-only merging keeps the first nonempty leads, so removing it
   * would permanently lose its front-page slot. Layout already ignores front-page slots without copy.
   */
  it('被退的那条不许被赶出 leads —— 下一批补上稿子,它照样上头版', async () => {
    putIssue('b4', three());
    await publishNewspaper(deps(), {
      publishToken: 'b4',
      edit: {
        ...head,
        leads: [1, 2],
        items: {
          '1': { q: Q1, h: 'the camera', s: 'it sees in the dark.' },
          '2': { q: Q1, h: 'wrong', s: 'somebody else\'s summary.' },
        },
      },
    });
    const sent: string[] = [];
    const upload = vi.fn(async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/x/4?t=tok' };
    });
    await publishNewspaper(deps(upload as never), {
      publishToken: 'b4',
      edit: {
        items: {
          '2': { q: Q2, h: 'sphere packing', s: 'dimension seventeen is settled.' },
          '3': { q: Q3, h: 'the console', s: 'a brighter screen.' },
        },
      },
    });
    const leadCol = sent[0]!.split('<div class="lead-col">')[1]!.split('<div class="rail-b">')[0]!;
    expect(leadCol).toContain('dimension seventeen is settled.');
  });

  /**
   * Saved copy is immutable under fill-only merging, so resubmitting that item's good or bad q does
   * not change layout. Reporting it as unaccepted would ask the writer to fix something they cannot
   * change.
   */
  it('已经写过的那条重发时带了个错 q → 不报退稿,报纸照发', async () => {
    putIssue('b5', three());
    await publishNewspaper(deps(), {
      publishToken: 'b5',
      edit: { ...head, items: { '1': { q: Q1, h: 'the camera', s: 'it sees in the dark.' } } },
    });
    const r = await publishNewspaper(deps(), {
      publishToken: 'b5',
      edit: {
        items: {
          '1': { q: Q2, h: 'the camera', s: 'it sees in the dark.' },
          '2': { q: Q2, h: 'sphere packing', s: 'dimension seventeen is settled.' },
          '3': { q: Q3, h: 'the console', s: 'a brighter screen.' },
        },
      },
    });
    expect(r.landed).toBe(true);
    expect(r.text).not.toContain(refused1(1, 'notInBody'));
  });

  /**
   * Reprinted material must use the material page's language (issue.language), even when the receipt
   * uses the owner's language. Translated labels would keep the writer's two copies from matching
   * verbatim.
   */
  it('重贴素材用素材页的语言,不跟着回执走', async () => {
    putIssue('b6', issue({ language: 'en', pulse: [item({ text: 'first' }), item({ eventId: 'e2', author: 'b', sigil: '6666ffff', text: 'second' })] }));
    const r = await publishNewspaper({ ...deps(), lang: 'zh-CN' }, {
      publishToken: 'b6',
      edit: { ...head, items: { '1': { q: 'first', h: 'h', s: 's.' } } },
    });
    expect(r.text).toContain('body: second'); // The material page is English.
    expect(r.text).not.toContain('正文: second');
  });

  it('锚太短 → 点名的理由是「太短」,不是「不在正文里」', async () => {
    putIssue('b7', three());
    const r = await publishNewspaper(deps(vi.fn() as never), {
      publishToken: 'b7',
      edit: { ...head, items: { '1': { q: 'camera', h: 'h', s: 's.' } } },
    });
    expect(r.text).toContain(refused1(1, 'tooShort'));
  });
});

/**
 * `pulls` are quotations printed directly beneath a person's name. The material page requires a
 * sentence already present in that item's own text. They need stricter verbatim fidelity than
 * summaries: summaries are visibly paraphrased, while quotation marks imply the person's own words.
 * They had never been checked.
 */
describe('引语也要是本条的原话', () => {
  beforeEach(() => {
    scratch = makeScratch('anchor');
    _resetIssuesForTest();
  });
  afterEach(() => dropScratch(scratch));

  const notVerbatim = (numbers: string): string =>
    renderCopy('en', 'newspaper.publish.pullNotVerbatim', { numbers });

  it('编出来的引语 → 丢掉并在回执上说一句,条目本身照存', async () => {
    putIssue('p1', three());
    const r = await publishNewspaper(deps(), {
      publishToken: 'p1',
      edit: {
        ...head,
        items: { '1': { q: Q1, h: 'the camera', s: 'it sees in the dark.' } },
        pulls: { '1': 'It is the best camera we have ever tested, bar none.' },
      },
    });
    expect(r.text).toContain(notVerbatim('[1]'));
    const saved = getEdit('p1')!;
    expect(saved.pulls).toEqual({}); // The fabricated quotation was not saved.
    expect(saved.items!['1']).toBeDefined(); // The item is still saved; a quotation error does not invalidate the body.
  });

  it('真是原话的引语照存 —— 大小写、标点不同不算两句话', async () => {
    putIssue('p2', three());
    const r = await publishNewspaper(deps(), {
      publishToken: 'p2',
      edit: {
        ...head,
        items: { '1': { q: Q1, h: 'the camera', s: 'it sees in the dark.' } },
        pulls: { '1': 'The new phone camera is a GENUINE step up in low light!!!' },
      },
    });
    expect(r.text).not.toContain(notVerbatim('[1]'));
    expect(Object.keys(getEdit('p2')!.pulls!)).toEqual(['1']);
  });

  it('被退条目的引语跟着一起走,不再单独报一遍(同一件事说两次等于两件事)', async () => {
    putIssue('p3', three());
    const r = await publishNewspaper(deps(), {
      publishToken: 'p3',
      edit: {
        ...head,
        items: {
          '1': { q: Q1, h: 'the camera', s: 'it sees in the dark.' },
          '2': { q: Q1, h: 'wrong', s: 'somebody else\'s summary.' },
        },
        pulls: { '2': 'a line nobody in this issue ever wrote.' },
      },
    });
    expect(r.text).toContain(refused1(2, 'notInBody'));
    expect(r.text).not.toContain(notVerbatim('[2]'));
    expect(getEdit('p3')!.pulls).toEqual({});
  });

  /**
   * A body with nothing in it to quote — an emoji-only post, a picture-only post.
   *
   * `anchorVerdict` deliberately waives the anchor there, and for the item's own
   * copy that is right: refusing would make such an item unwritable forever. But
   * the waiver reached `pulls` too, and for a quotation the right answer is not
   * "any sentence will do", it is "no pull quote at all" — the page prints it
   * inside quotation marks under a real person's name, next to a follow button.
   */
  it('a body with nothing to quote gets NO pull quote — the waiver is for the copy, not for the quotation', async () => {
    putIssue(
      'p4',
      issue({
        pulse: [
          item({ eventId: 'e9', author: 'MKBHD', sigil: '1111aaaa', authorPopclawId: 'pid-mkbhd', text: '\ud83d\udcf7', media: ['https://x/pic.jpg'] }),
          // A second item, left unwritten, so the hand-in is a batch and the stored
          // edit is still there to look at (the same shape as the tests above).
          item({ eventId: 'e10', author: 'verge', sigil: '3333cccc', authorPopclawId: 'pid-verge', text: 'The handheld console is getting a second revision with a brighter screen.' }),
        ],
      }),
    );
    const r = await publishNewspaper(deps(), {
      publishToken: 'p4',
      edit: {
        ...head,
        items: { '1': { q: '\ud83d\udcf7', h: 'one photograph', s: 'a picture, and not a word with it.' } },
        pulls: { '1': 'It is the best camera we have ever tested, bar none.' },
      },
    });
    expect(r.text).toContain(notVerbatim('[1]'));
    const saved = getEdit('p4')!;
    expect(saved.pulls).toEqual({}); // nothing to quote → nothing in quotation marks
    expect(saved.items!['1']).toBeDefined(); // the item itself still lands: the waiver stands for its own copy
  });
});
