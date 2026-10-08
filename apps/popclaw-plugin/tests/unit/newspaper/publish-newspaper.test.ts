/**
 * The write half, v0.2: the agent hands in `edit` (words only) and this lays the
 * page out, uploads it, and reports anything the copy or the style file got wrong.
 * The F2 link check that used to live here is gone with the HTML — the agent
 * never sees a URL now, so there is nothing left for it to fabricate.
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { publishNewspaper, checkEdit, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
import { putIssue, getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { DEFAULT_STYLE } from '../../../src/newspaper/newspaper-style.js';
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
  };
}

const edit = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  masthead: '云舟江湖报',
  items: { '1': { q: 'the booster landed on the pad', h: '猎鹰落回了发射台', s: '一次回收成功。' } },
  teaser: '今日导读',
  ...over,
});

describe('checkEdit —— 门口那道检查', () => {
  const L = (k: string): string => renderCopy('en', `newspaper.publish.${k}`);

  it('缺 items → 退回并说清楚(空报纸不是薄报纸)', () => {
    expect(checkEdit(edit({ items: {} }), 'en')).toEqual({ error: L('editNoItems') });
  });

  it('缺 teaser → 退回(那是主人打开之前唯一看到的一段话)', () => {
    expect(checkEdit(edit({ teaser: '  ' }), 'en')).toEqual({ error: L('editNoTeaser') });
  });

  it('根本不是对象 → 退回,不抛', () => {
    expect(checkEdit('nope', 'en')).toEqual({ error: L('editNotObject') });
    expect(checkEdit(null, 'en')).toEqual({ error: L('editNotObject') });
  });

  it('形状歪了的字段就地忽略,好的照收 —— 绝不因为一格坏了整份退回', () => {
    const r = checkEdit(
      edit({
        items: { '1': { h: '标题' }, '2': 'not an object', '3': { h: '  ' } },
        leads: [2, 'x', -1],
        weather: ['航天', 7],
        pulls: { '1': '一句原话', '2': 5 },
        newbies: { abc: '两三句小传' },
      }),
      'en',
    );
    expect('edit' in r).toBe(true);
    if (!('edit' in r)) return;
    expect(Object.keys(r.edit.items!)).toEqual(['1']); // 空的和不是对象的都不算
    expect(r.edit.leads).toEqual([2]);
    expect(r.edit.weather).toEqual(['航天']);
    expect(r.edit.pulls).toEqual({ '1': '一句原话' });
    expect(r.edit.newbies).toEqual({ abc: '两三句小传' });
  });
});

describe('publishNewspaper', () => {
  beforeEach(() => {
    scratch = makeScratch('publish');
    _resetIssuesForTest();
  });
  afterEach(() => dropScratch(scratch));

  it('排版 → 上画布 → 回执带 teaser、链接与页脚', async () => {
    putIssue('t1', issue());
    const upload = vi.fn(async () => ({ url: 'https://canvas/v/9?t=k' }));
    const r = await publishNewspaper(deps(upload as never), { publishToken: 't1', edit: edit() });
    expect(upload).toHaveBeenCalledOnce();
    expect(r.text).toContain('今日导读');
    expect(r.text).toContain('https://canvas/v/9?t=k');
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.footer'));
    // 2026-09-02 link-truncation fix (owner report: one host's chat linked the
    // URL SHORT, the owner's swallowed the glued suffix — both "bad token"):
    // the window note lives in the lead-in and the URL rides ALONE on its
    // own line, so no channel autolinker can cut it or over-extend it.
    const full = renderCopy('en', 'newspaper.publish.fullText', { url: 'https://canvas/v/9?t=k' });
    expect(r.text).toContain(full);
    expect(full.endsWith('https://canvas/v/9?t=k')).toBe(true); // nothing after the URL
    expect(full).toContain(':\nhttps://'); // URL alone on its line
    // and nothing is glued after the URL in the assembled receipt either
    expect(r.text).toContain(`https://canvas/v/9?t=k\n`);
  });

  it('版面由这一侧排:模型只给了字,页面上却有它从没见过的链接与样式', async () => {
    putIssue('t2', issue({ pulse: [item({ tier: 'card' })] }));
    const sent: string[] = [];
    const upload = vi.fn(async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/v/1?t=k' };
    });
    await publishNewspaper(deps(upload as never), { publishToken: 't2', edit: edit() });
    const html = sent[0]!;
    expect(html).toContain('猎鹰落回了发射台'); // 模型写的字
    expect(html).toContain('https://popclaw.me/post/abc1234567'); // 它没见过的讨论页链接
    expect(html).toContain('--paper:#f7f3ea'); // 骨架样式,不再靠模型复刻
    expect(html.split('<style>').length - 1).toBe(1);
  });

  it('deps.nickname 上版:报头署名带着它进门铃制的页面', async () => {
    putIssue('t-nick', issue({ pulse: [item({ tier: 'card' })] }));
    const sent: string[] = [];
    const upload = vi.fn(async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/v/2?t=k' };
    });
    await publishNewspaper(deps(upload as never), { publishToken: 't-nick', edit: edit() });
    expect(sent[0]!).toContain(renderCopy('en', 'newspaper.page.mastheadOwner', { owner: 'Yu' }));
    expect(sent[0]!).toContain(renderCopy('en', 'newspaper.page.footerShare', { owner: 'Yu' }));
  });

  it('edit 不合格 → 不上传,也不销令牌(让它把稿子再交一次)', async () => {
    putIssue('t3', issue());
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 't3',
      edit: edit({ items: {} }),
    });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toContain('edit.items');
    expect(getIssue('t3')).toBeDefined(); // 令牌还在
  });

  it('没写稿的条目照登(拿它自己的第一句),但回执上要说出来', async () => {
    putIssue('t4', issue({ pulse: [item(), item({ author: 'b', sigil: 'zzzz1111' })] }));
    const r = await publishNewspaper(deps(), { publishToken: 't4', edit: edit() });
    expect(r.text).toContain('edit.items'); // 「有 1 条没稿」
  });

  it('style.json 的抱怨一起上回执 —— 改了没生效必须当场说', async () => {
    putIssue('t5', issue());
    const r = await publishNewspaper(
      { ...deps(), style: { style: DEFAULT_STYLE, notes: ['style.json: unknown key "colour" (ignored)'] } },
      { publishToken: 't5', edit: edit() },
    );
    expect(r.text).toContain('colour');
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.notes'));
  });

  it('leads 指到不存在的条目 → 点名拒收整批,不出报', async () => {
    putIssue('t6', issue());
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload), { publishToken: 't6', edit: edit({ leads: [1, 99] }) });
    expect(r.text).toContain('[99]');
    expect(upload).not.toHaveBeenCalled();
    expect(r.landed).toBeUndefined();
    expect(getIssue('t6')).toBeDefined();
  });

  /**
   * 2026-08-29 真机:令牌对不上时,这里原本会拿「最近一次取到的素材」照发,回执上说一句
   * 「令牌对不上」。可 `edit` 的编号是按**模型当时拿到的那份素材**编的 —— 套到另一份上,
   * 每一条正文都挂到了别人名下(作者与原文链接是对的,正文是别人的)。
   * 一份看起来完整、却每行都在说谎的报纸,比不出报纸糟得多。
   */
  it('令牌对不上 → **拒发**,绝不拿最近那一份来套(认错人比不出报糟得多)', async () => {
    putIssue('t7', issue()); // 盘上确实有一份别的素材,正是当年会被拿来顶上的那一份
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { publishToken: 'unknown', edit: edit() });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.tokenMismatch'));
    expect(getIssue('t7')).toBeDefined(); // 别人的账不许被这次失败销掉
  });

  it('一份账本都没有 → 同样拒发,并告诉它重取一次', async () => {
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { publishToken: 'nope', edit: edit() });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.tokenMismatch'));
  });

  it('整份候选集被端回来 → 拒发,不再按热闹重选(重选会在正文之下换掉整套编号)', async () => {
    const many = issue({ pulse: Array.from({ length: 130 }, (_, i) => item({ eventId: `e${i}`, text: `p${i}` })) });
    putIssue('ctok_t9', many);
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { publishToken: 'ctok_t9', edit: edit() });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.notChosen', { count: '130' }));
  });

  it('画布连不上 → 纸照出(本地那份才是正本),错处记一笔,令牌照销', async () => {
    putIssue('t8', issue());
    const upload = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await publishNewspaper(deps(upload as never), { publishToken: 't8', edit: edit() });
    expect(r.text).toContain(scratch.issuesDir);
    expect(r.text).toContain('boom');
    expect(r.text).toContain('今日导读');
    expect(r.landed).toBe(true);
    expect(getIssue('t8')).toBeUndefined();
    // 2026-09-26 review follow-up: the colophon must not claim a share link that
    // never happened — the disk copy (the master copy) is walked back to the
    // plain closing line once the upload is known to have failed. Both files
    // writeLocalIssue wrote get checked: last-newspaper.html AND the dated
    // archived copy under issuesDir (the one the receipt's path actually points at).
    const onDisk = readFileSync(scratch.lastNewspaperHtml, 'utf-8');
    expect(onDisk).not.toContain(renderCopy('en', 'newspaper.page.colophonShared', { count: '1' }));
    expect(onDisk).toContain(renderCopy('en', 'newspaper.page.colophon', { count: '1' }));
    const archivedName = readdirSync(scratch.issuesDir)[0]!;
    const archived = readFileSync(join(scratch.issuesDir, archivedName), 'utf-8');
    expect(archived).not.toContain(renderCopy('en', 'newspaper.page.colophonShared', { count: '1' }));
    expect(archived).toContain(renderCopy('en', 'newspaper.page.colophon', { count: '1' }));
  });

  it('画布连不上，中文措辞同样收口 —— 分享链接的话不留在盘上', async () => {
    putIssue('t8zh', issue());
    const upload = vi.fn(async () => {
      throw new Error('boom');
    });
    await publishNewspaper({ ...deps(upload as never), lang: 'zh-CN' }, { publishToken: 't8zh', edit: edit() });
    const onDisk = readFileSync(scratch.lastNewspaperHtml, 'utf-8');
    expect(onDisk).not.toContain(renderCopy('zh-CN', 'newspaper.page.colophonShared', { count: '1' }));
    expect(onDisk).toContain(renderCopy('zh-CN', 'newspaper.page.colophon', { count: '1' }));
    const archivedName = readdirSync(scratch.issuesDir)[0]!;
    const archived = readFileSync(join(scratch.issuesDir, archivedName), 'utf-8');
    expect(archived).not.toContain(renderCopy('zh-CN', 'newspaper.page.colophonShared', { count: '1' }));
    expect(archived).toContain(renderCopy('zh-CN', 'newspaper.page.colophon', { count: '1' }));
  });

  it('画布上传成功 → colophon 照实说分享链接在', async () => {
    putIssue('t8s', issue());
    const upload = vi.fn(async () => ({ url: 'https://canvas/v/8?t=k' }));
    await publishNewspaper(deps(upload as never), { publishToken: 't8s', edit: edit() });
    const onDisk = readFileSync(scratch.lastNewspaperHtml, 'utf-8');
    expect(onDisk).toContain(renderCopy('en', 'newspaper.page.colophonShared', { count: '1' }));
  });

  it('社交日志那本账从 issue 推,不另存一份(两处不可能对不上)', async () => {
    putIssue('t9', issue({ totalCount: 42, pings: [{ fromShort: 'a#b', bodyPreview: 'hi' }] }));
    const recorded: { text?: string }[] = [];
    await publishNewspaper(
      { ...deps(), socialLog: { record: (e: { text?: string }) => void recorded.push(e) } as never },
      { publishToken: 't9', edit: edit() },
    );
    expect(recorded[0]!.text).toContain('42 items');
    expect(recorded[0]!.text).toContain('1 awaiting reply');
  });
});
