import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PendingFollowStore, type FollowIntentRow } from '../../../src/social-graph/pending-follow-store.js';
import { buildPendingInjection, injectionStrings } from '../../../src/newspaper/follow-injection.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const MS = 1_750_000_000_000;
const MIN = 60_000;

const T = injectionStrings('zh-CN');

/** The brief's row shape: only what the pure function is allowed to see. */
const row = (display_name: string, descriptor: string | null, first_surfaced_ts: number | null) => ({
  display_name,
  descriptor,
  first_surfaced_ts,
});

// ---------------------------------------------------------------------------
// The three modes (doorbell spec §6.4)
// ---------------------------------------------------------------------------

describe('buildPendingInjection — three modes', () => {
  it('nothing pending → empty string (no injection at all)', () => {
    expect(buildPendingInjection([], T)).toBe('');
  });

  it('any un-surfaced row → the full numbered block, listing EVERY pending row', () => {
    const out = buildPendingInjection(
      [row('云舟#3m8v', '写透 XX 那篇', null), row('levelsio#9xqe', null, null)],
      T,
    );
    // Head line with the count…
    expect(out.split('\n')[0]).toBe('待关注清单（2 位）：');
    // …one numbered entry per line, verbatim plugin-side display names,
    // descriptor parenthetical only where one exists…
    expect(out).toContain('1. 云舟#3m8v（写透 XX 那篇）');
    expect(out).toContain('2. levelsio#9xqe');
    // …and never the pointer line.
    expect(out).not.toContain('关注清单」我摊开');
  });

  it('a mixed batch (surfaced + un-surfaced) still injects the FULL block for all rows', () => {
    // The confirmation basis is the whole unresolved set: a surfaced row the
    // owner never answered is as pending as a fresh click.
    const out = buildPendingInjection(
      [row('云舟#3m8v', null, 1_700_000_000), row('levelsio#9xqe', null, null)],
      T,
    );
    expect(out).toContain('1. 云舟#3m8v');
    expect(out).toContain('2. levelsio#9xqe');
    expect(out).not.toContain('关注清单」我摊开');
  });

  it('every row already surfaced → the one-line pointer plus a compact name list', () => {
    const out = buildPendingInjection(
      [row('云舟#3m8v', '写透 XX 那篇', 1_700_000_000), row('levelsio#9xqe', null, 1_700_000_000)],
      T,
    );
    const lines = out.split('\n');
    // Spec §7's pointer line, byte-for-byte modulo the count.
    expect(lines[0]).toBe('还有 2 位待关注——说「关注清单」我摊开');
    // One compact line: numbered names only — no descriptors, no rules.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('1. 云舟#3m8v 2. levelsio#9xqe');
    expect(out).not.toContain('（写透 XX 那篇）');
    expect(out).not.toContain('先回显整批');
  });
});

// ---------------------------------------------------------------------------
// Numbering stability + the execution rules (brief's asserted strings)
// ---------------------------------------------------------------------------

describe('numbering and rules', () => {
  const rows = [
    row('云舟#3m8v', null, null),
    row('阿禾#k2f0', null, null),
    row('levelsio#9xqe', null, null),
  ];

  it('numbers entries 1..N in the given (first_ts asc) order, full mode', () => {
    const out = buildPendingInjection(rows, T);
    expect(out).toContain('1. 云舟#3m8v');
    expect(out).toContain('2. 阿禾#k2f0');
    expect(out).toContain('3. levelsio#9xqe');
  });

  it('pointer mode numbers the compact list in the same order', () => {
    const out = buildPendingInjection(
      rows.map((r) => ({ ...r, first_surfaced_ts: 1 })),
      T,
    );
    expect(out.split('\n')[1]).toBe('1. 云舟#3m8v 2. 阿禾#k2f0 3. levelsio#9xqe');
  });

  it('full mode carries all five execution-rule clauses (spec §6.4/§6.5)', () => {
    const out = buildPendingInjection(rows, T);
    // ① ≥6 or ambiguous → echo the whole batch first.
    expect(out).toContain('≥6 位或含糊');
    expect(out).toContain('先回显整批');
    // ② Reply examples are examples; natural language accepted.
    expect(out).toContain('回复示例仅是示例，自然语言均接受');
    // ③ "none" skips the batch; unmentioned entries are skipped.
    expect(out).toContain('「不要」=这批全跳过');
    expect(out).toContain('未点到=跳过');
    // ④ Off-topic → don't force it.
    expect(out).toContain('话题无关不必提起');
    // ⑤ T13 receipt rule: after a batch run, report by head-count and point
    // out the correction exit for a mistaken pick.
    expect(out).toContain('批量执行后按人数汇报');
    expect(out).toContain('「取消关注 名字」');
  });
});

