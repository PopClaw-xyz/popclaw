/**
 * Real-host P1 content mismatch regression, 2026-09-06: stable numbering, from r7's basis gate to r9's
 * no-guess contract. Codex acceptance on hosts B (01:42) and C (01:44) found whole-issue displacement:
 * other people's summaries appeared under Rainmaker1973. Host C's receipt explicitly rebound
 * `publish_token=nothing` to the latest issue and ignored nonexistent edit references [18][22][25].
 * Root cause (see .superpowers/numbering-fix-report.md): an edit's number basis could legitimately
 * diverge from the bound issue; the edit did not name its material page, and "latest" or "exactly one
 * in scope" guessed. The r9 no-guess ruling binds publish only to the issue explicitly named by a
 * field. `edit.basis`, printed on the material page and copied verbatim by the writer, selects that
 * batch; newer issues cannot steal it, and a missing issue is loudly refused (basisExpired), never
 * rebound to latest. A real publish_token remains strongest; matching token and basis proceed
 * normally, while conflict is refused before upload, saving or settlement (tokenBasisConflict), never
 * silently chosen. No reliable provenance in either field always yields noProvenance. A sole issue in
 * scope is not proof: once expired A is swept, A's late edit could bind to surviving B (Codex
 * --expired-a probe). Expiry does not eliminate ambiguity. Invariants: real tokens align with their
 * original snapshot; same-issue batches continue through all four valid paths; --expired-a and
 * --conflict failures must leave every ledger unchanged.
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

/**
 * dateLabel describes today's issue: the only issue the same-day rule can bind.
 */
const todaysIssue = (over: Parameters<typeof issue>[0] = {}): ReturnType<typeof issue> =>
  issue({ dateLabel: todayDateLabel(), ...over });

/**
 * A verbatim passage from each fixture item's body: the edit's `q` anchor checked by copy-anchor.ts.
 */
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
// First no-guess rule (r9, 2026-09-06): no reliable value in either field always means refusal. Remove the
// "exactly one issue in scope" fallback: a surviving ledger does not prove provenance. A late edit for A,
// which just expired, must not place A's summaries under B's authors (Codex --expired-a reproduction).
// Refusal is explicit and consumes no ledger. Copy the material page's basis into edit and submit again;
// if the material page is gone, gather and write again.
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
    expect(r.landed).toBeUndefined(); // No publication or upload.
    expect(uploads).toBe(0);
    expect(getIssue('tok_other_session', dir)).toBeDefined(); // Do not settle someone else's ledger.
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
// TTL also applies to basis: r6 added a two-hour TTL to the memory fast path, so an eight-hour-old
// same-day ledger is expired in memory too. Naming it by basis is refused, not bound merely because one issue exists.
// ---------------------------------------------------------------------------
describe('内存快路径的 TTL —— 过期的同日旧账,basis 指名也绑不得', () => {
  it('同日但 8 小时前铸的成刊还留在内存里,basis 指名它 → basisExpired 响亮拒绝', async () => {
    putIssue('tok_aged', todaysIssue(), dir, 'agent:workshop:本轮');
    _backdateIssueForTest('tok_aged', Date.now() - 8 * 60 * 60 * 1000, dir); // Move both memory and disk eight hours into the past.
    const upload = async () => ({ url: 'https://canvas/v/3?t=k' });
    const r = await publishNewspaper(deps(upload), { edit: edit({ basis: 'tok_aged' }) });
    expect(r.landed).toBeUndefined();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.basisExpired', { basis: 'tok_aged' }));
  });
});

// ---------------------------------------------------------------------------
// Same-issue batches: the second submits only items plus basis as the material page requires (r9's
// only tokenless continuation path). Fill-only saved-edit merging and the shared issue layout remain intact.
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
    // Actual first-batch shape: checkEdit requires masthead+teaser; a stored first edit necessarily has both.
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
    // Continuation shape: items plus basis (material instructions require only items later, with basis in every batch).
    const r = await publishNewspaper(deps(upload), {
      edit: { basis: 'tok_1', items: { '2': { q: Q, h: '第二批的标题', s: '第二批的正文,接着第一批的编号。' } } },
    });
    expect(r.landed).toBe(true);
    expect(r.text).toContain(
      renderCopy('en', 'newspaper.publish.basisBoundNote', { token: 'tok_1' }),
    );
    // The first batch remains through fill-only merging; the second writes tok_1 item 2. Verify both batches' layout.
    // Fixture items are briefs, rendered as body-only lines without headlines, so check the body.
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
    _backdateIssueForTest('tok_older_mint', Date.now() - 1000, dir); // Backdate issue creation by one second; same-millisecond creation does not occur in the real-host scenario.
    putIssue(
      'tok_newer_mint',
      todaysIssue({ pulse: [item({ eventId: 'q1', author: '后铸的作者', sigil: 'dddd0005' })] }),
      dir,
      'agent:workshop:本轮',
    );
    // A later saved batch on the older issue makes putEdit rewrite its file, giving it a newer mtime than the later issue.
    putEdit('tok_older_mint', { basis: 'tok_older_mint', masthead: '云舟江湖报', teaser: '导读', items: { '1': { h: '旧标题', s: '旧正文。' } } }, dir);
    // Pin sorting at the ledger layer; publish no longer uses that order, binding only by token/basis.
    const { latestPickedIssue } = await import('../../../src/newspaper/issue-store.js');
    expect(latestPickedIssue(dir, todayDateLabel(), 'agent:workshop:本轮')?.token).toBe('tok_newer_mint');
  });
});

