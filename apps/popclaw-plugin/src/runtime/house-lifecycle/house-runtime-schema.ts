import type { HostDb } from '../../host/host-db.js';

/** Schema-only authorities; callers retain the existing creation timing. */
export function ensureHouseOriginBindingsSchema(db: HostDb): void {
  db.execute('CREATE TABLE IF NOT EXISTS house_origin_bindings (slug TEXT PRIMARY KEY, origin TEXT NOT NULL UNIQUE)');
}
export function ensureHouseRecoveryCursorEvidenceSchema(db: HostDb): void {
  db.execute('CREATE TABLE IF NOT EXISTS house_recovery_cursor_evidence_v1 (decision_id TEXT NOT NULL, store_lane TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(decision_id,store_lane))');
}
