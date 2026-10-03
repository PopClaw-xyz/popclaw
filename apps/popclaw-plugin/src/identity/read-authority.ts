/**
 * One place decides how a read proves who is asking.
 *
 * Contract: `docs/contracts/relation-read-credential-v2.md` sections 8.3 and 9.
 *
 * Every identity-bearing read — the follower list, the inbox stream, the
 * relation snapshot and its evidence — has to answer the same two questions
 * before it can go out: *whose house is this, verifiably*, and *what did that
 * house say it can verify*. Answering them once, here, is the whole point.
 * Four call sites each answering for themselves is how three of them end up
 * agreeing and the fourth quietly sends something else.
 *
 * The three inputs are fixed by the contract and there is no fourth: the
 * current origin, the verified identity binding, and the named scheme the
 * house declared. **No domain allow-list**, no guessing from a version number,
 * no probing on a 401.
 *
 * All three now come from ONE response. The declaration is
 * `house-read-declaration.ts`'s projection of the same manifest bytes the pin's
 * proof was verified over, committed in the same transaction as the binding —
 * not, as it was, a field copied out of an unauthenticated handshake fetch that
 * nothing tied to the pin's own digest or revision.
 *
 * Every answer that is not "sign a v2 credential" is a REFUSAL:
 *
 *   - no verified binding at this origin → there is no audience to sign for,
 *     and inventing one would mean signing for a house nobody proved;
 *   - the house declared nothing → it does not do identity reads. Not a
 *     reason to try the old three-part token, not a reason to read
 *     anonymously, and above all not "nobody follows you" — a working house
 *     with no followers looks exactly like that, so the difference has to be
 *     said out loud or it is never said at all;
 *   - the house declared a name this build does not speak → the same refusal
 *     on a different fact. `house_session.proto` already has a credential
 *     called v2 and it is not this one, which is why the match is exact.
 *
 * A refusal is not always the whole story about a house, and this file is also
 * where that is said out loud. A house may decline identity reads and still
 * hand out a read token inside a login session; `chooseInboxReadToken` already
 * selects that lane positively, from the same verified `house_session` board.
 * `houseReadStanding` at the bottom reports which kinds of read are open —
 * for the owner's readout only. It changes no decision and mints nothing: what
 * goes on the wire is still decided above, and still refuses by name.
 *
 * The audience's origin is the pinned binding's own string, copied verbatim.
 * Nothing re-normalises the AUDIENCE: the house signed that string into its
 * manifest proof, so having verified the proof is having verified the string,
 * and a second normaliser on that side would only be a second place for the
 * two ends to disagree.
 *
 * The LOOKUP KEY is the opposite case, and the two must not be confused. What
 * a caller holds is whatever the owner put in `lore_houses` — validated only
 * as a URL, so `https://House.popclaw.me/` is as legal as the canonical form —
 * while a pin is always filed under the canonical origin the runtime derived
 * before it ever logged in. So the key is canonicalised ONCE, here, and the
 * pin, the declaration and the audience are then all read under that one
 * string. Doing it in each caller instead is how three of them agree and the
 * fourth asks for a house that, as far as the pin table is concerned, does not
 * exist — which reads as `READ_AUTH_HOUSE_NOT_TRUSTED` on a house the owner
 * configured and the runtime trusts.
 *
 * An address this build cannot canonicalise at all (userinfo, a fragment, a
 * scheme that is not http(s) — all of which `z.string().url()` lets through)
 * is a house no credential can name, so it is the same REFUSAL and never an
 * exception thrown out of a read path.
 */
import type { HostDb } from '../host/host-db.js';
import { normalizeHouseOrigin } from '../runtime/house-lifecycle/control-client.js';
import { readParticipation } from '../runtime/house-lifecycle/participation-store.js';
import { pinnedBinding, type HouseBindingPin } from '../world/house-binding-pin.js';
import {
  declarationFingerprint,
  readVerifiedDeclaration,
  type HouseReadDeclaration,
} from '../world/house-read-declaration.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import type { Signer } from './signer.js';
import {
  INBOX_TOKEN_HEADER,
  buildReadCredential,
  selectReadScheme,
  type ReadPurpose,
} from './read-credential.js';

