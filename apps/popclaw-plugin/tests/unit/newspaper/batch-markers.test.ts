/**
 * 批次标记 + 「怀疑短了却找不到说明」那一格(2026-09-13)。
 *
 * 那天的车间跑完没有回执:写作端说候选页(155 条)和素材页都被截断了,两次削减选题,
 * 最后交白卷,让主人去调大返回上限。事后量下来什么都没被截 —— 会话自报 256000 token
 * 预算,两页分别约 16k / 23k 加权单位,目标 56320、宿主上限 64000,宿主的会话级截断
 * 日志在那个时段根本没出现过。
 *
 * 关键在于:它当时手上已经有三条明确指令(素材页的 cut-short、childDirective 的分批
 * 交稿、页面上加粗印着的「完整、未被截断」),三条全被无视了。所以这一刀不是把保证
 * 喊得更响,而是补两样它自己能核的东西:
 *   · 页首说清本页几条、以哪一行收尾;页尾就是那一行 —— 完整性从「听我们保证」变成
 *     「自己数得出来」;
 *   · 真正缺的那一格:既没有截断提示、也没有省略标记、却仍然怀疑短了,该怎么办。
 *
 * 这两样分处两地,而且必须分处两地。页首/页尾是**这一页的事实**,只有这一页说得出来,
 * 所以印在页上;「该怎么办」是**行为规则**,每页一模一样,所以落在车间会话的系统提示
 * (CHILD_SYSTEM_PROMPT)里 —— 那份提示每会话只发一次,而页面要算进宿主的单条工具返回
 * 上限。把规则印在页上那一版给每一页平添约 2500 加权单位,三条素材的小报就再也塞不进
 * 最小档(16000),而「小报永远塞得下」正是 gather-materials 那条测试存在的理由。
 * 页面上只留一句指路,也是回退到主会话出报时唯一还剩的一句。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildNewspaperPrompt } from '../../../src/newspaper/build-newspaper-prompt.js';
import { buildCandidatePage } from '../../../src/newspaper/build-candidate-page.js';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { putIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { weightedChars } from '../../../src/newspaper/gather-materials.js';
import {
  noteContextTokenBudget,
  pageBudgetNow,
  _resetBudgetForTest,
} from '../../../src/newspaper/host-budget.js';
import { CHILD_SYSTEM_PROMPT } from '../../../src/newspaper/dedicated-session.js';
import { renderCopy, type Lang } from '../../../src/lexicon/index.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { issue, item } from './_issue-fixture.js';

const LANGS: Lang[] = ['zh-CN', 'en'];

const material = (lang: Lang, count: number, token = 'tok_x'): string =>
  buildNewspaperPrompt(
    issue({
      language: lang === 'en' ? 'en-US' : 'zh-CN',
      pulse: Array.from({ length: count }, (_, i) =>
        item({ eventId: `e${i + 1}`, text: `post ${i + 1}` }),
      ),
    }),
    { contentRules: '', publishToken: token, leadMax: 3, pickedCount: count, overBudget: false },
  );

const candidates = (lang: Lang, count: number, token = 'ctok_x'): string =>
  buildCandidatePage(
    issue({
      language: lang === 'en' ? 'en-US' : 'zh-CN',
      pulse: Array.from({ length: count }, (_, i) =>
        item({ eventId: `e${i + 1}`, text: `post ${i + 1}`, author: `a${i + 1}`, sigil: `s${i + 1}` }),
      ),
    }),
    {
      tasteText: '',
      bondLines: [],
      publishToken: token,
      suggestMin: 20,
      suggestMax: 40,
      floor: 15,
      perAuthorMax: 6,
      budget: pageBudgetNow(),
      dayTotal: count,
      overBudget: false,
    },
  );

/**
 * 宿主的保尾判据(openclaw 2026.8.2,`tool-result-truncation-*.js` 的 `hasImportantTail`):
 * 超限时只有当**末尾 2000 字符**命中那张英文词表(error / failed / total / summary /
 * complete / finished / done …,或以 `}` 收束)才保头保尾,否则一律只保头。
 * 所以收尾行必须自带一个这样的词——这正是「收尾行不见 = 真被截过」成立的前提。
 */
const HOST_KEEPS_TAIL =
  /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b|\b(total|summary|result|complete|finished|done)\b/;

