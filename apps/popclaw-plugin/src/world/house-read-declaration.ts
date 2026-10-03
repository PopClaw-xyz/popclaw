/**
 * What a house declared about reads — taken from the manifest that was
 * VERIFIED, and from nothing else.
 *
 * Two facts about one house used to come from two different responses. The
 * pin came from `/v1/manifest` fetched strictly, with the proof header read
 * off the same response and checked against the key. The declaration came
 * from `house-handshake.ts`, an ordinary conditional GET that never looked at
 * a proof and never compared anything to the pin. So "which key is this
 * house" and "which credential does it accept" were answers from two
 * responses that nothing cross-checked, and whoever could answer the
 * unauthenticated one chose what the client would send to the house the
 * other one named.
 *
 * So the declaration is projected here, out of the already-verified bytes, in
 * the same transaction that writes the binding. No second fetch, no second
 * verification, and no row that can move on its own:
 *
 *  - a proof that did not verify never reaches a commit, so it cannot write;
 *  - a valid manifest that withdrew `read_auth` rewrites the row to silence,
 *    which closes every subsequent read rather than leaving one this client
 *    remembered on the house's behalf;
 *  - a row belongs to the KEY it was projected under, so resolving a block to
 *    a different key does not inherit the old key's declaration.
 *
 * There is no conditional request anywhere on this path — `fetchTrustedManifest`
 * says why in its own words — so no 304 can ever reuse a declaration here.
 */
import { isHouseSessionBoard } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import { readAuthSchemesOf } from '../identity/read-credential.js';
import {
  browserEntryFingerprint,
  browserEntryOf,
  parseStoredBrowserEntry,
  serializeBrowserEntry,
  type DeclaredBrowserEntry,
} from '../identity/browser-entry.js';
import { pinnedBinding, type HouseBindingPin } from './house-binding-pin.js';

export interface HouseReadDeclaration {
  /**
   * `read_auth.schemes`, verbatim. `undefined` is a house that said nothing —
   * a refusal, and never a licence to try an older shape. `[]` is a house that
   * said something naming nothing, which is a different thing to tell someone.
   */
  readonly schemes: readonly string[] | undefined;
  /**
   * The same verified manifest carried a valid `house_session` board.
   *
   * This is the positive fact behind the house-issued session read lane: the
   * board IS the endpoint declaration, the ACK key it advertises is checked
   * against the pin before any session begins, and the read token itself
   * arrives inside an ACK signed by that key. A `session_id` left in this
   * machine's own row declares nothing.
   */
  readonly sessionBoard: boolean;
  /**
   * The browser entrance the same verified manifest declared (migration 042).
   *
   * `undefined` is a house that named no entrance, which refuses. A present
   * object is the house's word as declared — whether its URLs are usable is
   * decided at the moment a link is minted, not here: this row records what
   * was said, and storing a filtered version would keep granting under
   * whichever rules happened to be in force on the day it was written.
   */
  readonly browserEntry: DeclaredBrowserEntry | undefined;
}

interface DeclarationRow {
  house_key: string;
  schemes: string | null;
  session_board: number;
  browser_entry: string | null;
}

const SELECT =
  'SELECT house_key, schemes, session_board, browser_entry FROM house_read_declaration WHERE origin = ?';

/**
 * Write the projection inside the transaction that commits the binding.
 *
 * Called from `commitPreparedInTx` and from nowhere else: that is the one
 * point every trust commit — the explicit add, the login's relation binding,
 * every confirm — already passes through, after its guards and inside its CAS.
 * The bytes are the prepared record's own `manifestBytes`, which are the exact
 * bytes the proof was checked over.
 */
export function projectReadDeclarationInTx(
  tx: HostDb,
  binding: { readonly origin: string; readonly houseKey: string },
  manifestBytes: Uint8Array,
  at: number,
): void {
  const declaration = declarationOf(manifestBytes);
  tx.execute(
    `INSERT INTO house_read_declaration (origin, house_key, schemes, session_board, browser_entry, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(origin) DO UPDATE SET
       house_key = excluded.house_key, schemes = excluded.schemes,
       session_board = excluded.session_board, browser_entry = excluded.browser_entry,
       updated_at = excluded.updated_at`,
    [
      binding.origin,
      binding.houseKey,
      declaration.schemes === undefined ? null : JSON.stringify(declaration.schemes),
      declaration.sessionBoard ? 1 : 0,
      // Rewritten on every commit, like the other two: a house that withdrew
      // its entrance goes back to NULL rather than keeping one this client
      // remembered on its behalf.
      serializeBrowserEntry(declaration.browserEntry),
      at,
    ],
  );
}

