import type {
  DmDecryptResult,
  DmMediaDecryptResult,
  MaybeSealedDmBody,
  SealedDmBody,
} from '../messaging/dm-crypto.js';

/**
 * Signer — the plugin's single abstraction over private keys.
 *
 * MVP has one impl, MasterKeySigner. Phase 3 adds DeviceSubkeySigner
 * without changing this interface.
 *
 * DM sealing lives here rather than in the messaging module so that raw key
 * bytes never leave this abstraction (#227 / dm-crypto.ts header).
 */
export interface Signer {
  /** Ed25519 public key (32 bytes). */
  publicKey(): Promise<Uint8Array>;
  /** Detached Ed25519 signature over arbitrary bytes (64 bytes). */
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** Base58-encoded public key — the canonical popclaw_id. */
  popclawId(): Promise<string>;
  /**
   * Seal a DM body to `recipientPopclawId` (their X25519 key is derived from
   * the id itself — no key directory). THROWS on an unusable recipient id:
   * on the send path a loud failure is correct, and silently downgrading to
   * plaintext would be the worst possible outcome.
   */
  sealDm(plaintext: string, recipientPopclawId: string): SealedDmBody;
  /**
   * Open a sealed DM body. NEVER throws — returns a typed failure.
   *
   * Both are SYNCHRONOUS on purpose: the inbox delivery loop (index.ts /
   * main.ts) is synchronous and sits behind a dedupe gate that has already
   * produced 3×/9× duplicate-delivery bugs. Awaiting mid-loop would reorder
   * deliveries around that gate for no benefit — this is local key math.
   */
  openDm(sealed: MaybeSealedDmBody, senderPopclawId: string): DmDecryptResult;
  /**
   * Seal a picture into its OWN box for the same recipient (#231). THROWS on
   * an unusable recipient id, an empty/newline-bearing mime, or media over
   * {@link MAX_DM_MEDIA_BYTES} — all three are send-path programmer/user
   * errors that must be loud, never a silent downgrade.
   */
  sealDmMedia(bytes: Uint8Array, mime: string, recipientPopclawId: string): SealedDmBody;
  /** Open a sealed picture. NEVER throws — same contract as {@link openDm}. */
  openDmMedia(sealed: MaybeSealedDmBody, senderPopclawId: string): DmMediaDecryptResult;
}
