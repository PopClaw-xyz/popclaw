/**
 * Which house is this, really — and is this exact manifest its word?
 *
 * `house_key` is the relation namespace: an edge is (house, author, target),
 * and a key that quietly changes re-names every edge into a space nobody wrote
 * them in. So this is not a nicety on top of the handshake; nothing ordered can
 * honestly be signed or applied without it.
 *
 * **The two questions are different.** A pin answers *which key do we trust at
 * this origin*. A proof answers *is this exact manifest, and this incarnation,
 * backed by that key*. Neither substitutes for the other, which is why both are
 * here: a signature made with a key that arrived in the same response it is
 * meant to prove is not an independent source of anything. The pin is supplied
 * by the caller; this module never learns one from the bytes it is checking.
 *
 * Narrowed to the binding on purpose. The capability discovery that usually
 * sits around it — world executor, guide, schema vocabulary — is a separate
 * system and is deliberately not brought across.
 */
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';

/** The verified tuple. Every field has been checked against the pin. */
export interface VerifiedHouseBinding {
  readonly origin: string;
  readonly houseKey: string;
  readonly incarnation: string;
  /** SHA-256 hex of the exact response body this binding was proved over. */
  readonly manifestDigest: string;
  /** The exact proof bytes this verdict was reached over. */
  readonly proofBytes: Uint8Array;
}

export interface ManifestProofInput {
  /** The origin we ASKED, normalised. Not one read out of the response. */
  readonly origin: string;
  /** The exact bytes served. The digest is taken over these, not a re-encode. */
  readonly rawBytes: Uint8Array;
  /** The `X-Popclaw-Manifest-Proof` header value, base64. */
  /** The served header. `null`/empty is MISSING — a state this verifier names
   *  rather than one its callers each have to check for first. */
  readonly proofHeader: string | null;
  /** The pinned authority key for this origin, base58. Never from the response. */
  readonly pinnedHouseKey: string;
}

/** Refusal codes. Bare, so a caller can branch without matching prose. */
export type ManifestProofFailure =
  | 'MANIFEST_PROOF_MISSING'
  | 'MANIFEST_PROOF_MALFORMED'
  | 'MANIFEST_PROOF_BINDING_MISMATCH'
  | 'MANIFEST_PROOF_SIGNATURE_INVALID'
  | 'HOUSE_PIN_INVALID';

export class ManifestProofError extends Error {
  constructor(readonly code: ManifestProofFailure) {
    super(code);
    this.name = 'ManifestProofError';
  }
}

/** The domain prefix. A fixed protocol constant — never read off a response. */
const PROOF_DOMAIN = 'POPCLAW_WORLD_MANIFEST_PROOF_V1';

/** Generous for a signature and a short binding; small enough to bound work. */
const MAX_PROOF_HEADER = 8192;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// eslint-disable-next-line no-control-regex -- an opaque binding rejects control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Verify that these exact bytes are this pinned house's word.
 *
 * Every check is against something the caller already held or already asked
 * for — the pinned key, the origin we requested, the bytes we received. The
 * response contributes only the claim being tested.
 */
/**
 * The same 32-byte authority key, spelled the way the binding spells it.
 *
 * The session-ACK key is hex and `HouseBinding.house_key` is base58, and the
 * public contract says in as many words that they denote the SAME key
 * (world_interaction.proto). This is that one conversion, in one place, so no
 * caller re-derives it and no two callers can disagree about it.
 *
 * It is a re-spelling and nothing more. Holding the ACK key does not make a
 * house's manifest authentic — only verifying the proof under it does.
 */
export function houseKeyFromAckHex(ackKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(ackKeyHex)) throw new ManifestProofError('HOUSE_PIN_INVALID');
  return bs58.encode(Uint8Array.from(ackKeyHex.match(/../g)!, (pair) => parseInt(pair, 16)));
}

export function verifyManifestProof(input: ManifestProofInput): VerifiedHouseBinding {
  let pin: Uint8Array;
  try {
    pin = bs58.decode(input.pinnedHouseKey);
  } catch {
    throw new ManifestProofError('HOUSE_PIN_INVALID');
  }
  if (pin.length !== 32) throw new ManifestProofError('HOUSE_PIN_INVALID');

  if (!input.proofHeader) throw new ManifestProofError('MANIFEST_PROOF_MISSING');
  if (input.proofHeader.length > MAX_PROOF_HEADER || !BASE64.test(input.proofHeader)) {
    throw new ManifestProofError('MANIFEST_PROOF_MALFORMED');
  }

  const proofBytes = fromBase64(input.proofHeader);
  let proof: popclaw.world.ManifestProof;
  try {
    proof = popclaw.world.ManifestProof.decode(proofBytes);
  } catch {
    throw new ManifestProofError('MANIFEST_PROOF_MALFORMED');
  }

  const house = proof.house;
  const incarnation = house?.incarnation ?? '';
  // The digest is over the bytes we were SERVED. Re-encoding the manifest and
  // hashing that would prove something about our own parser instead.
  const digest = cidFromCanonical(input.rawBytes);
  if (
    !house ||
    house.origin !== input.origin ||
    house.houseKey !== input.pinnedHouseKey ||
    incarnation.length === 0 ||
    incarnation.trim() !== incarnation ||
    CONTROL.test(incarnation) ||
    proof.manifestDigest !== digest
  ) {
    throw new ManifestProofError('MANIFEST_PROOF_BINDING_MISMATCH');
  }

  // The core, rebuilt: the proof with its own signature cleared and implicit
  // defaults elided. `signed_at` is elided at zero like every other canonical
  // core in this protocol — writing it would make our bytes longer than the
  // signer's and fail a signature that is perfectly good.
  const signedAt = Number(proof.signedAt ?? 0);
  const core = popclaw.world.ManifestProof.encode({
    house: { origin: house.origin, houseKey: house.houseKey, incarnation },
    manifestDigest: digest,
    ...(signedAt === 0 ? {} : { signedAt: proof.signedAt }),
  }).finish();
  const prefix = new TextEncoder().encode(PROOF_DOMAIN);
  const signing = new Uint8Array(prefix.length + core.length);
  signing.set(prefix);
  signing.set(core, prefix.length);

  if (
    proof.authoritySignature.length !== 64 ||
    !nacl.sign.detached.verify(signing, new Uint8Array(proof.authoritySignature), pin)
  ) {
    throw new ManifestProofError('MANIFEST_PROOF_SIGNATURE_INVALID');
  }

  return {
    origin: house.origin,
    houseKey: house.houseKey,
    incarnation,
    manifestDigest: digest,
    // The exact bytes that were verified. A caller that records evidence must
    // record THESE, not a re-decode of the header it happens to still hold.
    proofBytes,
  };
}

function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
