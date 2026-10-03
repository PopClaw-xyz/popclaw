/** Config-authorized first trust with two deliberately distinct policies.
 * Static mode contributes a lifecycle CAS to the proof/pin/relation commit.
 * Public-v1 mode contributes guards only; it never seeds or advances a lane.
 * Opaque, one-use attempts cannot be turned into the other mode by callers.
 */
import type { HostDb } from '../../host/host-db.js';
import { storageDatabasePathAllowed } from '../../host/storage-maintenance.js';
import { pinnedBinding } from '../../world/house-binding-pin.js';
import { houseKeyFromAckHex } from '../../world/house-binding.js';
import { normalizeHouseOrigin } from './control-client.js';
import { emptyControlState, neverControlSubset } from './legacy-history.js';
import { readParticipation } from './participation-store.js';

const brand: unique symbol = Symbol('configured first trust');
interface PinAttempt<M extends 'static' | 'public-v1'> {
  readonly [brand]: true;
  readonly mode: M;
  readonly configuredHouseKey?: string;
}
export type ConfiguredFirstPinAttempt = PinAttempt<'static'> | PinAttempt<'public-v1'>;
export interface ConfiguredFirstPinPort {
  begin(db: HostDb, origin: string, current?: () => boolean): PinAttempt<'static'> | undefined;
}
export interface ConfiguredPublicPinPort {
  begin(db: HostDb, origin: string, current?: () => boolean): PinAttempt<'public-v1'> | undefined;
}
export type ConfiguredHousePinningStrategy =
  | { readonly mode: 'static'; readonly firstPin: ConfiguredFirstPinPort }
  | { readonly mode: 'public-v1'; readonly proofPin: ConfiguredPublicPinPort };
interface Participant {
  readonly db: HostDb;
  readonly origin: string;
  guard(tx: HostDb): void;
  advance?(tx: HostDb): void;
}
const attempts = new WeakMap<ConfiguredFirstPinAttempt, Participant>();
export class FirstPinRefusal extends Error {
  constructor(readonly refusal: string) { super(refusal); }
}
export function cancelConfiguredFirstPin(attempt: ConfiguredFirstPinAttempt): void { attempts.delete(attempt); }
/** Consumed on entry, including mismatched DB/origin and all refusals. */
export function takeConfiguredFirstPin(db: HostDb, origin: string, attempt: ConfiguredFirstPinAttempt): Participant {
  const participant = attempts.get(attempt); attempts.delete(attempt);
  if (!participant || participant.db !== db || participant.origin !== origin) throw new FirstPinRefusal('HOUSE_FIRST_PIN_ATTEMPT_STALE');
  return participant;
}
interface Scope {
  db: HostDb;
  selected(): boolean;
  configured(origin: string): boolean;
  configuredPin(origin: string): string;
  fence(origin: string): unknown;
  cancellationEpoch(origin: string): number;
  stopped(): boolean;
}
function scopeAllows(opts: Scope, db: HostDb, origin: string, current: () => boolean): boolean {
  return db === opts.db && normalizeHouseOrigin(origin) === origin && opts.selected() && !opts.stopped() && current()
    && opts.fence(origin) === undefined && opts.configured(origin)
    && storageDatabasePathAllowed(db, 'consumers') && storageDatabasePathAllowed(db, 'execution')
    && pinnedBinding(db, origin) === undefined;
}
function scopeGuard(opts: Scope, tx: HostDb, origin: string, pin: string, epoch: number, current: () => boolean): void {
  try {
    if (scopeAllows(opts, tx, origin, current) && opts.cancellationEpoch(origin) === epoch && opts.configuredPin(origin) === pin) return;
  } catch { /* An unreadable resolver/storage is not unchanged authority. */ }
  throw new FirstPinRefusal('HOUSE_FIRST_PIN_AUTHORITY_MOVED');
}
function issue<M extends 'static' | 'public-v1'>(mode: M, pin: string): PinAttempt<M> {
  return Object.freeze({ [brand]: true as const, mode,
    ...(pin ? { configuredHouseKey: houseKeyFromAckHex(pin) } : {}) });
}

/** Lifecycle-owner capability, positively selected for ordinary static mode. */
export function configuredFirstPinPort(opts: Scope & {
  installationId: string;
  seed(origin: string): void;
}): ConfiguredFirstPinPort {
  return { begin(db, origin, current = () => true) {
    try {
      if (!scopeAllows(opts, db, origin, current)) return undefined;
      const pin = opts.configuredPin(origin);
      const epoch = opts.cancellationEpoch(origin);
      // Only static config authority can seed, and always BEFORE network.
      // Existing intent is never overwritten, including a prior logout.
      if (!readParticipation(db, origin)) opts.seed(origin);
      const row = readParticipation(db, origin);
      if (!emptyControlState(row) || row.op_seq !== 0 || row.desired !== 'enabled' || row.phase !== 'connected'
        || row.installation_id !== opts.installationId || row.pending_enter_request_id !== null
        || !neverControlSubset(db, origin, row)) return undefined;
      const snapshot = JSON.stringify(row);
      const attempt = issue('static', pin);
      attempts.set(attempt, { db, origin, guard(tx) {
        scopeGuard(opts, tx, origin, pin, epoch, current);
        if (JSON.stringify(readParticipation(tx, origin)) !== snapshot
          || !neverControlSubset(tx, origin, readParticipation(tx, origin))) {
          throw new FirstPinRefusal('HOUSE_FIRST_PIN_AUTHORITY_MOVED');
        }
      }, advance(tx) {
        const result = tx.execute(`UPDATE house_participation SET op_seq=op_seq+1
          WHERE house_origin=? AND installation_id=? AND op_seq=0 AND desired='enabled' AND phase='connected'
          AND session_id='' AND ack_key_hex='' AND inbox_read_token='' AND house_revision=0 AND lease_expires_at=0
          AND pending_enter_request_id IS NULL`, [origin, opts.installationId]);
        if (result.changes !== 1) throw new FirstPinRefusal('HOUSE_FIRST_PIN_LIFECYCLE_CAS_FAILED');
      } });
      return attempt;
    } catch { return undefined; }
  } };
}

/** Explicit public-v1 selection keeps the existing proof/pin/relation path.
 * It carries no lifecycle permission: no static seed, no op_seq advance.
 * A refusal in static mode can NEVER obtain this capability as a fallback.
 */
export function configuredPublicPinPort(opts: Scope): ConfiguredPublicPinPort {
  return { begin(db, origin, current = () => true) {
    try {
      if (!scopeAllows(opts, db, origin, current)) return undefined;
      const pin = opts.configuredPin(origin);
      const epoch = opts.cancellationEpoch(origin);
      const snapshot = JSON.stringify(readParticipation(db, origin));
      const attempt = issue('public-v1', pin);
      attempts.set(attempt, { db, origin, guard(tx) {
        scopeGuard(opts, tx, origin, pin, epoch, current);
        // Logout/login during proof fetch cancels this operation too. Existing
        // lifecycle facts are neither created nor changed by this policy.
        if (JSON.stringify(readParticipation(tx, origin)) !== snapshot) {
          throw new FirstPinRefusal('HOUSE_FIRST_PIN_AUTHORITY_MOVED');
        }
      } });
      return attempt;
    } catch { return undefined; }
  } };
}
