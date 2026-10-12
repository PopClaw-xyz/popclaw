/**
 * The doorbell surfaces of the page (spec §6.1): a follow chip on every
 * author row that has someone to follow, a quiet external tag where there is
 * not, the masthead attribution, the three foot lines, and the inline script.
 *
 * The iron assertion is the one the spec calls v3-⑤: **the page carries no
 * id-shaped blob** — the doorbell must be answerable from a link without the
 * page ever teaching a reader anyone's popclaw id beyond the button's own
 * target.
 *
 * Untouched on purpose: the new-faces ear's `!p.isFollowing` filter and its
 * 未关注 tag (spec §6.1 last line — D5 constrains the byline entries, not
 * the ear; the last test pins it so nobody "fixes" it back).
 */
import { describe, it, expect } from 'vitest';
import { renderNewspaper, type NewspaperEdit } from '../../../src/newspaper/render-newspaper.js';
import { DEFAULT_STYLE, type NewspaperStyle } from '../../../src/newspaper/newspaper-style.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import type { IssueData } from '../../../src/newspaper/issue.js';
import { issue, item } from './_issue-fixture.js';

const L = (key: string, vars: Record<string, string> = {}): string =>
  renderCopy('zh-CN', `newspaper.${key}`, vars);

const EDIT: NewspaperEdit = {
  masthead: '云舟江湖报',
  items: {
    '1': { h: '猎鹰落回了发射台', s: '第一段。' },
    '2': { h: '次条', s: 'b' },
    '3': { h: '转载一条', s: 'c' },
  },
  teaser: '导读',
};

const render = (
  i: IssueData = issue(),
  edit: NewspaperEdit = EDIT,
  style: Partial<NewspaperStyle> = {},
  opts?: { ownerNickname?: string },
): ReturnType<typeof renderNewspaper> =>
  renderNewspaper(i, edit, { ...DEFAULT_STYLE, ...style }, 'zh-CN', opts);

/** A production-shaped followee id: popclaw ids are ~44-char base58 — exactly
 * what the follow chip's data-followee legitimately carries (the button's own
 * target). The zero-base58 regex below can no longer mean "no ids anywhere";
 * it means "no ids beyond the ones we put in data-followee on purpose". */
const AUTHOR_ID = '7xKvGjWntCHSPQoyY2mLBRTDdQFEAqNsZz4fCcrKVJ9u';
/** The owner's popclaw id, known to this test — v3-⑤'s real forbidden string.
 * The fixture carries it as the authorPopclawId of the owner's own post (which
 * has no EDIT copy, so the layout drops the item): the renderer thus HOLDS the
 * owner's id in its issue data, and any channel that starts echoing pulse-item
 * ids (a data-attr for the reader pass, an analytics hook) trips here. */
const OWNER_ID = '3fQwbEyrTUmNehkPgLszTkEtDvjohTcAySwFxNagXq8r';

/** The page with one followable card, one followable brief and one external author. */
const mixed = (): IssueData =>
  issue({
    pulse: [
      item({ tier: 'card', authorPopclawId: AUTHOR_ID }), // levelsio · production-length id
      item({ author: 'b', sigil: 'zz', authorPopclawId: 'pid-b', replyCount: 2 }), // brief row, short id on purpose (other assertions slice on it)
      item({ author: '转载君', sigil: '', authorPopclawId: '', tier: 'card', profileUrl: '' }),
      item({ author: '云舟', sigil: 'own', authorPopclawId: OWNER_ID }), // the owner's own post, unprinted
    ],
  });

