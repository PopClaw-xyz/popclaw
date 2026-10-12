/**
 * Batch markers and the missing case: suspecting truncation without an explanation (2026-09-13).
 *
 * That workshop run returned no receipt: the writer claimed both the 155-item candidate page
 * and material page were truncated, reduced its selections twice, then submitted nothing and
 * asked the owner to raise the return limit. Measurements found no truncation: the session
 * reported a 256000-token budget; pages weighed about 16k / 23k weighted units, against a
 * 56320 target and 64000 host ceiling. No session-level truncation log appeared in that interval.
 *
 * It already had three explicit instructions: the material page's cut-short rule, childDirective's
 * batch-submission rule, and a bold complete/not-truncated assertion. It ignored all three.
 * Instead of a stronger guarantee, add two things it can verify itself:
 *   · A header stating the item count and closing line, matched by that actual footer: integrity
 *     becomes countable rather than something it must take on trust.
 *   · The missing instruction: what to do when no truncation notice or omission marker is visible
 *     but it still suspects missing content.
 *
 * These belong in separate places. Header/footer are facts about this page and belong on it.
 * The response rule is identical across pages and belongs in the workshop session's system
 * prompt (CHILD_SYSTEM_PROMPT), sent once per session. Each page pays the host's per-tool-result
 * limit. Putting the rule on each page added about 2500 weighted units; even a three-item paper
 * no longer fit the smallest 16000 tier, violating the small-paper guarantee tested in gather-materials.
 * Retain only a one-sentence pointer on the page; that is also what survives main-session fallback.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildNewspaperPrompt } from '../../../src/newspaper/build-newspaper-prompt.js';
import { buildCandidatePage } from '../../../src/newspaper/build-candidate-page.js';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { putIssue, getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
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
 * Host tail-preservation rule (OpenClaw 2026.8.2, hasImportantTail in tool-result-truncation-*.js):
 * on overflow, preserve both ends only when the last 2000 characters match its English word list
 * (error / failed / total / summary / complete / finished / done …) or end with `}`. Otherwise
 * retain only the beginning. The closing line therefore needs such a word: that is the premise
 * behind treating a missing closing line as evidence of real truncation.
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
      // Once, not twice: the header quotes the closing line rather than printing another copy.
      expect(p.split(sentinel).length - 1).toBe(2); // Header quotation + actual footer.
      // Countable: header count = number of material blocks = footer count.
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
      // It also lies within the last 2000 characters, the only region the host checks.
      expect(material(lang, 7).slice(-2000)).toMatch(HOST_KEEPS_TAIL);
      expect(candidates(lang, 9).slice(-2000)).toMatch(HOST_KEEPS_TAIL);
    });
  }

  /**
   * ⚠️ Material-page numbers retain candidate identities and may skip. Never teach the writer
   * that count equals the last number or demand contiguous numbers: that caused both machines
   * to fetch feed data to fill gaps on 2026-08-27.
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
    // The header reports the count (2), not the last item number (41).
    expect(p).toContain('本页有 2 条要你写');
  });

  /**
   * Generate the closing line after the final trim and include it in page weight. Otherwise
   * it can push the page over the limit; truncating a marker meant to prove completeness is worse than none.
   * This is not append-after-trimming: both pages are rebuilt and reweighed in full, so every weighing includes the footer.
   */
  it('裁剪之后收尾行仍在页内,且整页没有因为它超出预算', () => {
    _resetIssuesForTest();
    // ≥100k → 32000 tier, multiplied by AIM 0.88 = 28160 weighted units.
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
    expect(r.notes.join(' ')).not.toContain('does not fit one hand-over');
    expect(getIssue(r.publishToken)!.pulse).toHaveLength(60);
    expect(r.payload).toContain('page_cursor=');
    expect(weightedChars(r.payload)).toBeLessThanOrEqual(budget);
    _resetIssuesForTest();
  });
});

/**
 * The missing case.
 *
 * The old cut-short instruction assumed a visible truncation notice or omission marker.
 * That writer saw neither but still concluded the page was short; no instruction covered that state.
 *
 * The rule lives in CHILD_SYSTEM_PROMPT (English, the repository's single language for system prompts).
 * The page retains only a pointer. The two assertion groups below follow that boundary.
 *
 * Wording constraints agreed by two independent reviews; do not strengthen them:
 *   · Say this session cannot change host settings, not that no adjustable limit exists; budget environment variables exist.
 *   · Say the explanation cannot reach the owner, not that nobody reads it or stopping means no paper today.
 *     Pressure can produce empty submissions, and the renderer counts a title as written: this failure mode is real.
 *   · Do not promise unconditional completeness.
 *   · Allow an honest stop when no usable batch can be submitted; partial submission must not be the only exit.
 */
describe('「怀疑短了却找不到说明」这一格', () => {
  beforeAll(() => setOwnerLang('zh-CN', 'config'));
  afterAll(() => setOwnerLang(undefined));

  it('页面上只剩一句指路,两页两语种都印得出来', () => {
    for (const lang of LANGS) {
      expect(material(lang, 3)).toContain('page_cursor');
      expect(candidates(lang, 3)).toContain('page_cursor');
    }
  });

  /**
   * The page pays the host's per-result limit, so the pointer must be one sentence.
   * Cap it at 200 weighted units: enough for a sentence, not a duplicate of the rule.
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
     * This exit already existed but the writer was never told: q anchors individual items, not whole pages.
     * Items whose bodies are readable can therefore be submitted regardless of what happened to the rest.
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
      // Neither false claims nor submission pressure may return.
      expect(CHILD_SYSTEM_PROMPT).not.toMatch(/no limit (that )?can be raised/i);
      expect(CHILD_SYSTEM_PROMPT).not.toMatch(/nobody reads/i);
      expect(CHILD_SYSTEM_PROMPT).not.toMatch(/there is no paper today/i);
      expect(CHILD_SYSTEM_PROMPT).not.toMatch(/with no exceptions/i);
    });
  });
});
