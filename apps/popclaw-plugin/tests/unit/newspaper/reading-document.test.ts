import { beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as reading from '../../../src/newspaper/reading-page.js';
import { _resetIssuesForTest, putIssue, readingTextVersion } from '../../../src/newspaper/issue-store.js';
import { _resetBudgetForTest } from '../../../src/newspaper/host-budget.js';
import { issue, item } from './_issue-fixture.js';

beforeEach(() => { _resetIssuesForTest(); _resetBudgetForTest(); });
const next = (page: string): string => /page_cursor="([^"]+)"/.exec(page)![1]!;
const readingModule = fileURLToPath(new URL('../../../src/newspaper/reading-page.ts', import.meta.url));
const storeModule = fileURLToPath(new URL('../../../src/newspaper/issue-store.ts', import.meta.url));
function child(script: string): void {
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
}

it('rejects process A old-stage cursor after process B updates the persistent receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reading-stage-'));
  putIssue('tok_process', issue(), dir, 'writer');
  const cursor = next(reading.beginReading('tok_process', 'OLD SOURCE '.repeat(12000), { manifestDir: dir }));
  child(`import {beginReading} from ${JSON.stringify(readingModule)}; beginReading('tok_process', 'NEW RECEIPT '.repeat(12000), {manifestDir:${JSON.stringify(dir)}});`);
  expect(JSON.parse(readFileSync(join(dir, 'tok_process.json'), 'utf8')).readingCurrent).not.toBe(cursor.split('.')[1]);
  expect(() => reading.readNewspaperPage(cursor, { manifestDir: dir })).toThrow('not found');
});

it.each(['consumed', 'deleted', 'expired', 'corrupt'] as const)('never revives cached source when the persistent ledger is %s', mode => {
  const dir = mkdtempSync(join(tmpdir(), 'reading-gone-'));
  putIssue('tok_gone', issue(), dir);
  const cursor = next(reading.beginReading('tok_gone', 'OLD SOURCE '.repeat(12000), { manifestDir: dir }));
  const file = join(dir, 'tok_gone.json');
  if (mode === 'consumed') child(`import {deleteIssue} from ${JSON.stringify(storeModule)}; deleteIssue('tok_gone', ${JSON.stringify(dir)});`);
  else if (mode === 'deleted') child(`import {unlinkSync} from 'node:fs'; unlinkSync(${JSON.stringify(file)});`);
  else if (mode === 'expired') {
    const raw = JSON.parse(readFileSync(file, 'utf8')); raw.created_at = Date.now() - 3 * 60 * 60 * 1000;
    writeFileSync(file, JSON.stringify(raw));
  } else writeFileSync(file, '{invalid');
  const validate = vi.fn();
  expect(() => reading.readNewspaperPage(cursor, { manifestDir: dir, validateMaterials: validate })).toThrow('not found');
  expect(() => reading.readNewspaperDocument('tok_gone', { manifestDir: dir, validateMaterials: validate })).toThrow('not found');
  expect(validate).not.toHaveBeenCalled();
});

it('returns structured complete Unicode text and version, not an English footer or response-sized excerpt', () => {
  const source = '  完整原文𠀀🙂\r\n'.repeat(15000) + '最后一个字\n';
  const dir = mkdtempSync(join(tmpdir(), 'reading-document-'));
  putIssue('tok_full', issue({ pulse: [item({ text: source })] }), dir);
  reading.beginReading('tok_full', source, { manifestDir: dir });
  const validate = vi.fn((current: ReturnType<typeof issue>) => expect(current.pulse[0]!.text).toBe(source));
  const doc = reading.readNewspaperDocument('tok_full', { manifestDir: dir, validateMaterials: validate });
  expect(Object.keys(doc).sort()).toEqual(['text', 'version']);
  expect(doc.version).toBe(readingTextVersion(source));
  expect(Buffer.from(doc.text)).toEqual(Buffer.from(source));
  expect(validate).toHaveBeenCalledOnce();
});

it('structured reading sees the same current disk snapshot for issue and document despite old memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reading-snapshot-'));
  putIssue('tok_snapshot', issue({ pulse: [item({ text: 'OLD SOURCE' })] }), dir);
  reading.beginReading('tok_snapshot', 'OLD DOCUMENT', { manifestDir: dir });
  child(`import {readFileSync,writeFileSync} from 'node:fs'; import {beginReading} from ${JSON.stringify(readingModule)};
    const f=${JSON.stringify(join(dir, 'tok_snapshot.json'))}; const raw=JSON.parse(readFileSync(f,'utf8')); raw.issue.pulse[0].text='CURRENT SOURCE'; writeFileSync(f,JSON.stringify(raw));
    beginReading('tok_snapshot','CURRENT DOCUMENT',{manifestDir:${JSON.stringify(dir)}});`);
  const validate = vi.fn((current: ReturnType<typeof issue>) => expect(current.pulse[0]!.text).toBe('CURRENT SOURCE'));
  expect(reading.readNewspaperDocument('tok_snapshot', { manifestDir: dir, validateMaterials: validate }).text).toBe('CURRENT DOCUMENT');
  expect(validate).toHaveBeenCalledOnce();
});

it('structured reading refuses invalid token, missing/version-tampered document and actual source refusal without returning text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reading-refusal-'));
  putIssue('tok_refuse', issue(), dir);
  reading.beginReading('tok_refuse', 'private source text', { manifestDir: dir });
  const validate = vi.fn(() => { throw new Error('NEWSPAPER_PUBLIC_SOURCE_UPDATED'); });
  expect(() => reading.readNewspaperDocument('tok_refuse', { manifestDir: dir, validateMaterials: validate })).toThrow('NEWSPAPER_PUBLIC_SOURCE_UPDATED');
  expect(validate).toHaveBeenCalledOnce();
  expect(() => reading.readNewspaperDocument('../tok_refuse', { manifestDir: dir })).toThrow('invalid');
  expect(() => reading.readNewspaperDocument('tok_absent', { manifestDir: dir })).toThrow('not found');
  const file = join(dir, 'tok_refuse.json'), raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.reading[raw.readingCurrent] += 'changed'; writeFileSync(file, JSON.stringify(raw));
  expect(() => reading.readNewspaperDocument('tok_refuse', { manifestDir: dir })).toThrow('version changed');
});

it('keeps non-persistent same-process reading and invalidates its old version', () => {
  putIssue('tok_memory', issue());
  const cursor = next(reading.beginReading('tok_memory', 'old text '.repeat(12000)));
  reading.beginReading('tok_memory', 'new text');
  expect(reading.readNewspaperDocument('tok_memory')).toEqual({ version: readingTextVersion('new text'), text: 'new text' });
  expect(() => reading.readNewspaperPage(cursor)).toThrow('not found');
});
