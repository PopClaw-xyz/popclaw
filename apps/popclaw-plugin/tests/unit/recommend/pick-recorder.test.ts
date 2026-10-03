import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCyclePicks, type PickRecord } from '../../../src/recommend/pick-recorder';

describe('pick-recorder', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'popclaw-picks-'));
    file = join(dir, 'picks.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function pick(over: Partial<PickRecord> = {}): PickRecord {
    return {
      ts: 1700000000,
      itemId: 'x:1',
      handle: 'karpathy',
      textPreview: 'hello',
      score: 0.7,
      reaction: 'up',
      ...over,
    };
  }

  it('appends picks one per line as JSONL', () => {
    recordCyclePicks(file, [pick({ itemId: 'x:1' }), pick({ itemId: 'x:2' })]);
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).itemId).toBe('x:1');
    expect(JSON.parse(lines[1]!).itemId).toBe('x:2');
  });

  it('appends to an existing file (does not truncate)', () => {
    recordCyclePicks(file, [pick({ itemId: 'a' })]);
    recordCyclePicks(file, [pick({ itemId: 'b' })]);
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('creates parent directory if missing', () => {
    const nested = join(dir, 'a', 'b', 'picks.jsonl');
    recordCyclePicks(nested, [pick()]);
    expect(existsSync(nested)).toBe(true);
  });

  it('empty picks list = no-op (does not create file)', () => {
    recordCyclePicks(file, []);
    expect(existsSync(file)).toBe(false);
  });
});
