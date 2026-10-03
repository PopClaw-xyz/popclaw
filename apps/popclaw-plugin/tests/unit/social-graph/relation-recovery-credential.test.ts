/**
 * The credential is per REQUEST, not per sweep.
 *
 * One token signed at the top of a run assumed the whole run fits inside its
 * freshness window. A run is up to 20 snapshot pages plus 500 evidence
 * fetches -- 520 round trips. On a slow link that crosses a minute, and
 * whichever request crosses it is refused; the gap stays open and the next
 * tick starts a sweep that is slow for the same reason, so the
 * reconciliation never finishes while the link stays slow.
 *
 * The clock here is injected rather than slept through, and the assertion is
 * not "a builder was called twice": it is that the token each request
 * actually CARRIED was fresh at the moment that request went out. The sweep
 * must also genuinely reach the evidence endpoint -- a fixture where every
 * request is refused would prove nothing about credentials.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { beginParticipation } from '../../../src/ingress/inbound-commit.js';
import { openRelationAwareInbox } from '../../../src/social-graph/relation-host.js';
import { RelationGapStore } from '../../../src/social-graph/relation-gap-store.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { AnyEventSource, SseFrame } from '../../../src/messaging/inbox-stream-client.js';
import { declaringReadAuthority } from '../../helpers/read-authority.js';
import { readCredentialMessage } from '../../../src/identity/read-credential.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ORIGIN = 'https://house.popclaw.me';
const NOW = () => 1_700_000_000;

const meKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x4d));
const ME = bs58.encode(meKp.publicKey);
const HOUSE_KEY = ME;

const BODY = new TextEncoder().encode('{"house":{"name":"me","slug":"me"},"official_ids":[]}');

/** A real signature, not a zero block: the purpose lives in the signed bytes
 *  and nowhere on the wire, so a stub signer could not tell the two routes
 *  apart and this file's whole claim would be untestable. */
const signer: Signer = {
  publicKey: async () => meKp.publicKey,
  sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, meKp.secretKey),
  popclawId: async () => ME,
} as unknown as Signer;

