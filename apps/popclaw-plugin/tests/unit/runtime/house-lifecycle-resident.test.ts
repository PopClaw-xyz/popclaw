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
import { readParticipation, commitLocalLogin, markEnterOutcome } from '../../../src/runtime/house-lifecycle/participation-store.js';

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

it('public-v1 resident does not seed configured houses without explicit local intent', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'public-resident-intent-'));
  const db = newDb(), rec = recorder(), capture = vi.fn(() => null);
  const owner = new ResidentLifecycle({ manager: manager(db, quietFetch), streams: rec.factory,
    publicStreams: { capture }, seedConfiguredLegacy: false, token: 'public-owner', now: () => clockMs });
  owner.configureOrigins([ORIGIN]); owner.start();
  try {
    expect(owner.authority.captureEpoch()).not.toBeNull();
    expect(readParticipation(db, ORIGIN)).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    expect(rec.events).toEqual([]);
  } finally { await owner.stop(); db.close(); }
});

describe('ResidentLifecycle', () => {
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

describe('resident resource completion and remote intent', () => {
  it('uses the existing default 2-second owner poll to refresh one set while the reader opens none', async () => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-refresh-'));
    const db = newDb(); const peerDb = newDb();
    const refresh = vi.fn(); const readerRefresh = vi.fn();
    const open = vi.fn(() => ({ stop() {}, refresh }));
    const readerOpen = vi.fn(() => ({ stop() {}, refresh: readerRefresh }));
    const owner = new ResidentLifecycle({ manager: manager(db, quietFetch), streams: { open }, token: 'refresh-owner', now: () => clockMs });
    const reader = new ResidentLifecycle({ manager: manager(peerDb, quietFetch), streams: { open: readerOpen }, token: 'refresh-reader', now: () => clockMs });
    owner.configureOrigins([ORIGIN]); reader.configureOrigins([ORIGIN]);
    try {
      owner.start(); reader.start();
      await vi.advanceTimersByTimeAsync(0);
      refresh.mockClear();
      await vi.advanceTimersByTimeAsync(1999);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(1);
      expect(readerOpen).not.toHaveBeenCalled();
      expect(readerRefresh).not.toHaveBeenCalled();
      await owner.stop(); await reader.stop();
      await vi.advanceTimersByTimeAsync(4000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally { await owner.stop(); await reader.stop(); db.close(); peerDb.close(); vi.useRealTimers(); }
  });

  it('fences stale owner refresh immediately after takeover before its next renewal tick', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-epoch-refresh-'));
    const db = newDb(); const peerDb = newDb();
    const refresh = vi.fn(); const peerRefresh = vi.fn();
    const owner = new ResidentLifecycle({ manager: manager(db, quietFetch), streams: { open: () => ({ stop() {}, refresh }) }, token: 'old-refresh-owner', now: () => clockMs, ttlMs: 10_000, intentPollMs: 60_000 });
    const peer = new ResidentLifecycle({ manager: manager(peerDb, quietFetch), streams: { open: () => ({ stop() {}, refresh: peerRefresh }) }, token: 'new-refresh-owner', now: () => clockMs, ttlMs: 10_000, intentPollMs: 60_000 });
    owner.configureOrigins([ORIGIN]); peer.configureOrigins([ORIGIN]);
    try {
      owner.start();
      refresh.mockClear();
      owner.coordinator.syncHouse(ORIGIN);
      expect(refresh).toHaveBeenCalledTimes(1);
      clockMs += 11_000;
      peer.start();
      peerRefresh.mockClear();
      owner.coordinator.syncHouse(ORIGIN);
      peer.coordinator.syncHouse(ORIGIN);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(peerRefresh).toHaveBeenCalledTimes(1);
    } finally { await owner.stop(); await peer.stop(); db.close(); peerDb.close(); }
  });

  it('restores gates for peer-created sessions during polling without rotating unchanged sets', async () => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-poll-'));
    const db = newDb(); const peerDb = newDb(); const rec = recorder();
    const r = new ResidentLifecycle({ manager: manager(db, quietFetch), streams: rec.factory, token: 'poll-owner', now: () => clockMs, intentPollMs: 20 });
    r.configureOrigins([ORIGIN]);
    try {
      r.start();
      await vi.advanceTimersByTimeAsync(0);
      const other = 'https://peer-created.invalid';
      const { opSeq } = commitLocalLogin(peerDb, other, 'install-test', 'peer-enter', Math.floor(clockMs / 1000), Buffer.from(IDENTITY_KEY.publicKey).toString('hex'));
      markEnterOutcome(peerDb, other, opSeq, { sessionId: 'peer-session', houseRevision: 1, phase: 'connected', ackKeyHex: Buffer.from(IDENTITY_KEY.publicKey).toString('hex'), leaseExpiresAt: Math.floor(clockMs / 1000) + 90, inboxReadToken: 'peer-token', now: Math.floor(clockMs / 1000) });
      await vi.advanceTimersByTimeAsync(20);
      expect(rec.events).toEqual([`open:${ORIGIN}`, `open:${other}`]);
      await vi.advanceTimersByTimeAsync(60);
      expect(rec.events).toEqual([`open:${ORIGIN}`, `open:${other}`]);
      expect(readParticipation(db, other)?.session_id).toBe('peer-session');
    } finally { await r.stop(); db.close(); peerDb.close(); vi.useRealTimers(); }
  });

  it('reports actual streams and drains async teardown before shutdown completes', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'popclaw-resident-drain-'));
    const db = newDb();
    let release!: () => void;
    let gate!: import('../../../src/runtime/house-lifecycle/manager.js').HouseGate;
    let stops = 0;
    const pending = new Promise<void>(r => { release = r; });
    const r = new ResidentLifecycle({ manager: manager(db, quietFetch), token: 'drain-owner', now: () => clockMs, streams: { open: captured => {
      gate = captured;
      return { status: () => ({ world: 'active' as const, inbox: 'inactive' as const }), stop: async () => { stops++; await pending; readParticipation(db, ORIGIN); } };
    } } });
    r.configureOrigins([ORIGIN]); r.start();
    try {
      expect((await r.coordinator.getHouseStatus(ORIGIN)).streams).toEqual({ world: 'active', inbox: 'inactive' });
      let done = false;
      const stopping = Promise.resolve(r.stop()).then(() => { done = true; });
      await Promise.resolve();
      expect(gate.isActive()).toBe(false);
      expect(done).toBe(false);
      expect(stops).toBe(1);
      release(); await stopping;
      expect(done).toBe(true);
      expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
    } finally { release(); await r.stop(); db.close(); }
  });
});
