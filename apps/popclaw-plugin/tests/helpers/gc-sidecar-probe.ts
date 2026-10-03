/**
 * Child process for the GC half of "only SQLite may hold a descriptor on a live
 * database file". Run as:
 *
 *     node --expose-gc --import tsx tests/helpers/gc-sidecar-probe.ts <dir>
 *
 * `--expose-gc` is why this is a separate process: it must not be on for the
 * whole suite, and the thing under test is what V8's collector does to a handle
 * nobody references any more.
 *
 * An unreferenced better-sqlite3 handle is finalized by the GC, the finalizer
 * closes the connection, and closing the LAST connection makes SQLite
 * checkpoint and unlink `-wal`/`-shm` — inside a process that is still running,
 * with no second process involved at all. `raw` is that control. `wrapped` is
 * the same shape through LocalHostDb, which keeps every open connection in a
 * process-wide registry precisely so the collector can never reach it.
 *
 * Prints one JSON line: {"raw": <sidecars still there>, "wrapped": <same>}.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LocalHostDb } from '../../src/host/local-host-db.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (path: string) => {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { run(...args: unknown[]): unknown };
};

const directory = process.argv[2]!;
const raw = join(directory, 'raw.db');
const wrapped = join(directory, 'wrapped.db');

// Both handles go out of scope at the end of their block, referenced by nothing.
(() => {
  const db = new Database(raw);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE probe(a)');
  db.prepare('INSERT INTO probe VALUES(1)').run();
})();
(() => {
  const db = new LocalHostDb(wrapped);
  db.execute('CREATE TABLE probe(a)');
  db.execute('INSERT INTO probe VALUES(1)');
})();

const collect = (globalThis as { gc?: () => void }).gc;
if (!collect) throw new Error('run this with --expose-gc');

// Poll rather than guess: finalization is not synchronous with gc(), and the
// control has to be given every chance to fire or it proves nothing.
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && existsSync(`${raw}-wal`)) {
  collect();
  await new Promise(resolve => setTimeout(resolve, 100));
}
process.stdout.write(JSON.stringify({
  raw: existsSync(`${raw}-wal`),
  wrapped: existsSync(`${wrapped}-wal`),
}) + '\n');
