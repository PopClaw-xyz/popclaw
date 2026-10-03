/**
 * 2026-09-06 真机 P1(内容错配)的回归 —— 编号稳定性,经 r7(basis 闸)到 r9(无猜测)收口。
 *
 * Codex 三端验收(乙机 01:42 / 丙机 01:44 轮)抓到的形态:成刊把别人家的摘要戴在
 * Rainmaker1973 头上(一致的整体错位),丙机回执明说「publish_token=nothing → 回绑
 * 最新成刊」且 edit 引用 [18][22][25] 不存在被忽略。
 *
 * 根因(见 .superpowers/numbering-fix-report.md):编辑稿的编号基准与实际绑定那份
 * 成刊的编号可以合法分叉 —— 稿子自己不声明编号属于哪页,而「最新 / 会话范围内
 * 恰一期」全是猜。r9 裁定(无猜测):publish 只按字段实际指名的那一期绑定 ——
 *  · `edit.basis`(素材页印出、指令教写作端原样带回)= 批次选择器:带了就按它
 *    选定,更新的成刊在后也不抢;那期没了 → 响亮拒绝(basisExpired),绝不退回绑最新;
 *  · publish_token 照旧是最强凭证,完全不受影响;与 basis 同现且一致 → 照常,
 *    不一致 → 上传/落稿/销账之前响亮拒绝(tokenBasisConflict),绝不静默任选;
 *  · 两个字段都没有可靠值 → 一律拒绝(noProvenance)。「范围内恰一期」不再是归属
 *    证明:过期 A 被扫走后只剩 B,A 的迟交稿会被「恰一期」绑给 B 出报(Codex
 *    --expired-a 探针)—— 过期不消除歧义,只剩一本账也不行。
 * 不变量(不许回归):真令牌按发出时的快照对位;同期分批续作接得上(保通四腿);
 * 两条新景(--expired-a / --conflict)拒绝时,谁的账本都不许被动。
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishNewspaper, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
import {
  putIssue,
  putEdit,
  getIssue,
  _resetIssuesForTest,
  _backdateIssueForTest,
} from '../../../src/newspaper/issue-store.js';
import { todayDateLabel } from '../../../src/newspaper/issue.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { issue, item } from './_issue-fixture.js';
import { dropScratch, makeScratch, type Scratch } from './_scratch.js';

let dir: string;
let scratch: Scratch;

function deps(
  upload: PublishDeps['upload'] = async () => ({ url: 'https://canvas/x/1?t=tok' }),
  over: Partial<PublishDeps> = {},
): PublishDeps {
  return {
    upload,
    // Publish asks the signer who the owner is, so the publisher's own byline
    // never wears a follow chip on their own paper.
    signer: { popclawId: async () => 'PublisherFixtureId' } as never,
    nickname: 'Yu',
    canvasBaseUrl: 'https://canvas',
    archive: createLocalNewspaperIssueArchive({ issuesDir: scratch.issuesDir, lastNewspaperHtml: scratch.lastNewspaperHtml }),
    manifestDir: dir,
    ...over,
  };
}

/** dateLabel 是今天的成刊 —— 同日守则下唯一可绑的那种。 */
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
  dir = mkdtempSync(join(tmpdir(), 'popclaw-numbering-'));
  scratch = makeScratch('numbering');
  _resetIssuesForTest();
});
afterEach(() => {
  _resetIssuesForTest(dir);
  dropScratch(scratch);
});

