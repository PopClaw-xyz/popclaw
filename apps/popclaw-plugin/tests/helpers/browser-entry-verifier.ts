/**
 * A reference `pcw2` verifier — test-tree only, deliberately NOT shipped.
 *
 * The plugin only ever produces these tokens; the site consumes them. So the
 * only way this repo can prove its producer is right is to verify its own
 * output with an independent reading of the contract, and to run that reading
 * against the same vector file the other end runs. This is that reading.
 *
 * Independent means independent: it re-derives the canonical form from its own
 * parse rather than calling `canonicalBrowserEntryPayload`, and it rebuilds
 * the signing bytes from the literal rule rather than calling
 * `browserEntrySigningBytes`. If it imported the producer's helpers, a
 * mistake in either would cancel itself out and every vector would still pass
 * — which is exactly the failure a shared vector file exists to catch.
 *
 * The order of the checks is part of the contract, not an implementation
 * detail: structure and type failures come BEFORE the signature check, so a
 * malformed token is reported as malformed. The signature check comes before
 * the semantic ones, so a tampered token is reported as a bad signature
 * rather than as a mismatched audience. Beyond that there is no secrecy to
 * claim: an attacker can sign their own payload with the wrong `aud`, so
 * "bad_audience" tells them nothing they did not already know.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export type VerifyError =
  | 'bad_format'
  | 'bad_version'
  | 'bad_signature'
  | 'bad_purpose'
  | 'bad_audience'
  | 'not_yet_valid'
  | 'bad_ttl'
  | 'expired';

export type VerifyResult =
  | { readonly ok: true; readonly claims: Record<string, unknown> }
  | { readonly ok: false; readonly error: VerifyError };

const TAG = 'pcw2';
const DOMAIN = 'POPCLAW_BROWSER_ENTRY_V2';
const MAX_PAYLOAD_BYTES = 8192;
const MAX_TOKEN_CHARS = 12288;
const MAX_TTL = 604800;
const MAX_SKEW = 60;
const TOP_LEVEL_KEYS = ['v', 'purpose', 'popclaw_id', 'aud', 'iat', 'exp', 'self_portrait'];
const PORTRAIT_KEYS = ['description', 'persona', 'home_city'];
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface VerifyOptions {
  /** The server's own fixed audience. Never derived from the token or a request header. */
  readonly audience: string;
  readonly nowSeconds: number;
}

export function verifyBrowserEntryToken(token: string, opts: VerifyOptions): VerifyResult {
  // 1 — shape, before anything is decoded.
  if (token.length > MAX_TOKEN_CHARS) return bad('bad_format');
  const segments = token.split('.');
  if (segments.length !== 3) return bad('bad_format');
  const [tag, payloadSeg, sigSeg] = segments as [string, string, string];
  if (tag !== TAG) return bad('bad_version');
  if (!B64URL.test(payloadSeg) || !B64URL.test(sigSeg)) return bad('bad_format');

  // 2 — canonical base64url: decoding and re-encoding has to round-trip, so
  // a segment with non-zero trailing bits is not a second spelling of the
  // same octets.
  const payloadBytes = Buffer.from(payloadSeg, 'base64url');
  const signature = Buffer.from(sigSeg, 'base64url');
  if (payloadBytes.toString('base64url') !== payloadSeg) return bad('bad_format');
  if (signature.toString('base64url') !== sigSeg) return bad('bad_format');
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) return bad('bad_format');

  // 3 — strict UTF-8, then a JSON object (not an array, not a scalar).
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
  } catch {
    return bad('bad_format');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad('bad_format');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return bad('bad_format');
  const claims = parsed as Record<string, unknown>;

  // 4 — allowlist. An unknown key is a refusal, never a field to ignore.
  for (const key of Object.keys(claims)) {
    if (!TOP_LEVEL_KEYS.includes(key)) return bad('bad_format');
  }
  // 5 — version, before the rest of the types: a v1 payload under a pcw2 tag
  // is a version problem even if everything else about it were fine.
  if (claims['v'] !== 2) return bad('bad_version');

  // 6 — types and required claims. `missing aud` lands here, as bad_format:
  // nothing was named, so there is nothing to compare against.
  for (const key of ['purpose', 'popclaw_id', 'aud'] as const) {
    if (typeof claims[key] !== 'string' || (claims[key] as string).length === 0) return bad('bad_format');
  }
  for (const key of ['iat', 'exp'] as const) {
    const value = claims[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return bad('bad_format');
  }
  if ('self_portrait' in claims && !portraitIsWellFormed(claims['self_portrait'])) return bad('bad_format');

  // 7 — canonical form, byte for byte. One comparison covers duplicate keys,
  // field order, whitespace, number spelling and escaped Unicode.
  if (reserialize(claims) !== text) return bad('bad_format');

  // 8 — key and signature sizes, then the signature itself.
  let publicKey: Uint8Array;
  try {
    publicKey = bs58.decode(claims['popclaw_id'] as string);
  } catch {
    return bad('bad_format');
  }
  if (publicKey.length !== 32 || signature.length !== 64) return bad('bad_format');
  const signed = signingBytes(payloadBytes);
  if (!nacl.sign.detached.verify(signed, new Uint8Array(signature), publicKey)) return bad('bad_signature');

  // 9 — semantics, only now that the message is known to be this key's word.
  if (claims['purpose'] !== 'browser-entry') return bad('bad_purpose');
  if (claims['aud'] !== opts.audience) return bad('bad_audience');
  const iat = claims['iat'] as number;
  const exp = claims['exp'] as number;
  if (iat > opts.nowSeconds + MAX_SKEW) return bad('not_yet_valid');
  const ttl = exp - iat;
  if (!(ttl > 0 && ttl <= MAX_TTL)) return bad('bad_ttl');
  if (!(opts.nowSeconds < exp)) return bad('expired');
  return { ok: true, claims };
}

function bad(error: VerifyError): VerifyResult {
  return { ok: false, error };
}

/** The literal signing rule, spelled out here rather than imported. */
function signingBytes(payloadBytes: Uint8Array): Uint8Array {
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x00]), Buffer.from(DOMAIN, 'utf8'), Buffer.from([0x00]), Buffer.from(payloadBytes)]),
  );
}

/** An object whose keys are all allowlisted, whose values are all non-empty strings, and which is not empty. */
function portraitIsWellFormed(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => PORTRAIT_KEYS.includes(k) && typeof v === 'string' && v.length > 0);
}

/** The canonical emission, rebuilt from the parsed claims alone. */
function reserialize(claims: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of TOP_LEVEL_KEYS) {
    if (key === 'self_portrait') continue;
    if (key in claims) out[key] = claims[key];
  }
  if ('self_portrait' in claims) {
    const portrait: Record<string, unknown> = {};
    const given = claims['self_portrait'] as Record<string, unknown>;
    for (const key of PORTRAIT_KEYS) if (key in given) portrait[key] = given[key];
    out['self_portrait'] = portrait;
  }
  return JSON.stringify(out);
}
