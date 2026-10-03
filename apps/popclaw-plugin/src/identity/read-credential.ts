/**
 * `popclaw-identity-read-v2` — proving, per request, who is asking to read.
 *
 * Contract: `docs/contracts/relation-read-credential-v2.md`.
 * Vectors:   `packages/contracts/fixtures/relation-read-v2-vectors.json`.
 *
 * Why the scheme is not called "v2": `house_session.proto` already has a
 * thing by that name, and that one is issued BY a house and bound to a
 * session. This one is issued by the identity key itself. Two different
 * authentications sharing a version number is how a client ends up sending
 * the wrong one and reading the refusal as a key problem.
 *
 * Three properties are easy to get wrong and each fails quietly:
 *
 *   - The origin is LAST because it is the only field that may contain a
 *     colon (`http://[::1]:8102`). Every earlier field is constrained to
 *     exclude one, which is what makes the message unambiguous. It is NOT
 *     enough to say "nobody ever parses this" — if two distinct legitimate
 *     tuples can produce the same bytes, rebuilding rather than parsing does
 *     not save you.
 *
 *   - `ts` is Unix epoch SECONDS. A millisecond value passes every syntax
 *     rule (16-char bound, 2^53-1 ceiling) and fails only the freshness
 *     compare — which looks exactly like clock skew, so the investigation
 *     goes to NTP and never to the unit.
 *
 *   - The audience origin is COPIED VERBATIM from the verified
 *     `HouseBinding`, never re-derived here. The house signed that string
 *     into its manifest proof; having verified the proof, we have verified
 *     the string. Canonicalising it a second time on this side would create
 *     a second place for the two ends to disagree, which is precisely the
 *     shape of the CID divergence this protocol is trying not to repeat.
 */
import type { Signer } from './signer.js';

export const READ_CREDENTIAL_SCHEME = 'popclaw-identity-read-v2';

/**
 * The header a read credential rides in.
 *
 * The NAME is unchanged from the shape this replaces — the house at the other
 * end reads exactly this key, and renaming it would be a second migration
 * bought for nothing. Only the value's shape changed. It lives here, beside
 * the credential it carries, so a new call site never has to import its header
 * from the module that holds the format nobody may send any more.
 */
export const INBOX_TOKEN_HEADER = 'x-popclaw-inbox-token';

/** The wire form's version segment — not the scheme name, and not optional. */
export const READ_CREDENTIAL_WIRE_VERSION = 'v2';

/**
 * Both ends fix the same ceiling. Nothing this builder emits approaches it:
 * neither the purpose nor the origin rides on the wire, so a token is
 * `v2.` + id + `.` + ts + `.` + signature — 147 characters for a 44-character
 * id and a 10-digit second. The headroom is for `ts` texts up to the 16
 * characters the contract allows.
 */
export const READ_CREDENTIAL_MAX_TOKEN_CHARS = 153;

/** One per endpoint CLASS. A snapshot credential must not open evidence. */
export type ReadPurpose =
  | 'relation-list'
  | 'inbox-stream'
  | 'relation-snapshot'
  | 'relation-evidence';

/**
 * The minimum the house must already be trusted about, and nothing more.
 *
 * Deliberately NOT the whole `HouseBinding`: `incarnation` is excluded so a
 * database restore cannot turn the read-authorisation identity into a
 * different one. Relation claims, capabilities and participation state stay
 * out too — a house with a sound origin and key can serve private messages
 * whether or not it speaks the ordered relation protocol.
 */
export interface ReadAudience {
  /** Verbatim from the verified binding. Never re-normalised here. */
  readonly origin: string;
  /** Base58, verbatim from the verified binding. */
  readonly houseKey: string;
}

/** The exact bytes the identity key signs. Fixed ASCII, fixed field order. */
export function readCredentialMessage(
  purpose: ReadPurpose,
  requesterPopclawId: string,
  audience: ReadAudience,
  ts: number,
): string {
  return `${READ_CREDENTIAL_SCHEME}:${purpose}:${requesterPopclawId}:${audience.houseKey}:${ts}:${audience.origin}`;
}

/**
 * One credential for ONE request.
 *
 * Not one per batch: the freshness window is freshness for a request, not a
 * budget for a sweep, and a caller that signs once and reuses it across a
 * long run gets refused at whichever request happens to cross the boundary.
 *
 * Two identical calls in the same second produce an identical token, and that
 * is fine — this contract establishes purpose and freshness, and does not
 * promise single-use replay protection within a house.
 */
export async function buildReadCredential(
  signer: Signer,
  audience: ReadAudience,
  purpose: ReadPurpose,
  clock: () => number = () => Date.now(),
): Promise<string> {
  const ts = Math.floor(clock() / 1000);
  const requesterPopclawId = await signer.popclawId();
  const message = readCredentialMessage(purpose, requesterPopclawId, audience, ts);
  const signature = await signer.sign(new TextEncoder().encode(message));
  return [READ_CREDENTIAL_WIRE_VERSION, requesterPopclawId, String(ts), encodeBase64(signature)].join('.');
}

function encodeBase64(b: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/**
 * What a house says it can verify, and what this client may do about it.
 *
 * The declaration's precondition on the house side is whether it can VERIFY
 * — whether it has a read audience at all — not whether it speaks any
 * particular relation protocol. The sign only advertises what the engine can
 * actually do.
 *
 * All three rules below refuse. None of them falls back, and that is the
 * point: the old shape is not dual-accepted, so a client that "tries the old
 * way" when the new declaration is missing produces a refusal the owner
 * reads as an empty follower list — a working house with no followers looks
 * exactly the same, so nothing ever surfaces.
 */
export type ReadSchemeChoice =
  | { readonly scheme: typeof READ_CREDENTIAL_SCHEME }
  | { readonly refusal: 'READ_AUTH_NOT_DECLARED' | 'READ_AUTH_SCHEME_UNSUPPORTED' };

/**
 * Exact match or refuse.
 *
 * Deliberately not a prefix, suffix or substring test: `house_session.proto`
 * already carries a credential called v2, issued BY a house and bound to a
 * session, and it is not this one. Sending that to an endpoint expecting an
 * identity signature earns a refusal the owner reads as a key problem.
 *
 * `undefined` (no declaration) and `[]` (a declaration naming nothing) both
 * refuse, and stay distinguishable: one house does not offer this, the other
 * offers something this build cannot speak, and they are different things to
 * tell someone.
 */
export function selectReadScheme(declared: readonly string[] | undefined): ReadSchemeChoice {
  if (declared === undefined) return { refusal: 'READ_AUTH_NOT_DECLARED' };
  return declared.includes(READ_CREDENTIAL_SCHEME)
    ? { scheme: READ_CREDENTIAL_SCHEME }
    : { refusal: 'READ_AUTH_SCHEME_UNSUPPORTED' };
}

/**
 * Lift `read_auth.schemes` out of a parsed manifest.
 *
 * `undefined` means the house said nothing. A present but malformed block
 * yields an empty list rather than `undefined`: it did say something, and
 * reporting that as silence would misdescribe the house — while reporting it
 * as a scheme list would be worse. Either way it grants nothing.
 */
export function readAuthSchemesOf(doc: Record<string, unknown>): readonly string[] | undefined {
  const block = doc['read_auth'];
  if (block === undefined || block === null) return undefined;
  const schemes = (block as Record<string, unknown>)['schemes'];
  if (!Array.isArray(schemes)) return [];
  return schemes.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
