/**
 * The sending side of an ordered relation event — what happens when the owner
 * follows or unfollows someone.
 *
 * Before this file, a real user action could not enter the ordered chain at
 * all: nothing reserved a seq, nothing bound the signing house, and a failed
 * push was swallowed with a `logger.warn` while the command layer still printed
 * `✓ unfollowed`. That last part is the one worth naming, because it is not a
 * cosmetic bug: the owner is told a relation changed on a house that never
 * heard about it, and the social log keeps that false fact forever (P-004).
 *
 * The whole file is therefore organised around one rule — **a local write is
 * not a remote fact** — and around keeping apart the things that are easy to
 * collapse into one another:
 *
 *   intent_recorded  the owner asked. Nothing has been signed or sent.
 *   queued           the signed original and its send todo are durable.
 *   accepted         a house on the chosen route echoed THIS exact CID, so the
 *                    transport todo can close. It does NOT mean the follow was
 *                    applied, and it does not mean the two ends agree — see
 *                    {@link RelationDomainState}.
 *
 * Order of operations, and why it is that order:
 *   ① resolve the scope — the producer never picks a house, and it treats
 *      "supported", "unsupported", "unproven" and "unreachable" as four
 *      different answers rather than one bucket called "old house".
 *   ② check signing readiness explicitly, then reserve a seq.
 *   ③ sign, binding `order { seq, house_key }` to the resolved house.
 *   ④ persist the signed original AND its send todo **before** the first
 *      network attempt.
 *   ⑤ push.
 *   ⑥ markSent only on a receipt naming this event id.
 *
 * ④ before ⑤ is the point. A timeout is the ordinary way to fork your own
 * edge: sign seq 8, the push hangs, re-sign, and the second attempt carries a
 * different event id at the same position. A restart or a timeout re-sends the
 * SAME stored bytes — {@link RelationProducer.resendPending} exists for exactly
 * that, and re-signing on retry is forbidden.
 */
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import type { Signer } from '../identity/signer.js';
import { RelationAllocator, type PendingRelationPush } from './relation-allocator.js';
import { activeRelationHouses } from './relation-active-houses.js';
import { signFollowDeclared, signFollowRevoked } from './sign-event.js';


export type RelationAction = 'declare' | 'revoke';

// ---------------------------------------------------------------------------
// ① Where the house comes from
// ---------------------------------------------------------------------------

/**
 * The edge as it was originally declared, carried into the scope call for a
 * revoke. An unfollow goes back to the house that holds the follow; re-picking
 * a house from wherever that person was most recently seen would send the
 * revoke somewhere that never held it, and the follow would simply stand.
 */
export interface DeclaredEdgeOrigin {
  /** The route the declaration took. Undefined = the home house. */
  readonly houseSlug?: string;
  /**
   * Every house key this edge's originals were signed under. Empty = the edge
   * has never been ordered locally, so it is still a legacy edge.
   */
  readonly houseKeys: readonly string[];
}

/**
 * What the producer asks the host, never what it decides for itself. A producer
 * that chose its own house could be steered by whichever house answered first.
 */
export interface RelationScopeRequest {
  readonly action: RelationAction;
  readonly followee: string;
  /** Revoke only: where this edge lives and under which key(s) it was signed. */
  readonly declaredEdge?: DeclaredEdgeOrigin;
  /** Explicit exact configured slug or origin; never inferred from discovery. */
  readonly house?: string;
  /** Active local intents, including durable originals whose ledger write was lost. */
  readonly activeHouses?: readonly (string | undefined)[];
  readonly activeUncertainty?: string;
  readonly uncertainHouses?: readonly (string | undefined)[];
}

/**
 * Four answers, deliberately not three.
 *
 * A verified `houseKey` proves **identity**, not **capability**: knowing who a
 * house is says nothing about whether it serves ordered relations. And a house
 * that cannot be reached right now has told you nothing at all about what it
 * supports. Collapsing either of those into "old house, send legacy" converts a
 * transient error or a failed proof into a silent protocol downgrade, which is
 * exactly the trade an attacker is trying to make.
 */
export type RelationScope =
  /** Verified binding AND a confirmed capability for ordered relations. */
  | {
      readonly support: 'supported';
      readonly houseKey: string;
      readonly houseSlug?: string;
    }
  /**
   * Verified binding, but this house does not serve ordered relations. Not a
   * licence for the legacy shape either: this build emits one wire format.
   * The answer is a refusal both ends can see, not a quieter downgrade.
   */
  | {
      readonly support: 'unsupported';
      /** Still a verified key — identity was proven, capability was absent. */
      readonly houseKey: string;
      readonly houseSlug?: string;
      readonly detail?: string;
    }
  /** No pin, a proof that failed, or a binding that moved. Never legacy. */
  | {
      readonly support: 'unproven';
      readonly reason?: RelationRefusalReason;
      readonly houseSlug?: string;
      readonly detail?: string;
    }
  /**
   * A network failure right now. Never legacy either: being unreachable is not
   * evidence about what a house supports. Retry, do not downgrade.
   */
  | {
      readonly support: 'unreachable';
      readonly houseSlug?: string;
      readonly detail?: string;
    }
  /**
   * The verified manifest carried a `relations` block this build cannot
   * interpret — present but mistyped, or naming a level this end does not
   * know. That is NOT the house saying "no ordered relations" (`unsupported`
   * is), and it is not a licence for the legacy shape: an unknown vocabulary
   * says what this END can verify, and guessing it either way — fake support,
   * or silent downgrade — is exactly the collapse the four other answers
   * exist to prevent.
   */
  | {
      readonly support: 'capability-unknown';
      readonly houseKey?: string;
      readonly houseSlug?: string;
      readonly detail?: string;
    };

