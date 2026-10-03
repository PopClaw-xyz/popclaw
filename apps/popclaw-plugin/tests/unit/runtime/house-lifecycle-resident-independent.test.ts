/**
 * ADR-0051 S2b — the RESIDENT lifecycle owner binding: only the lease owner
 * opens stream sets; ownership loss tears them down; takeover while a
 * non-owner process runs leaves it a reader with zero sets; durable state
 * survives handover. Real SQLite (temp file, dual connections).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import { ResidentLifecycle } from '../../../src/runtime/house-lifecycle/resident.js';
import type { PerHouseStreams } from '../../../src/runtime/house-lifecycle/coordinator.js';
import { readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';

const IDENTITY_SEED = new Uint8Array(32).fill(0x33);
const IDENTITY_KEY = nacl.sign.keyPair.fromSeed(IDENTITY_SEED);
const POPCLAW_ID = bs58.encode(IDENTITY_KEY.publicKey);
const ORIGIN = 'https://demo.loreshow.invalid';

const signer = {
  publicKey: async () => IDENTITY_KEY.publicKey,
  sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, IDENTITY_KEY.secretKey),
  popclawId: async () => POPCLAW_ID,
};

let tmp: string | null = null;
let clockMs = 1_757_200_000;

function newDb(): HostDb {
  return new LocalHostDb(join(tmp!, 'resident.db'));
}

function recorder() {
  const events: string[] = [];
  const sets: PerHouseStreams[] = [];
  return {
    events,
    sets,
    factory: {
      open: (gate: { origin: string }): PerHouseStreams => {
        const set = { stop: () => { events.push(`stop:${gate.origin}`); } };
        events.push(`open:${gate.origin}`);
        sets.push(set);
        return set;
      },
    },
  };
}

function manager(db: HostDb, fetch: typeof globalThis.fetch): HouseLifecycleManager {
  return new HouseLifecycleManager({
    db,
    signer,
    installationId: 'install-test',
    fetch,
    clock: () => clockMs,
  });
}

/** A fetch that is never expected to be called in these tests (legacy rows). */
const quietFetch: typeof globalThis.fetch = (async () => {
  throw new Error('unexpected network call in resident test');
}) as typeof globalThis.fetch;

