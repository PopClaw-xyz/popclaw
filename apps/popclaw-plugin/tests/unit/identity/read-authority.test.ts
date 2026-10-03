/**
 * The one decision every identity-bearing read makes.
 *
 * What is checked here is not "a header comes back" — it is that the bytes
 * inside it re-derive to the PINNED binding's own origin and key, for the
 * purpose the caller named, and that each of the three refusals happens
 * before anything is signed. A resolver that returned a plausible header for
 * a house nobody proved would pass a shape test and fail every real house.
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { houseReadAuthority } from '../../../src/identity/read-authority.js';
import { declareReadAuth, manifestDeclaring } from '../../helpers/read-authority.js';
import {
  INBOX_TOKEN_HEADER,
  READ_CREDENTIAL_SCHEME,
  readCredentialMessage,
} from '../../../src/identity/read-credential.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const seed = new Uint8Array(32).fill(7);
const kp = nacl.sign.keyPair.fromSeed(seed);
const ME = bs58.encode(kp.publicKey);
const signer = new MasterKeySigner({ seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: ME });

const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';
/** A non-default port, because that is the case a re-normaliser would break. */
const ORIGIN = 'http://[::1]:8102';

/** Pinned, and declaring whatever this house is meant to declare. */
function trustedDb(schemes: readonly string[] = [READ_CREDENTIAL_SCHEME]) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  establishTrust(db, { origin: ORIGIN, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'tofu', () => 1_700_000_000);
  declareReadAuth(db, ORIGIN, HOUSE_KEY, manifestDeclaring(schemes));
  return db;
}

const CLOCK = () => 1_700_000_000_000;

describe('choosing how a read proves who is asking', () => {
  it('signs the pinned audience, verbatim, for the purpose the caller named', async () => {
    const db = trustedDb();
    const authority = houseReadAuthority(
      { db, signer, clock: CLOCK },
      ORIGIN,
    );

    const out = await authority('relation-evidence');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const token = out.headers[INBOX_TOKEN_HEADER]!;
    const [version, id, ts, sig] = token.split('.');
    expect(version).toBe('v2');
    expect(id).toBe(ME);
    expect(ts).toBe('1700000000');

    // The bytes, not the shape: rebuild the message from the PIN and check
    // the signature over it. An implementation that signed the caller's
    // origin string, or a re-normalised one, fails right here.
    expect(nacl.sign.detached.verify(
      new TextEncoder().encode(
        readCredentialMessage('relation-evidence', ME, { origin: ORIGIN, houseKey: HOUSE_KEY }, 1_700_000_000),
      ),
      Buffer.from(sig!, 'base64'),
      kp.publicKey,
    )).toBe(true);
    db.close();
  });

  it('gives two purposes two different credentials', async () => {
    const db = trustedDb();
    const authority = houseReadAuthority(
      { db, signer, clock: CLOCK },
      ORIGIN,
    );
    const snapshot = await authority('relation-snapshot');
    const evidence = await authority('relation-evidence');
    expect(snapshot.ok && evidence.ok).toBe(true);
    if (!snapshot.ok || !evidence.ok) return;
    // Same second, same identity, same audience — so if these matched, the
    // purpose is not in the signature and one snapshot read would open the
    // evidence endpoint.
    expect(snapshot.headers[INBOX_TOKEN_HEADER]).not.toBe(evidence.headers[INBOX_TOKEN_HEADER]);
    db.close();
  });

  it('refuses, without signing, when the house declared nothing', async () => {
    const db = trustedDb();
    // `undefined` schemes, written the way a 200 with no `read_auth` writes it.
    declareReadAuth(db, ORIGIN, HOUSE_KEY, manifestDeclaring(undefined));
    const sign = vi.spyOn(signer, 'sign');
    const authority = houseReadAuthority({ db, signer }, ORIGIN);

    const out = await authority('relation-list');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toBe('READ_AUTH_NOT_DECLARED');
    expect(out.message).toContain(ORIGIN);
    expect(sign).not.toHaveBeenCalled();
    sign.mockRestore();
    db.close();
  });

  it('refuses a name it does not speak, without guessing from the digits in it', async () => {
    const db = trustedDb();
    for (const declared of [[], ['house-session-v2'], ['popclaw-identity-read-v3'], ['POPCLAW-IDENTITY-READ-V2']]) {
      declareReadAuth(db, ORIGIN, HOUSE_KEY, manifestDeclaring(declared));
      const authority = houseReadAuthority({ db, signer }, ORIGIN);
      const out = await authority('inbox-stream');
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.refusal).toBe('READ_AUTH_SCHEME_UNSUPPORTED');
    }
    db.close();
  });

  it('refuses before the declaration matters when nothing is pinned here', async () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const authority = houseReadAuthority(
      { db, signer },
      ORIGIN,
    );
    const out = await authority('inbox-stream');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // A declaration is not an identity. With no verified binding there is no
    // audience to sign for, whatever the house says it accepts.
    expect(out.refusal).toBe('READ_AUTH_HOUSE_NOT_TRUSTED');
    db.close();
  });

  it('refuses a blocked binding even though a row exists', async () => {
    const db = trustedDb();
    db.execute('UPDATE house_binding_pin SET blocked_reason = ? WHERE origin = ?', ['key changed', ORIGIN]);
    const authority = houseReadAuthority(
      { db, signer },
      ORIGIN,
    );
    const out = await authority('relation-snapshot');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toBe('READ_AUTH_HOUSE_NOT_TRUSTED');
    db.close();
  });

  it('re-reads the answer for every request instead of remembering it', async () => {
    const db = trustedDb();
    const authority = houseReadAuthority({ db, signer, clock: CLOCK }, ORIGIN);
    expect((await authority('inbox-stream')).ok).toBe(true);
    // A later 200 that withdrew the block rewrites the projection.
    declareReadAuth(db, ORIGIN, HOUSE_KEY, manifestDeclaring(undefined));
    // A house that withdrew its declaration, or a pin that was blocked one
    // request ago, must stop this connection — a cached "yes" is how a
    // credential goes out under an answer nobody holds any more.
    expect((await authority('inbox-stream')).ok).toBe(false);
    db.close();
  });
});

