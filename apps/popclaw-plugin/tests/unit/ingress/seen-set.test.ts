import { describe, it, expect } from 'vitest';
import { SeenSet } from '../../../src/ingress/seen-set.js';

describe('SeenSet', () => {
  it('deduplicates ids', () => {
    const s = new SeenSet();
    expect(s.has('a')).toBe(false);
    s.add('a');
    expect(s.has('a')).toBe(true);
    s.add('a');
    expect(s.size).toBe(1);
  });

  it('evicts oldest beyond capacity', () => {
    const s = new SeenSet(2);
    s.add('a');
    s.add('b');
    s.add('c');
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(true);
    expect(s.has('c')).toBe(true);
    expect(s.size).toBe(2);
  });
});