/** The declarations a manifest carries, read leniently and granting nothing. */
export function declarationOf(manifestBytes: Uint8Array): HouseReadDeclaration {
  const silence: HouseReadDeclaration = { schemes: undefined, sessionBoard: false, browserEntry: undefined };
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return silence;
    doc = parsed as Record<string, unknown>;
  } catch {
    // Verified bytes that are not a document declare nothing. The proof says
    // the house sent them; it does not say they mean anything.
    return silence;
  }
  return {
    schemes: readAuthSchemesOf(doc),
    sessionBoard: isHouseSessionBoard(doc['house_session']),
    browserEntry: browserEntryOf(doc),
  };
}

/**
 * The declaration that belongs to THIS pin, or nothing.
 *
 * A row filed under another key is not this house's word; it is the word of
 * the house this origin used to be. Returning `undefined` there lands on the
 * same refusal as never having heard a declaration at all, which is the
 * correct thing to say about a house whose key we no longer trust.
 */
export function readVerifiedDeclaration(
  db: HostDb,
  pin: HouseBindingPin,
): HouseReadDeclaration | undefined {
  const row = db.queryOne<DeclarationRow>(SELECT, [pin.origin]);
  if (row === null || row === undefined || row.house_key !== pin.houseKey) return undefined;
  return {
    schemes: parseSchemes(row.schemes),
    sessionBoard: row.session_board === 1,
    browserEntry: parseStoredBrowserEntry(row.browser_entry ?? null),
  };
}

/**
 * When the declaration this machine holds for the pinned key was last
 * verified, in unix seconds — or `undefined` when it holds none for that key.
 *
 * It is the `updated_at` the trust commit wrote, so it dates a verified check,
 * not a guess. A refusal built on this row can then say how old it is instead
 * of stating a snapshot as the house's current word.
 */
export function declarationCheckedAt(db: HostDb, origin: string): number | undefined {
  const pin = pinnedBinding(db, origin);
  if (pin === undefined) return undefined;
  const row = db.queryOne<{ house_key: string; updated_at: number }>(
    'SELECT house_key, updated_at FROM house_read_declaration WHERE origin = ?',
    [pin.origin],
  );
  if (row === null || row === undefined || row.house_key !== pin.houseKey) return undefined;
  return row.updated_at;
}

/**
 * Whether the house-issued session read lane is POSITIVELY selected here.
 *
 * Three facts, all of them the house's and none of them this machine's
 * leftovers: a pin that is present and not blocked, a declaration that belongs
 * to that pin's key, and a `house_session` board inside the manifest that pin
 * verified. The caller adds the fourth — a live session with a token.
 *
 * What this deliberately is NOT is "the identity-read resolver refused". A
 * failure is not a protocol negotiation, and a refusal that reroutes to
 * another credential is a client overriding its own decision.
 */
export function sessionReadSelected(db: HostDb, origin: string): boolean {
  const pin = pinnedBinding(db, origin);
  if (pin === undefined || pin.blockedReason !== undefined) return false;
  return readVerifiedDeclaration(db, pin)?.sessionBoard === true;
}

/**
 * A stable string for "is this the same declaration as the one I decided on".
 *
 * It covers EVERY declaration the row carries, browser entrance included. A
 * fingerprint that only summarised the read capability would keep reading the
 * same while the site an entry link points at moved underneath a pending
 * confirmation — which is the one thing a re-check before signing exists to
 * catch.
 */
export function declarationFingerprint(declaration: HouseReadDeclaration | undefined): string {
  if (declaration === undefined) return 'none';
  return (
    `${JSON.stringify(declaration.schemes ?? null)}:${declaration.sessionBoard ? 1 : 0}` +
    `:${browserEntryFingerprint(declaration.browserEntry)}`
  );
}

function parseSchemes(raw: string | null): readonly string[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
