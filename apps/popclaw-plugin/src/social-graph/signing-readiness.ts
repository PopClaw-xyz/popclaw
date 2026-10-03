/**
 * May this end sign a new relation event on this edge at all?
 *
 * `RelationAllocator.reserve()` already refuses when this end has VERIFIED
 * someone else signing higher. That covers one case and leaves the
 * one that matters most uncovered: a known import or a restored backup whose
 * observation root is still empty will happily reserve 1 on an edge where
 * originals it has never seen may already exist. "The allocator did not throw"
 * is therefore not a readiness signal, and treating it as one is how a restore
 * quietly forks every edge it used to hold.
 *
 * Three reasons to refuse, deliberately kept apart — collapsing them into one
 * boolean is what produced both of the defects this gate has had. A number this
 * end reserved and never signed is not evidence about another end; a local
 * count is not proof that a restored root's history is complete.
 *
 *  1. **Known history above this end that it has not re-established.** Only
 *     `observed` can carry that, and only an explicit recovery closes it.
 *  2. **A root that cannot account for its own history at all.** Independent of
 *     every counter.
 *  3. **A house claiming more than this end holds.** May block, never advance.
 *
 * Two inputs the allocator cannot have:
 *
 *  - **How this identity got here, and in which round.** Minted locally means
 *    there is no prior history anywhere; imported or restored means there may
 *    be history this root does not hold, and it must re-establish before it
 *    signs — in THIS round, because a restored database brings the previous
 *    round's proof back with it.
 *  - **What a house says about the edge.** A house's number is a CLAIM, not an
 *    allocation — my own rule, and it is why it may only ever BLOCK and never
 *    advance a counter. A hostile house can use this to stop the owner
 *    following someone, which is a denial and visible as one; the alternative
 *    is a silent collision with originals the owner really did sign, which is
 *    not visible at all. Between a refusal the owner can see and a fork they
 *    cannot, the refusal is the safe failure.
 */
import type { HostDb } from '../host/host-db.js';
import { currentIdentityRound, type RootOrigin } from './identity-round.js';
import type { RelationAllocator } from './relation-allocator.js';

export type SigningReadiness = 'ready' | { readonly blocked: string };

export type { RootOrigin };

export interface SigningReadinessDeps {
  readonly allocator: RelationAllocator;
  /**
   * Where the identity round is recorded. Read here rather than passed in as a
   * boolean: a caller reporting its own origin can be wrong, and the one case
   * that matters — a database restored a second time — is exactly the case
   * where the caller has nothing but that database to go on.
   */
  readonly db: HostDb;
  /**
   * What a house claims the current seq is on this edge, if it says anything.
   * UNVERIFIED by construction — that is the point. It may only block.
   */
  readonly houseClaimedSeq?: (houseKey: string, followee: string) => bigint | undefined;
}

export function makeSigningReadiness(
  deps: SigningReadinessDeps,
): (houseKey: string, followee: string) => SigningReadiness {
  return (houseKey, followee) => {
    const bound = deps.allocator.bound(houseKey, followee);

    // (1) Verified evidence of signing this end did not do.
    //
    // `observed` is the only counter that can carry it. The gate used to ask
    // `!authoritative && high > 0`, which is a different question and answers
    // it wrongly in both directions: a fresh root that reserved 1 and died
    // before signing it reopens with reserved=1, signed=0, observed=0, and was
    // told "another end has signed" — forever, because the only way out was to
    // sign, and it was not allowed to. A number this end handed to itself is
    // not evidence about anyone else. Skipping it is legitimate.
    if (bound.historyGapOpen) {
      return {
        blocked:
          `another end has signed to seq ${bound.observed} on this edge and this one ` +
          `has re-established only ${bound.recoveredThrough}`,
      };
    }

    // (2) A history this root cannot account for at all.
    //
    // Independent of every counter, which is the whole point: an old backup
    // with one signature on it looks exactly like a current root with one
    // signature on it, and the difference — whether 2..N exist elsewhere under
    // this same identity — is not visible from here. So a local count cannot
    // release this, and neither can a house reporting a low number or an
    // ordinary reserve. Only an explicit re-establishment of THIS edge does.
    //
    // Resending originals it already holds stays allowed throughout; what is
    // refused is allocating a new number on top of a history it cannot see.
    const round = currentIdentityRound(deps.db);
    if (
      round !== undefined &&
      (round.origin === 'imported' || round.origin === 'restored') &&
      (bound.recoveredInRound !== round.roundId || bound.recoveredThrough < bound.recoveredEver)
    ) {
      // The proof has to belong to THIS round, and it has to reach as far as
      // any round ever did. A recovery recorded before the backup was taken
      // comes back inside it, so asking only whether some recovery ever
      // happened let a restored copy present the previous round's work as its
      // own. Asking only whether THIS round stamped the row was not enough
      // either: a partial recovery here, relabelled over a complete one there,
      // reads as complete. The older work stays on the row as history, and
      // history is exactly the bar this round has to clear.
      const short =
        bound.recoveredInRound === round.roundId
          ? ` (this round has re-established ${bound.recoveredThrough} of ${bound.recoveredEver})`
          : bound.recoveredEver > 0n
            ? ' (an earlier round recovered it; that proof belongs to that round)'
            : '';
      return {
        blocked:
          `this identity was ${round.origin} and this edge's history has not been ` +
          `re-established in the current round${short}`,
      };
    }

    const claimed = deps.houseClaimedSeq?.(houseKey, followee);
    if (claimed !== undefined && claimed > bound.high) {
      // Deliberately asymmetric: this raises no counter and never becomes the
      // next seq. It only says "somebody says there is more than you have", and
      // signing into that gap is the one thing that cannot be undone.
      return {
        blocked:
          `a house reports seq ${claimed} on this edge and this end has only ${bound.high}; ` +
          'signing would collide with originals it has never seen',
      };
    }

    return 'ready';
  };
}
