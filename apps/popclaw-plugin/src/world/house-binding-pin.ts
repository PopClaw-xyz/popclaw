/**
 * The pin: which key we trust at which house, and what happens when the answer
 * changes under us.
 *
 * `verifyManifestProof` answers "is this manifest that key's word". It cannot
 * answer "is that key the right key", because the only thing offering an answer
 * is the response being checked. This is where the second question lives, and
 * it is deliberately a different file with different rules.
 *
 * **Three sources, ranked, and only two of them establish anything.** A
 * configured pin is the owner saying so and outranks everything. A persisted
 * pin is what we settled on before. A first contact over validated HTTPS may
 * establish a TOFU pin — but only during an explicit first-trust step, because
 * a background reconnect that could pin would turn every outage into an
 * opportunity to become the house.
 *
 * **A change is fail-closed, not a migration.** `house_key` is the relation
 * namespace: an edge is (house, author, target), so a key that changes renames
 * every edge into a space nobody wrote them in. A changed incarnation is milder
 * and still not automatic — the house was restored or rebuilt, and what it now
 * holds has to be reconciled against what we hold rather than assumed to
 * supersede it. Neither case deletes anything: the old evidence, the cursors
 * and the relations all stay, and the pin itself is not overwritten, because
 * the record of what we trusted has to survive the thing that contradicted it.
 */
import type { HostDb } from '../host/host-db.js';
import type { VerifiedHouseBinding } from './house-binding.js';

export type PinSource = 'configured' | 'tofu';

export interface HouseBindingPin {
  readonly origin: string;
  readonly houseKey: string;
  readonly incarnation: string;
  readonly source: PinSource;
  readonly firstTrustedAt: number;
  readonly confirmedAt: number;
  /** Set when a verified binding disagreed with this pin. */
  readonly blockedReason?: string;
  /** Bumped by every change. What a decision about this row names. */
  readonly revision: number;
}

/** Why a house is refused. Bare codes, so callers branch without matching prose. */
export type BindingRefusal =
  | 'HOUSE_NOT_TRUSTED'
  | 'HOUSE_KEY_CHANGED'
  | 'HOUSE_INCARNATION_CHANGED'
  | 'HOUSE_BINDING_BLOCKED';

export type ConfirmResult =
  | { readonly ok: true; readonly pin: HouseBindingPin }
  | { readonly ok: false; readonly refusal: BindingRefusal; readonly detail: string };

const SELECT =
  'SELECT origin, house_key, incarnation, source, first_trusted_at, confirmed_at, ' +
  'blocked_reason, revision FROM house_binding_pin WHERE origin = ?';

interface PinRow {
  origin: string;
  house_key: string;
  incarnation: string;
  source: string;
  first_trusted_at: number;
  confirmed_at: number;
  blocked_reason: string | null;
  revision: number;
}

function toPin(row: PinRow): HouseBindingPin {
  return {
    origin: row.origin,
    houseKey: row.house_key,
    incarnation: row.incarnation,
    source: row.source as PinSource,
    firstTrustedAt: row.first_trusted_at,
    confirmedAt: row.confirmed_at,
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    revision: row.revision,
  };
}

/** What we trust at this origin, if anything. */
export function pinnedBinding(db: HostDb, origin: string): HouseBindingPin | undefined {
  const row = db.queryOne<PinRow>(SELECT, [origin]);
  return row === null || row === undefined ? undefined : toPin(row);
}

/**
 * The key to hand `verifyManifestProof`. Undefined when we trust nothing here
 * yet, or when this house is blocked — a blocked house gets no verification
 * attempt at all, rather than one that might pass and read as fine.
 */
export function pinnedHouseKey(db: HostDb, origin: string): string | undefined {
  const pin = pinnedBinding(db, origin);
  if (pin === undefined || pin.blockedReason !== undefined) return undefined;
  return pin.houseKey;
}

/**
 * Establish trust at an origin for the first time.
 *
 * Called only from an explicit first-trust step — an owner adding a house, or
 * configuration naming one. Never from a reconnect, and never from a refresh.
 *
 * Insert-if-absent, in one statement, because a SELECT cannot decide this: two
 * connections on one data root each see no row and both proceed. The insert
 * makes it a primary-key race instead, so the loser reads the winner's pin
 * rather than stale emptiness, and concurrent first contact settles on exactly
 * one binding.
 *
 * A configured pin may replace a TOFU one — the owner outranks a guess. Nothing
 * replaces a configured pin, and TOFU replaces nothing at all.
 */
export function establishTrust(
  db: HostDb,
  binding: { readonly origin: string; readonly houseKey: string; readonly incarnation: string },
  source: PinSource,
  now: () => number = () => Math.floor(Date.now() / 1000),
): { readonly outcome: 'established' | 'upgraded' | 'kept'; readonly pin: HouseBindingPin } {
  return db.transaction((tx) => establishTrustInTx(tx, binding, source, now()));
}

/**
 * The establish semantics in whatever transaction the caller holds — so a
 * commit that must re-check the world first can do the checks and the write
 * as one atomic step instead of a read here and a write somewhere else.
 */