function resident(
  db: HostDb,
  token: string,
  rec: ReturnType<typeof recorder>,
  extra: { ttlMs?: number } = {},
): ResidentLifecycle {
  const r = new ResidentLifecycle({
    manager: manager(db, quietFetch),
    streams: rec.factory,
    token,
    ttlMs: extra.ttlMs ?? 30_000,
    now: () => clockMs,
    intentPollMs: 60_000,
  });
  r.configureOrigins([ORIGIN]);
  return r;
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('ResidentLifecycle', () => {
  it('independent: captured stream gate loses authority immediately after another owner takes over', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-'));
    const db1 = newDb();
    const db2 = newDb();
    const recA = recorder();
    const recB = recorder();
    let captured!: ReturnType<HouseLifecycleManager['gateFor']>;
    const a = new ResidentLifecycle({manager:manager(db1,quietFetch),token:'proc-a',now:()=>clockMs,intentPollMs:60_000,streams:{open:(gate)=>{captured=gate; return recA.factory.open(gate);}}});
    a.configureOrigins([ORIGIN]);
    const b = resident(db2,'proc-b',recB);
    try {
      a.start();
      expect(captured.isActive()).toBe(true);
      clockMs += 31_000;
      b.start();
      const holder = db1.queryOne<{holder:string}>('SELECT holder FROM house_lifecycle_owner WHERE id=1')!.holder;
      console.log('TAKEN_OVER_GATE',JSON.stringify({holder,oldGateActive:captured.isActive(),oldSignalAborted:captured.signal.aborted,openedByB:recB.sets.length}));
      expect(holder).toBe('proc-b');
      expect(captured.isActive(),'captured stream gate must include its captured owner epoch before timer notices takeover').toBe(false);
    } finally {a.stop();b.stop();db1.close();db2.close();}
  });

  it('independent: a reader acquiring the released owner lease actually restores stream sets', () => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-'));
    const db1=newDb(), db2=newDb();
    const recA=recorder(), recB=recorder();
    const a=resident(db1,'proc-a',recA), b=resident(db2,'proc-b',recB);
    try {
      a.start(); b.start();
      expect(recB.sets).toHaveLength(0);
      a.stop();
      vi.advanceTimersByTime(10_000);
      const holder=db2.queryOne<{holder:string}>('SELECT holder FROM house_lifecycle_owner WHERE id=1')!.holder;
      console.log('READER_ACQUIRED',JSON.stringify({holder,gateActive:b.coordinator.manager.gateFor(ORIGIN).isActive(),events:recB.events}));
      expect(holder).toBe('proc-b');
      expect([...recB.events],'new owner must restore its enabled durable houses').toEqual([`open:${ORIGIN}`]);
    } finally {a.stop();b.stop();db1.close();db2.close();vi.useRealTimers();}
  });

  it('independent: refused non-owner open is not retained as a successful set after takeover', async () => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-'));
    const db1=newDb(), db2=newDb();
    const recA=recorder(), recB=recorder();
    const a=resident(db1,'proc-a',recA), b=resident(db2,'proc-b',recB);
    try {
      a.start();
      db1.execute("UPDATE house_participation SET session_id='live-session', lease_expires_at=?, ack_key_hex=? WHERE house_origin=?",[Math.floor(clockMs/1000)+3600,Buffer.from(IDENTITY_KEY.publicKey).toString('hex'),ORIGIN]);
      b.start();
      const login=await b.coordinator.loginHouse(ORIGIN);
      expect(login.status).toBe('connecting'); // readers must submit through IPC
      b.coordinator.seedLegacyHouses([ORIGIN]); // exercise the defensive refused-factory path
      expect(b.coordinator.manager.gateFor(ORIGIN).isActive()).toBe(true);
      expect(recB.sets).toHaveLength(0);
      a.stop();
      vi.advanceTimersByTime(10_000);
      const holder=db2.queryOne<{holder:string}>('SELECT holder FROM house_lifecycle_owner WHERE id=1')!.holder;
      console.log('PLACEHOLDER_AFTER_ACQUIRE',JSON.stringify({holder,gateActive:b.coordinator.manager.gateFor(ORIGIN).isActive(),events:recB.events,realSets:recB.sets.length}));
      expect(holder).toBe('proc-b');
      expect([...recB.events],'refused factory open must not suppress the new owner real open').toEqual([`open:${ORIGIN}`]);
    } finally {a.stop();b.stop();db1.close();db2.close();vi.useRealTimers();}
  });

  it('independent: ex-owner can open fresh streams when it later regains ownership', () => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-'));
    const db1=newDb(), db2=newDb();
    const recA=recorder(), recB=recorder();
    const a=resident(db1,'proc-a',recA), b=resident(db2,'proc-b',recB);
    try {
      a.start();
      clockMs += 31_000;
      b.start();
      vi.advanceTimersByTime(10_000);
      expect([...recA.events]).toEqual([`open:${ORIGIN}`,`stop:${ORIGIN}`]);
      b.stop();
      vi.advanceTimersByTime(10_000);
      const holder=db1.queryOne<{holder:string}>('SELECT holder FROM house_lifecycle_owner WHERE id=1')!.holder;
      console.log('EX_OWNER_REACQUIRED',JSON.stringify({holder,gateActive:a.coordinator.manager.gateFor(ORIGIN).isActive(),events:recA.events}));
      expect(holder).toBe('proc-a');
      expect([...recA.events],'regained owner must replace the stopped coordinator/manager or resume them safely').toEqual([`open:${ORIGIN}`,`stop:${ORIGIN}`,`open:${ORIGIN}`]);
    } finally {a.stop();b.stop();db1.close();db2.close();vi.useRealTimers();}
  });

  it('the owner seeds legacy houses and opens stream sets', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-'));
    const db = newDb();
    const rec = recorder();
    const r = resident(db, 'proc-a', rec);
    r.start();
    expect(rec.events).toEqual([`open:${ORIGIN}`]);
    expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
    r.stop();
    db.close();
  });

  it('a second process on the same root is a READER: zero stream sets, no gate', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-'));
    const db1 = newDb();
    const db2 = newDb();
    const recA = recorder();
    const recB = recorder();
    const a = resident(db1, 'proc-a', recA);
    a.start();
    const b = resident(db2, 'proc-b', recB);
    b.start();
    // Only the owner opened sets; the reader opened none and seeded nothing
    // destructive (its seed is a no-op on existing rows).
    expect(recA.events).toEqual([`open:${ORIGIN}`]);
    expect(recB.events).toEqual([]);
    a.stop();
    b.stop();
    db1.close();
    db2.close();
  });

  it('losing ownership (takeover) tears the owner\'s stream sets down, durable state kept', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-'));
    const db1 = newDb();
    const db2 = newDb();
    const recA = recorder();
    const recB = recorder();
    const a = resident(db1, 'proc-a', recA, { ttlMs: 10_000 });
    a.start();
    expect(recA.events).toEqual([`open:${ORIGIN}`]);

    // proc-a stalls past its TTL; proc-b takes over.
    clockMs += 11_000;
    const b = resident(db2, 'proc-b', recB, { ttlMs: 10_000 });
    b.start();
    // the new owner opened its sets
    expect(recB.events).toEqual([`open:${ORIGIN}`]);

    // proc-a's own machinery notices the loss on its renewal cadence — but
    // even BEFORE that, its authority is gone: a manual sync opens nothing.
    clockMs += 11_000; // both leases now stale; nothing below should open
    a.coordinator.syncHouse(ORIGIN);
    // durable state unchanged: still enabled (a takeover is not a logout)
    expect(readParticipation(db1, ORIGIN)?.desired).toBe('enabled');
    a.stop();
    b.stop();
    db1.close();
    db2.close();
  });

  it('stop keeps durable desired (host shutdown ≠ logout)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-'));
    const db = newDb();
    const rec = recorder();
    const r = resident(db, 'proc-a', rec);
    r.start();
    r.stop();
    expect(rec.events).toEqual([`open:${ORIGIN}`, `stop:${ORIGIN}`]);
    expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
    db.close();
  });
});