// ---------------------------------------------------------------------------
// 无猜测的第一条(2026-09-06 r9):两个字段都没有可靠值 → 一律拒绝。「范围内恰一
// 期才绑」的回退被整段删除 —— 一本幸存的账不是归属证明:为 A 写的稿子迟交时 A
// 刚好过期,「恰一期」会把 A 的摘要配到 B 的作者名下出报(Codex --expired-a 探针
// 复现)。拒绝是响亮的、不消耗任何账本:写作端把素材页印的 basis 抄回 edit 再交
// 即可,素材页没了就重取重写。
// ---------------------------------------------------------------------------
describe('无令牌无 basis —— 一律拒发(无猜测,r9)', () => {
  it('别的会话有同日成刊在场 → 拒发 noProvenance,谁的账都不动', async () => {
    putIssue(
      'tok_other_session',
      todaysIssue({ pulse: [item({ eventId: 'others1', author: '别的会话的作者', sigil: 'aaaa0001' })] }),
      dir,
      'agent:workshop:别的机器轮次',
    );
    let uploads = 0;
    const upload = async () => {
      uploads += 1;
      return { url: 'https://canvas/v/1?t=k' };
    };
    const r = await publishNewspaper(deps(upload), { edit: edit() });
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(r.landed).toBeUndefined(); // 没出报,也没上传
    expect(uploads).toBe(0);
    expect(getIssue('tok_other_session', dir)).toBeDefined(); // 别人的账不许被销
  });

  it('本会话恰一份成刊在场 → 同样拒发:「只剩一本账」不是归属证明(过期不消除歧义)', async () => {
    putIssue(
      'tok_mine',
      todaysIssue({ pulse: [item({ eventId: 'mine1', author: '本轮作者', sigil: 'bbbb0002' })] }),
      dir,
      'agent:workshop:本轮',
    );
    const upload = async () => ({ url: 'https://canvas/v/2?t=k' });
    const r = await publishNewspaper(deps(upload), { edit: edit() });
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(r.landed).toBeUndefined();
    expect(getIssue('tok_mine', dir)).toBeDefined();
  });

  it('候选集行走器仍只认本会话的候选页(latestCandidate —— r25 后无生产调用方,钉的是行走器语义)', async () => {
    const { latestCandidate } = await import('../../../src/newspaper/issue-store.js');
    putIssue('ctok_other', todaysIssue(), dir, 'agent:workshop:别的轮次');
    putIssue('ctok_mine', todaysIssue(), dir, 'agent:workshop:本轮');
    expect(latestCandidate(dir, todayDateLabel(), 'agent:workshop:本轮')?.token).toBe('ctok_mine');
    expect(latestCandidate(dir, todayDateLabel(), 'agent:workshop:第三轮')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TTL 在 basis 路径上照算:r6 补上内存快路径的 2 小时 TTL 后,同日 8 小时前的旧账
// 在内存里也活不成 —— basis 指名它时同样响亮拒绝,而不是「好歹有一期就绑」。
// ---------------------------------------------------------------------------
describe('内存快路径的 TTL —— 过期的同日旧账,basis 指名也绑不得', () => {
  it('同日但 8 小时前铸的成刊还留在内存里,basis 指名它 → basisExpired 响亮拒绝', async () => {
    putIssue('tok_aged', todaysIssue(), dir, 'agent:workshop:本轮');
    _backdateIssueForTest('tok_aged', Date.now() - 8 * 60 * 60 * 1000, dir); // 内存与盘一起拨回 8 小时前
    const upload = async () => ({ url: 'https://canvas/v/3?t=k' });
    const r = await publishNewspaper(deps(upload), { edit: edit({ basis: 'tok_aged' }) });
    expect(r.landed).toBeUndefined();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.basisExpired', { basis: 'tok_aged' }));
  });
});

// ---------------------------------------------------------------------------
// 同期分批续作:第二批只交 items,但按素材页的吩咐带上 basis(r9 后这是续作的
// 唯一无令牌通路)。存稿的填空式合并、两批同版不变。
// ---------------------------------------------------------------------------
describe('分批续作 —— 第二批带 basis 接回压着存稿的那期', () => {
  it('第一批存稿在 tok_1 上,第二批 items+basis → 接回 tok_1,两批都在版上', async () => {
    putIssue(
      'tok_1',
      todaysIssue({
        pulse: [
          item({ eventId: 'p1', author: '第一批作者甲', sigil: 'cccc0003' }),
          item({ eventId: 'p2', author: '第一批作者乙', sigil: 'cccc0004' }),
        ],
      }),
      dir,
      'agent:workshop:本轮',
    );
    // 第一批的真实形状:checkEdit 在首批强制 masthead+teaser,存下来的稿子必然带着。
    putEdit(
      'tok_1',
      { basis: 'tok_1', masthead: '云舟江湖报', teaser: '第一批的导读', items: { '1': { h: '第一批的标题', s: '第一批的正文。' } } },
      dir,
    );
    const sent: string[] = [];
    const upload = async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/v/4?t=k' };
    };
    // 续稿的形状:只有 items 加 basis(素材页原话「a later batch needs only items」+「basis 每批都带」)。
    const r = await publishNewspaper(deps(upload), {
      edit: { basis: 'tok_1', items: { '2': { q: Q, h: '第二批的标题', s: '第二批的正文,接着第一批的编号。' } } },
    });
    expect(r.landed).toBe(true);
    expect(r.text).toContain(
      renderCopy('en', 'newspaper.publish.basisBoundNote', { token: 'tok_1' }),
    );
    // 第一批的稿子还在(填空式合并),第二批落在 tok_1 的第 2 条上 —— 版面两批都验。
    // (夹具条目是 brief 档,排成一行正文、不带标题,所以验正文。)
    expect(sent[0]).toContain('第一批的正文。');
    expect(sent[0]).toContain('第二批的正文,接着第一批的编号。');
  });

  it('「最新」按铸造时刻算,不按文件 mtime —— 压着存稿的旧刊靠 putEdit 抬高的 mtime 反超不了后来铸的新页', async () => {
    putIssue(
      'tok_older_mint',
      todaysIssue({ pulse: [item({ eventId: 'p1', author: '先铸的作者', sigil: 'cccc0003' })] }),
      dir,
      'agent:workshop:本轮',
    );
    _backdateIssueForTest('tok_older_mint', Date.now() - 1000, dir); // 真的先铸一秒(同毫秒铸造在真机上不存在)
    putIssue(
      'tok_newer_mint',
      todaysIssue({ pulse: [item({ eventId: 'q1', author: '后铸的作者', sigil: 'dddd0005' })] }),
      dir,
      'agent:workshop:本轮',
    );
    // 之后旧刊上落了一批存稿:putEdit 重写文件,mtime 反超后来铸的那份。
    putEdit('tok_older_mint', { basis: 'tok_older_mint', masthead: '云舟江湖报', teaser: '导读', items: { '1': { h: '旧标题', s: '旧正文。' } } }, dir);
    // 排序语义在账本层直接钉(publish 不再走这条排序 —— 绑定只认 token/basis):
    const { latestPickedIssue } = await import('../../../src/newspaper/issue-store.js');
    expect(latestPickedIssue(dir, todayDateLabel(), 'agent:workshop:本轮')?.token).toBe('tok_newer_mint');
  });
});

// ---------------------------------------------------------------------------
// 会话族与无键方:r6 曾给「无会话键的一方(MCP 宿主)」保留不设限的宽容、给子代理
// 开父会话的继承 —— 那都是给「猜」划的范围。r9 之后 publish 根本不猜:任何身份
// 形状,无 token 无 basis 一律同一句拒绝。会话戳自 r25 起只作诊断,不再门任何绑定。
// ---------------------------------------------------------------------------
describe('会话族与无键方 —— 无猜测闸面前没有特权身份(r9)', () => {
  it('子代理无 basis 交稿(父会话恰一份成刊在场) → 同样拒发 noProvenance', async () => {
    putIssue('tok_main', todaysIssue(), dir, 'agent:main');
    const upload = async () => ({ url: 'https://canvas/v/8?t=k' });
    const r = await publishNewspaper(deps(upload), { edit: edit() });
    expect(r.landed).toBeUndefined();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(getIssue('tok_main', dir)).toBeDefined();
  });

  it('无会话键的一方(MCP 宿主)无 basis → 同样拒发 —— r6 的「不设限」优惠随无猜测裁定作废', async () => {
    putIssue('tok_stamped', todaysIssue(), dir, 'agent:gateway');
    const upload = async () => ({ url: 'https://canvas/v/10?t=k' });
    const r = await publishNewspaper(deps(upload), { edit: edit() });
    expect(r.landed).toBeUndefined();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(getIssue('tok_stamped', dir)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 不变量 A:真令牌发布 = 编号冻结。素材页发出之后,账本世界怎么翻腾(别的账
// 被删、新候选集铸出、清扫跑过),这份令牌的编辑稿永远按**发出时的那份快照**
// 对位 —— 第 1 条的摘要必须落在第 1 条的作者/原帖名下。
// ---------------------------------------------------------------------------
describe('编号冻结 —— 真令牌按发出时的快照对位,不受账本世界翻腾影响', () => {
  it('中途删账/铸新候选/清扫 → 真令牌照常出报,摘要与作者一一对应', async () => {
    const mine = todaysIssue({
      pulse: [
        item({ eventId: 'frozen1', author: '冻结作者甲', sigil: 'eeee0007' }),
        item({ eventId: 'frozen2', author: '冻结作者乙', sigil: 'eeee0008' }),
      ],
    });
    putIssue('tok_frozen', mine, dir, 'agent:workshop:本轮');
    // 世界翻腾:另一份账来了又走、新候选集铸出、同日清扫跑过。
    putIssue('tok_distract', todaysIssue(), dir, 'agent:workshop:别的轮次');
    putIssue('ctok_newer', todaysIssue(), dir, 'agent:workshop:本轮');
    const { sweepStaleIssues, deleteIssue } = await import('../../../src/newspaper/issue-store.js');
    deleteIssue('tok_distract', dir);
    sweepStaleIssues(dir, todayDateLabel());
    const sent: string[] = [];
    const upload = async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/v/5?t=k' };
    };
    const r = await publishNewspaper(deps(upload), {
      publishToken: 'tok_frozen',
      edit: edit({
        items: {
          '1': { q: Q, h: '甲的标题', s: '甲的正文摘要。' },
          '2': { q: Q, h: '乙的标题', s: '乙的正文摘要。' },
        },
      }),
    });
    expect(r.landed).toBe(true);
    expect(sent[0]).toContain('冻结作者甲#eeee0007');
    expect(sent[0]).toContain('冻结作者乙#eeee0008');
    expect(sent[0]).toContain('甲的正文摘要。');
    expect(sent[0]).toContain('乙的正文摘要。');
  });

  it('真令牌跨会话照常可发(切片 H:主会话取材、子代理代发,令牌就是同批凭证)', async () => {
    putIssue('tok_subagent', todaysIssue(), dir, 'agent:main');
    const upload = async () => ({ url: 'https://canvas/v/6?t=k' });
    const r = await publishNewspaper(deps(upload), { publishToken: 'tok_subagent', edit: edit() });
    expect(r.landed).toBe(true);
    expect(r.text).not.toContain('basis named'); // 令牌有效,没有回绑一说
  });
});

// ---------------------------------------------------------------------------
// edit 内嵌 basis —— 批次选择器(2026-09-06 r7 定案,r9 收口)。同会话先铸 A
// (编号1=Voyager)再铸 B(编号1=Kremlin),两期同在 TTL 内:为 A 写的编号1摘要
// 迟交 → 只要有 basis 就按 basis 选 A,B 更新也不抢;没有 basis 一律拒(见上)。
// Codex 两条新景(--expired-a / --conflict)的等价回归也钉在这里。
// ---------------------------------------------------------------------------
describe('edit.basis —— 批次选择器,同会话多期并存不再靠「最新」猜', () => {
  /** Codex 探针的形态:A 期编号1=Voyager,B 期编号1=Kremlin,同会话先后铸出。 */
  const putAB = (): void => {
    putIssue(
      'tok_a',
      todaysIssue({ pulse: [item({ eventId: 'voyager', author: 'Rainmaker1973', sigil: 'aaaa0001', text: '旅行者一号还在飞。' })] }),
      dir,
      'agent:workshop:本轮',
    );
    putIssue(
      'tok_b',
      todaysIssue({ pulse: [item({ eventId: 'kremlin', author: 'KremlinWatcher', sigil: 'bbbb0002', text: '克宫消息人士说。' })] }),
      dir,
      'agent:workshop:本轮',
    );
  };

  it('①a 无 basis、同会话 A/B 并存,迟交的 A 稿 → 响亮拒绝,谁也不绑,两本账都在', async () => {
    putAB();
    const upload = async () => ({ url: 'https://canvas/v/11?t=k' });
    const r = await publishNewspaper(deps(upload), {
      edit: edit({ items: { '1': { q: '旅行者一号还在飞。', h: '旅行者一号', s: 'A 期的 Voyager 摘要。' } } }),
    });
    expect(r.landed).toBeUndefined(); // 没出报 —— 这正是此前 landed=true 的 P1 复现位
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(getIssue('tok_a', dir)).toBeDefined();
    expect(getIssue('tok_b', dir)).toBeDefined();
  });

  it('①b 带 basis=tok_a → 哪怕 B 更新,也按 basis 选 A:版面是 Voyager 作者 + A 的摘要', async () => {
    putAB();
    const sent: string[] = [];
    const upload = async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/v/12?t=k' };
    };
    const r = await publishNewspaper(deps(upload), {
      edit: edit({ basis: 'tok_a', items: { '1': { q: '旅行者一号还在飞。', h: '旅行者一号', s: 'A 期的 Voyager 摘要。' } } }),
    });
    expect(r.landed).toBe(true);
    expect(sent[0]).toContain('Rainmaker1973#aaaa0001');
    expect(sent[0]).toContain('A 期的 Voyager 摘要。');
    expect(sent[0]).not.toContain('KremlinWatcher'); // B 的素材一个字都不许上版
  });

  it('basis 查无此期 → 响亮拒绝,不退回「绑最新」(退回就是串位引擎)', async () => {
    putAB();
    const upload = async () => ({ url: 'https://canvas/v/13?t=k' });
    const r = await publishNewspaper(deps(upload), {
      edit: edit({ basis: 'tok_gone9999', items: { '1': { h: 'x', s: 'y.' } } }),
    });
    expect(r.landed).toBeUndefined();
    expect(getIssue('tok_b', dir)).toBeDefined(); // 没有任何人被这次失败销账
  });

  it('--expired-a:过期 A 被扫走只剩 B,A 的无 basis 迟交稿 → 拒发,B 的账分毫不动', async () => {
    putAB();
    _backdateIssueForTest('tok_a', Date.now() - 3 * 60 * 60 * 1000, dir); // A 越过 2h TTL,内存与盘都视为过期
    let uploads = 0;
    const upload = async () => {
      uploads += 1;
      return { url: 'https://canvas/v/17?t=k' };
    };
    const r = await publishNewspaper(deps(upload), {
      edit: edit({ items: { '1': { q: '旅行者一号还在飞。', h: '旅行者一号', s: 'A 期的 Voyager 摘要。' } } }),
    });
    expect(r.landed).toBeUndefined(); // r7 的「恰一期」回退在这里把 A 稿绑给 B 出报 —— 必须死
    expect(uploads).toBe(0);
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(getIssue('tok_a', dir)).toBeUndefined(); // A 确已过期
    expect(getIssue('tok_b', dir)).toBeDefined(); // B 的账不许被这次失败消耗
  });

  it('--expired-a、稿子还带着 A 的 basis → basisExpired 拒发,同样不退回绑 B', async () => {
    putAB();
    _backdateIssueForTest('tok_a', Date.now() - 3 * 60 * 60 * 1000, dir);
    const upload = async () => ({ url: 'https://canvas/v/19?t=k' });
    const r = await publishNewspaper(deps(upload), {
      edit: edit({ basis: 'tok_a', items: { '1': { q: '旅行者一号还在飞。', h: '旅行者一号', s: 'A 期的 Voyager 摘要。' } } }),
    });
    expect(r.landed).toBeUndefined();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.basisExpired', { basis: 'tok_a' }));
    expect(getIssue('tok_b', dir)).toBeDefined();
  });

  it('--conflict:edit.basis=A + publish_token=B → 上传前拒发,两本账分毫不动', async () => {
    putAB();
    let uploads = 0;
    const upload = async () => {
      uploads += 1;
      return { url: 'https://canvas/v/18?t=k' };
    };
    const r = await publishNewspaper(deps(upload), {
      publishToken: 'tok_b',
      edit: edit({ basis: 'tok_a', items: { '1': { q: '旅行者一号还在飞。', h: 'x', s: 'A 期的摘要。' } } }),
    });
    expect(r.landed).toBeUndefined(); // 此前令牌静默获胜、A 稿配 B 版 —— 双字段矛盾必须响亮拒
    expect(uploads).toBe(0);
    expect(r.text).toBe(
      renderCopy('en', 'newspaper.publish.tokenBasisConflict', { basis: 'tok_a', token: 'tok_b' }),
    );
    expect(getIssue('tok_a', dir)).toBeDefined();
    expect(getIssue('tok_b', dir)).toBeDefined();
  });

  it('--conflict 的边界:basis 被洗成 ***(占位形状)+ 真令牌 → 不算矛盾,令牌照常(占位符不构成主张)', async () => {
    putAB();
    const upload = async () => ({ url: 'https://canvas/v/20?t=k' });
    const r = await publishNewspaper(deps(upload), {
      publishToken: 'tok_b',
      edit: edit({ basis: '***', items: { '1': { q: '克宫消息人士说。', h: 'x', s: 'B 期的摘要。' } } }),
    });
    expect(r.landed).toBe(true);
  });

  it('② 子代理带着 basis 选对父会话的旧期(父会话 A/B 并存,basis=tok_a → 选 A)', async () => {
    putAB(); // 父会话 'agent:workshop:本轮' 铸的两期
    const upload = async (a: { html: string }) => {
      lastHtml = a.html;
      return { url: 'https://canvas/v/14?t=k' };
    };
    let lastHtml = '';
    const r = await publishNewspaper(deps(upload), {
      edit: edit({ basis: 'tok_a', items: { '1': { q: '旅行者一号还在飞。', h: 'x', s: 'A 期的摘要。' } } }),
    });
    expect(r.landed).toBe(true);
    expect(lastHtml).toContain('Rainmaker1973#aaaa0001');
    expect(lastHtml).not.toContain('KremlinWatcher');
  });

  it('③ 无会话键(MCP)无 basis 且多期并存 → 同样拒绝,不因旧行为宽松就放行', async () => {
    putIssue('tok_mcp_a', todaysIssue(), dir); // 无戳:无会话键路径的两期
    putIssue('tok_mcp_b', todaysIssue(), dir);
    const upload = async () => ({ url: 'https://canvas/v/15?t=k' });
    const r = await publishNewspaper(deps(upload), { edit: edit() });
    expect(r.landed).toBeUndefined();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
  });

  it('④a 真令牌照常直发(basis 革新不碰令牌路径)', async () => {
    putAB();
    const upload = async () => ({ url: 'https://canvas/v/16?t=k' });
    const r = await publishNewspaper(deps(upload), {
      publishToken: 'tok_a',
      edit: edit({ items: { '1': { q: '旅行者一号还在飞。', h: 'x', s: 'A 期的摘要。' } } }),
    });
    expect(r.landed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 保通四腿(常驻回归):无猜测收紧不许误伤的四条正路 —— 真令牌单独 / basis 单独 /
// 两者一致 / 同期分批续作。任何一条腿红了,收紧就收过头了。
// ---------------------------------------------------------------------------
describe('保通四腿 —— 无猜测收紧不许误伤', () => {
  const putLeg = (): void => {
    putIssue(
      'tok_leg',
      todaysIssue({ pulse: [item({ eventId: 'leg1', author: '腿作者甲', sigil: 'aaaa0011' })] }),
      dir,
      'agent:workshop:本轮',
    );
  };

  it('腿① 真令牌单独 → 照常直发(哪怕跨会话)', async () => {
    putLeg();
    const upload = async () => ({ url: 'https://canvas/v/21?t=k' });
    const r = await publishNewspaper(deps(upload), {
      publishToken: 'tok_leg',
      edit: edit({ items: { '1': { q: Q, h: 'x', s: '腿①的正文。' } } }),
    });
    expect(r.landed).toBe(true);
  });

  it('腿② basis 单独 → 按 basis 绑定出报,回执明说绑了哪期', async () => {
    putLeg();
    const upload = async () => ({ url: 'https://canvas/v/22?t=k' });
    const r = await publishNewspaper(deps(upload), {
      edit: edit({ basis: 'tok_leg', items: { '1': { q: Q, h: 'x', s: '腿②的正文。' } } }),
    });
    expect(r.landed).toBe(true);
    expect(r.text).toContain(
      renderCopy('en', 'newspaper.publish.basisBoundNote', { token: 'tok_leg' }),
    );
  });

  it('腿③ 令牌与 basis 一致 → 照常直发,不加绑定注(令牌本就精确)', async () => {
    putLeg();
    const upload = async () => ({ url: 'https://canvas/v/23?t=k' });
    const r = await publishNewspaper(deps(upload), {
      publishToken: 'tok_leg',
      edit: edit({ basis: 'tok_leg', items: { '1': { q: Q, h: 'x', s: '腿③的正文。' } } }),
    });
    expect(r.landed).toBe(true);
    expect(r.text).not.toContain('basis named'); // 一致不是回绑,不该出现绑定注
  });

  it('腿④ 同期分批续作 → 第一批 moreToWrite,第二批带 basis 接得上,两批都在版上', async () => {
    putIssue(
      'tok_leg4',
      todaysIssue({
        pulse: [
          item({ eventId: 's1', author: '腿四作者甲', sigil: 'cccc0013' }),
          item({ eventId: 's2', author: '腿四作者乙', sigil: 'cccc0014' }),
        ],
      }),
      dir,
      'agent:workshop:本轮',
    );
    const sent: string[] = [];
    const upload = async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/v/24?t=k' };
    };
    const first = await publishNewspaper(deps(upload), {
      edit: edit({ basis: 'tok_leg4', items: { '1': { q: Q, h: 'x', s: '腿④第一批。' } } }),
    });
    expect(first.landed).toBeUndefined(); // 没写完,这批本来就不算落地
    expect(first.text).toContain(renderCopy('en', 'newspaper.publish.moreToWrite', { count: '1', numbers: '[2]' }));
    const second = await publishNewspaper(deps(upload), {
      edit: { basis: 'tok_leg4', items: { '2': { q: Q, h: 'y', s: '腿④第二批。' } } },
    });
    expect(second.landed).toBe(true);
    expect(sent[0]).toContain('腿④第一批。');
    expect(sent[0]).toContain('腿④第二批。');
  });
});

// ---------------------------------------------------------------------------
// 夹具自检:会话戳确实随账落盘 —— r25 起它是诊断字段(谁被发过哪页),不再门任何绑定
// 在它上面。
// ---------------------------------------------------------------------------
describe('夹具自检 —— 这些用例真的搭出了错配的前置条件', () => {
  it('会话戳随账落盘', () => {
    putIssue('tok_stamp', todaysIssue(), dir, 'agent:workshop:本轮');
    const raw = JSON.parse(readFileSync(join(dir, 'tok_stamp.json'), 'utf-8')) as {
      servedSession?: string;
    };
    expect(raw.servedSession).toBe('agent:workshop:本轮');
    expect(existsSync(join(dir, 'tok_stamp.json'))).toBe(true);
  });
});
