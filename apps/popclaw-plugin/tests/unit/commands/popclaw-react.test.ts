import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPopclawReactCommand } from '../../../src/commands/popclaw-react';

const cacheItemFor = (over: Record<string, unknown> = {}) => ({
  platform: 'x',
  platformPostId: '12345',
  platformPostCreatedAt: 0,
  authorPopclawId: 'AAA',
  handle: 'karpathy',
  originalUrl: 'u',
  textPreview: 'Neural networks training is like coaxing water down a mountain.',
  ...over,
});

const cacheStub = (item: ReturnType<typeof cacheItemFor> | null) => ({
  lookup: vi.fn().mockReturnValue(item),
});

describe('runPopclawReactCommand', () => {
  let dir: string;
  let picksFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'popclaw-react-'));
    picksFile = join(dir, 'picks.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records `up` reaction and returns confirmation text', async () => {
    const cache = cacheStub(cacheItemFor());
    const out = await runPopclawReactCommand(
      { positional: ['up', '12345'] },
      { cache, picksFile, now: () => 1700000000_000 },
    );
    expect(out.text).toContain('@karpathy');
    expect(out.text).toMatch(/up|↑|recorded/i);
    expect(cache.lookup).toHaveBeenCalledWith('x', '12345');
    const lines = readFileSync(picksFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.itemId).toBe('x:12345');
    expect(rec.handle).toBe('karpathy');
    expect(rec.reaction).toBe('up');
    expect(rec.ts).toBe(1700000000);
  });

  it('records `down` reaction', async () => {
    const cache = cacheStub(cacheItemFor());
    await runPopclawReactCommand({ positional: ['down', '12345'] }, { cache, picksFile });
    const rec = JSON.parse(readFileSync(picksFile, 'utf-8').trim());
    expect(rec.reaction).toBe('down');
  });

  it('accepts <platform>:<postId> form', async () => {
    const cache = cacheStub(cacheItemFor({ platform: 'instagram', platformPostId: '99' }));
    await runPopclawReactCommand({ positional: ['up', 'instagram:99'] }, { cache, picksFile });
    expect(cache.lookup).toHaveBeenCalledWith('instagram', '99');
    const rec = JSON.parse(readFileSync(picksFile, 'utf-8').trim());
    expect(rec.itemId).toBe('instagram:99');
  });

  it('rejects unknown reaction with friendly text', async () => {
    const cache = cacheStub(cacheItemFor());
    const out = await runPopclawReactCommand({ positional: ['maybe', '12345'] }, { cache, picksFile });
    expect(out.text).toMatch(/up.*down|usage|unknown/i);
    expect(existsSync(picksFile)).toBe(false);
  });

  it('returns usage when no args', async () => {
    const cache = cacheStub(cacheItemFor());
    const out = await runPopclawReactCommand({ positional: [] }, { cache, picksFile });
    expect(out.text.toLowerCase()).toMatch(/usage|popclaw react/);
    expect(existsSync(picksFile)).toBe(false);
  });

  it('returns helpful error when item is not in cache', async () => {
    const cache = cacheStub(null);
    const out = await runPopclawReactCommand(
      { positional: ['up', 'never-seen-id'] },
      { cache, picksFile },
    );
    expect(out.text).toMatch(/not found|not in cache|never-seen-id/i);
    expect(existsSync(picksFile)).toBe(false);
  });

  it('appends to picks.jsonl (does not truncate prior entries)', async () => {
    const cache = cacheStub(cacheItemFor());
    await runPopclawReactCommand({ positional: ['up', '12345'] }, { cache, picksFile, now: () => 1000_000 });
    await runPopclawReactCommand({ positional: ['down', '67890'] }, {
      cache: cacheStub(cacheItemFor({ platformPostId: '67890', handle: 'sama' })),
      picksFile,
      now: () => 2000_000,
    });
    const lines = readFileSync(picksFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
