/**
 * ADR-0051 S2b — coordinator unit layer: gates bound to per-house stream
 * sets, ordering (manager first, streams second), immediate teardown on
 * logout, generation replacement on re-login, legacy seeding never
 * overwriting a logout, stopHost keeping desired.
 *
 * Real SQLite (:memory:) + the verified-ack fixtures from the S2a suite;
 * stream sets are recorded doubles (the real stream clients get their own
 * wiring in index/main/mcp and their coverage in S4's real two-house run).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { ackSigningInput } from '@popclaw/algorithms';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import type { LifecycleFetch } from '../../../src/runtime/house-lifecycle/control-client.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import { HouseLifecycleCoordinator, type PerHouseStreams } from '../../../src/runtime/house-lifecycle/coordinator.js';
import { readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';

const HOUSE_SEED = new Uint8Array(32).fill(0xa1);
const HOUSE_KEY = nacl.sign.keyPair.fromSeed(HOUSE_SEED);
const HOUSE_PUBKEY_HEX = Buffer.from(HOUSE_KEY.publicKey).toString('hex');

const IDENTITY_SEED = new Uint8Array(32).fill(0x33);
const IDENTITY_KEY = nacl.sign.keyPair.fromSeed(IDENTITY_SEED);
const POPCLAW_ID = bs58.encode(IDENTITY_KEY.publicKey);

const ORIGIN = 'https://demo.loreshow.invalid';
const OTHER = 'https://other.invalid';
const CLOCK_MS = 1_757_200_000_000;

const hsNs = (popclaw as unknown as {
  housesession: {
    HouseSessionRequest: { decode(b: Uint8Array): Record<string, unknown> };
    HouseSessionAck: { encode(m: unknown): { finish(): Uint8Array } };
  };
}).housesession;

const signer = {
  publicKey: async () => IDENTITY_KEY.publicKey,
  sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, IDENTITY_KEY.secretKey),
  popclawId: async () => POPCLAW_ID,
};

function boardJson(): string {
  return JSON.stringify({
    manifest_version: 1,
    house: { name: 'demo', slug: 'demo', description: 'x' },
    official_ids: [],
    core_primitives: { profile: true, follow: true, directed_delivery: true },
    event_kinds: [],
    intent_kinds: [],
    house_session: {
      version: 1,
      endpoint: '/v1/house-session',
      ack_pubkey: HOUSE_PUBKEY_HEX,
      operations: ['enter', 'renew', 'leave', 'status', 'action'],
      lease_seconds: 90,
      renew_interval_seconds: 30,
    },
  });
}

function bytesResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

function manifestResponse(): Response {
  return new Response(boardJson(), { status: 200, headers: { 'content-type': 'application/json' } });
}

function decodeRequest(body: Uint8Array): Record<string, unknown> {
  return hsNs.HouseSessionRequest.decode(body).core as Record<string, unknown>;
}

/** A fetch that answers manifest + a verified ENTER ack (session 'sess-1'). */
function ackingFetch(): { fetch: LifecycleFetch; calls: Array<{ url: string }> } {
  const calls: Array<{ url: string }> = [];
  const fetch: LifecycleFetch = async (url: string | URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url) });
    if (String(url).endsWith('/v1/manifest')) return manifestResponse();
    const req = decodeRequest(new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
    const core = {
      houseOrigin: ORIGIN,
      popclawId: POPCLAW_ID,
      installationId: 'install-test',
      requestId: req.requestId,
      opSeq: req.opSeq,
      operation: req.operation,
      outcome: req.operation === 1 ? 1 : 4,
      houseRevision: 1,
      sessionId: 'sess-1',
      sessionActive: req.operation === 1,
      leaseExpiresAt: CLOCK_MS / 1000 + 3600,
      serverCommittedAt: CLOCK_MS / 1000,
    };
    return bytesResponse(
      hsNs.HouseSessionAck.encode({
        core,
        signature: nacl.sign.detached(ackSigningInput(core), HOUSE_KEY.secretKey),
        signerPubkey: HOUSE_KEY.publicKey,
      }).finish(),
    );
  };
  return { fetch, calls };
}

