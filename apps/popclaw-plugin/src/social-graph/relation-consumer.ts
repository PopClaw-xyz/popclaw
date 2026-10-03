/**
 * The RECEIVING side of relation events: applies a verified FollowDeclared /
 * FollowRevoked to a local projection. Independent of `runtime/inbox-consumer.ts` (DMs,
 * attachments, red packets, notifications) and of the author-side allocator
 * in `relation-allocator.ts` (SENDING: reserving a seq, signing, pushing) —
 * this module only ever reads what the allocator or another author signed
 * and decides what it means for the edge.
 *
 * The decision order follows the relation contract verbatim:
 *
 *   0. verifyInboundEnvelope — signature, CID, per-type authorization. A
 *      frame that fails this causes NO effect: no table in this module is
 *      touched.
 *   1. order completeness (seq domain, house_key present) and SCOPE: the
 *      author's claimed `order.house_key` must equal the CALLER-SUPPLIED,
 *      independently-verified `TrustedSource.houseKey` — never
 *      `envelope.lorehouse`, which the same author also signs and therefore
 *      proves nothing about which house actually delivered the frame.
 *   2. same event_id already judged on this edge, TERMINALLY → return the
 *      stored verdict, no re-classification (§4.1 step 2).
 *   3. same seq, different event_id already on record for this edge → fork:
 *      mark every event at that seq `fork_branch`, set the edge conflicted,
 *      change nothing else (§1.2 step 3, §4.3: "the last applied effect
 *      stands"). This check runs for a `resolves`-bearing (recovery) event
 *      exactly the same as for an ordinary one — a recovery is a branch
 *      until something covers it.
 *   4. a `resolves`-bearing event is recorded as evidence but never applied:
 *      validity, sufficiency and missing-reference adjudication
 *      have ONE implementation owner elsewhere — but that owner is not the
 *      final judge. This module keeps every original and every attempt
 *      intact so a client-side adjudicator can later verify a recovery from
 *      the author's originals and the same-edge evidence itself, never from
 *      a house's hint or receipt. That adjudicator is not written this
 *      round; this module only refuses to design the room for it away.
 *   5. a legacy (order-absent) event is refused outright whenever ANY prior
 *      event on this edge ever passed order completeness + scope validation
 *      — i.e. relation_event_log has any row with a non-null seq for this
 *      edge, checked directly, never inferred from relation_edges' own
 *      applied_seq / conflicted columns (§6, §7's downgrade path). A
 *      genuinely signed, correctly-scoped `resolves` event lands `pending`
 *      (step 4, above) WITHOUT ever touching relation_edges — no
 *      applied_seq, no conflicted flag — so gating on the edge's own
 *      columns let a legacy event walk straight past evidence the edge
 *      projection had not yet been told about.
 *   6. edge already conflicted → pending(FORK_BLOCKED), no effect — checked
 *      BEFORE magnitude, so a higher seq can never move or un-conflict a
 *      forked edge.
 *   7. seq > applied_seq (or the edge has never applied) → apply; the
 *      previous applied event_id's log row becomes `superseded`. This is
 *      also how a legacy edge adopts ordered mode (§6).
 *   8. seq < applied_seq → stale, recorded `superseded`, not an error.
 *
 * **Commit boundary.** `makeRelationEnqueueWork` produces an `EnqueueWork` —
 * the exact callback shape `ingress/inbound-commit.ts`'s `commitInboundFrame`
 * calls INSIDE its own transaction, which is where the raw frame, whatever a
 * consumer queues, and the transport cursor all become durable together.
 * This module never opens a transaction of its own to receive a frame, and
 * never derives house/incarnation/generation trust from the frame — it
 * takes `frame.source: TrustedSource`, verified and injected by whoever
 * holds the connection.
 *
 * **Dedup, split on purpose (see migration 030).** `relation_frame_originals`
 * is a pure content-addressed store, keyed by event_id ALONE — correct,
 * because the same CID always decodes to the same bytes.
 * `relation_delivery_attempts` is keyed by the FULL
 * (event_id, house_key, incarnation, owner_generation) tuple, so a rejection
 * recorded under one source (a wrong house, a logged-out generation) can
 * never block a legitimate attempt recorded under a different, correct one.
 *
 * **Re-judgement, authorisation and fairness.** `drainRelationAttempts` only
 * marks an attempt `applied_at` on a TERMINAL verdict — a non-terminal one
 * (forked, pending) is left open so a transport's own dedup can never
 * silently swallow a domain state that is not decided yet. It only
 * processes attempts whose recorded (house_key, incarnation, generation) is
 * in the caller's CURRENT authorised list — a house the owner has logged out
 * of, or whose incarnation changed, has its backlog left exactly as
 * recorded: the data stays, the effects stop, and a stale callback from an
 * old connection can never commit an effect after logout. And never-attempted
 * rows (first pass) and already-attempted, still-open rows (re-judge) split
 * the drain budget by ROTATION — which pass gets to claim the FULL budget
 * alternates every call — so under continuous new traffic a permanently
 * non-terminal row is still guaranteed a share at least every other round,
 * not "whatever the other pass happens to leave", which under a small limit
 * and steady new arrivals is reliably zero forever.
 *
 * Hot path discipline: no LLM call, no chat history, no unread state, no
 * waiting on attachments or profile enrichment. Normal follows and unfollows
 * are SILENT here — notification is a later, separate downstream step, not a
 * missing optimisation (the relation contract's last bullet).
 */
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import { verifyInboundEnvelope } from '../ingress/verify-envelope.js';
import { MAX_RELATION_SEQ } from './relation-allocator.js';
import type {
  EnqueueOutcome,
  EnqueueWork,
  InboundFrame,
  TrustedSource,
} from '../ingress/inbound-commit.js';

