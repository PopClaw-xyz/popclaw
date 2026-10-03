/**
 * A read authority for tests, built from the REAL resolver.
 *
 * Deliberately not a stub returning a fixed header: a fixture that fakes the
 * decision cannot notice when the decision changes, and the whole point of the
 * resolver is that one place decides.
 *
 * Nothing is injected any more either. The declaration now comes from the
 * projection of a VERIFIED manifest, so these helpers make the database look
 * like a machine that verified such a manifest — by running the production
 * projector over real manifest bytes — rather than by handing the resolver an
 * answer it would never get on a real machine.
 */
import { houseReadAuthority, type ReadAuthority } from '../../src/identity/read-authority.js';
import { INBOX_TOKEN_HEADER, READ_CREDENTIAL_SCHEME } from '../../src/identity/read-credential.js';
import { projectReadDeclarationInTx } from '../../src/world/house-read-declaration.js';
import { pinnedBinding } from '../../src/world/house-binding-pin.js';
import { normalizeHouseOrigin } from '../../src/runtime/house-lifecycle/control-client.js';
import type { HostDb } from '../../src/host/host-db.js';
import type { Signer } from '../../src/identity/signer.js';

/** A valid `house_session` board, for the session-read lane's positive fact. */
export const SESSION_BOARD = {
  version: 1,
  endpoint: '/v1/house-session',
  ack_pubkey: 'a'.repeat(64),
  operations: ['enter', 'renew', 'leave'],
};

/**
 * Project a declaration the way a verified login does: the production
 * projector, over the bytes of a manifest document, keyed to a house key.
 */
export function declareReadAuth(
  db: HostDb,
  origin: string,
  houseKey: string,
  manifest: Record<string, unknown>,
  at = 1_700_000_000,
): void {
  db.transaction((tx) =>
    projectReadDeclarationInTx(
      tx,
      { origin, houseKey },
      new TextEncoder().encode(JSON.stringify(manifest)),
      at,
    ),
  );
}

/** The manifest body of a house declaring `schemes` (omit for a silent house). */
export function manifestDeclaring(
  schemes?: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    house: { name: 'test house' },
    ...(schemes === undefined ? {} : { read_auth: { schemes: [...schemes] } }),
    ...extra,
  };
}

function authorityWith(
  db: HostDb,
  signer: Signer,
  schemes: readonly string[] | undefined,
): (origin: string) => ReadAuthority {
  return (origin) => {
    // Whatever this house is pinned as, it is now also a house that served
    // that manifest. An origin with no pin gets nothing, which is the same
    // thing a real machine would have.
    try {
      const canonical = normalizeHouseOrigin(origin);
      const pin = pinnedBinding(db, canonical);
      if (pin !== undefined) declareReadAuth(db, canonical, pin.houseKey, manifestDeclaring(schemes));
    } catch {
      // An address with no canonical form is refused by the resolver itself.
    }
    return houseReadAuthority({ db, signer }, origin);
  };
}

/** A house that declares the scheme this build speaks. Still needs a pin. */
export function declaringReadAuthority(db: HostDb, signer: Signer): (origin: string) => ReadAuthority {
  return authorityWith(db, signer, [READ_CREDENTIAL_SCHEME]);
}

/** A house that declared nothing — every identity read there is refused. */
export function silentReadAuthority(db: HostDb, signer: Signer): (origin: string) => ReadAuthority {
  return authorityWith(db, signer, undefined);
}

/**
 * A house that named a scheme this build does not speak. `house-session-v2`
 * is the realistic one: it exists, it is a house-issued session token, and
 * the digits in its name are the trap.
 */
export function unknownSchemeReadAuthority(db: HostDb, signer: Signer): (origin: string) => ReadAuthority {
  return authorityWith(db, signer, ['house-session-v2']);
}

/**
 * A stand-in for tests that are NOT about the credential — a timeout, a diff,
 * a notification path — where establishing a pin would only add noise. It
 * always grants, so it can never make a credential test pass; those use the
 * real resolver above.
 */
export const grantedReadAuthority: ReadAuthority = async () => ({
  ok: true as const,
  headers: { [INBOX_TOKEN_HEADER]: 'v2.test.1700000000.signature' },
});

/** The same stand-in in the per-house shape `FollowerSyncDeps` asks for. */
export const grantingReadAuthorityFor = (): ReadAuthority => grantedReadAuthority;

/**
 * For a runtime under test that never opens an inbox. Fail-closed by design:
 * if such a test DOES reach the read path, it says so instead of quietly
 * getting a credential nobody arranged.
 */
export const refusingReadAuthorityFor = (): ReadAuthority => async () => ({
  ok: false as const,
  refusal: 'READ_AUTH_NOT_DECLARED' as const,
  message: 'this test runtime declares no read authority',
});