/** Recorded stream-set double. */
function streamRecorder(): {
  factory: { open: (gate: { origin: string }) => PerHouseStreams };
  events: string[];
  openSets: PerHouseStreams[];
} {
  const events: string[] = [];
  const openSets: PerHouseStreams[] = [];
  const factory = {
    open: (gate: { origin: string }): PerHouseStreams => {
      const set: PerHouseStreams = {
        stop: () => {
          events.push(`stop:${gate.origin}`);
        },
      };
      events.push(`open:${gate.origin}`);
      openSets.push(set);
      return set;
    },
  };
  return { factory, events, openSets };
}

function newManager(db: HostDb, fetch: LifecycleFetch): HouseLifecycleManager {
  return new HouseLifecycleManager({
    db,
    signer,
    installationId: 'install-test',
    fetch,
    clock: () => CLOCK_MS,
  });
}

let db: HostDb;

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('fetch', (() => {
    throw new Error('real network use detected in unit test (fetch injection drifted)');
  }) as unknown as typeof fetch);
  db = new InMemoryHostDb();
});

describe('HouseLifecycleCoordinator', () => {
  it('refreshes the current active set without reopening and stops refreshing after disable or shutdown', async () => {
    const refresh = vi.fn();
    const stop = vi.fn();
    const open = vi.fn(() => ({ refresh, stop }));
    const coordinator = new HouseLifecycleCoordinator({ manager: newManager(db, ackingFetch().fetch), streams: { open } });
    try {
      coordinator.seedLegacyHouses([ORIGIN]);
      refresh.mockClear();
      coordinator.syncHouse(ORIGIN);
      coordinator.syncHouse(ORIGIN);
      expect(open).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(2);
      await coordinator.logoutHouse(ORIGIN);
      coordinator.seedLegacyHouses([ORIGIN]);
      coordinator.syncHouse(ORIGIN);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledTimes(1);
      coordinator.seedLegacyHouses([OTHER]);
      const beforeStop = refresh.mock.calls.length;
      await coordinator.stopHost();
      coordinator.syncHouse(OTHER);
      expect(refresh).toHaveBeenCalledTimes(beforeStop);
      expect(open).toHaveBeenCalledTimes(2);
    } finally { await coordinator.stopHost(); }
  });

  it('contains a failed refresh so the existing sync pass reaches other active houses', async () => {
    const refreshed: string[] = [];
    const log = vi.fn();
    const coordinator = new HouseLifecycleCoordinator({ manager: newManager(db, ackingFetch().fetch), log, streams: {
      open: gate => ({ stop() {}, refresh() { refreshed.push(gate.origin); if (gate.origin === ORIGIN) throw new Error('refresh failed'); } }),
    } });
    try {
      coordinator.seedLegacyHouses([ORIGIN, OTHER]);
      refreshed.length = 0;
      coordinator.seedLegacyHouses([ORIGIN, OTHER]);
      expect(refreshed).toEqual([ORIGIN, OTHER]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('refresh failed'));
    } finally { await coordinator.stopHost(); }
  });

  // Pin-control probes (pin-bypass review on f0c533b1's seed restore).

  it('same-pin connected seed restores a valid session', async () => {
    const ff = ackingFetch();
    const first = newManager(db, ff.fetch);
    await first.loginHouse(ORIGIN);
    first.stopHost();
    const manager = new HouseLifecycleManager({ db, signer, installationId: 'install-test', fetch: ff.fetch, clock: () => CLOCK_MS, configuredPinFor: () => HOUSE_PUBKEY_HEX });
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    try {
      coordinator.seedLegacyHouses([ORIGIN]);
      expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
      expect(rec.events).toEqual([`open:${ORIGIN}`]);
    } finally {
      coordinator.stopHost();
    }
  });

  it('a connected seed cannot reopen a session under a different configured pin', async () => {
    const ff = ackingFetch();
    const first = newManager(db, ff.fetch);
    await first.loginHouse(ORIGIN);
    first.stopHost();
    const other = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x77));
    const configuredPin = Buffer.from(other.publicKey).toString('hex');
    const manager = new HouseLifecycleManager({ db, signer, installationId: 'install-test', fetch: ff.fetch, clock: () => CLOCK_MS, configuredPinFor: () => configuredPin });
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    try {
      const callsBefore = ff.calls.length;
      coordinator.seedLegacyHouses([ORIGIN]);
      const row = readParticipation(db, ORIGIN)!;
      expect(row.ack_key_hex).not.toBe(configuredPin);
      // configured-pin conflict must keep recovered gate closed
      expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
      expect(rec.events).toEqual([]);
      expect(ff.calls.length - callsBefore).toBe(0);
    } finally {
      coordinator.stopHost();
    }
  });

  it('an AUTH_INVALID login closes the previously captured active gate', async () => {
    const ff = ackingFetch();
    let configuredPin = HOUSE_PUBKEY_HEX;
    const manager = new HouseLifecycleManager({ db, signer, installationId: 'install-test', fetch: ff.fetch, clock: () => CLOCK_MS, configuredPinFor: () => configuredPin });
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    try {
      await coordinator.loginHouse(ORIGIN);
      const oldGate = manager.gateFor(ORIGIN);
      expect(oldGate.isActive()).toBe(true);
      const other = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x77));
      configuredPin = Buffer.from(other.publicKey).toString('hex');
      const result = await coordinator.loginHouse(ORIGIN);
      expect(result.errorCode).toBe('AUTH_INVALID');
      // rejected trust binding must revoke the previously captured gate
      expect(oldGate.isActive()).toBe(false);
      expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
      expect(rec.events).toEqual([`open:${ORIGIN}`, `stop:${ORIGIN}`]);
    } finally {
      coordinator.stopHost();
    }
  });

  // Reviewer probe (S2b ①): a fresh manager+coordinator on an EXISTING
  // enabled legacy row must restore its streams after restart.
  it('restores enabled legacy streams after a fresh manager restart', () => {
    const ff = ackingFetch();
    const first = new HouseLifecycleCoordinator({ manager: newManager(db, ff.fetch), streams: streamRecorder().factory });
    first.seedLegacyHouses([ORIGIN]);
    first.stopHost();
    const manager = newManager(db, ff.fetch);
    const rec = streamRecorder();
    const restarted = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    try {
      restarted.seedLegacyHouses([ORIGIN]);
      expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
      // enabled legacy migration must resume streams after restart
      expect(rec.events).toEqual([`open:${ORIGIN}`]);
      expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
    } finally {
      restarted.stopHost();
    }
  });

  // Reviewer probe (S2b ②): a lease-expired relogin mints a new persisted
  // session WITHOUT a logout — the gate must rotate and the coordinator must
  // replace the old stream set (stop old, open new).
  it('replaces streams when an expired-session login advances the persisted generation', async () => {
    let clock = CLOCK_MS;
    const fetch: LifecycleFetch = async (url: string | URL | RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
      const core = {
        houseOrigin: ORIGIN,
        popclawId: POPCLAW_ID,
        installationId: 'install-test',
        requestId: req.requestId,
        opSeq: req.opSeq,
        operation: req.operation,
        outcome: 1,
        houseRevision: req.opSeq,
        sessionId: `fresh-${req.opSeq}`,
        sessionActive: true,
        leaseExpiresAt: Math.floor(clock / 1000) + 60,
        serverCommittedAt: Math.floor(clock / 1000),
      };
      return bytesResponse(
        hsNs.HouseSessionAck.encode({
          core,
          signature: nacl.sign.detached(ackSigningInput(core), HOUSE_KEY.secretKey),
          signerPubkey: HOUSE_KEY.publicKey,
        }).finish(),
      );
    };
    const manager = new HouseLifecycleManager({ db, signer, installationId: 'install-test', fetch, clock: () => clock });
    const rec = streamRecorder();
    const captured: Array<{ isActive(): boolean; generation: number }> = [];
    const coordinator = new HouseLifecycleCoordinator({
      manager,
      streams: {
        open: (gate) => {
          captured.push(gate);
          return rec.factory.open(gate);
        },
      },
    });
    try {
      const first = await coordinator.loginHouse(ORIGIN);
      clock += 61_000;
      const second = await coordinator.loginHouse(ORIGIN);
      const row = readParticipation(db, ORIGIN)!;
      expect(row.op_seq).toBe(2);
      expect(row.lease_expires_at).toBeGreaterThan(clock / 1000);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(captured[0]!.isActive()).toBe(false);
      expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
      // new persisted session must replace the old captured-gate stream set
      expect(rec.events).toEqual([`open:${ORIGIN}`, `stop:${ORIGIN}`, `open:${ORIGIN}`]);
      expect(rec.openSets).toHaveLength(2);
    } finally {
      coordinator.stopHost();
    }
  });

  it('seeds legacy houses and opens their streams without a session', () => {
    const ff = ackingFetch();
    const manager = newManager(db, ff.fetch);
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    coordinator.seedLegacyHouses([ORIGIN]);
    // Static-connect lane: gate active, streams open, no session ever minted.
    expect(rec.events).toEqual([`open:${ORIGIN}`]);
    const row = readParticipation(db, ORIGIN);
    expect(row?.desired).toBe('enabled');
    expect(row?.phase).toBe('connected');
    expect(row?.session_id).toBe('');
    expect(row?.ack_key_hex).toBe('');
    // legacy lane performs no control-plane I/O
    expect(ff.calls).toHaveLength(0);
    coordinator.stopHost();
  });

  it('login opens streams only AFTER the verified ack (ordering)', async () => {
    const ff = ackingFetch();
    const manager = newManager(db, ff.fetch);
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    // Boot with the house ABSENT: nothing opens.
    expect(rec.events).toEqual([]);
    await coordinator.loginHouse(ORIGIN);
    // Streams opened after the enter ack — and exactly once.
    expect(rec.events).toEqual([`open:${ORIGIN}`]);
    coordinator.stopHost();
  });

  it('logout tears the stream set down immediately (before any remote wait)', async () => {
    const ff = ackingFetch();
    const manager = newManager(db, ff.fetch);
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    await coordinator.loginHouse(ORIGIN);
    const out = await coordinator.logoutHouse(ORIGIN);
    expect(out.localDisabled).toBe(true);
    expect(rec.events).toEqual([`open:${ORIGIN}`, `stop:${ORIGIN}`]);
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
    coordinator.stopHost();
  });

  it('re-login opens a NEW set; the old set is stopped, not reused', async () => {
    const ff = ackingFetch();
    const manager = newManager(db, ff.fetch);
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    await coordinator.loginHouse(ORIGIN);
    await coordinator.logoutHouse(ORIGIN);
    await manager.waitForQuiet();
    await coordinator.loginHouse(ORIGIN);
    // open → stop → open (the second open is a NEW generation's set).
    expect(rec.events).toEqual([`open:${ORIGIN}`, `stop:${ORIGIN}`, `open:${ORIGIN}`]);
    expect(rec.openSets).toHaveLength(2);
    expect(rec.openSets[0]).not.toBe(rec.openSets[1]);
    coordinator.stopHost();
  });

  it('legacy seeding never revives a house disabled by logout', async () => {
    const ff = ackingFetch();
    const manager = newManager(db, ff.fetch);
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    await coordinator.loginHouse(ORIGIN);
    await coordinator.logoutHouse(ORIGIN);
    await manager.waitForQuiet();
    // A boot-time seedLegacyHouses pass (config re-read / restart) must NOT
    // overwrite the disabled row nor reopen streams.
    coordinator.seedLegacyHouses([ORIGIN]);
    expect(rec.events).toEqual([`open:${ORIGIN}`, `stop:${ORIGIN}`]);
    expect(readParticipation(db, ORIGIN)?.desired).toBe('disabled');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
    coordinator.stopHost();
  });

  it('one house logout leaves other houses untouched', async () => {
    const ff = ackingFetch();
    const manager = newManager(db, ff.fetch);
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    // Two legacy houses.
    coordinator.seedLegacyHouses([ORIGIN, OTHER]);
    expect(rec.events).toEqual([`open:${ORIGIN}`, `open:${OTHER}`]);
    await coordinator.logoutHouse(ORIGIN);
    expect(rec.events).toEqual([`open:${ORIGIN}`, `open:${OTHER}`, `stop:${ORIGIN}`]);
    // B's set is still open and its gate active.
    expect(manager.gateFor(OTHER).isActive()).toBe(true);
    coordinator.stopHost();
  });

  it('stopHost stops stream sets but keeps desired (not a logout)', async () => {
    const ff = ackingFetch();
    const manager = newManager(db, ff.fetch);
    const rec = streamRecorder();
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: rec.factory });
    await coordinator.loginHouse(ORIGIN);
    coordinator.stopHost();
    expect(rec.events).toEqual([`open:${ORIGIN}`, `stop:${ORIGIN}`]);
    // stopHost is not a logout
    expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
  });

  it('serializes the independent public slot through actual teardown and keeps only the latest capture', async () => {
    const manager = newManager(db, ackingFetch().fetch);
    const events: string[] = [];
    let release!: () => void;
    const draining = new Promise<void>(resolve => { release = resolve; });
    let key = 'a';
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: streamRecorder().factory,
      publicStreams: { capture: () => {
        const captured = key;
        return { key: captured, open: () => {
          events.push(`open:${captured}`);
          return { stop: () => { events.push(`stop:${captured}`); return captured === 'a' ? draining : Promise.resolve(); } };
        } };
      } } });
    // No business gate, desired row or session is fabricated for this independent slot.
    coordinator.syncHouse(ORIGIN);
    expect(events).toEqual(['open:a']);
    key = 'b'; coordinator.syncHouse(ORIGIN);
    key = 'c'; coordinator.syncHouse(ORIGIN);
    expect(events).toEqual(['open:a', 'stop:a']);
    release();
    await vi.waitFor(() => expect(events).toEqual(['open:a', 'stop:a', 'open:c']));
    await coordinator.stopHost();
    expect(events.at(-1)).toBe('stop:c');
  });

  it('keeps a newer failed logout fenced when an older login settles, until a fresh explicit login', async () => {
    let started!: () => void;
    const discoveryStarted = new Promise<void>(resolve => { started = resolve; });
    let blockDiscovery = true;
    const successful = ackingFetch();
    const manager = newManager(db, async (input, init) => {
      if (blockDiscovery) { started(); return new Promise<Response>(() => {}); }
      return successful.fetch(input, init);
    });
    db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq) VALUES(?,'install-test','enabled','unsupported',1)", [ORIGIN]);
    const events: string[] = [];
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: streamRecorder().factory,
      publicStreams: { capture: () => readParticipation(db, ORIGIN)?.desired === 'enabled' ? {
        key: 'public', open: () => { events.push('open'); return { stop() { events.push('stop'); } }; },
      } : null } });
    try {
      coordinator.syncHouse(ORIGIN);
      const previousLogin = coordinator.loginHouse(ORIGIN);
      await discoveryStarted;
      const transaction = vi.spyOn(db, 'transaction').mockImplementation(() => { throw new Error('SYNTHETIC_SQLITE_FAILURE'); });
      try { await expect(coordinator.logoutHouse(ORIGIN)).rejects.toThrow('PERSISTENCE_FAILED'); }
      finally { transaction.mockRestore(); }
      expect((await previousLogin).status).toBe('connecting');
      expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
      coordinator.syncHouse(ORIGIN);
      await Promise.resolve(); await Promise.resolve();
      expect(events).toEqual(['open', 'stop']);
      blockDiscovery = false;
      await coordinator.loginHouse(ORIGIN);
      expect(events).toEqual(['open', 'stop', 'open']);
    } finally { await coordinator.stopHost(); }
  });

  it('fences public logout synchronously and joins teardown even when stop reenters sync', async () => {
    const manager = newManager(db, ackingFetch().fetch);
    let stops = 0, opens = 0, release!: () => void;
    const draining = new Promise<void>(resolve => { release = resolve; });
    const coordinator = new HouseLifecycleCoordinator({ manager, streams: streamRecorder().factory,
      publicStreams: { capture: () => readParticipation(db, ORIGIN)?.desired === 'enabled' ? {
        key: 'public', open: () => { opens++; return { stop: () => {
          stops++; coordinator.syncHouse(ORIGIN); return draining;
        } }; },
      } : null } });
    await coordinator.loginHouse(ORIGIN);
    expect(opens).toBe(1);
    const loggedOut = coordinator.logoutHouse(ORIGIN);
    expect(stops).toBe(1);
    await loggedOut;
    let stopped = false;
    const shutdown = coordinator.stopHost().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await shutdown;
    expect(opens).toBe(1);
  });
});

it('a private stream drain failure is latched for the House until resident restart',async()=>{
  const manager=newManager(db,ackingFetch().fetch);
  const stop=vi.fn().mockRejectedValue(new Error('SYNTHETIC_STREAM_DRAIN_FAILED'));
  const coordinator=new HouseLifecycleCoordinator({manager,streams:{open:()=>({stop})}});
  coordinator.seedLegacyHouses([ORIGIN]);
  // This unit isolates the coordinator drain; recovery's real persistent
  // fencing and owner approval are covered by house-recovery.test.ts.
  vi.spyOn(manager,'quiesceHouse').mockResolvedValue(undefined);
  try {
    await expect(coordinator.quiesceHouse(ORIGIN)).rejects.toThrow('SYNTHETIC_STREAM_DRAIN_FAILED');
    await expect(coordinator.quiesceHouse(ORIGIN)).rejects.toThrow('HOUSE_RECOVERY_TEARDOWN_FAILED');
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {await coordinator.stopHost();}
});
