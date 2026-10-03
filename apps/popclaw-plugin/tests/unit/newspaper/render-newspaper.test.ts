/**
 * 版面归代码之后，法典 §自检那张清单不再是念给模型听的提醒 —— 它是这个文件里的断言。
 * 每一条都对应 `layout.md` / `content.md` 里一条硬规则。
 */
import { describe, it, expect, vi } from 'vitest';
import { renderNewspaper, unshareColophon, type NewspaperEdit } from '../../../src/newspaper/render-newspaper.js';
import { DEFAULT_STYLE, type NewspaperStyle } from '../../../src/newspaper/newspaper-style.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import type { IssueData } from '../../../src/newspaper/issue.js';
import { buildNewspaperPrompt } from '../../../src/newspaper/build-newspaper-prompt.js';
import { selectByHeat } from '../../../src/newspaper/pick-issue.js';
import { buildCandidatePage, candidateOrder } from '../../../src/newspaper/build-candidate-page.js';
import { issue, item } from './_issue-fixture.js';

const L = (key: string, vars: Record<string, string> = {}): string =>
  renderCopy('zh-CN', `newspaper.${key}`, vars);

const EDIT: NewspaperEdit = {
  masthead: '云舟江湖报',
  edition: '晚报',
  weather: ['太空行走', 'AI'],
  items: { '1': { h: '猎鹰落回了发射台', s: '第一段。\n\n第二段。' } },
  teaser: '导读',
};

const render = (
  i: IssueData = issue(),
  edit: NewspaperEdit = EDIT,
  style: Partial<NewspaperStyle> = {},
): ReturnType<typeof renderNewspaper> =>
  renderNewspaper(i, edit, { ...DEFAULT_STYLE, ...style }, 'zh-CN');

/** 某一叠的那段 HTML。 */
function deck(html: string, slug: string): string {
  const i = html.indexOf(`id="deck-${slug}"`);
  expect(i).toBeGreaterThan(-1);
  return html.slice(i, html.indexOf('</section>', i));
}

const worldIssue = (over: Partial<IssueData> = {}): IssueData =>
  issue({
    pulse: [
      item({ tier: 'card' }),
      item({
        author: '',
        houseSlug: 'house-world',
        postPageUrl: '',
        url: '',
        kind: 'house:world.Postcard',
        houseFields: { place_name: '京都', scene: '在鸭川边躲了雨', home_url: 'https://w/h/1' },
        media: ['https://cdn/p.jpg'],
      }),
    ],
    byHouse: { 'house-me': 1, 'house-world': 1 },
    ...over,
  });

describe('整报骨架', () => {
  it('报头 / 双线 / 刊次 / 气象 / 索引 / 尾花,一样不少', () => {
    const { html } = render();
    expect(html).toContain('<h1>云舟江湖报</h1>');
    expect(html).toContain('class="rule2"');
    expect(html).toContain('晚报');
    expect(html).toContain(L('page.byline'));
    expect(html).toContain('太空行走 · AI');
    expect(html).toContain('class="index"');
    expect(html).toContain(L('page.colophonShared', { count: '1' }));
  });

  // The model is the host's and a published paper sits on its share link, so
  // the colophon may claim neither "this machine" nor "never sent anywhere".
  it('the colophon names the share link only on a page that has one', () => {
    const local = renderNewspaper(issue(), EDIT, DEFAULT_STYLE, 'zh-CN', { doorbell: false }).html;
    expect(local).toContain(L('page.colophon', { count: '1' }));
    expect(local).not.toContain(L('page.colophonShared', { count: '1' }));
    for (const lang of ['en', 'zh-CN'] as const) {
      for (const key of ['newspaper.page.colophon', 'newspaper.page.colophonShared']) {
        const text = renderCopy(lang, key, { count: '1' });
        expect(text).not.toMatch(/never sent anywhere|this machine|本机模型|未经外传/);
      }
    }
    expect(renderCopy('en', 'newspaper.page.colophon', { count: '1' })).toContain("your assistant's model");
    expect(renderCopy('en', 'newspaper.page.colophonShared', { count: '1' })).toContain('share link for 24 hours');
    expect(renderCopy('zh-CN', 'newspaper.page.colophon', { count: '1' })).toContain('用你的助手所用的模型');
    expect(renderCopy('zh-CN', 'newspaper.page.colophonShared', { count: '1' })).toContain('分享链接上留一份');
  });

  it('标题层级 h1 报名 > h2 要闻 > h3 人物卡,逐级不跳', () => {
    const { html } = render(
      issue({ pulse: [item({ tier: 'card' }), item({ author: 'b', sigil: 'zz', authorPopclawId: 'pid-b', tier: 'card' })] }),
      { ...EDIT, leads: [1], items: { '1': { h: '头条', s: 'a' }, '2': { h: '次条', s: 'b' } } },
    );
    expect(html).toMatch(/<h1>[^<]*<\/h1>/);
    expect(html).toContain('<h2>头条</h2>');
    expect(html).toContain('<h3>次条</h3>');
    expect(html).toContain('<h3 class="kicker"'); // 栏目头也是 h3,层级不断
    expect(html).not.toContain('<h4>次条');
  });

  it('全报只有一处首字下沉:头版第一条', () => {
    const i = issue({
      pulse: [item({ tier: 'card' }), item({ author: 'b', sigil: 'zz', authorPopclawId: 'pid-b', tier: 'card' })],
    });
    const { html } = render(i, { ...EDIT, leads: [1, 2], items: { '1': { h: 'a', s: 'x' }, '2': { h: 'b', s: 'y' } } });
    expect(html.split('class="drop"').length - 1).toBe(1);
  });

  it('HTML 零注释、零 <style> 之外的样式,唯一内联 style 是叠的 --accent', () => {
    const { html } = render(worldIssue());
    expect(html).not.toContain('<!--');
    expect(html.split('<style>').length - 1).toBe(1);
    for (const m of html.matchAll(/ style="([^"]*)"/g)) expect(m[1]).toMatch(/^--accent:#[0-9a-f]{6}$/i);
  });
});

describe('一坊一叠', () => {
  it('叠头带序号与灯坊 slug,计数诚实(含头版几条)', () => {
    const i = worldIssue();
    const { html } = render(i, { ...EDIT, leads: [1] });
    expect(deck(html, 'house-me')).toContain(L('page.deckName', { index: L('page.ordinal.1'), house: 'house-me' }));
    expect(deck(html, 'house-me')).toContain(
      L('page.deckCount', {
        paper: '云舟江湖报',
        date: i.dateLabel,
        index: L('page.ordinal.1'),
        character: L('page.character.talk'),
        count: '1',
        front: '1',
      }),
    );
    expect(deck(html, 'house-me')).toContain(L('page.onFront', { count: '1' })); // 提上头版的在原栏留一行
  });

  it('E4:订了却当天 0 条的坊仍占一叠,并且不塞任何编出来的条目', () => {
    const i = issue({ pulse: [item()], byHouse: { 'house-me': 1, 'house-world': 0 } });
    const d = deck(render(i).html, 'house-world');
    expect(d).toContain(L('page.deckName', { index: L('page.ordinal.2'), house: 'house-world' }));
    expect(d).toContain(L('page.note', { text: L('page.quietHouse') })); // 空叠那句也带 ▢,一符一义
    expect(d).not.toContain('class="card"');
  });

  it('告示牌有就出,没有整行删', () => {
    expect(render(issue({ houseVoices: { 'house-me': '走出去看看的地方' } })).html).toContain('走出去看看的地方');
    expect(render().html).not.toContain('class="voice"');
  });

  it('灯坊色:主人指名的照他的,没指名的按内置色环依次取', () => {
    const i = issue({ pulse: [item(), item({ author: 'b', sigil: 'zz', houseSlug: 'house-x' })], byHouse: { 'house-me': 1, 'house-x': 1 } });
    const { html } = render(i, EDIT, { houseAccents: { 'house-me': '#9b1c1c' } });
    expect(deck(html, 'house-me')).toContain('--accent:#9b1c1c'); // 主人点名的
    expect(deck(html, 'house-x')).toContain('--accent:#3f5f3a'); // 没点名的取色环第一格
  });

  it('叠序:主人给了 deckOrder 就照他的,没给按条数降序', () => {
    const i = issue({
      pulse: [item(), item({ author: 'b', sigil: 'zz', houseSlug: 'house-world' }), item({ author: 'c', sigil: 'cc', houseSlug: 'house-world' })],
      byHouse: { 'house-me': 1, 'house-world': 2 },
    });
    expect(render(i).html.indexOf('deck-house-world')).toBeLessThan(render(i).html.indexOf('deck-house-me'));
    const fixed = render(i, EDIT, { deckOrder: ['house-me', 'house-world'] }).html;
    expect(fixed.indexOf('deck-house-me')).toBeLessThan(fixed.indexOf('deck-house-world'));
  });

  it('≥5 坊 → 前 3 出全叠,其余并作「他坊拾遗」', () => {
    const slugs = ['h1', 'h2', 'h3', 'h4', 'h5'];
    const i = issue({
      pulse: slugs.map((s, n) => item({ author: `a${n}`, sigil: `s${n}`, houseSlug: s })),
      byHouse: Object.fromEntries(slugs.map((s) => [s, 1])),
    });
    const { html } = render(i);
    expect(html).toContain(L('page.otherHouses'));
    expect(html.split('class="deckhead"').length - 1).toBe(4); // 3 全叠 + 拾遗
  });
});

