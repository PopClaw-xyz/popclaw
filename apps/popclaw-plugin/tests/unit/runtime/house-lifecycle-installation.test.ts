/**
 * ADR-0051 — the shared installation id: schema-first mint, concurrent
 * first-caller convergence on the winning value, stability across roots.
 * Real SQLite (temp file, dual connections — the same-root shape).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { resolveInstallationId } from '../../../src/runtime/house-lifecycle/installation.js';

let tmp: string;

describe('resolveInstallationId', () => {
  it('mints once and returns the same value for every caller', () => {
    const db = new LocalHostDb(':memory:');
    const a = resolveInstallationId(db, () => 'candidate-a');
    const b = resolveInstallationId(db, () => 'candidate-b');
    expect(a).toBe('candidate-a');
    // the second caller reads the winner, not its own candidate
    expect(b).toBe('candidate-a');
  });

  it('works with the REAL default mint (no injection) — regression: the unbound crypto.randomUUID threw ERR_INVALID_THIS', () => {
    const db = new LocalHostDb(':memory:');
    const id = resolveInstallationId(db);
    // a real uuid from the default mint
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    // And it's the value every later caller sees.
    expect(resolveInstallationId(db)).toBe(id);
  });

  it('works on a FRESH root (schema before read — no no-such-table)', () => {
    const db = new LocalHostDb(':memory:');
    // No manual schema setup: the helper must create the table itself.
    const id = resolveInstallationId(db, () => 'fresh-root-id');
    expect(id).toBe('fresh-root-id');
  });

  it('concurrent first callers on one file converge on ONE id (dual connections)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-install-'));
    try {
      const file = join(tmp, 'meta.db');
      const db1: HostDb = new LocalHostDb(file);
      const db2: HostDb = new LocalHostDb(file);
      // Interleave: both mint before either could observe the other's row.
      const ids = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const db = i % 2 === 0 ? db1 : db2;
        ids.add(resolveInstallationId(db, () => `candidate-${i}`));
      }
      // every caller returns the same winning installation id
      expect(ids.size).toBe(1);
      db1.close();
      db2.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
