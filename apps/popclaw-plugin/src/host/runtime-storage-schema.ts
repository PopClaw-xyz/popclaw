/** Schema-only source shared by production initialization and read-only admission.
 * No service construction, runtime registration or business module imports. */
import type { HostDb } from './host-db.js';

export function ensureWorldCapabilitySchema(tx: HostDb): void {
  // Existing historical records and high-water marks are preserved in place.
  tx.execute(`CREATE TABLE IF NOT EXISTS world_kind_revisions (
    origin TEXT NOT NULL, direction TEXT NOT NULL, kind TEXT NOT NULL,
    version INTEGER NOT NULL, schema_digest TEXT NOT NULL, PRIMARY KEY(origin,direction,kind))`);
  tx.execute(`CREATE TABLE IF NOT EXISTS world_capability_views_v1 (
    origin TEXT NOT NULL, capability_revision TEXT NOT NULL, house_key TEXT NOT NULL, incarnation TEXT NOT NULL,
    manifest_bytes BLOB NOT NULL, proof_bytes BLOB NOT NULL, pin_provenance TEXT NOT NULL, guide_bytes BLOB,
    PRIMARY KEY(origin,capability_revision))`);
  // A restore may change only proof metadata, keeping identical manifest
  // bytes and digest. Preserve every incarnation's signed observation.
  tx.execute(`CREATE TABLE IF NOT EXISTS world_capability_recovery_views_v1 (
    origin TEXT NOT NULL, capability_revision TEXT NOT NULL, house_key TEXT NOT NULL, incarnation TEXT NOT NULL,
    manifest_bytes BLOB NOT NULL, proof_bytes BLOB NOT NULL, pin_provenance TEXT NOT NULL, guide_bytes BLOB,
    PRIMARY KEY(origin,house_key,incarnation,capability_revision))`);
  tx.execute(`CREATE TABLE IF NOT EXISTS world_capability_current_v1 (
    origin TEXT PRIMARY KEY, capability_revision TEXT NOT NULL, active INTEGER NOT NULL, detail TEXT NOT NULL,
    validation_json TEXT NOT NULL,
    FOREIGN KEY(origin,capability_revision) REFERENCES world_capability_views_v1(origin,capability_revision))`);
  tx.execute(`CREATE TABLE IF NOT EXISTS world_public_manifest_logs_v1 (
    origin TEXT NOT NULL, house_key TEXT NOT NULL, incarnation TEXT NOT NULL, log_incarnation TEXT NOT NULL,
    baseline_key TEXT NOT NULL, first_revision TEXT NOT NULL,
    retired INTEGER NOT NULL CHECK(retired IN (0,1)), conflicted INTEGER NOT NULL CHECK(conflicted IN (0,1)),
    retired_by_revision TEXT, conflict_revision TEXT,
    PRIMARY KEY(origin,house_key,incarnation,log_incarnation))`);
  tx.execute(`CREATE TABLE IF NOT EXISTS world_public_manifest_log_evidence_v1 (
    origin TEXT NOT NULL, house_key TEXT NOT NULL, incarnation TEXT NOT NULL, capability_revision TEXT NOT NULL,
    log_incarnation TEXT, baseline_key TEXT,
    CHECK((log_incarnation IS NULL AND baseline_key IS NULL) OR (log_incarnation IS NOT NULL AND baseline_key IS NOT NULL)),
    PRIMARY KEY(origin,house_key,incarnation,capability_revision))`);
}

export function ensureHouseCommandSchema(db: HostDb): void {
  db.execute(`CREATE TABLE IF NOT EXISTS house_lifecycle_commands (
      request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, house_origin TEXT NOT NULL,
      baseline_seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      running_epoch INTEGER, result_json TEXT, created_at INTEGER NOT NULL
    )`);
  db.transaction(tx => {
    const columns = new Set(tx.queryAll<{ name: string }>('PRAGMA table_info(house_lifecycle_commands)').map(c => c.name));
    for (const [name, type] of Object.entries({ payload_bytes: 'BLOB', effect_json: 'TEXT', session_id: 'TEXT', house_revision: 'INTEGER', ack_key_hex: 'TEXT', installation_id: 'TEXT', deadline_at: 'INTEGER' })) {
      if (!columns.has(name)) tx.execute(`ALTER TABLE house_lifecycle_commands ADD COLUMN ${name} ${type}`);
    }
  });
  db.execute('CREATE INDEX IF NOT EXISTS house_commands_pending ON house_lifecycle_commands(state, created_at)');
}

const OWNER_LEASE_SCHEMA =
  'CREATE TABLE IF NOT EXISTS house_lifecycle_owner (\n' +
  '  id INTEGER PRIMARY KEY CHECK (id = 1),\n' +
  '  generation INTEGER NOT NULL,\n' +
  '  holder TEXT NOT NULL,\n' +
  '  renewed_at INTEGER NOT NULL\n' +
  ')';

export function ensureOwnerLeaseSchema(db: HostDb): void {
  db.execute(OWNER_LEASE_SCHEMA);
}

export function ensureHouseRecoverySchema(db: HostDb): void {
  db.execute(`CREATE TABLE IF NOT EXISTS house_recovery_decisions_v1 (
      decision_id TEXT PRIMARY KEY, origin TEXT NOT NULL, decision_json TEXT NOT NULL, pin_json TEXT NOT NULL,
      participation_json TEXT NOT NULL, raw_bytes BLOB NOT NULL, proof_header TEXT NOT NULL,
      state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', approved_epoch INTEGER)`);
  db.execute(`CREATE TABLE IF NOT EXISTS house_recovery_command_evidence_v1 (
      decision_id TEXT NOT NULL, request_id TEXT NOT NULL, capture_json TEXT NOT NULL,
      PRIMARY KEY(decision_id,request_id))`);
  db.execute(`CREATE TABLE IF NOT EXISTS house_recovery_fences_v1 (
      origin TEXT PRIMARY KEY, decision_id TEXT NOT NULL, house_key TEXT NOT NULL, old_incarnation TEXT NOT NULL,
      new_incarnation TEXT NOT NULL, fence_seq INTEGER NOT NULL, state TEXT NOT NULL, completed_at INTEGER)`);
}

export function ensureWorldConversationInboxSchema(db: HostDb): void {
  db.execute(`CREATE TABLE IF NOT EXISTS world_conversation_inbox_v1 (
    binding TEXT PRIMARY KEY, inbox_id INTEGER NOT NULL REFERENCES inbox(id),
    metadata TEXT NOT NULL, original_text TEXT NOT NULL, envelope_bytes BLOB NOT NULL,
    received_at_ms INTEGER NOT NULL)`);
}
