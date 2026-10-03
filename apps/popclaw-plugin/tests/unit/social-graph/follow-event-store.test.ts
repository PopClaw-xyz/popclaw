import { describe, it, expect, beforeEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { FollowEventStore } from '../../../src/social-graph/follow-event-store.js';
import type { DeclaredEvent } from '../../../src/social-graph/state-projection.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

describe('FollowEventStore (DB-backed)', () => {
  let db: InMemoryHostDb;
  beforeEach(() => { db = new InMemoryHostDb(); runMigrations(db, MIGRATIONS); });

  it('append + readAll round-trips DeclaredEvent in insertion order', async () => {
    const s = new FollowEventStore(db);
    const dec: DeclaredEvent = { type: 'FollowDeclared', followee: 'a', followType: 'PUBLIC', tasteSubscribed: true, timestamp: 10, signature: '' };
    const rev: DeclaredEvent = { type: 'FollowRevoked', followee: 'a', followType: 'PUBLIC', timestamp: 20, signature: '' };
    await s.append(dec); await s.append(rev);
    expect(await s.readAll()).toEqual([dec, rev]);
  });

  it('shares state across instances on the same db', async () => {
    await new FollowEventStore(db).append({ type: 'FollowDeclared', followee: 'b', followType: 'PUBLIC', tasteSubscribed: false, timestamp: 1, signature: '' });
    expect(await new FollowEventStore(db).readAll()).toHaveLength(1);
  });
});
