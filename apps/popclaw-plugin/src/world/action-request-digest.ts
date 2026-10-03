import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import { isActionReceiptProfile, MANUAL_ACTION_RECEIPT_PROFILE, NATIVE_ACTION_RECEIPT_PROFILE } from './action-receipt-journal.js';

/** request_digest is the durable checksum of the complete retry unit. Receipt
 * profiles select the protocol domain without rewriting historical evidence. */
export function actionRequestDigest(request: {request_bytes: Uint8Array; request_digest: string; receipt_profile: string | null}): string {
  if (!isActionReceiptProfile(request.receipt_profile)) throw new Error('ACTION_CONTEXT_UNSUPPORTED');
  const raw = request.request_bytes;
  if (!(raw instanceof Uint8Array) || !raw.length || raw.length > 1048576 || cidFromCanonical(raw) !== request.request_digest) throw new Error('REQUEST_STORAGE_INVALID');
  if (request.receipt_profile === MANUAL_ACTION_RECEIPT_PROFILE || request.receipt_profile === NATIVE_ACTION_RECEIPT_PROFILE) return request.request_digest;
  // Extract exact nested bytes; never decode/re-encode the EventEnvelope when hashing.
  let offset = 0;
  const fields = new Map<number, Uint8Array>();
  const invalid = (): never => { throw new Error('REQUEST_STORAGE_INVALID'); };
  const varint = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (offset >= raw.length) return invalid();
      const byte = raw[offset++]!;
      value += (byte & 127) * 2 ** (7 * i);
      if (!(byte & 128)) {
        if ((i > 0 && byte === 0) || value > 4294967295) return invalid();
        return value;
      }
    }
    return invalid();
  };
  while (offset < raw.length) {
    const tag = varint(), field = tag >>> 3;
    if ((tag & 7) !== 2 || ![1, 2, 3].includes(field) || fields.has(field)) return invalid();
    const length = varint();
    if (!length || length > raw.length - offset) return invalid();
    fields.set(field, raw.subarray(offset, offset + length)); offset += length;
  }
  const payload = fields.get(1), signature = fields.get(2), key = fields.get(3);
  if (!payload || signature?.length !== 64 || key?.length !== 32 || !nacl.sign.detached.verify(payload, signature, key)) return invalid();
  return cidFromCanonical(payload);
}
