import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScoreCache, hashTasteSources } from '../../../src/recommend/score-cache';

describe('hashTasteSources', () => {
  it('returns same hash for same sources in same order', () => {
    const a = [
      { path: 'core/public.md', weight: 1, content: 'AI safety' },
      { path: 'core/private.md', weight: 1, content: 'private notes' },
    ];
    expect(hashTasteSources(a)).toBe(hashTasteSources(a));
  });

  it('returns same hash regardless of input order (canonicalized)', () => {
    const a = [
      { path: 'core/public.md', weight: 1, content: 'AI safety' },
      { path: 'core/private.md', weight: 1, content: 'private' },
    ];
    const b = [
      { path: 'core/private.md', weight: 1, content: 'private' },
      { path: 'core/public.md', weight: 1, content: 'AI safety' },
    ];
    expect(hashTasteSources(a)).toBe(hashTasteSources(b));
  });

  it('different content → different hash', () => {
    const a = [{ path: 'core/public.md', weight: 1, content: 'AI safety' }];
    const b = [{ path: 'core/public.md', weight: 1, content: 'AI safety + musk' }];
    expect(hashTasteSources(a)).not.toBe(hashTasteSources(b));
  });

  it('different weight → different hash', () => {
    const a = [{ path: 'core/public.md', weight: 1, content: 'x' }];
    const b = [{ path: 'core/public.md', weight: 2, content: 'x' }];
    expect(hashTasteSources(a)).not.toBe(hashTasteSources(b));
  });
});

describe('ScoreCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'popclaw-score-cache-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(): string {
    return join(dir, 'score-cache.json');
  }

  it('returns null when file does not exist', () => {
    const c = ScoreCache.load(file());
    expect(c.lookup('x:1', 'h1')).toBeNull();
  });

  it('lookup returns scores when itemId + tasteHash match', () => {
    const c = ScoreCache.load(file());
    c.put('x:1', 'h1', [0.7, 0.2]);
    expect(c.lookup('x:1', 'h1')).toEqual([0.7, 0.2]);
  });

  it('lookup returns null when itemId matches but tasteHash differs (taste edited → invalidate)', () => {
    const c = ScoreCache.load(file());
    c.put('x:1', 'h1', [0.7]);
    expect(c.lookup('x:1', 'h2')).toBeNull();
  });

  it('save then load round-trips', async () => {
    const c1 = ScoreCache.load(file());
    c1.put('x:1', 'h1', [0.5, 0.3]);
    c1.put('x:2', 'h1', [0.0, 0.0]);
    await c1.save();
    expect(existsSync(file())).toBe(true);

    const c2 = ScoreCache.load(file());
    expect(c2.lookup('x:1', 'h1')).toEqual([0.5, 0.3]);
    expect(c2.lookup('x:2', 'h1')).toEqual([0.0, 0.0]);
  });

  it('put with new tasteHash overwrites stale entry (no unbounded growth per item)', async () => {
    const c = ScoreCache.load(file());
    c.put('x:1', 'h1', [0.7]);
    c.put('x:1', 'h2', [0.4]);
    expect(c.lookup('x:1', 'h1')).toBeNull();
    expect(c.lookup('x:1', 'h2')).toEqual([0.4]);
    await c.save();
    const onDisk = JSON.parse(readFileSync(file(), 'utf-8'));
    // Only one entry per itemId
    expect(Object.keys(onDisk)).toHaveLength(1);
  });

  it('survives malformed JSON file by starting empty (defensive)', () => {
    writeFileSync(file(), '{not json', 'utf-8');
    const c = ScoreCache.load(file());
    expect(c.lookup('x:1', 'h1')).toBeNull();
  });
});
