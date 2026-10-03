import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { migrateExecutionStore } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession } from '../../../src/host/storage-maintenance.js';
import { tableFingerprint } from '../../../src/host/storage-backup.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'execution-migration-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const paths = new PopclawPaths(root);
  const db = new LocalHostDb(paths.socialDb());
  cleanup.push(() => db.close());
  const origin = 'https://legacy.example';
  db.execute('CREATE TABLE house_origin_bindings(slug TEXT PRIMARY KEY, origin TEXT UNIQUE)');
  db.execute('INSERT INTO house_origin_bindings VALUES(?,?)', [hostDbSlug(origin), origin]);
  const source = new LocalHostDb(paths.lorehouseDb(hostDbSlug(origin)));
  source.execute('CREATE TABLE world_stream(seq INTEGER PRIMARY KEY, envelope BLOB, task_done INTEGER)');
  source.execute('INSERT INTO world_stream VALUES(19,?,1)', [Uint8Array.of(0, 255, 128)]);
  source.execute('CREATE TABLE world_participation_policy(binding TEXT PRIMARY KEY, state TEXT)');
  source.execute('INSERT INTO world_participation_policy(rowid,binding,state) VALUES(37,?,?)', ['original-binding', '{"phase":"unknown","debit":7}']);
  source.execute('CREATE TABLE world_feed(raw BLOB)');
  source.execute('INSERT INTO world_feed(rowid,raw) VALUES(71,?)', [Uint8Array.of(255)]);
  const fingerprints = Object.fromEntries(['world_stream','world_participation_policy','world_feed'].map(table => [table, tableFingerprint(source, table)]));
  source.close();
  const catalog = new ExecutionStoreCatalog({db, paths, actorId: 'synthetic-actor'});
  cleanup.push(() => catalog.close());
  const maintenance = MaintenanceSession.begin(db, paths, 'migration test');
  return {db, paths, origin, catalog, maintenance, fingerprints};
}
describe('controlled execution partition cutover', () => {
  it.each(['after-backup', 'prepared', 'target-copied', 'target-verified', 'cache-copied', 'cache-verified', 'before-publish', 'after-publish'])('recovers a crash at %s without rewriting originals or unknown/consumed evidence', async stage => {
    const f = fixture();
    const options = {...f, installationId: null, codeVersion: 'test'};
    await expect(migrateExecutionStore({...options, failpoint: reached => {if (reached === stage) throw new Error('crash');}})).rejects.toThrow('crash');
    const afterCrash = f.db.queryOne<{store_id: string}>('SELECT store_id FROM execution_store_catalog_v1 WHERE origin=?', [f.origin]);
    expect(!!afterCrash).toBe(stage === 'after-publish');
    const result = await migrateExecutionStore(options);
    if (afterCrash) expect(result.storeId).toBe(afterCrash.store_id);
    const partition = f.catalog.open(f.origin);
    expect(tableFingerprint(partition.db, 'world_stream')).toBe(f.fingerprints.world_stream);
    expect(tableFingerprint(partition.db, 'world_participation_policy')).toBe(f.fingerprints.world_participation_policy);
    expect(partition.db.queryOne("SELECT name FROM sqlite_master WHERE name='world_feed'")).toBeNull();
    const original = new LocalHostDb(result.source, {readOnly: true});
    const cache = new LocalHostDb(f.paths.worldFeedProjectionDb(hostDbSlug(f.origin)), {readOnly: true});
    try {
      expect(tableFingerprint(original, 'world_stream')).toBe(f.fingerprints.world_stream);
      expect(tableFingerprint(original, 'world_feed')).toBe(f.fingerprints.world_feed);
      expect(tableFingerprint(cache, 'world_feed')).toBe(f.fingerprints.world_feed);
      expect(cache.queryOne("SELECT name FROM sqlite_master WHERE name='world_stream'")).toBeNull();
    } finally {original.close(); cache.close();}
  });
});

// Removed, not marked. `migrateExecutionStore()` has no callers in src/ or
// scripts/, so this guards a function that is not meant to be fixed — it is
// meant to be deleted with the retired lane. An earlier version of this file
// marked the case `it.fails`, which was wrong twice over: `it.fails` says
// "someone will make this pass", and it also inverts pass/fail without proving
// the target assertion was ever reached.
//
// What the guard MEANT is worth recording even though the guard goes: every
// table in DURABLE_TABLES must have DDL the migration can rebuild. Its method
// expired — it finds DDL by scanning 13 files for CREATE TABLE literals, and 6
// of the 41 durable tables (world_action_client_{requests,results,progress,
// evidence}, world_owner_action_reservations, world_native_action_reservations)
// no longer have one anywhere in src because their schema is generated now.
// Measured: 35 of 41 are still literal and none merely moved to another file.
// （用例本体已删，上面的记录即它存在过的理由。函数本身归 world 车道退役工单。）
