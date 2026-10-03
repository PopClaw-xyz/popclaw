/**
 * The window between deciding and sending.
 *
 * `houseReadAuthority` decided, awaited the signature, and returned the
 * credential. Signing is not instant — it is the one await on this path — and
 * a logout, a block or a house withdrawing its declaration inside that window
 * produced a credential minted under an answer that had already stopped being
 * true, and nothing looked again before it left.
 *
 * Nothing here sleeps. The signer's promise is resolved BY THE TEST, after the
 * world has been moved, so the race is deterministic rather than hopeful — and
 * "no request went out" is asserted as the refusal the caller actually gets,
 * since a refusal is exactly what stops the caller sending anything.
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { houseReadAuthority } from '../../../src/identity/read-authority.js';
import { READ_CREDENTIAL_SCHEME } from '../../../src/identity/read-credential.js';
import { declareReadAuth, manifestDeclaring } from '../../helpers/read-authority.js';
import type { Signer } from '../../../src/identity/signer.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ORIGIN = 'https://house.example';
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const ME = bs58.encode(kp.publicKey);

/** A signer whose `sign` resolves only when the test says so. */
function deferredSigner(): { signer: Signer; signed: Promise<void>; release: () => void } {
  let release!: () => void;
  let began!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const signed = new Promise<void>((r) => { began = r; });
  const signer: Signer = {
    popclawId: async () => ME,
    sign: async (bytes: Uint8Array) => {
      began();
      await gate;
      return nacl.sign.detached(bytes, kp.secretKey);
    },
  } as unknown as Signer;
  return { signer, signed, release };
}

function trustedDb() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  ensureHouseLifecycleSchema(db);
  establishTrust(db, { origin: ORIGIN, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'configured', () => 1_700_000_000);
  declareReadAuth(db, ORIGIN, HOUSE_KEY, manifestDeclaring([READ_CREDENTIAL_SCHEME]));
  db.execute(
    `INSERT INTO house_participation (house_origin, installation_id, op_seq, desired, phase, session_id, updated_at)
     VALUES (?, 'install-1', 4, 'enabled', 'connected', 'session-1', 1700000000)`,
    [ORIGIN],
  );
  return db;
}

async function raceWith(move: (db: InMemoryHostDb) => void) {
  const db = trustedDb();
  const { signer, signed, release } = deferredSigner();
  const pending = houseReadAuthority({ db, signer, clock: () => 1_700_000_000_000 }, ORIGIN)('inbox-stream');
  await signed;
  move(db);
  release();
  const out = await pending;
  db.close();
  return out;
}

describe('a credential minted while the world moved never leaves', () => {
  it('refuses when the house was blocked during the signature', async () => {
    const out = await raceWith((db) =>
      db.execute('UPDATE house_binding_pin SET blocked_reason = ?, revision = revision + 1 WHERE origin = ?',
        ['key changed', ORIGIN]));
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.refusal).toBe('READ_AUTH_HOUSE_NOT_TRUSTED');
  });

  it('refuses when the house withdrew its declaration during the signature', async () => {
    const out = await raceWith((db) => declareReadAuth(db, ORIGIN, HOUSE_KEY, manifestDeclaring(undefined)));
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.refusal).toBe('READ_AUTH_NOT_DECLARED');
  });

  it('refuses when the declaration was re-keyed to another house during the signature', async () => {
    const out = await raceWith((db) => {
      db.execute('UPDATE house_binding_pin SET house_key = ?, revision = revision + 1 WHERE origin = ?',
        ['another-key', ORIGIN]);
      declareReadAuth(db, ORIGIN, 'another-key', manifestDeclaring([READ_CREDENTIAL_SCHEME]));
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.refusal).toBe('READ_AUTH_HOUSE_NOT_TRUSTED');
  });

  it('refuses when the owner logged out during the signature', async () => {
    // A logout bumps the op_seq and flips the intent in one local
    // transaction, and leaves the pin exactly where it was — on purpose. So
    // the pin alone cannot notice this one, and something has to.
    const out = await raceWith((db) =>
      db.execute(
        "UPDATE house_participation SET desired = 'disabled', op_seq = op_seq + 1 WHERE house_origin = ?",
        [ORIGIN],
      ));
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.refusal).toBe('READ_AUTH_HOUSE_NOT_TRUSTED');
  });

  it('still grants when nothing moved', async () => {
    // The guard has to be a guard, not a tax: a slow signature on a quiet
    // machine is the ordinary case and must still produce a credential.
    const out = await raceWith(() => {});
    expect(out.ok).toBe(true);
  });
});
