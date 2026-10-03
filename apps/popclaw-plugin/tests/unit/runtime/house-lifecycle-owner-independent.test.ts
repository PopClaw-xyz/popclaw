/**
 * ADR-0051 S2b — the same-root lifecycle owner lease: authoritative reads
 * (no cache), TTL expiry, generation bump on takeover, resumed-after-
 * takeover processes cannot commit. Real SQLite (temp file, dual
 * connections = two processes on one root).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { OwnerLease } from '../../../src/runtime/house-lifecycle/owner-lease.js';

let tmp: string | null = null;
let clockMs = 1_000_000;

function newDb(): HostDb {
  return new LocalHostDb(join(tmp!, 'owner.db'));
}

function lease(db: HostDb, token: string): OwnerLease {
  return new OwnerLease({ db, token, ttlMs: 30_000, now: () => clockMs });
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('OwnerLease', () => {
  it('independent: single holder timer reacquisition after TTL reports lost then acquired for the new epoch', () => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-owner-'));
    const db = newDb();
    const a = lease(db, 'only-holder');
    const notifications: string[] = [];
    try {
      expect(a.tryAcquire()).toBe(true);
      const captured = a.knownGeneration()!;
      a.start({onLost: () => notifications.push('lost'), onAcquired: () => notifications.push('acquired')});
      clockMs += 31_000;
      expect(a.isOwnerNow()).toBe(false);
      expect(a.isGenerationCurrent(captured)).toBe(false);
      vi.advanceTimersByTime(10_000);
      console.log('SINGLE_HOLDER_EPOCH_NOTIFICATION', JSON.stringify({captured,current:a.knownGeneration(),ownerNow:a.isOwnerNow(),oldCapturedActive:a.isGenerationCurrent(captured),notifications}));
      expect(a.isOwnerNow()).toBe(true);
      expect(a.knownGeneration()).toBe(captured + 1);
      expect(a.isGenerationCurrent(captured)).toBe(false);
      expect([...notifications], 'new ownership epoch must tear down old coordinator then start a fresh one').toEqual(['lost','acquired']);
    } finally { a.release(); db.close(); vi.useRealTimers(); }
  });

  it('independent: same token reacquiring after TTL must never revive a captured generation', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-owner-'));
    const db = newDb();
    const a = lease(db, 'same-process');
    try {
      expect(a.tryAcquire()).toBe(true);
      const captured = a.knownGeneration()!;
      clockMs += 31_000;
      expect(a.isGenerationCurrent(captured)).toBe(false);
      expect(a.tryAcquire()).toBe(true);
      console.log('SAME_TOKEN_AFTER_TTL', JSON.stringify({captured,current:a.currentGeneration(),oldCapturedActive:a.isGenerationCurrent(captured),ownerNow:a.isOwnerNow()}));
      expect(a.isGenerationCurrent(captured), 'expired generation must remain dead after same-token reacquisition').toBe(false);
      expect(a.currentGeneration()).toBeGreaterThan(captured);
    } finally { a.release(); db.close(); }
  });

  it('independent: same token reacquiring after release must never revive a captured generation', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-owner-'));
    const db = newDb();
    const a = lease(db, 'same-process');
    try {
      expect(a.tryAcquire()).toBe(true);
      const captured = a.knownGeneration()!;
      a.release();
      expect(a.isGenerationCurrent(captured)).toBe(false);
      expect(a.tryAcquire()).toBe(true);
      console.log('SAME_TOKEN_AFTER_RELEASE', JSON.stringify({captured,current:a.currentGeneration(),oldCapturedActive:a.isGenerationCurrent(captured),ownerNow:a.isOwnerNow()}));
      expect(a.isGenerationCurrent(captured), 'released generation must remain dead after same-token reacquisition').toBe(false);
      expect(a.currentGeneration()).toBeGreaterThan(captured);
    } finally { a.release(); db.close(); }
  });

  it('independent: timer notifies onLost after an external holder takes over', () => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-owner-'));
    const db = newDb();
    const a = lease(db, 'proc-a');
    const b = lease(db, 'proc-b');
    const lost = vi.fn();
    try {
      expect(a.tryAcquire()).toBe(true);
      a.start({onLost:lost});
      clockMs += 31_000;
      expect(b.tryAcquire()).toBe(true);
      expect(a.isOwnerNow()).toBe(false);
      vi.advanceTimersByTime(10_000);
      console.log('TAKEOVER_NOTIFICATION', JSON.stringify({oldOwnerNow:a.isOwnerNow(),newOwnerNow:b.isOwnerNow(),lostNotifications:lost.mock.calls.length}));
      expect(lost, 'former owner must be told to stop its coordinator after takeover').toHaveBeenCalledTimes(1);
    } finally { a.release(); b.release(); db.close(); vi.useRealTimers(); }
  });

  it('claims, renews without bumping the generation, and expires by TTL', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-owner-'));
    const db = newDb();
    const a = lease(db, 'proc-a');
    expect(a.tryAcquire()).toBe(true);
    const gen1 = a.currentGeneration();
    expect(gen1).toBe(1);
    expect(a.tryAcquire()).toBe(true);
    // same-holder renewal keeps the generation
    expect(a.currentGeneration()).toBe(gen1);

    clockMs += 31_000; // past the TTL
    // expired — authoritative read, no cache
    expect(a.isOwnerNow()).toBe(false);
    const b = lease(db, 'proc-b');
    expect(b.tryAcquire()).toBe(true);
    // takeover bumps the generation
    expect(b.currentGeneration()).toBe(gen1! + 1);
    db.close();
  });

  it('a resumed-after-takeover process cannot commit (captured generation dead)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-owner-'));
    const db = newDb();
    const a = lease(db, 'proc-a');
    a.tryAcquire();
    const captured = a.knownGeneration()!;

    // proc-a SIGSTOPs; time passes past TTL; proc-b takes over.
    clockMs += 31_000;
    const b = lease(db, 'proc-b');
    b.tryAcquire();

    // proc-a resumes: its cached boolean would say "held", but the
    // authoritative checks see the takeover.
    expect(a.isOwnerNow()).toBe(false);
    // the captured generation died with the takeover
    expect(a.isGenerationCurrent(captured)).toBe(false);
    // Even a late renewal attempt loses: the row belongs to a live holder.
    expect(a.tryAcquire()).toBe(false);
    expect(b.isGenerationCurrent(b.knownGeneration()!)).toBe(true);
    db.close();
  });

  it('release hands ownership back; the next taker bumps the generation', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-owner-'));
    const db = newDb();
    const a = lease(db, 'proc-a');
    a.tryAcquire();
    const gen1 = a.currentGeneration();
    a.release();
    expect(a.isOwnerNow()).toBe(false);
    const b = lease(db, 'proc-b');
    expect(b.tryAcquire()).toBe(true);
    expect(b.currentGeneration()).toBe(gen1! + 1);
    db.close();
  });

  it('two connections on one root elect exactly one owner (dual connections)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-owner-'));
    const db1 = newDb();
    const db2 = newDb();
    const a = lease(db1, 'proc-a');
    const b = lease(db2, 'proc-b');
    expect(a.tryAcquire()).toBe(true);
    // live holder blocks the second process
    expect(b.tryAcquire()).toBe(false);
    expect(b.isOwnerNow()).toBe(false);
    // The holder's authority is visible across connections.
    expect(a.isOwnerNow()).toBe(true);
    db1.close();
    db2.close();
  });
});