// ---------------------------------------------------------------------------
// Strings resolve from the lexicon in both lanes
// ---------------------------------------------------------------------------

describe('injectionStrings', () => {
  it('zh pointer is spec §7 copy with the count templated', () => {
    expect(T.pointer).toBe('还有 {count} 位待关注——说「关注清单」我摊开');
  });

  it('en lane resolves to non-empty English strings', () => {
    const E = injectionStrings('en');
    expect(E.head).toContain('{count}');
    expect(E.pointer).toContain('{count}');
    for (const s of [E.head, E.entry, E.entryDescriptor, E.ruleEcho, E.ruleNatural, E.ruleSkip, E.ruleOffTopic, E.ruleReport, E.pointer, E.pointerEntry]) {
      expect(s.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tiering through the real store + the L1/L2 mutex (ruling C's other half:
// the passenger is read-only; the claim belongs to the drain site in index.ts)
// ---------------------------------------------------------------------------

describe('tiering + mutex against the real PendingFollowStore', () => {
  const T2 = injectionStrings('zh-CN');

  function setup() {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const store = new PendingFollowStore(db);
    const authors = new Map([
      ['yun', { display_name: '云舟#3m8v', descriptor: '写透 XX 那篇', issue_date: '2026-08-30' }],
      ['lev', { display_name: 'levelsio#9xqe', descriptor: null, issue_date: '2026-08-30' }],
    ]);
    const intent = (id: string, firstTs: number): FollowIntentRow => ({
      owner_popclaw_id: 'self',
      followee_popclaw_id: id,
      followee_label: 'link-holder input',
      first_ts: firstTs,
      latest_ts: firstTs,
      click_count: 1,
    });
    store.absorb([intent('lev', MS + MIN), intent('yun', MS)], { authors, followsIn: () => false });
    return store;
  }

  it('fresh batch → full mode; claimSurface flips it to pointer; a second claim wins nothing', () => {
    const store = setup();
    // Un-surfaced → the full block, numbered in first_ts asc order (yun
    // clicked first, so yun is 1 — the store's ordering, preserved here).
    const full = buildPendingInjection(store.listPending(), T2);
    expect(full).toContain('1. 云舟#3m8v（写透 XX 那篇）');
    expect(full).toContain('2. levelsio#9xqe');
    // The drain-site claim (ruling C) marks the batch surfaced…
    expect(store.claimSurface(MS / 1000 + 60)).toBe(2);
    // …so the very next render degrades to the pointer + compact list.
    const pointer = buildPendingInjection(store.listPending(), T2);
    expect(pointer.split('\n')[0]).toBe('还有 2 位待关注——说「关注清单」我摊开');
    // The mutex: the timer leg's claim after the drain site's returns 0.
    expect(store.claimSurface(MS / 1000 + 120)).toBe(0);
  });

  it('confirmations shrink the pointer; once everything resolves, no injection', () => {
    const store = setup();
    store.claimSurface(MS / 1000 + 60);
    store.markConfirmed('yun');
    const one = buildPendingInjection(store.listPending(), T2);
    expect(one.split('\n')[0]).toBe('还有 1 位待关注——说「关注清单」我摊开');
    expect(one).toContain('1. levelsio#9xqe');
    store.expireOlderThan(MS / 1000 + 3_600);
    expect(buildPendingInjection(store.listPending(), T2)).toBe('');
  });
});
