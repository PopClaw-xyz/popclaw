import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';

const io = vi.hoisted(() => ({ calls: [] as Array<{ op: string; path: string }> }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const wrapped: Record<string, unknown> = { ...fs };
  for (const op of ['mkdirSync', 'existsSync', 'writeFileSync', 'readdirSync', 'readFileSync', 'rmSync', 'statSync', 'appendFileSync'] as const) {
    wrapped[op] = (...args: unknown[]) => {
      io.calls.push({ op, path: String(args[0]) });
      return (fs[op] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return wrapped;
});

let root: string;
let issuesDir: string;
let lastNewspaperHtml: string;
const nowMs = new Date(2026, 9, 1, 12, 5, 6).getTime();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'popclaw-artifacts-'));
  issuesDir = join(root, 'issues');
  lastNewspaperHtml = join(root, 'latest', 'last.html');
  io.calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the local newspaper archive capability', () => {
  it('constructs without filesystem work, even when neither destination exists', () => {
    createLocalNewspaperIssueArchive({ issuesDir, lastNewspaperHtml });
    expect(io.calls).toEqual([]);
    expect(existsSync(issuesDir)).toBe(false);
    expect(existsSync(join(root, 'latest'))).toBe(false);
  });

  it('keeps deterministic same-second editions and rewrites the captured suffixed edition', () => {
    const archive = createLocalNewspaperIssueArchive({ issuesDir, lastNewspaperHtml });
    const first = archive.save({ token: 'tok/live', html: 'first', nowMs });
    const second = archive.save({ token: 'tok/live', html: 'second', nowMs });
    const third = archive.save({ token: 'tok/live', html: 'third', nowMs });
    expect([first, second, third].map(saved => basename(saved.path))).toEqual([
      '20261001-120506-tok_live.html',
      '20261001-120506-tok_live-2.html',
      '20261001-120506-tok_live-3.html',
    ]);
    second.rewrite('corrected second');
    expect(readFileSync(first.path, 'utf-8')).toBe('first');
    expect(readFileSync(second.path, 'utf-8')).toBe('corrected second');
    expect(readFileSync(third.path, 'utf-8')).toBe('third');
    expect(readFileSync(lastNewspaperHtml, 'utf-8')).toBe('corrected second');
    expect(readdirSync(issuesDir)).toHaveLength(3);
  });

  it('caps the sanitized token at 64 characters and uses the existing empty-token fallback', () => {
    const archive = createLocalNewspaperIssueArchive({ issuesDir, lastNewspaperHtml });
    const capped = archive.save({ token: '../' + 'x'.repeat(80), html: 'capped', nowMs });
    const empty = archive.save({ token: '', html: 'empty', nowMs });
    expect(basename(capped.path)).toBe(`20261001-120506-${'___' + 'x'.repeat(61)}.html`);
    expect(basename(empty.path)).toBe('20261001-120506-issue.html');
  });

  it('can leave an archive when latest fails, and does not start housekeeping', () => {
    mkdirSync(join(root, 'latest'));
    mkdirSync(lastNewspaperHtml);
    const archive = createLocalNewspaperIssueArchive({ issuesDir, lastNewspaperHtml });
    io.calls = [];
    expect(() => archive.save({ token: 'tok', html: 'partial master', nowMs })).toThrow();
    expect(io.calls.some(call => call.op === 'readdirSync')).toBe(false);
    expect(readFileSync(join(issuesDir, '20261001-120506-tok.html'), 'utf-8')).toBe('partial master');
  });

  it('stops correction at a failed archive write and preserves the latest bytes', () => {
    const archive = createLocalNewspaperIssueArchive({ issuesDir, lastNewspaperHtml });
    const saved = archive.save({ token: 'tok', html: 'original', nowMs });
    rmSync(saved.path);
    mkdirSync(saved.path);
    io.calls = [];
    expect(() => saved.rewrite('correction')).toThrow();
    expect(io.calls.filter(call => call.op === 'writeFileSync').map(call => call.path)).toEqual([saved.path]);
    expect(readFileSync(lastNewspaperHtml, 'utf-8')).toBe('original');
  });
});