describe('world 叠的规矩', () => {
  it('绝不出「去围观」—— 那条讨论页属于另一座坊,点开是 404', () => {
    const i = worldIssue({
      pulse: [
        item({ tier: 'card' }),
        item({ author: 'w', sigil: 'ww', houseSlug: 'house-world', postPageUrl: 'https://popclaw.me/post/xxxxxxxxxx' }),
      ],
    });
    const d = deck(render(i).html, 'house-world');
    expect(d).not.toContain(renderCopy('zh-CN', 'newspaper.material.button.talk'));
    expect(d).not.toContain('popclaw.me/post/xxxxxxxxxx');
  });

  it('明信片:图在最上、不带人物卡头、题字与出口照坊自报的字段排', () => {
    // leadMax 设 0 → 头版不占位,明信片留在自己栏里(默认它会被提上头版,见下一条)
    const { html } = render(worldIssue(), EDIT, { leadMax: 0 });
    const d = deck(html, 'house-world');
    expect(d).toContain('src="https://cdn/p.jpg"');
    expect(d).toContain('<h3>京都</h3>');
    expect(d).toContain('在鸭川边躲了雨');
    expect(d).toContain(renderCopy('zh-CN', 'newspaper.material.button.home'));
    expect(d).not.toContain('class="who"'); // 明信片的主角是主人自己,不出卡头
  });

  it('当日有明信片就提 1 张上头版,原栏留一行说明,绝不印两遍', () => {
    // 法典 内容§五.2:头版要同现「新闻 + 人在走动」两面。模型看不到坊事件的序号,
    // 所以这一张是版面自己提的。
    const { html } = render(worldIssue());
    const top = html.slice(html.indexOf('id="top"'), html.indexOf('class="deck"'));
    expect(top).toContain('京都'); // 上了头版
    const d = deck(html, 'house-world');
    expect(d).toContain(L('page.onFront', { count: '1' })); // 原栏留一行
    expect(html.split('<h3>京都</h3>').length - 1).toBe(1); // 只印了一遍
  });

  it('门楣一叠只出一行,①级把来源与时刻署在右端', () => {
    const i = worldIssue({ mantles: [{ houseSlug: 'house-world', level: 1, text: '蒂法 · 在家', asOf: '14:49', url: 'https://w/h/1' }] });
    const d = deck(render(i).html, 'house-world');
    expect(d.split('class="mantle"').length - 1).toBe(1);
    expect(d).toContain(L('page.asOf', { time: '14:49' }));
  });

  it('门楣④级用三行门卡', () => {
    const i = worldIssue({ mantles: [{ houseSlug: 'house-world', level: 4, text: '捏一个你自己的公仔', url: 'https://w/' }] });
    const d = deck(render(i).html, 'house-world');
    expect(d).toContain('class="doorplate"');
    expect(d).toContain(renderCopy('zh-CN', 'newspaper.material.button.world'));
  });

  it('值得一逛的家:排序依据与截止时刻照坊给的原文印,顺序不动,必带门牌', () => {
    const i = worldIssue({
      homeSections: [{
        houseSlug: 'house-world',
        asOf: '14:49',
        rankingBasis: '按小屋落成时间倒序',
        homes: [
          { name: '伊芙', visitUrl: 'https://w/h/2', owner: '#z1', voice: '一间卧室', builtAt: '2026年7月29日' },
          { name: '青禾', visitUrl: 'https://w/h/3', owner: '青禾#n1' },
        ],
      }],
    });
    const d = deck(render(i).html, 'house-world');
    expect(d).toContain('按小屋落成时间倒序');
    expect(d).toContain(L('page.houseList', { asOf: '14:49' }));
    expect(d.indexOf('伊芙')).toBeLessThan(d.indexOf('青禾')); // 坊给什么顺序就什么顺序
    expect(d.split(renderCopy('zh-CN', 'newspaper.material.button.visit')).length - 1).toBe(2); // 每卡必带门牌
    expect(d).not.toContain(L('page.visitsToday', { count: '0' })); // 没给就是没有,不许补一个数字
  });

  it('认不出的 kind → 附记,小字括号照抄坊自报的字段', () => {
    const i = worldIssue({
      pulse: [item({ tier: 'card' }), item({ author: '', houseSlug: 'house-world', kind: 'house:Whatever', houseFields: { odd: '1' } })],
    });
    const d = deck(render(i).html, 'house-world');
    expect(d).toContain(L('page.section.misc'));
    expect(d).toContain(L('page.miscRow', { kind: 'house:Whatever', fields: 'odd=1' }));
  });
});

describe('头版与耳版', () => {
  it('待回一条不漏,信内链接渲成可点、显示文本 percent-decode 而 href 原样', () => {
    const i = issue({ pings: [{ fromShort: '朱雀#a1', bodyPreview: '在吗', links: ['https://popclaw.world/%E8%92%82%E6%B3%95'] }] });
    const { html } = render(i);
    expect(html).toContain(L('page.ear.awaiting'));
    expect(html).toContain('朱雀#a1');
    expect(html).toContain('href="https://popclaw.world/%E8%92%82%E6%B3%95"');
    expect(html).toContain('>https://popclaw.world/蒂法<');
  });

  // 2026-08-27 改判：一封都没有时，那个「暂无待回信」的框天天占着手机第一屏的头条位。
  // 空的待办清单不上版，账仍然在天气行与账目耳版里报（一个数都不少）。
  it('一封都没有就整个耳版不出,但账目照报', () => {
    const { html } = render();
    expect(html).not.toContain(L('page.noPings'));
    expect(html).not.toContain('id="await"');
    expect(html).toContain(L('page.ledgerPings', { pings: '0', letters: '0' }));
  });

  it('本期账:各叠条数、出场人数、全报合计、计数体例只注明一次', () => {
    const i = issue({ pulse: [item({ replyCount: 2, markCount: 3 })], totalCount: 718 });
    const { html } = render(i);
    expect(html).toContain(L('page.ear.ledger'));
    expect(html).toContain(L('page.deckTally', { house: 'house-me', count: '1' }));
    expect(html).toContain(L('page.ledgerTotals', { people: '1', laidOut: '1', gathered: '718', front: '0' }));
    expect(html).toContain(L('page.ledgerEchoes', { replies: '2', marks: '3' }));
    expect(html.split(L('page.ledgerBasis')).length - 1).toBe(1);
  });

  it('待回与世界来信两处口径一致(分流不许变成漏账)', () => {
    const i = issue({
      pings: [{ fromShort: 'a#1', bodyPreview: 'x' }],
      houseLetters: [{ houseSlug: 'house-me', fromShort: 'w#1', dateLabel: 'd', body: 'b' }],
    });
    expect(render(i).html).toContain(L('page.ledgerPings', { pings: '1', letters: '1' }));
  });

  // 2026-08-27 改判：耳版的门原来开在「有荐因」上，而荐因在真机上 0/51（中文标签在英文
  // 正文里找子串，注定零命中）。删掉新人榜之后，唯一幸存的新面孔展示面就会一次都不出现。
  // 现在的门开在「本机新面孔 + 未关注」——那才是「值得认识的人」真正的依据。
  it('生面孔耳版收「本机新面孔 + 未关注」的人;有荐因就带上,没有也照出', () => {
    const i = issue({
      pulse: [
        item({ tier: 'card', newcomerDays: 2, reasons: ['品味命中「译诗」'] }),
        item({ author: 'b', sigil: 'zz', authorPopclawId: 'pid-b', newcomerDays: 1 }),
        item({ author: 'c', sigil: 'yy', authorPopclawId: 'pid-c' }), // 老面孔,不进耳版
      ],
    });
    const { html } = render(i);
    const earStart = html.indexOf(L('page.ear.newFaces'));
    const ear = html.slice(earStart, html.indexOf('</aside>', earStart));
    expect(html).toContain(L('page.ear.newFaces'));
    expect(ear).toContain('#zz'); // 没有荐因的新面孔也在
    expect(ear).not.toContain('#yy'); // 老面孔不在
    // 耳版用短式,卡片才印整句 —— 法典禁止两处逐字重复
    expect(html).toContain('<span class="why">品味命中「译诗」</span>');
    expect(html).toContain(L('page.why', { reason: '品味命中「译诗」' }));
  });
});