/** Bare codes, so a caller branches without matching prose. */
export type ReadAuthRefusal =
  | 'READ_AUTH_HOUSE_NOT_TRUSTED'
  | 'READ_AUTH_NOT_DECLARED'
  | 'READ_AUTH_SCHEME_UNSUPPORTED';

export type ReadCredentialOutcome =
  | { readonly ok: true; readonly headers: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly refusal: ReadAuthRefusal; readonly message: string };

/**
 * One house's read authority, already bound to that house.
 *
 * A function of the PURPOSE alone, because the purpose is the only thing that
 * changes between two requests to the same house — and it must change, or one
 * snapshot credential would open the evidence endpoint too.
 */
export type ReadAuthority = (purpose: ReadPurpose) => Promise<ReadCredentialOutcome>;

export interface ReadAuthoritySources {
  readonly db: HostDb;
  readonly signer: Signer;
  readonly clock?: () => number;
}

/**
 * Bind the decision to one house.
 *
 * Nothing is cached: the pin can be blocked and the declaration can change
 * between two requests, and a credential minted under an answer that has since
 * been withdrawn is exactly the request that should not go out. Signing is
 * cheap next to the round trip it authorises.
 *
 * And signing is not instant. The decision is captured BEFORE the signature
 * and re-checked AFTER it and before the credential leaves this function: a
 * logout, a block, or a house withdrawing its declaration while the key was
 * busy would otherwise be overtaken by a credential minted under the answer
 * that had just stopped being true.
 */
export function houseReadAuthority(sources: ReadAuthoritySources, origin: string): ReadAuthority {
  return async (purpose) => {
    const decision = decideReadAuthority(sources.db, origin);
    if ('refusal' in decision) return refuse(decision);
    const lifecycle = lifecycleFingerprint(sources.db, decision.origin);
    const token = await buildReadCredential(
      sources.signer,
      // Verbatim from the pin, both fields. The origin the caller passed was
      // only ever a lookup key.
      { origin: decision.pin.origin, houseKey: decision.pin.houseKey },
      purpose,
      sources.clock ?? (() => Date.now()),
    );
    const after = decideReadAuthority(sources.db, origin);
    if ('refusal' in after) return refuse(after);
    if (!sameSelection(decision, after) || lifecycleFingerprint(sources.db, after.origin) !== lifecycle) {
      // The selection moved under the signature. There is no "which of the two
      // is right" to resolve here — a credential is minted for one answer, and
      // this one was minted for an answer nobody holds any more.
      return refuse({ refusal: 'READ_AUTH_HOUSE_NOT_TRUSTED', origin: after.origin });
    }
    return { ok: true as const, headers: { [INBOX_TOKEN_HEADER]: token } };
  };
}

/**
 * The lifecycle state this decision was made under, as one comparable string.
 *
 * A logout bumps `op_seq` and flips `desired` in one local transaction, so a
 * logout that lands while the key is signing changes this string and the
 * credential never leaves. Only CHANGE is refused, not a house that was
 * already logged out when the decision was made: that is the caller's gate to
 * judge, and the inbox lane already does.
 *
 * The lifecycle tables are created at runtime rather than by a migration, so a
 * database that has never mounted a house legitimately has none — which is a
 * lifecycle state like any other, and stays comparable.
 */
function lifecycleFingerprint(db: HostDb, origin: string): string {
  try {
    const row = readParticipation(db, origin);
    return row === null ? 'none' : `${row.desired}:${row.op_seq}:${row.session_id}`;
  } catch {
    return 'none';
  }
}

