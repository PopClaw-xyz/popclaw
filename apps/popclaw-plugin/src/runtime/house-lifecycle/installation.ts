/**
 * ADR-0051 — the per-(identity, data-root) installation id.
 *
 * ONE id for every entry root (CLI / OpenClaw plugin / MCP) on the same data
 * root — the server's per-installation watermarks key on it. Minted once,
 * transactionally, insert-if-absent; concurrent first callers all read back
 * the SAME winning value (the loser's candidate is discarded, never
 * returned). The id does not vary by which root is asking.
 */

import type { HostDb } from '../../host/host-db.js';

export function ensureInstallationIdSchema(db: HostDb): void {
  db.execute(
    'CREATE TABLE IF NOT EXISTS house_lifecycle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
}

/**
 * Resolve (minting on first call) the installation id. Schema FIRST (a fresh
 * root has no table yet — reading before CREATE was the draft bug), then a
 * transactional insert-if-absent, then READ BACK the winning row — the
 * concurrent loser returns the winner's value, not its own candidate.
 */
export function resolveInstallationId(db: HostDb, mintId: () => string = (): string => crypto.randomUUID()): string {
  ensureInstallationIdSchema(db);
  return db.transaction((tx) => {
    const candidate = mintId();
    tx.execute(
      'INSERT OR IGNORE INTO house_lifecycle_meta (key, value) VALUES (?, ?)',
      ['installation_id', candidate],
    );
    // ALWAYS read back: on a race the INSERT ignored our candidate and this
    // SELECT returns the winner's — which every caller must use.
    const row = tx.queryOne<{ value: string }>(
      'SELECT value FROM house_lifecycle_meta WHERE key = ?',
      ['installation_id'],
    );
    if (!row?.value) throw new Error('installation_id mint failed');
    return row.value;
  });
}