describe('卡与人', () => {
  it('卡头是人:头像 + 名号#印信 + 关注入口,整块链到他的主页', () => {
    const { html } = render(issue({ pulse: [item({ tier: 'card' })] }));
    expect(html).toContain('href="https://popclaw.me/levelsio/65v29fn1"');
    expect(html).toContain('<b>levelsio</b><span class="sig">#65v29fn1</span>');
    // 门铃制:关注状态不再是烤进页面的 span,是一枚初始态按钮(翻面交给读者证与画布回执)
    expect(html).toContain('data-followee="pid-levelsio"');
    expect(html).not.toContain(`<span class="tag">${L('page.notFollowing')}</span>`);
  });

  it('无署名走紧凑兜底,绝不编头像与印信', () => {
    const { html } = render(issue({ pulse: [item({ author: '', sigil: '', avatarUrl: '', profileUrl: '', platform: 'rss' })] }));
    expect(html).toContain(renderCopy('zh-CN', 'newspaper.material.pulse.unattributed', { platform: 'rss' }));
    expect(html).not.toContain('<img');
  });

  it('远程图一律 lazy;配图失败自己藏起来,人脸失败换成本地字母牌', () => {
    const { html } = render(issue({ pulse: [item({ tier: 'card', media: ['https://cdn/a.jpg'] })] }));
    for (const m of html.matchAll(/<img[^>]*>/g)) expect(m[0]).toContain('loading="lazy"');
    const fig = html.match(/<img class="fig"[^>]*>/)![0];
    expect(fig).toContain("onerror=\"this.style.display='none'\""); // 配图没了就没了
    // 脸不一样:unavatar 被限流时返回的是 JSON,<img> 必然出错 —— 那一刻要有张本地的顶上,
    // 而不是留一排没有脸的卡片。兜底是内联 SVG,不需要网络。
    const av = html.match(/<img src="https:\/\/unavatar[^>]*>/)![0];
    expect(av).toContain('data-mono="data:image/svg+xml;base64,');
    expect(av).toContain('onerror="this.onerror=null;this.src=this.dataset.mono"');
  });

  it('本地画的字母牌本身不再挂第二个兜底(它就是兜底)', () => {
    const { html } = render(issue({ pulse: [item({ tier: 'card', platform: 'popclaw', handle: '' })] }));
    const av = html.match(/<img src="data:image\/svg\+xml[^>]*>/);
    if (av) expect(av[0]).toContain("onerror=\"this.style.display='none'\"");
  });

  it('链接一律纯 <a>,新页打开;页上唯一的脚本就是门铃', () => {
    const { html } = render(worldIssue());
    expect(html).not.toContain('onclick');
    // 门铃制之前是「零 JS」;现在页面唯一一段脚本是关注门铃,贴着 </body>
    expect(html.split('<script').length - 1).toBe(1);
    for (const m of html.matchAll(/<a [^>]*href=[^>]*>/g)) {
      if (m[0].includes('href="#')) continue; // 锚点是页内导航
      expect(m[0]).toContain('target="_blank"');
      // noreferrer joined noopener on 2026-09-12 (the zero-dependency page): an
      // outbound click must not tell the site where the paper is kept either.
      expect(m[0]).toContain('rel="noopener noreferrer"');
    }
  });

  it('url 是空的按钮整颗不出,绝不自拼', () => {
    const { html } = render(issue({ pulse: [item({ tier: 'card', url: '', postPageUrl: '', profileUrl: '' })] }));
    expect(html).not.toContain('class="btn"');
  });

  it('镜像帖必带「查看原文」;讨论页与原帖同一条时不重复出', () => {
    const same = 'https://popclaw.me/post/abc1234567';
    expect(render(issue({ pulse: [item({ tier: 'card' })] })).html).toContain(
      renderCopy('zh-CN', 'newspaper.material.button.original'),
    );
    expect(render(issue({ pulse: [item({ tier: 'card', url: same })] })).html).not.toContain(
      renderCopy('zh-CN', 'newspaper.material.button.original'),
    );
  });

  it('卡脚计数纯文字,0 不印', () => {
    const withCounts = render(issue({ pulse: [item({ tier: 'card', replyCount: 2 })] })).html;
    expect(withCounts).toContain(`class="cnt"`);
    expect(withCounts).toContain(L('page.replies', { count: '2' }));
    const foot = render(issue({ pulse: [item({ tier: 'card' })] })).html.match(/class="foot">[\s\S]*?<\/div>/)![0];
    expect(foot).not.toContain(L('page.marks', { count: '0' }));
  });

  it('交情只标至交/密友,陌生人不挂标签', () => {
    expect(render(issue({ pulse: [item({ tier: 'card', bondTier: 'close', remarkName: '老龙' })] })).html).toContain('老龙');
    expect(render(issue({ pulse: [item({ tier: 'card', bondTier: 'acquaintance' })] })).html).not.toContain('class="tag hot"');
  });

  it('名录收本期全部作者,没有主页 url 的不进名录', () => {
    const i = issue({ pulse: [item(), item({ author: 'b', sigil: 'zz', authorPopclawId: 'pid-b', profileUrl: '' })] });
    const { html } = render(i);
    expect(html).toContain(L('page.roster'));
    expect(html).toContain(L('page.people', { count: '1' })); // 名录旁边那个数就是名录里的人数
    const roster = html.slice(html.indexOf('class="roster"'));
    expect(roster).toContain('levelsio');
    expect(roster).not.toContain('>b<');
  });
});

describe('模型交来的字', () => {
  // 2026-08-26 主人裁定翻案：原先「没写稿就照登它自己的第一句」——真机上那是四十条英文原帖。
  // 现在没成文就不上版，回执点名。
  it('没写稿的条目不上版,回执里点名', () => {
    const { html, notes } = render(issue({ pulse: [item({ text: '第一句。第二句。' })] }), { ...EDIT, items: {} });
    expect(html).not.toContain('第一句。');
    expect(notes.join()).toContain('edit.items');
  });

  it('leads 指到坊事件 → 丢掉并说明(它归自己的栏目)', () => {
    const i = worldIssue();
    const { notes } = render(i, { ...EDIT, leads: [2] });
    expect(notes.join()).toContain('lore-house event');
  });

  it('leads 超过 leadMax → 多的丢掉并说明', () => {
    const i = issue({ pulse: [item({ tier: 'card' }), item({ author: 'b', sigil: 'zz', tier: 'card' })] });
    const { html, notes } = render(i, { ...EDIT, leads: [1, 2] }, { leadMax: 1 });
    expect(notes.join()).toContain('leadMax');
    expect(html.split('class="lead"').length - 1).toBe(1);
  });

  it('引文块 ≤4、互指 ≤8,超配额的静静丢掉', () => {
    const pulse = Array.from({ length: 30 }, (_, n) =>
      item({ author: `a${n}`, sigil: `s${n}`, authorPopclawId: `pid-${n}`, tier: 'card' }),
    );
    const keys = Object.fromEntries(pulse.map((_, n) => [String(n + 1), `引${n}`]));
    const items = Object.fromEntries(pulse.map((_, n) => [String(n + 1), { h: `h${n}`, s: `s${n}` }]));
    const { html } = render(issue({ pulse }), { ...EDIT, items, pulls: keys, xrefs: keys });
    expect(html.split('class="pull"').length - 1).toBe(4);
    expect(html.split('class="xref"').length - 1).toBe(8);
  });

  it('叠按语一叠一句', () => {
    const { html } = render(issue(), { ...EDIT, deckNotes: { 'house-me': '今日十人出场' } });
    expect(html).toContain(L('page.note', { text: '今日十人出场' }));
  });
});

describe('主人的旋钮', () => {
  it('fontScale 直接改字号', () => {
    expect(render().html).toContain('font-size:15.5px');
    expect(render(issue(), EDIT, { fontScale: 1.2 }).html).toContain('font-size:18.6px');
  });

  it('主色换了,整报跟着换', () => {
    expect(render(issue(), EDIT, { accent: '#123456', houseAccents: {} }).html).toContain('--accent:#123456');
  });

  it('关掉的栏目一个都不出', () => {
    const i = issue({ pulse: [item(), item({ author: 'b', sigil: 'zz' })] });
    const off = render(i, EDIT, { briefs: false, roster: false, newbieBoard: false, index: false }).html;
    expect(off).not.toContain('class="briefs"');
    expect(off).not.toContain('class="index"');
    expect(off).not.toContain(L('page.roster'));
  });

  // 2026-08-27 改判：比例制（每叠 30%）在真机上退化成「有图=人物卡」——8/26 是 28 张卡
  // 对 28 条带图、8/27 是 5 对 5，一条不差。版面形状不该由当天有多少人发了照片决定。
  // 现在是全报固定配额 12 张，style.cardMax 仍是硬上限。
  it('人物卡走固定配额,不再随当天带图条数漂移', () => {
    const pulse = Array.from({ length: 20 }, (_, n) =>
      item({ author: `a${n}`, sigil: `s${n}`, authorPopclawId: `pid-${n}`, tier: 'card' }),
    );
    // 20 条全都够格上卡,但法典的形状是「要闻 5% / 人物卡 30% / 简讯 65%」——
    // 报纸好看恰恰来自这个密度差,20 张卡的一堵墙不是报纸。
    const written = { ...EDIT, items: Object.fromEntries(pulse.map((_, n) => [String(n + 1), { h: `标题${n}`, s: `正文${n}。` }])) };
    const wide = render(issue({ pulse }), written, { cardMax: 30 }).html;
    expect(wide.split('class="card"').length - 1).toBe(12); // 全报配额
    expect(wide.split('class="brief"').length - 1).toBe(8);
    const tight = render(issue({ pulse }), written, { cardMax: 2 }).html;
    expect(tight.split('class="card"').length - 1).toBe(2);
  });

  it('sections 改栏目顺序,改了必然生效', () => {
    const i = worldIssue({ mantles: [{ houseSlug: 'house-world', level: 1, text: '蒂法在家', asOf: '14:00' }] });
    const d = deck(render(i, EDIT, { sections: { 'house-world': ['postcards', 'mantle'] } }).html, 'house-world');
    expect(d.indexOf('class="card"')).toBeLessThan(d.indexOf('class="mantle"'));
  });
});

describe('两种语言', () => {
  it('en 主人拿到英文版面与英文字体链接', () => {
    const { html } = renderNewspaper(issue({ language: 'en-US' }), EDIT, DEFAULT_STYLE, 'en');
    expect(html).toContain('lang="en-US"');
    expect(html).toContain(renderCopy('en', 'newspaper.page.roster'));
    expect(html).toContain('UnifrakturMaguntia');
    expect(html).not.toContain('zeoseven');
  });

  it('zh 主人拿到中文版面与中文字体链接', () => {
    const { html } = render();
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('zeoseven.com/309');
    expect(html).toContain('Ma+Shan+Zheng');
  });

  it('正文字体换成霞鹜文楷,汇文明朝那条链接就不再拉', () => {
    const { html } = render(issue(), EDIT, { bodyFont: 'lxgw' });
    expect(html).toContain("--serif:'EB Garamond','LXGW WenKai Screen'");
    expect(html).not.toContain('zeoseven.com/256');
  });
});

/**
 * 2026-08-26 真机（乙机 gpt-5.6-sol，51 条素材）：模型只给 1–11 条写了字，12–51 条全部回落印原帖，
 * 于是一版报纸上挂着四十条英文原文。主人：「很多的『又记』里面全是英文，不符合我们的报纸原则。」
 * 报纸只登成文的东西 —— 没成文的不印原文、不上版，但要说出来有几条。
 */
describe('没成文的条目不许上版（真机回归钉）', () => {
  const twoItems = (): IssueData =>
    issue({
      pulse: [
        item({ author: 'a', sigil: 'aa', tier: 'card', text: 'The booster landed on the pad.' }),
        item({ author: 'a', sigil: 'aa', tier: 'brief', text: 'A cat climbed the escalator, not understanding how it worked.' }),
      ],
      byHouse: { 'house-me': 2 },
    });

  it('模型没写的那条不印原文,也不占版面', () => {
    const { html } = render(twoItems(), { ...EDIT, items: { '1': { h: '猎鹰落回发射台', s: '第一段。' } } });
    expect(html).toContain('猎鹰落回发射台');
    expect(html).not.toContain('A cat climbed the escalator'); // 回落印原帖 = 主人看到的那四十条
    expect(html).toContain(L('page.unwritten', { count: '1' })); // 但要说出来
  });

  it('两条都成文时一条都不少,也不会多出未成文那行', () => {
    const { html } = render(twoItems(), {
      ...EDIT,
      items: { '1': { h: '猎鹰落回发射台', s: '第一段。' }, '2': { h: '猫与扶梯', s: '一只猫。' } },
    });
    expect(html).toContain('猎鹰落回发射台');
    expect(html).toContain('一只猫。'); // 同一人的第二条挂在他卡下当「又记」,印的是摘要
    expect(html).not.toContain(L('page.unwritten', { count: '1' }));
  });

  it('没成文的条目也不许上头版(模型把它写进 leads 也不行)', () => {
    const { html, notes } = render(twoItems(), {
      ...EDIT,
      leads: [2],
      items: { '1': { h: '猎鹰落回发射台', s: '第一段。' } },
    });
    expect(html).not.toContain('A cat climbed the escalator');
    expect(notes.join(' ')).toContain('no copy');
  });

  it('回执把没成文的条数说清楚', () => {
    const { notes } = render(twoItems(), { ...EDIT, items: { '1': { h: 'h', s: 's' } } });
    expect(notes.join(' ')).toMatch(/1 item\(s\) had no copy/);
  });
});

/**
 * 2026-08-27 真机：候选页按人归摞，但**编号仍是存储下标**，于是页面上是 `[18] [242] [415] [176]`
 * 这样一串带窟窿的号码。两台机器读到的结论都一样：「内容被截断了」——乙机跑去 feed 补全，
 * 甲机（deepseek-v4-flash，输出上限 8192）把整个输出预算烧在这上面，撞 `stopReason=length`
 * 整轮挂死。**什么都没被截断，是编号在说谎。**
 */
describe('候选页编号必须一路顺下来（真机回归钉）', () => {
  it('按人归摞之后,编号仍然是 1,2,3…… 不跳号', () => {
    const pulse = [
      item({ author: 'a', sigil: 'aa', authorPopclawId: 'pid-a' }),
      item({ author: 'b', sigil: 'bb', authorPopclawId: 'pid-b' }),
      item({ author: 'a', sigil: 'aa', authorPopclawId: 'pid-a' }),
      item({ author: 'c', sigil: 'cc', authorPopclawId: 'pid-c' }),
      item({ author: 'a', sigil: 'aa', authorPopclawId: 'pid-a' }),
    ];
    const ordered = candidateOrder(pulse, 'zh-CN');
    const page = buildCandidatePage(issue({ pulse: ordered }), {
      tasteText: '',
      bondLines: [],
      publishToken: 'ctok_x',
      suggestMin: 3,
      suggestMax: 6,
      floor: 2,
      budget: 60_000,
      dayTotal: 99,
      overBudget: false,
      perAuthorMax: 6,
    });
    const nums = [...page.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    expect(nums.length).toBe(5);
    expect(nums).toEqual([1, 2, 3, 4, 5]); // 一路顺下来,一个窟窿都没有
  });

  /**
   * 2026-08-27 甲机：「候选页面被截断,未包含 publish_token,所以无法进入第二步发布」。
   * 令牌原来只印在页尾那一块 —— 页尾丢了也好、模型没读到也好,结局一样,而且丢的正是
   * 整页里唯一补不回来的那一样:别的都能再调一次拿回来,令牌不能。
   */
  it('令牌页首页尾各印一次 —— 只剩半页也接得下去', () => {
    const page = buildCandidatePage(issue({ pulse: [item()] }), {
      tasteText: '',
      bondLines: [],
      publishToken: 'ctok_head',
      suggestMin: 3,
      suggestMax: 6,
      floor: 2,
      budget: 60_000,
      dayTotal: 99,
      overBudget: false,
      perAuthorMax: 6,
    });
    const lines = page.split('\n');
    const at = lines.flatMap((l, i) => (l.includes('ctok_head') ? [i] : []));
    expect(at.length).toBeGreaterThanOrEqual(2);
    expect(at[0]).toBeLessThan(12); // 页首那一次,在素材开始之前
    expect(at[at.length - 1]).toBeGreaterThan(lines.length - 6); // 页尾那一次照旧
  });
});

/**
 * 2026-08-27 真机（乙机）：候选页被宿主截断 → 模型丢了页尾那行指令 → **凭记忆编了一个
 * `tok_` 令牌** → `getIssue` 落空 → 过期令牌回退路径 `latestIssue()` 把候选集整份端了回来
 * → 254 条全部上版，一个账号占 11 条。兜底闸当时按「令牌是不是 c 开头」判，名字不对就没拦。
 * **闸门改成看内容不看令牌名。**
 */
describe('候选集绝不许整份上版（真机回归钉）', () => {
  it('拿一份 254 条的候选集去出版 → 兜底挑到 90 条上下,每人不超上限', () => {
    const big = Array.from({ length: 254 }, (_, i) =>
      item({
        author: i % 3 === 0 ? 'loud' : `q${i}`,
        sigil: i % 3 === 0 ? 'ld' : `s${i}`,
        authorPopclawId: i % 3 === 0 ? 'pid-loud' : `pid-${i}`,
        url: `https://x.com/a/${i}`,
      }),
    );
    const picked = selectByHeat(big, { target: 90, perAuthorMax: 6 });
    expect(picked.length).toBe(90);
    expect(picked.filter((p) => p.author === 'loud').length).toBeLessThanOrEqual(6);
  });
});

/**
 * 兜底:模型跳过挑选那一步、直接拿候选 token 来出版 —— 那会把整天 452 条印上版面,
 * 正是挑选步骤存在的理由。所以插件自己挑 90 条,**并在回执里说出来**(静默降级正是
 * 「四十条英文原帖上版」那次事故的形状)。
 */
describe('兜底选样:按热闹挑,但要说出来', () => {
  it('刷屏账号不因为量大而占满,且每人不超上限', () => {
    const flood = Array.from({ length: 40 }, (_, i) =>
      item({ author: 'loud', sigil: 'ld', authorPopclawId: 'pid-loud', url: `https://x.com/loud/${i}` }),
    );
    const quiet = Array.from({ length: 10 }, (_, i) =>
      item({ author: `q${i}`, sigil: `s${i}`, authorPopclawId: `pid-q${i}`, media: ['https://i/1.jpg'] }),
    );
    const picked = selectByHeat([...flood, ...quiet], { target: 12, perAuthorMax: 6 });
    expect(picked.length).toBe(12);
    expect(picked.filter((p) => p.author === 'loud').length).toBeLessThanOrEqual(6);
    // 安静但带图的那十个人一个不少 —— 「量大」不等于「热」
    for (let i = 0; i < 10; i += 1) expect(picked.some((p) => p.author === `q${i}`)).toBe(true);
    // 兜底挑的一律记作「填热闹」,不冒充为主人挑的
    expect(picked.every((p) => p.pickedFor === 'lively')).toBe(true);
  });
});

/**
 * 「为我定制」要看得见,但不能变成噪音墙:75 条简讯每行挂一句「▢ 为你圈的:热度(带图)」,
 * 行高翻倍、时长破线,而且等于逐条提醒主人「这条其实不是为你挑的」——冷启动期它占八成。
 * 所以:**标记稀有的(口味/交情),放过普遍的(热闹),总账在天气行下面记一次。**
 */
describe('为我定制:标记稀有的,放过普遍的', () => {
  const picked = (): IssueData =>
    issue({
      pulse: [
        item({ author: 'a', sigil: 'aa', authorPopclawId: 'pid-a', tier: 'card', pickedFor: 'taste' }),
        item({ author: 'b', sigil: 'bb', authorPopclawId: 'pid-b', tier: 'brief', pickedFor: 'bond' }),
        item({ author: 'c', sigil: 'cc', authorPopclawId: 'pid-c', tier: 'brief', pickedFor: 'lively' }),
      ],
      byHouse: { 'house-me': 3 },
    });
  const edit3: NewspaperEdit = {
    ...EDIT,
    items: { '1': { h: 'h1', s: 's1' }, '2': { h: 'h2', s: 's2' }, '3': { h: 'h3', s: 's3' } },
  };

  it('口味与交情各带一枚记号,热闹不带', () => {
    const { html } = render(picked(), edit3);
    expect(html).toContain(L('page.pickedFor.taste'));
    expect(html).toContain(L('page.pickedFor.bond'));
    // 记号本身各只出现一次；热闹那条一个记号都没有 —— 冷启动期它是大多数
    // （账目那行也会说出同样的词，所以按记号的标记来数，不按词来数）
    const tag = (k: string): string => `<span class="tag">${L(`page.pickedFor.${k}`)}</span>`;
    expect(html.split(tag('taste')).length - 1).toBe(1);
    expect(html.split(tag('bond')).length - 1).toBe(1);
  });

  it('本期账在天气行下面记一次:多少为你挑、多少填热闹', () => {
    const { html } = render(picked(), edit3);
    expect(html).toContain(L('page.chosen', { taste: '1', bond: '1', lively: '1' }));
  });

  it('一条都不是为你挑的时候,不立这块牌子', () => {
    const i = issue({ pulse: [item({ author: 'c', sigil: 'cc', pickedFor: 'lively' })] });
    const { html } = render(i, { ...EDIT, items: { '1': { h: 'h', s: 's' } } });
    expect(html).not.toContain(L('page.chosen', { taste: '0', bond: '0', lively: '1' }));
  });
});

/**
 * 主人 2026-08-26 的裁定：「看到一个完全不认识的语言，这个信息对我就无效了，哪怕失真一点也比无效要好。」
 * 版面逐字照印的那几行（坊给的排序依据、小屋主人的自述）是别人的原话，v0.2 把版面收回代码时
 * 顺手把它们从模型手里拿走了，翻译能力跟着一起丢。这一组钉住三层降级：译文 > 原文，且原文永远还在。
 */
describe('读者看不懂的那几行（译文层）', () => {
  const enHomes = (): IssueData =>
    issue({
      language: 'en-US',
      homeSections: [{
        houseSlug: 'house-world',
        asOf: '14:49',
        rankingBasis: '按小屋落成时间倒序',
        homes: [{ name: '伊芙', visitUrl: 'https://w/h/2', owner: '#z1', voice: '一间卧室' }],
      }],
      byHouse: { 'house-world': 1 },
    });

  const renderEn = (edit: NewspaperEdit): string =>
    renderNewspaper(enHomes(), edit, DEFAULT_STYLE, 'en').html;

  it('交了译文就印译文,原文留在 title 里,并注明是译文', () => {
    const html = renderEn({
      ...EDIT,
      translations: { 按小屋落成时间倒序: 'Newest home first', 一间卧室: 'A bedroom' },
    });
    expect(html).toContain('Newest home first');
    expect(html).toContain('A bedroom');
    expect(html).toContain('title="按小屋落成时间倒序"'); // 原文没被换掉,只是让了位
    expect(html).toContain(renderCopy('en', 'newspaper.page.translated'));
  });

  it('没交译文就照旧印原文(兜底不变,绝不留空)', () => {
    const html = renderEn(EDIT);
    expect(html).toContain('按小屋落成时间倒序');
    expect(html).toContain('一间卧室');
    expect(html).not.toContain(renderCopy('en', 'newspaper.page.translated'));
  });

  it('译文里的 HTML 一律当字面文本', () => {
    const html = renderEn({ ...EDIT, translations: { 按小屋落成时间倒序: '<script>x</script>' } });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('简报把待译原文逐行列给模型,并说清 key 就是原文本身', () => {
    const brief = buildNewspaperPrompt(enHomes(), { contentRules: '', publishToken: 'tok', leadMax: 3, pickedCount: 1, overBudget: false });
    expect(brief).toContain('按小屋落成时间倒序');
    expect(brief).toContain('一间卧室');
    expect(brief).toContain('translations');
  });

  it('人名家名不进待译清单(译了就找不到人)', () => {
    const brief = buildNewspaperPrompt(enHomes(), { contentRules: '', publishToken: 'tok', leadMax: 3, pickedCount: 1, overBudget: false });
    const list = brief.slice(brief.indexOf(renderCopy('en', 'newspaper.material.verbatim.head')));
    expect(list).not.toContain('伊芙'); // 家名是找门用的
    expect(list).not.toContain('#z1'); // 印信更是
  });
});

/**
 * 这一组是 2026-08-26 外部审查抓出来的三条 —— 每一条都会让主人当天拿到一份残报，
 * 而当时的测试全绿。它们的共同点：夹具恰好没踩到那条分支。**别删。**
 */
describe('会让整版消失的三条（回归钉）', () => {
  it('me 叠拿到一行门楣,当天的帖子一条都不许少', () => {
    // 门楣对每座坊都会生成（③级只要有一封坊官方来信、④级只要有门卡），主人自己那座
    // 坊完全可能有。曾经这会把整叠切换到「具身坊」栏目集,当天所有帖子静默消失。
    const i = issue({
      pulse: [item({ tier: 'card' }), item({ author: 'b', sigil: 'zz', authorPopclawId: 'pid-b' })],
      mantles: [{ houseSlug: 'house-me', level: 3, text: '上一程：七月二十九日', dateLabel: '七月二十九日' }],
      byHouse: { 'house-me': 2 },
    });
    const { html } = render(i, { ...EDIT, items: { '1': { h: '甲', s: 'x' }, '2': { h: '乙', s: 'y' } } });
    expect(html).toContain('甲'); // 人物卡
    expect(html).toContain('y'); // 简讯行(简讯印摘要)
    expect(html).toContain('class="mantle"'); // 门楣照出,两者并存
  });

  it('只有世界来信与值得一逛的家、没有事件的坊,两栏都得出', () => {
    const i = issue({
      pulse: [item({ tier: 'card' })],
      houseLetters: [{ houseSlug: 'house-world', fromShort: '世界#w1', dateLabel: '八月一日', body: '欢迎来到这个世界' }],
      homeSections: [{ houseSlug: 'house-world', asOf: '14:00', homes: [{ name: '伊芙', visitUrl: 'https://w/h/1', owner: '#z1' }] }],
      byHouse: { 'house-me': 1, 'house-world': 0 },
    });
    const d = deck(render(i).html, 'house-world');
    expect(d).toContain('欢迎来到这个世界');
    expect(d).toContain('伊芙');
  });

  it('第 4 座坊起并作拾遗,但门楣/来信/明信片/家 一样都不许被折掉', () => {
    const slugs = ['h1', 'h2', 'h3', 'h4', 'house-world'];
    const i = issue({
      pulse: [
        ...slugs.slice(0, 4).map((sl, n) => item({ author: `a${n}`, sigil: `s${n}`, authorPopclawId: `pid-${n}`, houseSlug: sl })),
      ],
      mantles: [{ houseSlug: 'house-world', level: 1, text: '蒂法 · 在家', asOf: '14:49' }],
      homeSections: [{ houseSlug: 'house-world', asOf: '14:49', homes: [{ name: '伊芙', visitUrl: 'https://w/h/1', owner: '#z1' }] }],
      byHouse: Object.fromEntries(slugs.map((sl) => [sl, sl === 'house-world' ? 0 : 1])),
    });
    const { html } = render(i);
    // 世界坊条数最少,排最后,正是会被折进拾遗的那一座
    expect(html).toContain('id="deck-house-world"');
    expect(html).toContain('蒂法 · 在家');
    expect(html).toContain('伊芙');
    expect(html).toContain(L('page.otherHouses')); // 普通帖子照折
  });
});

describe('安全与不崩（外部审查补）', () => {
  it('坊给的 javascript: 链接绝不变成页面上的链接', () => {
    const i = issue({
      pulse: [
        item({ tier: 'card' }),
        item({
          author: '',
          houseSlug: 'house-world',
          kind: 'house:world.Postcard',
          houseFields: { place_name: '京都', home_url: 'javascript:alert(1)' },
        }),
      ],
      byHouse: { 'house-me': 1, 'house-world': 1 },
    });
    const { html } = render(i);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('京都'); // 内容照排,只是那颗按钮不给链接
  });

  it('坊少给一个字段不许掀翻整份报纸', () => {
    const i = issue({
      pulse: [item({ tier: 'card' })],
      houseLetters: [{ houseSlug: 'house-me', fromShort: undefined as never, dateLabel: undefined as never, body: undefined as never }],
      homeSections: [{ houseSlug: 'house-me', asOf: '1', homes: [{ name: undefined as never, visitUrl: 'https://w/1', owner: undefined as never }] }],
      pings: [{ fromShort: undefined as never, bodyPreview: undefined as never }],
    });
    expect(() => render(i)).not.toThrow();
  });
});

describe('版面细节（外部审查补）', () => {
  it('卡头是一行:名号与小字同在 .who 里,不再断成两行', () => {
    const { html } = render(issue({ pulse: [item({ tier: 'card', followerCount: 82_000, verified: true })] }));
    const who = html.match(/<a class="who"[^>]*>[\s\S]*?<\/a>/)![0];
    expect(who).toContain('<b>levelsio</b>');
    expect(who).toContain('class="sig"');
    expect(who).toContain('class="meta"'); // 小字在同一个 flex 行里
    // 门铃制:行尾那枚入口与锚点同在 .who-row 一行里,但绝不嵌进链接(审查修复)
    const row = html.match(/<div class="who-row">[\s\S]*?<\/div>/)![0];
    expect(who).not.toContain('follow-btn');
    expect(row).toContain('class="follow-btn"');
  });

  it('要闻卡:图排在标题与正文之后,绝不挡在署名和标题中间', () => {
    const { html } = render(
      issue({ pulse: [item({ tier: 'card', media: ['https://cdn/a.jpg'] })] }),
      { ...EDIT, leads: [1] },
    );
    const lead = html.match(/<article class="lead">[\s\S]*?<\/article>/)![0];
    expect(lead.indexOf('<h2>')).toBeLessThan(lead.indexOf('class="fig"'));
  });

  it('图有高度上限 —— 一张竖图不许占满整屏', () => {
    expect(render().html).toContain('max-height:420px');
    expect(render(issue(), EDIT, { figMax: 200 }).html).toContain('max-height:200px');
  });

  it('手机 DOM 顺序:待回排在三条要闻之前(桌面靠 grid 摆回右栏)', () => {
    const { html } = render(issue({ pulse: [item({ tier: 'card' })] }), { ...EDIT, leads: [1] });
    expect(html.indexOf('id="await"')).toBeLessThan(html.indexOf('class="lead"'));
    expect(html).toContain('grid-template-areas'); // 桌面靠 grid,不靠 order 反转
  });

  it('同一个人当天多条:一个卡头,其余作又记,计数分列不合并', () => {
    const i = issue({
      pulse: [item({ tier: 'card', replyCount: 9 }), item({ replyCount: 3, postPageUrl: 'https://popclaw.me/post/second1234' })],
    });
    const { html } = render(i, { ...EDIT, items: { '1': { h: '头帖', s: 'a' }, '2': { h: '又一帖', s: '第二帖的摘要' } } });
    expect(html.split('class="who"').length - 1).toBe(1); // 只有一个卡头
    expect(html).toContain('class="also"');
    // 又记只印一句(摘要),不把标题和摘要都印一遍 —— 那读起来是结巴
    expect(html).toContain('第二帖的摘要');
    expect(html).not.toContain('又一帖');
    expect(html).toContain(L('page.replies', { count: '9' }));
    expect(html).toContain(L('page.replies', { count: '3' })); // 各计各的
    expect(html).toContain(renderCopy('zh-CN', 'newspaper.material.button.talkAlso'));
  });

  it('要闻卡里一条又记都不许有 —— 主人认可那期 28 条又记全在人物卡里', () => {
    // 头版三条各自吸走作者当天其余五六条,读起来就是标题底下一堵墙。
    // 那些条目该留在下面的叠里、归到那个人的卡上。
    const i = issue({
      pulse: [item({ tier: 'card' }), item(), item(), item({ author: 'b', sigil: 'zz', authorPopclawId: 'pid-b' })],
    });
    const { html } = render(i, {
      ...EDIT,
      leads: [1],
      items: { '1': { h: '头条', s: 'a' }, '2': { h: 'x', s: '第二条' }, '3': { h: 'y', s: '第三条' }, '4': { h: 'z', s: 'w' } },
    });
    const lead = html.match(/<article class="lead">[\s\S]*?<\/article>/)![0];
    expect(lead).not.toContain('class="also"');
    // 而它们并没有消失:留在叠里,归在同一个人的卡头下
    expect(html).toContain('第二条');
    expect(html).toContain('第三条');
  });

  // 2026-08-27：新人榜整节已删 —— 头版耳版的「新面孔」列的是同一批人，带荐因、带最新一条，
  // 而这台机器上几乎每个作者都是新面孔，榜会长成第二张名录。删榜留耳版。
  it('新人榜整节已删,索引也不再指向它(锚点落空是法典明令的缺陷)', () => {
    const i = issue({ pulse: [item({ tier: 'card', newcomerDays: 2 })] });
    const { html } = render(i, { ...EDIT, newbies: { '65v29fn1': '两三句小传' } });
    expect(html).not.toContain('id="newbies"');
    expect(html).not.toContain(L('page.newbieDeck'));
    expect(html).not.toContain('两三句小传');
    expect(html).toContain(L('page.ear.newFaces')); // 耳版还在,人没丢
  });

  // Was: the masthead face was subset with `&text=<masthead>`, 2,980 bytes
  // against 6.1MB (measured 2026-08-26). The owner struck that on 2026-09-12:
  // the URL carried the name of his own paper to a third party on every read,
  // and a page that costs nobody a secret is worth more than the bytes. The
  // family is asked for by name now, and the masthead still decides WHETHER it
  // is asked for at all.
  it('报头字体按整套家族引 —— url 里绝不带本期的字', () => {
    const { html } = render(issue(), { ...EDIT, masthead: '云舟江湖报' });
    expect(html).toContain('family=Ma+Shan+Zheng&display=swap');
    expect(html).not.toContain('text=');
    expect(html).not.toContain(encodeURIComponent('云舟江湖报'));
  });

  it('en 的哥特报头同理', () => {
    const { html } = renderNewspaper(issue({ language: 'en-US' }), { ...EDIT, masthead: 'The Cloudboat Chronicle' }, DEFAULT_STYLE, 'en');
    expect(html).toContain('family=UnifrakturMaguntia&display=swap');
    expect(html).not.toContain('text=');
  });

  it('中文显示字体引的是 CDN 真正声明的那个名字', () => {
    // CDN 的 @font-face 只声明 KingHwaOldSong-GB;引成 KingHwaOldSong 匹配不上
    // (CSS 字族名精确匹配),标题就会一路掉回系统宋体 —— v9 起一直如此。
    const css = render().html;
    expect(css).toContain("'KingHwaOldSong-GB'");
    expect(css).toContain('fontsapi.zeoseven.com/309/gb/result.css');
  });

  it('同一个人不许占两条头版', () => {
    const i = issue({ pulse: [item({ tier: 'card' }), item({ tier: 'card' })] });
    const { html, notes } = render(i, { ...EDIT, leads: [1, 2], items: { '1': { h: '甲', s: 'x' }, '2': { h: '乙', s: 'y' } } });
    expect(html.split('class="lead"').length - 1).toBe(1);
    expect(notes.join()).toContain('already on the front page');
  });

  it('索引条每个锚点都落得到地方', () => {
    const i = issue({ pulse: [item({ tier: 'card', newcomerDays: 2 })], pings: [{ fromShort: 'a#1', bodyPreview: 'x' }] });
    const { html } = render(i);
    for (const anchor of [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!)) {
      expect(html).toContain(`id="${anchor}"`);
    }
  });


  it('江湖人情不出机器字段:时刻成人话、phase 与 kind 都译过来', () => {
    const i = issue({
      pulse: [
        item({ tier: 'card' }),
        item({
          author: '',
          houseSlug: 'house-world',
          kind: 'house:world.Trip',
          houseFields: { occurred_at: '2026年8月25日 14:03', place_name: '苏州', phase: 'returned' },
        }),
      ],
      byHouse: { 'house-me': 1, 'house-world': 1 },
    });
    const d = deck(render(i).html, 'house-world');
    expect(d).toContain(renderCopy('zh-CN', 'newspaper.material.kind.trip'));
    expect(d).toContain(renderCopy('zh-CN', 'newspaper.material.phase.returned'));
    expect(d).not.toContain('returned');
    expect(d).not.toContain('phase=');
  });

  it('主题小节只加在简讯栏,标题是「简讯 · 主题」,而且同一主题只出一节', () => {
    // 1 航天 / 2 市场 / 3 航天 —— 页面顺序上被打断了。主人认可那期的形态是
    // 「简 讯 · 提示注入与造物」这样一栏一题,不是同一个题分成三栏。
    const pulse = [1, 2, 3, 4].map((n) =>
      item({ author: `a${n}`, sigil: `s${n}`, authorPopclawId: `pid-${n}` }),
    );
    const items = Object.fromEntries(pulse.map((_, n) => [String(n + 1), { h: `h${n}`, s: `s${n}` }]));
    const { html } = render(issue({ pulse }), {
      ...EDIT,
      items,
      topics: { '1': '航天', '2': '市场', '3': '航天' },
    });
    const heads = [...html.matchAll(/class="kicker"[^>]*>([^<]*)/g)].map((m) => m[1]!);
    const themed = heads.filter((h) => h.includes('·'));
    expect(themed).toEqual([
      L('page.sectionTheme', { section: L('page.section.briefs'), theme: '航天' }),
      L('page.sectionTheme', { section: L('page.section.briefs'), theme: '市场' }),
    ]);
    expect(heads).toContain(L('page.section.briefs')); // 没给主题的那条落在最后的普通栏
  });

  it('人物栏不分小节(法典只给简讯栏分题)', () => {
    const pulse = [1, 2].map((n) => item({ author: `a${n}`, sigil: `s${n}`, authorPopclawId: `pid-${n}`, tier: 'card' }));
    const items = Object.fromEntries(pulse.map((_, n) => [String(n + 1), { h: `h${n}`, s: 's' }]));
    const { html } = render(issue({ pulse }), { ...EDIT, items, topics: { '1': '航天', '2': '市场' } });
    expect(html).toContain(L('page.section.cards'));
    expect(html).not.toContain('>航天<');
  });
});

/**
 * 第二轮外部审查（fable，2026-08-26）复现出来的五条 —— 又全在当时夹具踩不到的分支上。
 * 前四条每一期真实报纸都会走到。**别删。**
 */
describe('第二轮审查抓出来的（回归钉）', () => {
  it('没有主页可指的人,卡头照样是一整行 —— 不许掉成一张原尺寸大头像', () => {
    // 没有 popclaw_id 的作者 profileUrl 就是空('本期账'里那句名录差额说的就是他们)。
    // a() 曾在没链接时把元素整个丢掉,而 .who 正是那一行 flex 容器。
    const { html } = render(issue({ pulse: [item({ tier: 'card', profileUrl: '' })] }));
    expect(html).toContain('<span class="who">');
    const who = html.match(/<span class="who">[\s\S]*?<\/span>/)![0];
    expect(who).toContain('<img'); // 头像在这一行里,受 .who img{width:40px} 管
  });

  it('两条无署名的条目绝不合成一个人', () => {
    // key 曾是 `${author}#${sigil}`,无署名时等于 '#' —— 真值,于是所有无署名条目
    // collapse 成一个卡头加「又记」。认错人比不认得更糟(忠实铁律)。
    const i = issue({
      pulse: [
        item({ author: '', sigil: '', authorPopclawId: '', tier: 'card', media: ['https://cdn/a.jpg'] }),
        item({ author: '', sigil: '', authorPopclawId: '', tier: 'card', media: ['https://cdn/b.jpg'] }),
      ],
    });
    const { html } = render(i, { ...EDIT, items: { '1': { h: '甲', s: 'x' }, '2': { h: '乙', s: 'y' } } });
    // 两条各归各的:一条上卡(密度差只给得起一张),另一条落简讯 —— 关键是
    // 第二条绝不能成为第一条的「又记」,那等于说这两条是同一个人写的。
    expect(html).not.toContain('class="also"');
    expect(html).toContain('x');
    expect(html).toContain('y');
  });

  it('各小节加得齐:人物栏的数要把又记算进去', () => {
    const i = issue({ pulse: [item({ tier: 'card' }), item(), item()] }); // 同一人,一卡两又记
    const { html } = render(i, { ...EDIT, items: { '1': { h: 'a', s: 'a' }, '2': { h: 'b', s: 'b' }, '3': { h: 'c', s: 'c' } } });
    const d = deck(html, 'house-me');
    expect(d).toContain(L('page.items', { count: '3' })); // 栏目头报 3,不是 1
    expect(d.split('class="also"').length - 1).toBe(2);
  });


  it('气象行与本期账两处口径一致(世界来信不许只在一处披露)', () => {
    const i = issue({ houseLetters: [{ houseSlug: 'house-me', fromShort: 'w#1', dateLabel: 'd', body: 'b' }] });
    const { html } = render(i);
    expect(html).toContain(L('page.weather', { total: '1', pings: '0', letters: '1', drifts: '太空行走 · AI' }));
    expect(html).toContain(L('page.ledgerPings', { pings: '0', letters: '1' }));
  });

  it('要闻卡不印互指,也不许把互指的配额白白花掉', () => {
    const pulse = Array.from({ length: 30 }, (_, n) =>
      item({ author: `a${n}`, sigil: `s${n}`, authorPopclawId: `pid-${n}`, tier: 'card' }),
    );
    const items = Object.fromEntries(pulse.map((_, n) => [String(n + 1), { h: `h${n}`, s: `s${n}` }]));
    const xrefs = Object.fromEntries(pulse.map((_, n) => [String(n + 1), `互${n}`]));
    const { html } = render(issue({ pulse }), { ...EDIT, items, xrefs, leads: [1, 2, 3] });
    const top = html.slice(html.indexOf('id="top"'), html.indexOf('class="deck"'));
    expect(top).not.toContain('class="xref"');
    expect(html.split('class="xref"').length - 1).toBe(8); // 配额一格都没被头版吃掉
  });

  it('无坊字段的降级路:一叠、有名字、来信照排', () => {
    const i = issue({
      pulse: [item({ houseSlug: '' })],
      houseLetters: [{ houseSlug: 'somewhere', fromShort: 'w#1', dateLabel: 'd', body: '来信正文' }],
      byHouse: {},
    });
    const { html } = render(i);
    expect(html).toContain(L('page.oneDeck')); // 不是「第一叠 · 」这种断头
    expect(html).toContain('来信正文'); // 账上算了就得排出来
  });

  it('简报里没有转义残渣(模型每期读的就是这段契约)', () => {
    const brief = buildNewspaperPrompt(issue(), { contentRules: '', publishToken: 'tok', leadMax: 3, pickedCount: 1, overBudget: false });
    expect(brief).not.toContain('\\`'); // 被转义的反引号会把两条规则粘成一句
    expect(brief).not.toMatch(/\*\*`,\s*`-/);
  });
});

describe('headsByNumber —— 每条在版面上的标题(关注作者集 descriptor 的素材)', () => {
  it('写过的条目给 edit 的标题,没写的退回自己的首句 —— 与版面同一个来源', () => {
    const i = issue({ pulse: [item({ tier: 'card' }), item({ eventId: 'e2', author: 'linabot', sigil: 'bbbb1111', authorPopclawId: 'pid-lina' })] });
    const { html, headsByNumber } = render(i, {
      ...EDIT,
      items: { '1': { h: '猎鹰落回了发射台', s: '第一段。' } }, // 2 号没写
    });
    expect(headsByNumber.get(1)).toBe('猎鹰落回了发射台');
    expect(headsByNumber.get(2)).toBe('the booster landed on the pad.'); // copyFor 的降级首句
    expect(html).toContain('猎鹰落回了发射台'); // descriptor 引的就是版面上印的
  });

  it('纯增量:加这个字段不改版面本身', () => {
    const a = renderNewspaper(issue(), EDIT, DEFAULT_STYLE, 'zh-CN');
    expect(a.html).toBe(render(issue(), EDIT).html);
    expect([...a.headsByNumber.keys()].sort()).toEqual([1]);
  });
});

describe('unshareColophon —— 上传失败后把分享链接的话收回去', () => {
  it('找得到就换掉,不留分享链接的话', () => {
    // render() 默认 doorbell 开(未传 opts) → 版面自带 shared colophon。
    const { html } = render(issue());
    expect(html).toContain(renderCopy('zh-CN', 'newspaper.page.colophonShared', { count: '1' }));
    const patched = unshareColophon(html, 'zh-CN', 1);
    expect(patched).not.toContain(renderCopy('zh-CN', 'newspaper.page.colophonShared', { count: '1' }));
    expect(patched).toContain(renderCopy('zh-CN', 'newspaper.page.colophon', { count: '1' }));
  });

  // 2026-09-26 review follow-up: a page that never carried the shared line in
  // the first place (doctored, or laid out differently than expected) must
  // not throw — the caller is a failure path that still has to return a
  // receipt — but the false claim staying uncorrected, silently, is exactly
  // the bug this function exists to fix. So: warn once, through the logger,
  // never throw.
  it('找不到就原样返回,且经 logger 报一句警(绝不抛)', () => {
    const doctored = '<html><body><div class="end">something else entirely</div></body></html>';
    const warn = vi.fn();
    let patched = '';
    expect(() => {
      patched = unshareColophon(doctored, 'en', 1, { warn });
    }).not.toThrow();
    expect(patched).toBe(doctored);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('shared colophon line not found');
  });

  it('没传 logger 同样不抛,只是没人喊', () => {
    const doctored = '<html><body>no colophon here</body></html>';
    expect(() => unshareColophon(doctored, 'en', 1)).not.toThrow();
    expect(unshareColophon(doctored, 'en', 1)).toBe(doctored);
  });
});
