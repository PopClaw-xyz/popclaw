/**
 * The durable dispatch ledger.
 *
 * Before it, a failed newspaper run left one line in a container log that is gone on the
 * next restart (2026-09-13: two truncated pages, no publish receipt, nothing to count). The
 * ledger is the denominator — successes are written too — and it is bound by the same
 * retention the published issues already use, so it can never grow without limit.
 *
 * The host artifact module owns newspaper filesystem writes and retention;
 * business publication and dispatch orchestration perform no direct filesystem IO.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ISSUE_RETENTION_DAYS,
  dispatchLogPath,
  readDispatchLog,
  recordNewspaperDispatch,
  sweepDispatchLog,
} from '../../../src/host/local-newspaper-artifacts.js';
import type { NewspaperDispatchRecord } from '../../../src/newspaper/dedicated-session.js';

const DAY_MS = 24 * 60 * 60 * 1000;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-dispatch-log-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (over: Partial<NewspaperDispatchRecord> = {}): NewspaperDispatchRecord => ({
  at: new Date().toISOString(),
  runId: 'run-1',
  sessionKey: 'agent:main:popclaw-newspaper:202609130956-8jwc',
  outcome: 'published',
  ...over,
});

describe('recordNewspaperDispatch', () => {
  it('leaves every earlier record byte-for-byte alone — the ordinary append rewrites nothing', () => {
    recordNewspaperDispatch(dir, rec({ runId: 'run-1' }));
    const afterFirst = readFileSync(dispatchLogPath(dir), 'utf-8');
    recordNewspaperDispatch(dir, rec({ runId: 'run-2', outcome: 'no-receipt' }));
    const afterSecond = readFileSync(dispatchLogPath(dir), 'utf-8');

    // A ledger kept to record the runs that die must not put its history at risk on every
    // write: the second append extends the file, it does not rebuild it.
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(readDispatchLog(dir).map((r) => r.runId)).toEqual(['run-1', 'run-2']);
  });

  it('appends one JSON line per outcome, next to the issue archive', () => {
    recordNewspaperDispatch(dir, rec());
    recordNewspaperDispatch(dir, rec({ outcome: 'no-receipt', reason: 'the workshop never published' }));

    const raw = readFileSync(dispatchLogPath(dir), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trim().split('\n')).toHaveLength(2);
    const rows = readDispatchLog(dir);
    expect(rows.map((r) => r.outcome)).toEqual(['published', 'no-receipt']);
    expect(rows[1]!.reason).toBe('the workshop never published');
    expect(dispatchLogPath(dir)).toBe(join(dir, 'dispatches.jsonl'));
  });

  it('creates the directory it writes into (a machine that has never published)', () => {
    const fresh = join(dir, 'newspaper');
    recordNewspaperDispatch(fresh, rec());
    expect(readDispatchLog(fresh)).toHaveLength(1);
  });

  it('an IO error is logged and swallowed — a ledger must never cost the owner a paper', () => {
    // A file where the directory should be: every write into it fails.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory', 'utf-8');
    const logged: string[] = [];
    expect(() => recordNewspaperDispatch(blocked, rec(), { log: (m) => logged.push(m) })).not.toThrow();
    expect(logged.join('\n')).toContain('popclaw: newspaper dispatch record not written');
  });

  it('a record with no logger still swallows its IO error', () => {
    const blocked = join(dir, 'blocked2');
    writeFileSync(blocked, 'not a directory', 'utf-8');
    expect(() => recordNewspaperDispatch(blocked, rec())).not.toThrow();
  });
});

describe('retention', () => {
  it('the sweep drops records past the window the published issues use, and keeps the rest', () => {
    const now = Date.now();
    const old = new Date(now - (ISSUE_RETENTION_DAYS + 1) * DAY_MS).toISOString();
    const edge = new Date(now - (ISSUE_RETENTION_DAYS - 1) * DAY_MS).toISOString();
    recordNewspaperDispatch(dir, rec({ at: old, runId: 'ancient' }), { now });
    recordNewspaperDispatch(dir, rec({ at: edge, runId: 'recent' }), { now });

    sweepDispatchLog(dir, now);
    expect(readDispatchLog(dir).map((r) => r.runId)).toEqual(['recent']);
  });

  it('every append sweeps too, so the file cannot grow without bound', () => {
    const now = Date.now();
    const old = new Date(now - (ISSUE_RETENTION_DAYS + 3) * DAY_MS).toISOString();
    writeFileSync(dispatchLogPath(dir), `${JSON.stringify(rec({ at: old, runId: 'ancient' }))}\n`, 'utf-8');
    recordNewspaperDispatch(dir, rec({ runId: 'fresh' }), { now });
    expect(readDispatchLog(dir).map((r) => r.runId)).toEqual(['fresh']);
  });

  it('a line nothing can date is dropped rather than kept forever', () => {
    writeFileSync(dispatchLogPath(dir), 'not json at all\n{"runId":"undated"}\n', 'utf-8');
    recordNewspaperDispatch(dir, rec({ runId: 'fresh' }));
    expect(readDispatchLog(dir).map((r) => r.runId)).toEqual(['fresh']);
  });

  it('sweeping a ledger that does not exist yet is a no-op, not a throw', () => {
    expect(() => sweepDispatchLog(join(dir, 'nope', 'deeper'), Date.now())).not.toThrow();
    expect(readDispatchLog(dir)).toEqual([]);
  });
});
