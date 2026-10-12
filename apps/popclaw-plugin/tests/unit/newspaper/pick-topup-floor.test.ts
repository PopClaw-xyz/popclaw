/**
 * Top-up targets the floor, not the suggested range (2026-09-13).
 *
 * read-tools wired topUpTo to PICK_SUGGESTED_MIN (20) while floor was PICK_FLOOR (15). A writer
 * selecting 14 items, as the party responsible for editorial choice, would get six unselected
 * popularity-based additions. The plugin may enforce only the floor; the suggested range remains
 * advisory on the candidate page.
 *
 * This corrects editorial consistency and is unrelated to the blank-submission incident on
 * 2026-09-13. Wiring lives in read-tools, so exercise the real tool entry rather than calling
 * buildIssueFromPicks directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { putIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { todayDateLabel } from '../../../src/newspaper/issue.js';
import { PICK_FLOOR, PICK_SUGGESTED_MIN } from '../../../src/newspaper/gather-materials.js';
import { issue, item } from './_issue-fixture.js';

let dir: string;

/**
 * Thirty items from thirty people keep the per-person limit from blocking top-up first.
 */
const thirty = (): ReturnType<typeof issue> =>
  issue({
    dateLabel: todayDateLabel(),
    pulse: Array.from({ length: 30 }, (_, i) =>
      item({
        text: `post ${i + 1}`,
        eventId: `e${i + 1}`,
        author: `a${i + 1}`,
        sigil: `sig${i + 1}`,
        authorPopclawId: `pid-${i + 1}`,
        replyCount: 30 - i, // Earlier items are more popular.
      }),
    ),
  });

/**
 * The picks path does not refetch, so the runtime needs only paths.
 */
function makePaper(): (params: Record<string, unknown>) => Promise<{ text: string }> {
  const tools: Array<{ name: string; execute: (c: string, p: unknown) => Promise<{ type: string; text: string }> }> = [];
  const api = {
    registerTool: (tool: unknown): void => {
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({ agentId: 'a' }) : tool;
      const t = resolved as { name?: string; execute?: unknown };
      if (t?.name && typeof t.execute === 'function') tools.push(t as (typeof tools)[number]);
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
  return (params) => paper.execute('c1', params);
}

/** Unique selected identities: the directory and packet bodies share their original numbers. */
const printed = (text: string): number => new Set([...text.matchAll(/^\[(\d+)\] 作者: /gm)].map(m => m[1])).size;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-topup-floor-'));
  _resetIssuesForTest();
});
afterEach(() => _resetIssuesForTest(dir));

describe('补齐的落点', () => {
  it('地板和落点是同一个数 —— 建议区间不是配额', () => {
    expect(PICK_SUGGESTED_MIN).toBeGreaterThan(PICK_FLOOR); // This case is meaningful only while this precondition holds.
  });

  it('挑了 3 条 → 补到地板就停,不再冲着建议区间多补', async () => {
    putIssue('ctok_few00001', thirty(), dir);
    const r = await makePaper()({ candidate_token: 'ctok_few00001', picks_flat: [1, 2, 3] });
    expect(printed(r.text)).toBe(PICK_FLOOR);
    expect(printed(r.text)).toBeLessThan(PICK_SUGGESTED_MIN);
    expect(r.text).toContain('added by what was liveliest');
  });

  it('挑了 14 条(差一条到地板)→ 只补一条,而不是补出六条来', async () => {
    putIssue('ctok_fourteen', thirty(), dir);
    const r = await makePaper()({
      candidate_token: 'ctok_fourteen',
      picks_flat: Array.from({ length: PICK_FLOOR - 1 }, (_, i) => i + 1),
    });
    expect(printed(r.text)).toBe(PICK_FLOOR);
  });

  it('挑够了就一条都不补 —— 这一刀不许把地板变成配额', async () => {
    putIssue('ctok_enough001', thirty(), dir);
    const r = await makePaper()({
      candidate_token: 'ctok_enough001',
      picks_flat: Array.from({ length: PICK_FLOOR }, (_, i) => i + 1),
    });
    expect(printed(r.text)).toBe(PICK_FLOOR);
    expect(r.text).not.toContain('added by what was liveliest');
  });
});
