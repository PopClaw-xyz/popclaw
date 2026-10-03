/** The exact legacy table family observed in the owner's approved newspaper repair.
 * Synthetic records only; no real root, identity, session or network is used. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { migrateExecutionStore } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession, publishStorageJson, readStorageControl } from '../../../src/host/storage-maintenance.js';
import { tableFingerprint, verifyStorageBackup } from '../../../src/host/storage-backup.js';
import { PublicWorldStreamClient } from '../../../src/ingress/public-world-stream-client.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';
import { item } from '../../helpers/world-feed-cache.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const stages = ['after-backup', 'prepared', 'target-copied', 'target-verified', 'cache-copied', 'cache-verified', 'before-publish', 'after-publish'] as const;

describe('newspaper legacy cache/execution split with current production DDL', () => {
  it.each(stages)('preserves all four tables and prior recovery decisions after interruption at %s', async stage => {
    const root = mkdtempSync(join(tmpdir(), 'newspaper-storage-migration-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const paths = new PopclawPaths(root);
    const global = new LocalHostDb(paths.socialDb());
    cleanup.push(() => global.close());
    const origin = 'https://newspaper-migration.example';
    const slug = hostDbSlug(origin);
    global.execute('CREATE TABLE house_origin_bindings(slug TEXT PRIMARY KEY, origin TEXT UNIQUE)');
    global.execute('INSERT INTO house_origin_bindings VALUES(?,?)', [slug, origin]);
    const source = new LocalHostDb(paths.lorehouseDb(slug));
    const cache = new WorldFeedCache({ db: source });
    await cache.start();
    cache.record(item({ platformPostId: 'old-post', eventId: 'old-event' }));
    cache.recordInsertCursor('37');
    const onContent = vi.fn();
    const client = new PublicWorldStreamClient({ baseUrl: origin, db: source, onContent });
    client.ensureSchema(); // No start/connect or callbacks: schema only.
    source.execute('INSERT INTO world_stream(seq,event_id,kind,envelope,projection,content_done,task_done,received_at) VALUES(?,?,?,?,?,?,?,?)',
      [41, 'opaque-consumed', 'post', Uint8Array.of(0, 255, 128), Uint8Array.of(1, 200), 1, 1, 1800000000]);
    source.execute('INSERT INTO world_stream(seq,event_id,kind,envelope,projection,content_done,task_done,received_at) VALUES(?,?,?,?,?,?,?,?)',
      [42, 'opaque-pending', 'quest', Uint8Array.of(128, 0, 255), null, 0, 0, 1800000001]);
    source.execute('UPDATE world_stream_cursor SET seq=42 WHERE id=1');
    const names = ['world_feed', 'world_feed_cursor', 'world_stream', 'world_stream_cursor'];
    const before = Object.fromEntries(names.map(name => [name, tableFingerprint(source, name)]));
    source.close();
    const prior = { version: 1 as const, epoch: 'previous-epoch', mode: 'recovery' as const, reason: 'Previous approved recovery', held: [],
      releases: { execution: { policy: 'Existing decision', evidence: 'Existing evidence' } } };
    publishStorageJson(paths.storageControlFile(), prior);
    const catalog = new ExecutionStoreCatalog({ db: global, paths, actorId: 'synthetic-actor' });
    cleanup.push(() => catalog.close());
    expect(catalog.cacheProjection(origin).readOnly).toBe(true);
    const maintenance = MaintenanceSession.begin(global, paths, 'Synthetic newspaper migration');
    const options = { catalog, origin, maintenance, installationId: 'synthetic-installation', codeVersion: 'synthetic-test' };
    await expect(migrateExecutionStore({ ...options, failpoint: at => { if (at === stage) throw new Error('synthetic-interruption'); } })).rejects.toThrow('synthetic-interruption');
    expect(readStorageControl(paths)?.mode).toBe('maintenance');
    const migrated = await migrateExecutionStore(options);
    const record = JSON.parse(readFileSync(migrated.recordPath, 'utf8'));
    expect(verifyStorageBackup(record.backupDirectory).consistency).toBe('quiescent-set');
    const original = new LocalHostDb(migrated.source, { readOnly: true });
    const projection = new LocalHostDb(paths.worldFeedProjectionDb(slug));
    try {
      for (const name of names) expect(tableFingerprint(original, name)).toBe(before[name]);
      const execution = catalog.open(origin);
      for (const name of ['world_stream', 'world_stream_cursor']) expect(tableFingerprint(execution.db, name)).toBe(before[name]);
      for (const name of ['world_feed', 'world_feed_cursor']) expect(tableFingerprint(projection, name)).toBe(before[name]);
      expect(projection.queryOne("SELECT name FROM sqlite_master WHERE name='world_stream'")).toBeNull();
      expect(execution.db.queryOne("SELECT name FROM sqlite_master WHERE name='world_feed'")).toBeNull();
      expect(catalog.cacheProjection(origin).readOnly).toBe(false);
      new WorldFeedCache({ db: projection }).record(item({ platformPostId: 'fresh-post', eventId: 'fresh-event' }));
      expect(new WorldFeedCache({ db: projection }).recent(10).some(row => row.eventId === 'fresh-event')).toBe(true);
      expect(tableFingerprint(execution.db, 'world_stream')).toBe(before.world_stream);
      expect(tableFingerprint(original, 'world_feed')).toBe(before.world_feed);
      expect(onContent).not.toHaveBeenCalled();
    } finally { original.close(); projection.close(); }
    maintenance.finish({ recovery: false, reason: 'Synthetic migration verified' });
    expect(readStorageControl(paths)).toMatchObject({ mode: prior.mode, held: prior.held, releases: prior.releases });
  });
});
