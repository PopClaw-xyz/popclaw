/**
 * Choosing an authentication scheme is a set of refusals, not a fallback chain.
 *
 * A house says what it can actually verify. Every way of reading that
 * declaration wrongly ends the same way — the client sends a credential the
 * house will not accept — but the failures that matter are the ones that do
 * not look like failures:
 *
 *   Falling back to the old shape when the field is absent turns "this house
 *   does not do identity reads" into a refusal the owner reads as "nobody
 *   follows me". An empty follower list is indistinguishable from a working
 *   house with no followers, so nothing ever surfaces.
 *
 *   Matching loosely on the name is worse than not matching at all:
 *   `house_session.proto` already has a thing called v2, issued BY a house
 *   and bound to a session. Treating any name containing "v2" as this scheme
 *   sends session credentials to an endpoint expecting an identity
 *   signature, and the refusal gets read as a key problem.
 *
 * So the rule is exact-match or refuse, and the refusals stay distinct: a
 * house that declared nothing and a house that declared something we do not
 * speak are different conversations to have with the owner.
 */
import { describe, expect, it } from 'vitest';
import { declarationOf } from '../../../src/world/house-read-declaration.js';
import { fetchHouseManifest } from '../../../src/world/manifest-client.js';
import {
  READ_CREDENTIAL_SCHEME,
  selectReadScheme,
  readAuthSchemesOf,
} from '../../../src/identity/read-credential.js';

describe('selecting a read authentication scheme', () => {
  it('accepts the house that names this scheme exactly', () => {
    expect(selectReadScheme([READ_CREDENTIAL_SCHEME])).toEqual({ scheme: READ_CREDENTIAL_SCHEME });
  });

  it('refuses when the house declared nothing — and does not fall back', () => {
    const choice = selectReadScheme(undefined);
    // Not `{scheme: ...}` under any name: there is no v1 lane left, no
    // anonymous lane, and no "assume it works and find out".
    expect(choice).toEqual({ refusal: 'READ_AUTH_NOT_DECLARED' });
    expect(choice).not.toHaveProperty('scheme');
  });

  it('refuses a name that merely contains v2 — the session token is not this', () => {
    // The trap this exists for: a house-issued, session-bound credential
    // that also calls itself v2.
    expect(selectReadScheme(['v2'])).toEqual({ refusal: 'READ_AUTH_SCHEME_UNSUPPORTED' });
    expect(selectReadScheme(['house-session-v2'])).toEqual({ refusal: 'READ_AUTH_SCHEME_UNSUPPORTED' });
  });

  it('refuses a near-miss of this scheme\'s own name', () => {
    // Prefix and suffix, both directions — a loose `startsWith` or
    // `includes` on either side would let one of these through.
    expect(selectReadScheme([`${READ_CREDENTIAL_SCHEME}-beta`]))
      .toEqual({ refusal: 'READ_AUTH_SCHEME_UNSUPPORTED' });
    expect(selectReadScheme(['popclaw-identity-read'])).toEqual({ refusal: 'READ_AUTH_SCHEME_UNSUPPORTED' });
  });

  it('picks this scheme out of a list that also names others', () => {
    expect(selectReadScheme(['something-else', READ_CREDENTIAL_SCHEME])).toEqual({ scheme: READ_CREDENTIAL_SCHEME });
  });

  it('keeps "declared nothing" and "declared something unknown" apart', () => {
    // Different things to tell the owner: one house does not offer this at
    // all, the other offers something this build cannot speak.
    expect(selectReadScheme([])).toEqual({ refusal: 'READ_AUTH_SCHEME_UNSUPPORTED' });
    expect(selectReadScheme(undefined)).toEqual({ refusal: 'READ_AUTH_NOT_DECLARED' });
  });
});

describe('reading the declaration out of a manifest', () => {
  it('absent field reads as absent, not as empty', () => {
    expect(readAuthSchemesOf({})).toBeUndefined();
    expect(readAuthSchemesOf({ read_auth: null })).toBeUndefined();
  });

  it('takes the declared names verbatim', () => {
    expect(readAuthSchemesOf({ read_auth: { schemes: [READ_CREDENTIAL_SCHEME] } }))
      .toEqual([READ_CREDENTIAL_SCHEME]);
  });

  it('a malformed declaration grants nothing, and is not mistaken for absence', () => {
    // Present but unusable. Reporting it as absent would be a lie about what
    // the house said; reporting it as a scheme list would be worse.
    for (const bad of [{ read_auth: {} }, { read_auth: { schemes: 'v2' } }, { read_auth: [] }]) {
      const schemes = readAuthSchemesOf(bad);
      expect(schemes).toEqual([]);
      expect(selectReadScheme(schemes)).toEqual({ refusal: 'READ_AUTH_SCHEME_UNSUPPORTED' });
    }
  });

  it('drops non-string entries rather than carrying them into a comparison', () => {
    expect(readAuthSchemesOf({ read_auth: { schemes: [1, null, READ_CREDENTIAL_SCHEME, ''] } }))
      .toEqual([READ_CREDENTIAL_SCHEME]);
  });
});

/**
 * The parser above is only worth having if the path that carries it is the
 * path that can be trusted. A correct function nothing calls was this round's
 * other bug twice over — and a correct function called from the WRONG fetch
 * was the round after that: the lenient manifest client has no proof header,
 * so what it parsed could not decide which credential went anywhere.
 */
describe('the declaration survives the VERIFIED fetch, and only that one', () => {
  const BASE = 'https://house.example';
  const bytesOf = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
  const serving = (body: unknown): typeof globalThis.fetch =>
    (async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

  it('a declaring house arrives with its scheme, ready to be selected', () => {
    const declared = declarationOf(bytesOf({
      house: { name: 'h', slug: 'h' }, read_auth: { schemes: [READ_CREDENTIAL_SCHEME] },
    })).schemes;
    expect(declared).toEqual([READ_CREDENTIAL_SCHEME]);
    expect(selectReadScheme(declared)).toEqual({ scheme: READ_CREDENTIAL_SCHEME });
  });

  it('a silent house arrives silent, and selection refuses', () => {
    const declared = declarationOf(bytesOf({ house: { name: 'h', slug: 'h' } })).schemes;
    expect(declared).toBeUndefined();
    expect(selectReadScheme(declared)).toEqual({ refusal: 'READ_AUTH_NOT_DECLARED' });
  });

  it('is not carried by the lenient manifest client, which reads no proof', async () => {
    const r = await fetchHouseManifest(BASE, {
      fetch: serving({ house: { name: 'h', slug: 'h' }, read_auth: { schemes: [READ_CREDENTIAL_SCHEME] } }),
    });
    expect(r.status).toBe('ok');
    expect('readAuthSchemes' in (r as { manifest: object }).manifest).toBe(false);
  });
});