describe('作者旁的入口', () => {
  it('卡片头带按钮:data-followee 是作者 id,data-label 是名#印信', () => {
    const { html } = render(issue({ pulse: [item({ tier: 'card' })] }));
    expect(html).toContain(
      `<button class="follow-btn" data-followee="pid-levelsio" data-label="levelsio#65v29fn1">${L('page.followCta')}</button>`,
    );
  });

  it('卡片头的按钮在 .who 锚点之外、同一行行尾——按钮不许嵌进链接里(审查修复)', () => {
    // Review decision: placing the chip inside <a class="who"> both rings the bell and opens the author's homepage, and creates invalid nesting.
    // Use the brief-row fix: put it at the end of the equivalent .who-row outside the anchor; the script also uses preventDefault.
    const { html } = render(issue({ pulse: [item({ tier: 'card' })] }));
    const who = html.match(/<a class="who"[^>]*>[\s\S]*?<\/a>/)![0];
    expect(who).not.toContain('follow-btn');
    const row = html.match(/<div class="who-row">[\s\S]*?<\/div>/)![0];
    expect(row).toContain('<a class="who"');
    expect(row).toContain('data-followee="pid-levelsio"');
    expect(row).toContain('</a><button class="follow-btn"'); // Anchor first, button second, on the same row.
  });

  it('头版 lead 的作者块同款入口,同样在锚点外', () => {
    const { html } = render(issue({ pulse: [item({ tier: 'card' })] }), { ...EDIT, leads: [1] });
    const lead = html.slice(html.indexOf('<article class="lead"'), html.indexOf('</article>'));
    expect(lead).toContain('data-followee="pid-levelsio"');
    const who = lead.match(/<a class="who"[^>]*>[\s\S]*?<\/a>/)![0];
    expect(who).not.toContain('follow-btn');
  });

  it('简讯行也有,位置统一在行尾 counts 之前', () => {
    const { html } = render(mixed());
    const brief = html.slice(html.indexOf('class="brief"'), html.indexOf('</div>', html.indexOf('pid-b')));
    const chip = brief.indexOf('class="follow-btn"');
    const cnt = brief.indexOf('class="cnt"');
    expect(chip).toBeGreaterThan(-1);
    expect(cnt).toBeGreaterThan(-1);
    expect(chip).toBeLessThan(cnt); // At the row end, before counts, consistently throughout the newspaper.
  });

  it('无 popclaw 身份的作者:非交互的外部平台 tag,绝无按钮', () => {
    const { html } = render(mixed());
    expect(html).toContain(`<span class="tag">${L('page.externalTag')}</span>`);
    // Two followable authors (levelsio card and b brief), excluding the repost author: button count equals followable-author count.
    expect(html.split('class="follow-btn"').length - 1).toBe(2);
  });

  it('简讯行的外部作者带同一枚外部平台 tag(小号);popclaw 作者的简讯行不带', () => {
    // Criterion 3's inline static marker applies to every tier: cards use the personMeta tag and brief rows must use
    // the same key and text, scaled down for a brief row, without interaction.
    const { html } = render(
      issue({
        pulse: [
          item({ author: '外君', sigil: '', authorPopclawId: '', profileUrl: '' }), // Brief item, external author.
          item({ author: 'b', sigil: 'zz', authorPopclawId: 'pid-b' }), // Brief item, popclaw author.
        ],
      }),
    );
    const rows = html.split('<div class="brief">').slice(1).map((r) => r.slice(0, r.indexOf('</div>')));
    const ext = rows.find((r) => r.includes('外君'))!;
    const own = rows.find((r) => r.includes('pid-b'))!;
    expect(ext).toContain(`<span class="tag">${L('page.externalTag')}</span>`);
    expect(ext).not.toContain('follow-btn'); // External author: static tag, not a button.
    expect(own).not.toContain(`<span class="tag">${L('page.externalTag')}</span>`); // Has an identity: omit this tag.
    expect(html).toContain('.brief .tag{'); // Smaller styling for a brief row.
  });

  it('不烤 isFollowing:本地关注状态不再产出「已关注」span,初始一律 cta', () => {
    const { html } = render(issue({ pulse: [item({ tier: 'card', isFollowing: true })] }));
    // The old following span used the deleted page.following key; anchor the negative assertion on
    // the surviving page.followFollowed key with the same text. Semantics are unchanged: static pages never generate this span.
    // The reader-pass script creates the following marker client-side; see chip.followed in render-newspaper.
    expect(html).not.toContain(`<span class="tag">${L('page.followFollowed')}</span>`);
    expect(html).toContain(`data-label="levelsio#65v29fn1">${L('page.followCta')}</button>`);
  });

  it('按钮有真按钮的样子:可点、悬停有反馈,简讯行里小一号', () => {
    const { html } = render(mixed());
    expect(html).toContain('.follow-btn{');
    expect(html).toContain('cursor:pointer');
    expect(html).toContain('.follow-btn:hover{');
    expect(html).toContain('.brief .follow-btn{');
    expect(html).toContain('.who-row{'); // Card-row container: anchor and button share a row.
  });
});

