/** Phase 1 v1 allowlist. Unknown tables remain protected. */
import type { HostDb } from './host-db.js';
export const EXECUTION_LAYOUT_VERSION = 1;
export const CACHE_TABLES = ['world_feed', 'world_feed_cursor'] as const;
export const PUBLIC_JOURNAL_TABLES = [
  'world_public_bindings_v1',
  'world_public_cursors_v1',
  'world_public_events_v1',
  'world_public_frames_v1',
  'world_public_associations_v1',
  'world_public_consumers_v1',
  'world_public_imports_v1',
  'world_public_log_profiles_v1',
] as const;
/** The evidence name durably selects the complete action-receipts-v1 profile. */
export const ACTION_RECEIPT_FEATURE_TABLES = [
  'world_action_client_requests', 'world_action_client_results', 'world_action_client_progress',
  'world_action_client_evidence', 'world_owner_action_reservations',
] as const;
/** Independent extension; never changes the original five-table fingerprint. */
export const NATIVE_ACTION_FEATURE_TABLES = ['world_native_action_reservations'] as const;
export const DURABLE_TABLES = [
  ...NATIVE_ACTION_FEATURE_TABLES,
  ...PUBLIC_JOURNAL_TABLES,
  "world_stream",
  "world_stream_cursor",
  "world_scoped_bindings",
  "world_scoped_descriptors",
  "world_scoped_initial_scopes",
  "world_scoped_cursors",
  "world_scoped_events",
  "world_scoped_log_events",
  "world_scoped_event_scopes",
  "world_scoped_gaps",
  "world_policy_registry",
  "world_participation_policy",
  "world_action_client_requests",
  "world_action_client_results",
  "world_action_client_progress",
  "world_action_client_evidence",
  "world_readiness_invalidations",
  "world_readiness",
  "world_readiness_snapshots",
  "world_readiness_refreshes",
  "world_read_state_grants",
  "world_read_state_reservations",
  "world_owner_action_reservations",
  "world_private_messages_v2",
  "world_private_states_v2",
  "world_private_delivery_sources",
  "host_world_turns_v1",
  "host_world_turn_audit_v1",
  "world_turn_coordinator_jobs",
  "world_turn_coordinator_attempts",
  "world_turn_coordinator_schedule",
  "world_direct_dm_attempts"
] as const;
export function inspectLegacySchema(db: HostDb): { durable: string[]; cache: string[] } {
  const tables = db.queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row => row.name);
  const known = new Set<string>([...CACHE_TABLES, ...DURABLE_TABLES, '_READ_THIS_FIRST']);
  const unknown = tables.filter(name => !known.has(name));
  if (unknown.length) throw new Error(`EXECUTION_SCHEMA_UNKNOWN: ${unknown.join(', ')}`);
  return {
    durable: tables.filter(name => (DURABLE_TABLES as readonly string[]).includes(name)),
    cache: tables.filter(name => (CACHE_TABLES as readonly string[]).includes(name)),
  };
}
