/**
 * 门铃 §5(Task 7):一期报纸落地时,把当期「可关注的作者集」落进社交库。
 *
 * followableAuthorsOf 是纯的一半 —— 过滤 / 去重 / descriptor / 48 小时有效期,
 * 全部从已存的 issue + 版面印出来的标题决定;publish 一半只在纸真落桌了才写
 * (P7 同款闸门:画布挂了走本地降级,那不算发布,不许写)。
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  followableAuthorsOf,
  type FollowableAuthorRow,
} from '../../../src/newspaper/followable-authors.js';
import { publishNewspaper, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
import { putIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { dropScratch, makeScratch, type Scratch } from './_scratch.js';
import { issue, item } from './_issue-fixture.js';
import { todayDateLabel } from '../../../src/newspaper/issue.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const NOW = 1_700_000_000_000;
const H48 = 48 * 60 * 60 * 1000;

describe('followableAuthorsOf —— 当期可关注作者集(纯函数)', () => {
  it('只收既有 popclaw_id 又有名字的条目', () => {
    const i = issue({
      pulse: [
        item(), // levelsio / pid-levelsio —— 收
        item({ eventId: 'e2', authorPopclawId: '' }), // 没有 id —— 不收
        item({ eventId: 'e3', author: '' }), // 没有名字 —— 不收
      ],
    });
    const rows = followableAuthorsOf(i, new Map(), NOW);
    expect(rows.map((r) => r.popclaw_id)).toEqual(['pid-levelsio']);
  });

  it('同人去重,以第一次出现的条目为准', () => {
    const twice = item({ eventId: 'e2' }); // 同 pid-levelsio
    const i = issue({ pulse: [item(), twice, item({ eventId: 'e3', author: 'linabot', sigil: 'bbbb1111', authorPopclawId: 'pid-lina' })] });
    const rows = followableAuthorsOf(
      i,
      new Map([
        [1, '第一条的标题'],
        [2, '第二条的标题'],
      ]),
      NOW,
    );
    expect(rows.map((r) => r.popclaw_id)).toEqual(['pid-levelsio', 'pid-lina']);
    expect(rows[0]!.descriptor).toBe('第一条的标题'); // 第一次出现的,不是后一条
  });

  it('descriptor 取该条标题截 12 字符;该期没这条标题 → null', () => {
    const i = issue({ pulse: [item(), item({ eventId: 'e2', author: 'linabot', sigil: 'bbbb1111', authorPopclawId: 'pid-lina' })] });
    const rows = followableAuthorsOf(
      i,
      new Map([[1, '零一二三四五六七八九十一二三四个字']]),
      NOW,
    );
    expect(rows[0]!.descriptor).toBe('零一二三四五六七八九十一'); // 恰 12 字,不多的一个也不带
    expect(rows[1]!.descriptor).toBeNull(); // heads 里没有 2 号 → null,不许编
  });

  it('expires_at = now + 48h;issue_date / display_name 如实带过', () => {
    const i = issue();
    const rows = followableAuthorsOf(i, new Map([[1, 'h']]), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      issue_date: '2026年8月25日',
      popclaw_id: 'pid-levelsio',
      display_name: 'levelsio#65v29fn1',
      descriptor: 'h',
      expires_at: NOW + H48,
    } satisfies FollowableAuthorRow);
  });

  it('display_name 合成印信:有 sigil 拼「名#印信」,空 sigil 就是裸名', () => {
    const i = issue({
      pulse: [
        item(), // 默认带 sigil '65v29fn1'
        item({ eventId: 'e2', sigil: '', author: 'anon', authorPopclawId: 'pid-anon' }),
      ],
    });
    const rows = followableAuthorsOf(i, new Map(), NOW);
    expect(rows.map((r) => r.display_name)).toEqual(['levelsio#65v29fn1', 'anon']);
  });
});

let dir: string;
let scratch: Scratch;

function deps(
  upload = vi.fn(async () => ({ url: 'https://canvas/x/1?t=tok' })),
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

/** 一份两作者、三条目的成刊(第二条没有 popclaw_id,不该进作者集)。 */
// 无猜测契约(2026-09-06 r9)后,无令牌交稿必须带 basis 才绑得到成刊——夹具盖上
// 今天的戳,edit 里带上该期的 basis。
const authorIssue = () =>
  issue({
    dateLabel: todayDateLabel(),
    pulse: [
      item(),
      item({ eventId: 'e2', authorPopclawId: '' }),
      item({ eventId: 'e3', author: 'linabot', sigil: 'bbbb1111', authorPopclawId: 'pid-lina' }),
    ],
  });

