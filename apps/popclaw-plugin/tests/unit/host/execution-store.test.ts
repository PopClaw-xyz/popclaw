import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-durable-store-'));
  roots.push(root);
  const paths = new PopclawPaths(root);
  const db = new LocalHostDb(paths.socialDb());
  closers.push(() => db.close());
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: '11111111111111111111111111111111' });
  closers.push(() => catalog.close());
  return { root, paths, db, catalog };
}

describe('personally owned execution partitions', () => {
  it('uses an opaque durable path and one actual handle without creating a feed cache', () => {
    const { paths, catalog } = fixture();
    const a = catalog.open('https://house.example');
    const again = catalog.open('https://house.example');
    expect(again.db).toBe(a.db);
    expect(a.path).toContain('/vault/social/execution/');
    expect(a.path).not.toContain('house.example');
    expect(existsSync(paths.lorehouseDb(hostDbSlug('https://house.example')))).toBe(false);
    a.db.transaction(tx => expect(tx).toBe(a.db));
  });

  it('does not reuse another origin or silently rebind the local actor', () => {
    const { catalog, db, paths } = fixture();
    const a = catalog.open('https://a.example');
    const b = catalog.open('https://b.example');
    expect(b.path).not.toBe(a.path);
    expect(b.db).not.toBe(a.db);
    expect(() => new ExecutionStoreCatalog({ db, paths, actorId: '22222222222222222222222222222222' }))
      .toThrow('EXECUTION_ACTOR_MISMATCH');
  });

  it('rejects lossy cache slug collisions instead of sharing an address across origins', () => {
    const {catalog} = fixture();
    catalog.open('https://same-host.example');
    expect(() => catalog.open('https://same.host.example')).toThrow('EXECUTION_ORIGIN_COLLISION');
  });

  it('requires controlled migration for an old reliable journal without changing its bytes', () => {
    const { catalog, paths } = fixture();
    const origin = 'https://legacy.example';
    const source = new LocalHostDb(paths.lorehouseDb(hostDbSlug(origin)));
    closers.push(() => source.close());
    source.execute('CREATE TABLE world_stream(seq INTEGER PRIMARY KEY, envelope BLOB, task_done INTEGER)');
    const original = Uint8Array.of(0, 255, 1, 128);
    source.execute('INSERT INTO world_stream VALUES(7,?,1)', [original]);
    expect(() => catalog.open(origin)).toThrow('EXECUTION_MIGRATION_REQUIRED');
    const row = source.queryOne<{ envelope: Uint8Array; task_done: number }>('SELECT * FROM world_stream WHERE seq=7');
    expect(new Uint8Array(row!.envelope)).toEqual(original);
    expect(row!.task_done).toBe(1);
  });

  it('keeps other partitions and local history available when a selected execution file is missing', () => {
    const {catalog, db, paths} = fixture();
    const a = catalog.open('https://a.example');
    catalog.open('https://b.example');
    db.execute('CREATE TABLE personal_history(value TEXT)');
    db.execute("INSERT INTO personal_history VALUES('available offline')");
    catalog.close();
    rmSync(a.path);
    const restarted = new ExecutionStoreCatalog({db, paths, actorId:'11111111111111111111111111111111'});
    closers.push(() => restarted.close());
    expect(() => restarted.open('https://a.example')).toThrow('EXECUTION_PARTITION_MISSING');
    expect(restarted.open('https://b.example').db).toBeDefined();
    expect(db.queryOne<{value:string}>('SELECT value FROM personal_history')?.value).toBe('available offline');
    expect(existsSync(a.path)).toBe(false);
  });

  it('rolls back the whole durable group on the exact same transaction handle', () => {
    const {catalog} = fixture();
    const {db} = catalog.open('https://atomic.example');
    db.execute('CREATE TABLE world_participation_policy(binding TEXT PRIMARY KEY, state TEXT)');
    db.execute('CREATE TABLE world_readiness(binding TEXT PRIMARY KEY, record BLOB)');
    expect(() => db.transaction(tx => {
      expect(tx).toBe(db);
      tx.execute("INSERT INTO world_participation_policy VALUES('binding','debited')");
      tx.execute('INSERT INTO world_readiness VALUES(?,?)', ['original',Uint8Array.of(255)]);
      throw new Error('abort outer transaction');
    })).toThrow('abort outer transaction');
    expect(db.queryAll('SELECT * FROM world_participation_policy')).toEqual([]);
    expect(db.queryAll('SELECT * FROM world_readiness')).toEqual([]);
  });

  it('never treats an unknown legacy table as an empty disposable cache', () => {
    const { catalog, paths } = fixture();
    const origin = 'https://unknown.example';
    const source = new LocalHostDb(paths.lorehouseDb(hostDbSlug(origin)));
    closers.push(() => source.close());
    source.execute('CREATE TABLE future_authorization(record TEXT NOT NULL)');
    source.execute("INSERT INTO future_authorization VALUES('preserve')");
    expect(() => catalog.open(origin)).toThrow('EXECUTION_SCHEMA_UNKNOWN');
    expect(source.queryOne<{ record: string }>('SELECT record FROM future_authorization')?.record).toBe('preserve');
  });
});
