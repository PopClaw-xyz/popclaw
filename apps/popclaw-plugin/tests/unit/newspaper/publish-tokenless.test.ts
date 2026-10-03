/**
 * 2026-08-30 定案的信道故障:主人主力宿主路径(ollama.com 云端 glm-5.2:cloud)会把
 * 工具调用参数里任何 `*_token` 键的值在半路洗成 `***` —— 全转录历史 62/62 全灭,
 * 模型正文里写真令牌也没用。所以 publish 这一侧不能把令牌当硬要求。2026-09-06 r9
 * 收口为无猜测契约:令牌缺失/占位符时,edit 里的 `basis`(素材页印出、指令教写作
 * 端原样带回)就是绑定凭证 —— 带了按它精确选定;没带则一律拒发(noProvenance),
 * 绝不回退「绑最新」。护栏(notChosen / wrongNumbering / 全覆盖才发)一条不少。
 * 真样令牌查无此票 → 依旧响亮拒绝,绝不静默顶包。
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishNewspaper, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
import { putIssue, putEdit, getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { todayDateLabel } from '../../../src/newspaper/issue.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { issue, item } from './_issue-fixture.js';
import { dropScratch, makeScratch, type Scratch } from './_scratch.js';

let dir: string;
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
    manifestDir: dir,
  };
}

/** An issue whose dateLabel IS today — the only kind the same-day rule lets live. */
const todaysIssue = (over: Parameters<typeof issue>[0] = {}): ReturnType<typeof issue> =>
  issue({ dateLabel: todayDateLabel(), ...over });

/** 夹具条目正文里原样抄下的一段 —— 每条稿子的 `q`(copy-anchor.ts 要核的锚)。 */
const Q = 'the booster landed on the pad';

const edit = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  masthead: '云舟江湖报',
  items: { '1': { q: Q, h: '猎鹰落回了发射台', s: '一次回收成功。' } },
  teaser: '今日导读',
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-tokenless-'));
  scratch = makeScratch('tokenless');
  _resetIssuesForTest();
});
afterEach(() => dropScratch(scratch));

