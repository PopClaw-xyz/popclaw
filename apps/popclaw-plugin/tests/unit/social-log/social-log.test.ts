/**
 * Social log (dreaming mechanism step 1): writer and reader. ADR-0023 Revision 2026-07-26.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SocialLogWriter,
  appendSocialLog,
  readSocialLog,
  safeRecord,
  socialLogMonth,
  type SocialLogRecord,
} from '../../../src/social-log/social-log.js';
import { setOwnerTz } from '../../../src/time/time-context.js';

/**
 * Owner-local (year, month, day, hour) to epoch milliseconds. Month partitioning must follow the
 * local time zone.
 */
function localMs(y: number, m: number, d: number, h = 12): number {
  return new Date(y, m - 1, d, h, 0, 0, 0).getTime();
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-social-log-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appendSocialLog', () => {
  it('按主人本地时区切月份文件，目录不存在时自建', () => {
    const nested = join(dir, 'vault', 'social', 'log');
    appendSocialLog(nested, { kind: 'post_sent', text: 'hello' }, localMs(2026, 7, 26));
    expect(readdirSync(nested)).toEqual(['2026-07.jsonl']);
  });

  it('每条自带 v / ts / tz，且只 append 不覆盖', () => {
    appendSocialLog(dir, { kind: 'post_sent', text: '一' }, localMs(2026, 7, 26, 9));
    appendSocialLog(dir, { kind: 'post_sent', text: '二' }, localMs(2026, 7, 26, 10));
    const lines = readFileSync(join(dir, '2026-07.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as SocialLogRecord;
    expect(first.v).toBe(1);
    expect(first.ts).toBe(Math.floor(localMs(2026, 7, 26, 9) / 1000));
    // tz and socialLogMonth both read the owner's local time zone.
    expect(first.tz).toMatch(/^[+-]\d{2}(:\d{2})?$/);
    expect(first.kind).toBe('post_sent');
    expect(JSON.parse(lines[1]!).text).toBe('二');
  });

  it('主人配了时区就以它为准，不再跟着进程时区走（ADR-0045）', () => {
    // At 2026-08-01T02:00Z, New York is still 7/31 22:00 and Shanghai is already 8/1 10:00.
    const ms = Date.UTC(2026, 7, 1, 2, 0);
    setOwnerTz('America/New_York');
    appendSocialLog(dir, { kind: 'post_sent' }, ms);
    expect(readdirSync(dir)).toEqual(['2026-07.jsonl']);
    expect(JSON.parse(readFileSync(join(dir, '2026-07.jsonl'), 'utf-8').trim()).tz).toBe('-04');

    setOwnerTz('Asia/Shanghai');
    appendSocialLog(dir, { kind: 'post_sent' }, ms);
    expect(readdirSync(dir).sort()).toEqual(['2026-07.jsonl', '2026-08.jsonl']);
    expect(JSON.parse(readFileSync(join(dir, '2026-08.jsonl'), 'utf-8').trim()).tz).toBe('+08');
    setOwnerTz(undefined);
  });

  it('本地时区月末最后一刻仍落在本月文件（不按 UTC 切）', () => {
    // localMs uses the process time zone: local 12/31 23:30 must stay in the December file.
    // Whether that instant falls in a different UTC year depends on the process time zone.
    appendSocialLog(dir, { kind: 'post_sent' }, localMs(2026, 12, 31, 23) + 30 * 60_000);
    expect(readdirSync(dir)).toEqual(['2026-12.jsonl']);
    expect(socialLogMonth(new Date(localMs(2026, 12, 31, 23)))).toBe('2026-12');
  });
});

describe('readSocialLog', () => {
  it('跨月窗口自动连读相邻月文件，按 ts 升序返回', () => {
    appendSocialLog(dir, { kind: 'post_sent', text: '六月' }, localMs(2026, 6, 20));
    appendSocialLog(dir, { kind: 'post_sent', text: '七月' }, localMs(2026, 7, 5));
    appendSocialLog(dir, { kind: 'post_sent', text: '八月' }, localMs(2026, 8, 3));
    expect(readdirSync(dir).sort()).toEqual(['2026-06.jsonl', '2026-07.jsonl', '2026-08.jsonl']);

    const got = readSocialLog(
      dir,
      Math.floor(localMs(2026, 6, 1) / 1000),
      Math.floor(localMs(2026, 8, 31) / 1000),
    );
    expect(got.map((r) => r.text)).toEqual(['六月', '七月', '八月']);
  });

  it('窗口外的条目被过滤掉（含被顺带读进来的相邻月）', () => {
    appendSocialLog(dir, { kind: 'post_sent', text: '早' }, localMs(2026, 7, 1));
    appendSocialLog(dir, { kind: 'post_sent', text: '中' }, localMs(2026, 7, 15));
    appendSocialLog(dir, { kind: 'post_sent', text: '晚' }, localMs(2026, 7, 30));
    const got = readSocialLog(
      dir,
      Math.floor(localMs(2026, 7, 10) / 1000),
      Math.floor(localMs(2026, 7, 20) / 1000),
    );
    expect(got.map((r) => r.text)).toEqual(['中']);
  });

  it('乱序写入也按 ts 升序返回', () => {
    appendSocialLog(dir, { kind: 'post_sent', text: '后' }, localMs(2026, 7, 20));
    appendSocialLog(dir, { kind: 'post_sent', text: '前' }, localMs(2026, 7, 2));
    const got = readSocialLog(dir, 0, Math.floor(localMs(2026, 12, 1) / 1000));
    expect(got.map((r) => r.text)).toEqual(['前', '后']);
  });

  it('跳过坏行：半行 JSON / 非 JSON / 缺 ts / 缺 kind 都不毁掉整个窗口', () => {
    appendSocialLog(dir, { kind: 'post_sent', text: '好行一' }, localMs(2026, 7, 2));
    const file = join(dir, '2026-07.jsonl');
    writeFileSync(
      file,
      readFileSync(file, 'utf-8') +
        '{"v":1,"ts":178499,"kind":"post_se\n' + // Partial line from a torn append.
        'not json at all\n' +
        '{"v":1,"kind":"post_sent"}\n' + // Missing ts.
        `{"v":1,"ts":${Math.floor(localMs(2026, 7, 3) / 1000)}}\n` + // Missing kind.
        '\n', // Empty line.
      'utf-8',
    );
    appendSocialLog(dir, { kind: 'post_sent', text: '好行二' }, localMs(2026, 7, 4));

    const got = readSocialLog(dir, 0, Math.floor(localMs(2026, 12, 1) / 1000));
    expect(got.map((r) => r.text)).toEqual(['好行一', '好行二']);
  });

  it('目录不存在 / 月份文件缺失 → 空数组，不抛', () => {
    expect(readSocialLog(join(dir, 'nope'), 0, 2 ** 31)).toEqual([]);
    expect(readSocialLog(dir, 0, 2 ** 31)).toEqual([]);
  });
});

describe('SocialLogWriter — _then 上下文', () => {
  it('注入交情本时 tier_then 填实际档；查不到按 stranger', () => {
    const w = new SocialLogWriter({
      dir,
      bondTierOf: (id) => (id === 'KNOWN' ? 'confidant' : null),
      now: () => localMs(2026, 7, 26),
    });
    w.record({ kind: 'reply_received', actor: { id: 'KNOWN' } });
    w.record({ kind: 'reply_received', actor: { id: 'NOBODY' } });
    const got = readSocialLog(dir, 0, 2 ** 31);
    expect(got[0]!.actor?.tier_then).toBe('confidant');
    expect(got[1]!.actor?.tier_then).toBe('stranger');
  });

  it('没有交情本来源时省略 tier_then，绝不填默认值（空缺是诚实的）', () => {
    const w = new SocialLogWriter({ dir, now: () => localMs(2026, 7, 26) });
    w.record({ kind: 'reply_received', actor: { id: 'X', name: '谁' } });
    const rec = readSocialLog(dir, 0, 2 ** 31)[0]!;
    expect(rec.actor).toEqual({ id: 'X', name: '谁' });
    expect('tier_then' in rec.actor!).toBe(false);
  });

  it('没有 actor.id 时不查交情本、也不塞 tier_then', () => {
    const w = new SocialLogWriter({
      dir,
      bondTierOf: () => 'acquaintance',
      now: () => localMs(2026, 7, 26),
    });
    w.record({ kind: 'post_sent', text: '独白' });
    const rec = readSocialLog(dir, 0, 2 ** 31)[0]!;
    expect(rec.actor).toBeUndefined();
  });

  it('verified_then 为空数组时省略该字段', () => {
    const w = new SocialLogWriter({ dir, now: () => localMs(2026, 7, 26) });
    w.record({ kind: 'reply_received', actor: { id: 'X', verified_then: [] } });
    const rec = readSocialLog(dir, 0, 2 ** 31)[0]!;
    expect('verified_then' in rec.actor!).toBe(false);
  });

  it('verified_then 有值时原样落盘', () => {
    const w = new SocialLogWriter({ dir, now: () => localMs(2026, 7, 26) });
    w.record({
      kind: 'reply_received',
      actor: { id: 'X', verified_then: [{ platform: 'x', followers: 12000 }] },
    });
    const rec = readSocialLog(dir, 0, 2 ** 31)[0]!;
    expect(rec.actor?.verified_then).toEqual([{ platform: 'x', followers: 12000 }]);
  });

  it('自足：双向原文都带（spec §4 硬要求 1）', () => {
    const w = new SocialLogWriter({ dir, now: () => localMs(2026, 7, 26) });
    w.record({
      kind: 'reply_received',
      actor: { id: 'X', name: '苍梧阁大学士', sigil: '3m8v5x1p' },
      text: '回复的完整原文',
      in_reply_to: { event_id: 'abc', text: '我被回的那条的完整原文', url: 'https://popclaw.me/x' },
    });
    const rec = readSocialLog(dir, 0, 2 ** 31)[0]!;
    expect(rec.text).toBe('回复的完整原文');
    expect(rec.in_reply_to).toEqual({
      event_id: 'abc',
      text: '我被回的那条的完整原文',
      url: 'https://popclaw.me/x',
    });
  });
});

describe('韧性 — 日志故障绝不影响主流程', () => {
  it('写入失败只 warn，不抛', () => {
    // A regular file occupies the directory path, so mkdir/append must fail.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'i am a file, not a dir', 'utf-8');
    const warns: string[] = [];
    const w = new SocialLogWriter({ dir: join(blocked, 'log'), warn: (m) => warns.push(m) });
    expect(() => w.record({ kind: 'post_sent', text: 'x' })).not.toThrow();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('social-log');
  });

  it('safeRecord 吞掉任何 recorder 的抛错，undefined recorder 也安全', () => {
    const exploding = {
      record() {
        throw new Error('boom');
      },
    };
    expect(() => safeRecord(exploding, { kind: 'post_sent' })).not.toThrow();
    expect(() => safeRecord(undefined, { kind: 'post_sent' })).not.toThrow();
  });

  // Known boundary (ADR-0023 revision): POSIX append is atomic only below 4KB; torn lines can come from
  // multiple writers. A torn line consumes the immediately following record because they join and are skipped together; loss ends there,
  // and later records remain readable. Do not add newline repair to compensate for violating the single-writer rule.
  it('撕裂行只连累紧随其后的一条，再后面的照常读得出', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07.jsonl'), '{"v":1,"ts":123,"kind":"post_se', 'utf-8');
    const w = new SocialLogWriter({ dir, now: () => localMs(2026, 7, 26) });
    w.record({ kind: 'post_sent', text: '被连累' });
    w.record({ kind: 'post_sent', text: '幸存' });
    const got = readSocialLog(dir, 0, 2 ** 31);
    expect(got.map((r) => r.text)).toEqual(['幸存']);
  });
});
