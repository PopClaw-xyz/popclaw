/**
 * 主人本地时间的唯一推导点（ADR-0045，落地 charter D3 欠下的 `timeContext(ts, tz)`）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  isValidTz,
  ownerTz,
  setOwnerTz,
  startOfLocalDay,
  systemTz,
  timeContext,
} from '../../../src/time/time-context.js';

afterEach(() => setOwnerTz(undefined));

describe('ownerTz — 三级回落', () => {
  it('① cadence.delivery.timezone 最优先', () => {
    setOwnerTz('America/New_York');
    expect(ownerTz({ delivery: { timezone: 'Asia/Tokyo' } })).toBe('Asia/Tokyo');
  });

  it('② 没有 cadence 就用组合根登记的时区', () => {
    setOwnerTz('America/New_York');
    expect(ownerTz()).toBe('America/New_York');
    expect(ownerTz({ delivery: {} })).toBe('America/New_York');
  });

  it('③ 都没有就用系统时区', () => {
    expect(ownerTz()).toBe(systemTz());
  });

  it('胡填的时区被跳过，落到下一级（绝不因为一行配置崩掉展示）', () => {
    expect(ownerTz({ delivery: { timezone: 'Mars/Olympus' } })).toBe(systemTz());
    setOwnerTz('Mars/Olympus');
    expect(ownerTz()).toBe(systemTz());
    expect(ownerTz({ delivery: { timezone: '  ' } })).toBe(systemTz());
  });
});

describe('timeContext', () => {
  // 2026-07-30T20:30:00Z
  const ts = Math.floor(Date.UTC(2026, 6, 30, 20, 30, 0) / 1000);

  it('UTC+8：跨到次日凌晨', () => {
    const c = timeContext(ts, 'Asia/Shanghai');
    expect(c).toMatchObject({ ymd: '2026-07-31', hm: '04:30', monthKey: '2026-07', bucket: 'small-hours' });
  });

  it('UTC-8：还是当天下午', () => {
    const c = timeContext(ts, 'America/Los_Angeles');
    expect(c).toMatchObject({ ymd: '2026-07-30', hm: '13:30', monthKey: '2026-07', bucket: 'noon' });
  });

  it('半小时偏移的时区也对（India）', () => {
    expect(timeContext(ts, 'Asia/Kolkata').hm).toBe('02:00');
  });

  it('社交日志里存的偏移串（+08 / -05:30）当时区用', () => {
    expect(timeContext(ts, '+08').ymd).toBe('2026-07-31');
    expect(timeContext(ts, '-05:30').hm).toBe('15:00');
  });

  it('时段桶按主人本地钟点分（D3 的六档）', () => {
    const at = (h: number) => timeContext(Math.floor(Date.UTC(2026, 6, 30, h) / 1000), 'UTC').bucket;
    expect([at(0), at(4)]).toEqual(['small-hours', 'small-hours']);
    expect([at(5), at(7)]).toEqual(['dawn', 'dawn']);
    expect([at(8), at(11)]).toEqual(['morning', 'morning']);
    expect([at(12), at(13)]).toEqual(['noon', 'noon']);
    expect([at(14), at(17)]).toEqual(['afternoon', 'afternoon']);
    expect([at(18), at(23)]).toEqual(['evening', 'evening']);
  });

  it('月份键跟着本地日历走 —— 本地月末最后一刻不落进下个月', () => {
    const eve = Math.floor(Date.UTC(2026, 6, 31, 23, 30) / 1000); // UTC 7/31 23:30
    expect(timeContext(eve, 'Asia/Shanghai').monthKey).toBe('2026-08');
    expect(timeContext(eve, 'UTC').monthKey).toBe('2026-07');
  });
});

describe('startOfLocalDay', () => {
  const ts = Math.floor(Date.UTC(2026, 6, 30, 20, 30, 0) / 1000);

  it('UTC+8：本地 7/31 0 点 = UTC 7/30 16:00', () => {
    const s = startOfLocalDay(ts, 'Asia/Shanghai');
    expect(new Date(s * 1000).toISOString()).toBe('2026-07-30T16:00:00.000Z');
    expect(timeContext(s, 'Asia/Shanghai')).toMatchObject({ ymd: '2026-07-31', hm: '00:00' });
  });

  it('UTC-8（夏令时下 -7）：本地 7/30 0 点 = UTC 7/30 07:00', () => {
    const s = startOfLocalDay(ts, 'America/Los_Angeles');
    expect(new Date(s * 1000).toISOString()).toBe('2026-07-30T07:00:00.000Z');
    expect(timeContext(s, 'America/Los_Angeles')).toMatchObject({ ymd: '2026-07-30', hm: '00:00' });
  });

  it('日切当刻自身是幂等的（对 0 点再求 0 点还是它）', () => {
    for (const tz of ['Asia/Shanghai', 'America/Los_Angeles', 'UTC', 'Asia/Kolkata']) {
      const s = startOfLocalDay(ts, tz);
      expect(startOfLocalDay(s, tz)).toBe(s);
    }
  });

  it('跨夏令时切换那天也落在本地 0 点（美西 2026-03-08 春进）', () => {
    const inDst = Math.floor(Date.UTC(2026, 2, 8, 20) / 1000); // 本地 3/8 13:00 PDT
    const s = startOfLocalDay(inDst, 'America/Los_Angeles');
    expect(timeContext(s, 'America/Los_Angeles')).toMatchObject({ ymd: '2026-03-08', hm: '00:00' });
  });
});

// 真机 / CI 2026-07-30~31（issue #332）：偏移串被当 IANA 名直接喂给 Intl。
//   - node 22.19 的 ICU：`RangeError: Invalid time zone specified: +08`（直接调
//     timeContext 那条路 **抛**）；
//   - 走 resolveTz 那条路更阴：validTz 吞掉异常 → 静默回落系统时区 → **日期算错**
//     却不报错（dream.test 里 2026-07-31 变 2026-07-30 就是它）。
//   - node 22.23 的 ICU 恰好开始认 `+08`，于是 CI 自己绿了 —— bug 没修，只是隐身。
// 偏移量根本不需要时区数据库，别再把命运交给 ICU 版本。
describe('偏移串时区自己算，绝不经过 Intl（issue #332）', () => {
  it('不给 Intl 碰：+07:45 这种偏移串一次都不构造 DateTimeFormat', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      expect(timeContext(0, '+07:45').hm).toBe('07:45');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('正负、带分钟、不带分钟都对得上', () => {
    expect(timeContext(0, '+08').hm).toBe('08:00');
    expect(timeContext(0, '+08').ymd).toBe('1970-01-01');
    expect(timeContext(0, '-05:30').hm).toBe('18:30');
    expect(timeContext(0, '-05:30').ymd).toBe('1969-12-31'); // 跨回前一天
    expect(timeContext(0, '+0530').hm).toBe('05:30'); // 紧凑写法也认
  });

  it('偏移串是合法时区（不该被 validTz 判死后静默回落）', () => {
    expect(isValidTz('+08')).toBe(true);
    expect(isValidTz('-05:30')).toBe(true);
    expect(isValidTz('Asia/Shanghai')).toBe(true);
    expect(isValidTz('Mars/Olympus')).toBe(false);
  });

  it('本地日界按那个偏移算', () => {
    // 1970-01-01T00:00Z 在 +08 是当天 08:00 → 当地日界是前一天 16:00Z = -57600
    expect(startOfLocalDay(0, '+08')).toBe(-8 * 3600);
  });
});
