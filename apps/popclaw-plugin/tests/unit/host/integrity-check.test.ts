import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import {
  isSchemaDrift,
  runIntegrityChecks,
  markIntegrityAnnounced,
  type IntegrityRecord,
} from '../../../src/host/integrity-check.js';

const rec = (fingerprint: string, build: string, announced?: string): IntegrityRecord =>
  announced ? { fingerprint, build, announced } : { fingerprint, build };

describe('isSchemaDrift (false-alarm gate — the one thing worth not getting wrong)', () => {
  it('alerts when the fingerprint changed and the build did not', () => {
    expect(isSchemaDrift(rec('aaa', 'b1'), 'bbb', 'b1')).toBe(true);
  });

  it('stays quiet when the build changed too (plugin upgrades legitimately change schema)', () => {
    expect(isSchemaDrift(rec('aaa', 'b1'), 'bbb', 'b2')).toBe(false);
  });

  it('stays quiet on the first boot (nothing to compare against) and on no change', () => {
    expect(isSchemaDrift(undefined, 'aaa', 'b1')).toBe(false);
    expect(isSchemaDrift(rec('aaa', 'b1'), 'aaa', 'b1')).toBe(false);
  });
});

describe('runIntegrityChecks', () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'popclaw-integrity-'));
    stateFile = join(tmpDir, 'data', 'db-integrity.json');
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const open = () => new LocalHostDb(join(tmpDir, 'x.db'));

  it('is silent on a healthy db, and silent again after an upgrade adds a table', () => {
    const db = open();
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(runIntegrityChecks({ dbs: [{ label: 'social', db }], stateFile, build: 'b1' })).toEqual([]);
    expect(runIntegrityChecks({ dbs: [{ label: 'social', db }], stateFile, build: 'b1' })).toEqual([]);
    db.execute('CREATE TABLE t2 (id INTEGER PRIMARY KEY)'); // "upgrade"
    expect(runIntegrityChecks({ dbs: [{ label: 'social', db }], stateFile, build: 'b2' })).toEqual([]);
    db.close();
  });

  it('flags schema drift under an unchanged build, once only after it is announced', () => {
    const db = open();
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    runIntegrityChecks({ dbs: [{ label: 'social', db }], stateFile, build: 'b1' });

    db.execute('CREATE INDEX helpful ON t (id)'); // "let me optimise that for you"
    const findings = runIntegrityChecks({ dbs: [{ label: 'social', db }], stateFile, build: 'b1' });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.key).toMatch(/^schema_drift:/);

    markIntegrityAnnounced(stateFile, findings);
    expect(runIntegrityChecks({ dbs: [{ label: 'social', db }], stateFile, build: 'b1' })).toEqual([]);
    db.close();
  });

  it('flags dangling foreign keys (what an outside sqlite3 hand-edit leaves behind)', () => {
    const db = open();
    db.execute('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    db.execute('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))');
    db.execute('INSERT INTO p (id) VALUES (1)');
    db.execute('INSERT INTO c (id, pid) VALUES (1, 1)');
    runIntegrityChecks({ dbs: [{ label: 'social', db }], stateFile, build: 'b1' });

    // Exactly what the sqlite3 CLI does by default (foreign_keys = 0).
    db.execute('PRAGMA foreign_keys = OFF');
    db.execute('DELETE FROM p WHERE id = 1');
    db.execute('PRAGMA foreign_keys = ON');

    const findings = runIntegrityChecks({ dbs: [{ label: 'social', db }], stateFile, build: 'b1' });
    expect(findings.map((f) => f.key)).toEqual(['foreign_key_check']);
    db.close();
  });

  it('survives a broken db handle instead of bricking boot', () => {
    const db = open();
    db.close();
    const seen: string[] = [];
    expect(
      runIntegrityChecks({
        dbs: [{ label: 'social', db }],
        stateFile,
        build: 'b1',
        onError: (label) => seen.push(label),
      }),
    ).toEqual([]);
    expect(seen).toEqual(['social']);
  });
});
