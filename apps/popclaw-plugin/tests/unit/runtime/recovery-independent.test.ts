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
  type LifecycleFetch,
} from '../../../src/runtime/house-lifecycle/control-client.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import {
  ensureHouseLifecycleSchema,
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


describe('independent enabled recovery probes',()=>{
  it('expired confirmed session keeps retrying after discovery is temporarily offline',async()=>{
    const clock={value:CLOCK_MS};const ff=fakeFetch();const manager=new HouseLifecycleManager({db,signer,installationId:'install-test',fetch:ff.fetch,clock:()=>clock.value,retryBackoffMs:1000});
    ff.respond(call=>call.url.endsWith('/v1/manifest')?manifestResponse():enterAckFor(decodeRequest(call.body!),'old-session',1));
    await manager.loginHouse(ORIGIN);
    db.execute('UPDATE house_participation SET lease_expires_at = ?, renew_after = 0 WHERE house_origin = ?',[clock.value/1000-1,ORIGIN]);
    ff.calls.length=0;ff.respond(()=>{throw new Error('temporary network outage');});
    await manager.resumeEnabledSessions();
    const intermediate=readParticipation(db,ORIGIN);clock.value+=2000;
    ff.respond(call=>call.url.endsWith('/v1/manifest')?manifestResponse():enterAckFor(decodeRequest(call.body!),'recovered-session',2));
    await manager.resumeEnabledSessions();
    console.log('OFFLINE_EXPIRED_RECOVERY',JSON.stringify({intermediate,final:readParticipation(db,ORIGIN),calls:ff.calls.map(c=>c.url)}));
    expect(readParticipation(db,ORIGIN)?.session_id).toBe('recovered-session');
    manager.stopHost();await manager.waitForQuiet();
  });
  it('lost ACK resolved as historical expired own session remains eligible for fresh recovery',async()=>{
    const clock={value:CLOCK_MS};const ff=fakeFetch();const manager=new HouseLifecycleManager({db,signer,installationId:'install-test',fetch:ff.fetch,clock:()=>clock.value,retryBackoffMs:1000});
    ff.respond(call=>{if(call.url.endsWith('/v1/manifest'))return manifestResponse();throw new Error('lost ACK');});
    await manager.loginHouse(ORIGIN);clock.value+=120_000;
    ff.respond(call=>{
      if(call.url.endsWith('/v1/manifest'))return manifestResponse();const req=decodeRequest(call.body!);
      return bytesResponse(signedAckBytes({houseOrigin:ORIGIN,popclawId:POPCLAW_ID,installationId:'install-test',requestId:req.requestId,opSeq:req.opSeq,operation:1,outcome:2,houseRevision:1,sessionId:'historical-own-session',sessionActive:true,leaseExpiresAt:CLOCK_MS/1000+90,serverCommittedAt:CLOCK_MS/1000,inboxReadToken:'expired-token'}));
    });
    await manager.resumeEnabledSessions();const intermediate=readParticipation(db,ORIGIN);clock.value+=2000;
    ff.respond(call=>call.url.endsWith('/v1/manifest')?manifestResponse():enterAckFor(decodeRequest(call.body!),'fresh-session',2));
    await manager.resumeEnabledSessions();console.log('HISTORICAL_RECOVERY',JSON.stringify({intermediate,final:readParticipation(db,ORIGIN)}));
    expect(readParticipation(db,ORIGIN)?.session_id).toBe('fresh-session');manager.stopHost();await manager.waitForQuiet();
  });
});
