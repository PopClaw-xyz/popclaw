/**
 * The refusal journal of the ordered relation producer — the durable
 * `recordPendingIntent` sink. Until this store the only sinks in existence
 * were test arrays: a production refusal (no pin, house down, signing not
 * ready) left no trace anywhere, which is exactly the disappearance R4 §8.1's
 * required-dependency rule exists to prevent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { RelationPendingIntentStore } from '../../../src/social-graph/relation-pending-intent-store.js';
import type { PendingRelationIntent } from '../../../src/social-graph/relation-producer.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

describe('RelationPendingIntentStore', () => {
  let db: InMemoryHostDb;
  let store: RelationPendingIntentStore;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    store = new RelationPendingIntentStore(db);
  });
  afterEach(() => db.close());

  it('persists every field of a refusal verbatim — reason, detail, house, action, time', () => {
    const intent: PendingRelationIntent = {
      action: 'declare',
      followee: 'FOLLOWEE_ABC',
      houseSlug: 'world',
      reason: 'HOUSE_BINDING_UNPROVEN',
      detail: 'no pin for this origin',
      at: 1_700_000_100,
    };
    store.append(intent);
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'declare',
      followeePopclawId: 'FOLLOWEE_ABC',
      houseSlug: 'world',
      reason: 'HOUSE_BINDING_UNPROVEN',
      detail: 'no pin for this origin',
      at: 1_700_000_100,
    });
  });

  it('optional fields land as NULL, not as empty strings or zeros', () => {
    store.append({ action: 'revoke', followee: 'X', reason: 'HOUSE_UNREACHABLE', at: 5 });
    const row = store.list()[0]!;
    expect(row.houseSlug).toBeNull();
    expect(row.detail).toBeNull();
  });

  it('is an append-only journal: the same followee refused twice keeps both rows (the count is information)', () => {
    const base = { action: 'declare' as const, followee: 'SOMEONE', reason: 'HOUSE_UNREACHABLE' as const, at: 100 };
    store.append(base);
    store.append({ ...base, at: 200 });
    const rows = store.list({ followee: 'SOMEONE' });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.at).toBe(200); // newest first — the owner's "what just happened" reads top-down
    expect(rows[1]!.at).toBe(100);
  });

  it('scopes by followee and caps the list', () => {
    for (let i = 0; i < 5; i++) {
      store.append({ action: 'declare', followee: `P${i}`, reason: 'RELATION_SIGNING_NOT_READY', at: i });
    }
    expect(store.list({ followee: 'P3' })).toHaveLength(1);
    expect(store.list({ limit: 2 })).toHaveLength(2);
    expect(store.list({ limit: 2 })[0]!.followeePopclawId).toBe('P4'); // newest first across all
  });

  it('satisfies the producer contract shape: usable directly as recordPendingIntent', () => {
    // The exact wiring the roots will use — the store IS the producer's
    // required sink, not an adapter around one.
    const sink = (intent: PendingRelationIntent) => store.append(intent);
    sink({ action: 'declare', followee: 'Wired', houseSlug: 'me', reason: 'ORDERED_EDGE_NEEDS_BINDING', at: 7 });
    expect(store.list({ followee: 'Wired' })[0]!.reason).toBe('ORDERED_EDGE_NEEDS_BINDING');
  });
});
