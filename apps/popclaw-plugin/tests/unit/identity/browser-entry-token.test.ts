/**
 * The `pcw2` bytes, checked in both directions against the shared vectors.
 *
 * `tests/fixtures/pcw2-home-entry-vectors.json` is the SAME file the site
 * verifies against — 42 vectors over one throwaway Ed25519 seed, with the
 * exact signed octets recorded as hex. Running it here proves two different
 * things, and both are needed:
 *
 *  - the builder reproduces every accepted vector's token BYTE FOR BYTE from
 *    that vector's own key, times and portrait. Anything weaker (a token that
 *    verifies, a payload that parses) would pass with a producer that emits a
 *    different canonical form from the one the site requires;
 *  - a reference verifier written from the contract, not from the producer's
 *    helpers, returns the expected verdict AND the expected reason for all 42.
 *
 * The key in the fixture is a fixed seed so the vectors are reproducible. It
 * is not an identity and must never be used anywhere else.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import {
  BROWSER_ENTRY_DOMAIN,
  BROWSER_ENTRY_TTL_SECONDS,
  browserEntryLongLink,
  browserEntrySigningBytes,
  canonicalBrowserEntryPayload,
  encodeBrowserEntryToken,
  mintBrowserEntryToken,
  type SelfPortrait,
} from '../../../src/identity/browser-entry-token.js';
import { verifyBrowserEntryToken } from '../../helpers/browser-entry-verifier.js';

interface Vector {
  id: string;
  note: string;
  expect: 'accept' | 'reject';
  error: string | null;
  token: string;
  signed_bytes_hex: string | null;
}

const VECTORS = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/pcw2-home-entry-vectors.json'),
    'utf-8',
  ),
) as {
  domain: string;
  audience: string;
  verify_now_unix_seconds: number;
  test_key: { ed25519_seed_hex: string; popclaw_id: string };
  vectors: Vector[];
};

const NOW = VECTORS.verify_now_unix_seconds;
const AUD = VECTORS.audience;

/** The throwaway fixture key, as a Signer — the same seam production signs through. */
function fixtureSigner(): MasterKeySigner {
  const seed = new Uint8Array(Buffer.from(VECTORS.test_key.ed25519_seed_hex, 'hex'));
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return new MasterKeySigner({
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  });
}

/** Rebuilds one vector's token from its recorded claims, through the production path. */
function rebuild(claims: Record<string, unknown>): string {
  const payload = canonicalBrowserEntryPayload({
    popclawId: claims['popclaw_id'] as string,
    audience: claims['aud'] as string,
    iat: claims['iat'] as number,
    exp: claims['exp'] as number,
    ...(claims['self_portrait'] === undefined
      ? {}
      : { selfPortrait: claims['self_portrait'] as SelfPortrait }),
  });
  const seed = new Uint8Array(Buffer.from(VECTORS.test_key.ed25519_seed_hex, 'hex'));
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const signature = nacl.sign.detached(browserEntrySigningBytes(payload), kp.secretKey);
  return encodeBrowserEntryToken(payload, signature);
}

