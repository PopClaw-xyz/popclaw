import Database, { type Database as DatabaseType } from 'better-sqlite3';
import type { HostDb, Params } from './host-db.js';

/**
 * In-memory SQLite via better-sqlite3 (:memory: handle).
 *
 * Used for tests so they exercise the same SQL surface that LocalHostDb
 * runs in production. NOT a fake KV substitute.
 */
export class InMemoryHostDb implements HostDb {
  private readonly handle: DatabaseType;
  private closed = false;

  constructor() {
    this.handle = new Database(':memory:');
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: Params = []): T | null {
    const stmt = this.handle.prepare(sql);
    const row = stmt.get(...(params as unknown[]));
    return (row as T | undefined) ?? null;
  }

  queryAll<T = Record<string, unknown>>(sql: string, params: Params = []): T[] {
    const stmt = this.handle.prepare(sql);
    return stmt.all(...(params as unknown[])) as T[];
  }

  execute(sql: string, params: Params = []): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.handle.prepare(sql);
    const info = stmt.run(...(params as unknown[]));
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  transaction<T>(fn: (tx: HostDb) => T): T {
    const txFn = this.handle.transaction((arg: HostDb) => fn(arg));
    return txFn(this);
  }

  close(): void {
    if (this.closed) return;
    this.handle.close();
    this.closed = true;
  }
}
