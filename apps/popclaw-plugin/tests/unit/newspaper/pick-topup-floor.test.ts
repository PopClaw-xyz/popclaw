/**
 * 补齐落在**地板上**,不落在建议区间上(2026-09-13)。
 *
 * `read-tools` 一直把 `topUpTo` 接成 `PICK_SUGGESTED_MIN`(20),而 `floor` 是
 * `PICK_FLOOR`(15):于是一个挑了 14 条的写作端 —— 那是唯一有资格判断「什么属于这份
 * 报纸」的一方给出的、审慎的答案 —— 会被按热闹补到 20 条,凭空多出六条没人替主人挑过
 * 的东西。插件有资格强制的只有地板;建议区间仍然是建议,照旧印在候选页上。
 *
 * 这一条是选题一致性的修正,与 2026-09-13 那次「交白卷」的故障无关。
 *
 * 接线只在 `read-tools` 里,所以这里走真正的工具入口,不直接调 `buildIssueFromPicks`。
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

/** 三十条、三十个人 —— 免得每人上限先一步把补齐挡掉。 */
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
        replyCount: 30 - i, // 越靠前越热闹
      }),
    ),
  });

/** picks 那一支不重新抓取,所以运行时只需要 paths。 */
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

/** 素材页上实际印出来的条目数。 */
const printed = (text: string): number => [...text.matchAll(/^\[\d+\] 作者: /gm)].length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-topup-floor-'));
  _resetIssuesForTest();
});
afterEach(() => _resetIssuesForTest(dir));

describe('补齐的落点', () => {
  it('地板和落点是同一个数 —— 建议区间不是配额', () => {
    expect(PICK_SUGGESTED_MIN).toBeGreaterThan(PICK_FLOOR); // 前提还在,这一条才有意义
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
