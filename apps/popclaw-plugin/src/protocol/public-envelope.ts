/** Controlled consumption of public-envelope-01.7. Never decode before the raw guard. */
import type { popclaw as LegacyTypes } from '@popclaw/contracts';
import { popclaw, checkEnvelopeWire } from './public-envelope-generated.js';
export { ENVELOPE_BASELINE, L_ENVELOPE_MAX_BYTES, checkEnvelopeWire, checkPublicEnvelopeStructure, canonicalizeEnvelope } from './public-envelope-generated.js';

export function decodeEnvelope(raw: Uint8Array): LegacyTypes.event.EventEnvelope {
  checkEnvelopeWire(raw);
  // Existing consumers retain their type surface; removed fields cannot cross the guard.
  return popclaw.event.EventEnvelope.decode(raw) as unknown as LegacyTypes.event.EventEnvelope;
}