describe('publish_token 可选 —— 信道会把令牌洗成 ***,协议必须不靠它', () => {
  it('不带令牌、edit 带 basis → 按 basis 绑定该期,照常出报,回执上明说绑了哪份', async () => {
    putIssue('tok_live', todaysIssue(), dir);
    const upload = vi.fn(async () => ({ url: 'https://canvas/v/9?t=k' }));
    const r = await publishNewspaper(deps(upload as never), { edit: edit({ basis: 'tok_live' }) });
    expect(upload).toHaveBeenCalledOnce();
    expect(r.text).toContain('https://canvas/v/9?t=k');
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.basisBoundNote', { token: 'tok_live' }));
    expect(getIssue('tok_live', dir)).toBeUndefined(); // 发完照常销账
  });

  it('令牌是 *** (宿主洗过的样子) → 当作没给,同样按 basis 绑定', async () => {
    putIssue('tok_live', todaysIssue(), dir);
    const upload = vi.fn(async () => ({ url: 'https://canvas/v/1?t=k' }));
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: '***',
      edit: edit({ basis: 'tok_live' }),
    });
    expect(upload).toHaveBeenCalledOnce();
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.basisBoundNote', { token: 'tok_live' }));
  });

  it('不带令牌也不带 basis → 一律拒发,绝不回退「绑最新」(r9 无猜测)', async () => {
    putIssue('tok_live', todaysIssue(), dir);
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { edit: edit() });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(getIssue('tok_live', dir)).toBeDefined(); // 账没被消耗,补个 basis 再交就行
  });

  it('盘上只有候选集 → 同样拒绝,候选集不许被消耗', async () => {
    putIssue('ctok_only', todaysIssue({ pulse: Array.from({ length: 130 }, (_, i) => item({ eventId: `e${i}` })) }), dir);
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { edit: edit() });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(getIssue('ctok_only', dir)).toBeDefined();
  });

  it('真样令牌查无此票 → 依旧拒发,不许静默顶包(2026-08-29 的教训不动摇)', async () => {
    putIssue('tok_live', issue(), dir);
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'tok_nope1234',
      edit: edit(),
    });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.tokenMismatch'));
    expect(getIssue('tok_live', dir)).toBeDefined(); // 别人的账不许被这次失败销掉
  });

  // 2026-09-06 r7:两份成刊并存时,「绑最新」正是把 A 期稿子发到 B 期版面上的串位
  // 引擎(Codex 同会话 A/B 探针复现)—— r9 起:无 basis 响亮拒发;带 basis 精确
  // 选定,后铸的抢不走。basis 是 edit 里的普通字段,洗 *_token 的信道对它没有
  // 规则可施 —— 这是协议形状加指令的要求,不是宿主必然保留的物理保证。
  it('两份成刊并存、edit 没带 basis → 无从知道编号属于哪页,响亮拒发,谁也不绑', async () => {
    putIssue('tok_old', todaysIssue({ pulse: [item({ eventId: 'old1', author: 'oldface', sigil: 'aaaa0000' })] }), dir);
    putIssue('tok_new', todaysIssue({ pulse: [item({ eventId: 'new1', author: 'newface', sigil: 'bbbb1111' })] }), dir);
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { edit: edit() });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(getIssue('tok_old', dir)).toBeDefined(); // 两本账分毫未动
    expect(getIssue('tok_new', dir)).toBeDefined();
  });

  it('两份成刊并存、edit 带 basis → 按 basis 选定那份,后铸的抢不走', async () => {
    putIssue('tok_old', todaysIssue({ pulse: [item({ eventId: 'old1', author: 'oldface', sigil: 'aaaa0000' })] }), dir);
    putIssue('tok_new', todaysIssue({ pulse: [item({ eventId: 'new1', author: 'newface', sigil: 'bbbb1111' })] }), dir);
    const sent: string[] = [];
    const upload = vi.fn(async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/v/2?t=k' };
    });
    const r = await publishNewspaper(deps(upload as never), {
      edit: edit({ basis: 'tok_old', items: { '1': { q: Q, h: '旧刊的标题', s: '按旧刊编号写的正文。' } } }),
    });
    expect(r.landed).toBe(true);
    expect(sent[0]).toContain('oldface'); // 版面上的作者来自 basis 选定的那份成刊
    expect(sent[0]).not.toContain('newface'); // 后铸的那份一个字都不许上版
    expect(getIssue('tok_new', dir)).toBeDefined(); // 没被选中的账没被动
  });

  it('编号对不上这套护栏在 basis 路径上同样生效(多数编号不在 → 拒发)', async () => {
    putIssue('tok_live', todaysIssue(), dir);
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), {
      edit: edit({ basis: 'tok_live', items: { '97': { h: 'a', s: 'b.' }, '98': { h: 'c', s: 'd.' }, '99': { h: 'e', s: 'f.' } } }),
    });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(
      renderCopy('en', 'newspaper.publish.wrongNumbering', { stray: '3', total: '3', numbers: 'items[97] items[98] items[99]' }),
    );
  });

  it('分批回执不再要求带令牌续稿(令牌那句话本身就是死循环教练)', async () => {
    putIssue('tok_live', todaysIssue({ pulse: [item(), item({ eventId: 'e2', author: 'b', sigil: 'zzzz1111' })] }), dir);
    const r = await publishNewspaper(deps(), { edit: edit({ basis: 'tok_live' }) });
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.moreToWrite', { count: '1', numbers: '[2]' }));
    expect(r.text).not.toContain('publish_token="');
  });
});

// ---------------------------------------------------------------------------
// 同日守门(2026-09-03 夜裁定):昨夜没写完的残刊绝不能劫持今天的交稿。真机
// (甲机)的事故形态:昨晚的 issue 文件越过了 2 小时 TTL(机器夜里关过
// /日界翻篇),被「最新成刊」绑走。r9 之后 publish 不再走账本扫描,残刊的
// 清扫归 sweepStaleIssues(见 issue-store 测试);这里钉的是:无论谁在场,
// 无凭证的交稿一律拒绝,且拒绝不消耗任何账。
// ---------------------------------------------------------------------------
describe('同日守门 —— 昨天的残刊不劫持今天的交稿', () => {
  it('昨夜没写完的残刊在场 → 无凭证交稿照样拒绝,残刊文件原样留着(清扫归 sweep)', async () => {
    putIssue('tok_yday', issue({ dateLabel: '2026年9月2日' }), dir); // 固定的过去日期 ≠ 今天
    putEdit('tok_yday', { masthead: '昨天的旧报' }, dir); // 没写完的存稿还挂在上面
    _resetIssuesForTest(); // 换个进程视角:只剩盘上那本
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { edit: edit() });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(existsSync(join(dir, 'tok_yday.json'))).toBe(true); // 拒绝不删账;死账由清扫收走
  });

  it('今天的成刊带着没写完的存稿 → 带 basis 照常续写(同日恢复不受影响)', async () => {
    putIssue('tok_today', todaysIssue({ pulse: [item(), item({ eventId: 'e2', author: 'b', sigil: 'zzzz1111' })] }), dir);
    putEdit('tok_today', { basis: 'tok_today', masthead: '云舟江湖报', items: { '1': { h: '第一批的标题', s: '第一批的正文。' } } }, dir);
    const r = await publishNewspaper(deps(), { edit: edit({ basis: 'tok_today' }) });
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.basisBoundNote', { token: 'tok_today' }));
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.moreToWrite', { count: '1', numbers: '[2]' }));
  });
});