/** Everything the decision rested on, unchanged. */
function sameSelection(
  before: { readonly pin: HouseBindingPin; readonly declaration: HouseReadDeclaration | undefined },
  after: { readonly pin: HouseBindingPin; readonly declaration: HouseReadDeclaration | undefined },
): boolean {
  return (
    before.pin.origin === after.pin.origin &&
    before.pin.houseKey === after.pin.houseKey &&
    before.pin.revision === after.pin.revision &&
    declarationFingerprint(before.declaration) === declarationFingerprint(after.declaration)
  );
}

/**
 * A refusal, or the pin a credential would be signed for — and, either way,
 * the canonical origin everything was looked up under. Callers that show the
 * answer to the owner key their own lookups by that string rather than by
 * whatever was configured; one decision, one key.
 */
export type ReadAuthorityDecision =
  | {
      readonly refusal: ReadAuthRefusal;
      readonly origin: string;
      /**
       * The verified projection the refusal was made on, when there was one.
       *
       * Carried for the SENTENCE, never for the decision: the refusal code
       * above is computed exactly as before and nothing downstream may turn
       * this field into a second credential lane. It is here so that "this
       * house declared no read scheme" and "this house declared no read
       * scheme but does have a login session" — two states the owner has to
       * act on differently — stop sharing one line of prose. Absent for a
       * missing or blocked pin: that refusal is answered before any
       * declaration is read, and it must stay that way.
       */
      readonly declaration?: HouseReadDeclaration;
    }
  | {
      readonly pin: HouseBindingPin;
      readonly origin: string;
      /** The verified projection this decision was made on, for the re-check. */
      readonly declaration: HouseReadDeclaration | undefined;
    };

/**
 * The decision itself, without signing anything.
 *
 * Status needs the same answer the read path acts on, and asking for a
 * credential to find out would sign one nobody is going to send. Splitting it
 * out keeps the ONE place this file exists to be: a readout that reproduced
 * the reasoning would be a second decider, and the two would agree right up
 * until one of them was changed.
 */
export function decideReadAuthority(db: HostDb, configured: string): ReadAuthorityDecision {
  // Canonicalised once, here, and never again below: the pin, the declaration
  // and the audience are then all read under this one string. No canonical
  // form at all means no house a credential could name, which is the same
  // refusal — never an exception thrown out of a read path.
  let origin: string;
  try {
    origin = normalizeHouseOrigin(configured);
  } catch {
    return { refusal: 'READ_AUTH_HOUSE_NOT_TRUSTED', origin: configured };
  }
  // The binding first: without a verified one there is no audience, so
  // there is nothing to sign for whatever the house may have declared.
  const pin = pinnedBinding(db, origin);
  if (pin === undefined || pin.blockedReason !== undefined) {
    return { refusal: 'READ_AUTH_HOUSE_NOT_TRUSTED', origin };
  }
  const declaration = readVerifiedDeclaration(db, pin);
  const choice = selectReadScheme(declaration?.schemes);
  if ('refusal' in choice) return { refusal: choice.refusal, origin, ...(declaration ? { declaration } : {}) };
  return { pin, origin, declaration };
}

function refuse(decision: {
  readonly refusal: ReadAuthRefusal;
  readonly origin: string;
  readonly declaration?: HouseReadDeclaration;
}): ReadCredentialOutcome {
  return {
    ok: false as const,
    refusal: decision.refusal,
    message: readAuthRefusalMessage(
      decision.refusal,
      decision.origin,
      ownerLang(),
      decision.declaration?.sessionBoard === true,
    ),
  };
}

/**
 * What to tell the owner.
 *
 * THREE states, three sentences — it used to be two, and the reference server
 * is what that cost. That house declares no `read_auth` block at all and does
 * declare a `house_session` board. The refusal was right and named
 * (`READ_AUTH_NOT_DECLARED`); the sentence under it said "the read
 * authentication scheme it currently uses is not supported", which is a
 * sentence about a house that named a scheme. The owner is sent to check that
 * house's version, while the step that actually opens the inbox is to log in.
 *
 * So the split is on `session_board` from the VERIFIED declaration — the same
 * fact `chooseInboxReadToken` already selects the session read lane by, read
 * from the same projection. Nothing here decides anything: the refusal code,
 * and every credential built anywhere from it, are exactly what they were.
 * This function only chooses which true sentence to print.
 *
 * `READ_AUTH_SCHEME_UNSUPPORTED` deliberately keeps the original wording and
 * is NOT split the same way: a house that named a scheme this build cannot
 * speak has said something specific and wrong for this client, and "log in
 * instead" is not the answer to it.
 */