export function establishTrustInTx(
  db: HostDb,
  binding: { readonly origin: string; readonly houseKey: string; readonly incarnation: string },
  source: PinSource,
  at: number,
): { readonly outcome: 'established' | 'upgraded' | 'kept'; readonly pin: HouseBindingPin } {
  // Whether the INSERT won is something the INSERT knows. Asking afterwards
  // whether the row "looks like ours" compared a second-resolution timestamp
  // and a key, so a TOFU pin followed IN THE SAME SECOND by a configured call
  // for the same key reported `established` while the row was still the first
  // one — the wrong answer, and the wrong reason.
  const inserted = db.execute(
    `INSERT OR IGNORE INTO house_binding_pin
       (origin, house_key, incarnation, source, first_trusted_at, confirmed_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [binding.origin, binding.houseKey, binding.incarnation, source, at, at],
  );
  const existing = toPin(db.queryOne<PinRow>(SELECT, [binding.origin])!);
  if (inserted.changes === 1) {
    return { outcome: 'established' as const, pin: existing };
  }
  // The owner's word replaces a guess, and clears a block it disagrees with:
  // saying "this IS the key" is exactly how a blocked house gets resolved.
  if (source === 'configured' && existing.source === 'tofu') {
    db.execute(
      `UPDATE house_binding_pin
       SET house_key = ?, incarnation = ?, source = 'configured', confirmed_at = ?,
           blocked_reason = NULL, blocked_at = NULL, revision = revision + 1
       WHERE origin = ?`,
      [binding.houseKey, binding.incarnation, at, binding.origin],
    );
    return { outcome: 'upgraded' as const, pin: toPin(db.queryOne<PinRow>(SELECT, [binding.origin])!) };
  }
  return { outcome: 'kept' as const, pin: existing };
}

/**
 * Check a verified binding against what we trust, and record the answer.
 *
 * This is what a refresh, a reconnect and a resume all call. It never
 * establishes a pin and never rotates one: an origin we have never trusted is
 * refused here rather than silently adopted, which is the difference between a
 * first-trust step and everything that comes after it.
 *
 * A disagreement blocks the house and keeps the pin. Both halves matter — the
 * block is what stops new application, and keeping the pin is what leaves
 * something to compare against when somebody comes to resolve it.
 */
export function confirmBinding(
  db: HostDb,
  verified: VerifiedHouseBinding,
  now: () => number = () => Math.floor(Date.now() / 1000),
): ConfirmResult {
  return db.transaction((tx) => confirmBindingInTx(tx, verified, now()));
}

/** The confirm semantics in whatever transaction the caller holds. */
export function confirmBindingInTx(db: HostDb, verified: VerifiedHouseBinding, at: number): ConfirmResult {
  const row = db.queryOne<PinRow>(SELECT, [verified.origin]);
  if (row === null || row === undefined) {
    return {
      ok: false as const,
      refusal: 'HOUSE_NOT_TRUSTED' as const,
      detail: `no pin at ${verified.origin}; trust is established explicitly, not on arrival`,
    };
  }
  const pin = toPin(row);
  if (pin.blockedReason !== undefined) {
    return {
      ok: false as const,
      refusal: 'HOUSE_BINDING_BLOCKED' as const,
      detail: pin.blockedReason,
    };
  }

  const block = (refusal: BindingRefusal, detail: string): ConfirmResult => {
    db.execute(
      `UPDATE house_binding_pin
       SET blocked_reason = ?, blocked_at = ?, revision = revision + 1
       WHERE origin = ?`,
      [detail, at, verified.origin],
    );
    return { ok: false as const, refusal, detail };
  };

  if (pin.houseKey !== verified.houseKey) {
    return block(
      'HOUSE_KEY_CHANGED',
      `pinned ${pin.houseKey}, served ${verified.houseKey}`,
    );
  }
  if (pin.incarnation !== verified.incarnation) {
    // Same house, restored or rebuilt. Milder than a key change and still not
    // automatic: clearing the cursors and carrying on would treat whatever it
    // holds now as a continuation of what it held before, which is the one
    // thing a rebuild does not promise.
    return block(
      'HOUSE_INCARNATION_CHANGED',
      `pinned incarnation ${pin.incarnation}, served ${verified.incarnation}`,
    );
  }

  db.execute('UPDATE house_binding_pin SET confirmed_at = ? WHERE origin = ?', [
    at,
    verified.origin,
  ]);
  return { ok: true as const, pin: { ...pin, confirmedAt: at } };
}

/**
 * The owner has looked at a blocked house and decided.
 *
 * Deliberately separate from `confirmBinding`, and deliberately explicit about
 * the new binding rather than "accept whatever is there now": resolving a block
 * by re-reading the thing that caused it is not resolving it.
 *
 * And a decision names the revision it was made about. An owner deciding takes
 * time, and in that time a configured pin and a fresh block can land — matching
 * on "is blocked" alone let the stale answer revert both, putting the older key
 * back and clearing a block nobody had looked at.
 */
export function resolveBlock(
  db: HostDb,
  binding: { readonly origin: string; readonly houseKey: string; readonly incarnation: string },
  sawRevision: number,
  now: () => number = () => Math.floor(Date.now() / 1000),
): boolean {
  const at = now();
  const res = db.execute(
    `UPDATE house_binding_pin
     SET house_key = ?, incarnation = ?, confirmed_at = ?, blocked_reason = NULL,
         blocked_at = NULL, revision = revision + 1
     WHERE origin = ? AND blocked_reason IS NOT NULL AND revision = ?`,
    [binding.houseKey, binding.incarnation, at, binding.origin, sawRevision],
  );
  return res.changes === 1;
}
