import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb, isNativeLoadError, STATEMENT_CACHE_CAPACITY } from '../../../src/host/local-host-db.js';

describe('isNativeLoadError (native rebuild gate — bug host-c 派发链 ①)', () => {
  it('flags wrong-platform / wrong-arch / wrong-ABI native loads → rebuild', () => {
    for (const m of [
      '/x/better_sqlite3-node22.node: invalid ELF header',
      'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version requires 137.',
      'dlopen(...): wrong ELF class: ELFCLASS64',
      'incompatible architecture (have arm64, need x86_64)',
      'mach-o, but wrong architecture',
      'Module did not self-register',
      'undefined symbol: node_module_register',
    ]) {
      expect(isNativeLoadError(new Error(m))).toBe(true);
    }
  });

  it('does NOT flag ordinary SQLite open errors → no pointless rebuild', () => {
    for (const m of [
      'SQLITE_CANTOPEN: unable to open database file',
      'database disk image is malformed',
      'attempt to write a readonly database',
      'no such table: bonds',
    ]) {
      expect(isNativeLoadError(new Error(m))).toBe(false);
    }
  });
});

describe('LocalHostDb (temp file)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'popclaw-localdb-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists data across handle close + reopen', () => {
    const db1 = new LocalHostDb(dbPath);
    db1.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db1.execute('INSERT INTO t (name) VALUES (?)', ['persisted']);
    db1.close();

    const db2 = new LocalHostDb(dbPath);
    const row = db2.queryOne<{ name: string }>('SELECT name FROM t WHERE id = 1');
    expect(row?.name).toBe('persisted');
    db2.close();
  });

  it('creates parent directory if missing', () => {
    const nested = join(tmpDir, 'sub', 'dir', 'nested.db');
    const db = new LocalHostDb(nested);
    db.execute('CREATE TABLE x (a INTEGER)');
    db.close();
    // No throw = pass.
  });
});

