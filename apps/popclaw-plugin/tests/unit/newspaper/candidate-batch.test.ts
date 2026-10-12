/**
 * Exact candidate batch: picks provenance gate (2026-09-06 r25, owner authorization item 1:
 * preserve original text, author, and link correspondence for the selected item and batch).
 *
 * r9 added noProvenance / tokenBasisConflict at publication. Selection still bound missing
 * or stripped candidate_token to the session's latest candidate page, another scope-based guess.
 * With pages A and B in one session, picks numbered for A could resolve against B and select
 * someone else's items. Mirror publication's no-guessing contract at selection:
 *   · A real candidate_token and basis that disagree → reject with tokenBasisConflict.
 *   · Neither reliable → reject with noProvenance; remove latestCandidate fallback.
 *     Latest-in-session is no longer an answer for missing tokens.
 *   · basis alone → select that exact candidate page. Both header and footer print basis="ctok_…",
 *     analogous to issue basis: the candidate token itself under a non-token field name,
 *     outside channels' *_token stripping rules.
 *   · Real candidate_token alone or both agreeing → normal behavior (all four paths, including repeated picks from one page).
 *   · Rejection consumes no ledger entry, even for expired candidates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import {
  putIssue,
  getIssue,
  _resetIssuesForTest,
  _backdateIssueForTest,
} from '../../../src/newspaper/issue-store.js';
import { todayDateLabel } from '../../../src/newspaper/issue.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { EN } from '../../../src/lexicon/en.js';
import { ZH_CN } from '../../../src/lexicon/zh-CN.js';
import { issue, item } from './_issue-fixture.js';

let dir: string;

const todaysIssue = (over: Parameters<typeof issue>[0] = {}): ReturnType<typeof issue> =>
  issue({ dateLabel: todayDateLabel(), ...over });

/** The candidate-page shape: two items so a one-number pick leaves one behind. */
const candidateIssue = (): ReturnType<typeof issue> =>
  todaysIssue({
    pulse: [
      item({ eventId: 'cb1', author: '候选作者甲', sigil: 'aaaa0001' }),
      item({ eventId: 'cb2', author: '候选作者乙', sigil: 'bbbb0002' }),
    ],
  });

