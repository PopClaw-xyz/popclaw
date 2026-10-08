import type { HostDb } from './host-db.js';

/** Schema only: no actor binding, feature marker or store selection is written. */
export function ensureExecutionStoreIdentitySchema(db: HostDb): void {
  db.execute(`CREATE TABLE IF NOT EXISTS execution_store_identity_v1 (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), actor_id TEXT NOT NULL, layout_version INTEGER NOT NULL)`);
}
export function ensureExecutionStoreCatalogSchema(db: HostDb): void {
  db.execute(`CREATE TABLE IF NOT EXISTS execution_store_catalog_v1 (
        origin TEXT PRIMARY KEY, actor_id TEXT NOT NULL, store_id TEXT NOT NULL UNIQUE,
        layout_version INTEGER NOT NULL, source_path TEXT, source_fingerprint TEXT, required_tables TEXT NOT NULL DEFAULT '[]')`);
}

/** The marker column is historically absent; adding it carries no certification. */
export function addPrivateMessageFeatureColumn(tx: HostDb): void {
  if (!tx.queryAll<{name: string}>('PRAGMA table_info(execution_store_catalog_v1)').some(column => column.name === 'private_message_feature'))
    tx.execute('ALTER TABLE execution_store_catalog_v1 ADD COLUMN private_message_feature TEXT');
}
