import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { ensureSentinelReadmes } from '../../../src/host/sentinels.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';

const MARKER = "STOP. This database is the owner's social assets";

function sentinelSql(db: LocalHostDb): string | null {
  const row = db.queryOne<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='_READ_THIS_FIRST'",
  );
  return row?.sql ?? null;
}

describe('_READ_THIS_FIRST sentinel table', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'popclaw-sentinel-'));
    dbPath = join(tmpDir, 'test.db');
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('is created on open with the warning preserved in the stored DDL', () => {
    const db = new LocalHostDb(dbPath);
    expect(sentinelSql(db)).toContain(MARKER);
    expect(sentinelSql(db)).toContain('popclaw_*');
    db.close();
  });

  it('is idempotent across reopens (warning still there, exactly one table)', () => {
    new LocalHostDb(dbPath).close();
    const db = new LocalHostDb(dbPath);
    expect(sentinelSql(db)).toContain(MARKER);
    expect(
      db.queryAll("SELECT name FROM sqlite_master WHERE name='_READ_THIS_FIRST'"),
    ).toHaveLength(1);
    db.close();
  });

  it('drops and recreates a same-named table whose DDL lost the warning', () => {
    const seed = new LocalHostDb(dbPath);
    seed.execute('DROP TABLE _READ_THIS_FIRST');
    seed.execute('CREATE TABLE _READ_THIS_FIRST (x INTEGER)'); // no comments = silent wall
    expect(sentinelSql(seed)).not.toContain(MARKER);
    seed.close();

    const db = new LocalHostDb(dbPath);
    expect(sentinelSql(db)).toContain(MARKER);
    db.close();
  });
});

describe('sentinel READMEs', () => {
  let root: string;
  let paths: PopclawPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'popclaw-readme-'));
    paths = new PopclawPaths(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates one in the root, data/ and vault/', () => {
    ensureSentinelReadmes(paths);
    for (const dir of [root, paths.data(), paths.vault()]) {
      expect(readFileSync(join(dir, 'README-DO-NOT-TOUCH.md'), 'utf-8')).toContain('PopClaw');
    }
  });

  it('never overwrites an existing file (the owner may have edited it)', () => {
    ensureSentinelReadmes(paths);
    const file = join(root, 'README-DO-NOT-TOUCH.md');
    writeFileSync(file, 'owner edited', 'utf-8');
    ensureSentinelReadmes(paths);
    expect(readFileSync(file, 'utf-8')).toBe('owner edited');
  });
});
