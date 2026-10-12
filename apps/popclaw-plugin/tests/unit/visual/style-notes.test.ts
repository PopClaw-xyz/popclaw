import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStyleNotes,
  appendStyleNote,
  handleStyleFeedback,
  migrateStyleNotesToVault,
} from '../../../src/visual/style-notes';
import { setOwnerLang } from '../../../src/lexicon/owner-language';

// S13 slice: handleStyleFeedback's ack/warn text now renders in `ownerLang()`
// (default en-US) instead of hardcoded zh — pin zh-CN so the assertions below
// stay meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

function tmpStyleFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'vd-')), 'canvas-style.md');
}
const at = (ms: number) => () => ms;

describe('style-notes', () => {
  it('readStyleNotes returns empty string when file missing', () => {
    expect(readStyleNotes(tmpStyleFile())).toBe('');
  });

  it('appendStyleNote then read round-trips with a timestamp line', () => {
    const file = tmpStyleFile();
    appendStyleNote(file, '字体大点', at(0));
    const out = readStyleNotes(file);
    expect(out).toContain('字体大点');
    expect(out).toContain('1970-01-01'); // ISO timestamp from now()=0
    expect(existsSync(file)).toBe(true);
  });

  it('multiple appends accumulate newest-last', () => {
    const file = tmpStyleFile();
    appendStyleNote(file, '深色', at(0));
    appendStyleNote(file, '浅色', at(1000));
    const out = readStyleNotes(file);
    expect(out.indexOf('深色')).toBeLessThan(out.indexOf('浅色'));
  });

  it('appendStyleNote ignores blank notes', () => {
    const file = tmpStyleFile();
    appendStyleNote(file, '   ', at(0));
    expect(readStyleNotes(file)).toBe('');
  });

  it('handleStyleFeedback returns null when no --feedback flag', () => {
    expect(handleStyleFeedback({}, tmpStyleFile(), at(0))).toBeNull();
  });

  it('handleStyleFeedback warns and does not write on empty --feedback', () => {
    const file = tmpStyleFile();
    const r = handleStyleFeedback({ feedback: '  ' }, file, at(0));
    expect(r?.text).toContain('要带上你的意见');
    expect(readStyleNotes(file)).toBe('');
  });

  it('handleStyleFeedback treats bare --feedback (parseArgs "true" sentinel) as empty', () => {
    const file = tmpStyleFile();
    const r = handleStyleFeedback({ feedback: 'true' }, file, at(0));
    expect(r?.text).toContain('要带上你的意见');
    expect(readStyleNotes(file)).toBe('');
  });

  it('handleStyleFeedback writes note and acks on real --feedback', () => {
    const file = tmpStyleFile();
    const r = handleStyleFeedback({ feedback: '多上图表' }, file, at(0));
    expect(r?.text).toContain('已记下');
    expect(r?.text).toContain('多上图表');
    expect(readStyleNotes(file)).toContain('多上图表');
  });
});

// ---------------------------------------------------------------------------
// Move data/ → vault/ (P-004: owner-provided taste signals cannot live in disposable storage;
// P-006: migrate existing users' files too, never orphan them).
// ---------------------------------------------------------------------------

describe('migrateStyleNotesToVault', () => {
  function beds(): { root: string; oldFile: string; newFile: string } {
    const root = mkdtempSync(join(tmpdir(), 'vd-mig-'));
    return {
      root,
      oldFile: join(root, 'data', 'canvas-style.md'),
      newFile: join(root, 'vault', 'taste', 'canvas-style.md'),
    };
  }

  it('没有老文件 → 什么都不做（全新用户 / 已搬过）', () => {
    const { oldFile, newFile } = beds();
    expect(migrateStyleNotesToVault(oldFile, newFile)).toBe(false);
    expect(existsSync(newFile)).toBe(false);
  });

  it('老文件搬进 vault，原地不再留一份', () => {
    const { oldFile, newFile } = beds();
    mkdirSync(join(oldFile, '..'), { recursive: true });
    writeFileSync(oldFile, '- [t] 字体大点\n', 'utf-8');
    expect(migrateStyleNotesToVault(oldFile, newFile)).toBe(true);
    expect(readStyleNotes(newFile)).toBe('- [t] 字体大点\n');
    expect(existsSync(oldFile)).toBe(false);
  });

  it('幂等：再跑一次不重复搬、不覆盖新家已有内容', () => {
    const { oldFile, newFile } = beds();
    mkdirSync(join(oldFile, '..'), { recursive: true });
    writeFileSync(oldFile, '- [t] 老笔记\n', 'utf-8');
    migrateStyleNotesToVault(oldFile, newFile);
    appendStyleNote(newFile, '新笔记', at(0));
    expect(migrateStyleNotesToVault(oldFile, newFile)).toBe(false);
    const out = readStyleNotes(newFile);
    expect(out).toContain('老笔记');
    expect(out).toContain('新笔记');
    expect(out.split('老笔记').length - 1).toBe(1);
  });

  it('两边都有内容（换机/回滚过）→ 合并保留双方，老的在前', () => {
    const { oldFile, newFile } = beds();
    mkdirSync(join(oldFile, '..'), { recursive: true });
    mkdirSync(join(newFile, '..'), { recursive: true });
    writeFileSync(oldFile, '- [1] 老笔记\n', 'utf-8');
    writeFileSync(newFile, '- [2] 新笔记\n', 'utf-8');
    expect(migrateStyleNotesToVault(oldFile, newFile)).toBe(true);
    const out = readStyleNotes(newFile);
    expect(out.indexOf('老笔记')).toBeLessThan(out.indexOf('新笔记'));
    expect(existsSync(oldFile)).toBe(false);
  });
});
