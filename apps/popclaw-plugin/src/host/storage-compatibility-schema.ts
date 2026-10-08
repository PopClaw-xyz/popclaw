/** Structural admission uses SQLite's interpretation of the actual migration
 * SQL, never a second hand-maintained column or constraint registry. */
import type { HostDb } from './host-db.js';
import { LocalHostDb } from './local-host-db.js';
import { replayAppliedMigrationSchema } from './migrations.js';
import { quoteSqlIdentifier, ensureStorageRestoreSchema } from './storage-backup.js';
import { ensureStorageControlSchema, ensureStorageParticipantsSchema } from './storage-maintenance.js';
import { ensureSentinelTable } from './sentinels.js';
import { ensureHouseLifecycleSchema } from '../runtime/house-lifecycle/participation-store.js';
import { ensureInstallationIdSchema } from '../runtime/house-lifecycle/installation.js';
import { ensureOwnerLeaseSchema, ensureHouseCommandSchema, ensureWorldConversationInboxSchema,
  ensureHouseRecoverySchema, ensureWorldCapabilitySchema } from './runtime-storage-schema.js';

function tableNames(db: HostDb): string[] {
  return db.queryAll<{name: string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row => row.name);
}

function structure(db: HostDb, table: string): unknown {
  const name = quoteSqlIdentifier(table);
  const indices = db.queryAll<{name: string; unique: number; origin: string; partial: number}>(`PRAGMA index_list(${name})`)
    .map(({name, unique, origin, partial}) => ({
      name, unique, origin, partial,
      sql: db.queryOne<{sql: string | null}>('SELECT sql FROM sqlite_master WHERE type=\'index\' AND name=?', [name])?.sql,
      columns: db.queryAll(`PRAGMA index_xinfo(${quoteSqlIdentifier(name)})`),
    })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    // Includes CHECK expressions, collations, generated expressions and FTS
    // options which column names and index existence alone cannot certify.
    sql: db.queryOne<{sql: string}>('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?', [table])?.sql,
    columns: db.queryAll(`PRAGMA table_xinfo(${name})`),
    foreignKeys: db.queryAll(`PRAGMA foreign_key_list(${name})`),
    indices,
  };
}

/** The only writes here target :memory:. The inspected root stays read-only. */
export function verifyAppliedGlobalSchema(db: HostDb, migrationsDir: string, applied: readonly string[]): Set<string> {
  const expected = new LocalHostDb(':memory:');
  try {
    replayAppliedMigrationSchema(expected, migrationsDir, applied);
    const required = new Set(tableNames(expected)), present = new Set(tableNames(db));
    if ([...required].some(name => !present.has(name))) throw new Error('STORAGE_MIGRATED_TABLE_MISSING');
    for (const name of required) {
      if (JSON.stringify(structure(db, name)) !== JSON.stringify(structure(expected, name))) throw new Error('STORAGE_GLOBAL_SCHEMA_MISMATCH');
    }
    // Runtime-created tables may be absent or partially initialized. Derive
    // their authority from the same schema-only functions used by production,
    // and validate each present table without registering participants, minting
    // installation IDs, creating lifecycle services or touching the data root.
    ensureSentinelTable(expected);
    ensureHouseLifecycleSchema(expected);
    ensureInstallationIdSchema(expected);
    ensureOwnerLeaseSchema(expected);
    ensureHouseCommandSchema(expected);
    ensureWorldConversationInboxSchema(expected);
    ensureHouseRecoverySchema(expected);
    ensureWorldCapabilitySchema(expected);
    ensureStorageControlSchema(expected);
    ensureStorageParticipantsSchema(expected);
    ensureStorageRestoreSchema(expected);
    const allowed = new Set(tableNames(expected));
    for (const name of allowed) {
      if (!required.has(name) && present.has(name)
        && JSON.stringify(structure(db, name)) !== JSON.stringify(structure(expected, name))) throw new Error('STORAGE_GLOBAL_SCHEMA_MISMATCH');
    }
    return allowed;
  } finally { expected.close(); }
}
