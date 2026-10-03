import {afterEach, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {popclaw} from '@popclaw/contracts';
import {PopclawPaths} from '../../../src/host/popclaw-paths.js';
import {LocalHostDb} from '../../../src/host/local-host-db.js';
import {ExecutionStoreCatalog} from '../../../src/host/execution-store.js';
import {clearWorldFeedProjection, initializeActionReceiptJournal, initializeNativeActionJournal} from '../../../src/host/execution-store-migration.js';
import {MaintenanceSession} from '../../../src/host/storage-maintenance.js';
import {WorldFeedCache} from '../../../src/ingress/world-feed-cache.js';
import {tableFingerprint} from '../../../src/host/storage-backup.js';
import {hostDbSlug} from '../../../src/ingress/host-slug.js';
import {bytesOf, item} from '../../helpers/world-feed-cache';
import { signedFixtureEnvelope } from '../../helpers/signed-envelope';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
it('clears/rebuilds only projection rows without touching claims, unknown requests or task_done',async()=>{
 const root=mkdtempSync(join(tmpdir(),'safe-cache-clear-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const paths=new PopclawPaths(root),global=new LocalHostDb(paths.socialDb());cleanup.push(()=>global.close());
 const catalog=new ExecutionStoreCatalog({db:global,paths,actorId:'synthetic'});cleanup.push(()=>catalog.close());
 const origin='https://cache.example',store=catalog.open(origin);
 store.db.execute('CREATE TABLE world_stream(seq INTEGER PRIMARY KEY,kind TEXT,envelope BLOB,projection BLOB,received_at INTEGER,task_done INTEGER,content_done INTEGER)');
 store.db.execute('CREATE TABLE world_participation_policy(binding TEXT PRIMARY KEY,state TEXT)');
 store.db.execute("INSERT INTO world_participation_policy VALUES('grant','{\"debit\":9,\"unknown\":true}')");
 const projection=popclaw.event.WorldFeedItem.encode({platform:'test',platformPostId:'one',textPreview:'history',eventId:'event-1'}).finish();
 // The envelope cell must be a real signed public carrier: the rebuild leg of
 // the clear scans it with the strict wire guard (synthetic bytes WIRE_TAG).
 const carrier = popclaw.event.EventEnvelope.encode(signedFixtureEnvelope('')).finish() as Uint8Array;
 store.db.execute('INSERT INTO world_stream VALUES(8,?,?,?,?,1,1)', ['post', carrier,projection,Math.floor(Date.now()/1000)]);
 const before=tableFingerprint(store.db,'world_stream'),policy=tableFingerprint(store.db,'world_participation_policy');
 const cacheDb=new LocalHostDb(paths.lorehouseDb(hostDbSlug(origin)));
 const cache=new WorldFeedCache({db:cacheDb});await cache.start();
 const stale = item({platform:'test',platformPostId:'stale',eventId:'stale-event',textPreview:'stale'}); cache.record(stale, bytesOf(stale));cacheDb.close();
 const maintenance=MaintenanceSession.begin(global,paths,'cache clear');
 await clearWorldFeedProjection({catalog,origin,maintenance});
 expect(tableFingerprint(store.db,'world_stream')).toBe(before);
 expect(tableFingerprint(store.db,'world_participation_policy')).toBe(policy);
 const check=new LocalHostDb(paths.lorehouseDb(hostDbSlug(origin)),{readOnly:true});
 try {expect(check.queryAll<{platform_post_id:string}>('SELECT platform_post_id FROM world_feed')).toEqual([{platform_post_id:'one'}]);}
 finally{check.close();}
});

it('requires explicit rebuild mode when a public journal is bound, before touching cached rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'public-cache-mode-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root), global = new LocalHostDb(paths.socialDb()); cleanup.push(() => global.close());
  const catalog = new ExecutionStoreCatalog({ db: global, paths, actorId: 'synthetic' }); cleanup.push(() => catalog.close());
  const origin = 'https://cache.example', partition = catalog.open(origin);
  const cacheDb = new LocalHostDb(paths.lorehouseDb(hostDbSlug(origin))); cleanup.push(() => cacheDb.close());
  const cache = new WorldFeedCache({ db: cacheDb }); await cache.start();
  const maintenance = MaintenanceSession.begin(global, paths, 'synthetic explicit cache mode');
  // Control group: the factory built the public tables, but nothing bound them,
  // so this house is cleared from its legacy source with no mode demanded.
  await clearWorldFeedProjection({ catalog, origin, maintenance });
  const preserved = item({ platform: 'test', platformPostId: 'preserved', eventId: 'event', textPreview: 'keep until mode is chosen' }); cache.record(preserved, bytesOf(preserved));
  const before = tableFingerprint(cacheDb, 'world_feed');
  // Deliberately synthetic binding cells, not a claimed subscription.
  partition.db.execute(`INSERT INTO world_public_bindings_v1(binding_id,origin,house_key,house_incarnation,active_log,
    capability_revision,selection_json,cycle_inputs_json,consumer_contracts_json,phase) VALUES(?,?,?,?,?,?,?,?,?,'idle')`,
    ['binding', origin, 'house-key', 'house-incarnation', 'log_1', 'revision', '{"fullPublic":true,"scopes":[]}', '{}', '[]']);
  await expect(clearWorldFeedProjection({ catalog, origin, maintenance })).rejects.toThrow('PUBLIC_REBUILD_MODE_REQUIRED');
  expect(tableFingerprint(cacheDb, 'world_feed')).toBe(before);
});


it.each([false, true])('preserves action records on cache clear and rejects missing protected tables (native=%s)', async native => {
  const root = mkdtempSync(join(tmpdir(), 'action-cache-protection-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root), global = new LocalHostDb(paths.socialDb()); cleanup.push(() => global.close());
  const catalog = new ExecutionStoreCatalog({ db: global, paths, actorId: 'synthetic' }); cleanup.push(() => catalog.close());
  const origin = 'https://action-cache.example', partition = catalog.open(origin);
  const cacheDb = new LocalHostDb(paths.lorehouseDb(hostDbSlug(origin))); cleanup.push(() => cacheDb.close());
  const cache = new WorldFeedCache({ db: cacheDb }); await cache.start();
  const maintenance = MaintenanceSession.begin(global, paths, 'synthetic action cache test');
  initializeActionReceiptJournal({ catalog, origin, maintenance });
  if (native) {
    initializeNativeActionJournal({ catalog, origin, maintenance });
    partition.db.execute("INSERT INTO world_native_action_reservations VALUES('binding','r','call','{}','{}','revision','{}','{}',9223372036854775807,42,NULL,'unknown')");
  }
  // Deliberately synthetic storage cells, not claimed as authenticated receipts.
  partition.db.execute('INSERT INTO world_action_client_evidence VALUES(?,?,?,?,?,?,?,?)',
    ['binding', 'request', 'status_response', 'source', 'core', Uint8Array.of(0, 255, 128), Uint8Array.of(254, 1), 7]);
  const evidence = tableFingerprint(partition.db, 'world_action_client_evidence');
  const nativeBefore = native ? tableFingerprint(partition.db, 'world_native_action_reservations') : null;
  await clearWorldFeedProjection({ catalog, origin, maintenance });
  expect(tableFingerprint(partition.db, 'world_action_client_evidence')).toBe(evidence);
  if (native) expect(tableFingerprint(partition.db, 'world_native_action_reservations')).toBe(nativeBefore);
  const keep = item({ platform: 'test', platformPostId: 'keep', eventId: 'event', textPreview: 'preserve when ledger is damaged' }); cache.record(keep, bytesOf(keep));
  const before = tableFingerprint(cacheDb, 'world_feed');
  partition.db.execute(native ? 'DROP TABLE world_native_action_reservations' : 'DROP TABLE world_action_client_evidence');
  await expect(clearWorldFeedProjection({ catalog, origin, maintenance })).rejects.toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
  expect(tableFingerprint(cacheDb, 'world_feed')).toBe(before);
});
