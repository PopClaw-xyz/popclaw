/** A captured local trust decision, never a new grant or a TOFU attempt. */
import bs58 from 'bs58';
import type { HostDb } from '../../host/host-db.js';

export interface LegacyTrustCapture {
  readonly origin: string;
  readonly binding: Readonly<{houseKey: string; incarnation: string; revision: number}> | null;
}

export function validLegacyTrustCapture(value: unknown): value is LegacyTrustCapture {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || typeof row.origin !== 'string' || !row.origin || row.origin.length > 4096) return false;
  if (row.binding === null) return true;
  if (!row.binding || typeof row.binding !== 'object') return false;
  const pin = row.binding as Record<string, unknown>;
  if (Object.keys(pin).length !== 3 || typeof pin.houseKey !== 'string' || typeof pin.incarnation !== 'string'
    || !pin.incarnation || pin.incarnation.length > 1024 || typeof pin.revision !== 'number'
    || !Number.isSafeInteger(pin.revision) || pin.revision < 1) return false;
  try { return bs58.decode(pin.houseKey).length === 32; } catch { return false; }
}

/** Unknown/unreadable is different from a successfully observed absent pin.
 * The old unpinned compatibility lane may observe an absent table, but new
 * recovery admission always requires a concrete, already established pin. */
export function captureLegacyTrust(db: HostDb, origin: string): LegacyTrustCapture | undefined {
  try {
    const table = db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='house_binding_pin'");
    const row = table ? db.queryOne<Record<string, unknown>>(
      'SELECT origin,house_key,incarnation,revision,blocked_reason,source FROM house_binding_pin WHERE origin=?', [origin]) : null;
    if (!row) return Object.freeze({origin, binding: null});
    if (row.origin !== origin || row.blocked_reason !== null || !['configured','tofu'].includes(String(row.source))) return undefined;
    const capture = {origin, binding: {houseKey: row.house_key, incarnation: row.incarnation, revision: row.revision}};
    if (!validLegacyTrustCapture(capture)) return undefined;
    return Object.freeze({origin, binding: Object.freeze(capture.binding)});
  } catch { return undefined; }
}

export function legacyTrustCurrent(db: HostDb, capture: LegacyTrustCapture | undefined): boolean {
  if (!capture) return false;
  const current = captureLegacyTrust(db, capture.origin);
  if (!current) return false;
  if (capture.binding === null || current.binding === null) return capture.binding === current.binding;
  return capture.binding.houseKey === current.binding.houseKey && capture.binding.incarnation === current.binding.incarnation
    && capture.binding.revision === current.binding.revision;
}
