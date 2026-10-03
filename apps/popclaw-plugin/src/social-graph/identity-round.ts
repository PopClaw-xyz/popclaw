/**
 * Which round of this identity's life we are in.
 *
 * A round begins when the identity does: minted here, imported from elsewhere,
 * or restored from a backup. Nothing else starts one — an ordinary restart must
 * not, or every reboot would demand a fresh resync before the owner could
 * follow anyone.
 *
 * **Why a round and not a flag.** Whether this end has re-established an edge's
 * history is recorded in the database, and a database can be restored twice.
 * Recover an edge through 4, take a backup, keep signing 5, 6 and 7 on the live
 * copy, then restore that backup: it comes back holding its own proof, a
 * boolean-shaped gate reads it as satisfied, and the identity signs into 5 a
 * second time. A proof has to belong to the act that produced it, so the act
 * gets an id and the proof is stamped with it. Proofs stamped in an earlier
 * round stay on the row as history; what they stop being is current authority.
 *
 * **The residual, stated rather than solved.** A restore that does not announce
 * itself is indistinguishable from an ordinary restart, because everything this
 * process can read came out of the same backup. `beginIdentityRound` is a
 * contract with whoever performs the act, not a detection of it.
 */
import nacl from 'tweetnacl';
import type { HostDb } from '../host/host-db.js';

/** How this data root came by its identity. */
export type RootOrigin =
  /** Generated here. No prior originals exist anywhere. */
  | 'minted'
  /** Brought in from elsewhere, or restored from a backup. History may exist
   *  above what this root holds, and none of it is visible from here. */
  | 'imported'
  | 'restored'
  /** Not recorded — every installation that predates this question. Treated as
   *  neither trusted nor blocked on its own: only the per-edge evidence
   *  decides, so an upgrade does not stop the owner following anyone. */
  | 'unknown';

export interface IdentityRound {
  readonly roundId: string;
  readonly origin: Exclude<RootOrigin, 'unknown'>;
}

/**
 * Start a round. Called by mint, import and restore — and by nothing else.
 *
 * The id is fresh every time, so a restored database cannot bring a matching
 * one back with it: whatever round its rows were stamped in, it is not this
 * one.
 */
export function beginIdentityRound(
  db: HostDb,
  origin: Exclude<RootOrigin, 'unknown'>,
  now: () => number = () => Math.floor(Date.now() / 1000),
): string {
  // tweetnacl rather than `node:crypto`: this is a business module, and only
  // the composition roots may reach for node APIs.
  const roundId = Array.from(nacl.randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  db.execute(
    `INSERT INTO identity_round (singleton, round_id, origin, established_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT (singleton)
     DO UPDATE SET round_id = excluded.round_id,
                   origin = excluded.origin,
                   established_at = excluded.established_at`,
    [roundId, origin, now()],
  );
  return roundId;
}

/**
 * The round in progress, or undefined on an installation that predates this.
 *
 * Undefined is `unknown`, and unknown is neither trusted nor blocked: an
 * upgrade must not stop an owner who has been signing happily for months.
 */
export function currentIdentityRound(db: HostDb): IdentityRound | undefined {
  const row = db.queryOne<{ round_id: string; origin: string }>(
    'SELECT round_id, origin FROM identity_round WHERE singleton = 1',
  );
  if (row === null || row === undefined) return undefined;
  return { roundId: row.round_id, origin: row.origin as IdentityRound['origin'] };
}
