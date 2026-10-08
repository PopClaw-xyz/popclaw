import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';

describe('runMigrations', () => {
  let tmpDir: string;
  let migDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'popclaw-mig-'));
    migDir = join(tmpDir, 'migrations');
    mkdirSync(migDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies a single migration', () => {
    writeFileSync(join(migDir, '001-create-foo.sql'), 'CREATE TABLE foo (a INTEGER);');
    const db = new InMemoryHostDb();
    runMigrations(db, migDir);
    const row = db.queryOne('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'foo\'');
    expect(row).not.toBeNull();
    db.close();
  });

  it('applies migrations in filename order', () => {
    writeFileSync(join(migDir, '001-a.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(migDir, '002-b.sql'), 'CREATE TABLE b (y INTEGER);');
    writeFileSync(join(migDir, '003-c.sql'), 'CREATE TABLE c (z INTEGER);');
    const db = new InMemoryHostDb();
    runMigrations(db, migDir);
    const tables = db.queryAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b','c') ORDER BY name"
    );
    expect(tables.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    db.close();
  });

  it('is idempotent — second run is no-op', () => {
    writeFileSync(join(migDir, '001-create.sql'), 'CREATE TABLE once (a INTEGER);');
    const db = new InMemoryHostDb();
    runMigrations(db, migDir);
    // Re-run: must not throw "table already exists".
    expect(() => runMigrations(db, migDir)).not.toThrow();
    const applied = db.queryAll<{ filename: string }>('SELECT filename FROM _migrations ORDER BY filename');
    expect(applied.map((a) => a.filename)).toEqual(['001-create.sql']);
    db.close();
  });

  it('rejects unknown applied migrations before any remaining schema write', () => {
    writeFileSync(join(migDir, '001-new.sql'), 'CREATE TABLE must_not_exist (value INTEGER);');
    const db = new InMemoryHostDb();
    db.execute('CREATE TABLE _migrations(filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.execute("INSERT INTO _migrations VALUES('999-future.sql',1)");
    const before = db.queryAll('SELECT name,sql FROM sqlite_master ORDER BY name');
    expect(() => runMigrations(db, migDir)).toThrow('STORAGE_MIGRATION_UNSUPPORTED');
    expect(db.queryAll('SELECT name,sql FROM sqlite_master ORDER BY name')).toEqual(before);
    expect(db.queryAll('SELECT filename FROM _migrations')).toEqual([{filename: '999-future.sql'}]);
    db.close();
  });

  it('skips non-.sql files', () => {
    writeFileSync(join(migDir, '001-real.sql'), 'CREATE TABLE real (a INTEGER);');
    writeFileSync(join(migDir, 'README.md'), '# notes');
    writeFileSync(join(migDir, '.DS_Store'), 'mac noise');
    const db = new InMemoryHostDb();
    expect(() => runMigrations(db, migDir)).not.toThrow();
    const applied = db.queryAll<{ filename: string }>('SELECT filename FROM _migrations');
    expect(applied).toHaveLength(1);
    db.close();
  });

  it('throws if a migration .sql contains invalid SQL', () => {
    writeFileSync(join(migDir, '001-bad.sql'), 'CREATE TABEL typo (a);');
    const db = new InMemoryHostDb();
    expect(() => runMigrations(db, migDir)).toThrow();
    db.close();
  });

  it('applies multi-statement .sql files (e.g., CREATE TABLE + CREATE INDEX)', () => {
    writeFileSync(
      join(migDir, '001-multi.sql'),
      'CREATE TABLE multi (a INTEGER, b TEXT);\nCREATE INDEX idx_multi_b ON multi(b);',
    );
    const db = new InMemoryHostDb();
    runMigrations(db, migDir);
    const table = db.queryOne(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='multi'",
    );
    const index = db.queryOne(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_multi_b'",
    );
    expect(table).not.toBeNull();
    expect(index).not.toBeNull();
    db.close();
  });

  it('strips full-line SQL comments (lines starting with --)', () => {
    writeFileSync(
      join(migDir, '001-with-comments.sql'),
      '-- This is a comment\nCREATE TABLE commented (a INTEGER);\n-- Trailing comment',
    );
    const db = new InMemoryHostDb();
    expect(() => runMigrations(db, migDir)).not.toThrow();
    const row = db.queryOne(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='commented'",
    );
    expect(row).not.toBeNull();
    db.close();
  });

  /**
   * The real set, applied the way an upgrade applies it: everything up to the
   * new migration, then rows, then the new migration. A forward-only schema
   * that only ever runs against an empty database is untested where it
   * matters, and `ALTER TABLE ... ADD COLUMN` is exactly the statement whose
   * failure mode is "fine on a fresh install, fatal on a real one".
   */
  it('adds the quarantine position to a database that already has refusals', () => {
    const real = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
    const NEW = '041-quarantine-transport-position.sql';
    for (const f of readdirSync(real)) {
      if (f.endsWith('.sql') && f !== NEW) copyFileSync(join(real, f), join(migDir, f));
    }
    const db = new InMemoryHostDb();
    runMigrations(db, migDir);
    db.execute(
      `INSERT INTO inbound_quarantine
         (claimed_event_id, bytes_sha256, house_key, incarnation, owner_generation,
          stream, reason, envelope, received_at)
       VALUES ('claimed', 'digest', 'HouseA', 'inc-1', 1, 'world', 'NOT_PUBLIC', x'00', 10)`,
    );

    copyFileSync(join(real, NEW), join(migDir, NEW));
    expect(() => runMigrations(db, migDir)).not.toThrow();

    // The row survives, and says honestly that its position was never kept.
    expect(
      db.queryAll<{ reason: string; position: string | null }>(
        'SELECT reason, position FROM inbound_quarantine',
      ),
    ).toEqual([{ reason: 'NOT_PUBLIC', position: null }]);
    db.close();
  });

  /**
   * The same shape for the witnessed-follow column, and for the same reason.
   * The answer NULL is load-bearing here rather than merely tidy: an existing
   * row is one this build never saw arrive, so it keeps waiting for its
   * house's baseline exactly as it does today.
   */
  it('leaves existing followers unwitnessed when the witnessed column arrives', () => {
    const real = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
    const NEW = '043-follower-witnessed-follow.sql';
    for (const f of readdirSync(real)) {
      if (f.endsWith('.sql') && f !== NEW) copyFileSync(join(real, f), join(migDir, f));
    }
    const db = new InMemoryHostDb();
    runMigrations(db, migDir);
    db.execute(
      'INSERT INTO known_followers (house_slug, follower_id, first_seen_at) VALUES (?, ?, ?)',
      ['house-a', 'alice', 900],
    );

    copyFileSync(join(real, NEW), join(migDir, NEW));
    expect(() => runMigrations(db, migDir)).not.toThrow();

    expect(
      db.queryAll<{ follower_id: string; verified_at: number | null }>(
        'SELECT follower_id, verified_at FROM known_followers',
      ),
    ).toEqual([{ follower_id: 'alice', verified_at: null }]);
    db.close();
  });
});