// The real shapes, now that the ingress boundary is on this branch. The
// placeholder copies this module carried while the two lived apart are gone.
export type {
  EnqueueOutcome,
  EnqueueWork,
  InboundFrame,
  TrustedSource,
} from '../ingress/inbound-commit.js';

export type RelationVerdict = 'applied' | 'superseded' | 'forked' | 'pending' | 'rejected';

export interface RelationFrameOutcome {
  readonly verdict: RelationVerdict;
  readonly reason?: string;
  readonly eventId?: string;
  /** True when this event_id was already terminal — step 2 returned the stored verdict untouched. */
  readonly reused?: boolean;
}

interface EdgeKey {
  readonly houseKey: string;
  readonly follower: string;
  readonly followee: string;
}

interface EdgeRow {
  state: string;
  applied_seq: string | null;
  applied_event_id: string | null;
  conflicted: number;
}

interface LogRow {
  verdict: string;
  seq: string | null;
}

/** Terminal verdicts: never re-classified once recorded, and the only ones that stamp an attempt done. */
const TERMINAL = new Set(['applied', 'superseded', 'rejected']);

const EDGE_SELECT =
  'SELECT state, CAST(applied_seq AS TEXT) AS applied_seq, applied_event_id, conflicted ' +
  'FROM relation_edges WHERE house_key = ? AND follower_popclaw_id = ? AND followee_popclaw_id = ?';

/**
 * A JS `number|Long|null|undefined` from protobufjs, read losslessly. Every
 * Long implementation this repo can end up with (the `long` package, or
 * protobufjs' own minimal polyfill when it is absent) implements
 * `toString()` as the full decimal value — the one thing a `Number` cannot
 * do above 2^53 (see relation-allocator.ts's own comment on the same
 * hazard).
 */
function seqToBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (v !== null && v !== undefined) return BigInt(String(v));
  return 0n;
}

function now(nowFn: (() => number) | undefined): number {
  return nowFn ? nowFn() : Math.floor(Date.now() / 1000);
}

