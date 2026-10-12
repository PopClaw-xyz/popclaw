/**
 * The follow doorbell's next-day piggyback (doorbell spec §6.5 fallback leg):
 * unresolved pending rows ride the NEXT day's delivery message as a numbered
 * list with its own reply syntax — the catch-all for a batch every other leg
 * missed. Three states are pinned: rows present → block present (after the
 * footer, names verbatim `name#sigil`); no rows → absent; dep not injected →
 * absent (test stubs and store-less hosts must see the old receipt).
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { publishNewspaper, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
import { putIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { issue, item } from './_issue-fixture.js';
import { dropScratch, makeScratch, type Scratch } from './_scratch.js';

let scratch: Scratch;

function deps(over: Partial<PublishDeps> = {}): PublishDeps {
  return {
    upload: async () => ({ url: 'https://canvas/v/9?t=k' }),
    // Publish asks the signer who the owner is, so the publisher's own byline
    // never wears a follow chip on their own paper.
    signer: { popclawId: async () => 'PublisherFixtureId' } as never,
    nickname: 'Yu',
    canvasBaseUrl: 'https://canvas',
    archive: createLocalNewspaperIssueArchive({ issuesDir: scratch.issuesDir, lastNewspaperHtml: scratch.lastNewspaperHtml }),
    // zh so the assertions below are the spec §7 bytes, not a paraphrase.
    lang: 'zh-CN',
    ...over,
  };
}

const edit = (): Record<string, unknown> => ({
  masthead: '云舟江湖报',
  items: { '1': { q: 'the booster landed on the pad', h: '猎鹰落回了发射台', s: '一次回收成功。' } },
  teaser: '今日导读',
});

const PENDING = [
  { display_name: '云舟#3m8v' },
  { display_name: 'levelsio#9xqe' },
];

describe('publishNewspaper —— 次日捎带（门铃兜底腿）', () => {
  beforeEach(() => {
    scratch = makeScratch('piggyback');
    _resetIssuesForTest();
  });
  afterEach(() => dropScratch(scratch));

  it('残单非空 → 回执末尾捎带编号块（页脚之后、名字照存、自带回复语法）', async () => {
    putIssue('t1', issue());
    const r = await publishNewspaper(deps({ pendingList: () => PENDING }), {
      publishToken: 't1',
      edit: edit(),
    });
    const block = renderCopy('zh-CN', 'newspaper.doorbell.piggyback', {
      n: '2',
      list: '1. 云舟#3m8v 2. levelsio#9xqe',
    });
    expect(r.text).toContain(block);
    expect(r.text).toContain('48 小时后我就不提了');
    // Append after the footer: this piggybacks on the next-day newspaper delivery message, not its body.
    expect(r.text.indexOf(block)).toBeGreaterThan(r.text.indexOf(renderCopy('zh-CN', 'newspaper.publish.footer')));
  });

  it('残单为空 → 一字不提（没有残单就不打扰）', async () => {
    putIssue('t2', issue());
    const r = await publishNewspaper(deps({ pendingList: () => [] }), { publishToken: 't2', edit: edit() });
    expect(r.text).not.toContain('待关注');
    expect(r.text).toContain(renderCopy('zh-CN', 'newspaper.publish.footer'));
  });

  it('依赖未注入 → 不捎带（测试桩与无库宿主看到的还是旧回执）', async () => {
    putIssue('t3', issue());
    const r = await publishNewspaper(deps(), { publishToken: 't3', edit: edit() });
    expect(r.text).not.toContain('待关注');
  });

  it('读残单抛了 → 报照样出,捎带就地放弃（副产品不许沉掉回执）', async () => {
    putIssue('t4', issue());
    const r = await publishNewspaper(
      deps({
        pendingList: () => {
          throw new Error('db gone');
        },
      }),
      { publishToken: 't4', edit: edit() },
    );
    expect(r.text).toContain('https://canvas/v/9?t=k');
    expect(r.text).not.toContain('待关注');
  });

  it('画布连不上（本地兜底腿）→ 捎带照骑：纸换了个住处,欠的关注没换', async () => {
    putIssue('t5', issue({ pulse: [item()] }));
    const r = await publishNewspaper(
      deps({
        upload: async () => {
          throw new Error('canvas down');
        },
        pendingList: () => PENDING,
      }),
      { publishToken: 't5', edit: edit() },
    );
    expect(r.text).toContain(scratch.issuesDir);
    expect(r.text).toContain('昨天的报纸还有 2 位待关注');
  });
});