// ---------------------------------------------------------------------------
// ② Signing readiness — an explicit input, never an inference
// ---------------------------------------------------------------------------

/**
 * Whether this end may mint a NEW seq on this edge at all.
 *
 * It is asked, not inferred, because the allocator's silence is not an answer.
 * `RelationAllocator.reserve()` throws `RELATION_SIGNING_NOT_READY` for exactly
 * one case — this end has *observed* another end signing higher — and a known
 * import or restore whose observation root is still empty will happily reserve
 * 1 on an edge where originals it has never seen already exist. "The allocator
 * did not throw" is therefore not a readiness signal, and using it as one is
 * the default-to-true that the relation contract refuses.
 *
 * The implementation belongs to the identity lifecycle (newly minted vs known
 * import/restore) and lives outside this module; the producer only consumes it,
 * and never unlocks it, clears `lower_bound_only`, or keeps identity state of
 * its own.
 */
export type RelationSigningReadiness = 'ready' | { readonly blocked: string };

export type SigningReadinessCheck = (
  houseKey: string,
  followee: string,
) => RelationSigningReadiness;

// ---------------------------------------------------------------------------
// ④ What a receipt means
// ---------------------------------------------------------------------------

/**
 * Structurally the subset of `egress/event-egress.ts`'s `PushResult` this side
 * is allowed to reason about. Declared here rather than imported so that the
 * one field acceptance depends on — `eventId` — is visibly part of this
 * module's contract instead of an optional extra someone may later drop.
 */
export interface RelationPushReceipt {
  readonly status: number;
  /** The house's echo of what it stored. Absent = NOT acceptance. */
  readonly eventId?: string;
  readonly deduplicated?: boolean;
  readonly detail?: string;
}

export type RelationPush = (
  signedBytes: Uint8Array,
  houseSlug: string | undefined,
) => Promise<RelationPushReceipt>;

export type RelationPushFailureKind =
  /** The push threw: no receipt at all. */
  | 'transport'
  /** A receipt, and it is a refusal (non-2xx). */
  | 'refused'
  /** 2xx, but it did not name this event id. Delivered, not agreed. */
  | 'unacknowledged';

export interface RelationPushFailure {
  readonly kind: RelationPushFailureKind;
  readonly status?: number;
  readonly detail?: string;
}

/** Whether the bytes got there and the send todo can close. */
export type RelationTransportState = 'unchanged' | 'intent_recorded' | 'queued' | 'accepted';

/**
 * What the house DID with the event, as opposed to whether it took delivery.
 *
 * Kept as its own field so a CID echo can never be read as agreement. Today's
 * receipt carries only `event_id` and `deduplicated`, and a house can return
 * Accepted for an event it stored as `pending` or recorded as a fork branch —
 * so nothing in this slice can honestly report anything but `unknown`. Widening
 * this type requires the evidence read the relations contract demands, not a more optimistic
 * reading of the same receipt.
 */
export type RelationDomainState =
  /** Nothing here can say more than this, and nothing may pretend otherwise. */
  | 'unknown'
  /**
   * Checked against the house's own evidence for this edge.
   *
   * **Produced by nothing in this slice, and that is deliberate.** The evidence
   * read does not exist yet, and the only other thing on offer is a transport
   * ACK — which is exactly what must never be promoted into this value. The
   * field exists so the state has one home when the read lands, rather than
   * being bolted on later next to a receipt that already looks like proof.
   */
  | 'confirmed';

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every value here means the same thing: **nothing was signed and nothing was
 * sent**. None of them is a reason to invent a seq, to default readiness to
 * true, or to clear `lower_bound_only` — each of those manufactures authority
 * this end does not have.
 */
export type RelationRefusalReason =
  /** Readiness said no, or the allocator did. */
  | 'RELATION_SIGNING_NOT_READY'
  | 'RELATION_SEQ_EXHAUSTED'
  | 'HOUSE_SELECTION_REQUIRED'
  | 'RELATION_NOT_FOLLOWING'
  /** A different original already occupies this seq — a fork, caught early. */
  | 'RELATION_SEQ_ALREADY_SIGNED'
  /** No pin, a failed proof, or a binding that moved. Not a licence for legacy. */
  | 'HOUSE_BINDING_UNPROVEN'
  /** The house could not be reached. Retry; being down proves nothing. */
  | 'HOUSE_UNREACHABLE'
  /** The edge is already ordered and this house cannot order it (§8.1②). */
  | 'ORDERED_EDGE_NEEDS_BINDING'
  /** The edge's originals were signed under another house key. */
  | 'ORDERED_EDGE_HOUSE_KEY_CHANGED'
  /**
   * The verified manifest's `relations` block could not be interpreted —
   * mistyped, or a level this build does not know. Refused, never legacy:
   * an unreadable capability statement is not an absence of capability.
   */
  | 'HOUSE_CAPABILITY_UNKNOWN'
  /**
   * Identity proven, and the manifest declares no ordered relations. This
   * build does not answer that with the old shape: this is a first release,
   * so there is no deployed population the legacy format would be reaching,
   * and an edge started legacy carries no seq — nothing can order it later
   * without abandoning its history. Both ends move together or neither does.
   */
  | 'HOUSE_ORDERED_RELATIONS_UNSUPPORTED';