describe('报头与页脚', () => {
  it('报头署名:ownerNickname 传入才印,不传不出', () => {
    const owned = render(mixed(), EDIT, {}, { ownerNickname: '听风' });
    expect(owned.html).toContain(L('page.mastheadOwner', { owner: '听风' }));
    const masthead = owned.html.slice(owned.html.indexOf('class="masthead"'), owned.html.indexOf('class="rule2"'));
    expect(masthead).toContain(L('page.mastheadOwner', { owner: '听风' }));
    // Without owner, render no such line; stylesheet class declarations do not count as visible output.
    expect(render(mixed()).html).not.toContain('class="masthead-owner"');
  });

  it('页脚报主行常在;分享行带 owner 名;无身份说明仅当期有无身份作者', () => {
    const r = render(mixed(), EDIT, {}, { ownerNickname: '听风' });
    expect(r.html).toContain(L('page.footerOwner'));
    expect(r.html).toContain(L('page.footerShare', { owner: '听风' }));
    expect(r.html).toContain(L('page.footerExternal')); // mixed() contains one repost author.
    const clean = render(issue({ pulse: [item({ tier: 'card' })] }), EDIT, {}, { ownerNickname: '听风' });
    expect(clean.html).not.toContain(L('page.footerExternal'));
  });
});

describe('内联脚本与零 id 誓约', () => {
  it('页面唯一一段脚本就是门铃,贴着 </body>', () => {
    const { html } = render(mixed(), EDIT, {}, { ownerNickname: '听风' });
    expect(html.split('<script').length - 1).toBe(1);
    expect(html.endsWith('</script></body></html>')).toBe(true);
    expect(html).not.toContain('onclick');
  });

  it('v3-⑤ 真属性:被关注者的 base58 在页上(data-followee),主人的 id 不在', () => {
    const { html } = render(mixed(), EDIT, {}, { ownerNickname: '听风' });
    // By design, the button target is the followee's roughly 44-character base58 ID and must appear on the page.
    expect(html).toContain(`data-followee="${AUTHOR_ID}"`);
    // The owner's ID never appears: the renderer does not accept it, and the fixture embeds it in the owner's own post above
    // to verify that even an ID present in issue data is never echoed.
    expect(html).not.toContain(OWNER_ID);
    // Keep the global regex, but now assert that apart from deliberate data-followee button targets,
    // the page has no ID-shaped strings, including leaks through URLs, event IDs, house fields or inline scripts.
    expect(html.split(AUTHOR_ID).join('')).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{40,}/);
  });
});

describe('耳栏原样保留', () => {
  it('新面孔耳栏的 !p.isFollowing 过滤与「未关注」tag 都还在(spec §6.1:勿当 bug 修回去)', () => {
    const { html } = render(
      issue({
        pulse: [
          item({ tier: 'card', newcomerDays: 2 }),
          item({ author: 'c', sigil: 'yy', authorPopclawId: 'pid-c' }), // Known face, excluded from the new-faces sidebar.
        ],
      }),
    );
    const earStart = html.indexOf(L('page.ear.newFaces'));
    const ear = html.slice(earStart, html.indexOf('</aside>', earStart));
    expect(ear).toContain(`<span class="tag">${L('page.notFollowing')}</span>`);
    expect(ear).not.toContain('pid-c');
    expect(ear).not.toContain('follow-btn'); // No buttons in the ear column: doorbells belong only on bylines.
  });
});
