/**
 * The declaration that picks a credential comes from the manifest that was
 * VERIFIED, and from the same commit as the binding.
 *
 * It used to come from `data/lorehouses/<slug>.handshake.json`, written by an
 * ordinary conditional GET that never read `X-Popclaw-Manifest-Proof` and was
 * tied to no pin, digest or revision. So "which key is this house" and "which
 * credential does it accept" were two answers from two responses that nothing
 * cross-checked — and the second one decided what got sent to the house the
 * first one named.
 *
 * Everything below goes through the real trust machinery: a real signed
 * manifest, the real prepare/commit pair, the real resolver. A fixture that
 * wrote the projection row by hand would prove nothing about provenance,
 * which is the entire property under test.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import {
  beginHouseAdd,
  prepareHouseTrust,
  commitEstablishAndActivate,
  confirmHouseTrust,
} from '../../../src/world/house-trust.js';
import {
  readVerifiedDeclaration,
  sessionReadSelected,
} from '../../../src/world/house-read-declaration.js';
import { pinnedBinding } from '../../../src/world/house-binding-pin.js';
import { refreshHouseHandshake } from '../../../src/world/house-handshake.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { houseReadAuthority } from '../../../src/identity/read-authority.js';
import { READ_CREDENTIAL_SCHEME } from '../../../src/identity/read-credential.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { mintHouse } from '../../helpers/signed-manifest.js';
import { SESSION_BOARD } from '../../helpers/read-authority.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOUSE = 'https://house.example';

const seed = new Uint8Array(32).fill(7);
const kp = nacl.sign.keyPair.fromSeed(seed);
const signer = new MasterKeySigner({
  seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: bs58.encode(kp.publicKey),
});

const DECLARES = { read_auth: { schemes: [READ_CREDENTIAL_SCHEME] } };

function freshDb() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  return db;
}

/** The owner's explicit add, against a house serving `manifest`. */
async function add(db: InMemoryHostDb, manifest: Record<string, unknown>, seedByte = 1) {
  const house = mintHouse({ origin: HOUSE, seed: seedByte, manifest });
  const prepared = await prepareHouseTrust(db, HOUSE, {
    fetch: house.fetch as typeof globalThis.fetch,
    attempt: beginHouseAdd(db, HOUSE),
    now: () => 1_700_000_000,
  });
  if (!prepared.ok) return { house, outcome: prepared };
  // The explicit add's own pair: pin and participation in one commit, which is
  // what every later confirm speaks for.
  const outcome = commitEstablishAndActivate(db, prepared.prepared, { now: () => 1_700_000_000 });
  return { house, outcome };
}

