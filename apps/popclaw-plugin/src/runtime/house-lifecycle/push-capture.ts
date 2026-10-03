/** Versioned IPC capture in the existing effect_json column. No new authority,
 * and no SQL migration: the envelope carries the caller's original constraint. */
import { captureHousePushEffect, type HousePushEffectReference } from './push-effect.js';
import { validLegacyTrustCapture, type LegacyTrustCapture } from './legacy-trust.js';
import { normalizeHouseOrigin } from './control-client.js';
const MAX_CAPTURE_BYTES = 65_536;
export interface LegacyPushCapture {
  readonly version: 1;
  readonly kind: 'house_command_capture';
  readonly trust: LegacyTrustCapture;
  readonly effect: HousePushEffectReference | null;
}
export function serializeLegacyPushCapture(trust: LegacyTrustCapture, effect?: HousePushEffectReference): string {
  if (!validLegacyTrustCapture(trust) || normalizeHouseOrigin(trust.origin) !== trust.origin) throw new Error('HOUSE_COMMAND_CAPTURE_INVALID');
  const binding = trust.binding === null ? null : Object.freeze({houseKey:trust.binding.houseKey,incarnation:trust.binding.incarnation,revision:trust.binding.revision});
  const value: LegacyPushCapture = Object.freeze({version:1,kind:'house_command_capture',trust:Object.freeze({origin:trust.origin,binding}),effect:effect ? captureHousePushEffect(effect) : null});
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_CAPTURE_BYTES) throw new Error('HOUSE_COMMAND_CAPTURE_INVALID');
  return text;
}
export function parseLegacyPushCapture(text: string | null): LegacyPushCapture {
  if (typeof text !== 'string' || text.length > MAX_CAPTURE_BYTES) throw new Error('HOUSE_COMMAND_CAPTURE_MISSING');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HOUSE_COMMAND_CAPTURE_INVALID');
  const row = value as Record<string,unknown>;
  if (Object.keys(row).length !== 4 || row.version !== 1 || row.kind !== 'house_command_capture'
    || !validLegacyTrustCapture(row.trust) || !Object.hasOwn(row,'effect')) throw new Error('HOUSE_COMMAND_CAPTURE_INVALID');
  const effect = row.effect === null ? undefined : captureHousePushEffect(row.effect);
  const canonical = serializeLegacyPushCapture(row.trust,effect);
  if (canonical !== text) throw new Error('HOUSE_COMMAND_CAPTURE_INVALID');
  const binding = row.trust.binding === null ? null : Object.freeze({...row.trust.binding});
  return Object.freeze({version:1,kind:'house_command_capture',trust:Object.freeze({origin:row.trust.origin,binding}),effect:effect ?? null});
}
