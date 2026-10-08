/**
 * DM body encryption — `nacl.box` (X25519-XSalsa20-Poly1305) keyed off the
 * identity key. Standalone module: this slice does NOT wire it into the
 * messaging flow, the proto, or lore-house.
 *
 * ── Why there is no key distribution ────────────────────────────────────
 * `popclaw_id ≡ base58(Ed25519 public key)`. A recipient's X25519 public key
 * is therefore *derived from their name*: decode the base58, run the standard
 * Ed25519→X25519 birational map (`ed2curve.convertPublicKey`). No key
 * directory, no server endpoint, no TOFU step. Keep it that way.
 *
 * ── Accepted tradeoff: ONE keypair for both signing and key agreement ───
 * We derive the X25519 private key from the existing Ed25519 secret key
 * (`ed2curve.convertSecretKey`) instead of generating a second keypair.
 * Reusing a signing key for key agreement is a real, if small, cryptographic
 * smell — but the birational Ed25519→X25519 map is widely deployed (Signal's
 * XEdDSA, WireGuard-adjacent tooling, libsodium's `crypto_sign_ed25519_*_to_
 * curve25519`) and no practical attack is known against this composition.
 * We accept it deliberately, because the alternative is worse *here*: the
 * 32-byte seed in `master.key` must remain the ONE thing a user backs up.
 * This project has no export command and no mnemonic — a second key would be
 * a second backup artifact and a second way to lose everything.
 *
 * ── What this does NOT buy (spec §4, be honest about it) ────────────────
 * No forward secrecy (one seed leak decrypts all past and future DMs — and
 * the lore-house keeps ciphertext indefinitely, so a stolen key is a
 * retroactive full-history leak), no post-compromise recovery, no metadata
 * privacy (sender / recipient / timestamp / length stay plaintext, indexed
 * columns), no deniability (the Ed25519 envelope signature pins authorship),
 * and no local-at-rest protection (decrypted bodies land in
 * `my-social-assets.db`). It buys exactly one thing: the lore-house operator
 * and anonymous inbox subscribers cannot read DM bodies.
 *
 * ── Never log key material ──────────────────────────────────────────────
 * No function here logs, prints, or embeds secret bytes, and no thrown
 * message may include them.
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import ed2curve from 'ed2curve';

/** `nacl.box` nonce width. Fresh random nonce per message. */
export const DM_NONCE_BYTES = nacl.box.nonceLength; // 24

/** An encrypted DM body: the two `bytes` fields the wire carries alongside the envelope. */
export interface SealedDmBody {
  readonly ciphertext: Uint8Array;
  /** Exactly {@link DM_NONCE_BYTES} bytes. */
  readonly nonce: Uint8Array;
}

/**
 * Why a decryption attempt produced nothing.
 *
 * - `missing_ciphertext`  — nothing to open; typically a legacy plaintext row.
 * - `malformed_nonce`     — nonce absent or not {@link DM_NONCE_BYTES} bytes.
 * - `malformed_media`     — the box opened but its contents are not
 *                          `<mime>\n<bytes>` (i.e. not sealed by us).
 * - `malformed_sender_id` — sender popclaw_id is not base58 of a 32-byte
 *                           Ed25519 public key convertible to X25519.
 * - `decrypt_failed`      — authentication failed: corrupt or tampered
 *                           ciphertext, wrong recipient, wrong sender, wrong
 *                           nonce, or plaintext fed in by mistake.
 */
export type DmDecryptFailure =
  | 'missing_ciphertext'
  | 'malformed_nonce'
  | 'malformed_sender_id'
  | 'malformed_media'
  | 'decrypt_failed';

export type DmDecryptResult =
  | {
    readonly ok: true;
    readonly plaintext: string;
    /** Authenticated bytes before text decoding, in independently owned storage.
     * Optional so existing custom Signer implementations remain compatible. */
    readonly plaintextBytes?: Uint8Array;
  }
  | { readonly ok: false; readonly reason: DmDecryptFailure };

/** Loose shape so callers can pass a decoded proto DM or a DB row unchanged. */
export interface MaybeSealedDmBody {
  readonly ciphertext?: Uint8Array | null;
  readonly nonce?: Uint8Array | null;
}

/**
 * Encrypt a DM body to `recipientPopclawId`.
 *
 * THROWS — but only on programmer error: an unparseable recipient popclaw_id
 * or an unusable sender secret key. Both mean the caller handed us garbage,
 * on the *send* path, where a loud failure is correct. The decrypt path is
 * the one that must never throw; see {@link decryptDmBody}.
 *
 * @param plaintext                 UTF-8 body.
 * @param recipientPopclawId        base58(recipient Ed25519 public key).
 * @param senderEd25519SecretKey    64-byte tweetnacl signing secret key
 *                                  (`MasterKey.secretKey`).
 */