describe('the read declaration is projected from the verified manifest', () => {
  it('is committed by the same act that pins the house', async () => {
    const db = freshDb();
    const { outcome } = await add(db, DECLARES);
    expect(outcome.ok).toBe(true);

    const pin = pinnedBinding(db, HOUSE)!;
    expect(readVerifiedDeclaration(db, pin)?.schemes).toEqual([READ_CREDENTIAL_SCHEME]);
    // And the whole point of it: the read path now grants, with nothing
    // injected and no second fetch anywhere.
    expect((await houseReadAuthority({ db, signer }, HOUSE)('relation-list')).ok).toBe(true);
    db.close();
  });

  it('is not written at all when the proof does not verify', async () => {
    const db = freshDb();
    // The shape is right and the signature is not that key's word — a forged
    // manifest carrying a generous declaration.
    const impostor = mintHouse({
      origin: HOUSE,
      seed: 1,
      manifest: DECLARES,
      signWith: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).secretKey,
    });
    const outcome = await prepareHouseTrust(db, HOUSE, {
      fetch: impostor.fetch as typeof globalThis.fetch,
      attempt: beginHouseAdd(db, HOUSE),
      now: () => 1_700_000_000,
    });
    // It never reaches a commit at all, which is why nothing can be written.
    expect(outcome.ok).toBe(false);
    expect(db.queryOne('SELECT origin FROM house_read_declaration WHERE origin = ?', [HOUSE])).toBeFalsy();
    db.close();
  });

  it('cannot be changed by an unverifiable manifest once a good one exists', async () => {
    const db = freshDb();
    await add(db, {});
    const pin = pinnedBinding(db, HOUSE)!;
    // The house declared nothing, so every identity read here is refused.
    expect(readVerifiedDeclaration(db, pin)?.schemes).toBeUndefined();

    const impostor = mintHouse({
      origin: HOUSE,
      seed: 1,
      manifest: DECLARES,
      signWith: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).secretKey,
    });
    const confirmed = await confirmHouseTrust(db, HOUSE, {
      fetch: impostor.fetch as typeof globalThis.fetch,
      now: () => 1_700_000_100,
    });
    expect(confirmed.ok).toBe(false);
    // A bad proof introduces nothing and overwrites nothing.
    expect(readVerifiedDeclaration(db, pinnedBinding(db, HOUSE)!)?.schemes).toBeUndefined();
    expect((await houseReadAuthority({ db, signer }, HOUSE)('relation-list')).ok).toBe(false);
    db.close();
  });

  it('closes subsequent reads when a valid manifest withdraws the declaration', async () => {
    const db = freshDb();
    await add(db, DECLARES);
    expect((await houseReadAuthority({ db, signer }, HOUSE)('inbox-stream')).ok).toBe(true);

    const withdrawn = mintHouse({ origin: HOUSE, seed: 1, manifest: {} });
    const confirmed = await confirmHouseTrust(db, HOUSE, {
      fetch: withdrawn.fetch as typeof globalThis.fetch,
      now: () => 1_700_000_100,
    });
    expect(confirmed.ok).toBe(true);
    const out = await houseReadAuthority({ db, signer }, HOUSE)('inbox-stream');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.refusal).toBe('READ_AUTH_NOT_DECLARED');
    db.close();
  });

  it('is not established by the unverified handshake cache', async () => {
    const db = freshDb();
    // Pinned, and declaring nothing — so every identity read here is refused.
    await add(db, {});
    const paths = new PopclawPaths(mkdtempSync(join(tmpdir(), 'popclaw-decl-')));
    // Now the lenient path runs, against a manifest that DOES declare a
    // scheme. It carries no proof header and is tied to no pin, which is the
    // entire reason it may not decide this: whoever can answer this fetch
    // would otherwise choose what gets sent to the house the pin named.
    await refreshHouseHandshake(HOUSE, {
      paths,
      fetch: (async () =>
        new Response(JSON.stringify({ house: { name: 'h' }, ...DECLARES }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof globalThis.fetch,
    });
    const out = await houseReadAuthority({ db, signer }, HOUSE)('relation-list');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.refusal).toBe('READ_AUTH_NOT_DECLARED');

    // The positive control, so this is a test about PROVENANCE and not a test
    // in which nothing happened: the very same declaration, arriving through
    // the verified path instead, does take effect.
    const proving = mintHouse({ origin: HOUSE, seed: 1, manifest: DECLARES });
    const confirmed = await confirmHouseTrust(db, HOUSE, {
      fetch: proving.fetch as typeof globalThis.fetch,
      now: () => 1_700_000_100,
    });
    expect(confirmed.ok).toBe(true);
    expect((await houseReadAuthority({ db, signer }, HOUSE)('relation-list')).ok).toBe(true);
    db.close();
  });

  it('works for a house with no board and no world capability at all', async () => {
    const db = freshDb();
    // Ordinary mail must not depend on the game. This manifest proves an
    // identity and declares a read scheme, and that is the whole of it.
    const { outcome } = await add(db, DECLARES);
    expect(outcome.ok).toBe(true);
    expect(sessionReadSelected(db, HOUSE)).toBe(false);
    expect((await houseReadAuthority({ db, signer }, HOUSE)('relation-snapshot')).ok).toBe(true);
    db.close();
  });

  it('does not lend one key’s declaration to another key at the same origin', async () => {
    const db = freshDb();
    await add(db, DECLARES);
    const pin = pinnedBinding(db, HOUSE)!;
    // A block resolved to a DIFFERENT key: the row survives (it is kept on
    // purpose), but it is the old key's word, not this one's.
    db.execute('UPDATE house_binding_pin SET house_key = ? WHERE origin = ?', ['another-key', HOUSE]);
    expect(readVerifiedDeclaration(db, { ...pin, houseKey: 'another-key' })).toBeUndefined();
    const out = await houseReadAuthority({ db, signer }, HOUSE)('relation-list');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.refusal).toBe('READ_AUTH_NOT_DECLARED');
    db.close();
  });
});

describe('the session read lane is a fact about the house, not about this machine', () => {
  it('is selected by a house_session board in the verified manifest', async () => {
    const db = freshDb();
    await add(db, { house_session: SESSION_BOARD });
    expect(sessionReadSelected(db, HOUSE)).toBe(true);
    db.close();
  });

  it('is not selected when the board is absent or malformed', async () => {
    for (const manifest of [{}, { house_session: { version: 2, endpoint: '/v1/house-session' } }]) {
      const db = freshDb();
      await add(db, manifest);
      expect(sessionReadSelected(db, HOUSE)).toBe(false);
      db.close();
    }
  });

  it('is not selected while the pin is blocked', async () => {
    const db = freshDb();
    await add(db, { house_session: SESSION_BOARD });
    db.execute('UPDATE house_binding_pin SET blocked_reason = ? WHERE origin = ?', ['key changed', HOUSE]);
    // A blocked house is not "currently trusted", so it does not get to keep
    // reading the inbox on a session this machine still remembers.
    expect(sessionReadSelected(db, HOUSE)).toBe(false);
    db.close();
  });

  it('is not selected for a house nothing is pinned at', () => {
    const db = freshDb();
    expect(sessionReadSelected(db, HOUSE)).toBe(false);
    db.close();
  });
});
