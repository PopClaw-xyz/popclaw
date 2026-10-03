/**
 * What a house is trusted to be, established once and confirmed thereafter.
 *
 * A relation is scoped to a `HouseBinding.house_key`, so before any follow can
 * be written or any inbound original committed, this machine has to have
 * decided which key that is for a given origin. Nothing decided it. The world
 * path establishes a binding only after finding a session board's ACK key, and
 * both deployed houses serve no session board — so for every house a real user
 * has, that decision was never reached at all.
 *
 * The rules here are not new; they are the existing house-trust rules, reached
 * from the login path for the first time:
 *
 *  - **First sight establishes.** There is no prior key to check against, so
 *    what carries the trust is the owner's explicit act plus a verified
 *    transport — not the response, which cannot vouch for itself.
 *  - **Every sight after that confirms.** A binding that already exists is
 *    checked, never replaced.
 *  - **A conflict refuses and keeps the old binding.** Re-running `login` is
 *    not authorization to re-key a house; that needs its own decision about
 *    that specific old binding, and this path deliberately cannot make it.
 *
 * ## It binds the bytes the login was served
 *
 * An earlier version of this fetched the manifest a second time, and said it
 * did so because the login's fetch "does not require HTTPS, forbid redirects,
 * or treat loopback as an explicit allowance". Two of those three were simply
 * false: `control-client.ts` passes `redirect: 'error'`, and
 * `normalizeHouseOrigin` refuses plain http for anything but loopback, on
 * every login. The second GET was paid for a problem that did not exist, and
 * it broke the rule that a login issues one manifest request.
 *
 * So the served bytes are handed to the same `house-trust` machinery through
 * a one-shot responder. Every guard still runs — the scheme check happens
 * before the fetch, and the revision CAS, participation snapshot and prepared
 * registry are untouched — and the two decisions now rest on ONE response
 * rather than on two that nothing cross-checks.
 */
import type { HostDb } from '../host/host-db.js';
import { pinnedBinding } from '../world/house-binding-pin.js';
import {
  beginHouseAdd,
  prepareHouseTrust,
  prepareConfirmHouseTrust,
  commitRelationBindingInTx,
} from '../world/house-trust.js';

export interface RelationBindingDeps {
  readonly db: HostDb;
  /**
   * The operator's pinned key for an origin, when there is one. Supplying it
   * makes this a CONFIGURED trust: the proof is checked against that key and a
   * house serving anything else is refused outright. Without one, a first
   * sight is a weaker thing and does not get to call itself configured.
   */
  readonly configuredKeyFor?: (origin: string) => string | undefined;
  /**
   * Origins where plain http is the owner's deliberate choice — a local test
   * house, a development lore-house. An explicit allowance, never inferred
   * from the scheme: "it said http" is not a reason to accept http.
   */
  readonly allowInsecureOrigin?: (origin: string) => boolean;
  readonly now?: () => number;
}

export interface PreparedRelationBinding {
  /**
   * Returns the refusal reason, or undefined when it bound.
   *
   * It does NOT throw. A throw here would abort the caller's transaction,
   * and one of the things written in that transaction is the BLOCK a
   * key-or-incarnation disagreement leaves behind — which `house-trust`
   * states plainly is "a security outcome, not a guard, and stays". Rolling
   * it back would mean the one refusal worth remembering is the one that
   * erases its own record.
   */
  commit(tx: HostDb): string | undefined;
}

/**
 * Builds the hook the lifecycle manager calls on an explicit login.
 *
 * It throws on refusal rather than returning a quiet "no relations here". The
 * manager has an outlet for that and uses it; a house whose proof did not
 * verify must never end up looking like a house that never offered relations.
 */
export function makeRelationBindingPreparer(deps: RelationBindingDeps) {
  return async (input: {
    readonly origin: string;
    readonly rawBytes: Uint8Array;
    readonly proofHeader: string | null;
    readonly signal: AbortSignal;
  }): Promise<PreparedRelationBinding> => {
    const { origin } = input;
    const configured = deps.configuredKeyFor?.(origin);
    // The login's response, replayed to the verifier rather than re-requested.
    // `fetchTrustedManifest` checks the scheme BEFORE it calls this, so the
    // transport rule is still enforced here; what is skipped is only the
    // second round trip.
    // `.slice()` copies into a buffer that is exactly these bytes — handing
    // over the live view's backing buffer could carry unrelated bytes with it.
    const body = input.rawBytes.slice().buffer as ArrayBuffer;
    const served: typeof globalThis.fetch = async () => new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        ...(input.proofHeader !== null ? { 'X-Popclaw-Manifest-Proof': input.proofHeader } : {}),
      },
    });
    const opts = {
      fetch: served,
      ...(configured ? { configuredHouseKey: configured } : {}),
      ...(deps.allowInsecureOrigin?.(origin) ? { allowInsecureOrigin: true } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    };

    const existing = pinnedBinding(deps.db, origin);
    const prepared = existing !== undefined
      // Already decided. Re-verified against the key already pinned here, so
      // it cannot write a different one even if it wanted to.
      //
      // `allowEndedParticipation` is what makes REJOINING possible. A pin
      // outlives a leave by design, so someone returning to a house they left
      // takes this path with no live participation — and without it they were
      // refused for ever at a house they had personally asked to return to.
      // It does not widen what a confirm may do: still no new key, still no
      // block cleared.
      ? await prepareConfirmHouseTrust(deps.db, origin, { ...opts, allowEndedParticipation: true })
      // Never decided. The owner's command IS the authorization — that is
      // what `beginHouseAdd` exists to represent, and why nothing recorded
      // anywhere can stand in for it.
      : await prepareHouseTrust(deps.db, origin, { ...opts, attempt: beginHouseAdd(deps.db, origin) });

    if (!prepared.ok) throw new Error(prepared.refusal);
    const handle = prepared.prepared;

    return {
      commit(tx: HostDb): string | undefined {
        const committed = commitRelationBindingInTx(deps.db, tx, handle,
          deps.now ? { now: deps.now } : {});
        return committed.ok ? undefined : committed.refusal;
      },
    };
  };
}
