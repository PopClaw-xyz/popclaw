import { describe, it, expect } from 'vitest';
import { displayWidth } from '../../../src/commands/status.js';

describe('displayWidth — 等宽块里中文占两格', () => {
  it('counts ASCII as one cell', () => {
    expect(displayWidth('abc 12')).toBe(6);
  });
  it('counts CJK as two cells', () => {
    expect(displayWidth('关注')).toBe(4);
    expect(displayWidth('私信过你')).toBe(8);
  });
  it('counts fullwidth punctuation as two cells', () => {
    expect(displayWidth('（好友）')).toBe(8);
  });
  it('mixes them correctly', () => {
    expect(displayWidth('关注 2 人')).toBe(4 + 1 + 1 + 1 + 2);
  });
  it('treats the middle dot as one cell', () => {
    expect(displayWidth('·')).toBe(1);
  });
});
