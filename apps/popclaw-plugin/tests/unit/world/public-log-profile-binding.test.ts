import { afterEach, describe, expect, it } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { canonicalizeEnvelope, cidFromCanonical, popclaw as fixedCodec } from '../../../src/protocol/public-envelope-generated.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { PUBLIC_JOURNAL_TABLES } from '../../../src/host/execution-store-schema.js';
import { MaintenanceSession } from '../../../src/host/storage-maintenance.js';
import { PublicStreamJournal, preparePublicStreamJournal, verifyPublicStreamJournalSchema, rebuildPublicJournalProjection, EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST,
  type PublicJournalPreparation } from '../../../src/world/scoped-stream-journal.js';
import type { VerifiedPublicStreamCapability } from '../../../src/world/world-capabilities.js';
import { openUnprovisionedPartition } from '../../helpers/unprovisioned-partition.js';

const dbs: InMemoryHostDb[] = [];
const cleanup: Array<() => void> = [];
const house = { origin: 'https://public.example', houseKey: 'house-key', incarnation: 'server_1' };
const ledger = 'world_public_log_profiles_v1';
function database() { const db = new InMemoryHostDb(); dbs.push(db); return db; }
function options(db: HostDb, log = 'log_A', revision = log): PublicJournalPreparation {
  const capability: VerifiedPublicStreamCapability = { house, capabilityRevision: revision,
    publicStream: { endpoint: '/v1/world-stream', mode: 'public-v1', envelope_baseline: 'public-envelope-02', log_incarnation: log, initial_public_scopes: [] } };
  return { executionDb: db, capability, producerPolicy: { house, capabilityRevision: revision, officialActorIds: [] },
    selection: { fullPublic: true, scopes: [] }, consumerContracts: [], approvedConsumerMappingDigest: EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST };
}
function receiver(o: PublicJournalPreparation) {
  const abort = new AbortController();
  return new PublicStreamJournal({ ...o, gate: { origin: house.origin, signal: abort.signal, isActive: () => !abort.signal.aborted } });
}
function legacy(db: HostDb) {
  // Snapshot the predecessor's exact seven-table schema, without its new feature.
  preparePublicStreamJournal(options(db));
  db.execute(`DROP TABLE ${ledger}`);
  db.execute("UPDATE world_public_cursors_v1 SET after_seq='17'");
}
function legacyCatalog() {
  const root = mkdtempSync(join(tmpdir(), 'public-log-profile-'));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb());
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: 'profile-test-owner' });
  cleanup.push(() => { catalog.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const partition = openUnprovisionedPartition({ catalog, db, paths, actorId: 'profile-test-owner', origin: house.origin });
  const maintenance = MaintenanceSession.begin(db, paths, 'public profile upgrade test');
  legacy(partition.db);
  const names = PUBLIC_JOURNAL_TABLES.filter(name => name !== ledger);
  db.execute('UPDATE execution_store_catalog_v1 SET required_tables=? WHERE origin=?', [JSON.stringify(names), house.origin]);
  return { db, partition, catalog, maintenance };
}
function signedPost() {
  const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(122));
  const envelope = { actor: { popclawId: bs58.encode(key.publicKey) }, timestamp: 10, post: {} };
  const canonical = canonicalizeEnvelope(envelope), eventId = cidFromCanonical(canonical);
  const raw = fixedCodec.event.EventEnvelope.encode({ ...envelope, eventId, signature: nacl.sign.detached(canonical, key.secretKey) }).finish();
  const frame = popclaw.event.WorldStreamFrame.encode(popclaw.event.WorldStreamFrame.fromObject({ seq: '1', envelope: raw, kind: 'post' })).finish();
  return { eventId, raw, frame };
}
afterEach(() => { dbs.splice(0).forEach(db => db.close()); cleanup.splice(0).reverse().forEach(close => close()); });

