import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostDb } from './host-db.js';

/**
 * Apply all .sql files in `migrationsDir` (sorted by filename) that have
 * not yet been recorded in `_migrations`. Idempotent. Designed for
 * monotonically-growing schemas; no down migrations.
 *
 * File naming convention: NNN-description.sql (e.g., 001-notification-queue.sql).
 * Bookkeeping table:
 *   CREATE TABLE _migrations (
 *     filename   TEXT PRIMARY KEY,
 *     applied_at INTEGER NOT NULL
 *   );
 *
 * Each migration is applied inside a transaction. If the SQL throws, the
 * whole migration rolls back AND the runner propagates the error so the
 * plugin fails to boot rather than running with a partial schema.
 *
 * Multi-statement support: a single .sql file may contain multiple
 * statements separated by `;` (e.g., CREATE TABLE + CREATE INDEX).
 * Statements are split + executed in order within one transaction.
 * Comment lines starting with `--` are stripped. `;` inside string
 * literals would break naive split — DDL migrations don't have these.
 */
export function runMigrations(db: HostDb, migrationsDir: string): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const all = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db.queryAll<{ filename: string }>('SELECT filename FROM _migrations').map((r) => r.filename),
  );

  for (const filename of all) {
    if (applied.has(filename)) continue;
    const sql = readFileSync(join(migrationsDir, filename), 'utf-8');
    const statements = splitStatements(sql);
    db.transaction((tx) => {
      if (tx.queryOne('SELECT filename FROM _migrations WHERE filename = ?', [filename])) return;
      for (const stmt of statements) {
        tx.execute(stmt);
      }
      tx.execute(
        'INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)',
        [filename, Math.floor(Date.now() / 1000)],
      );
    });
  }
}

/**
 * Split a .sql file into individual statements.
 * - Strips lines starting with `--` (full-line comments)
 * - Splits on `;`
 * - Trims and filters empty
 *
 * Naive — does not handle `;` inside string literals. Sufficient for
 * DDL migrations which don't have such cases.
 */
function splitStatements(sql: string): string[] {
  const stripped = sql
    .split('\n')
    .map((line) => (line.trim().startsWith('--') ? '' : line))
    .join('\n');
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
