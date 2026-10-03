import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { backfillFollows } from '../../../src/bonds/backfill-follows.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

describe('backfillFollows', () => {
  it('marks each currently-followed id as followed in bonds (idempotent)', () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const bondsStore = new BondsStore(db, () => 1000);
    backfillFollows(bondsStore, ['ALICE', 'BOB']);
    backfillFollows(bondsStore, ['ALICE', 'BOB']);
    expect(bondsStore.get('ALICE')!.followed).toBe(true);
    expect(bondsStore.get('BOB')!.followed).toBe(true);
    expect(bondsStore.list({}).length).toBe(2);
  });
});
