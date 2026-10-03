import { describe, it, expect } from 'vitest';
import { SessionContextIndex, type ContextItem } from '../../../src/onboarding/context-index.js';

const item = (n: number, nickname: string, line: string): ContextItem => ({
  eventId: `${n}`.repeat(64).slice(0, 64),
  authorPopclawId: `pid-${n}`,
  authorNickname: nickname,
  summaryLine: line,
  source: 'summary',
});

describe('SessionContextIndex', () => {
  it('register sets lastBatch and byOrdinal is 1-based within it', () => {
    const idx = new SessionContextIndex();
    idx.register([item(1, 'Elon', 'mars'), item(2, '青鸾', '杭州吃饭')]);
    expect(idx.lastBatch()).toHaveLength(2);
    expect(idx.byOrdinal(2)?.authorNickname).toBe('青鸾');
    expect(idx.byOrdinal(3)).toBeNull();
    expect(idx.byOrdinal(0)).toBeNull();
  });

  it('findByHint matches nickname or summaryLine substring, newest batch first', () => {
    const idx = new SessionContextIndex();
    idx.register([item(1, 'Elon Musk', 'to mars')]);
    idx.register([item(2, '青鸾', '杭州吃饭那家店')]);
    expect(idx.findByHint('杭州')[0]?.eventId).toBe(item(2, '', '').eventId);
    expect(idx.findByHint('Musk')[0]?.authorPopclawId).toBe('pid-1');
    expect(idx.findByHint('不存在')).toHaveLength(0);
  });

  it('dedupes by eventId across batches keeping the newest', () => {
    const idx = new SessionContextIndex();
    const a = item(1, 'Elon', 'old line');
    idx.register([a]);
    idx.register([{ ...a, summaryLine: 'new line', source: 'thread' as const }]);
    const hits = idx.findByHint('Elon');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.summaryLine).toBe('new line');
  });

  it('ring buffer caps total retained items', () => {
    const idx = new SessionContextIndex(3);
    idx.register([item(1, 'a', 'x'), item(2, 'b', 'y')]);
    idx.register([item(3, 'c', 'z'), item(4, 'd', 'w')]);
    expect(idx.recent(10)).toHaveLength(3);             // capacity=3
    expect(idx.recent(10)[0]?.authorPopclawId).toBe('pid-4'); // 最新在前
  });
});