// ---------------------------------------------------------------------------
// Session families and missing keys: r6 allowed unrestricted no-key callers (MCP hosts) and child
// inheritance of parent sessions. Those bounded guessing. After r9, publish never guesses: any identity
// shape without token or basis gets the same refusal. Since r25, session stamps are diagnostic, never binding gates.
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
// Invariant A: publishing with a real token freezes numbering. Regardless of subsequent ledger changes
// (deletions, new candidate sets or sweeps), its edit always aligns with the snapshot originally issued.
// Item 1's summary must appear under item 1's author/original post.
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
    // Change the ledger world: another ledger arrives and leaves, a new candidate set appears, and same-day sweeping runs.
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
    expect(r.text).not.toContain('basis named'); // The token is valid; no rebinding is needed.
  });
});

// ---------------------------------------------------------------------------
// Embedded edit.basis selects the batch (r7 decision, 2026-09-06; finalized r9). In one session create A
// (item 1 = Voyager), then B (item 1 = Kremlin), both within TTL. A's late item-1 summary
// selects A by basis; newer B cannot steal it. Without basis, always refuse (above).
// Equivalent regressions for the two Codex probes (--expired-a / --conflict) are pinned here too.
// ---------------------------------------------------------------------------
describe('edit.basis —— 批次选择器,同会话多期并存不再靠「最新」猜', () => {
  /**
   * Codex probe shape: A item 1 = Voyager, B item 1 = Kremlin; create both sequentially in one
   * session.
   */
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
    expect(r.landed).toBeUndefined(); // No publication: this is the P1 reproduction point that previously returned landed=true.
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
    expect(sent[0]).not.toContain('KremlinWatcher'); // No B material may enter the layout.
  });

  it('basis 查无此期 → 响亮拒绝,不退回「绑最新」(退回就是串位引擎)', async () => {
    putAB();
    const upload = async () => ({ url: 'https://canvas/v/13?t=k' });
    const r = await publishNewspaper(deps(upload), {
      edit: edit({ basis: 'tok_gone9999', items: { '1': { h: 'x', s: 'y.' } } }),
    });
    expect(r.landed).toBeUndefined();
    expect(getIssue('tok_b', dir)).toBeDefined(); // This failure must not settle anyone's ledger.
  });

  it('--expired-a:过期 A 被扫走只剩 B,A 的无 basis 迟交稿 → 拒发,B 的账分毫不动', async () => {
    putAB();
    _backdateIssueForTest('tok_a', Date.now() - 3 * 60 * 60 * 1000, dir); // A exceeds the two-hour TTL and is expired in memory and on disk.
    let uploads = 0;
    const upload = async () => {
      uploads += 1;
      return { url: 'https://canvas/v/17?t=k' };
    };
    const r = await publishNewspaper(deps(upload), {
      edit: edit({ items: { '1': { q: '旅行者一号还在飞。', h: '旅行者一号', s: 'A 期的 Voyager 摘要。' } } }),
    });
    expect(r.landed).toBeUndefined(); // r7's single-issue fallback bound A's edit to B here; that behavior must disappear.
    expect(uploads).toBe(0);
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(getIssue('tok_a', dir)).toBeUndefined(); // A is genuinely expired.
    expect(getIssue('tok_b', dir)).toBeDefined(); // The failure must not consume B's ledger.
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
    expect(r.landed).toBeUndefined(); // Previously the token silently won, putting A's copy in B's issue. Conflicting fields must be loudly refused.
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
    putAB(); // Two issues created by parent session 'agent:workshop:本轮'.
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
    putIssue('tok_mcp_a', todaysIssue(), dir); // No stamp: two issues on the session-key-free path.
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
// Four valid paths that no-guess tightening must preserve: real token alone, basis alone,
// matching token+basis, and same-issue batch continuation. Failure in any means the tightening went too far.
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
    expect(r.text).not.toContain('basis named'); // Agreement is not rebinding; no binding note should appear.
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
    expect(first.landed).toBeUndefined(); // This unfinished batch is not a landed paper.
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
// Fixture self-check: the session stamp is persisted with the ledger. Since r25 it is diagnostic (who received which page),
// and no binding is gated on it.
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