describe('authenticated public log baseline binding', () => {
  it('refuses missing or different baseline before creating tables', () => {
    for (const baseline of [undefined, 'wider-baseline']) {
      const db = database(), o = options(db);
      (o.capability.publicStream as { envelope_baseline?: string }).envelope_baseline = baseline;
      expect(() => preparePublicStreamJournal(o)).toThrow('PUBLIC_BASELINE_UNSUPPORTED');
      expect(db.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_public_%'")).toEqual([]);
    }
  });

  it('retains same-log cursors on reconnect and retires old IDs on a fresh-log switch', () => {
    const db = database(), a = options(db);
    preparePublicStreamJournal(a);
    const first = receiver(a); first.activate();
    db.execute("UPDATE world_public_cursors_v1 SET after_seq='17'");
    first.end(null);
    const restarted = receiver(options(db, 'log_A', 'manifest_2')); restarted.activate();
    expect(restarted.request().publicAfter).toBe('17'); restarted.end(null);
    const second = receiver(options(db, 'log_B')); second.activate();
    expect(second.request()).toMatchObject({ incarnation: 'log_B', publicAfter: '0' });
    expect(db.queryAll('SELECT log_incarnation,after_seq FROM world_public_cursors_v1 ORDER BY log_incarnation'))
      .toEqual([{ log_incarnation: 'log_A', after_seq: '17' }, { log_incarnation: 'log_B', after_seq: '0' }]);
    second.end(null);
    expect(() => receiver(options(db)).activate()).toThrow('PUBLIC_LOG_RETIRED');
    expect(db.queryOne('SELECT active_log,house_incarnation FROM world_public_bindings_v1'))
      .toEqual({ active_log: 'log_B', house_incarnation: 'server_1' });
  });

  it('refuses a still-running local generation until its owner ends it', () => {
    const db = database(), a = options(db); preparePublicStreamJournal(a);
    const first = receiver(a); first.activate();
    const boundary = popclaw.world.PublicStreamBoundary.fromObject({ logIncarnation: 'log_A', scopes: [], highWaterSeq: '0', fullPublic: true });
    const generation = first.begin(boundary, popclaw.world.PublicStreamBoundary.encode(boundary).finish(), first.request());
    const second = receiver(options(db, 'log_B'));
    expect(() => second.activate()).toThrow('PUBLIC_RECEIVER_JOIN_REQUIRED');
    expect(db.queryOne('SELECT active_log FROM world_public_bindings_v1')).toEqual({ active_log: 'log_A' });
    first.end(generation); second.activate();
    expect(second.request().incarnation).toBe('log_B');
  });

  it('refuses to relabel a persisted baseline in either selection direction', () => {
    const db = database(), o = options(db); preparePublicStreamJournal(o);
    db.execute(`UPDATE ${ledger} SET envelope_baseline='wider-baseline'`);
    expect(() => receiver(o).activate()).toThrow('PUBLIC_LOG_BASELINE_CONFLICT');
    (o.capability.publicStream as {envelope_baseline: string}).envelope_baseline = 'wider-baseline';
    expect(() => receiver(o).activate()).toThrow('PUBLIC_BASELINE_UNSUPPORTED');
    expect(db.queryOne(`SELECT envelope_baseline FROM ${ledger}`)).toEqual({ envelope_baseline: 'wider-baseline' });
  });

  it('keeps original CID bytes and completed content separate from new-log sequence associations', () => {
    const db = database(), o = options(db), original = signedPost(); preparePublicStreamJournal(o);
    for (const log of ['log_A', 'log_B']) {
      const journal = receiver(options(db, log)); journal.activate();
      expect(journal.request().publicAfter).toBe('0');
      const boundary = popclaw.world.PublicStreamBoundary.fromObject({ logIncarnation: log, scopes: [], highWaterSeq: '1', fullPublic: true });
      const generation = journal.begin(boundary, popclaw.world.PublicStreamBoundary.encode(boundary).finish(), journal.request());
      journal.append(generation, original.frame); journal.end(generation);
      if (log === 'log_A') db.execute("INSERT INTO world_public_consumers_v1(binding_id,event_id,consumer_id,state) VALUES(?,?,?,'done')",
        [journal.bindingId, original.eventId, 'legacy-public-content:v1']);
    }
    const rows = db.queryAll<{envelope: Uint8Array}>('SELECT envelope FROM world_public_events_v1');
    expect(rows).toHaveLength(1); expect(new Uint8Array(rows[0]!.envelope)).toEqual(new Uint8Array(original.raw));
    expect(db.queryAll('SELECT log_incarnation,seq FROM world_public_frames_v1 ORDER BY log_incarnation'))
      .toEqual([{ log_incarnation: 'log_A', seq: '1' }, { log_incarnation: 'log_B', seq: '1' }]);
    expect(db.queryOne('SELECT state FROM world_public_consumers_v1')).toEqual({ state: 'done' });
  });

  it('does not infer an upgrade when the protected profile table is missing', () => {
    const db = database(); legacy(db);
    expect(() => verifyPublicStreamJournalSchema(db)).toThrow(`PUBLIC_JOURNAL_SCHEMA_INVALID:${ledger}`);
    expect(() => preparePublicStreamJournal(options(db, 'log_B'))).toThrow('PUBLIC_LOG_PROFILE_MAINTENANCE_REQUIRED');
    expect(db.queryOne("SELECT name FROM sqlite_master WHERE name=?", [ledger])).toBeNull();
    expect(db.queryOne('SELECT after_seq FROM world_public_cursors_v1')).toEqual({ after_seq: '17' });
  });

  it('explicitly upgrades exact old schema and permanently marks old IDs unsupported', () => {
    const db = database(); legacy(db);
    const next = { ...options(db, 'log_B'), upgradeLegacyLogProfiles: true };
    preparePublicStreamJournal(next); verifyPublicStreamJournalSchema(db);
    expect(db.queryOne(`SELECT envelope_baseline,retired FROM ${ledger} WHERE log_incarnation='log_A'`))
      .toEqual({ envelope_baseline: null, retired: 1 });
    expect(db.queryOne('SELECT active_log FROM world_public_bindings_v1')).toEqual({ active_log: 'log_A' });
    const second = receiver(next); second.activate(); second.end(null);
    expect(() => receiver(options(db)).activate()).toThrow('PUBLIC_LOG_RETIRED');
    expect(db.queryOne("SELECT after_seq FROM world_public_cursors_v1 WHERE log_incarnation='log_A'"))
      .toEqual({ after_seq: '17' });
  });

  it('will not relabel the active legacy log or repair a damaged legacy schema', () => {
    const db = database(); legacy(db);
    expect(() => preparePublicStreamJournal({ ...options(db), upgradeLegacyLogProfiles: true })).toThrow('PUBLIC_LOG_RETIRED');
    expect(db.queryOne("SELECT name FROM sqlite_master WHERE name=?", [ledger])).toBeNull();
    db.execute('DROP INDEX world_public_consumers_pending_v1');
    expect(() => preparePublicStreamJournal({ ...options(db, 'log_B'), upgradeLegacyLogProfiles: true }))
      .toThrow('PUBLIC_JOURNAL_SCHEMA_INVALID:world_public_consumers_pending_v1');
    expect(db.queryOne("SELECT name FROM sqlite_master WHERE name=?", [ledger])).toBeNull();
  });

  it('reserves the explicit upgrade only for a complete protected legacy schema', () => {
    const f = legacyCatalog();
    const reservation = f.catalog.reservePublicJournal(house.origin, f.partition, f.maintenance);
    expect(reservation).toEqual({ upgradeLegacyLogProfiles: true });
    expect(JSON.parse(f.db.queryOne<{required_tables: string}>('SELECT required_tables FROM execution_store_catalog_v1')!.required_tables))
      .toEqual([...PUBLIC_JOURNAL_TABLES].sort());
    expect(() => f.catalog.open(house.origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
    preparePublicStreamJournal({ ...options(f.partition.db, 'log_B'), ...reservation });
    expect(f.catalog.open(house.origin)).toBe(f.partition);
    expect(f.catalog.reservePublicJournal(house.origin, f.partition, f.maintenance)).toEqual({ upgradeLegacyLogProfiles: false });
  });

  it('never recreates a missing protected ledger, including after catalog restart', () => {
    const f = legacyCatalog();
    const reservation = f.catalog.reservePublicJournal(house.origin, f.partition, f.maintenance);
    preparePublicStreamJournal({ ...options(f.partition.db, 'log_B'), ...reservation });
    f.partition.db.execute(`DROP TABLE ${ledger}`);
    expect(() => f.catalog.reservePublicJournal(house.origin, f.partition, f.maintenance)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
    expect(() => f.catalog.open(house.origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
    f.catalog.close();
    const restarted = new ExecutionStoreCatalog(f.catalog.options); cleanup.push(() => restarted.close());
    expect(() => restarted.open(house.origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
  });

  it('rejects damaged old schema before extending its durable reservation', () => {
    const f = legacyCatalog();
    f.partition.db.execute('DROP INDEX world_public_consumers_pending_v1');
    expect(() => f.catalog.reservePublicJournal(house.origin, f.partition, f.maintenance))
      .toThrow('PUBLIC_JOURNAL_SCHEMA_INVALID:world_public_consumers_pending_v1');
    expect(f.db.queryOne<{required_tables: string}>('SELECT required_tables FROM execution_store_catalog_v1')!.required_tables).not.toContain(ledger);
  });

  it('restricts an original historical frame with a duplicate envelope carrier', () => {
    const db = database(), o = options(db), original = signedPost(), binding = JSON.stringify([house.origin, house.houseKey, house.incarnation]);
    const malformed = new Uint8Array([...original.frame, 18, 0]);
    db.execute('CREATE TABLE world_scoped_bindings(binding_id TEXT,origin TEXT,house_key TEXT,house_incarnation TEXT)');
    db.execute('INSERT INTO world_scoped_bindings VALUES(?,?,?,?)', [binding, house.origin, house.houseKey, house.incarnation]);
    db.execute('CREATE TABLE world_scoped_events(binding_id TEXT,event_id TEXT,envelope BLOB,frame_bytes BLOB,content_pending INTEGER,task_pending INTEGER)');
    db.execute('INSERT INTO world_scoped_events VALUES(?,?,?,?,0,1)', [binding, original.eventId, original.raw, malformed]);
    expect(preparePublicStreamJournal(o)).toMatchObject({ imported: 0, restricted: 1 });
    expect(db.queryAll('SELECT * FROM world_public_events_v1')).toEqual([]);
    expect(db.queryOne('SELECT disposition,reason_code,source_consumer_flags FROM world_public_imports_v1'))
      .toEqual({ disposition: 'restricted', reason_code: 'PUBLIC_IMPORT_CARRIER_INVALID', source_consumer_flags: JSON.stringify({ 'legacy-scoped-content:v1': 1, 'legacy-scoped-combined-task:v1': 0 }) });
    expect(new Uint8Array(db.queryOne<{frame_bytes: Uint8Array}>('SELECT frame_bytes FROM world_scoped_events')!.frame_bytes)).toEqual(malformed);
  });

  it('rejects a stored raw projection before duplicate carriers can be decoded away', () => {
    const db = database(), o = options(db), original = signedPost(); preparePublicStreamJournal(o);
    const journal = receiver(o); journal.activate();
    const boundary = popclaw.world.PublicStreamBoundary.fromObject({ logIncarnation: 'log_A', scopes: [], highWaterSeq: '1', fullPublic: true });
    const generation = journal.begin(boundary, popclaw.world.PublicStreamBoundary.encode(boundary).finish(), journal.request());
    journal.append(generation, original.frame);
    const projection = popclaw.event.WorldFeedItem.encode({ eventId: original.eventId, platform: 'test', platformPostId: 'test-post' }).finish();
    // field22 first holds forbidden envelope29, then a duplicate empty field22.
    const malformed = new Uint8Array([...projection, 178, 1, 3, 234, 1, 0, 178, 1, 0]);
    db.execute("UPDATE world_public_events_v1 SET current_projection=?,projection_log='log_A',projection_seq='1'", [malformed]);
    const records: unknown[] = [];
    expect(() => rebuildPublicJournalProjection(db, { record: item => { records.push(item); } },
      { mode: 'public-v1', capability: o.capability, producerPolicy: o.producerPolicy, assertCurrent() {} })).toThrow();
    expect(records).toEqual([]);
    expect(new Uint8Array(db.queryOne<{current_projection: Uint8Array}>('SELECT current_projection FROM world_public_events_v1')!.current_projection)).toEqual(malformed);
  });
});
