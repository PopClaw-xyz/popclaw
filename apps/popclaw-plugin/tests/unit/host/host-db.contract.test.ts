import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostDb } from '../../../src/host/host-db.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';

interface Row { id: number; name: string }

function runContract(name: string, makeDb: () => HostDb) {
  describe(`HostDb contract — ${name}`, () => {
    let db: HostDb;

    beforeEach(() => {
      db = makeDb();
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    });

    afterEach(() => { db.close(); });

    it('execute returns changes + lastInsertRowid', () => {
      const r = db.execute('INSERT INTO t (name) VALUES (?)', ['alice']);
      expect(r.changes).toBe(1);
      expect(Number(r.lastInsertRowid)).toBe(1);
    });

    it('queryOne returns first row or null', () => {
      db.execute('INSERT INTO t (name) VALUES (?), (?)', ['a', 'b']);
      const row = db.queryOne<Row>('SELECT id, name FROM t WHERE name = ?', ['a']);
      expect(row).toEqual({ id: 1, name: 'a' });
      const none = db.queryOne<Row>('SELECT id, name FROM t WHERE name = ?', ['zzz']);
      expect(none).toBeNull();
    });

    it('queryAll returns all matching rows in order', () => {
      db.execute('INSERT INTO t (name) VALUES (?), (?), (?)', ['a', 'b', 'c']);
      const rows = db.queryAll<Row>('SELECT id, name FROM t ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 3, name: 'c' },
      ]);
    });

    it('transaction commits on success', () => {
      db.transaction((tx) => {
        tx.execute('INSERT INTO t (name) VALUES (?)', ['committed']);
      });
      const row = db.queryOne<Row>('SELECT name FROM t WHERE name = ?', ['committed']);
      expect(row?.name).toBe('committed');
    });

    it('transaction rolls back on throw', () => {
      expect(() => {
        db.transaction((tx) => {
          tx.execute('INSERT INTO t (name) VALUES (?)', ['rollback']);
          throw new Error('intentional');
        });
      }).toThrow('intentional');
      const row = db.queryOne<Row>('SELECT name FROM t WHERE name = ?', ['rollback']);
      expect(row).toBeNull();
    });

    it('close is idempotent', () => {
      db.close();
      expect(() => db.close()).not.toThrow();
    });
  });
}

runContract('InMemoryHostDb', () => new InMemoryHostDb());

let localTmpDir: string | null = null;
runContract('LocalHostDb', () => {
  localTmpDir = mkdtempSync(join(tmpdir(), 'popclaw-contract-'));
  return new LocalHostDb(join(localTmpDir, 'contract.db'));
});
// Vitest doesn't expose suite-end hooks cleanly here; rely on OS-level
// /tmp cleanup. The temp dirs are negligible.
