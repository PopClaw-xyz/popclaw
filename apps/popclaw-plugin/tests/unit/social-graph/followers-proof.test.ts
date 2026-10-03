/**
 * Asking who follows me says who is asking — and when it cannot, it says
 * nothing rather than asking anonymously.
 *
 * A house may decide that a follow list belongs to the person it is about,
 * and answer nobody else. This poll then has to prove it holds that identity's
 * key — and the failure if it does not is the quiet kind: the round throws,
 * the caller treats a throw as "skip this house", and new followers simply
 * stop being announced.
 *
 * The anonymous branch is the one that had to go. Sending no header at all
 * once looked harmless — a house that does not require proof still answers —
 * but the answer to an unauthenticated read of a private list is an empty
 * array, and an empty array is indistinguishable from "nobody follows you".
 * So a house this build cannot authenticate to is refused BEFORE the request,
 * with a code, and nothing goes on the wire.
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { fetchFollowers } from '../../../src/social-graph/followers-sync.js';
import { INBOX_TOKEN_HEADER, readCredentialMessage } from '../../../src/identity/read-credential.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import {
  declaringReadAuthority,
  silentReadAuthority,
  unknownSchemeReadAuthority,
} from '../../helpers/read-authority.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const seed = new Uint8Array(32).fill(53);
const kp = nacl.sign.keyPair.fromSeed(seed);
const ME = bs58.encode(kp.publicKey);
const signer = new MasterKeySigner({ seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: ME });
const BASE = 'https://house.test';
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

function trustedDb() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  establishTrust(db, { origin: BASE, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'tofu', () => 1_700_000_000);
  return db;
}

function transport(status = 200, body: unknown = [{ popclaw_id: 'alice' }]) {
  const seen: RequestInit[] = [];
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, seen };
}

describe('proving who is asking for a follower list', () => {
  it('sends a credential the house can check against this identity', async () => {
    const db = trustedDb();
    const t = transport();
    expect(await fetchFollowers(t.fn, BASE, ME, declaringReadAuthority(db, signer)(BASE))).toEqual(['alice']);

    const header = (t.seen[0]!.headers as Record<string, string>)[INBOX_TOKEN_HEADER];
    expect(header).toBeTruthy();

    // Not "a header is present" — the bytes have to verify against the
    // relation-list purpose and the pinned audience, or a house that actually
    // checks would refuse it and this test would be guarding a header that
    // means nothing.
    const [version, id, ts, sig] = header!.split('.');
    expect(version).toBe('v2');
    expect(id).toBe(ME);
    expect(nacl.sign.detached.verify(
      new TextEncoder().encode(
        readCredentialMessage('relation-list', ME, { origin: BASE, houseKey: HOUSE_KEY }, Number(ts)),
      ),
      Buffer.from(sig!, 'base64'),
      kp.publicKey,
    )).toBe(true);
    db.close();
  });

  it('a refusal about someone else is not reported as a bad key', async () => {
    const db = trustedDb();
    const authority = declaringReadAuthority(db, signer)(BASE);
    // 401 and 403 answer different questions. Told "unauthorized", a person
    // goes and replaces a key that was never the problem; the real answer is
    // that this list is not theirs to read.
    await expect(fetchFollowers(transport(403).fn, BASE, ME, authority))
      .rejects.toThrow('FOLLOWER_LIST_NOT_OURS');
    await expect(fetchFollowers(transport(401).fn, BASE, ME, authority)).rejects.toThrow('HTTP 401');
    db.close();
  });

  it('a house that declared no scheme is refused, and nothing is asked', async () => {
    const db = trustedDb();
    const t = transport();
    await expect(fetchFollowers(t.fn, BASE, ME, silentReadAuthority(db, signer)(BASE)))
      .rejects.toThrow('READ_AUTH_NOT_DECLARED');
    // The old behaviour was a request with no header, which this house would
    // answer `200 []` — read by the caller as every follower having left.
    expect(t.seen).toHaveLength(0);
    db.close();
  });

  it('a house that named an unknown scheme is refused the same way', async () => {
    const db = trustedDb();
    const t = transport();
    await expect(fetchFollowers(t.fn, BASE, ME, unknownSchemeReadAuthority(db, signer)(BASE)))
      .rejects.toThrow('READ_AUTH_SCHEME_UNSUPPORTED');
    expect(t.seen).toHaveLength(0);
    db.close();
  });

  it('polls a house configured with a trailing slash instead of refusing it', async () => {
    const db = trustedDb();
    const t = transport();
    // `lore_houses` holds whatever the owner typed; the pin holds the
    // canonical origin. The poll must not treat a house it is trusted at as
    // an untrusted one because of a slash, which for a real owner looks like
    // their followers silently disappearing.
    expect(await fetchFollowers(t.fn, `${BASE}/`, ME, declaringReadAuthority(db, signer)(`${BASE}/`)))
      .toEqual(['alice']);

    const header = (t.seen[0]!.headers as Record<string, string>)[INBOX_TOKEN_HEADER];
    const [, , ts, sig] = header!.split('.');
    // And the audience it signs is still the canonical origin, not the string
    // the owner happened to type.
    expect(nacl.sign.detached.verify(
      new TextEncoder().encode(
        readCredentialMessage('relation-list', ME, { origin: BASE, houseKey: HOUSE_KEY }, Number(ts)),
      ),
      Buffer.from(sig!, 'base64'),
      kp.publicKey,
    )).toBe(true);
    db.close();
  });

  it('says out loud that a refusal is not an empty follower list', async () => {
    const db = trustedDb();
    let thrown = '';
    await fetchFollowers(transport().fn, BASE, ME, silentReadAuthority(db, signer)(BASE))
      .catch((err: unknown) => { thrown = String(err); });
    // The owner-facing half of the refusal travels with the code, because
    // "READ_AUTH_NOT_DECLARED" alone in a log tells nobody that their
    // followers did not vanish.
    expect(thrown).toContain('follows you');
    db.close();
  });
});