export function encryptDmBody(
  plaintext: string,
  recipientPopclawId: string,
  senderEd25519SecretKey: Uint8Array,
): SealedDmBody {
  const recipientCurvePk = toCurvePublicKey(recipientPopclawId);
  if (!recipientCurvePk) {
    // Safe to echo: popclaw_id is public. Never echo key bytes.
    throw new Error(`encryptDmBody: unparseable recipient popclaw_id: ${recipientPopclawId}`);
  }
  const senderCurveSk = ed2curve.convertSecretKey(senderEd25519SecretKey);
  const nonce = nacl.randomBytes(DM_NONCE_BYTES);
  const ciphertext = nacl.box(
    new TextEncoder().encode(plaintext),
    nonce,
    recipientCurvePk,
    senderCurveSk,
  );
  return { ciphertext, nonce };
}

/**
 * Decrypt a DM body from `senderPopclawId`.
 *
 * NEVER THROWS. This sits inside the inbox delivery loop, which has a history
 * of duplicate-delivery bugs (host-b saw 3x/9x) and where one malformed message must
 * never poison the loop. Every failure — corrupt ciphertext, wrong recipient,
 * bad nonce, malformed base58, legacy plaintext, even a broken recipient key —
 * comes back as `{ ok: false, reason }`.
 *
 * `nacl.box` is authenticated: opening with the wrong sender public key fails,
 * so a successful result also proves the body came from `senderPopclawId`.
 *
 * @param sealed                     ciphertext + nonce, from the wire or a row.
 * @param senderPopclawId            base58(sender Ed25519 public key).
 * @param recipientEd25519SecretKey  64-byte tweetnacl signing secret key
 *                                   (`MasterKey.secretKey`).
 */
export function decryptDmBody(
  sealed: MaybeSealedDmBody | null | undefined,
  senderPopclawId: string,
  recipientEd25519SecretKey: Uint8Array,
): DmDecryptResult {
  try {
    const ciphertext = sealed?.ciphertext;
    if (!ciphertext || ciphertext.length === 0) return fail('missing_ciphertext');

    const nonce = sealed?.nonce;
    if (!nonce || nonce.length !== DM_NONCE_BYTES) return fail('malformed_nonce');

    const senderCurvePk = toCurvePublicKey(senderPopclawId);
    if (!senderCurvePk) return fail('malformed_sender_id');

    const recipientCurveSk = ed2curve.convertSecretKey(recipientEd25519SecretKey);
    const opened = nacl.box.open(ciphertext, nonce, senderCurvePk, recipientCurveSk);
    if (!opened) return fail('decrypt_failed');

    // Non-fatal TextDecoder: the Poly1305 tag already proved these are exactly
    // the bytes the sender sealed, and a decoder that throws would break the
    // never-throw contract for no benefit.
    return {
      ok: true,
      plaintext: new TextDecoder().decode(opened),
      plaintextBytes: new Uint8Array(opened),
    };
  } catch {
    // Backstop: whatever tweetnacl/ed2curve/bs58 decided to throw at us,
    // the delivery loop still gets a value.
    return fail('decrypt_failed');
  }
}

/**
 * Dual-read discriminator for the wiring slice: does this DM carry an
 * encrypted body, or is it a legacy plaintext row?
 *
 * Presence of a non-empty ciphertext is the whole test — legacy rows have no
 * ciphertext at all. Nonce validity is deliberately NOT checked here: a
 * present-but-broken nonce should reach {@link decryptDmBody} and surface as a
 * typed `malformed_nonce`, not get silently misread as plaintext.
 */
export function looksEncrypted(dm: MaybeSealedDmBody | null | undefined): boolean {
  return !!dm?.ciphertext && dm.ciphertext.length > 0;
}

/** base58 popclaw_id → X25519 public key, or null if it is not one. */
function toCurvePublicKey(popclawId: string): Uint8Array | null {
  if (!popclawId) return null;
  let edPk: Uint8Array;
  try {
    edPk = bs58.decode(popclawId);
  } catch {
    return null;
  }
  if (edPk.length !== nacl.sign.publicKeyLength) return null;
  // Returns null when the bytes are not a valid Ed25519 point.
  return ed2curve.convertPublicKey(edPk);
}

function fail(reason: DmDecryptFailure): DmDecryptResult {
  return { ok: false, reason };
}