function logEvent(
  tx: HostDb,
  key: EdgeKey,
  eventId: string,
  seq: bigint | null,
  kind: string,
  verdict: string,
  reason: string | undefined,
  ts: number,
): void {
  tx.execute(
    `INSERT INTO relation_event_log
       (house_key, follower_popclaw_id, followee_popclaw_id, event_id, seq, kind, verdict, reason, recorded_at)
     VALUES (?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CAST(? AS INTEGER) END, ?, ?, ?, ?)
     ON CONFLICT (house_key, follower_popclaw_id, followee_popclaw_id, event_id)
     DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, recorded_at = excluded.recorded_at`,
    [
      key.houseKey,
      key.follower,
      key.followee,
      eventId,
      seq === null ? null : seq.toString(),
      seq === null ? null : seq.toString(),
      kind,
      verdict,
      reason ?? null,
      ts,
    ],
  );
}

function retagVerdict(tx: HostDb, key: EdgeKey, eventId: string | null, verdict: string): void {
  if (!eventId) return;
  tx.execute(
    `UPDATE relation_event_log SET verdict = ?
     WHERE house_key = ? AND follower_popclaw_id = ? AND followee_popclaw_id = ? AND event_id = ?`,
    [verdict, key.houseKey, key.follower, key.followee, eventId],
  );
}

function upsertConflicted(tx: HostDb, key: EdgeKey, sourceHouse: TrustedSource, ts: number): void {
  tx.execute(
    `INSERT INTO relation_edges
       (house_key, follower_popclaw_id, followee_popclaw_id, state, applied_seq, applied_event_id, conflicted,
        source_incarnation, source_owner_generation, updated_at)
     VALUES (?, ?, ?, 'unknown', NULL, NULL, 1, ?, ?, ?)
     ON CONFLICT (house_key, follower_popclaw_id, followee_popclaw_id)
     DO UPDATE SET conflicted = 1, source_incarnation = excluded.source_incarnation,
                   source_owner_generation = excluded.source_owner_generation, updated_at = excluded.updated_at`,
    [key.houseKey, key.follower, key.followee, sourceHouse.incarnation, sourceHouse.ownerGeneration, ts],
  );
}

function upsertApplied(
  tx: HostDb,
  key: EdgeKey,
  eventId: string,
  seq: bigint | null,
  state: string,
  sourceHouse: TrustedSource,
  ts: number,
): void {
  tx.execute(
    `INSERT INTO relation_edges
       (house_key, follower_popclaw_id, followee_popclaw_id, state, applied_seq, applied_event_id, conflicted,
        source_incarnation, source_owner_generation, updated_at)
     VALUES (?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CAST(? AS INTEGER) END, ?, 0, ?, ?, ?)
     ON CONFLICT (house_key, follower_popclaw_id, followee_popclaw_id)
     DO UPDATE SET state = excluded.state, applied_seq = excluded.applied_seq,
                   applied_event_id = excluded.applied_event_id, conflicted = 0,
                   source_incarnation = excluded.source_incarnation,
                   source_owner_generation = excluded.source_owner_generation,
                   updated_at = excluded.updated_at`,
    [
      key.houseKey,
      key.follower,
      key.followee,
      state,
      seq === null ? null : seq.toString(),
      seq === null ? null : seq.toString(),
      eventId,
      sourceHouse.incarnation,
      sourceHouse.ownerGeneration,
      ts,
    ],
  );
}

function stateOf(env: popclaw.event.EventEnvelope): string {
  return env.followDeclared ? 'following' : 'revoked';
}

function kindOf(env: popclaw.event.EventEnvelope): string {
  return env.followDeclared ? 'follow_declared' : 'follow_revoked';
}

/**
 * Run the relation contract's decision table for one already-verified relation
 * envelope against the projection. Pure with respect to its `tx` — call it
 * inside a transaction (see `drainRelationAttempts`). `sourceHouse` is the
 * VERIFIED delivery context recorded for THIS specific attempt.
 */