describe('批次标记:页首报数、页尾收尾', () => {
  beforeEach(() => _resetBudgetForTest());
  afterEach(() => _resetBudgetForTest());

  for (const lang of LANGS) {
    it(`[${lang}] 素材页:页首说清本页几条,页尾就是它点名的那一行,后面再无一字`, () => {
      const p = material(lang, 7);
      const sentinel = renderCopy(lang, 'newspaper.material.batch.sentinel', {
        count: '7',
        id: 'tok_x',
      });
      expect(p).toContain(renderCopy(lang, 'newspaper.material.batch.head', { count: '7', sentinel }));
      expect(p.endsWith(sentinel)).toBe(true);
      // 一次,不是两次:页首那句是**引用**收尾行,不是又印一份。
      expect(p.split(sentinel).length - 1).toBe(2); // 页首引用 + 页尾本体
      // 数得出来:页首报的条数 = 素材块的条数 = 收尾行里的条数。
      expect([...p.matchAll(/^\[\d+\] (?:author|作者): /gm)]).toHaveLength(7);
    });

    it(`[${lang}] 候选页:同一对标记,编号 1..N 连号`, () => {
      const p = candidates(lang, 9);
      const sentinel = renderCopy(lang, 'newspaper.candidates.batch.sentinel', {
        count: '9',
        id: 'ctok_x',
      });
      expect(p).toContain(renderCopy(lang, 'newspaper.candidates.batch.head', { count: '9', sentinel }));
      expect(p.endsWith(sentinel)).toBe(true);
    });

    it(`[${lang}] 收尾行自带宿主保尾所需的英文关键词 —— 否则「收尾行不见 = 被截」不成立`, () => {
      for (const key of ['newspaper.material.batch.sentinel', 'newspaper.candidates.batch.sentinel']) {
        expect(renderCopy(lang, key, { count: '3', id: 'x' })).toMatch(HOST_KEEPS_TAIL);
      }
      // 而且它确实落在末尾 2000 字符之内(宿主只看那一截)。
      expect(material(lang, 7).slice(-2000)).toMatch(HOST_KEEPS_TAIL);
      expect(candidates(lang, 9).slice(-2000)).toMatch(HOST_KEEPS_TAIL);
    });
  }

  /**
   * ⚠️ 素材页的编号沿用候选页身份、本来就跳号。绝不能教写作端「条数 = 最后一个编号」,
   * 也绝不能要求编号连续 —— 那正是 2026-08-27 两台机器跑去 feed「补全」的起点。
   */
  it('素材页页首明说会跳号,且从不把条数等同于最后一个编号', () => {
    const i = issue({
      pulse: [
        item({ eventId: 'a', text: 'one', itemNumber: 3 }),
        item({ eventId: 'b', text: 'two', itemNumber: 41 }),
      ],
    });
    const p = buildNewspaperPrompt(i, {
      contentRules: '',
      publishToken: 'tok_skip',
      leadMax: 3,
      pickedCount: 2,
      overBudget: false,
    });
    const head = renderCopy('zh-CN', 'newspaper.material.batch.head', {
      count: '2',
      sentinel: renderCopy('zh-CN', 'newspaper.material.batch.sentinel', { count: '2', id: 'tok_skip' }),
    });
    expect(head).toContain('跳号');
    expect(p).toContain(head);
    // 页首报的是条数(2),不是最后一个编号(41)。
    expect(p).toContain('本页有 2 条要你写');
  });

  /**
   * 收尾行在**最终一次裁剪之后**生成,并且照样计入页面重量 —— 否则它自己就可能是
   * 把一页推过上限的那一根稻草,而一张「证明没被截」的标记被截掉,比没有还坏。
   * 做法上不是「裁完再追加」:两页都是整页重建 + 重新称重,收尾行天然在每一次称量里。
   */
  it('裁剪之后收尾行仍在页内,且整页没有因为它超出预算', () => {
    _resetIssuesForTest();
    // ≥100k → 32000 档,再乘 AIM 0.88 = 28160 加权单位。
    noteContextTokenBudget('s1', 100_000);
    const budget = pageBudgetNow('s1');
    const long = 'x'.repeat(900);
    putIssue(
      'ctok_trim',
      issue({
        pulse: Array.from({ length: 60 }, (_, i) =>
          item({
            eventId: `t${i}`,
            text: `${long} ${i}`,
            author: `a${i}`,
            sigil: `s${i}`,
            authorPopclawId: `pid-${i}`,
          }),
        ),
      }),
    );
    const r = buildIssueFromPicks('ctok_trim', Array.from({ length: 60 }, (_, i) => i + 1), {
      mintToken: () => 'tok_trim',
      contentRules: '',
      leadMax: 3,
      perAuthorMax: 6,
      floor: 15,
      topUpTo: 15,
      sessionKey: 's1',
    });
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.notes.join(' ')).toContain('does not fit one hand-over'); // 真的裁过
    const shown = [...r.payload.matchAll(/^\[\d+\] 作者: /gm)].length;
    expect(shown).toBeLessThan(60);
    const sentinel = renderCopy('zh-CN', 'newspaper.material.batch.sentinel', {
      count: String(shown),
      id: 'tok_trim',
    });
    // 收尾行报的是**裁剪之后**的条数,而且是整页的最后一行。
    expect(r.payload.endsWith(sentinel)).toBe(true);
    expect(weightedChars(r.payload)).toBeLessThanOrEqual(budget);
    _resetIssuesForTest();
  });
});