// ─── Image: the second box ──────────────────────────────────────────────────
//
// Why not stuff it into the box above: the text box's plaintext is a UTF-8
// string (`encryptDmBody` accepts a string). Squeezing an image in would
// require turning the plaintext into a structured blob, and **every
// not-yet-upgraded client** would then render a message it was never going to
// be able to display as garbage. With two boxes + two proto fields, old
// clients ignore the unknown field per ADR-0003 and display the text as
// usual, just without the image — graceful degradation, not breakage.
//
// Plaintext layout: `<mime>\n<raw bytes>`. The mime is sealed **inside the
// box**, so the lore-house can't even tell "is this a sticker or a
// screenshot." The length is still visible (metadata privacy was never
// promised).

/** The separator between mime and bytes in the plaintext. */
const MIME_SEP = 0x0a; // '\n'

export type DmMediaDecryptResult =
  | { ok: true; mime: string; bytes: Uint8Array }
  | { ok: false; reason: DmDecryptFailure };

/**
 * Seal an image for the recipient, using the same X25519 key pair as the text
 * but **a different, fresh nonce**.
 *
 * Reusing a nonce across two boxes under the same key pair is XSalsa20
 * keystream reuse (a textbook-level pitfall), so this generates its own
 * `randomBytes` and never accepts a caller-supplied nonce.
 *
 * @param bytes  Raw image bytes (jpg/png/gif/webp all fine — this only moves bytes).
 * @param mime   Media type, sealed into the box; must not contain a newline (it's the separator).
 */
export function encryptDmMedia(
  bytes: Uint8Array,
  mime: string,
  recipientPopclawId: string,
  senderEd25519SecretKey: Uint8Array,
): SealedDmBody {
  // Preserve the original bytes. Capacity belongs to the complete signed
  // EventEnvelope, not to a separate file budget.
  if (!mime || mime.includes('\n')) {
    throw new Error('encryptDmMedia: mime must be non-empty and contain no newline');
  }
  const recipientCurvePk = toCurvePublicKey(recipientPopclawId);
  if (!recipientCurvePk) {
    throw new Error(`encryptDmMedia: unparseable recipient popclaw_id: ${recipientPopclawId}`);
  }
  const header = new TextEncoder().encode(mime);
  const plaintext = new Uint8Array(header.length + 1 + bytes.length);
  plaintext.set(header, 0);
  plaintext[header.length] = MIME_SEP;
  plaintext.set(bytes, header.length + 1);

  const senderCurveSk = ed2curve.convertSecretKey(senderEd25519SecretKey);
  const nonce = nacl.randomBytes(DM_NONCE_BYTES);
  return { ciphertext: nacl.box(plaintext, nonce, recipientCurvePk, senderCurveSk), nonce };
}

/**
 * Open the image box. **Never throws** — the same iron rule as
 * {@link decryptDmBody}: it sits in the inbox delivery loop, where one bad
 * message must never poison the whole batch. When an image can't be opened,
 * the caller should still deliver the text portion as usual.
 */
export function decryptDmMedia(
  sealed: MaybeSealedDmBody | null | undefined,
  senderPopclawId: string,
  recipientEd25519SecretKey: Uint8Array,
): DmMediaDecryptResult {
  try {
    const ciphertext = sealed?.ciphertext;
    if (!ciphertext || ciphertext.length === 0) return { ok: false, reason: 'missing_ciphertext' };

    const nonce = sealed?.nonce;
    if (!nonce || nonce.length !== DM_NONCE_BYTES) return { ok: false, reason: 'malformed_nonce' };

    const senderCurvePk = toCurvePublicKey(senderPopclawId);
    if (!senderCurvePk) return { ok: false, reason: 'malformed_sender_id' };

    const recipientCurveSk = ed2curve.convertSecretKey(recipientEd25519SecretKey);
    const opened = nacl.box.open(ciphertext, nonce, senderCurvePk, recipientCurveSk);
    if (!opened) return { ok: false, reason: 'decrypt_failed' };

    const sep = opened.indexOf(MIME_SEP);
    // Poly1305 has already proven these are the bytes the sender sealed; no
    // separator means whatever sealed it wasn't using our layout — don't
    // guess, error out.
    if (sep <= 0) return { ok: false, reason: 'malformed_media' };
    return {
      ok: true,
      mime: new TextDecoder().decode(opened.subarray(0, sep)),
      bytes: opened.subarray(sep + 1),
    };
  } catch {
    return { ok: false, reason: 'decrypt_failed' };
  }
}
