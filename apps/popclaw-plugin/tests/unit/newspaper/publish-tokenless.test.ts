/**
 * Channel failure confirmed on 2026-08-30: the owner's main host path (ollama.com cloud glm-5.2:cloud)
 * replaces every `*_token` argument with `***` in transit, all 62/62 historical calls, even when a
 * real token appears in model text. Publish therefore cannot require a token. The r9 no-guess
 * contract, 2026-09-06, uses edit.basis, printed on the material page and copied verbatim, as
 * provenance when the token is missing or a placeholder. A basis selects exactly that issue; without
 * it, refuse with noProvenance, never bind latest. Keep all notChosen, wrongNumbering and complete-
 * coverage gates. A real-looking token absent from the ledger is still loudly refused, never silently
 * substituted.
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

/**
 * A verbatim passage from the fixture item's body: each edit's `q`, checked by copy-anchor.ts.
 */
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
    expect(getIssue('tok_live', dir)).toBeUndefined(); // Settle the ledger normally after publication.
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
    expect(getIssue('tok_live', dir)).toBeDefined(); // The ledger was not consumed; add a basis and submit again.
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
    expect(getIssue('tok_live', dir)).toBeDefined(); // The failure must not settle someone else's ledger.
  });

  // r7, 2026-09-06: with two issues present, binding latest displaced A's copy into B's layout
  // (reproduced by the same-session Codex A/B probe). Since r9: loudly refuse without basis; with basis, select exactly
  // the named issue. A newer issue cannot steal it. basis is an ordinary edit field unaffected by rules targeting *_token;
  // this is a protocol shape plus instruction, not a physical guarantee that every host preserves it.
  it('两份成刊并存、edit 没带 basis → 无从知道编号属于哪页,响亮拒发,谁也不绑', async () => {
    putIssue('tok_old', todaysIssue({ pulse: [item({ eventId: 'old1', author: 'oldface', sigil: 'aaaa0000' })] }), dir);
    putIssue('tok_new', todaysIssue({ pulse: [item({ eventId: 'new1', author: 'newface', sigil: 'bbbb1111' })] }), dir);
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { edit: edit() });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(getIssue('tok_old', dir)).toBeDefined(); // Both ledgers remain unchanged.
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
    expect(sent[0]).toContain('oldface'); // Layout authors come from the issue selected by basis.
    expect(sent[0]).not.toContain('newface'); // The later issue contributes no text to the layout.
    expect(getIssue('tok_new', dir)).toBeDefined(); // The unselected ledger is unchanged.
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
// Same-day gate (owner ruling, night of 2026-09-03): last night's unfinished issue must not hijack today's edit.
// On host A, last night's issue exceeded the two-hour TTL after the machine shut down overnight
// or crossed a day boundary, yet was selected as latest. Since r9 publish no longer scans ledgers;
// sweepStaleIssues owns stale-issue removal (see issue-store tests). Here we pin the rule that regardless of surviving issues,
// a provenance-free edit is refused and consumes no ledger.
// ---------------------------------------------------------------------------
describe('同日守门 —— 昨天的残刊不劫持今天的交稿', () => {
  it('昨夜没写完的残刊在场 → 无凭证交稿照样拒绝,残刊文件原样留着(清扫归 sweep)', async () => {
    putIssue('tok_yday', issue({ dateLabel: '2026年9月2日' }), dir); // A fixed past date is not today.
    putEdit('tok_yday', { masthead: '昨天的旧报' }, dir); // The unfinished saved edit is still attached to it.
    _resetIssuesForTest(); // Switch to a fresh-process perspective: only the disk ledger remains.
    const upload = vi.fn();
    const r = await publishNewspaper(deps(upload as never), { edit: edit() });
    expect(upload).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
    expect(existsSync(join(dir, 'tok_yday.json'))).toBe(true); // Refusal does not delete ledgers; sweeping removes stale ones.
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
    expect(getIssue('tok_child', dir)).toBeDefined(); // Refusal does not consume the ledger.
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