/**
 * 真正缺的那一格。
 *
 * 原来的 cut-short 指令的前提是「你**看见**了截断提示或省略标记」;那天的写作端两样
 * 都没看见,却仍然认定页面短了 —— 这个状态下没有任何一句话告诉它该怎么办。
 *
 * 规则本体在 CHILD_SYSTEM_PROMPT(英文,系统提示在本仓是英文单一来源);页面上只剩
 * 一句指路。下面两组断言按这条分界走。
 *
 * 措辞红线(两条独立评审共同的结论,勿「加强」):
 *  · 说「本会话改不了宿主设置」,不说「没有上限可调」—— 预算环境变量确实存在,那是假话;
 *  · 说「解释送不到主人手上」,不说「没人读你」「停下来就今天没有报纸」—— 逼单会把模型
 *    推去交空壳稿,而渲染器认标题即算写过,那个失败模式是真的;
 *  · 不给「绝无例外」式的完整性承诺;
 *  · 交不出可用的一批时,允许老实收场 —— 不能把「交一批部分稿」做成唯一出口。
 */
describe('「怀疑短了却找不到说明」这一格', () => {
  beforeAll(() => setOwnerLang('zh-CN', 'config'));
  afterAll(() => setOwnerLang(undefined));

  it('页面上只剩一句指路,两页两语种都印得出来', () => {
    for (const lang of LANGS) {
      expect(material(lang, 3)).toContain(renderCopy(lang, 'newspaper.material.cutShort.suspected'));
      expect(candidates(lang, 3)).toContain(
        renderCopy(lang, 'newspaper.candidates.cutShort.suspected'),
      );
    }
  });

  /**
   * 这一页要付宿主的单条返回上限,所以指路只能是一句。上限定在 200 加权单位:
   * 够写一句,不够把规则再抄一遍回来。
   */
  it('那一句必须一直是一句 —— 行为规则不许再按页计费', () => {
    for (const lang of LANGS) {
      for (const page of ['material', 'candidates'] as const) {
        const line = renderCopy(lang, `newspaper.${page}.cutShort.suspected`);
        expect(weightedChars(line)).toBeLessThan(200);
      }
    }
  });

  it('指路给的是三件事:照着手上的做、不要重取、不要停', () => {
    expect(renderCopy('en', 'newspaper.material.cutShort.suspected')).toContain(
      'Work with the material you can read and hand that in',
    );
    expect(renderCopy('en', 'newspaper.material.cutShort.suspected')).toContain(
      'do not fetch this page again',
    );
    expect(renderCopy('en', 'newspaper.material.cutShort.suspected')).toContain('do not stop');
    const z = renderCopy('zh-CN', 'newspaper.material.cutShort.suspected');
    expect(z).toContain('就着读得到的素材往下写并交上去');
    expect(z).toContain('不要重取');
    expect(z).toContain('也不要停');
    const zc = renderCopy('zh-CN', 'newspaper.candidates.cutShort.suspected');
    expect(zc).toContain('就着读得到的编号挑完并交上去');
    expect(zc).toContain('不要重取候选');
    expect(zc).toContain('也不要停');
  });

  describe('规则本体:车间会话的系统提示', () => {
    it('给的是三件事:照着手上的做、不要重取、不要停', () => {
      expect(CHILD_SYSTEM_PROMPT).toContain('work with what you have');
      expect(CHILD_SYSTEM_PROMPT).toContain('do not request that page again');
      expect(CHILD_SYSTEM_PROMPT).toContain('do not stop');
    });

    /**
     * 那条出路本来就存在,只是从没跟写作端讲过:`q` 是**逐条**锚,不是整页锚,
     * 所以读得到正文的那几条,不管其余出了什么事都交得上去。
     */
    it('把已有的补救讲明白:逐条锚、交得动的先交', () => {
      expect(CHILD_SYSTEM_PROMPT).toContain('`q` is checked per item');
      expect(CHILD_SYSTEM_PROMPT).toContain('never against the page as a whole');
      expect(CHILD_SYSTEM_PROMPT).toContain(
        'Hand in the items you can verify and leave out the ones you cannot',
      );
    });

    it('允许老实收场,并明说「只有标题」的空壳稿是不许交的', () => {
      expect(CHILD_SYSTEM_PROMPT).toContain('say which step you reached and stop there');
      expect(CHILD_SYSTEM_PROMPT).toContain('Never hand in a headline with no summary');
      expect(CHILD_SYSTEM_PROMPT).toContain('counts as written on its headline alone');
    });

    it('准确优先于施压:只说这个会话做不到什么,不谎称上限不存在,也不拿主人施压', () => {
      expect(CHILD_SYSTEM_PROMPT).toContain('cannot change host settings');
      expect(CHILD_SYSTEM_PROMPT).toContain('cannot wait for the owner to answer here');
      expect(CHILD_SYSTEM_PROMPT).toContain('your explanation does not reach him');
      // 假话与逼单,一个都不许回来。
      expect(CHILD_SYSTEM_PROMPT).not.toMatch(/no limit (that )?can be raised/i);
      expect(CHILD_SYSTEM_PROMPT).not.toMatch(/nobody reads/i);
      expect(CHILD_SYSTEM_PROMPT).not.toMatch(/there is no paper today/i);
      expect(CHILD_SYSTEM_PROMPT).not.toMatch(/with no exceptions/i);
    });
  });
});
