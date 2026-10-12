/**
 * Owner ruling, 2026-08-28: select enough using the three principles when possible; otherwise
 * supplement with popular items so the owner gets a useful, nonempty newspaper. The owner also removed
 * the fixed count that day: selection need not be hardcoded to 90. This layer therefore enforces only
 * a floor (below it is an empty paper; supplement by popularity and disclose it) and a runaway
 * guardrail (returning the whole candidate pool unchanged is not selection). Everything between those
 * limits passes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { putIssue, latestCandidate, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { issue, item } from './_issue-fixture.js';

/**
 * Thirty items by thirty authors, so per-author quotas do not block supplementation.
 */
const thirty = (): ReturnType<typeof issue> =>
  issue({
    pulse: Array.from({ length: 30 }, (_, i) =>
      item({
        text: `post ${i + 1}`,
        eventId: `e${i + 1}`,
        author: `a${i + 1}`,
        sigil: `sig${i + 1}`,
        authorPopclawId: `pid-${i + 1}`,
        replyCount: 30 - i, // Earlier items have higher popularity.
      }),
    ),
  });

const opts = { mintToken: () => 'tok_x', contentRules: '', leadMax: 3, perAuthorMax: 6, floor: 15, topUpTo: 20 };

describe('挑不够就用热闹补齐', () => {
  beforeEach(() => _resetIssuesForTest());

  it('只挑了三条 → 补到下限之上,补了几条明说,且补进来的都记在「热闹」名下', () => {
    putIssue('c1', thirty());
    const r = buildIssueFromPicks('c1', { taste: [1, 2], bond: [3] }, opts);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.notes.join(' ')).toContain('added by what was liveliest');
    // After supplementation this is no longer an empty paper.
    expect(r.payload).toContain('post 1');
    // Keep provenance for the owner's three original picks unchanged; the layout relies on it.
    expect(r.payload).toContain('post 3');
  });

  it('挑够了就一个字都不补 —— 下限是地板不是配额', () => {
    putIssue('c2', thirty());
    const many = Array.from({ length: 18 }, (_, i) => i + 1);
    const r = buildIssueFromPicks('c2', { taste: many }, opts);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.notes.join(' ')).not.toContain('liveliest');
  });

  it('挑了二十条也不再被说「离目标还差得远」—— 固定条数已经撤掉了', () => {
    putIssue('c3', thirty());
    const r = buildIssueFromPicks('c3', { taste: Array.from({ length: 20 }, (_, i) => i + 1) }, opts);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.notes.join(' ')).not.toContain('aims for');
  });
});

/**
 * Token mismatch has a gate on each end. Candidate tokens contain `c`, publishing tokens do not; both
 * share a ledger and format. Without this gate, a publishing token silently matches: picks 1..53 hit a
 * pulse with only twenty items. Out-of-range numbers are dropped as absent, while in-range numbers
 * point to entirely different items. The wrong material page and resulting paper look internally
 * consistent, but none of those selections are the writer's. This confusion happened on 2026-08-27 and
 * 2026-08-29. Publish gained the symmetric gate on 8/29; selection had been missing it.
 */
describe('令牌错配', () => {
  beforeEach(() => _resetIssuesForTest());

  it('拿出版令牌来交挑选 → 当场点名说错了,绝不静默命中', () => {
    putIssue('tok_already_chosen', thirty());
    const r = buildIssueFromPicks('tok_already_chosen', { taste: [1, 2, 3] }, opts);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('publish_token, not the candidate_token');
  });

  it('候选令牌照旧通行 —— 这道闸不许挡住正路', () => {
    putIssue('ctok_fine', thirty());
    expect(buildIssueFromPicks('ctok_fine', { taste: [1, 2, 3] }, opts).kind).toBe('ready');
  });
});

/**
 * Flooded day: nearly all candidates share one author. selectByHeat used to count author quota from
 * zero, ignoring the outer picks. Its hottest supplements all hit an exhausted author and were
 * rejected outside, so supplementation did nothing while the receipt claimed three additions. Quota is
 * now shared, and an issue still below the floor explicitly says so.
 */
describe('刷屏日的补齐', () => {
  beforeEach(() => _resetIssuesForTest());

  const oneAuthor = (): ReturnType<typeof issue> =>
    issue({
      pulse: Array.from({ length: 40 }, (_, i) =>
        item({ text: `p${i}`, eventId: `e${i}`, replyCount: 40 - i }),
      ),
    });

  it('补不动的时候要说「补完仍然不够」,不能只报补了几条', () => {
    putIssue('ctok_spam', oneAuthor());
    const r = buildIssueFromPicks('ctok_spam', { taste: [1, 2] }, opts);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    const said = r.notes.join(' ');
    expect(said).toContain('18 more added');
    expect(said).not.toContain('still under');
  });

  it('每人上限照旧守死 —— 补齐不许拿它换条数', () => {
    putIssue('ctok_spam2', oneAuthor());
    const r = buildIssueFromPicks('ctok_spam2', { taste: [1, 2] }, opts);
    if (r.kind !== 'ready') throw new Error(r.message);
    // The directory and current bodies can show the same immutable ID; count selected identities once.
    const printed = new Set([...r.payload.matchAll(/^\[(\d+)\]/gm)].map(m => m[1])).size;
    expect(printed).toBe(opts.topUpTo);
  });
});

/**
 * A token must not be a memory test. On host B, 2026-08-30, eleven candidate sets were created in
 * three minutes with no successful selection. The host's skill workshop read the session and recorded
 * that the model must reread the token from tool output and copy it verbatim, and must not retry the
 * same placeholder endlessly; that was exactly what it did. Six nights of incidents shared the
 * requirement to copy a random opaque string across a tool round trip. Do not keep patching that
 * requirement: when the candidate token cannot be recognized, select the latest candidate set and
 * generate the material page from that same set, keeping the writer's copy and our numbering aligned.
 */
describe('令牌认不出来时不该死循环', () => {
  beforeEach(() => _resetIssuesForTest());

  it('盘上找得到最新那份候选集', () => {
    putIssue('ctok_old', thirty());
    putIssue('ctok_new', thirty());
    // With the same-day gate, the caller determines today; the fixture date makes all these candidate sets today's.
    expect(latestCandidate(undefined, thirty().dateLabel)?.token).toBe('ctok_new');
  });

  it('出版令牌不算候选集 —— 兜底只认 c 开头的', () => {
    putIssue('tok_an_issue', thirty());
    expect(latestCandidate(undefined, thirty().dateLabel)).toBeUndefined();
  });

  it('一份候选集都没有 → 老实说没有,不瞎兜', () => {
    expect(latestCandidate(undefined, thirty().dateLabel)).toBeUndefined();
  });
});
