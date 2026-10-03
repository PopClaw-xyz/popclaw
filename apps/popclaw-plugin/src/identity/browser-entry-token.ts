/**
 * The `pcw2` home-entry token: the bytes, and nothing else.
 *
 * A link the owner opens in a browser IS a login key for seven days, so the
 * only thing standing between "this key opens the site the owner meant" and
 * "this key opens whatever site asked for it" is the exact byte string that
 * gets signed. That byte string is defined here once, for a producer, with
 * every rule written so a verifier in another language reaches the same
 * octets — the reference implementation happens to be JavaScript, the
 * definition is not.
 *
 * ## The token
 *
 * `pcw2.<payload_b64url>.<sig_b64url>` — exactly three `.`-separated
 * segments. base64url is RFC 4648 §5 WITHOUT padding: alphabet
 * `A-Za-z0-9-_`, no `=`, and the encoding is canonical (re-encoding the
 * decoded octets yields the same segment back, so unused trailing bits are
 * zero). Segment 2 decodes to `payloadBytes`; segment 3 decodes to the raw
 * 64-octet Ed25519 signature.
 *
 * ## The payload
 *
 * `payloadBytes` are the UTF-8 octets of a JSON object emitted in ONE fixed
 * order — `v, purpose, popclaw_id, aud, iat, exp, self_portrait?` — with no
 * insignificant whitespace, integers written in plain decimal, and non-ASCII
 * text carried as raw UTF-8 rather than `\uXXXX` escapes. `self_portrait`'s
 * sub-keys keep the relative order `description, persona, home_city`, and
 * ONLY the ones actually present are emitted: an absent key is absent, never
 * padded with `null` or `""`. A `self_portrait` with nothing in it is not a
 * thing this module can produce — `{}` is a different byte string from
 * "omitted", and no legitimate producer has a reason to emit it.
 *
 * A verifier does not re-serialise before checking the signature. It checks
 * the signature over the octets it received, and separately requires that
 * re-emitting the parsed object under these rules reproduces those octets
 * byte for byte. That one comparison is what makes duplicate keys, reordered
 * fields, stray whitespace, `1e3`-style numbers and escaped Unicode all one
 * refusal instead of five checks somebody eventually forgets.
 *
 * ## The signature
 *
 * Ed25519 over `0x00 || UTF8("POPCLAW_BROWSER_ENTRY_V2") || 0x00 ||
 * payloadBytes`.
 *
 * The domain prefix is the whole defence, and it is load-bearing in a way
 * that is easy to lose: without it the signed bytes are the payload alone,
 * which is precisely what the retired `pcw1` producer signed — so a verifier
 * that "simplified" the prefix away would accept both, and the new format
 * would silently inherit the old one's reach. The leading `0x00` is not
 * decoration either: it is not a legal protobuf tag, so these bytes can never
 * be read as an EventEnvelope, and every other signing domain in this plugin
 * begins with a printable ASCII tag byte, so no two domains can collide by
 * construction rather than by anyone remembering a rule.
 *
 * ⚠️ Changing any byte above is a protocol break; both ends move together.
 * Pinned by `tests/unit/identity/browser-entry-token.test.ts` against the
 * shared contract vectors.
 */

import type { Signer } from './signer.js';

/** Segment 1, verbatim. A `pcw1` tag dies here, before anything is parsed. */
export const BROWSER_ENTRY_TAG = 'pcw2';

/** The domain tag inside the signed bytes. Not a version string — part of the message. */
export const BROWSER_ENTRY_DOMAIN = 'POPCLAW_BROWSER_ENTRY_V2';

/** `purpose` is a fixed constant, not a namespace to extend. */
export const BROWSER_ENTRY_PURPOSE = 'browser-entry';

/** Seven days, the published product semantics: repeatable, and it works on another device. */
export const BROWSER_ENTRY_TTL_SECONDS = 604800;

/** Payload ceiling in OCTETS (not characters), checked before any parsing. */
export const BROWSER_ENTRY_MAX_PAYLOAD_BYTES = 8192;

/** Whole-token ceiling in CHARACTERS, checked before any decoding. */
export const BROWSER_ENTRY_MAX_TOKEN_CHARS = 12288;

/**
 * The self-portrait sub-keys, in their canonical relative order.
 *
 * These three are what the destination actually consumes. The list is an
 * allowlist on both ends: an unknown sub-key is a refusal, never a field to
 * carry along.
 */
export const SELF_PORTRAIT_KEYS = ['description', 'persona', 'home_city'] as const;

export type SelfPortraitKey = (typeof SELF_PORTRAIT_KEYS)[number];

/** Only the keys the owner actually gave. Absent is absent. */
export type SelfPortrait = Partial<Record<SelfPortraitKey, string>>;

/** Everything a payload says, before it becomes bytes. */
export interface BrowserEntryClaims {
  readonly popclawId: string;
  /** The APPLICATION origin the key is for — not the house origin. */
  readonly audience: string;
  readonly iat: number;
  readonly exp: number;
  readonly selfPortrait?: SelfPortrait;
}