export function readAuthRefusalMessage(
  refusal: ReadAuthRefusal,
  origin: string,
  lang: Lang = ownerLang(),
  /** The verified declaration carried a `house_session` board. */
  sessionLane = false,
): string {
  return renderCopy(lang, refusalCopyKey(refusal, sessionLane), { origin });
}

function refusalCopyKey(refusal: ReadAuthRefusal, sessionLane: boolean): string {
  if (refusal === 'READ_AUTH_HOUSE_NOT_TRUSTED') return 'read.auth.untrusted';
  if (refusal === 'READ_AUTH_SCHEME_UNSUPPORTED') return 'read.auth.unsupported';
  return sessionLane ? 'read.auth.sessionLogin' : 'read.auth.notDeclared';
}

/**
 * What the owner can actually read at one house, per KIND of read.
 *
 * Status used to ask `decideReadAuthority` alone and render one tick from it.
 * That is right for a house whose reads all ride the identity credential, and
 * wrong for a house that has a login session and nothing else: the inbox is
 * demonstrably readable there — the stream returns 200 to a request carrying
 * the session's own token — while the reads that must prove who is asking
 * have no credential at all. One tick cannot be true in both directions, so
 * the answer is a kind, not a boolean.
 *
 * The inputs are the two the READ PATH itself uses and no others: the verified
 * declaration behind `decideReadAuthority`, and the participation row
 * `chooseInboxReadToken` reads. Nothing is fetched. A readout that probed the
 * network would be a second decider, and would report a house as readable on
 * evidence the read path never consults.
 */
export type HouseReadStanding =
  /** The identity credential is granted here; every kind of read is open. */
  | { readonly kind: 'identity'; readonly origin: string }
  /** No identity credential, but a declared session lane holding a live token. */
  | { readonly kind: 'session-inbox'; readonly origin: string }
  /** Nothing identity-bearing can be read here, and the code says why. */
  | {
      readonly kind: 'refused';
      readonly origin: string;
      readonly refusal: ReadAuthRefusal;
      readonly sessionLane: boolean;
    };

export function houseReadStanding(db: HostDb, configured: string): HouseReadStanding {
  const decision = decideReadAuthority(db, configured);
  if (!('refusal' in decision)) return { kind: 'identity', origin: decision.origin };
  // A blocked or missing pin carries no declaration, so it cannot reach the
  // session lane here any more than it can in `chooseInboxReadToken` — a
  // remembered session must never resurrect the house the pin stopped
  // trusting.
  const sessionLane = decision.declaration?.sessionBoard === true;
  if (sessionLane && holdsLiveSession(db, decision.origin)) {
    return { kind: 'session-inbox', origin: decision.origin };
  }
  return { kind: 'refused', origin: decision.origin, refusal: decision.refusal, sessionLane };
}

/**
 * The same two columns `chooseInboxReadToken` reads, and the same verdict.
 *
 * A session id with no token is the state that THROWS there
 * (`HOUSE_SESSION_READ_TOKEN_MISSING`), so it is not readable and must not be
 * ticked. The lease deadline is deliberately NOT consulted: the read path does
 * not consult it either, and a readout that called the inbox unreadable while
 * this client was still sending that token would be the same kind of lie in
 * the other direction. The lifecycle tables are created at runtime, so a
 * database that never mounted a house legitimately has none.
 */
function holdsLiveSession(db: HostDb, origin: string): boolean {
  try {
    const row = readParticipation(db, origin);
    return row !== null && row.session_id !== '' && row.inbox_read_token !== '';
  } catch {
    return false;
  }
}
