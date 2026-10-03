/**
 * ADR-0051 S2 — plugin-side HouseLifecycleManager unit layer (S2a).
 *
 * Real SQLite (:memory: HostDb / temp-file dual connections) + fake fetch:
 * local-first logout, idempotent retry, ack verification under pinned house
 * keys, generation-gate binding, legacy houses, crash recovery, stopHost
 * keeping desired, cross-connection CAS.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
void vi;
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { ackSigningInput } from '@popclaw/algorithms';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import {
  normalizeHouseOrigin,
  type LifecycleFetch,
} from '../../../src/runtime/house-lifecycle/control-client.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import {
  ensureHouseLifecycleSchema,
  markEnterOutcome,
  readParticipation,
} from '../../../src/runtime/house-lifecycle/participation-store.js';

// --- keys & constants -----------------------------------------------------

const HOUSE_SEED = new Uint8Array(32).fill(0xa1);
const HOUSE_KEY = nacl.sign.keyPair.fromSeed(HOUSE_SEED);
const HOUSE_PUBKEY_HEX = Buffer.from(HOUSE_KEY.publicKey).toString('hex');

const IDENTITY_SEED = new Uint8Array(32).fill(0x33);
const IDENTITY_KEY = nacl.sign.keyPair.fromSeed(IDENTITY_SEED);
const POPCLAW_ID = bs58.encode(IDENTITY_KEY.publicKey);

// RFC 2606 reserved TLD: even if fetch injection drifts and falls back to
// the real fetch, this cannot resolve (stubGlobal is the second guard).
// Real-world domain spellings appear in docs only, never in tests.
const ORIGIN = 'https://demo.loreshow.invalid';
const CLOCK_MS = 1_757_200_000_000; // ms — the manager's clock contract

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

function boardJson(ackPubkey = HOUSE_PUBKEY_HEX): string {
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
      ack_pubkey: ackPubkey,
      operations: ['enter', 'renew', 'leave', 'status', 'action'],
      lease_seconds: 90,
      renew_interval_seconds: 30,
    },
  });
}

function legacyManifestJson(): string {
  return JSON.stringify({
    manifest_version: 1,
    house: { name: 'x', slug: 'x', description: 'x' },
    official_ids: [],
    core_primitives: { profile: true, follow: true, directed_delivery: true },
    event_kinds: [],
    intent_kinds: [],
  });
}

// --- helpers ---------------------------------------------------------------

function bytesResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes as unknown as BodyInit, {
    status,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

function manifestResponse(json = boardJson()): Response {
  return new Response(json, { status: 200, headers: { 'content-type': 'application/json' } });
}

function signedAckBytes(core: Record<string, unknown>, key = HOUSE_KEY): Uint8Array {
  const sig = nacl.sign.detached(ackSigningInput(core), key.secretKey);
  return hsNs.HouseSessionAck.encode({ core, signature: sig, signerPubkey: key.publicKey }).finish();
}

type RecordedCall = { url: string; body?: Uint8Array };

function fakeFetch() {
  const calls: RecordedCall[] = [];
  let responder: (call: RecordedCall) => Promise<Response> | Response = () => new Response('x', { status: 404 });
  const fetch: LifecycleFetch = async (url: string | URL | RequestInfo, init?: RequestInit) => {
    const call = {
      url: String(url),
      body: init?.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : undefined,
    };
    calls.push(call);
    return responder(call);
  };
  return {
    calls,
    fetch,
    respond(fn: (call: RecordedCall) => Promise<Response> | Response) {
      responder = fn;
    },
  };
}

function decodeRequest(body: Uint8Array): Record<string, unknown> {
  return hsNs.HouseSessionRequest.decode(body).core as Record<string, unknown>;
}

function enterAckFor(req: Record<string, unknown>, sessionId: string, revision: number): Response {
  return bytesResponse(
    signedAckBytes({
      houseOrigin: ORIGIN,
      popclawId: POPCLAW_ID,
      installationId: 'install-test',
      requestId: req.requestId,
      opSeq: req.opSeq,
      operation: 1,
      outcome: 1,
      houseRevision: revision,
      sessionId,
      sessionActive: true,
      leaseExpiresAt: 4_102_444_800,
      serverCommittedAt: 1_757_200_000,
      inboxReadToken: 'tok',
    }),
  );
}

function leaveAckFor(req: Record<string, unknown>, outcome: number): Response {
  return bytesResponse(
    signedAckBytes({
      houseOrigin: ORIGIN,
      popclawId: POPCLAW_ID,
      installationId: 'install-test',
      requestId: req.requestId,
      opSeq: req.opSeq,
      operation: 3,
      outcome,
      houseRevision: 3,
      sessionId: 'sess-old',
      sessionActive: false,
      serverCommittedAt: 1_757_200_100,
    }),
  );
}

function newManager(db: HostDb, fetch: LifecycleFetch, retryMs = 60_000): HouseLifecycleManager {
  return new HouseLifecycleManager({
    db,
    signer,
    installationId: 'install-test',
    fetch,
    clock: () => CLOCK_MS,
    retryBackoffMs: retryMs,
    retryMaxMs: retryMs,
  });
}

let db: HostDb;

// No-real-network double guard: any injection drift that falls back to the
// global fetch blows up immediately — unit tests never touch the network
// (work-order red line: never contact the example domain).
beforeEach(() => {
  vi.stubGlobal('fetch', (() => {
    throw new Error('real network use detected in unit test (fetch injection drifted)');
  }) as unknown as typeof fetch);
  db = new InMemoryHostDb();
  ensureHouseLifecycleSchema(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- origin normalization ---------------------------------------------------

describe('normalizeHouseOrigin', () => {
  it('bare domains normalize to https origins', () => {
    expect(normalizeHouseOrigin('demo.loreshow.invalid')).toBe('https://demo.loreshow.invalid');
  });

  it('keeps ports, lowercases scheme/host, drops paths and trailing slashes', () => {
    expect(normalizeHouseOrigin('HTTPS://X.io:8443')).toBe('https://x.io:8443');
    expect(normalizeHouseOrigin('https://x.io/')).toBe('https://x.io');
    expect(normalizeHouseOrigin('https://x.io/some/path')).toBe('https://x.io');
  });

  it('allows explicit http only for loopback fixtures', () => {
    expect(normalizeHouseOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeHouseOrigin('http://localhost:9')).toBe('http://localhost:9');
    expect(() => normalizeHouseOrigin('http://example.com')).toThrow();
  });

  it.each(['/private/tmp/identity.json', './private-memory.md', '../relationships.json', 'house.invalid/private'])(
  'rejects bare paths instead of treating a path component as a house: %s', input => {
    expect(() => normalizeHouseOrigin(input)).toThrow();
  });

  it('rejects cross-origin smuggling shapes', () => {
    const bad: string[] = [
      '\\evil.com',
      'https://\\evil.com',
      'https://user:pass@demo.loreshow.invalid',
      'https://demo.loreshow.invalid?q=1',
      'https://demo.loreshow.invalid#f',
      'ftp://demo.loreshow.invalid',
      '//demo.loreshow.invalid',
      '   ',
      '',
    ];
    const rejected: string[] = [];
    for (const candidate of bad) {
      let threw = false;
      try {
        normalizeHouseOrigin(candidate);
      } catch {
        threw = true;
      }
      if (!threw) rejected.push(candidate);
    }
    expect(rejected).toEqual([]);
  });
});

// --- manager semantics --------------------------------------------------------

describe('HouseLifecycleManager', () => {
  it('login connects after a verified enter ack and opens the gate', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      return enterAckFor(decodeRequest(call.body!), 'sess-1', 1);
    });
    const manager = newManager(db, ff.fetch);
    const result = await manager.loginHouse('demo.loreshow.invalid');

    expect(result.status).toBe('connected');
    expect(result.sessionId).toBe('sess-1');
    expect(result.scope).toBe('local_installation');
    const row = readParticipation(db, ORIGIN);
    expect(row?.desired).toBe('enabled');
    expect(row?.phase).toBe('connected');
    expect(row?.session_id).toBe('sess-1');
    expect(row?.remote_status).toBe('confirmed');
    // ack key bound to the origin
    expect(row?.ack_key_hex).toBe(HOUSE_PUBKEY_HEX);
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
    expect(manager.gateFor('https://other.example').isActive()).toBe(false);
  });

  it('plain repeated login while connected reuses the generation — no second enter', async () => {
    const ff = fakeFetch();
    let enterCount = 0;
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      enterCount += 1;
      return enterAckFor(decodeRequest(call.body!), 'sess-1', 1);
    });
    const manager = newManager(db, ff.fetch);
    const first = await manager.loginHouse(ORIGIN);
    const second = await manager.loginHouse(ORIGIN);
    expect(second.status).toBe('connected');
    expect(second.sessionId).toBe(first.sessionId);
    // connected re-login does not re-send enter
    expect(enterCount).toBe(1);
    expect(readParticipation(db, ORIGIN)?.op_seq).toBe(1);
  });

  it('rejects a forged ack key — never connected, no session', async () => {
    const stranger = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0xee));
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      return bytesResponse(signedAckBytes({
        houseOrigin: ORIGIN,
        popclawId: POPCLAW_ID,
        installationId: 'install-test',
        requestId: req.requestId,
        opSeq: req.opSeq,
        operation: 1,
        outcome: 1,
        houseRevision: 1,
        sessionId: 'sess-evil',
        sessionActive: true,
        serverCommittedAt: 1_757_200_000,
      }, stranger));
    });
    const manager = newManager(db, ff.fetch);
    const result = await manager.loginHouse(ORIGIN);
    expect(result.status).toBe('connecting');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
    expect(readParticipation(db, ORIGIN)?.session_id ?? '').toBe('');
  });

  it('legacy house (no board) reports unsupported — never fake confirmation', async () => {
    const ff = fakeFetch();
    ff.respond((call) =>
      call.url.endsWith('/v1/manifest') ? manifestResponse(legacyManifestJson()) : new Response('', { status: 404 }),
    );
    const manager = newManager(db, ff.fetch);
    const result = await manager.loginHouse(ORIGIN);
    expect(result.status).toBe('unsupported');
    expect(result.errorCode).toBe('HOUSE_LIFECYCLE_UNSUPPORTED');
    expect(readParticipation(db, ORIGIN)?.remote_status).toBe('unsupported');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
  });

  it('an explicit login on a SEEDED legacy house leaves its lane working', async () => {
    // The shape every configured house is in before anyone logs in:
    // seedLegacyHouse writes {op_seq 0, enabled, connected, session ''} and
    // the gate opens on it, because a house with no control plane still
    // serves its streams. Both live houses are exactly this — neither offers
    // a house_session board.
    const ff = fakeFetch();
    ff.respond((call) =>
      call.url.endsWith('/v1/manifest') ? manifestResponse(legacyManifestJson()) : new Response('', { status: 404 }),
    );
    const manager = newManager(db, ff.fetch);
    manager.seedLegacyHouse(ORIGIN);
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true); // the lane works before

    const result = await manager.loginHouse(ORIGIN);

    // Saying "no control plane here" is right. Taking the working lane away
    // to say it is not: an explicit login must not leave a house worse than
    // it found it, and nothing restores this — the re-seed pass is
    // INSERT … ON CONFLICT DO NOTHING, and the gate reads the demoted row.
    expect(result.errorCode).toBe('HOUSE_LIFECYCLE_UNSUPPORTED');
    expect(readParticipation(db, ORIGIN)?.remote_status).toBe('unsupported');
    expect(readParticipation(db, ORIGIN)?.phase).toBe('connected');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
  });

  it('a second login on a seeded legacy house still leaves the lane working', async () => {
    // The first login is the one that used to break it; the second is how an
    // owner discovers it stayed broken. The command bus also replays login
    // rows, so "logged in twice" is not an unusual thing to do.
    const ff = fakeFetch();
    ff.respond((call) =>
      call.url.endsWith('/v1/manifest') ? manifestResponse(legacyManifestJson()) : new Response('', { status: 404 }),
    );
    const manager = newManager(db, ff.fetch);
    manager.seedLegacyHouse(ORIGIN);
    await manager.loginHouse(ORIGIN);
    await manager.loginHouse(ORIGIN);
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
  });

  it('restoring a legacy lane can never revive a house left mid-flight', async () => {
    // Asking to log in legitimately re-enables a house, so disabling it first
    // and then logging in proves nothing. The hazard is the logout that lands
    // WHILE the manifest is in flight: the login already committed its
    // intent, and the restore must not undo the departure that happened after
    // it. Putting a lane back repairs damage this login did — it never
    // re-opens a door the owner closed.
    const ff = fakeFetch();
    ff.respond((call) => {
      if (!call.url.endsWith('/v1/manifest')) return new Response('', { status: 404 });
      db.execute("UPDATE house_participation SET desired='disabled' WHERE house_origin = ?", [normalizeHouseOrigin(ORIGIN)]);
      return manifestResponse(legacyManifestJson());
    });
    const manager = newManager(db, ff.fetch);
    manager.seedLegacyHouse(ORIGIN);

    await manager.loginHouse(ORIGIN);

    // The login abandons the round at its intent check, so it never demotes
    // the row and never reaches the restore. The house is simply left closed,
    // which is the property that matters: a departure taken mid-flight is not
    // undone.
    expect(readParticipation(db, ORIGIN)?.desired).toBe('disabled');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
    // NOTE what this test does NOT reach: `restoreLegacyLane`'s own CAS on
    // desired='enabled'. For a board-less house there is no await between
    // committing the intent and the restore, so no logout can interleave
    // there and no test can drive it. The CAS stays as the second guard for
    // whoever adds an await to that stretch.
  });

  it('logout on a legacy house ends at unsupported, not confirmed', async () => {
    const ff = fakeFetch();
    ff.respond(() => new Response('down', { status: 503 }));
    const manager = newManager(db, ff.fetch);
    db.execute(
      `INSERT INTO house_participation (house_origin, installation_id, op_seq, desired, phase, remote_status, updated_at)
       VALUES (?, 'install-test', 2, 'enabled', 'connected', 'unsupported', 0)`,
      [ORIGIN],
    );
    const out = await manager.logoutHouse(ORIGIN);
    expect(out.localDisabled).toBe(true);
    // legacy ≠ confirmed
    expect(out.remoteStatus).toBe('unsupported');
    expect(readParticipation(db, ORIGIN)?.remote_status).toBe('unsupported');
  });

  it('logout is local-first: persisted disabled + gate closed before network success', async () => {
    const ff = fakeFetch();
    ff.respond(() => new Response('down', { status: 503 }));
    const manager = newManager(db, ff.fetch, 5);
    db.execute(
      `INSERT INTO house_participation (house_origin, installation_id, op_seq, desired, phase, session_id, house_revision, ack_key_hex, remote_status, updated_at)
       VALUES (?, 'install-test', 3, 'enabled', 'connected', 'sess-9', 2, ?, 'confirmed', 0)`,
      [ORIGIN, HOUSE_PUBKEY_HEX],
    );
    const result = await manager.logoutHouse(ORIGIN);
    expect(result.localDisabled).toBe(true);
    expect(result.localQuiesced).toBe(true);
    expect(result.remoteStatus).toBe('pending');
    const row = readParticipation(db, ORIGIN);
    expect(row?.desired).toBe('disabled');
    expect(row?.phase).toBe('disconnected');
    expect(row?.op_seq).toBe(4);
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);

    await new Promise((r) => setTimeout(r, 60));
    const ops = ff.calls.filter((c) => c.url.endsWith('/v1/house-session'));
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      // leave-only restricted channel
      expect(decodeRequest(op.body!).operation).toBe(3);
    }
  });

  it('pending logout + relogin keeps the new session independent', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      if (req.operation === 3) return leaveAckFor(req, 4); // CLOSED
      return enterAckFor(req, `sess-${req.opSeq}`, 5);
    });
    const manager = newManager(db, ff.fetch);
    const login = await manager.loginHouse(ORIGIN);
    expect(login.sessionId).toBe('sess-1');
    const out = await manager.logoutHouse(ORIGIN);
    expect(out.remoteStatus).toBe('pending');
    const again = await manager.loginHouse(ORIGIN);
    expect(again.status).toBe('connected');
    expect(again.sessionId).toBe('sess-3');
    await manager.waitForQuiet();
    const row = readParticipation(db, ORIGIN);
    expect(row?.session_id).toBe('sess-3');
    expect(row?.desired).toBe('enabled');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
  });

  it('restart (fresh manager, same DB) resumes disabled state with leave-only retry', async () => {
    db.execute(
      `INSERT INTO house_participation (house_origin, installation_id, op_seq, desired, phase, session_id, house_revision, ack_key_hex, remote_status, updated_at)
       VALUES (?, 'install-test', 7, 'disabled', 'disconnected', '', 3, ?, 'pending', 0)`,
      [ORIGIN, HOUSE_PUBKEY_HEX],
    );
    db.execute(
      `INSERT INTO house_lifecycle_outbox (request_id, house_origin, op, op_seq, ack_key_hex, installation_id, created_at)
       VALUES ('leave-r9', ?, 'leave', 7, ?, 'install-test', 0)`,
      [ORIGIN, HOUSE_PUBKEY_HEX],
    );
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      expect(req.requestId).toBe('leave-r9');
      expect(req.operation).toBe(3);
      return leaveAckFor(req, 5); // ALREADY_CLOSED
    });
    const manager = newManager(db, ff.fetch);
    await manager.resumePendingOperations();
    await manager.waitForQuiet();
    expect(readParticipation(db, ORIGIN)?.remote_status).toBe('confirmed');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
  });

  it('stopHost cancels gates but keeps desired (not a logout)', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      return enterAckFor(decodeRequest(call.body!), 'sess-1', 1);
    });
    const manager = newManager(db, ff.fetch);
    await manager.loginHouse(ORIGIN);
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
    manager.stopHost();
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
    const row = readParticipation(db, ORIGIN);
    // stopHost is not a logout
    expect(row?.desired).toBe('enabled');
    expect(row?.phase).toBe('connected');
  });

  // --- S2a review counter-examples -------------------------------------------

  it('stale gate handle stays inactive after logout→login (generation binding)', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      if (req.operation === 3) return leaveAckFor(req, 4);
      return enterAckFor(req, `sess-${req.opSeq}`, 1);
    });
    const manager = newManager(db, ff.fetch);
    await manager.loginHouse(ORIGIN);
    const oldGate = manager.gateFor(ORIGIN);
    expect(oldGate.isActive()).toBe(true);
    await manager.logoutHouse(ORIGIN);
    // captured handle dies with its generation
    expect(oldGate.isActive()).toBe(false);
    await manager.waitForQuiet();
    await manager.loginHouse(ORIGIN); // new generation
    // old handle does NOT revive after relogin
    expect(oldGate.isActive()).toBe(false);
    // fresh handle sees the new generation
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
  });

  it('leave retry verifies against the pinned outbox key — a swapped house key never settles', async () => {
    const stranger = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x66));
    const enterFetch = fakeFetch();
    enterFetch.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      return enterAckFor(decodeRequest(call.body!), 'sess-1', 1);
    });
    const manager = newManager(db, enterFetch.fetch, 5);
    await manager.loginHouse(ORIGIN);
    await manager.logoutHouse(ORIGIN);
    manager.stopHost();

    // The control endpoint now answers with a self-consistent ACK under a
    // DIFFERENT house key; a fresh manager (post-crash resume) must not settle.
    const swappedFetch = fakeFetch();
    swappedFetch.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      return bytesResponse(signedAckBytes({
        houseOrigin: ORIGIN,
        popclawId: POPCLAW_ID,
        installationId: 'install-test',
        requestId: req.requestId,
        opSeq: req.opSeq,
        operation: 3,
        outcome: 4,
        houseRevision: 9,
        sessionId: 'sess-x',
        sessionActive: false,
        serverCommittedAt: 1_757_200_100,
      }, stranger));
    });
    const manager2 = newManager(db, swappedFetch.fetch, 5);
    await manager2.resumePendingOperations();
    await new Promise((r) => setTimeout(r, 80));
    const row = readParticipation(db, ORIGIN);
    // swapped-key ACK does not settle the leave
    expect(row?.remote_status).toBe('pending');
    expect(row?.remote_error).toContain('verification');
    manager2.stopHost();
  });

  it('late enter outcome cannot revive a newer logout (CAS)', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      return enterAckFor(decodeRequest(call.body!), 'sess-1', 1);
    });
    const manager = newManager(db, ff.fetch);
    await manager.loginHouse(ORIGIN); // op_seq=1 connected
    await manager.logoutHouse(ORIGIN); // op_seq=2 disabled (leave worker will
    // spin against the enter-only responder; stopped at the end)
    const applied = markEnterOutcome(db, ORIGIN, 1, {
      sessionId: 'sess-late',
      houseRevision: 1,
      phase: 'connected',
      ackKeyHex: HOUSE_PUBKEY_HEX,
      now: 1_757_200_300,
    });
    expect(applied).toBe(false);
    const row = readParticipation(db, ORIGIN);
    expect(row?.desired).toBe('disabled');
    expect(row?.session_id).toBe('');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
    manager.stopHost();
  });

  it('ack key binding: a silently swapped house key on re-login is refused', async () => {
    const otherHouse = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x55));
    let swapped = false;
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) {
        return manifestResponse(boardJson(swapped ? Buffer.from(otherHouse.publicKey).toString('hex') : HOUSE_PUBKEY_HEX));
      }
      return enterAckFor(decodeRequest(call.body!), 'sess-1', 1);
    });
    const manager = newManager(db, ff.fetch);
    const first = await manager.loginHouse(ORIGIN);
    expect(first.status).toBe('connected');
    swapped = true;
    await manager.logoutHouse(ORIGIN);
    await new Promise((r) => setTimeout(r, 30));
    manager.stopHost();
    await manager.waitForQuiet();
    const restarted = newManager(db, ff.fetch);
    const second = await restarted.loginHouse(ORIGIN);
    restarted.stopHost();
    expect(second.status).toBe('connecting');
    expect(second.errorCode).toBe('AUTH_INVALID');
    expect(readParticipation(db, ORIGIN)?.session_id).toBe('');
  });

  it('unknown-key leave stays pending in background until an explicit login TOFUs', async () => {
    const down = fakeFetch();
    down.respond(() => new Response('down', { status: 503 }));
    const m1 = newManager(db, down.fetch, 10_000);
    const out = await m1.logoutHouse(ORIGIN);
    expect(out.remoteStatus).toBe('pending');
    // Relogin attempt offline: intent persists, discovery unknown.
    const relogin = await m1.loginHouse(ORIGIN);
    expect(relogin.status).toBe('connecting');
    expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
    expect(db.queryAll('SELECT * FROM house_lifecycle_outbox WHERE settled_at IS NULL')).toHaveLength(1);

    // Restart with the network UP but NO trusted key anywhere: background
    // classification must NOT TOFU (finding 6 follow-up) — the leave stays
    // pending with an explanatory error, no board fetch on the retry path.
    const up = fakeFetch();
    up.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      if (Number(req.operation) === 1) return enterAckFor(req, 'sess-login', 2);
      return leaveAckFor(req, 4);
    });
    const m2 = newManager(db, up.fetch, 10);
    await m2.resumePendingOperations();
    await m2.waitForQuiet();
    // desired is 'enabled' (the newer relogin intent), so the explanatory
    // error cannot land on the participation row — the observable contract is
    // the outbox row staying OPEN with zero background binding writes.
    expect(db.queryAll('SELECT * FROM house_lifecycle_outbox WHERE settled_at IS NULL')).toHaveLength(1);
    const keyNow = readParticipation(db, ORIGIN)?.ack_key_hex ?? '';
    // no key was TOFU'd by background traffic
    expect(keyNow).toBe('');

    // An explicit login TOFUs the key (persisted before its ENTER) — and the
    // NEXT resume settles the old leave under that login-established key.
    const login = await m2.loginHouse(ORIGIN);
    expect(login.status).toBe('connected');
    await m2.resumePendingOperations();
    await m2.waitForQuiet();
    // settled under the login-established key; intent not clobbered
    expect(db.queryAll('SELECT * FROM house_lifecycle_outbox WHERE settled_at IS NULL')).toHaveLength(0);
    expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
  });

  it('a logout landing during the manifest await stops the old login cold', async () => {
    // Deferred manifest: the login parks on discovery; logout commits; the
    // manifest THEN resolves — the old login must not re-enable or send.
    let releaseManifest!: (r: Response) => void;
    const manifestGate = new Promise<Response>((resolve) => { releaseManifest = resolve; });
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestGate;
      return enterAckFor(decodeRequest(call.body!), 'sess-stale', 1);
    });
    const manager = newManager(db, ff.fetch);
    const loginPromise = manager.loginHouse(ORIGIN);
    await new Promise((r) => setTimeout(r, 10)); // login is parked in discovery
    await manager.logoutHouse(ORIGIN);
    releaseManifest(manifestResponse());
    const result = await loginPromise;
    // the disabled house is not re-enabled
    expect(result.status).toBe('connecting');
    const row = readParticipation(db, ORIGIN);
    expect(row?.desired).toBe('disabled');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
    // And no ENTER was ever sent — only the manifest request happened.
    const enters = ff.calls.filter((c) => c.url.endsWith('/v1/house-session'));
    expect(enters).toHaveLength(0);
    manager.stopHost();
  });

  // Reviewer probe (review_more #4): per-CALL discovery state — house A's
  // successful discovery must never turn house B's network failure into a
  // probed-legacy "unsupported".
  it('a failed duplicate cannot downgrade an already successful enter', async () => {
    const ff = fakeFetch();
    let rejectFirst!: (reason: Error) => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => { reached = r; });
    const delayed = new Promise<Response>((_r, reject) => { rejectFirst = reject; });
    let enters = 0;
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      enters += 1;
      if (enters === 1) {
        reached();
        return delayed;
      }
      return enterAckFor(req, 'success-survives', 1);
    });
    const manager = newManager(db, ff.fetch);
    const first = manager.loginHouse(ORIGIN);
    await arrived;
    const second = await manager.loginHouse(ORIGIN);
    expect(second.status).toBe('connected');
    rejectFirst(new Error('delayed duplicate transport failure'));
    await first;
    const phase = readParticipation(db, ORIGIN)?.phase;
    manager.stopHost();
    // settled success must not be downgraded by obsolete failure
    expect(phase).toBe('connected');
  });

  // Reviewer probe (review_races #2): stopHost must abort an outstanding
  // leave transport — the worker ends instead of waiting forever.
  it('stopHost aborts an outstanding leave transport', async () => {
    let release!: (r: Response) => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => { reached = r; });
    let leaveReq!: Record<string, unknown>;
    const controlledFetch: LifecycleFetch = async (url: string | URL | RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
      if (Number(req.operation) === 1) return enterAckFor(req, 'session', 1);
      leaveReq = req;
      return new Promise<Response>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by caller')), { once: true });
        reached();
      });
    };
    const manager = newManager(db, controlledFetch, 10);
    await manager.loginHouse(ORIGIN);
    await manager.logoutHouse(ORIGIN);
    await arrived;
    manager.stopHost();
    const quiet = await Promise.race([
      manager.waitForQuiet().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    release(leaveAckFor(leaveReq, 4));
    await manager.waitForQuiet();
    // stop must cancel transport rather than wait forever for it
    expect(quiet).toBe(true);
  });

  it('a logout landing during the manifest await stops the old login cold', async () => {
    // Deferred manifest: the login parks on discovery; logout commits; the
    // manifest THEN resolves — the old login must not re-enable or send.
    let releaseManifest!: (r: Response) => void;
    const manifestGate = new Promise<Response>((resolve) => { releaseManifest = resolve; });
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestGate;
      return enterAckFor(decodeRequest(call.body!), 'sess-stale', 1);
    });
    const manager = newManager(db, ff.fetch);
    const loginPromise = manager.loginHouse(ORIGIN);
    await new Promise((r) => setTimeout(r, 10)); // login is parked in discovery
    await manager.logoutHouse(ORIGIN);
    releaseManifest(manifestResponse());
    const result = await loginPromise;
    // the disabled house is not re-enabled
    expect(result.status).toBe('connecting');
    const row = readParticipation(db, ORIGIN);
    expect(row?.desired).toBe('disabled');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
    // And no ENTER was ever sent — only the manifest request happened.
    const enters = ff.calls.filter((c) => c.url.endsWith('/v1/house-session'));
    expect(enters).toHaveLength(0);
    manager.stopHost();
  });

  // Reviewer probe (review_more #4): per-CALL discovery state — house A's
  // successful discovery must never turn house B's network failure into a
  // probed-legacy "unsupported".

  it('concurrent discovery of A cannot mark unreachable B unsupported', async () => {
    const ff = fakeFetch();
    let rejectB!: (reason: Error) => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => { reached = r; });
    const pendingB = new Promise<Response>((_r, reject) => { rejectB = reject; });
    ff.respond((call) => {
      if (call.url.startsWith('https://other.invalid')) {
        reached();
        return pendingB;
      }
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      return enterAckFor(decodeRequest(call.body!), 'A-session', 1);
    });
    const manager = newManager(db, ff.fetch);
    const b = manager.loginHouse('https://other.invalid');
    await arrived;
    await manager.loginHouse(ORIGIN); // A succeeds while B's discovery hangs
    rejectB(new Error('B temporarily offline'));
    const result = await b;
    manager.stopHost();
    // A success cannot make B a probed legacy house
    expect(result.status).toBe('connecting');
    const rowB = readParticipation(db, 'https://other.invalid');
    expect(rowB?.remote_status).not.toBe('unsupported');
  });

  // Reviewer probe (review_more #2): a restarted manager must not treat an
  // expired durable "connected" row as live — the fastpath is lease-checked
  // and an offline recovery window authorizes nothing.
  it('a restarted manager cannot treat an expired durable connected row as live', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      return bytesResponse(signedAckBytes({
        houseOrigin: ORIGIN,
        popclawId: POPCLAW_ID,
        installationId: 'install-test',
        requestId: req.requestId,
        opSeq: req.opSeq,
        operation: 1,
        outcome: 1,
        houseRevision: 1,
        sessionId: 'expired-after-restart',
        sessionActive: true,
        leaseExpiresAt: CLOCK_MS / 1000 + 1, // one second of lease only
        serverCommittedAt: CLOCK_MS / 1000,
        inboxReadToken: 'tok',
      }));
    });
    const first = newManager(db, ff.fetch);
    await first.loginHouse(ORIGIN);
    first.stopHost();
    // Recovery 120s later with the network GONE: the durable row says
    // connected, but its lease is long past — no gate may open.
    ff.respond(() => {
      throw new Error('offline during recovery');
    });
    const recovered = new HouseLifecycleManager({
      db,
      signer,
      installationId: 'install-test',
      fetch: ff.fetch,
      clock: () => CLOCK_MS + 120_000,
    });
    await recovered.loginHouse(ORIGIN);
    const active = recovered.gateFor(ORIGIN).isActive();
    recovered.stopHost();
    // expired session must not authorize offline recovery
    expect(active).toBe(false);
  });

  it('a logout landing during signing stops the ENTER before the fetch', async () => {
    // Deterministic deferred signing: the signer parks; logout aborts the
    // login flight; the ENTER fetch must never fire.
    let releaseSign!: () => void;
    const signGate = new Promise<void>((resolve) => { releaseSign = resolve; });
    const slowSigner = {
      publicKey: signer.publicKey,
      popclawId: signer.popclawId,
      sign: async (bytes: Uint8Array) => {
        await signGate;
        return nacl.sign.detached(bytes, IDENTITY_KEY.secretKey);
      },
    };
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      return enterAckFor(decodeRequest(call.body!), 'sess-x', 1);
    });
    const manager = new HouseLifecycleManager({
      db, signer: slowSigner, installationId: 'install-test', fetch: ff.fetch,
      clock: () => CLOCK_MS,
    });
    const loginPromise = manager.loginHouse(ORIGIN);
    await new Promise((r) => setTimeout(r, 10)); // parked inside signer.sign
    await manager.logoutHouse(ORIGIN);
    releaseSign();
    const result = await loginPromise;
    expect(result.status).toBe('connecting');
    // The logout's own LEAVE may legitimately be on the wire; the ENTER must
    // not be (count by decoded operation).
    const sent = ff.calls
      .filter((c) => c.url.endsWith('/v1/house-session'))
      .map((c) => decodeRequest(c.body!));
    // no ENTER after the logout abort
    expect(sent.filter((r) => r.operation === 1)).toHaveLength(0);
    manager.stopHost();
  });

  it('an ack answering a DIFFERENT operation never verifies (leave receipt, entered outcome)', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      // Correct house key, correct request echo, but operation = LEAVE with
      // an Entered outcome — signature valid, semantics crossed.
      return bytesResponse(signedAckBytes({
        houseOrigin: ORIGIN,
        popclawId: POPCLAW_ID,
        installationId: 'install-test',
        requestId: req.requestId,
        opSeq: req.opSeq,
        operation: 3,
        outcome: 1,
        houseRevision: 1,
        sessionId: 'sess-crossed',
        sessionActive: true,
        serverCommittedAt: 1_757_200_000,
      }));
    });
    const manager = newManager(db, ff.fetch);
    const result = await manager.loginHouse(ORIGIN);
    // crossed-operation ack does not connect
    expect(result.status).toBe('connecting');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
  });

  // Reviewer probe (review_remaining, re-pinned after f0c533b1): a SECOND
  // manager's logout while THIS manager's login parks in signing must
  // suppress the ENTER — local AbortSignals cannot see it; the persistent
  // row check (authorizeSend) after signing is the gate.
  it('another manager logout during signing suppresses ENTER', async () => {
    const ff = fakeFetch();
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => { reached = r; });
    const delayed = new Promise<void>((r) => { release = r; });
    let signCalls = 0;
    const delayedSigner = {
      ...signer,
      sign: async (bytes: Uint8Array) => {
        signCalls += 1;
        if (signCalls === 1) {
          reached();
          await delayed;
        }
        return signer.sign(bytes);
      },
    };
    ff.respond((c) => {
      if (c.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(c.body!);
      return Number(req.operation) === 1 ? enterAckFor(req, 'late', 1) : leaveAckFor(req, 4);
    });
    const first = new HouseLifecycleManager({ db, signer: delayedSigner, installationId: 'install-test', fetch: ff.fetch, clock: () => CLOCK_MS });
    const second = newManager(db, ff.fetch, 10);
    const pending = first.loginHouse(ORIGIN);
    await arrived;
    await second.logoutHouse(ORIGIN);
    release();
    await pending;
    first.stopHost();
    second.stopHost();
    await second.waitForQuiet();
    const enters = ff.calls.filter((c) => c.body && Number(decodeRequest(c.body).operation) === 1);
    // persistent gate must be checked after signing across managers
    expect(enters).toHaveLength(0);
  });

  it('PERSISTENCE_FAILED still closes the in-memory gate (logout)', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      return enterAckFor(decodeRequest(call.body!), 'sess-p', 1);
    });
    const manager = newManager(db, ff.fetch);
    await manager.loginHouse(ORIGIN);
    const oldGate = manager.gateFor(ORIGIN);
    expect(oldGate.isActive()).toBe(true);
    // Force the local transaction to throw without breaking the read path
    // (spy on the transaction method — same shape as the reviewer's probe).
    const spy = vi
      .spyOn(db, 'transaction')
      .mockImplementationOnce(() => { throw new Error('simulated persistence failure'); });
    await expect(manager.logoutHouse(ORIGIN)).rejects.toThrow(/PERSISTENCE_FAILED/);
    spy.mockRestore();
    // memory gate closed even though persistence failed
    expect(oldGate.isActive()).toBe(false);
    manager.stopHost();
  });

  it('the connected fastpath does not outlive the server lease', async () => {
    let clock = CLOCK_MS;
    const ff = fakeFetch();
    let enters = 0;
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      enters += 1;
      const req = decodeRequest(call.body!);
      return bytesResponse(signedAckBytes({
        houseOrigin: ORIGIN,
        popclawId: POPCLAW_ID,
        installationId: 'install-test',
        requestId: req.requestId,
        opSeq: req.opSeq,
        operation: 1,
        outcome: 1,
        houseRevision: 1,
        sessionId: `sess-${req.opSeq}`,
        sessionActive: true,
        leaseExpiresAt: Math.floor(clock / 1000) + 10,
        serverCommittedAt: Math.floor(clock / 1000),
      }));
    });
    const manager = new HouseLifecycleManager({
      db, signer, installationId: 'install-test', fetch: ff.fetch, clock: () => clock,
    });
    const first = await manager.loginHouse(ORIGIN);
    expect(first.status).toBe('connected');
    // The captured gate expires with the lease — no new login call needed.
    const gate = manager.gateFor(ORIGIN);
    expect(gate.isActive()).toBe(true);
    clock += 20_000;
    // gate expires with the server lease
    expect(gate.isActive()).toBe(false);
    // And the fastpath refuses the dead session: a fresh ENTER runs.
    const second = await manager.loginHouse(ORIGIN);
    // expired lease forces a fresh enter, not a fastpath reuse
    expect(enters).toBe(2);
    expect(second.status).toBe('connected');
    expect(readParticipation(db, ORIGIN)?.op_seq).toBe(2);
  });

  // --- Configured ack-key pins (handoff §18:26 shared injection point) ---------

  it('a configured pin wins over the board key and is persisted as the binding', async () => {
    const pinned = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x77));
    const pinnedHex = Buffer.from(pinned.publicKey).toString('hex');
    const ff = fakeFetch();
    // The board advertises the PINNED key; acks are signed by it.
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse(boardJson(pinnedHex));
      const req = decodeRequest(call.body!);
      return bytesResponse(signedAckBytes({
        houseOrigin: ORIGIN,
        popclawId: POPCLAW_ID,
        installationId: 'install-test',
        requestId: req.requestId,
        opSeq: req.opSeq,
        operation: 1,
        outcome: 1,
        houseRevision: 1,
        sessionId: 'sess-pin',
        sessionActive: true,
        leaseExpiresAt: CLOCK_MS / 1000 + 3600,
        serverCommittedAt: 1_757_200_000,
      }, pinned));
    });
    const manager = new HouseLifecycleManager({
      db, signer, installationId: 'install-test', fetch: ff.fetch,
      clock: () => CLOCK_MS, configuredPinFor: () => pinnedHex,
    });
    const result = await manager.loginHouse(ORIGIN);
    expect(result.status).toBe('connected');
    expect(readParticipation(db, ORIGIN)?.ack_key_hex).toBe(pinnedHex);
  });

  it('a board advertising a different key than the pin fails closed', async () => {
    const pinned = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x77));
    const pinnedHex = Buffer.from(pinned.publicKey).toString('hex');
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) {
        // Board claims a DIFFERENT key than the operator pin.
        return manifestResponse();
      }
      return enterAckFor(decodeRequest(call.body!), 'sess-x', 1);
    });
    const manager = new HouseLifecycleManager({
      db, signer, installationId: 'install-test', fetch: ff.fetch,
      clock: () => CLOCK_MS, configuredPinFor: () => pinnedHex,
    });
    const result = await manager.loginHouse(ORIGIN);
    expect(result.status).toBe('connecting');
    expect(result.errorCode).toBe('AUTH_INVALID');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
  });

  it('accepts a base58-spelled pin (same 32 bytes, G1 encoding)', async () => {
    const { normalizeAckKeyHex } = await import('../../../src/runtime/house-lifecycle/control-client.js');
    const pinned = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x77));
    const pinnedB58 = bs58.encode(pinned.publicKey);
    expect(normalizeAckKeyHex(pinnedB58)).toBe(Buffer.from(pinned.publicKey).toString('hex'));
    expect(normalizeAckKeyHex('')).toBe('');
    expect(() => normalizeAckKeyHex('not-a-key')).toThrow();
  });

  it('concurrent first logins with different keys leave exactly one binding', async () => {
    const otherHouse = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x88));
    const otherHex = Buffer.from(otherHouse.publicKey).toString('hex');
    // Two managers, one SQLite file, racing the FIRST login with DIFFERENT
    // discovered keys (as if two processes saw different boards).
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'popclaw-lifecycle-pin-'));
    try {
      const { LocalHostDb } = await import('../../../src/host/local-host-db.js');
      const file = path.join(tmp, 'participation.db');
      const db1 = new LocalHostDb(file);
      const db2 = new LocalHostDb(file);
      const mkFetch = (hex: string, key: nacl.SignKeyPair) => {
        const ff = fakeFetch();
        ff.respond((call) => {
          if (call.url.endsWith('/v1/manifest')) return manifestResponse(boardJson(hex));
          const req = decodeRequest(call.body!);
          return bytesResponse(signedAckBytes({
            houseOrigin: ORIGIN,
            popclawId: POPCLAW_ID,
            installationId: 'install-test',
            requestId: req.requestId,
            opSeq: req.opSeq,
            operation: 1,
            outcome: 1,
            houseRevision: 1,
            sessionId: `sess-${hex.slice(0, 4)}`,
            sessionActive: true,
            leaseExpiresAt: CLOCK_MS / 1000 + 3600,
            serverCommittedAt: 1_757_200_000,
          }, key));
        });
        return ff.fetch;
      };
      const m1 = new HouseLifecycleManager({
        db: db1, signer, installationId: 'install-test',
        fetch: mkFetch(HOUSE_PUBKEY_HEX, HOUSE_KEY), clock: () => CLOCK_MS,
      });
      const m2 = new HouseLifecycleManager({
        db: db2, signer, installationId: 'install-test',
        fetch: mkFetch(otherHex, otherHouse), clock: () => CLOCK_MS,
      });
      const [r1, r2] = await Promise.all([m1.loginHouse(ORIGIN), m2.loginHouse(ORIGIN)]);
      // Exactly one binding survives; the other must NOT have connected under
      // the winner's key (its ack verifies under a different key than the
      // persisted binding → refused).
      const outcomes = [r1.status, r2.status].sort();
      expect(outcomes).toEqual(['connected', 'connecting']);
      const row = readParticipation(db1, ORIGIN);
      expect([HOUSE_PUBKEY_HEX, otherHex]).toContain(row?.ack_key_hex);
      db1.close();
      db2.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // --- Round-3 trust/transport probes (review_trust_transport) ---------------

  it('verified BUSY surfaces the structured EXECUTOR_BUSY error', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      return bytesResponse(signedAckBytes({
        houseOrigin: ORIGIN,
        popclawId: POPCLAW_ID,
        installationId: 'install-test',
        requestId: req.requestId,
        opSeq: req.opSeq,
        operation: 1,
        outcome: 7,
        errorCode: 4,
        serverCommittedAt: CLOCK_MS / 1000,
      }));
    });
    const manager = newManager(db, ff.fetch);
    const result = await manager.loginHouse(ORIGIN);
    manager.stopHost();
    expect(result.errorCode).toBe('EXECUTOR_BUSY');
  });

  it('logout alone cannot create the first TOFU pin in background', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      return leaveAckFor(decodeRequest(call.body!), 4);
    });
    const manager = newManager(db, ff.fetch, 5);
    await manager.logoutHouse(ORIGIN);
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    manager.stopHost();
    await manager.waitForQuiet();
    // only explicit login may create the first TOFU pin
    expect(readParticipation(db, ORIGIN)?.ack_key_hex).toBe('');
  });

  it('unknown-key logout honors the configured pin (background adopts operator trust)', async () => {
    const ff = fakeFetch();
    ff.respond((call) => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      return leaveAckFor(decodeRequest(call.body!), 4);
    });
    const otherKey = Buffer.from(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x77)).publicKey).toString('hex');
    const manager = new HouseLifecycleManager({
      db, signer, installationId: 'install-test', fetch: ff.fetch,
      clock: () => CLOCK_MS, configuredPinFor: () => otherKey,
    });
    await manager.logoutHouse(ORIGIN);
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    manager.stopHost();
    await manager.waitForQuiet();
    expect(readParticipation(db, ORIGIN)?.ack_key_hex).toBe(otherKey);
    // A pinned-but-foreign board ack never settles the leave.
    expect(readParticipation(db, ORIGIN)?.remote_status).not.toBe('confirmed');
  });

  it('a caller signal preserves the discovery timeout', async () => {
    const { fetchSessionBoard } = await import('../../../src/runtime/house-lifecycle/control-client.js');
    const timeout = new AbortController();
    const caller = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let captured: AbortSignal | undefined;
    const transport: LifecycleFetch = async (_url: string | URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        captured = init?.signal as AbortSignal;
        captured.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const pending = fetchSessionBoard(ORIGIN, transport, caller.signal).catch(() => null);
    timeout.abort();
    const timedOut = captured?.aborted;
    caller.abort();
    await pending;
    spy.mockRestore();
    // timeout must remain effective with a caller cancellation signal
    expect(timedOut).toBe(true);
  });

  // --- resume race (review in-flight reminder): a leave worker parked in
  // its fetch when ownership is lost must never settle; the post-resume
  // worker — a NEW generation, not a revival — sends and settles exactly once.

  it('quiesce→resume: the old worker never settles, a fresh worker does', async () => {
    let releaseNext!: (r: Response) => void;
    let arrived!: () => void;
    const arrivedPromise = new Promise<void>((r) => { arrived = r; });
    const attempts: number[] = [];
    let attempt = 0;
    const parkedFetch: LifecycleFetch = async (url: string | URL | RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith('/v1/manifest')) return manifestResponse();
      attempt += 1;
      const mine = attempt;
      attempts.push(mine);
      arrived();
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by pause')), { once: true });
        const origRelease = releaseNext;
        releaseNext = (r: Response) => {
          void origRelease?.(r);
          resolve(r);
        };
      });
    };
    const ff = { fetch: parkedFetch };
    const manager = new HouseLifecycleManager({
      db, signer, installationId: 'install-test', fetch: ff.fetch,
      clock: () => CLOCK_MS, retryBackoffMs: 60_000, retryMaxMs: 60_000,
    });
    // A pinned binding so the leave can verify acks.
    db.execute(
      `INSERT INTO house_participation (house_origin, installation_id, op_seq, desired, phase, session_id, house_revision, lease_expires_at, inbox_read_token, ack_key_hex, remote_status, updated_at)
       VALUES (?, 'install-test', 1, 'enabled', 'connected', 'sess-q', 1, 0, '', ?, 'confirmed', 0)`,
      [ORIGIN, HOUSE_PUBKEY_HEX],
    );
    const out = await manager.logoutHouse(ORIGIN);
    expect(out.remoteStatus).toBe('pending');
    await arrivedPromise; // the worker's first fetch is parked

    // Ownership lost mid-flight: the old worker's captured pause signal dies.
    manager.quiesce();
    // Resume BEFORE releasing the parked fetch: the drain waits for the old
    // worker to exit (its fetch aborts via the pause signal), then a NEW
    // generation worker takes over the same outbox row.
    const resumeDone = manager.resumeAfterOwnership();
    await new Promise((r) => setTimeout(r, 20)); // let the abort propagate
    // The OLD attempt aborted — nothing settled by it.
    expect(db.queryAll('SELECT * FROM house_lifecycle_outbox WHERE settled_at IS NOT NULL')).toHaveLength(0);
    // The NEW worker sends its own leave (attempt 2); release it with a
    // verified CLOSED ack.
    await arrivedPromise; // wait is already resolved; new attempt parks again
    await new Promise((r) => setTimeout(r, 10));
    releaseNext(leaveAckFor({ requestId: out.operationId, opSeq: 2, operation: 3 }, 4));
    await resumeDone;
    await manager.waitForQuiet();
    // Exactly one settle, by the new worker; the old attempt contributed none.
    expect(db.queryAll('SELECT * FROM house_lifecycle_outbox WHERE settled_at IS NOT NULL')).toHaveLength(1);
    expect(readParticipation(db, ORIGIN)?.remote_status).toBe('confirmed');
    expect(attempts.length).toBe(2);
    manager.stopHost();
  });

  it('a quiesce during the resume drain cancels that resume (epoch CAS)', async () => {
    // Deterministic drain race: the OLD worker parks in its fetch (never
    // settles); resume #1 starts draining (waiting on it); a quiesce lands;
    // the old fetch then aborts via its captured pause signal. The STALE
    // resume must spawn NO new worker (zero new sends). A CURRENT resume
    // afterwards sends exactly one leave and settles the outbox row.
    // Per-attempt resolver array: each fetch entry pushes its own resolver
    // and counts an attempt at ENTRY time (not resolution time) — a stale
    // resume releasing nothing shows up as attempt count staying at 1.
    interface Parked {
      resolve: (r: Response) => void;
      reject: (e: Error) => void;
    }
    const parked: Parked[] = [];
    let arriveOld!: () => void;
    const oldParked = new Promise<void>((r) => { arriveOld = () => r(); });
    let arriveNew!: () => void;
    const newParked = new Promise<void>((r) => { arriveNew = () => r(); });
    const parkedFetch: LifecycleFetch = async (url: string | URL | RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith('/v1/manifest')) return manifestResponse();
      const index = parked.length; // attempt number - 1
      if (index === 0) arriveOld();
      if (index === 1) arriveNew();
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        parked.push({ resolve, reject });
      });
    };
    const manager = new HouseLifecycleManager({
      db, signer, installationId: 'install-test', fetch: parkedFetch,
      clock: () => CLOCK_MS, retryBackoffMs: 60_000, retryMaxMs: 60_000,
    });
    db.execute(
      `INSERT INTO house_participation (house_origin, installation_id, op_seq, desired, phase, session_id, house_revision, lease_expires_at, inbox_read_token, ack_key_hex, remote_status, updated_at)
       VALUES (?, 'install-test', 1, 'enabled', 'connected', 'sess-c', 1, 0, '', ?, 'confirmed', 0)`,
      [ORIGIN, HOUSE_PUBKEY_HEX],
    );
    const out = await manager.logoutHouse(ORIGIN);
    expect(out.remoteStatus).toBe('pending');
    await oldParked; // attempt 1 (the old worker) parked in its fetch

    // Resume #1 begins draining; a quiesce lands IMMEDIATELY — its epoch is
    // dead. The old fetch aborts via its captured pause signal, the drain
    // completes, the post-drain CAS rejects → the STALE resume spawns
    // NOTHING (attempt count must stay at 1 and the row unsettled).
    manager.quiesce();
    const staleResume = manager.resumeAfterOwnership();
    manager.quiesce();
    await staleResume;
    expect(parked).toHaveLength(1);
    expect(db.queryAll('SELECT * FROM house_lifecycle_outbox WHERE settled_at IS NOT NULL')).toHaveLength(0);

    // A CURRENT resume takes the same unsettled row: exactly one more
    // attempt, resolved with a verified CLOSED ack → settled once.
    const currentResume = manager.resumeAfterOwnership();
    await newParked; // attempt 2 (the new worker) parked
    const second: Parked | undefined = parked[1];
    second?.resolve(leaveAckFor({ requestId: out.operationId, opSeq: 2, operation: 3 }, 4));
    await currentResume;
    await manager.waitForQuiet();
    // exactly two fetch entries: old (aborted) + new (settled)
    expect(parked).toHaveLength(2);
    expect(db.queryAll('SELECT * FROM house_lifecycle_outbox WHERE settled_at IS NOT NULL')).toHaveLength(1);
    expect(readParticipation(db, ORIGIN)?.remote_status).toBe('confirmed');
    manager.stopHost();
  });

  it('two connections on one SQLite file keep independent outbox rows', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'popclaw-lifecycle-'));
    try {
      const { LocalHostDb } = await import('../../../src/host/local-host-db.js');
      const file = path.join(tmp, 'participation.db');
      const db1 = new LocalHostDb(file);
      const db2 = new LocalHostDb(file);
      const ff = fakeFetch();
      ff.respond((call) => {
        if (call.url.endsWith('/v1/manifest')) return manifestResponse();
        const req = decodeRequest(call.body!);
        if (req.operation === 3) {
          return new Response('stall', { status: 503 });
        }
        return enterAckFor(req, `sess-${req.opSeq}`, 4);
      });
      const m1 = newManager(db1, ff.fetch, 60_000);
      await m1.loginHouse(ORIGIN);
      const out1 = await m1.logoutHouse(ORIGIN);
      const m2 = newManager(db2, ff.fetch, 60_000);
      const login2 = await m2.loginHouse(ORIGIN);
      expect(login2.status).toBe('connected');
      const out2 = await m2.logoutHouse(ORIGIN);
      const open = db1
        .queryAll<{ request_id: string }>('SELECT request_id FROM house_lifecycle_outbox WHERE settled_at IS NULL')
        .map((r) => r.request_id)
        .sort();
      expect(open).toEqual([out1.operationId, out2.operationId].sort());
      db1.close();
      db2.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});


describe('manager shutdown control drain', () => {
  it.each(['fetch', 'body', 'popclawId', 'publicKey', 'sign'] as const)('waitForQuiet drains a canceled login whose %s stage ignores abort', async (stage) => {
    let started!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    const hanging = async <T>(): Promise<T> => { started(); return new Promise<T>(() => {}); };
    const stalledSigner = ['popclawId', 'publicKey', 'sign'].includes(stage) ? { ...signer, [stage]: hanging } : signer;
    const manager = new HouseLifecycleManager({ db, signer: stalledSigner, installationId: 'install-test', clock: () => CLOCK_MS, fetch: async () => {
      if (stage === 'fetch') return hanging<Response>();
      if (stage === 'body') return new Response(new ReadableStream<Uint8Array>({pull: () => hanging<void>()}));
      return manifestResponse();
    } });
    let finished = false;
    const login = manager.loginHouse(ORIGIN).finally(() => { finished = true; });
    await entered;
    manager.stopHost();
    await manager.waitForQuiet();
    expect(finished).toBe(true);
    await login;
    db.close();
  });
});


describe('session renewal', () => {
  async function setup(renewSigner = signer) {
    const clock = { value: CLOCK_MS };
    const ff = fakeFetch();
    ff.respond(call => call.url.endsWith('/v1/manifest') ? manifestResponse() : enterAckFor(decodeRequest(call.body!), 'renew-session', 5));
    const manager = new HouseLifecycleManager({ db, signer: renewSigner, installationId: 'install-test', fetch: ff.fetch, clock: () => clock.value, retryBackoffMs: 1000 });
    await manager.loginHouse(ORIGIN);
    db.execute('UPDATE house_participation SET lease_expires_at = ?, renew_after = ? WHERE house_origin = ?', [CLOCK_MS / 1000 + 90, CLOCK_MS / 1000 + 30, ORIGIN]);
    ff.calls.length = 0;
    return { clock, ff, manager };
  }
  function renewalAck(req: Record<string, unknown>, now: number, extra: Record<string, unknown> = {}) {
    return bytesResponse(signedAckBytes({
      houseOrigin: ORIGIN, popclawId: POPCLAW_ID, installationId: 'install-test', requestId: req.requestId,
      opSeq: req.opSeq, operation: 2, outcome: 3, sessionId: 'renew-session', sessionActive: true,
      houseRevision: 5, leaseExpiresAt: now + 90, serverCommittedAt: now, inboxReadToken: 'renew-token', ...extra,
    }));
  }
  it('renews on persisted cadence with pinned session/fence, without discovery or generation rotation', async () => {
    const { clock, ff, manager } = await setup();
    const gate = manager.gateFor(ORIGIN);
    ff.respond(call => {
      expect(call.url.endsWith('/v1/house-session')).toBe(true);
      const req = decodeRequest(call.body!);
      expect(req.targetSessionId).toBe('renew-session'); expect(Number(req.expectedHouseRevision)).toBe(5);
      return renewalAck(req, clock.value / 1000);
    });
    await manager.renewDueSessions(); expect(ff.calls).toHaveLength(0);
    clock.value += 30_000;
    await manager.renewDueSessions(); expect(ff.calls).toHaveLength(1);
    const row = readParticipation(db, ORIGIN)!;
    expect(row.lease_expires_at).toBe(clock.value / 1000 + 90);
    expect(row.inbox_read_token).toBe('renew-token'); expect(row.op_seq).toBe(1);
    expect(gate.isActive()).toBe(true); expect(manager.gateFor(ORIGIN).generation).toBe(gate.generation);
    await manager.renewDueSessions(); expect(ff.calls).toHaveLength(1);
    manager.stopHost(); await manager.waitForQuiet();
  });
  it.each(['session', 'fence', 'signature', 'outcome'])('rejects a signed renewal with invalid %s binding and keeps prior authority', async (mismatch) => {
    const { clock, ff, manager } = await setup();
    ff.respond(call => {
      const req = decodeRequest(call.body!);
      if (mismatch === 'signature') return bytesResponse(signedAckBytes({ houseOrigin: ORIGIN }, nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(45))));
      return renewalAck(req, clock.value / 1000, mismatch === 'session' ? { sessionId: 'foreign' } : mismatch === 'fence' ? { houseRevision: 6 } : { outcome: 1 });
    });
    expect(await manager.renewHouse(ORIGIN)).toBe(false);
    expect(readParticipation(db, ORIGIN)?.inbox_read_token).toBe('tok');
    expect(readParticipation(db, ORIGIN)?.lease_expires_at).toBe(CLOCK_MS / 1000 + 90);
    manager.stopHost(); await manager.waitForQuiet();
  });
  it('deduplicates in-flight renewal and discards its ACK after owner takeover', async () => {
    const { clock, ff, manager } = await setup(); let owner = true;
    manager.bindOwnerAuthority({ captureEpoch: () => owner ? 1 : null, isEpochCurrent: epoch => owner && epoch === 1 });
    let reply!: () => void; let sent!: () => void; const sending = new Promise<void>(r => { sent = r; });
    ff.respond(call => new Promise<Response>(r => { reply = () => r(renewalAck(decodeRequest(call.body!), clock.value / 1000)); sent(); }));
    const a = manager.renewHouse(ORIGIN); const b = manager.renewHouse(ORIGIN);
    await sending; owner = false; reply();
    expect(await a).toBe(false); expect(await b).toBe(false); expect(ff.calls).toHaveLength(1);
    expect(readParticipation(db, ORIGIN)?.inbox_read_token).toBe('tok');
    manager.stopHost(); await manager.waitForQuiet();
  });
  it('a late renewal after an observed lease gap opens a fresh local gate', async () => {
    const { clock, ff, manager } = await setup(); const gate = manager.gateFor(ORIGIN);
    let reply!: () => void; let sent!: () => void; const sending = new Promise<void>(r => { sent = r; });
    ff.respond(call => new Promise<Response>(r => { reply = () => r(renewalAck(decodeRequest(call.body!), CLOCK_MS / 1000 + 80)); sent(); }));
    clock.value += 80_000; const renewing = manager.renewHouse(ORIGIN); await sending;
    clock.value += 15_000; expect(gate.isActive()).toBe(false); reply();
    expect(await renewing).toBe(true);
    expect(gate.isActive()).toBe(false); expect(gate.signal.aborted).toBe(true);
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
    manager.stopHost(); await manager.waitForQuiet();
  });
  it('owner loss while signing cancels the final renewal send', async () => {
    let blocked = false; let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(r => { entered = r; });
    const paused = new Promise<void>(r => { release = r; });
    const { ff, manager } = await setup({ ...signer, sign: async bytes => { if (blocked) { entered(); await paused; } return signer.sign(bytes); } });
    let owner = true;
    manager.bindOwnerAuthority({ captureEpoch: () => owner ? 1 : null, isEpochCurrent: () => owner });
    blocked = true;
    const renewing = manager.renewHouse(ORIGIN); await waiting;
    owner = false; release(); expect(await renewing).toBe(false);
    expect(ff.calls).toHaveLength(0); expect(readParticipation(db, ORIGIN)?.inbox_read_token).toBe('tok');
    manager.stopHost(); await manager.waitForQuiet();
  });
  it('legacy schema upgrade preserves disabled intent and does not start renewal I/O', async () => {
    const { ff, manager } = await setup();
    manager.stopHost(); await manager.waitForQuiet();
    db.execute("UPDATE house_participation SET desired = 'disabled', op_seq = 19");
    db.execute('ALTER TABLE house_participation DROP COLUMN renew_interval_seconds');
    db.execute('ALTER TABLE house_participation DROP COLUMN renew_after');
    const restarted = newManager(db, ff.fetch);
    restarted.seedLegacyHouse(ORIGIN);
    await restarted.renewDueSessions();
    expect(readParticipation(db, ORIGIN)?.desired).toBe('disabled');
    expect(readParticipation(db, ORIGIN)?.op_seq).toBe(19);
    expect(readParticipation(db, ORIGIN)?.renew_interval_seconds).toBe(30);
    expect(ff.calls).toHaveLength(0);
    restarted.stopHost(); await restarted.waitForQuiet();
  });
  it('verified fencing closes permission but never pretends to be a leave ACK', async () => {
    const { clock, ff, manager } = await setup(); const gate = manager.gateFor(ORIGIN);
    ff.respond(call => renewalAck(decodeRequest(call.body!), clock.value / 1000, { outcome: 7, errorCode: 6, sessionActive: false, sessionId: '' }));
    expect(await manager.renewHouse(ORIGIN)).toBe(false);
    expect(gate.isActive()).toBe(false); expect(gate.signal.aborted).toBe(true);
    expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
    expect(readParticipation(db, ORIGIN)?.remote_status).toBe('error');
    expect(readParticipation(db, ORIGIN)?.remote_error).toContain('SESSION_FENCED');
    manager.stopHost(); await manager.waitForQuiet();
  });
});


describe('enabled session recovery and owner login authority', () => {
  it('a non-owner does not discover or create login intent', async () => {
    const ff = fakeFetch(); const manager = newManager(db, ff.fetch);
    manager.bindOwnerAuthority({ captureEpoch: () => null, isEpochCurrent: () => false });
    expect((await manager.loginHouse(ORIGIN)).status).toBe('connecting');
    expect(ff.calls).toHaveLength(0); expect(readParticipation(db, ORIGIN)).toBeNull();
    manager.stopHost(); await manager.waitForQuiet();
  });
  it('owner loss during manifest fetch prevents the local intent and ENTER', async () => {
    const ff = fakeFetch(); const manager = newManager(db, ff.fetch);
    let owner = true; let respond!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(r => { entered = r; });
    manager.bindOwnerAuthority({ captureEpoch: () => 1, isEpochCurrent: () => owner });
    ff.respond(call => call.url.endsWith('/v1/manifest') ? new Promise<Response>(r => { respond = () => r(manifestResponse()); entered(); }) : enterAckFor(decodeRequest(call.body!), 'obsolete-owner-session', 1));
    const login = manager.loginHouse(ORIGIN); await waiting; owner = false; respond();
    expect((await login).status).toBe('connecting');
    expect(ff.calls).toHaveLength(1); expect(readParticipation(db, ORIGIN)).toBeNull();
    manager.stopHost(); await manager.waitForQuiet();
  });
  it('retries an undecided network failure using the original request and generation', async () => {
    const ff = fakeFetch(); const manager = newManager(db, ff.fetch);
    ff.respond(call => { if (call.url.endsWith('/v1/manifest')) return manifestResponse(); throw new Error('offline'); });
    await manager.loginHouse(ORIGIN);
    const pending = readParticipation(db, ORIGIN)!;
    ff.respond(call => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      expect(req.requestId).toBe(pending.pending_enter_request_id); expect(Number(req.opSeq)).toBe(pending.op_seq);
      return enterAckFor(req, 'recovered-session', 2);
    });
    await manager.resumeEnabledSessions();
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
    expect(readParticipation(db, ORIGIN)?.session_id).toBe('recovered-session');
    manager.stopHost(); await manager.waitForQuiet();
  });
  it('an expired desired session tries recovery once, then stays quiet after EXECUTOR_BUSY', async () => {
    const ff = fakeFetch(); let now = CLOCK_MS;
    const manager = new HouseLifecycleManager({ db, signer, installationId: 'install-test', fetch: ff.fetch, clock: () => now, retryBackoffMs: 1000 });
    ff.respond(call => call.url.endsWith('/v1/manifest') ? manifestResponse() : enterAckFor(decodeRequest(call.body!), 'expired-session', 1));
    await manager.loginHouse(ORIGIN);
    const oldGate = manager.gateFor(ORIGIN);
    db.execute('UPDATE house_participation SET lease_expires_at = ?, renew_after = 0', [now / 1000 + 2]); now += 3000;
    ff.calls.length = 0;
    ff.respond(call => {
      if (call.url.endsWith('/v1/manifest')) return manifestResponse();
      const req = decodeRequest(call.body!);
      return bytesResponse(signedAckBytes({ houseOrigin: ORIGIN, popclawId: POPCLAW_ID, installationId: 'install-test', requestId: req.requestId, opSeq: req.opSeq, operation: 1, outcome: 7, errorCode: 4, sessionActive: false, serverCommittedAt: now / 1000 }));
    });
    await manager.resumeEnabledSessions();
    expect(ff.calls).toHaveLength(2); expect(oldGate.isActive()).toBe(false);
    expect(readParticipation(db, ORIGIN)?.remote_error).toContain('EXECUTOR_BUSY');
    now += 120_000;
    await manager.resumeEnabledSessions(); await manager.renewDueSessions();
    expect(ff.calls).toHaveLength(2);
    manager.stopHost(); await manager.waitForQuiet();
  });
});


describe('local failed-logout fence compatibility', () => {
  it('background recovery cannot clear an unbound manager fence; a direct verified login can', async () => {
    const ff = fakeFetch(), manager = newManager(db, ff.fetch);
    ff.respond(call => call.url.endsWith('/v1/manifest') ? manifestResponse()
      : enterAckFor(decodeRequest(call.body!), 'direct-session', 1));
    await manager.loginHouse(ORIGIN);
    const old = manager.gateFor(ORIGIN);
    const tx = vi.spyOn(db, 'transaction').mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(manager.logoutHouse(ORIGIN)).rejects.toThrow('PERSISTENCE_FAILED'); tx.mockRestore();
    expect(old.isActive()).toBe(false);
    db.execute('UPDATE house_participation SET lease_expires_at=0,renew_after=0 WHERE house_origin=?', [ORIGIN]);
    await manager.resumeEnabledSessions();
    expect(readParticipation(db, ORIGIN)?.desired).toBe('enabled');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(false);
    expect((await manager.loginHouse(ORIGIN)).status).toBe('connected');
    expect(manager.gateFor(ORIGIN).isActive()).toBe(true);
    expect(old.isActive()).toBe(false);
    manager.stopHost(); await manager.waitForQuiet(); db.close();
  });
});
