/**
 * 稿子挂到别人名下 —— 2026-09-10/11 真机的形态,以及唯一治得了它的那道闸。
 *
 * 素材页的编号是对的,写手用的每个编号也都合法,可它照样把 Quanta 的摘要填进了
 * MKBHD 的 [100],把 MKBHD 的填进了 verge 的 [120],还有一次把同一作者相邻的
 * [1][2] 对调。数字校验从原理上就看不见这种事:编号本身没错。
 *
 * 所以每条稿子要带一个 `q` —— 从**它自己**那条素材正文里原样抄下的一段话。
 * publish 拿它去核那一条的正文:核不上的,只退这一条,同批其余照收;整批都核
 * 不上的,一个字也不存、账本也不消耗,并把那几条的素材原样重贴一遍——回执里
 * 点名一个它已经看不见的编号,等于逼它凭印象写,而凭印象写正是串位的来处。
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

/** 三条素材,三个作者,三段互不相干的正文 —— 串位才有得串。 */
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

/** 回执要点名「为什么」——四种毛病长得一模一样的话,写作端只能瞎猜一个改。 */
const why = (reason: string): string => renderCopy('en', `newspaper.publish.anchorReason.${reason}`);
const refused1 = (n: number, reason: string): string => refusedCopy(1, `[${n}] (${why(reason)})`);

/**
 * 同一个人相邻两条,开头那串 @ 是一模一样的 —— 正是 2026-09-10/11 真机上被对调的
 * 那种形态。抄公共开头当锚,两条都核得上,对调照样过闸。
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
          // 真机的形态:合法编号 + 别人的正文摘要 + 别人正文里的话。
          '2': { q: Q1, h: 'the camera again', s: 'the phone camera, written under Quanta.' },
          '3': { q: Q3, h: 'the console', s: 'a brighter screen.' },
        },
      },
    });
    expect(r.text).toContain(refused1(2, 'notInBody'));
    // 被退的那条要连素材一起重贴:作者行 + 正文,它才不必凭印象重写。
    expect(r.text).toContain('QuantaMagazine#2222bbbb');
    expect(r.text).toContain('Mathematicians have finally settled the sphere packing question');
    const saved = getEdit('a2')!;
    expect(Object.keys(saved.items!).sort()).toEqual(['1', '3']); // 串位那条一个字也没存
    expect(upload).not.toHaveBeenCalled(); // 还欠第 2 条,这一期当然不发
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
    expect(getEdit('a7')).toBeUndefined(); // 什么都没存
    expect(getIssue('a7')).toBeDefined(); // 账本还在,原样再交一次就行
    // 重贴的是那两条,不是全期。
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
    // leads 不剔:版面本来就会忽略没稿的头版位,而填空式合并只认第一份非空的
    // leads —— 当场剔掉等于把它永久赶下头版,下一批补好了也回不来。
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
    expect(sent[0]).not.toContain('somebody else\'s summary.'); // 退掉的那版从没存在过
    expect(getIssue('a9')).toBeUndefined(); // 写完销账
  });

  it('锚抄的是两条共有的那段(同一个人相邻两条的 @ 开头)→ 两条都退,对调不许蒙混过去', async () => {
    putIssue('b1', twins());
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'b1',
      // 稿子其实是对调的 —— 但两条的 q 都核得上,只靠「核得上」这一关它会照收。
      edit: {
        ...head,
        items: {
          '1': { q: SHARED, h: 'the filing', s: 'the court filing says so too.' },
          '2': { q: SHARED, h: 'the cut', s: 'the storefront cut is the whole argument.' },
        },
      },
    });
    expect(upload).not.toHaveBeenCalled();
    // 同一段话两条都对得上 —— 点名的理由必须是「与别的条目共有」,不是「不在正文里」。
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
   * 被退的那条仍然留在 leads 里:填空式合并只认第一份非空的 leads,当场剔掉就等于
   * 永久把它赶下头版 —— 而版面本来就会忽略没稿的头版位。
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
   * 已经存下的稿子是改不动的(填空式合并),所以重发时那条的 q 好坏都不影响版面 ——
   * 再为它报一句「没收下」,就是在教写作端去修一个它其实修不了的东西。
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
   * 重贴的素材要和素材页一个语言:那一页是按 issue.language 印的,回执却按主人的
   * 语言说话。标签换了语言,写作端手上的两份就对不上字了。
   */
  it('重贴素材用素材页的语言,不跟着回执走', async () => {
    putIssue('b6', issue({ language: 'en', pulse: [item({ text: 'first' }), item({ eventId: 'e2', author: 'b', sigil: '6666ffff', text: 'second' })] }));
    const r = await publishNewspaper({ ...deps(), lang: 'zh-CN' }, {
      publishToken: 'b6',
      edit: { ...head, items: { '1': { q: 'first', h: 'h', s: 's.' } } },
    });
    expect(r.text).toContain('body: second'); // 素材页是英文的
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
 * `pulls` 是版面直接打引号印在人名底下的那句话 —— 素材页的原话是「a sentence
 * **already present in that item's own text**」。它比摘要更该逐字:摘要看得出是转述,
 * 引号里的一句看起来就是那个人亲口说的。可它从来没被核过。
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
    expect(saved.pulls).toEqual({}); // 编的那句没存下
    expect(saved.items!['1']).toBeDefined(); // 条目照存 —— 引语的毛病不连坐正文
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