describe('LocalHostDb statement cache (per connection, statements only)', () => {
  let tmpDir: string;
  let dbPath: string;
  const open: LocalHostDb[] = [];
  const db = () => { const d = new LocalHostDb(dbPath); open.push(d); return d; };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'popclaw-stmtcache-'));
    dbPath = join(tmpDir, 'cache.db');
  });

  afterEach(() => {
    for (const d of open.splice(0)) d.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compiles a statement once and re-runs it with fresh parameters and results', () => {
    const d = db();
    d.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const base = d.statementCacheStats();
    d.execute('INSERT INTO t (v) VALUES (?)', ['a']);
    d.execute('INSERT INTO t (v) VALUES (?)', ['b']);
    expect(d.queryOne<{ v: string }>('SELECT v FROM t WHERE id = ?', [1])?.v).toBe('a');
    expect(d.queryOne<{ v: string }>('SELECT v FROM t WHERE id = ?', [2])?.v).toBe('b');
    expect(d.queryOne('SELECT v FROM t WHERE id = ?', [3])).toBeNull();
    const after = d.statementCacheStats();
    expect(after.misses - base.misses).toBe(2);
    expect(after.hits - base.hits).toBe(3);
  });

  it('is bounded: least recently used entries are evicted at capacity', () => {
    const d = db();
    d.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const hot = 'SELECT count(*) AS n FROM t';
    d.queryOne(hot);
    for (let i = 0; i < STATEMENT_CACHE_CAPACITY + 10; i++) {
      d.queryOne(`SELECT ${i} AS n FROM t`);
      if (i % 8 === 0) d.queryOne(hot); // keep the hot statement recently used
    }
    expect(d.statementCacheStats().size).toBe(STATEMENT_CACHE_CAPACITY);
    const s0 = d.statementCacheStats();
    d.queryOne(hot);
    expect(d.statementCacheStats().hits).toBe(s0.hits + 1);
    d.queryOne('SELECT 0 AS n FROM t'); // the oldest entry was evicted
    expect(d.statementCacheStats().misses).toBe(s0.misses + 1);
  });

  it('generated NOT IN (?,…) variants cannot grow the cache past its bound', () => {
    const d = db();
    d.execute('CREATE TABLE c (origin TEXT)');
    for (let n = 1; n <= 200; n++) {
      const ps = Array.from({ length: n }, (_, i) => `o${i}`);
      d.queryAll(`SELECT * FROM c WHERE origin NOT IN (${ps.map(() => '?').join(',')})`, ps);
    }
    expect(d.statementCacheStats().size).toBeLessThanOrEqual(STATEMENT_CACHE_CAPACITY);
  });

  it('close() drops the cache, and a closed connection still refuses queries', () => {
    const d = new LocalHostDb(dbPath);
    d.execute('CREATE TABLE t (id INTEGER)');
    d.queryAll('SELECT * FROM t');
    expect(d.statementCacheStats().size).toBeGreaterThan(0);
    d.close();
    expect(d.statementCacheStats().size).toBe(0);
    expect(() => d.queryAll('SELECT * FROM t')).toThrow();
  });

  it('never shares statements across connections, and each sees the other\'s writes', () => {
    const a = db(), b = db();
    a.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const sql = 'SELECT v FROM t ORDER BY id';
    const a0 = a.statementCacheStats(), b0 = b.statementCacheStats();
    expect(b.queryAll(sql)).toEqual([]);
    a.execute('INSERT INTO t (v) VALUES (?)', ['x']);
    expect(b.queryAll(sql)).toEqual([{ v: 'x' }]);
    // b's second read hit its own cache; a still has to compile its own copy.
    expect(b.statementCacheStats()).toMatchObject({ hits: b0.hits + 1, misses: b0.misses + 1 });
    expect(a.queryAll(sql)).toEqual([{ v: 'x' }]);
    expect(a.statementCacheStats()).toMatchObject({ hits: a0.hits, misses: a0.misses + 2 });
  });

  it('caches nothing when prepare throws, and a statement survives an execution error', () => {
    const d = db();
    d.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const s0 = d.statementCacheStats();
    expect(() => d.queryAll('SELEC * FROM t')).toThrow();
    expect(() => d.queryAll('SELECT * FROM missing_table')).toThrow(/no such table/);
    expect(d.statementCacheStats()).toEqual(s0);
    const ins = 'INSERT INTO t (id) VALUES (?)';
    d.execute(ins, [1]);
    expect(() => d.execute(ins, [1])).toThrow(/UNIQUE/);
    expect(d.execute(ins, [2]).changes).toBe(1);
    expect(d.queryAll<{ id: number }>('SELECT id FROM t ORDER BY id').map(r => r.id)).toEqual([1, 2]);
  });

  it('a cached SELECT * returns a column added later (same connection and another connection)', () => {
    const a = db(), b = db();
    a.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    a.execute('INSERT INTO t (id) VALUES (1)');
    const sql = 'SELECT * FROM t WHERE id = 1';
    expect(a.queryOne(sql)).toEqual({ id: 1 });
    a.execute("ALTER TABLE t ADD COLUMN x TEXT DEFAULT 'same'");
    const hits = a.statementCacheStats().hits;
    expect(a.queryOne(sql)).toEqual({ id: 1, x: 'same' });
    expect(a.statementCacheStats().hits).toBe(hits + 1); // served by the cached statement
    b.execute("ALTER TABLE t ADD COLUMN y TEXT DEFAULT 'other'");
    expect(a.queryOne(sql)).toEqual({ id: 1, x: 'same', y: 'other' });
    expect(a.statementCacheStats().hits).toBe(hits + 2);
  });

  it('a cached statement follows a DROP and re-CREATE of its table', () => {
    const a = db(), b = db();
    a.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    a.execute("INSERT INTO t (v) VALUES ('old')");
    const sql = 'SELECT * FROM t';
    expect(a.queryAll(sql)).toEqual([{ id: 1, v: 'old' }]);
    b.execute('DROP TABLE t');
    expect(() => a.queryAll(sql)).toThrow(/no such table/);
    b.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, w INTEGER, v TEXT)');
    b.execute("INSERT INTO t (w, v) VALUES (7, 'new')");
    const hits = a.statementCacheStats().hits;
    expect(a.queryAll(sql)).toEqual([{ id: 1, w: 7, v: 'new' }]);
    expect(a.statementCacheStats().hits).toBe(hits + 1);
  });

  it('a cached single-row read leaves no read transaction open', () => {
    const a = db(), b = db();
    a.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    for (let i = 0; i < 50; i++) a.execute('INSERT INTO t (id) VALUES (?)', [i]);
    a.queryOne('SELECT id FROM t ORDER BY id'); // reads 1 of 50 rows
    a.queryOne('SELECT id FROM t ORDER BY id');
    b.execute('INSERT INTO t (id) VALUES (1000)');
    const ck = b.queryOne<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(ck?.busy).toBe(0);
  });
});
