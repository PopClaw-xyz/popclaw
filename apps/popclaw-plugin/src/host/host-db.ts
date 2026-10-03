/**
 * HostDb — the plugin's SQLite gateway.
 *
 * All persistent plugin state (per ADR-0013) flows through this interface.
 * Production impl wraps better-sqlite3 (apps/popclaw-plugin/src/host/local-host-db.ts).
 * Test impl uses better-sqlite3 against :memory: so tests exercise the same SQL.
 *
 * Business modules MUST NOT import better-sqlite3 directly — go through this.
 */

export type SqlParam = string | number | bigint | Uint8Array | null;
export type Params = ReadonlyArray<SqlParam>;

export interface HostDb {
  /** Parameterized query → first row or null. */
  queryOne<T = Record<string, unknown>>(sql: string, params?: Params): T | null;

  /** Parameterized query → all rows. */
  queryAll<T = Record<string, unknown>>(sql: string, params?: Params): T[];

  /** Write query → affected row count + lastInsertRowid. */
  execute(sql: string, params?: Params): { changes: number; lastInsertRowid: number | bigint };

  /** Atomic transaction. If fn throws, rollback. */
  transaction<T>(fn: (tx: HostDb) => T): T;

  /** Close handle. Idempotent. */
  close(): void;
}