/**
 * The owner asked and this end could not act. Recorded as pending WITH the
 * reason — never as a relation change, and never as a success line in the
 * social log, because neither of those became true.
 *
 * The sink is a required dependency on purpose: an optional one with a no-op
 * default is how an intent quietly disappears, and "the owner's request was
 * dropped" is the failure this whole file exists to make visible.
 */
export interface PendingRelationIntent {
  readonly action: RelationAction;
  readonly followee: string;
  readonly houseSlug?: string;
  readonly reason: RelationRefusalReason;
  readonly detail?: string;
  /** Unix seconds. */
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

interface RelationOutcomeBase {
  readonly action: RelationAction;
  readonly followee: string;
  readonly houseSlug?: string;
  /** Always `unknown` in this slice. See {@link RelationDomainState}. */
  readonly domain: RelationDomainState;
}

/** A seq was reserved and the original is durable. */
export interface RelationOrderedOutcome extends RelationOutcomeBase {
  readonly mode: 'ordered';
  readonly transport: 'queued' | 'accepted';
  readonly houseKey: string;
  readonly eventId: string;
  readonly seq: bigint;
  /**
   * True when another end holding the owner's key has signed above what this
   * end did. The number handed out is still safe; what is not safe is
   * presenting this end's local count as the edge's whole history.
   */
  readonly anotherEndHasSigned: boolean;
  /**
   * This call signed nothing: the edge already carried exactly this
   * statement, and what happened instead was that the existing one was
   * finished — its ledger row repaired, its bytes re-sent if they had never
   * landed. The ask is fulfilled, which is why this is an ordered outcome and
   * not a refusal, but nothing about the relation CHANGED — so a caller must
   * not record an interaction, write a social-log line, or move a timestamp
   * on the strength of it.
   */
  readonly restated?: true;
  /** Absent exactly when `transport === 'accepted'`. */
  readonly failure?: RelationPushFailure;
}

/** Nothing signed or sent. An actionable refusal is recorded; no-edge and
 * house-selection answers leave the database unchanged. */
export interface RelationRefusedOutcome extends RelationOutcomeBase {
  readonly mode: 'none';
  readonly transport: 'intent_recorded' | 'unchanged';
  readonly reason: RelationRefusalReason;
  readonly detail?: string;
}

export type RelationOutcome = RelationOrderedOutcome | RelationRefusedOutcome;

/**
 * One stored original re-sent. It deliberately carries no `action`: the outbox
 * stores bytes, not a verb, and decoding the original just to label the report
 * would be inventing a field the table does not have.
 */
export interface RelationResendOutcome {
  readonly eventId: string;
  readonly followee: string;
  readonly houseKey: string;
  readonly seq: bigint;
  readonly houseSlug?: string;
  readonly transport: 'queued' | 'accepted';
  readonly domain: RelationDomainState;
  readonly failure?: RelationPushFailure;
}

// ---------------------------------------------------------------------------
// Errors for the compatibility shim (see social-graph.ts)
// ---------------------------------------------------------------------------

/**
 * How far the owner's action actually got.
 *
 * `received` is the one worth reading twice. It means a house on the chosen
 * route echoed this exact CID, so the send todo can close — and nothing more.
 * It does not say the original was applied rather than stored as `pending`, and
 * it does not say the edge is not forked or this event stale. The house's
 * receipt carries `event_id` and `deduplicated`; neither answers any of that.
 *
 * `confirmed` is therefore unreachable in this slice, and deliberately kept in
 * the type as the slot that evidence read will fill. Nothing may
 * promote `received` to it by looking harder at the same receipt.
 */
export type RelationConfidence =
  /** Nothing was signed and nothing was sent. */
  | 'not_declared'
  /** Signed, reached no house, and has no send todo to retry from (legacy). */
  | 'undelivered'
  /** The original and its send todo are durable; no house has echoed it. */
  | 'queued'
  /** A house echoed this CID. The relation state is still to be confirmed. */
  | 'received'
  /** Verified against the house's own evidence. Not produced here. */
  | 'confirmed';

// `relationReceipt` (an owner-facing receipt renderer keyed on `RelationConfidence`,
// once living here) was deleted 2026-09-27: zero callers, and it rendered
// `relation.follow.*` / `relation.unfollow.*` keys that don't exist in the
// lexicon (the real receipts are `relation.followReceived` etc., rendered in
// `commands/follow.ts` and `commands/popclaw-unfollow.ts`). It also guessed
// `?? 'the home house'` when `houseSlug` was absent — the guess the G1-copy
// fix (commands/follow.ts, commands/popclaw-unfollow.ts) deliberately does
// not make.

/** Thrown where a caller's only vocabulary is "worked" / "threw". */
export class RelationRefusedError extends Error {
  constructor(readonly outcome: RelationRefusedOutcome) {
    super(`${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''}`);
    this.name = 'RelationRefusedError';
  }
}

// ---------------------------------------------------------------------------

export interface RelationProducerLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface RelationProducerDeps {
  /** The social DB: `follow_events`, `relation_seq`, `relation_outbox`. */
  readonly db: HostDb;
  readonly signer: Signer;
  /** §8.1① — the host's house resolution. The producer never picks a house. */
  readonly resolveScope: (req: RelationScopeRequest) => Promise<RelationScope> | RelationScope;
  /**
   * §8.1③ — may this end mint a new seq on this edge? Required and explicit:
   * see {@link RelationSigningReadiness} for why the allocator's silence will
   * not do. Owned by the identity lifecycle, consumed here.
   */
  readonly signingReadiness: SigningReadinessCheck;
  readonly push: RelationPush;
  /** Where a refused intent is recorded. Required, never defaulted. */
  readonly recordPendingIntent: (intent: PendingRelationIntent) => void;
  readonly now?: () => number;
  readonly logger?: RelationProducerLogger;
}

export interface RelationProducer {
  /** Follow `followee`. PUBLIC only; PRIVATE stays local-canonical. */
  declare(followee: string, opts?: { tasteSubscribed?: boolean; house?: string }): Promise<RelationOutcome>;
  revoke(followee: string, opts?: { house?: string }): Promise<RelationOutcome>;
  /**
   * Re-send every stored original that has not been accepted, oldest first.
   * The bytes go out verbatim — the CID is unchanged, so the house's own dedup
   * absorbs a duplicate. This is the restart and timeout path; it never signs.
   *
   * `stillValid`, when given, is the CALLER'S round: checked before each
   * original and again after each push await. A round that died mid-sweep
   * stops (the rest stays queued for the next round), and a push whose ACK
   * arrives after the round died does NOT `markSent` — the receipt cannot
   * close a todo on behalf of a round that no longer exists; the next round
   * re-sends the same bytes and the house's dedup absorbs it.
   */
  resendPending(opts?: { readonly stillValid?: () => boolean }): Promise<readonly RelationResendOutcome[]>;
}

const NOOP_LOGGER: RelationProducerLogger = { info: () => {}, warn: () => {} };

/**
 * Is this stored original the same follow being asked for again?
 *
 * Same verb and same taste-subscription choice. A revoke is not a restatement
 * — an unfollow followed by a follow is genuinely a new statement — and
 * turning taste subscription on is a real change the house records, so
 * neither may be absorbed here.
 *
 * Anything it cannot decode is treated as NOT a restatement. Erring that way
 * signs one extra original; erring the other way would silently drop a follow
 * the owner asked for.
 */
function restatesTheSameFollow(signedPayload: Uint8Array, tasteSubscribed: boolean): boolean {
  try {
    const sp = popclaw.identity.SignedPayload.decode(signedPayload);
    const declared = popclaw.event.EventEnvelope.decode(sp.payload as Uint8Array).followDeclared;
    if (!declared) return false;
    return (declared.tasteSubscribed === true) === tasteSubscribed;
  } catch {
    return false;
  }
}

export function createRelationProducer(deps: RelationProducerDeps): RelationProducer {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const logger = deps.logger ?? NOOP_LOGGER;
  const allocator = new RelationAllocator(deps.db, now);

  /**
   * The keys this edge's originals were signed under **at this house**.
   *
   * Scoped by house, because an edge is `(house, author, target)` and not
   * `(author, target)`. Searching by followee alone turns "the owner
   * deliberately followed this person at a second house" into "someone rotated
   * the key", and refuses a declaration the owner explicitly asked for. The
   * author is implicit: one data root holds one signer.
   */
  function keysAtHouse(houseSlug: string | undefined, followee: string): string[] {
    return deps.db
      .queryAll<{ house_key: string }>(
        'SELECT DISTINCT house_key FROM relation_outbox WHERE followee_popclaw_id = ? AND house_slug IS ?',
        [followee, houseSlug ?? null],
      )
      .map((r) => r.house_key);
  }

  /**
   * Is this edge in ordered mode, on the evidence this end actually holds?
   *
   * Two sources, because ordered history is NOT only history this machine
   * signed. `relation_seq.observed` is raised from author-verified evidence —
   * an original from the owner's other device, verified here — and leaves
   * nothing in this end's outbox. An edge like that is ordered, and offering it
   * the legacy shape is the downgrade the relation contract refuses.
   *
   * `reserved` is deliberately NOT consulted. A bare reservation is a number
   * handed out and then abandoned (a crash between reserve and sign); no
   * original exists at it on any end, so it says nothing about the edge's mode.
   */
  function isOrderedEdge(
    houseKey: string | undefined,
    houseSlug: string | undefined,
    followee: string,
  ): boolean {
    if (keysAtHouse(houseSlug, followee).length > 0) return true;
    if (!houseKey) return false;
    const row = deps.db.queryOne<{ signed: string; observed: string }>(
      'SELECT CAST(signed AS TEXT) AS signed, CAST(observed AS TEXT) AS observed ' +
        'FROM relation_seq WHERE house_key = ? AND followee_popclaw_id = ?',
      [houseKey, followee],
    );
    return !!row && (BigInt(row.signed) > 0n || BigInt(row.observed) > 0n);
  }

  function refuse(
    action: RelationAction,
    followee: string,
    houseSlug: string | undefined,
    reason: RelationRefusalReason,
    detail?: string,
  ): RelationRefusedOutcome {
    const outcome: RelationRefusedOutcome = {
      mode: 'none',
      transport: 'intent_recorded',
      domain: 'unknown',
      action,
      followee,
      ...(houseSlug ? { houseSlug } : {}),
      reason,
      ...(detail ? { detail } : {}),
    };
    // The intent is recorded BEFORE anything else so that a refusal leaves a
    // trace even if the caller drops the outcome on the floor. Nothing about a
    // relation is written here: no ledger row, no projection, no social line.
    deps.recordPendingIntent({
      action,
      followee,
      ...(houseSlug ? { houseSlug } : {}),
      reason,
      ...(detail ? { detail } : {}),
      at: now(),
    });
    logger.warn(`relation-producer: ${action} ${followee} refused — ${reason}`);
    return outcome;
  }

  /**
   * Transport acceptance: a receipt naming THIS event id, and nothing else.
   * What the house then did with it is a separate question this cannot answer.
   */
  async function attempt(
    bytes: Uint8Array,
    houseSlug: string | undefined,
    eventId: string,
  ): Promise<RelationPushFailure | undefined> {
    let receipt: RelationPushReceipt;
    try {
      receipt = await deps.push(bytes, houseSlug);
    } catch (err) {
      return { kind: 'transport', detail: String(err) };
    }
    if (receipt.status < 200 || receipt.status >= 300) {
      return {
        kind: 'refused',
        status: receipt.status,
        ...(receipt.detail ? { detail: receipt.detail } : {}),
      };
    }
    if (receipt.eventId !== eventId) {
      return {
        kind: 'unacknowledged',
        status: receipt.status,
        detail: receipt.eventId
          ? `receipt names ${receipt.eventId}, not ${eventId}`
          : 'receipt carries no event id',
      };
    }
    return undefined;
  }

  /**
   * Write the owner's intent into the local ledger, tagged with the event it
   * records (migration 032).
   *
   * The SQL is here rather than through `FollowEventStore.append` because only
   * this path has an event id to tag the row with, and the tag is what makes
   * the write idempotent — which is what lets the repair below re-run it after
   * a crash without duplicating. `INSERT OR IGNORE` leans on the unique index:
   * re-recording the same original is a no-op, and a legacy row (event_id
   * NULL) is never in the way, because SQLite treats NULLs as distinct.
   *
   * The `signature` column keeps its placeholder. It has carried one since the
   * JSONL days; the canonical bytes live in the signed envelope, and this is
   * not a second copy of the signature.
   */
  function recordIntent(
    on: HostDb,
    args: {
    readonly action: RelationAction;
    readonly followee: string;
    readonly houseSlug: string | undefined;
    readonly tasteSubscribed: boolean;
    readonly timestamp: number;
    readonly eventId: string;
  }): void {
    on.execute(
      `INSERT OR IGNORE INTO follow_events
         (type, followee, follow_type, taste_subscribed, timestamp, signature, house_slug, event_id)
       VALUES (?, ?, 'PUBLIC', ?, ?, '', ?, ?)`,
      [
        args.action === 'declare' ? 'FollowDeclared' : 'FollowRevoked',
        args.followee,
        args.action === 'declare' && args.tasteSubscribed ? 1 : 0,
        args.timestamp,
        args.houseSlug ?? '',
        args.eventId,
      ],
    );
  }

  /**
   * Re-derive a missing ledger row from an original this end already holds.
   *
   * Called on the resend sweep, which is the first thing to run after the
   * restart that lost the write. It decodes OUR OWN stored bytes — no network,
   * no signing, no guessing — and does nothing at all when the row is already
   * there. Deliberately not gated on delivery: the owner's intent is local and
   * true whether or not any house has taken the event yet.
   */
  function repairIntent(push: PendingRelationPush): void {
    // Position, not presence, is what makes this safe. The ledger is projected
    // in insertion order, so a tail append asserts "this is the author's latest
    // word" — and for a lost row with newer rows after it, that is a lie the
    // owner pays for: follow, revoke whose ledger write died, follow, and the
    // repaired revoke lands last and un-follows someone the author is still
    // following.
    //
    // The position comes from the originals themselves. `seq` is where the
    // author put this event in THIS edge's history, so anything at or below
    // what the ledger already records has been superseded and must not be
    // appended. It is never compared against another house's counter: two
    // houses are two unrelated sequences and ordering them would invent a
    // history nobody signed.
    //
    // The read of that water-mark and the write that depends on it are ONE
    // transaction, and they are re-done per original. A value read once at the
    // top of the sweep is stale the moment the sweep awaits a resend: the owner
    // can follow again in that window, and the repaired revoke then appends
    // after their new follow and un-follows them. Nor is a process-local cache
    // any good — two hosts share one data root, so the only boundary that
    // covers both is the database's.
    deps.db.transaction((tx) => {
      const ledgerHigh = ledgerHighWater(tx, push.houseSlug, push.followeePopclawId);
      if (push.seq <= ledgerHigh) return;
      const sp = popclaw.identity.SignedPayload.decode(push.signedPayload);
      const env = popclaw.event.EventEnvelope.decode(sp.payload as Uint8Array);
      const declared = env.followDeclared;
      const revoked = env.followRevoked;
      if (!declared && !revoked) return; // not a relation original; not ours to repair
      recordIntent(tx, {
        action: declared ? 'declare' : 'revoke',
        followee: (declared?.followeePopclawId ?? revoked?.followeePopclawId) as string,
        houseSlug: push.houseSlug,
        tasteSubscribed: declared?.tasteSubscribed === true,
        // The original's own timestamp, so a repaired row says when the owner
        // acted rather than when the repair happened to run.
        timestamp: Number(String(env.timestamp ?? now())),
        eventId: push.eventId,
      });
    });
  }

  /**
   * The highest seq this edge's ledger already accounts for, at this house.
   *
   * Read by joining the ledger's `event_id` back to the originals, so the
   * answer is derived from bytes this end signed rather than from row order or
   * a clock. A row with no `event_id` contributes nothing: it was written by
   * the pre-ordered path, which has no position in an ordered sequence, and
   * guessing one for it would be exactly the invented ordering this avoids.
   */
  function ledgerHighWater(on: HostDb, houseSlug: string | undefined, followee: string): bigint {
    const row = on.queryOne<{ m: string | null }>(
      `SELECT CAST(MAX(o.seq) AS TEXT) AS m
         FROM follow_events f
         JOIN relation_outbox o ON o.event_id = f.event_id
        WHERE o.followee_popclaw_id = ? AND o.house_slug IS ?`,
      [followee, houseSlug ?? null],
    );
    return row?.m ? BigInt(row.m) : 0n;
  }

  async function produce(
    action: RelationAction,
    followee: string,
    tasteSubscribed: boolean,
    house?: string,
  ): Promise<RelationOutcome> {
    // Read-only routing evidence. A lost ledger write cannot turn an existing
    // world declaration into a fresh home declaration. No retry bytes move houses.
    const owner = await deps.signer.popclawId();
    const active = activeRelationHouses(deps.db, followee, owner);
    const activeHouses = active.houses;
    const originalHouse = activeHouses.length === 1 ? activeHouses[0] : undefined;
    const scope = await deps.resolveScope({
      action, followee, activeHouses,
      ...(active.uncertain ? { activeUncertainty: active.uncertain, uncertainHouses: active.uncertainHouses } : {}),
      ...(house !== undefined ? { house } : {}),
      ...(action === 'revoke' && activeHouses.length === 1 ? {
        declaredEdge: { houseSlug: originalHouse, houseKeys: keysAtHouse(originalHouse, followee) },
      } : {}),
    });
    const houseSlug = scope.houseSlug;

    // No edge, or no selected edge: no signed statement and no actionable
    // pending intent. Retained ordered history does not change this answer.
    if (scope.support === 'unproven' &&
        (scope.reason === 'RELATION_NOT_FOLLOWING' || scope.reason === 'HOUSE_SELECTION_REQUIRED')) {
      return { mode: 'none', transport: 'unchanged', domain: 'unknown', action, followee,
        ...(houseSlug ? { houseSlug } : {}), reason: scope.reason, detail: scope.detail };
    }

    if (scope.support === 'unproven' && scope.reason) return refuse(action, followee, houseSlug, scope.reason, scope.detail);

    if (scope.support !== 'supported') {
      // An edge already in ordered mode NEVER degrades to legacy. Whatever the
      // house's answer was, the only honest reply here is a refusal. An
      // `unsupported` or `capability-unknown` answer still carries a verified
      // key, so the observed evidence for that key can be consulted;
      // `unproven` and `unreachable` carry none and are refused below
      // regardless.
      const scopedKey =
        scope.support === 'unsupported' || scope.support === 'capability-unknown'
          ? scope.houseKey
          : undefined;
      if (isOrderedEdge(scopedKey, houseSlug, followee)) {
        return refuse(action, followee, houseSlug, 'ORDERED_EDGE_NEEDS_BINDING', scope.detail);
      }
      // "I could not prove who this house is" and "I could not reach it" are
      // facts about this end's knowledge, not statements that the house lacks
      // the capability. Emitting the legacy shape on either is the downgrade.
      if (scope.support === 'unproven') {
        return refuse(action, followee, houseSlug, scope.reason ?? 'HOUSE_BINDING_UNPROVEN', scope.detail);
      }
      if (scope.support === 'unreachable') {
        return refuse(action, followee, houseSlug, 'HOUSE_UNREACHABLE', scope.detail);
      }
      // An unreadable capability statement is neither support nor its absence.
      // Refused on its own reason; never the legacy shape.
      if (scope.support === 'capability-unknown') {
        return refuse(action, followee, houseSlug, 'HOUSE_CAPABILITY_UNKNOWN', scope.detail);
      }
      // 'unsupported': identity proven, the manifest declares the capability
      // absent. Refused BEFORE signing — signing is what makes the
      // consequences durable, and a seq once spent is spent.
      return refuse(action, followee, houseSlug, 'HOUSE_ORDERED_RELATIONS_UNSUPPORTED', scope.detail);
    }

    // A rotated key is a different namespace, and this edge's history
    // lives in the old one. Switching silently would start a second chain at
    // seq 1 while the house still holds the first.
    //
    // Scoped to THIS house on purpose. A second, independent house the owner
    // deliberately followed someone at is a new edge that legitimately starts
    // its own sequence at 1; it neither disturbs the first house's originals
    // nor authorises re-signing them anywhere else.
    const keysHere = keysAtHouse(houseSlug, followee);
    if (keysHere.length > 0 && !keysHere.includes(scope.houseKey)) {
      return refuse(
        action,
        followee,
        houseSlug,
        'ORDERED_EDGE_HOUSE_KEY_CHANGED',
        `edge at ${houseSlug ?? 'the home house'} was signed under ${keysHere.join(', ')}, ` +
          `scope resolved ${scope.houseKey}`,
      );
    }

    // ② Readiness, asked explicitly — the allocator's silence is not an answer.
    const readiness = deps.signingReadiness(scope.houseKey, followee);
    if (readiness !== 'ready') {
      return refuse(action, followee, houseSlug, 'RELATION_SIGNING_NOT_READY', readiness.blocked);
    }
    // Verified consumer history may be ahead before issuance recovery has
    // recorded its position. It can block new signing, never allocate a seq.
    const applied = deps.db.queryOne<{ seq: string | null }>(
      `SELECT CAST(applied_seq AS TEXT) AS seq FROM relation_edges
       WHERE house_key = ? AND follower_popclaw_id = ? AND followee_popclaw_id = ?`,
      [scope.houseKey, owner, followee],
    );
    const bound = allocator.bound(scope.houseKey, followee);
    if (applied?.seq && BigInt(applied.seq) > bound.signed && BigInt(applied.seq) > bound.observed) {
      return refuse(action, followee, houseSlug, 'RELATION_SIGNING_NOT_READY',
        'verified consumer position is ahead of the issuance record');
    }

    // Saying the same thing again is not a new thing to say.
    //
    // Running `follow` twice used to mint a second numbered statement, and the
    // two are not interchangeable: re-sending the same bytes is absorbed by
    // the house's dedup, while a fresh sequence number is a new fact the
    // followee's machine has to take seriously, a second entry in a social log
    // that records what changed, and a `since` that moves for a relation that
    // did not.
    //
    // It deliberately does NOT suppress. The queue that re-sends unacknowledged
    // originals has no caller in this build, so asking again is currently the
    // owner's ONLY way to retry something that never reached the house —
    // taking that away would turn a duplicate into a dead end. What happens
    // instead is that the ORIGINAL statement is finished: its ledger row
    // repaired if a crash lost it, its bytes re-sent if they never landed.
    //
    // The comparison is against the LATEST original on this edge, not against
    // the projection. An unfollow followed by a follow is genuinely three
    // statements and stays three, because the latest is then a revoke; a
    // follow at a second house is a separate edge and starts at 1.
    if (action === 'declare') {
      const standing = allocator.latestAt(scope.houseKey, followee);
      if (standing && standing.houseSlug !== houseSlug) {
        return refuse(action, followee, houseSlug, 'ORDERED_EDGE_NEEDS_BINDING',
          'stored original has no matching house route; retry and ledger repair stopped');
      }
      if (standing !== undefined && activeHouses.includes(houseSlug) &&
          allocator.bound(scope.houseKey, followee).observed <= standing.seq &&
          restatesTheSameFollow(standing.signedPayload, tasteSubscribed)) {
        // Unconditionally, and before any network work: a house being
        // unreachable is no reason to leave the owner unable to see what they
        // already declared.
        repairIntent(standing);
        const failure = standing.sentAt === null
          ? await attempt(standing.signedPayload, standing.houseSlug, standing.eventId)
          : undefined;
        if (standing.sentAt === null && failure === undefined) allocator.markSent(standing.eventId);
        return {
          mode: 'ordered' as const,
          transport: failure ? ('queued' as const) : ('accepted' as const),
          domain: 'unknown' as const,
          action,
          followee,
          ...(houseSlug ? { houseSlug } : {}),
          houseKey: scope.houseKey,
          eventId: standing.eventId,
          seq: standing.seq,
          anotherEndHasSigned: false,
          // Nothing was signed in this call. The caller needs that to avoid
          // recording a change that did not happen.
          restated: true as const,
        };
      }
    }

    // Then reserve. The allocator's own throw covers the case it CAN see —
    // this end having observed another end signing higher — and is an OUTCOME,
    // not an error to swallow.
    let reserved;
    try {
      reserved = allocator.reserve(scope.houseKey, followee);
    } catch (err) {
      const msg = String(err);
      // Only the allocator's own two verdicts are outcomes. A locked database
      // or a failing disk is a real error, and relabelling it "not ready"
      // would tell the owner a story about their signing history that is not
      // true — and would hide a fault that needs fixing behind a refusal that
      // looks routine.
      const reason: RelationRefusalReason | undefined = msg.includes('RELATION_SEQ_EXHAUSTED')
        ? 'RELATION_SEQ_EXHAUSTED'
        : msg.includes('RELATION_SIGNING_NOT_READY')
          ? 'RELATION_SIGNING_NOT_READY'
          : undefined;
      if (!reason) throw err;
      return refuse(action, followee, houseSlug, reason, msg);
    }

    // ③ Sign, bound to the resolved house.
    const order = { seq: reserved.seq, houseKey: scope.houseKey };
    const signed =
      action === 'declare'
        ? await signFollowDeclared(deps.signer, {
            followee,
            followType: 'PUBLIC',
            tasteSubscribed,
            order,
          })
        : await signFollowRevoked(deps.signer, { followee, followType: 'PUBLIC', order });

    // ④ Durable BEFORE the first network attempt.
    const todo: PendingRelationPush = {
      eventId: signed.eventId,
      houseKey: scope.houseKey,
      followeePopclawId: followee,
      seq: reserved.seq,
      signedPayload: signed.signedPayloadBytes,
      ...(houseSlug ? { houseSlug } : {}),
    };
    try {
      allocator.recordSigned(todo);
    } catch (err) {
      // A different original already holds this position. Nothing goes out:
      // two event ids at one seq is the fork this end is here to prevent.
      // Anything else the write threw is a fault, not a verdict — same reason
      // as the reservation above.
      if (!String(err).includes('RELATION_SEQ_ALREADY_SIGNED')) throw err;
      return refuse(action, followee, houseSlug, 'RELATION_SEQ_ALREADY_SIGNED', String(err));
    }
    recordIntent(deps.db, {
      action,
      followee,
      houseSlug,
      tasteSubscribed,
      timestamp: now(),
      eventId: signed.eventId,
    });

    // ⑤ / ⑥
    const failure = await attempt(signed.signedPayloadBytes, houseSlug, signed.eventId);
    if (!failure) allocator.markSent(signed.eventId);
    else logger.warn(`relation-producer: ${action} ${followee} queued — ${failure.kind}`);
    return {
      mode: 'ordered',
      transport: failure ? 'queued' : 'accepted',
      // A CID echo closes the todo. It says nothing about whether the edge
      // applied, went pending, or landed as a fork branch.
      domain: 'unknown',
      action,
      followee,
      ...(houseSlug ? { houseSlug } : {}),
      houseKey: scope.houseKey,
      eventId: signed.eventId,
      seq: reserved.seq,
      anotherEndHasSigned: reserved.anotherEndHasSigned,
      ...(failure ? { failure } : {}),
    };
  }

  return {
    declare: (followee, opts) => produce('declare', followee, opts?.tasteSubscribed ?? false, opts?.house),
    revoke: (followee, opts) => produce('revoke', followee, false, opts?.house),
    async resendPending(opts: { readonly stillValid?: () => boolean } = {}): Promise<readonly RelationResendOutcome[]> {
      // Before the FIRST DB read: a dead round does not even list the
      // queue, because pending() reads the database too.
      if (opts.stillValid !== undefined && !opts.stillValid()) return [];
      const out: RelationResendOutcome[] = [];
      // `pending()` yields oldest-first within an edge, which for one author is
      // seq order, so several lost rows are restored in the order their author
      // signed them. Each repair re-reads the water-mark inside its own
      // transaction rather than trusting a value from before the last await.
      for (const p of allocator.pending()) {
        // A dead round stops here: everything not yet sent stays queued for
        // the round that is actually current.
        if (opts.stillValid && !opts.stillValid()) break;
        // Repair first, and unconditionally: a house being down is no reason to
        // leave the owner unable to see — or take back — what they declared.
        repairIntent(p);
        const failure = await attempt(p.signedPayload, p.houseSlug, p.eventId);
        if (
          failure === undefined &&
          opts.stillValid !== undefined &&
          !opts.stillValid()
        ) {
          // The push was already in the network — it cannot be recalled — but
          // the ACK belongs to no round now. Do NOT close the todo on it; the
          // next round re-sends the same bytes and the house's dedup absorbs
          // them. Reported as queued, because that is what it is.
          out.push({
            eventId: p.eventId,
            followee: p.followeePopclawId,
            houseKey: p.houseKey,
            seq: p.seq,
            ...(p.houseSlug ? { houseSlug: p.houseSlug } : {}),
            transport: 'queued',
            domain: 'unknown',
          });
          break;
        }
        if (!failure) allocator.markSent(p.eventId);
        out.push({
          eventId: p.eventId,
          followee: p.followeePopclawId,
          houseKey: p.houseKey,
          seq: p.seq,
          ...(p.houseSlug ? { houseSlug: p.houseSlug } : {}),
          transport: failure ? 'queued' : 'accepted',
          domain: 'unknown',
          ...(failure ? { failure } : {}),
        });
      }
      return out;
    },
  };
}