/**
 * The origin a caller holds is whatever the owner typed into configuration;
 * the origin a pin is filed under is the canonical one the runtime derived.
 * Those two strings agree for the houses that ship in the default config,
 * which is exactly why nothing caught them disagreeing for everybody else.
 */
describe('the configured origin is a key that has to be canonicalised first', () => {
  /** The form a pin is always written under, whatever was configured. */
  const CANON = 'https://house.popclaw.me';

  function pinnedAtCanon() {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    establishTrust(db, { origin: CANON, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'configured', () => 1_700_000_000);
    return db;
  }

  for (const configured of [
    'https://house.popclaw.me/',
    'https://House.PopClaw.me',
    'https://House.PopClaw.me/',
  ]) {
    it(`resolves ${configured} against the pin filed under the canonical origin`, async () => {
      const db = pinnedAtCanon();
      // The declaration is filed under the CANONICAL origin, exactly as the
      // pin is — one key, derived once. A resolver that looked the
      // declaration up under the configured spelling would find nothing here
      // and refuse a house the owner is demonstrably trusted at.
      declareReadAuth(db, CANON, HOUSE_KEY, manifestDeclaring([READ_CREDENTIAL_SCHEME]));
      const authority = houseReadAuthority({ db, signer, clock: CLOCK }, configured);

      const out = await authority('relation-list');
      expect(out.ok).toBe(true);
      if (!out.ok) return;

      // And the audience in the signed bytes is the canonical origin — the
      // house signed that string into its manifest proof, so it is the only
      // string a credential may name.
      const token = out.headers[INBOX_TOKEN_HEADER]!;
      const [, , ts, sig] = token.split('.');
      expect(nacl.sign.detached.verify(
        new TextEncoder().encode(
          readCredentialMessage('relation-list', ME, { origin: CANON, houseKey: HOUSE_KEY }, Number(ts)),
        ),
        Buffer.from(sig!, 'base64'),
        kp.publicKey,
      )).toBe(true);
      db.close();
    });
  }

  for (const configured of [
    'https://me:secret@house.popclaw.me',
    'https://house.popclaw.me/#fragment',
    'ftp://house.popclaw.me',
  ]) {
    it(`refuses ${configured} instead of throwing out of the read path`, async () => {
      const db = pinnedAtCanon();
      declareReadAuth(db, CANON, HOUSE_KEY, manifestDeclaring([READ_CREDENTIAL_SCHEME]));
      const authority = houseReadAuthority({ db, signer, clock: CLOCK }, configured);

      // `z.string().url()` accepts all three, so they reach this resolver as
      // ordinary configured houses. An address this build cannot canonicalise
      // is a house it cannot name in a credential — a refusal, with a code the
      // caller can branch on, never an exception escaping the read path.
      const out = await authority('inbox-stream');
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.refusal).toBe('READ_AUTH_HOUSE_NOT_TRUSTED');
      db.close();
    });
  }
});
