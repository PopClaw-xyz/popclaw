import nacl from 'tweetnacl';
import type { Signer } from './signer.js';
import type { MasterKey } from './keystore.js';
import {
  encryptDmBody,
  decryptDmBody,
  encryptDmMedia,
  decryptDmMedia,
  type DmDecryptResult,
  type DmMediaDecryptResult,
  type MaybeSealedDmBody,
  type SealedDmBody,
} from '../messaging/dm-crypto.js';

export class MasterKeySigner implements Signer {
  // ECMAScript `#private`, NOT TS `private`: TS's is compile-time only, so a
  // `private` member still shows up in JSON.stringify, util.inspect/console.log,
  // {...signer}, Object.entries and structuredClone — every one of which would
  // print the raw seed and secretKey. `#key` is unreachable by all of them.
  readonly #key: MasterKey;

  constructor(key: MasterKey) {
    this.#key = key;
  }
  async publicKey(): Promise<Uint8Array> {
    return this.#key.publicKey;
  }
  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(bytes, this.#key.secretKey);
  }
  async popclawId(): Promise<string> {
    return this.#key.popclawId;
  }
  toJSON(): unknown {
    return { type: 'MasterKeySigner', key: '[redacted]' };
  }
  /** #227: the ONE place the seed is used for key agreement (ed2curve). */
  sealDm(plaintext: string, recipientPopclawId: string): SealedDmBody {
    return encryptDmBody(plaintext, recipientPopclawId, this.#key.secretKey);
  }
  openDm(sealed: MaybeSealedDmBody, senderPopclawId: string): DmDecryptResult {
    return decryptDmBody(sealed, senderPopclawId, this.#key.secretKey);
  }
  /** #231: media goes through **a separate** box — same key, its own fresh nonce. */
  sealDmMedia(bytes: Uint8Array, mime: string, recipientPopclawId: string): SealedDmBody {
    return encryptDmMedia(bytes, mime, recipientPopclawId, this.#key.secretKey);
  }
  openDmMedia(sealed: MaybeSealedDmBody, senderPopclawId: string): DmMediaDecryptResult {
    return decryptDmMedia(sealed, senderPopclawId, this.#key.secretKey);
  }
}

// console.log / util.inspect route through this symbol. Node does not print
// #private fields today, so this is belt-and-braces — and it makes the redaction
// explicit instead of an anonymous `MasterKeySigner {}`. Assigned on the
// prototype rather than as a computed class member because `Symbol.for(...)` is
// not a `unique symbol` and TS rejects it as a method name.
(MasterKeySigner.prototype as unknown as Record<symbol, unknown>)[
  Symbol.for('nodejs.util.inspect.custom')
] = function inspectRedacted(): string {
  return 'MasterKeySigner { key: [redacted] }';
};