function silentTransport() {
  return class {
    onmessage: ((e: SseFrame) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    addEventListener(): void {}
    close(): void {}
  } as unknown as new (url: string, init?: { readonly headers?: Record<string, string> }) => AnyEventSource;
}

async function waitFor<T>(read: () => T, accepts: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = read();
    if (accepts(v)) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not reached');
}

/** A signed original of the owner's own follow — what the evidence serves. */
function followOriginal(seq: number): { eventId: string; envelopeB64: string } {
  const env: Record<string, unknown> = {
    actor: { popclawId: ME },
    timestamp: seq,
    followDeclared: { followeePopclawId: 'some-followee', order: { seq, houseKey: HOUSE_KEY } },
  };
  const canonical = canonicalizeEnvelope(env);
  const eventId = cidFromCanonical(canonical);
  const bytes = popclaw.event.EventEnvelope.encode({
    ...env, eventId, signature: nacl.sign.detached(canonical, meKp.secretKey),
  }).finish();
  return { eventId, envelopeB64: Buffer.from(bytes).toString('base64') };
}

describe('a sweep whose link is slow', () => {
  let db: InMemoryHostDb;
  const opened: Array<{ stop: () => void }> = [];
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    establishTrust(db, { origin: ORIGIN, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'tofu', NOW);
    beginParticipation(db, HOUSE_KEY, NOW);
    new RelationGapStore(db).mark({
      houseKey: HOUSE_KEY, incarnation: 'inc-1',
      reason: 'below_floor', logGeneration: '5', floor: '120', at: NOW(),
    });
  });
  afterEach(() => {
    for (const h of opened.splice(0)) h.stop();
    db.close();
    vi.useRealTimers();
  });

  it('signs a fresh credential per request and still reaches the evidence', async () => {
    const f1 = followOriginal(1);
    const sent: Array<{ kind: 'snapshot' | 'evidence'; ts: number; at: number; token: string }> = [];

    const digest = cidFromCanonical(BODY);
    const binding = { origin: ORIGIN, houseKey: HOUSE_KEY, incarnation: 'inc-1' };
    const core = popclaw.world.ManifestProof.encode({ house: binding, manifestDigest: digest }).finish();
    const prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
    const signing = new Uint8Array(prefix.length + core.length);
    signing.set(prefix); signing.set(core, prefix.length);
    const header = Buffer.from(popclaw.world.ManifestProof.encode({
      house: binding, manifestDigest: digest,
      authoritySignature: nacl.sign.detached(signing, meKp.secretKey),
    }).finish()).toString('base64');

    const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const token = ((init?.headers ?? {}) as Record<string, string>)['x-popclaw-inbox-token'];
      const at = Math.floor(Date.now() / 1000);
      if (url.includes('/v1/relation-snapshot')) {
        // v2 wire form is `v2.<id>.<ts>.<sig>` — the ts is the THIRD segment.
        sent.push({ kind: 'snapshot', ts: Number(token!.split('.')[2]), at, token: token! });
        vi.setSystemTime(Date.now() + 90_000); // the house is slow to answer
        return { status: 200, ok: true, json: async () => ({
          checkpoint_id: 'cp-slow', log_generation: '5', floor: '120', watermark: '300',
          entries: [{ evidence_event_ids: [f1.eventId] }], complete: true,
        }) } as unknown as Response;
      }
      if (url.includes('/v1/relation-evidence/')) {
        sent.push({ kind: 'evidence', ts: Number(token!.split('.')[2]), at, token: token! });
        return { status: 200, ok: true,
          json: async () => ({ event_id: f1.eventId, envelope_b64: f1.envelopeB64 }) } as unknown as Response;
      }
      return {
        status: 200, ok: true,
        headers: { get: (k: string) => (k.toLowerCase() === 'x-popclaw-manifest-proof' ? header : String(BODY.length)) },
        arrayBuffer: async () => BODY.buffer.slice(BODY.byteOffset, BODY.byteOffset + BODY.length),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const host = await openRelationAwareInbox(
      { db, recipientPopclawId: ME, signer, readAuthorityFor: declaringReadAuthority(db, signer),
        now: NOW, fetch: slowFetch,
        eventSourceCtor: silentTransport(), onMessage: () => {},
        drainIntervalMs: 5, streamReconnectDelayMs: 0, startStreams: false } as never,
      [ORIGIN],
    );
    opened.push(host);

    const both = await waitFor(() => sent, (s) => s.length >= 2);
    // It genuinely got as far as evidence.
    expect(both.map((r) => r.kind).slice(0, 2)).toEqual(['snapshot', 'evidence']);
    expect(both[1]!.at - both[0]!.at).toBe(90);
    // The point: each token fresh AT THE MOMENT IT WAS SENT. The old shape
    // put a 90-second-old timestamp on the evidence request.
    for (const r of both.slice(0, 2)) expect(Math.abs(r.ts - r.at)).toBeLessThanOrEqual(60);
    expect(both[1]!.ts).not.toBe(both[0]!.ts);

    // And each carried its OWN purpose. The purpose never rides on the wire,
    // so the only way to see it is to rebuild the message the house will
    // rebuild and check the signature against it. One closure serving both
    // routes with one purpose passes every other assertion in this file.
    const audience = { origin: ORIGIN, houseKey: HOUSE_KEY };
    for (const [r, purpose] of [[both[0]!, 'relation-snapshot'], [both[1]!, 'relation-evidence']] as const) {
      const [version, id, ts, sig] = r.token.split('.');
      expect([version, id]).toEqual(['v2', ME]);
      expect(nacl.sign.detached.verify(
        new TextEncoder().encode(readCredentialMessage(purpose, ME, audience, Number(ts))),
        Buffer.from(sig!, 'base64'),
        meKp.publicKey,
      )).toBe(true);
    }
  });
});
