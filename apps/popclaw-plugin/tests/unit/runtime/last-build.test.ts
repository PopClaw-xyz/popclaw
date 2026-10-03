/**
 * 装机凭据 —— gateway 重启杀断片回来的 agent 回合，机器上得留一条"刚才装过/
 * 升级过 popclaw"的痕迹。见 src/runtime/last-build.ts 头注释。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordBuildOnBoot,
  readLastBuild,
  markBuildAnnounced,
  DEV_BUILD,
  type LastBuildSnapshot,
} from '../../../src/runtime/last-build.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-last-build-'));
  file = join(dir, 'last-build.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recordBuildOnBoot — dev build', () => {
  it('skips entirely on the dev build stamp: no file, no upgrade callback', () => {
    const onUpgrade = vi.fn();
    recordBuildOnBoot(file, DEV_BUILD, onUpgrade);
    expect(existsSync(file)).toBe(false);
    expect(onUpgrade).not.toHaveBeenCalled();
  });
});

describe('recordBuildOnBoot — first run (no file yet)', () => {
  it('writes {build, recordedAt} and does not fire onUpgrade (cannot tell fresh install from an old pre-feature build)', () => {
    const onUpgrade = vi.fn();
    recordBuildOnBoot(file, 'abc123', onUpgrade, () => new Date('2026-07-29T14:15:00.000Z'));
    expect(onUpgrade).not.toHaveBeenCalled();
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    expect(rec).toEqual({ build: 'abc123', recordedAt: '2026-07-29T14:15:00.000Z' });
  });
});

describe('recordBuildOnBoot — same build (every ordinary gateway restart)', () => {
  it('touches nothing: no rewrite, no upgrade callback', () => {
    recordBuildOnBoot(file, 'abc123', undefined, () => new Date('2026-07-29T14:15:00.000Z'));
    const before = readFileSync(file, 'utf-8');
    const onUpgrade = vi.fn();
    recordBuildOnBoot(file, 'abc123', onUpgrade, () => new Date('2026-07-30T09:00:00.000Z'));
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});

describe('recordBuildOnBoot — build changed (an upgrade actually happened)', () => {
  it('updates the file with a previous snapshot and fires onUpgrade with from/to', () => {
    recordBuildOnBoot(file, '4aa6104', undefined, () => new Date('2026-07-28T10:00:00.000Z'));
    const onUpgrade = vi.fn();
    recordBuildOnBoot(file, '55695ac', onUpgrade, () => new Date('2026-07-29T14:15:00.000Z'));

    expect(onUpgrade).toHaveBeenCalledTimes(1);
    const [from, to] = onUpgrade.mock.calls[0] as [LastBuildSnapshot, LastBuildSnapshot];
    expect(from).toEqual({ build: '4aa6104', recordedAt: '2026-07-28T10:00:00.000Z' });
    expect(to).toEqual({ build: '55695ac', recordedAt: '2026-07-29T14:15:00.000Z' });

    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    expect(rec).toEqual({
      build: '55695ac',
      recordedAt: '2026-07-29T14:15:00.000Z',
      previous: { build: '4aa6104', recordedAt: '2026-07-28T10:00:00.000Z' },
    });
  });
});

describe('recordBuildOnBoot — corrupted last-build.json', () => {
  it('treats it as absent: rewrites fresh, does not throw, does not fire onUpgrade', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, 'not json at all', 'utf-8');
    const onUpgrade = vi.fn();
    expect(() =>
      recordBuildOnBoot(file, 'abc123', onUpgrade, () => new Date('2026-07-29T14:15:00.000Z')),
    ).not.toThrow();
    expect(onUpgrade).not.toHaveBeenCalled();
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    expect(rec).toEqual({ build: 'abc123', recordedAt: '2026-07-29T14:15:00.000Z' });
  });

  it('also treats a well-formed-but-wrong-shaped file as absent', () => {
    writeFileSync(file, JSON.stringify({ build: 42 }), 'utf-8');
    const onUpgrade = vi.fn();
    recordBuildOnBoot(file, 'abc123', onUpgrade, () => new Date('2026-07-29T14:15:00.000Z'));
    expect(onUpgrade).not.toHaveBeenCalled();
  });
});

describe('markBuildAnnounced — issue #270 once-only announce marker', () => {
  it('writes announcedBuild onto the existing record, preserving previous', () => {
    recordBuildOnBoot(file, '4aa6104', undefined, () => new Date('2026-07-28T10:00:00.000Z'));
    recordBuildOnBoot(file, '55695ac', undefined, () => new Date('2026-07-29T14:15:00.000Z'));
    markBuildAnnounced(file, '55695ac');
    expect(readLastBuild(file)).toEqual({
      build: '55695ac',
      recordedAt: '2026-07-29T14:15:00.000Z',
      previous: { build: '4aa6104', recordedAt: '2026-07-28T10:00:00.000Z' },
      announcedBuild: '55695ac',
    });
  });

  it('no-ops when the file has moved on to a different build in the meantime', () => {
    recordBuildOnBoot(file, 'abc123', undefined, () => new Date('2026-07-29T14:15:00.000Z'));
    markBuildAnnounced(file, 'stale-build'); // not the build on disk
    expect(readLastBuild(file)?.announcedBuild).toBeUndefined();
  });

  it('no-ops (does not throw) when the file does not exist yet', () => {
    expect(() => markBuildAnnounced(file, 'abc123')).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it('no-ops (does not throw) when the file is corrupted', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, 'not json at all', 'utf-8');
    expect(() => markBuildAnnounced(file, 'abc123')).not.toThrow();
    expect(readFileSync(file, 'utf-8')).toBe('not json at all'); // untouched, not silently rewritten
  });
});

describe('readLastBuild', () => {
  it('returns null when the file does not exist', () => {
    expect(readLastBuild(file)).toBeNull();
  });

  it('returns null when the file is corrupted', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '{not json', 'utf-8');
    expect(readLastBuild(file)).toBeNull();
  });

  it('returns the record, previous included, once an upgrade has happened', () => {
    recordBuildOnBoot(file, '4aa6104', undefined, () => new Date('2026-07-28T10:00:00.000Z'));
    recordBuildOnBoot(file, '55695ac', undefined, () => new Date('2026-07-29T14:15:00.000Z'));
    expect(readLastBuild(file)).toEqual({
      build: '55695ac',
      recordedAt: '2026-07-29T14:15:00.000Z',
      previous: { build: '4aa6104', recordedAt: '2026-07-28T10:00:00.000Z' },
    });
  });
});