/** 夹具条目正文里原样抄下的一段 —— 每条稿子的 `q`(copy-anchor.ts 要核的锚)。 */
const Q = 'the booster landed on the pad';

const fullEdit = {
  basis: 'tok_live',
  masthead: '云舟江湖报',
  items: {
    '1': { q: Q, h: '猎鹰落回了发射台', s: '一次回收成功。' },
    '2': { q: Q, h: '无名的条目', s: '也写完了。' },
    '3': { q: Q, h: '第二件也写完了', s: '两件都写完了。' },
  },
  teaser: '今日导读',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-followable-'));
  scratch = makeScratch('followable');
  _resetIssuesForTest();
});
afterEach(() => dropScratch(scratch));

describe('publish 落库 —— 纸真落桌了才写', () => {
  it('上传成功后 recordFollowable 收到当期作者行(descriptor 是版面上印的标题)', async () => {
    putIssue('tok_live', authorIssue(), dir);
    const recorded: FollowableAuthorRow[][] = [];
    const r = await publishNewspaper(deps(undefined, { recordFollowable: (rows) => recorded.push(rows) }), {
      edit: fullEdit,
    });
    expect(r.text).toContain('https://canvas/x/1?t=tok');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.map((x) => x.popclaw_id)).toEqual(['pid-levelsio', 'pid-lina']);
    expect(recorded[0]![0]).toMatchObject({
      issue_date: authorIssue().dateLabel,
      display_name: 'levelsio#65v29fn1',
      descriptor: '猎鹰落回了发射台',
    });
    const before = Date.now();
    expect(recorded[0]![0]!.expires_at).toBeGreaterThanOrEqual(before + 47 * 3600 * 1000);
    expect(recorded[0]![0]!.expires_at).toBeLessThanOrEqual(before + 49 * 3600 * 1000);
  });

  // The local HTML became the master copy (2026-09-12): a failed upload is a
  // missing share link, not a missing paper. The owner can read the issue, so
  // its authors are answerable — the gate is "did the paper come out", and it did.
  it('upload failed → the paper still came out, so the author set is still written', async () => {
    putIssue('tok_live', authorIssue(), dir);
    const record = vi.fn();
    const upload = vi.fn(async () => {
      throw new Error('canvas down');
    });
    const r = await publishNewspaper(deps(upload as never, { recordFollowable: record }), { edit: fullEdit });
    expect(r.text).toContain(scratch.issuesDir);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('期还没写完(分批中)→ 还没落桌,不写', async () => {
    putIssue('tok_live', authorIssue(), dir);
    const record = vi.fn();
    const r = await publishNewspaper(
      deps(undefined, { recordFollowable: record }),
      { edit: { ...fullEdit, items: { '1': fullEdit.items['1']! } } },
    );
    expect(r.text).not.toContain('https://canvas/x/1?t=tok'); // 没上传,就没有链接
    expect(record).not.toHaveBeenCalled();
  });

  it('没注入 recordFollowable → 照常出报(缺省即功能关,不许挡发报)', async () => {
    putIssue('tok_live', authorIssue(), dir);
    const r = await publishNewspaper(deps(), { edit: fullEdit });
    expect(r.text).toContain('https://canvas/x/1?t=tok');
  });
});

describe('migration 023 —— 两张表随迁移通道落地', () => {
  it('followable_authors / pending_follows 建齐,装配点的 INSERT OR REPLACE 能跑', () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const tables = db
      .queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('followable_authors','pending_follows')")
      .map((t) => t.name);
    expect(tables.sort()).toEqual(['followable_authors', 'pending_follows']);

    // 装配点(read-tools)写这张表用的就是这条语句:同键重发一期是刷新,不是撞键。
    const insert =
      'INSERT OR REPLACE INTO followable_authors (issue_date, popclaw_id, display_name, descriptor, expires_at) VALUES (?, ?, ?, ?, ?)';
    db.execute(insert, ['2026年8月25日', 'pid-levelsio', 'levelsio', '猎鹰落回了发射台', NOW]);
    db.execute(insert, ['2026年8月25日', 'pid-levelsio', 'levelsio', null, NOW + 1000]);
    const rows = db.queryAll<{ popclaw_id: string; descriptor: string | null; expires_at: number }>(
      'SELECT popclaw_id, descriptor, expires_at FROM followable_authors',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ popclaw_id: 'pid-levelsio', descriptor: null, expires_at: NOW + 1000 });
    db.close();
  });
});