describe('pcw2 contract vectors', () => {
  it('covers every vector in the shared file, with no silent skips', () => {
    expect(VECTORS.vectors.length).toBe(42);
    expect(VECTORS.domain).toBe(BROWSER_ENTRY_DOMAIN);
    expect(new Set(VECTORS.vectors.map((v) => v.id)).size).toBe(42);
  });

  it('the reference verifier returns the expected verdict AND reason for all 42', () => {
    const wrong: string[] = [];
    for (const v of VECTORS.vectors) {
      const got = verifyBrowserEntryToken(v.token, { audience: AUD, nowSeconds: NOW });
      const verdict = got.ok ? 'accept' : 'reject';
      const reason = got.ok ? null : got.error;
      if (verdict !== v.expect || reason !== v.error) {
        wrong.push(`${v.id}: expected ${v.expect}/${v.error ?? '-'}, got ${verdict}/${reason ?? '-'}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('the builder reproduces every accepted vector byte for byte', () => {
    const mismatched: string[] = [];
    for (const v of VECTORS.vectors) {
      if (v.expect !== 'accept') continue;
      const got = verifyBrowserEntryToken(v.token, { audience: AUD, nowSeconds: NOW });
      if (!got.ok) throw new Error(`${v.id} should verify`);
      const rebuilt = rebuild(got.claims);
      if (rebuilt !== v.token) mismatched.push(`${v.id}:\n  want ${v.token}\n  got  ${rebuilt}`);
    }
    expect(mismatched, mismatched.join('\n')).toEqual([]);
  });

  it('the signed octets match the hex the vector file records', () => {
    const wrong: string[] = [];
    for (const v of VECTORS.vectors) {
      if (v.expect !== 'accept' || v.signed_bytes_hex === null) continue;
      const payloadSeg = v.token.split('.')[1]!;
      const payloadBytes = new Uint8Array(Buffer.from(payloadSeg, 'base64url'));
      const hex = Buffer.from(browserEntrySigningBytes(payloadBytes)).toString('hex');
      if (hex !== v.signed_bytes_hex) wrong.push(v.id);
    }
    expect(wrong).toEqual([]);
  });

  /**
   * The fallback a lost domain tag fails INTO. Without the prefix the signed
   * bytes are the payload alone, which is what the retired pcw1 producer
   * signed — so a verifier that dropped the prefix would accept this, and the
   * new format would inherit the old one's reach in silence.
   */
  it('a token signed over the bare payload, with no domain prefix, is refused', () => {
    const v = VECTORS.vectors.find((x) => x.id === 'bare_signature_fallback')!;
    expect(verifyBrowserEntryToken(v.token, { audience: AUD, nowSeconds: NOW })).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('a valid signature under a neighbouring domain tag is refused', () => {
    const v = VECTORS.vectors.find((x) => x.id === 'wrong_domain_signature')!;
    expect(verifyBrowserEntryToken(v.token, { audience: AUD, nowSeconds: NOW })).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });
});

describe('the signing preimage', () => {
  it('is 0x00 || the domain tag || 0x00 || the payload, in that order', () => {
    const payload = new TextEncoder().encode('{"x":1}');
    const bytes = browserEntrySigningBytes(payload);
    expect(bytes[0]).toBe(0x00);
    expect(new TextDecoder().decode(bytes.subarray(1, 1 + BROWSER_ENTRY_DOMAIN.length))).toBe(
      BROWSER_ENTRY_DOMAIN,
    );
    expect(bytes[1 + BROWSER_ENTRY_DOMAIN.length]).toBe(0x00);
    expect(bytes.subarray(2 + BROWSER_ENTRY_DOMAIN.length)).toEqual(payload);
  });

  /**
   * Not a style point. Every other domain this key signs begins with a
   * printable ASCII tag byte (`canvas-upload\0…` starts at 0x63), so the two
   * families cannot collide by construction rather than by anyone remembering
   * a rule about NUL bytes.
   */
  it('starts with a raw 0x00, which no ASCII-tagged domain can produce', () => {
    expect(browserEntrySigningBytes(new Uint8Array([1]))[0]).toBe(0x00);
  });
});

describe('canonical payload emission', () => {
  const base = { popclawId: VECTORS.test_key.popclaw_id, audience: AUD, iat: NOW, exp: NOW + 604800 };
  const text = (p: Uint8Array) => new TextDecoder().decode(p);

  it('emits the top-level keys in the fixed contract order', () => {
    expect(text(canonicalBrowserEntryPayload(base))).toBe(
      `{"v":2,"purpose":"browser-entry","popclaw_id":"${base.popclawId}","aud":"${AUD}","iat":${NOW},"exp":${NOW + 604800}}`,
    );
  });

  it('emits self_portrait sub-keys in the canonical relative order, whatever order the caller used', () => {
    const out = text(
      canonicalBrowserEntryPayload({
        ...base,
        selfPortrait: { home_city: 'Hangzhou', persona: 'curious', description: 'a test lobster' },
      }),
    );
    expect(out.endsWith(
      '"self_portrait":{"description":"a test lobster","persona":"curious","home_city":"Hangzhou"}}',
    )).toBe(true);
  });

  it('omits absent sub-keys entirely rather than padding them', () => {
    const out = text(canonicalBrowserEntryPayload({ ...base, selfPortrait: { persona: 'curious' } }));
    expect(out).toContain('"self_portrait":{"persona":"curious"}');
    expect(out).not.toContain('null');
    expect(out).not.toContain('"description"');
  });

  it('never emits an empty self_portrait — an unfilled portrait is an absent field', () => {
    expect(text(canonicalBrowserEntryPayload({ ...base, selfPortrait: {} }))).not.toContain('self_portrait');
    expect(
      text(canonicalBrowserEntryPayload({ ...base, selfPortrait: { persona: undefined } })),
    ).not.toContain('self_portrait');
  });

  it('refuses an empty portrait value instead of emitting one the site must reject', () => {
    expect(() => canonicalBrowserEntryPayload({ ...base, selfPortrait: { persona: '' } })).toThrow(
      /non-empty/,
    );
  });

  it('refuses a validity window outside (0, seven days]', () => {
    expect(() => canonicalBrowserEntryPayload({ ...base, exp: base.iat })).toThrow(/exp - iat/);
    expect(() =>
      canonicalBrowserEntryPayload({ ...base, exp: base.iat + BROWSER_ENTRY_TTL_SECONDS + 1 }),
    ).toThrow(/exp - iat/);
    expect(() => canonicalBrowserEntryPayload({ ...base, iat: 1.5, exp: 1.5 + 60 })).toThrow(/iat/);
  });
});

describe('minting through the Signer seam', () => {
  it('takes its own clock, fixes the seven-day window, and never sees key bytes', async () => {
    const signer = fixtureSigner();
    const minted = await mintBrowserEntryToken({ signer, audience: AUD, nowSeconds: NOW });
    expect(minted.claims.iat).toBe(NOW);
    expect(minted.claims.exp).toBe(NOW + BROWSER_ENTRY_TTL_SECONDS);
    const verdict = verifyBrowserEntryToken(minted.token, { audience: AUD, nowSeconds: NOW });
    expect(verdict.ok).toBe(true);
  });

  it('produces the canonical vector token for the vector claims', async () => {
    const signer = fixtureSigner();
    const minted = await mintBrowserEntryToken({
      signer,
      audience: AUD,
      nowSeconds: NOW - 60,
      selfPortrait: { description: 'a test lobster', persona: 'curious', home_city: 'Hangzhou' },
    });
    expect(minted.token).toBe(VECTORS.vectors.find((v) => v.id === 'valid_self_portrait')!.token);
  });
});

describe('the long link', () => {
  it('carries the token on the declared entry URL and nowhere else', () => {
    const link = browserEntryLongLink('https://popclaw.world/welcome', 'pcw2.a.b');
    expect(link).toBe('https://popclaw.world/welcome?t=pcw2.a.b');
    expect(new URL(link).origin).toBe(AUD);
  });
});
