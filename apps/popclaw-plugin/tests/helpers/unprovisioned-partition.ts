import { randomBytes } from 'node:crypto';
import type { HostDb } from '../../src/host/host-db.js';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import type { PopclawPaths } from '../../src/host/popclaw-paths.js';
import type { ExecutionPartition, ExecutionStoreCatalog } from '../../src/host/execution-store.js';
import { EXECUTION_LAYOUT_VERSION } from '../../src/host/execution-store-schema.js';
import { normalizeHouseOrigin } from '../../src/runtime/house-lifecycle/control-client.js';

/**
 * The partition every install carried before the fresh factory existed: a
 * PUBLISHED catalog row whose reservation is empty and whose file holds
 * nothing but its identity.
 *
 * The factory must never read that state as permission to build — eligibility
 * comes from a controlled creation, not from observing `required_tables='[]'`
 * afterwards — so the offline preparation tests construct it explicitly
 * instead of getting it from `catalog.open`.
 */
export function openUnprovisionedPartition(input: {
  catalog: ExecutionStoreCatalog; db: HostDb; paths: PopclawPaths; actorId: string; origin: string;
}): ExecutionPartition {
  const origin = normalizeHouseOrigin(input.origin), storeId = randomBytes(16).toString('hex');
  const target = new LocalHostDb(input.paths.executionDb(storeId));
  try {
    target.execute(`CREATE TABLE execution_partition_identity_v1 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), actor_id TEXT NOT NULL,
      origin TEXT NOT NULL, store_id TEXT NOT NULL, layout_version INTEGER NOT NULL)`);
    target.execute('INSERT INTO execution_partition_identity_v1 VALUES(1,?,?,?,?)', [input.actorId, origin, storeId, EXECUTION_LAYOUT_VERSION]);
  } finally { target.close(); }
  input.db.execute('INSERT INTO execution_store_catalog_v1(origin,actor_id,store_id,layout_version) VALUES(?,?,?,?)',
    [origin, input.actorId, storeId, EXECUTION_LAYOUT_VERSION]);
  return input.catalog.open(origin);
}