/**
 * The canonical payload octets.
 *
 * THROWS rather than repairing. This is the producing end: an empty portrait
 * value, an empty portrait object or a nonsense validity window are all
 * programmer or caller errors, and quietly cleaning them here would mean the
 * bytes the owner was shown are not the bytes that got signed.
 */
export function canonicalBrowserEntryPayload(claims: BrowserEntryClaims): Uint8Array {
  if (!Number.isSafeInteger(claims.iat) || claims.iat < 0) {
    throw new Error(`browser entry: iat must be a non-negative safe integer, got ${String(claims.iat)}`);
  }
  if (!Number.isSafeInteger(claims.exp) || claims.exp < 0) {
    throw new Error(`browser entry: exp must be a non-negative safe integer, got ${String(claims.exp)}`);
  }
  const ttl = claims.exp - claims.iat;
  if (!(ttl > 0 && ttl <= BROWSER_ENTRY_TTL_SECONDS)) {
    throw new Error(`browser entry: exp - iat must be in (0, ${BROWSER_ENTRY_TTL_SECONDS}], got ${ttl}`);
  }
  // Built by assignment in emission order, because that order IS the format.
  // An object spread of the caller's portrait would carry ITS key order in,
  // and the canonical form would then depend on how the caller happened to
  // write a literal.
  const payload: Record<string, unknown> = {
    v: 2,
    purpose: BROWSER_ENTRY_PURPOSE,
    popclaw_id: claims.popclawId,
    aud: claims.audience,
    iat: claims.iat,
    exp: claims.exp,
  };
  const portrait = canonicalSelfPortrait(claims.selfPortrait);
  if (portrait !== undefined) payload['self_portrait'] = portrait;
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** The portrait in canonical order, or `undefined` when there is nothing to say. */
function canonicalSelfPortrait(given: SelfPortrait | undefined): Record<string, string> | undefined {
  if (given === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const key of SELF_PORTRAIT_KEYS) {
    const value = given[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`browser entry: self_portrait.${key} must be a non-empty string`);
    }
    out[key] = value;
  }
  // `{}` is a byte string with no legitimate producer: a portrait nobody
  // filled in is an absent field, and emitting the empty object instead would
  // hand a verifier something it is required to refuse.
  return Object.keys(out).length === 0 ? undefined : out;
}

/** `0x00 || UTF8(domain) || 0x00 || payloadBytes`. See this file's header for why. */
export function browserEntrySigningBytes(payloadBytes: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode(BROWSER_ENTRY_DOMAIN);
  const out = new Uint8Array(1 + tag.length + 1 + payloadBytes.length);
  out[0] = 0x00;
  out.set(tag, 1);
  out[1 + tag.length] = 0x00;
  out.set(payloadBytes, 1 + tag.length + 1);
  return out;
}

/**
 * base64url, RFC 4648 §5, no padding.
 *
 * Spelled out rather than left to a library default because the padding is
 * the part everybody gets differently: `Buffer`'s `base64url` already omits
 * `=`, and the `replace` is a belt for the day that changes under us.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url').replace(/=+$/, '');
}

/** `pcw2.<payload>.<signature>` — the only place the three segments are joined. */
export function encodeBrowserEntryToken(payloadBytes: Uint8Array, signature: Uint8Array): string {
  return `${BROWSER_ENTRY_TAG}.${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`;
}

/** What minting produced, so a caller can show the owner exactly what was signed. */
export interface MintedBrowserEntry {
  readonly token: string;
  readonly payloadBytes: Uint8Array;
  readonly claims: BrowserEntryClaims;
}

/**
 * Sign one home-entry payload with the owner's key.
 *
 * The key never appears here: `Signer` is handed the bytes and returns a
 * signature, exactly as `popclaw_pair_browser` does. This function is also
 * the only clock on the path — `iat` is taken from the caller's clock seam
 * and `exp` is derived, so no agent and no request body ever chooses how long
 * a key lives.
 */
export async function mintBrowserEntryToken(opts: {
  readonly signer: Signer;
  readonly audience: string;
  readonly nowSeconds: number;
  readonly selfPortrait?: SelfPortrait;
}): Promise<MintedBrowserEntry> {
  const popclawId = await opts.signer.popclawId();
  const iat = opts.nowSeconds;
  const claims: BrowserEntryClaims = {
    popclawId,
    audience: opts.audience,
    iat,
    exp: iat + BROWSER_ENTRY_TTL_SECONDS,
    ...(opts.selfPortrait === undefined ? {} : { selfPortrait: opts.selfPortrait }),
  };
  const payloadBytes = canonicalBrowserEntryPayload(claims);
  const signature = await opts.signer.sign(browserEntrySigningBytes(payloadBytes));
  return { token: encodeBrowserEntryToken(payloadBytes, signature), payloadBytes, claims };
}

/** The long link: the declared entry URL carrying the token. Same origin as `aud`, always. */
export function browserEntryLongLink(entryUrl: string, token: string): string {
  const url = new URL(entryUrl);
  url.searchParams.set('t', token);
  return url.toString();
}