function decide(
  tx: HostDb,
  env: popclaw.event.EventEnvelope,
  ts: number,
  sourceHouse: TrustedSource,
): RelationFrameOutcome {
  const payload = env.followDeclared ?? env.followRevoked;
  const follower = env.actor?.popclawId ?? '';
  const followee = payload?.followeePopclawId ?? '';
  const eventId = env.eventId ?? '';
  const kind = kindOf(env);
  const orderRaw = payload?.order;
  const key: EdgeKey = { houseKey: sourceHouse.houseKey, follower, followee };

  // --- §1.1.1 / §4.1 step 1: order completeness and SCOPE, when present.
  // The scope check is against the VERIFIED sourceHouse, never against
  // envelope.lorehouse. ---
  let seq: bigint | null = null;
  let isRecovery = false;
  if (orderRaw) {
    const orderedSeq = seqToBigInt(orderRaw.seq);
    if (orderedSeq < 1n || orderedSeq > MAX_RELATION_SEQ) {
      logEvent(tx, key, eventId, null, kind, 'rejected', 'ILLEGAL_ORDER_SEQ', ts);
      return { verdict: 'rejected', reason: 'ILLEGAL_ORDER_SEQ', eventId };
    }
    const claimedHouseKey = orderRaw.houseKey ?? '';
    if (!claimedHouseKey) {
      logEvent(tx, key, eventId, null, kind, 'rejected', 'ILLEGAL_ORDER_HOUSE_KEY', ts);
      return { verdict: 'rejected', reason: 'ILLEGAL_ORDER_HOUSE_KEY', eventId };
    }
    if (claimedHouseKey !== sourceHouse.houseKey) {
      // The author's claim disagrees with what was actually verified for
      // this delivery. Not a self-consistency check on the author's own
      // signed fields — a check against an independent, trusted source.
      logEvent(tx, key, eventId, null, kind, 'rejected', 'SCOPE_MISMATCH', ts);
      return { verdict: 'rejected', reason: 'SCOPE_MISMATCH', eventId };
    }
    seq = orderedSeq;
    isRecovery = (orderRaw.resolves?.length ?? 0) > 0;
  }

  // --- §4.1 step 2: identity. A terminal verdict is never re-classified. ---
  const prior = tx.queryOne<LogRow>(
    `SELECT verdict, CAST(seq AS TEXT) AS seq FROM relation_event_log
     WHERE house_key = ? AND follower_popclaw_id = ? AND followee_popclaw_id = ? AND event_id = ?`,
    [key.houseKey, key.follower, key.followee, eventId],
  );
  if (prior && TERMINAL.has(prior.verdict)) {
    return { verdict: prior.verdict as RelationVerdict, reused: true, eventId };
  }

  const edge = tx.queryOne<EdgeRow>(EDGE_SELECT, [key.houseKey, key.follower, key.followee]);

  // --- §1.2 step 1 / §6: order absent = legacy event. Gated on ANY VALID
  // ORDERED EVIDENCE ever logged for this edge — any relation_event_log row
  // with a non-null seq. By construction that column is non-null if AND
  // ONLY IF an event passed order completeness + scope validation above
  // (every reject path before `seq = orderedSeq` logs seq = NULL), so this
  // is independent of relation_edges even having a row yet. Gating on the
  // EDGE's own applied_seq/conflicted columns missed exactly this: a
  // genuinely signed, correctly-scoped `resolves` event lands `pending`
  // without ever calling upsertApplied or upsertConflicted (step 4, below),
  // so applied_seq stays NULL and conflicted stays 0 — a legacy event would
  // then walk straight past known ordered evidence that has not yet
  // produced any relation_edges row at all. ---
  if (seq === null) {
    const orderedEvidence = tx.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM relation_event_log
       WHERE house_key = ? AND follower_popclaw_id = ? AND followee_popclaw_id = ? AND seq IS NOT NULL
       LIMIT 1`,
      [key.houseKey, key.follower, key.followee],
    );
    if (orderedEvidence) {
      // Downgrade path: an old-format event landing on an edge with known
      // ordered evidence. Refused with a distinct, visible reason (§6, §7)
      // — never silently applied, and never silently clearing a fork or a
      // pending recovery that has not resolved yet.
      logEvent(tx, key, eventId, null, kind, 'rejected', 'LEGACY_EVENT_ON_ORDERED_EDGE', ts);
      return { verdict: 'rejected', reason: 'LEGACY_EVENT_ON_ORDERED_EDGE', eventId };
    }
    if (edge?.applied_event_id) retagVerdict(tx, key, edge.applied_event_id, 'superseded');
    upsertApplied(tx, key, eventId, null, stateOf(env), sourceHouse, ts);
    logEvent(tx, key, eventId, null, kind, 'applied', undefined, ts);
    return { verdict: 'applied', eventId };
  }

  // --- §1.2 step 3: sibling/fork test. Runs identically for an ordinary
  // event AND a resolves-bearing (recovery) one — a recovery is a branch
  // until something covers it, and skipping this check for it is exactly
  // how a real fork can go undetected. ---
  const siblings = tx.queryAll<{ event_id: string }>(
    `SELECT event_id FROM relation_event_log
     WHERE house_key = ? AND follower_popclaw_id = ? AND followee_popclaw_id = ? AND seq = CAST(? AS INTEGER)`,
    [key.houseKey, key.follower, key.followee, seq.toString()],
  );
  const sibling = siblings.find((s) => s.event_id !== eventId);
  if (sibling) {
    // A genuine fork: mark this event AND its sibling as fork evidence, and
    // conflict the edge. The edge's current state/applied_seq/
    // applied_event_id are left exactly as they are — "the last applied
    // effect stands" (§4.3) — this is the boundary that step 6 then defends.
    retagVerdict(tx, key, sibling.event_id, 'fork_branch');
    logEvent(tx, key, eventId, seq, kind, 'fork_branch', undefined, ts);
    upsertConflicted(tx, key, sourceHouse, ts);
    return { verdict: 'forked', eventId };
  }

  // --- recovery: evidence recorded and checked for conflict above; its
  // ACTION is never applied here. Validity, sufficiency and missing
  // references have one implementation owner elsewhere — but that
  // owner is not the final judge; a client-side adjudicator must verify a
  // recovery from the author's originals and same-edge evidence itself, not
  // from a house's hint. This module keeps every original and every attempt
  // intact so that adjudicator CAN be built; it does not compute the
  // verdict itself. ---
  if (isRecovery) {
    logEvent(tx, key, eventId, seq, kind, 'pending', 'UNSUPPORTED_RECOVERY', ts);
    return { verdict: 'pending', reason: 'UNSUPPORTED_RECOVERY', eventId };
  }

  // --- §1.2 step 4 (table position 6): an already-conflicted edge blocks
  // an ordinary event, BEFORE magnitude gets a chance to apply or
  // un-conflict it. ---
  if (edge?.conflicted) {
    logEvent(tx, key, eventId, seq, kind, 'pending', 'FORK_BLOCKED', ts);
    return { verdict: 'pending', reason: 'FORK_BLOCKED', eventId };
  }

  const appliedSeq = edge?.applied_seq !== null && edge?.applied_seq !== undefined ? BigInt(edge.applied_seq) : null;

  // --- §1.2 step 5 (table position 7): apply (also how a legacy edge
  // adopts ordered mode). ---
  if (appliedSeq === null || seq > appliedSeq) {
    if (edge?.applied_event_id) retagVerdict(tx, key, edge.applied_event_id, 'superseded');
    upsertApplied(tx, key, eventId, seq, stateOf(env), sourceHouse, ts);
    logEvent(tx, key, eventId, seq, kind, 'applied', undefined, ts);
    return { verdict: 'applied', eventId };
  }

  // --- §1.2 step 6 (table position 8): stale, not an error. ---
  logEvent(tx, key, eventId, seq, kind, 'superseded', 'STALE', ts);
  return { verdict: 'superseded', reason: 'STALE', eventId };
}

/**
 * Store the verified original (content-addressed, once per event_id) and
 * this specific (event, source) delivery attempt (once per source tuple).
 * Both inserts are OR IGNORE: re-delivery of the identical frame from the
 * SAME source is idempotent, and a genuinely different source for the same
 * event_id gets its OWN attempt row rather than being swallowed by the
 * first source that happened to deliver it (P1, migration 030).
 */
function writeAttempt(
  tx: HostDb,
  env: popclaw.event.EventEnvelope,
  envelopeBytes: Uint8Array,
  source: TrustedSource,
  position: string | undefined,
  ts: number,
): void {
  const payload = env.followDeclared ?? env.followRevoked;
  tx.execute(
    `INSERT OR IGNORE INTO relation_frame_originals
       (event_id, kind, follower_popclaw_id, followee_popclaw_id, envelope_bytes, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [env.eventId ?? '', kindOf(env), env.actor?.popclawId ?? '', payload?.followeePopclawId ?? '', envelopeBytes, ts],
  );
  tx.execute(
    `INSERT OR IGNORE INTO relation_delivery_attempts
       (event_id, house_key, source_incarnation, source_owner_generation, delivery_position, enqueued_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [env.eventId ?? '', source.houseKey, source.incarnation, source.ownerGeneration, position ?? null, ts],
  );
}

export interface RelationConsumerDeps {
  /** Threaded into verifyInboundEnvelope; see that module's EnvelopeTrust. */
  readonly recipientPopclawId: string;
  readonly nowFn?: () => number;
  /**
   * Observability. The refusal itself now travels in the return value, where
   * the commit point can act on it — a side channel could only tell a caller
   * what had already been committed. This stays for logging, and is called
   * synchronously, inside the same transaction, before returning.
   */
  readonly onRefused?: (frame: InboundFrame, reason: string) => void;
}

/**
 * Build the `EnqueueWork` this module hands to `commitInboundFrame` (or
 * whatever composition root wires the two together) — host-agnostic on
 * purpose (a feature wired into the
 * gateway only and stayed invisible on MCP hosts): the same function is
 * usable from `index.ts` and `mcp.ts` alike.
 *
 * Verifies BEFORE any effect: `verifyInboundEnvelope` runs first, and on
 * failure nothing in this module is written — not `relation_frame_originals`,
 * not `relation_delivery_attempts`. The refusal goes back to the commit point
 * in the return value, so the frame is not recorded as ordinary received mail;
 * `deps.onRefused` is now observability on top of that, not the only signal.
 */
export function makeRelationEnqueueWork(deps: RelationConsumerDeps): EnqueueWork {
  return (tx, frame): EnqueueOutcome => {
    // Relations ride the personal stream only. Silence about somebody
    // else's mail is neither acceptance nor refusal of it: this consumer has
    // not verified it, has not stored it and has not decided anything. Saying
    // "accepted" would tell the commit point a frame was handled when nobody
    // touched it; saying "refused" would let this consumer veto a DM on behalf
    // of the one it belongs to. `composeConsumers` turns the set of answers
    // into one verdict.
    if (frame.stream !== 'personal')
      return { status: 'not-applicable', reason: 'not the personal stream' };
    let env: popclaw.event.EventEnvelope;
    try {
      env = verifyInboundEnvelope(frame.envelopeBytes, {
        recipientPopclawId: deps.recipientPopclawId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.onRefused?.(frame, reason);
      return { status: 'refused', reason };
    }
    if (!env.followDeclared && !env.followRevoked) {
      // Not a relation event — and with the DM consumer riding the same
      // composition, that is JURISDICTION, not a verdict: a DM on the
      // personal stream is the DM consumer's to accept, and refusing it here
      // would let this consumer veto somebody else's mail. The envelope's
      // own auth and shape refusals above stay exactly as they were — only
      // the "not mine" answer changes from a refusal to a decline.
      return { status: 'not-applicable', reason: 'not a relation event' };
    }
    writeAttempt(tx, env, frame.envelopeBytes, frame.source, frame.position, now(deps.nowFn));
    return { status: 'accepted' };
  };
}

interface AttemptRow {
  event_id: string;
  house_key: string;
  source_incarnation: string;
  source_owner_generation: number;
  attempt_rowid: number;
}

/**
 * Drain pending `relation_delivery_attempts`, running the decision table
 * (`decide`) on each and advancing the PER-HOUSE `relation_applied_watermark`
 * as it goes.
 *
 * `authorisedSources` gates which rows may produce an effect: an attempt is
 * only eligible when its recorded (house_key, incarnation, owner_generation)
 * matches one of the CURRENTLY authorised entries. A house the owner has
 * logged out of, or whose incarnation has since changed, has its backlog
 * left exactly as recorded — the data stays, the effects stop.
 *
 * Fairness (P2, third round): a first pass over never-attempted rows and a
 * re-judge pass over already-attempted, still-open rows SHARE the budget by
 * ROTATION, not by "whoever goes first gets what it wants and the other
 * gets the leftovers". Under continuous new traffic and a small limit, a
 * fixed "first pass always goes first" order gives the re-judge pass
 * leftover budget that is permanently zero — a permanently non-terminal row
 * would then never be reconsidered at all, no matter how many rounds run.
 * `relation_drain_state.favor_retry` flips after every call, so which pass
 * gets to claim the FULL budget alternates: across any two consecutive
 * calls, each pass is guaranteed to have gone first — and so guaranteed a
 * share — at least once. The re-judge pass orders by `attempt_seq`, a
 * strictly increasing counter assigned once per attempt, not by
 * `last_attempted_at`: two attempts processed inside the same wall-clock
 * second tie there, and breaking a tie on rowid alone is a fixed
 * preference, not a rotation.
 *
 * Only a TERMINAL verdict (applied/superseded/rejected) stamps
 * `applied_at`. A non-terminal one (forked, pending) is left open on
 * purpose — this module does not itself decide WHEN a forked or pending
 * event becomes decidable; it only guarantees the evidence and the open
 * state survive to be reconsidered, including simply being re-examined on a
 * later call to this same function.
 */
export interface DrainRelationDeps {
  /**
   * The read-model bridge: called
   * INSIDE the apply transaction when a verified edge whose FOLLOWEE is the
   * owner lands — a signed Follow adds the follower to the owner-facing
   * caches, a signed Unfollow removes them. One row at a time, no reconcile
   * semantics, no notification: the existing silence/L2 policies stay
   * exactly where they are.
   */
  readonly onOwnerDirectedEdge?: (
    edge: { readonly houseKey: string; readonly follower: string; readonly following: boolean },
  ) => void;
  /** The owner's popclaw_id — gates the bridge to FOLLOWEE-is-me edges. */
  readonly recipientPopclawId?: string;
}

export function drainRelationAttempts(
  db: HostDb,
  authorisedSources: readonly TrustedSource[],
  nowFn?: () => number,
  limit = 500,
  deps: DrainRelationDeps = {},
): RelationFrameOutcome[] {
  if (authorisedSources.length === 0) return [];
  const where = authorisedSources
    .map(() => '(house_key = ? AND source_incarnation = ? AND source_owner_generation = ?)')
    .join(' OR ');
  const params = authorisedSources.flatMap((s) => [s.houseKey, s.incarnation, s.ownerGeneration]);

  const queryFirstPass = (take: number): AttemptRow[] =>
    take <= 0
      ? []
      : db.queryAll<AttemptRow>(
          `SELECT rowid AS attempt_rowid, event_id, house_key, source_incarnation, source_owner_generation
           FROM relation_delivery_attempts
           WHERE applied_at IS NULL AND attempt_seq IS NULL AND (${where})
           ORDER BY rowid LIMIT ?`,
          [...params, take],
        );
  const queryRetryPass = (take: number): AttemptRow[] =>
    take <= 0
      ? []
      : db.queryAll<AttemptRow>(
          `SELECT rowid AS attempt_rowid, event_id, house_key, source_incarnation, source_owner_generation
           FROM relation_delivery_attempts
           WHERE applied_at IS NULL AND attempt_seq IS NOT NULL AND (${where})
           ORDER BY attempt_seq ASC LIMIT ?`,
          [...params, take],
        );

  const drainState = db.queryOne<{ favor_retry: number }>(
    'SELECT favor_retry FROM relation_drain_state WHERE singleton = 1',
  );
  const favorRetry = !!drainState?.favor_retry;

  let firstPass: AttemptRow[];
  let retryPass: AttemptRow[];
  if (favorRetry) {
    retryPass = queryRetryPass(limit);
    firstPass = queryFirstPass(limit - retryPass.length);
  } else {
    firstPass = queryFirstPass(limit);
    retryPass = queryRetryPass(limit - firstPass.length);
  }

  const outcomes: RelationFrameOutcome[] = [];
  for (const row of [...firstPass, ...retryPass]) {
    const ts = now(nowFn);
    const original = db.queryOne<{ envelope_bytes: Uint8Array }>(
      'SELECT envelope_bytes FROM relation_frame_originals WHERE event_id = ?',
      [row.event_id],
    );
    if (!original) continue; // FK guarantees this cannot happen; defensive only
    const sourceHouse: TrustedSource = {
      houseKey: row.house_key,
      incarnation: row.source_incarnation,
      ownerGeneration: row.source_owner_generation,
    };
    const outcome = db.transaction((tx) => {
      // Bytes were already verified once in makeRelationEnqueueWork;
      // re-decoding here (rather than re-verifying) is safe because these
      // bytes are our own durable copy, never re-received from the network
      // between the two steps.
      const env = popclaw.event.EventEnvelope.decode(original.envelope_bytes);
      const result = decide(tx, env, ts, sourceHouse);
      // The bridge rides the SAME transaction as the apply: a follower the
      // caches gained but the edge did not (or vice versa) cannot happen.
      if (
        deps.onOwnerDirectedEdge !== undefined &&
        deps.recipientPopclawId !== undefined &&
        result.verdict === 'applied' &&
        (env.followDeclared ?? env.followRevoked)?.followeePopclawId === deps.recipientPopclawId
      ) {
        deps.onOwnerDirectedEdge({
          houseKey: sourceHouse.houseKey,
          follower: env.actor?.popclawId ?? '',
          // protobufjs yields null (not undefined) for an unset message
          // field — a `!== undefined` check read every revoke as a follow.
          following: env.followDeclared != null,
        });
      }

      const seqRow = tx.queryOne<{ next_attempt_seq: number }>(
        'SELECT next_attempt_seq FROM relation_drain_state WHERE singleton = 1',
      );
      const attemptSeq = seqRow?.next_attempt_seq ?? 1;
      tx.execute('UPDATE relation_drain_state SET next_attempt_seq = ? WHERE singleton = 1', [attemptSeq + 1]);

      tx.execute(
        `UPDATE relation_delivery_attempts SET last_attempted_at = ?, attempt_seq = ?
         WHERE event_id = ? AND house_key = ? AND source_incarnation = ? AND source_owner_generation = ?`,
        [ts, attemptSeq, row.event_id, row.house_key, row.source_incarnation, row.source_owner_generation],
      );
      if (TERMINAL.has(result.verdict)) {
        tx.execute(
          `UPDATE relation_delivery_attempts SET applied_at = ?
           WHERE event_id = ? AND house_key = ? AND source_incarnation = ? AND source_owner_generation = ?`,
          [ts, row.event_id, row.house_key, row.source_incarnation, row.source_owner_generation],
        );
      }
      tx.execute(
        `INSERT INTO relation_applied_watermark (house_key, last_attempt_rowid) VALUES (?, ?)
         ON CONFLICT (house_key) DO UPDATE SET last_attempt_rowid = excluded.last_attempt_rowid`,
        [row.house_key, row.attempt_rowid],
      );
      return result;
    });
    outcomes.push(outcome);
  }

  // Flip which pass goes first NEXT call — see the function doc for why
  // this alone is what makes the share a rotation rather than a fixed
  // priority (in either direction).
  db.execute('UPDATE relation_drain_state SET favor_retry = ? WHERE singleton = 1', [favorRetry ? 0 : 1]);

  return outcomes;
}
