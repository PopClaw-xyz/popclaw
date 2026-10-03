/**
 * The agent-facing brief, v0.2. What matters here is what the agent is and is
 * **not** handed: the words to write, the tier to write them to, and not one URL,
 * class name or layout instruction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildNewspaperPrompt } from '../../../src/newspaper/build-newspaper-prompt.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { issue, item } from './_issue-fixture.js';
import type { IssueData } from '../../../src/newspaper/issue.js';

const mat = (key: string, vars: Record<string, string> = {}): string =>
  renderCopy('zh-CN', `newspaper.material.${key}`, vars);

const brief = (i: IssueData = issue(), over: Partial<{ contentRules: string; leadMax: number }> = {}): string =>
  buildNewspaperPrompt(i, {
    contentRules: '',
    publishToken: 'tok_x',
    leadMax: 3,
    pickedCount: i.pulse.length,
    overBudget: false,
    ...over,
  });

describe('buildNewspaperPrompt', () => {
  beforeAll(() => setOwnerLang('zh-CN', 'config'));
  afterAll(() => setOwnerLang(undefined));

  it('交待清楚要交什么:basis、令牌、edit 的形状、必填三样', () => {
    const p = brief();
    expect(p).toContain('popclaw_publish_newspaper');
    expect(p).toContain('tok_x');
    for (const key of ['basis', 'masthead', 'edition', 'weather', 'leads', 'items', 'pulls', 'xrefs', 'deckNotes', 'newbies', 'teaser']) {
      expect(p).toContain(`"${key}"`);
    }
    expect(p).toContain('`masthead`, `items` and `teaser` are required');
  });

  /**
   * 2026-09-10/11 真机:编号全合法,摘要却挂到了别人名下(Quanta 的进了 MKBHD 的
   * [100])。数字校验看不见这种事,能看见的只有「稿子必须引到自己那条素材」。
   * 所以 edit 模板里每条多一个 `q`,规则里说清它会被核。
   */
  it('每条稿子的形状带上 `q`,并说清它会被核 —— 这是唯一治得了串位的那一刀', () => {
    const p = brief();
    expect(p).toContain('"q"');
    expect(p).toContain('**`q` is the anchor.**');
    expect(p).toContain("publish checks `q` against that very item's body");
    expect(p).toContain("each with its own `q`"); // 续批同样要带
    // 从哪抄、抄多少、什么不算数 —— 三样都说死,否则写作端会去抄标签、抄两字、
    // 抄两条共有的那段开头。
    expect(p).toContain('copy it from the text after `正文:` (never the label)');
    expect(p).toContain('at least about four English words or five Chinese characters');
    expect(p).toContain('a passage that other items also contain does not count');
    expect(p).toContain('`pulls` is the quotation the page prints');
  });

  /**
   * 这是整个 v0.2 的地基：模型碰不到 URL，就没有什么可编造的，F2 那套检查才敢整套删掉。
   * 2026-09-06 r7:洗令牌的信道依旧,但指令不再停在「可以不带令牌」——素材页把该期
   * basis(= 账本令牌)印进 edit 模板并下令原样带回;basis 是 edit 里的普通字段,不是
   * *_token 工具参数,脱参宿主洗不掉。令牌降回括号里的可选说明。
   */
  it('不再命令照抄令牌:指令要的是 basis(edit 里的普通字段,洗不掉),令牌只以可选说明出现', () => {
    const p = brief();
    expect(p).not.toContain('with publish_token="');
    expect(p).toContain('**Copy the `basis` value below into every edit you hand in, verbatim**');
    expect(p).toContain('"basis": "tok_x"'); // 该期 basis 印在 edit 模板首行 —— 编号属于哪页,它说了算
    expect(p).toContain('the basis needs no token at all');
    expect(p).toContain('tok_x'); // 令牌仍然印 —— 传得了的宿主用它精确绑定
  });

  it('首手交稿量指导:先交一批再续,不再许诺「约30条安全」(deepseek-v4-flash 32条死在半路)', () => {
    const p = brief();
    expect(p).toContain('About a dozen items per hand-in');
    expect(p).not.toContain('a safe amount to promise');
  });

  it('一个 URL 都不给 —— 素材里有的链接也不给', () => {
    const p = brief(
      issue({
        pulse: [item({ media: ['https://cdn/x.jpg'], platformProfileUrl: 'https://x.com/levelsio' })],
        houseLetters: [{ houseSlug: 'house-me', fromShort: 'a#b', dateLabel: 'd', body: 'x', links: ['https://w/1'] }],
        mantles: [{ houseSlug: 'house-me', level: 1, text: '蒂法在家', url: 'https://w/h/1' }],
        homeSections: [{ houseSlug: 'house-me', asOf: '14:00', homes: [{ name: '小屋', visitUrl: 'https://w/h/2', owner: '#z' }] }],
      }),
    );
    expect(p).not.toContain('http');
  });

  it('版面的活一句都不再念给它听', () => {
    const p = brief();
    for (const gone of ['<a ', '</a>', '<div', 'class=', '.card', '.mantle', '--paper:', 'onerror', 'viewport']) {
      expect(p).not.toContain(gone);
    }
    expect(p).toContain('popclaw lays out the page');
  });

  it('每条带密度档,模型照档写长短', () => {
    const p = brief(issue({ pulse: [item({ tier: 'card' }), item({ author: 'b', sigil: 'zz', tier: 'brief' })] }));
    expect(p).toContain(`${mat('pulse.author', { i: '1', who: 'levelsio#65v29fn1' })} · ${mat('tier.card')}`);
    expect(p).toContain(`${mat('pulse.author', { i: '2', who: 'b#zz' })} · ${mat('tier.brief')}`);
  });

  /** 坊事件由版面照坊自报的字段排 —— 让模型重写它，等于请它破忠实那条铁律。 */
  it('坊事件不进简报,序号仍是它在 issue 里的位置', () => {
    const p = brief(
      issue({
        pulse: [
          item({ houseFields: { place_name: '山塘街' }, kind: 'house:world.encounter' }),
          item({ author: 'b', sigil: 'zz' }),
        ],
      }),
    );
    expect(p).toContain(mat('pulse.head', { count: '1' }));
    expect(p).toContain(mat('pulse.author', { i: '2', who: 'b#zz' })); // 第 2 条仍叫 [2]
    expect(p).not.toContain('山塘街');
  });

  it('名录只报「属于人」的那几格,头像与主页留给版面', () => {
    const p = brief(issue({ pulse: [item({ followerCount: 82_000, verified: true, isFollowing: true })] }));
    expect(p).toContain(mat('cast.head', { label: mat('cast.label'), count: '1' }));
    expect(p).toContain('8.2 万粉'); // 数字按主人的语言本地化
    expect(p).toContain('verified✓');
    expect(p).toContain('follow state: following');
    expect(p).not.toContain('unavatar');
  });

  it('leadMax 照主人的旋钮说给它听', () => {
    expect(brief(issue(), { leadMax: 1 })).toContain('at most 1');
  });

  it('content.md 原样附在后面;没有就整块不出', () => {
    expect(brief(issue(), { contentRules: '## 我的规矩' })).toContain('## 我的规矩');
    expect(brief()).not.toContain('[Content rules');
  });

  it('语言指令自带一份,且只有一份', () => {
    const p = brief(issue({ language: 'zh-CN' }));
    expect(p.split('Speak to the owner in').length - 1).toBe(1);
    expect(p).toContain('zh-CN');
  });

  it('en 主人拿到的是英文那套槽', () => {
    const p = brief(issue({ language: 'en-US', pulse: [item({ tier: 'card' })] }));
    expect(p).toContain(renderCopy('en', 'newspaper.material.tier.card'));
    expect(p).toContain(renderCopy('en', 'newspaper.material.cast.label'));
  });

  it('待回列出来只为让 teaser 说得准,收信人与预览照给', () => {
    const p = brief(issue({ pings: [{ fromShort: '朱雀#a1b2', bodyPreview: '在吗' }] }));
    expect(p).toContain(mat('pings.head', { count: '1', letters: '' }));
    expect(p).toMatch(/\[1\] 朱雀#a1b2: 在吗/);
  });

  it('坊分布给出来,deckNotes 才有 slug 可用', () => {
    const p = brief(issue({ byHouse: { 'house-me': 1, 'house-world': 0 } }));
    expect(p).toContain(mat('houseCount', { slug: 'house-world', count: '0' }));
  });

  it('计数照实说:收编总数进钩子,上版条数进素材头', () => {
    const p = brief(issue({ totalCount: 718, pulse: [item(), item({ author: 'b', sigil: 'zz' })] }));
    expect(p).toContain('**718 items** gathered');
    expect(p).toContain(mat('pulse.head', { count: '2' }));
  });

  it('无署名条目照旧走「(无署名) · 平台」,绝不借名字', () => {
    const p = brief(issue({ pulse: [item({ author: '', sigil: '', platform: 'rss' })] }));
    expect(p).toContain(mat('pulse.author', { i: '1', who: mat('pulse.unattributed', { platform: 'rss' }) }));
  });

  /** 宿主截断保头不保中 —— 这条防惊慌的话必须在被切掉的位置之前。 */
  it('防截断那段话排在最前面(宿主要切也切不到它)', () => {
    const p = brief();
    expect(p.indexOf('[IF THIS MATERIAL IS CUT SHORT]')).toBeLessThan(p.indexOf(mat('pulse.head', { count: '1' })));
  });
});
