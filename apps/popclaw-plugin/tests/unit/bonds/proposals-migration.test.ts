import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

describe('migration 009 — bond_proposals + interaction column', () => {
  it('adds recent_interactions_json to bonds (default [])', () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    db.execute(
      `INSERT INTO bonds (popclaw_id, tier, tier_source, peak_tier, created_at, updated_at) VALUES ('A','acquaintance','auto','acquaintance',1,1)`,
      [],
    );
    const row = db.queryOne<{ recent_interactions_json: string }>(
      'SELECT recent_interactions_json FROM bonds WHERE popclaw_id = ?',
      ['A'],
    );
    expect(row?.recent_interactions_json).toBe('[]');
  });

  it('creates bond_proposals with the expected columns + CHECK', () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    db.execute(
      `INSERT INTO bonds (popclaw_id, tier, tier_source, peak_tier, created_at, updated_at) VALUES ('A','friend','manual','friend',1,1)`,
      [],
    );
    db.execute(
      `INSERT INTO bond_proposals (popclaw_id, from_tier, to_tier, rationale, status, created_at) VALUES ('A','friend','close','recent',  'pending', 10)`,
      [],
    );
    const p = db.queryOne<{ status: string; to_tier: string }>(
      'SELECT status, to_tier FROM bond_proposals WHERE popclaw_id = ?',
      ['A'],
    );
    expect(p).toEqual({ status: 'pending', to_tier: 'close' });
  });
});