/** The picks-carrying call needs only paths from the runtime — picks never re-gather. */
function makePaper(): {
  execute: (params: Record<string, unknown>) => Promise<{ type: string; text: string }>;
} {
  const tools: Array<{ name: string; execute: (c: string, p: unknown) => Promise<{ type: string; text: string }> }> = [];
  const api = {
    registerTool: (tool: unknown): void => {
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({ agentId: 'a' }) : tool;
      const t = resolved as { name?: string; execute?: unknown };
      if (t?.name && typeof t.execute === 'function') {
        tools.push(t as typeof tools[number]);
      }
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  registerPopclawTools({
    api,
    runtime: (async () => ({
      boot: { loreHouseUrls: [] },
      paths: {
        newspaperDir: () => join(dir, 'newspaper'),
        newspaperManifestsDir: () => dir,
        tasteDir: () => join(dir, 'taste'),
        houseGuideFile: (s: string) => join(dir, 'lorehouses', `${s}.guide.md`),
      },
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
  });
  const paper = tools.find((t) => t.name === 'popclaw_newspaper');
  if (!paper) throw new Error('popclaw_newspaper not registered');
  return { execute: (params) => paper.execute('c1', params) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-candidate-batch-'));
  _resetIssuesForTest();
});
afterEach(() => {
  _resetIssuesForTest(dir);
});

describe('picks 归属闸 —— 候选层的无猜测(①冲突 ②无凭证 ③过期不销账)', () => {
  it('① candidate_token 真 + picks 带 basis,两者不一致 → 拒,两份候选页都分毫不动', async () => {
    putIssue('ctok_aaaa1111', candidateIssue(), dir);
    putIssue('ctok_bbbb2222', candidateIssue(), dir);
    const r = await makePaper().execute({
      candidate_token: 'ctok_bbbb2222',
      basis: 'ctok_aaaa1111',
      picks_flat: [1],
    });
    expect(r.text).toBe(
      renderCopy('en', 'newspaper.picks.tokenBasisConflict', { basis: 'ctok_aaaa1111', token: 'ctok_bbbb2222' }),
    );
    expect(getIssue('ctok_aaaa1111', dir)).toBeDefined();
    expect(getIssue('ctok_bbbb2222', dir)).toBeDefined();
  });

  it('②a 令牌与 basis 都没带 → 拒(noProvenance),不绑「会话内最新」', async () => {
    putIssue('ctok_solo0001', candidateIssue(), dir);
    const r = await makePaper().execute({ picks_flat: [1] });
    expect(r.text).toBe(renderCopy('en', 'newspaper.picks.noProvenance'));
    expect(getIssue('ctok_solo0001', dir)).toBeDefined(); // Neither ledger changed.
  });

  it('②b 令牌被洗成 ***(占位形状)、basis 也没带 → 同样拒,绝不回退绑最新', async () => {
    putIssue('ctok_solo0001', candidateIssue(), dir);
    const r = await makePaper().execute({ candidate_token: '***', picks_flat: [1] });
    expect(r.text).toBe(renderCopy('en', 'newspaper.picks.noProvenance'));
    expect(getIssue('ctok_solo0001', dir)).toBeDefined();
  });

  it('③a 真 token 指向的候选页已过期 → 拒,候选账不销(文件还在)', async () => {
    putIssue('ctok_aged0001', candidateIssue(), dir);
    _backdateIssueForTest('ctok_aged0001', Date.now() - 3 * 60 * 60 * 1000, dir); // Exceed the 2h TTL.
    const r = await makePaper().execute({ candidate_token: 'ctok_aged0001', picks_flat: [1] });
    expect(r.text).toContain('candidate set not found or expired');
    expect(existsSync(join(dir, 'ctok_aged0001.json'))).toBe(true); // Rejection does not consume receipts.
  });

  it('③b basis 指向的候选页已过期 → basisExpired 拒,同样不销账', async () => {
    putIssue('ctok_aged0002', candidateIssue(), dir);
    _backdateIssueForTest('ctok_aged0002', Date.now() - 3 * 60 * 60 * 1000, dir);
    const r = await makePaper().execute({ basis: 'ctok_aged0002', picks_flat: [1] });
    expect(r.text).toBe(renderCopy('en', 'newspaper.picks.basisExpired', { basis: 'ctok_aged0002' }));
    expect(existsSync(join(dir, 'ctok_aged0002.json'))).toBe(true);
  });

  it('basis 指到一份成刊(publish token,无 c 前缀)→ 拒:那不是候选页', async () => {
    putIssue('tok_live00001', candidateIssue(), dir); // Issue-token shape.
    const r = await makePaper().execute({ basis: 'tok_live00001', picks_flat: [1] });
    expect(r.text).toBe(renderCopy('en', 'newspaper.picks.basisNotCandidate', { basis: 'tok_live00001' }));
  });
});

describe('picks 保通四腿 —— 收紧不许误伤', () => {
  it('腿① 真 candidate_token 单独 → 照常出素材页(带成刊 basis)', async () => {
    putIssue('ctok_leg00001', candidateIssue(), dir);
    const r = await makePaper().execute({ candidate_token: 'ctok_leg00001', picks_flat: [1] });
    expect(r.text).toMatch(/"basis": "tok_[a-z0-9]+"/); // The material page prints the issue basis (r7).
    expect(r.text).toContain('候选作者甲');
  });

  it('腿② basis 单独 → 按 basis 选定候选页出素材,回执注明按 basis 解析', async () => {
    putIssue('ctok_leg00002', candidateIssue(), dir);
    const r = await makePaper().execute({ basis: 'ctok_leg00002', picks_flat: [1] });
    expect(r.text).toMatch(/"basis": "tok_[a-z0-9]+"/);
    expect(r.text).toContain('ctok_leg00002'); // The receipt explicitly identifies the page used for resolution.
  });

  it('腿③ 令牌与 basis 一致 → 照常,不加解析注', async () => {
    putIssue('ctok_leg00003', candidateIssue(), dir);
    const r = await makePaper().execute({
      candidate_token: 'ctok_leg00003',
      basis: 'ctok_leg00003',
      picks_flat: [1],
    });
    expect(r.text).toMatch(/"basis": "tok_[a-z0-9]+"/);
  });

  it('腿④ 同一份候选页多轮 picks → 每轮各自成刊,候选页不被消耗', async () => {
    putIssue('ctok_leg00004', candidateIssue(), dir);
    const paper = makePaper();
    const first = await paper.execute({ basis: 'ctok_leg00004', picks_flat: [1] });
    const second = await paper.execute({ basis: 'ctok_leg00004', picks_flat: [2] });
    const t1 = first.text.match(/"basis": "(tok_[a-z0-9]+)"/)![1];
    const t2 = second.text.match(/"basis": "(tok_[a-z0-9]+)"/)![1];
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    expect(t1).not.toBe(t2); // Each round creates its own issue.
    expect(getIssue('ctok_leg00004', dir)).toBeDefined(); // The candidate page remains.
  });
});

/**
 * C (2026-09-12): the picks call's argument is `candidate_basis`.
 *
 * `basis` used to name two different pages — the candidate page on the picks
 * call and the material page inside `edit` — and on real hardware a strong
 * model carried the candidate id into `edit.basis` and lost two whole rounds to
 * refusals that never named the value to keep. One word, one page: the picks
 * call says `candidate_basis`, `edit.basis` stays the material page's own id.
 * The old name is still accepted here, silently, so pages minted before this
 * release still resolve inside their two-hour TTL.
 */
describe('candidate_basis —— the picks-side name of the candidate page', () => {
  it('candidate_basis alone selects that candidate page', async () => {
    putIssue('ctok_named0001', candidateIssue(), dir);
    const r = await makePaper().execute({ candidate_basis: 'ctok_named0001', picks_flat: [1] });
    expect(r.text).toMatch(/"basis": "tok_[a-z0-9]+"/);
    expect(r.text).toContain('ctok_named0001');
  });

  it('the old `basis` argument still selects it (compatibility leg)', async () => {
    putIssue('ctok_named0002', candidateIssue(), dir);
    const r = await makePaper().execute({ basis: 'ctok_named0002', picks_flat: [1] });
    expect(r.text).toMatch(/"basis": "tok_[a-z0-9]+"/);
  });

  it('candidate_basis contradicting a real candidate_token is refused, no ledger touched', async () => {
    putIssue('ctok_named0003', candidateIssue(), dir);
    putIssue('ctok_named0004', candidateIssue(), dir);
    const r = await makePaper().execute({
      candidate_token: 'ctok_named0004',
      candidate_basis: 'ctok_named0003',
      picks_flat: [1],
    });
    expect(r.text).toBe(
      renderCopy('en', 'newspaper.picks.tokenBasisConflict', {
        basis: 'ctok_named0003',
        token: 'ctok_named0004',
      }),
    );
    expect(getIssue('ctok_named0003', dir)).toBeDefined();
    expect(getIssue('ctok_named0004', dir)).toBeDefined();
  });

  it('neither lane advertises the candidate id under the bare word `basis`', () => {
    const keys = [
      'newspaper.candidates.head',
      'newspaper.candidates.handIn',
      'newspaper.picks.noProvenance',
      'newspaper.picks.tokenBasisConflict',
      'newspaper.picks.basisExpired',
      'newspaper.picks.basisNotCandidate',
    ];
    for (const table of [EN.copy, ZH_CN.copy] as Array<Record<string, string>>) {
      for (const key of keys) {
        const text = table[key] ?? '';
        expect(text, key).toBeTruthy();
        // `{basis}` stays the render parameter's name, and `edit.basis` may be named
        // explicitly to contrast the two. Every other word of prose must say
        // `candidate_basis`, so that nothing on the candidate page can be copied into
        // `edit.basis` by a writer following the page literally.
        const prose = text
          .replace(/candidate_basis/g, '')
          .replace(/edit\.basis/g, '')
          .replace(/\{basis\}/g, '');
        expect(prose, key).not.toContain('basis');
      }
    }
  });
});
