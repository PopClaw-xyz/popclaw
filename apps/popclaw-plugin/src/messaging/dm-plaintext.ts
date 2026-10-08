/**
 * #227 S3 — the ONE place a wire DM becomes a body downstream code can use.
 *
 * The inbox delivery loop exists twice (`index.ts` for the plugin runtime,
 * `main.ts` for the dev-CLI daemon). Both start with the same statement, so
 * decrypting here means every consumer below it — InboxStore, the social log,
 * the red-packet ticket inbox, the owner notifier, `/popclaw inbox`, the
 * newspaper preview — keeps receiving plaintext and needs zero changes.
 *
 * NEVER THROWS. A single undecryptable message must cost exactly that one
 * message: the loop it sits in has a history of 3×/9× duplicate-delivery bugs
 * and a wedged SSE consumer is a silent, total outage of the owner's inbox.
 */
import type { popclaw } from '@popclaw/contracts';
import type { Signer } from '../identity/signer.js';
import { looksEncrypted, type DmDecryptFailure } from './dm-crypto.js';

/**
 * Plaintext body of an incoming DM, or `null` when it cannot be read — in
 * which case the caller must skip THIS message and continue the loop.
 *
 * Dual read (no migration, no backfill): a DM with no ciphertext is a legacy
 * plaintext row and stays plaintext forever.
 *
 * The returned string is what callers should hash / store: computing the
 * dedupe hash on the decrypted text is what keeps an SSE replay of the same
 * ciphertext (and a re-encryption of the same body under a fresh nonce)
 * collapsing to one delivery.
 */
export function readDmBody(
  dm: popclaw.event.IDirectMessage,
  recipient: Signer,
  onUndecryptable?: (reason: DmDecryptFailure) => void,
): string | null {
  if (!looksEncrypted(dm)) return dm.body ?? '';
  try {
    const opened = recipient.openDm(dm, dm.fromPopclawId ?? '');
    if (opened.ok) return opened.plaintext;
    onUndecryptable?.(opened.reason);
  } catch {
    // decryptDmBody already promises never to throw; this covers any other
    // Signer implementation, because the never-throw guarantee the loop needs
    // must not depend on which one is wired in.
    onUndecryptable?.('decrypt_failed');
  }
  return null;
}

/**
 * The image carried with a direct message, or `null` (none / could not be
 * opened).
 *
 * **A broken image must never take down the text.** This is an independent
 * check from {@link readDmBody}: it's entirely possible for a DM's text to
 * read fine while its image is corrupt — in that case deliver the text as
 * usual and treat the image as absent. The reverse holds too.
 *
 * NEVER THROWS, for the same reason as {@link readDmBody}: it sits in the same
 * inbound loop that has a track record of 3x/9x duplicate delivery.
 *
 * Note: **do not** fold the image's bytes into the dedup hash — the dedup key
 * is computed over the decrypted text (see {@link readDmBody}); mixing the
 * image in would make "the same line paired with a different image" get
 * misjudged as two separate messages — which would actually be correct
 * behavior, but more importantly, it would mean hashing attachment bytes on
 * every single message, which we should avoid.
 */
export function readDmMedia(
  dm: popclaw.event.IDirectMessage,
  recipient: Signer,
  onUndecryptable?: (reason: DmDecryptFailure) => void,
): { mime: string; bytes: Uint8Array } | null {
  const sealed = { ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce };
  if (!sealed.ciphertext || sealed.ciphertext.length === 0) return null;
  try {
    const opened = recipient.openDmMedia(sealed, dm.fromPopclawId ?? '');
    if (opened.ok) return { mime: opened.mime, bytes: opened.bytes };
    onUndecryptable?.(opened.reason);
  } catch {
    onUndecryptable?.('decrypt_failed');
  }
  return null;
}