// ---------------------------------------------------------------------------
// F1 + B' (2026-09-12, two live hosts): the candidate ancestry.
//
// The word `basis` named two pages at once — `candidate_basis` on the picks
// call, `edit.basis` inside the hand-in — and a strong model handed in
// `edit.basis=ctok_…` with `publish_token=tok_…`, then lost two rounds: the
// conflict refusal never said which value to keep, and once it dropped the
// token the `ctok_` basis walked into the candidate gate, which sent it back to
// the candidate page although a live material page existed. Both legs are fixed
// from the issue's stamped parent: a hand-in whose two names are parent and
// child of one another binds the child, and the refusals name the material
// page's own id instead of ordering a restart.
// ---------------------------------------------------------------------------
describe('候选血统 —— ctok basis + 真令牌绑子刊,拒收话里点名 tok_', () => {
  it('edit.basis 是本刊的候选父页、publish_token 指向本刊 → 照常出报,回执点名下次带哪个 basis', async () => {
    putIssue('tok_child', todaysIssue(), dir, undefined, 'ctok_parent01');
    const upload = vi.fn(async () => ({ url: 'https://canvas/v/7?t=k' }));
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'tok_child',
      edit: edit({ basis: 'ctok_parent01' }),
    });
    expect(upload).toHaveBeenCalledOnce();
    expect(r.landed).toBe(true);
    expect(r.text).toContain(
      renderCopy('en', 'newspaper.publish.candidateAncestryNote', {
        token: 'tok_child',
        candidate: 'ctok_parent01',
      }),
    );
  });

  it('候选 basis 与令牌所指成刊没有血统关系 → 仍拒,但话里点名素材页的 id', async () => {
    putIssue('tok_child', todaysIssue(), dir, undefined, 'ctok_parent01');
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), {
      publishToken: 'tok_child',
      edit: edit({ basis: 'ctok_stranger' }),
    });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(
      renderCopy('en', 'newspaper.publish.tokenBasisConflictNamed', {
        basis: 'ctok_stranger',
        token: 'tok_child',
        material: 'tok_child',
      }),
    );
    expect(getIssue('tok_child', dir)).toBeDefined(); // 拒绝不消耗
  });

  it('两个都是成刊形状、互不相同 → 仍是旧的矛盾拒收(没有哪个更「素材页」)', async () => {
    putIssue('tok_a', todaysIssue(), dir);
    const r = await publishNewspaper(deps(vi.fn() as never), {
      publishToken: 'tok_b',
      edit: edit({ basis: 'tok_a' }),
    });
    expect(r.text).toBe(
      renderCopy('en', 'newspaper.publish.tokenBasisConflict', { basis: 'tok_a', token: 'tok_b' }),
    );
  });

  it('只带候选 basis、令牌被洗掉 → 不再叫它回候选页,而是点名已经铸出的素材页', async () => {
    putIssue('ctok_parent02', todaysIssue(), dir);
    putIssue('tok_child2', todaysIssue(), dir, undefined, 'ctok_parent02');
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { edit: edit({ basis: 'ctok_parent02' }) });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(
      renderCopy('en', 'newspaper.publish.notChosenHasMaterial', { count: '1', token: 'tok_child2' }),
    );
    expect(getIssue('ctok_parent02', dir)).toBeDefined();
    expect(getIssue('tok_child2', dir)).toBeDefined();
  });

  it('候选页还没铸出任何素材页 → 保留旧措辞(回去挑)', async () => {
    putIssue('ctok_parent03', todaysIssue(), dir);
    const r = await publishNewspaper(deps(vi.fn() as never), { edit: edit({ basis: 'ctok_parent03' }) });
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.notChosen', { count: '1' }));
  });
});
