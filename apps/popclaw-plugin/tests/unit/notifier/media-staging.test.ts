import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dmMediaStagingDir, stageMediaForSend } from '../../../src/notifier/media-staging.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'popclaw-stage-'));

describe('dmMediaStagingDir', () => {
  it('落在宿主允许的 <stateDir>/media 之内（取证见模块头注释）', () => {
    expect(dmMediaStagingDir('/Users/x/.openclaw')).toBe('/Users/x/.openclaw/media/popclaw-dm');
  });
});

describe('stageMediaForSend', () => {
  it('把正本拷进 staging 目录并返回新路径（正本原地不动）', () => {
    const root = tmp();
    const src = join(root, 'src.png');
    writeFileSync(src, 'PNGBYTES');
    const dir = join(root, 'staged');

    const out = stageMediaForSend(src, dir);

    expect(out).toBe(join(dir, 'src.png'));
    expect(readFileSync(out!, 'utf8')).toBe('PNGBYTES');
    expect(readFileSync(src, 'utf8')).toBe('PNGBYTES'); // The master copy remains in data/dm-media.
  });

  it('同名重复 staging 覆盖而不是堆一地（文件名是确定性的）', () => {
    const root = tmp();
    const src = join(root, 'a.png');
    const dir = join(root, 'staged');
    writeFileSync(src, 'one');
    stageMediaForSend(src, dir);
    writeFileSync(src, 'two');

    expect(readFileSync(stageMediaForSend(src, dir)!, 'utf8')).toBe('two');
  });

  it('拷不动就返回 null 并喊一声——图失败绝不拦文字', () => {
    const root = tmp();
    const onError = vi.fn();

    const out = stageMediaForSend(join(root, 'nope.png'), join(root, 'staged'), onError);

    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('staging 目录建不出来也只是 null（不抛）', () => {
    const root = tmp();
    const src = join(root, 'a.png');
    writeFileSync(src, 'x');
    const blocked = join(root, 'blocked');
    mkdirSync(blocked);
    chmodSync(blocked, 0o500); // Read-only directory: neither mkdir nor copy can succeed.

    expect(stageMediaForSend(src, join(blocked, 'staged'))).toBeNull();
  });
});
