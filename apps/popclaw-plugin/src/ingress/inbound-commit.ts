/**
 * Who a frame actually came from, and the one place an inbound frame becomes
 * durable.
 *
 * **The trust problem this exists for.** A consumer handed only the envelope
 * can compare `envelope.lorehouse` against `order.house_key` and find them
 * equal — but both are fields the AUTHOR signed, so their agreement says
 * nothing about which house delivered the frame. A legacy original usually has
 * an empty `lorehouse`, which collapses every house into one blank scope. An
 * author's signature proves who wrote the event; which house handed it over,
 * whether that house is trusted, and whether this owner is still participating
 * there are separate questions with separate answers, and they have to be
 * INJECTED by whoever holds the connection rather than read off the payload.
 *
 * **The atomicity problem.** The raw frame, whatever work consumers queue from
 * it, and the transport cursor have to become durable together. Advance the
 * cursor first and a crash loses a frame nobody will send again; queue first
 * and a crash replays work already done. Both failures are silent, which is why
 * there is one entry point and not a convention.
 *
 * **Three layers that share a word.** A house's `incarnation` is its own
 * restore or rebuild. A stream's log epoch is that stream's rebuild. An owner's
 * participation generation is which of the owner's sessions is the live one.
 * None of them can be used as evidence for another, and carrying any of them on
 * a frame records only what the connection believed when it opened. Whether it
 * is STILL true is a question that has to be asked at the commit boundary, in
 * the same transaction as the effects — which is the one thing an injected
 * field cannot do for you.
 */
import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';

/** A source established at connection time, never derived from a frame. */
export interface TrustedSource {
  /** The verified house key of the connection this frame arrived on. */
  readonly houseKey: string;
  /**
   * The house's restore/rebuild generation. Stable across ordinary restarts;
   * a change means the house was rebuilt and its trust path has to be
   * re-resolved before anything new is applied.
   */
  readonly incarnation: string;
  /**
   * The owner's participation generation at this house, as it stood when this
   * connection opened. Checked against the current one at commit time — a frame
   * carrying an older one belongs to a session the owner has since left, so the
   * bytes are kept and the effect is dropped.
   */
  readonly ownerGeneration: number;
  readonly houseSlug?: string;
}

export type SourceTrust = { readonly trusted: TrustedSource } | { readonly untrusted: string };

export interface InboundFrame {
  readonly eventId: string;
  readonly envelopeBytes: Uint8Array;
  readonly source: TrustedSource;
  /** Which logical stream this arrived on — a house serves more than one. */
  readonly stream: 'personal' | 'world';
  /** The transport's own position, when it has one. DM frames carry none. */
  readonly position?: string;
}

/**
 * What a consumer decided about a frame.
 *
 * The shared entry point is what writes the cursor and what records the frame
 * as handled, so it is the one that has to know. A void return meant a
 * consumer that refused a frame on verification or authorisation still had it
 * committed as ordinary received mail — which is the precise thing that must
 * not happen: a frame nothing accepted must not be indistinguishable from one
 * waiting its turn. Reporting the refusal through a side channel does not help,
 * because by then the commit has already decided.
 */
export type EnqueueOutcome =
  | { readonly status: 'accepted' }
  /**
   * Not this consumer's mail. Distinct from acceptance on purpose: a relation
   * consumer handed a DM has not verified it, has not stored it and has not
   * decided anything, and reporting that as success tells the commit point a
   * frame was handled when nobody touched it. Distinct from refusal too — a
   * consumer with nothing to say about a frame must not be able to veto it on
   * behalf of the one it belongs to.
   */
  | { readonly status: 'not-applicable'; readonly reason?: string }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Queue domain work for this frame. Runs INSIDE the commit, so anything it
 * writes lands with the frame and the cursor or not at all.
 *
 * It is handed the transaction, not the database: a consumer that opened its
 * own would be back outside the boundary this function exists to provide.
 */
export type EnqueueWork = (tx: HostDb, frame: InboundFrame) => EnqueueOutcome;

/**
 * What these bytes actually are, before anything is keyed by what they claim.
 *
 * `frame.eventId` arrives from the wire. Storing the bytes under it first and
 * verifying afterwards let a frame of rubbish announce a real original's id,
 * take the row, and keep it: the genuine original arrived later, was accepted,
 * and the stored bytes were still the rubbish. The id is a claim until someone
 * checks the signature and recomputes the CID, so that check happens here,
 * before the first write, and the verdict carries the id it actually proved.
 *
 * The composition root supplies this. It costs a verification the relation
 * consumer then repeats — worth collapsing when the root is written and the
 * verified envelope can be passed down, and not worth a shortcut before then.
 */
export type FrameVerdict =
  | { readonly ok: true; readonly eventId: string }
  | { readonly ok: false; readonly reason: string };
export type VerifyFrame = (frame: InboundFrame) => FrameVerdict;

export interface CommitHandlers {
  readonly verify: VerifyFrame;
  readonly enqueue: EnqueueWork;
}

/**
 * Thrown across a savepoint so a non-acceptance takes its own writes down with
 * it; never escapes this module.
 *
 * It carries the whole outcome, not a reason string. Carrying only the text
 * meant the catch had to guess which kind of non-acceptance it had been — and
 * it guessed by asking whether the string was empty, so a consumer that
 * declined jurisdiction WITH an explanation came back as a refusal, and one
 * that refused without words came back as not-applicable. The verdict is a
 * field; recovering it from prose was never going to hold.
 */
class NotAccepted extends Error {
  constructor(readonly outcome: Exclude<EnqueueOutcome, { status: 'accepted' }>) {
    super(outcome.reason ?? outcome.status);
  }
}

/**
 * Combine the consumers wired at a root into one verdict.
 *
 * Acceptance by anyone wins: a frame one consumer handled was handled. Failing
 * that, a refusal stands — somebody looked and said no. Only when every
 * consumer declined jurisdiction is the frame not applicable, which is its own
 * answer and not a success. The two mechanical alternatives are both wrong: OR
 * over `accepted` lets a chorus of "not mine" report a handled frame, and AND
 * lets the relation consumer veto a perfectly good DM.
 */
export function composeConsumers(consumers: readonly EnqueueWork[]): EnqueueWork {
  return (tx, frame) => {
    const refusals: string[] = [];
    let accepted = false;
    for (const consumer of consumers) {
      // Each consumer in its own savepoint. Rolling back only when the COMBINED
      // verdict is a refusal let a consumer that refused keep its writes as
      // long as some other consumer accepted the frame — one consumer's
      // "no" cancelled by another consumer's "yes", which is not what either
      // of them said. Declining jurisdiction must write nothing either.
      let outcome: EnqueueOutcome;
      try {
        outcome = tx.transaction((inner) => {
          const o = consumer(inner, frame);
          if (o.status !== 'accepted') throw new NotAccepted(o);
          return o;
        });
      } catch (err) {
        if (!(err instanceof NotAccepted)) throw err;
        outcome = err.outcome;
      }
      if (outcome.status === 'accepted') accepted = true;
      else if (outcome.status === 'refused') refusals.push(outcome.reason);
    }
    if (accepted) return { status: 'accepted' };
    if (refusals.length > 0) return { status: 'refused', reason: refusals.join('; ') };
    return { status: 'not-applicable', reason: 'no wired consumer handles this frame' };
  };
}

export interface CommitOptions {
  readonly now?: () => number;
  /**
   * Does `next` come after `prev` on this transport?
   *
   * Optional, and absent by default, because this module cannot answer it: a
   * position is opaque, and the two obvious guesses are both wrong — a JS
   * number loses precision on a large one, and a lexicographic comparison ranks
   * "10" below "9". A transport that knows its own ordering hands it in;
   * otherwise the participation check is what keeps a departed session from
   * writing a stale position, and this makes no comparison at all.
   *
   * **It constrains the CURSOR and nothing else.** It is not a domain admission
   * predicate, and a `false` here does not mean the frame had no effect: the
   * consumer has already been offered it. Dropping every frame whose position
   * is at or below the cursor would throw away late fork evidence and stall
   * pending re-judgement — the transport's idea of "old" and the domain's idea
   * of "already handled" are different questions with different answers.
   *
   * `prev` is `undefined` when there is no stored position yet, and that case
   * is still asked rather than waved through: the first write used to bypass
   * the comparison entirely, so a position the transport could never have
   * issued landed unexamined and every later reconnect resumed from debris.
   */
  readonly advances?: (prev: string | undefined, next: string) => boolean;
}

export interface CommitResult {
  /** Were these bytes new to this installation? */
  readonly firstTime: boolean;
  /** Did this DELIVERY take effect — a different question from the bytes. */
  readonly disposition: 'accepted' | 'refused' | 'not-applicable';
  readonly reason?: string;
}

/**
 * Commit one inbound frame: the bytes, the queued work, and the cursor.
 *
 * Idempotent on `event_id` for the BYTES, because a reconnect re-delivering a
 * frame is normal. It is deliberately not idempotent for the delivery: the same
 * original arriving from a second house, on a second stream, or after the owner
 * logged out and back in, is a separate fact about who was entitled to hand it
 * over, and collapsing those onto the first arrival is how a refusal by one
 * source silently becomes the verdict for every later legitimate one.
 *
 * `firstTime` therefore means "these bytes were new", never "the domain has
 * finished with them": a non-terminal domain state stays re-judgeable, and
 * transport dedup must not swallow it.
 */
export function commitInboundFrame(
  db: HostDb,
  frame: InboundFrame,
  handlers: CommitHandlers,
  opts: CommitOptions = {},
): CommitResult {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return db.transaction((tx) => {
    const at = now();

    // Read once, before anything can write. A frame's own claim about which
    // session it belongs to is checked against this, and NOTHING moves a cursor
    // without it — the quarantine path used to skip straight past the check and
    // let a departed session's rubbish set the position to whatever it liked.
    const participation = tx.queryOne<{ owner_generation: number; active: number }>(
      'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
      [frame.source.houseKey],
    );
    const standing: string | undefined =
      participation === undefined || participation === null
        ? 'no participation is established at this house'
        : participation.active !== 1
          ? 'the owner has left this house; no session is participating'
          : participation.owner_generation !== frame.source.ownerGeneration
            ? `frame belongs to owner generation ${frame.source.ownerGeneration}; ` +
              `the live one is ${participation.owner_generation}`
            : undefined;

    const advanceCursor = (): void => {
      if (frame.position === undefined) return;
      // The guard lives here rather than at each call site, because a path that
      // forgets it is exactly how this went wrong: a session with no standing
      // has none to move a position the live one is reading, whatever the
      // frame turned out to contain.
      if (standing !== undefined) return;
      const prev = tx.queryOne<{ position: string }>(
        'SELECT position FROM stream_cursors WHERE house_key = ? AND stream = ? AND incarnation = ?',
        [frame.source.houseKey, frame.stream, frame.source.incarnation],
      )?.position;
      if (opts.advances !== undefined && !opts.advances(prev, frame.position)) return;
      tx.execute(
        `INSERT INTO stream_cursors (house_key, stream, incarnation, position, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (house_key, stream, incarnation)
         DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
        [frame.source.houseKey, frame.stream, frame.source.incarnation, frame.position, at],
      );
    };

    const quarantine = (reason: string): CommitResult => {
      // Kept, and kept apart. The bytes are evidence about whoever sent them;
      // what they must not get is the identity they claimed. `bytes_sha256` is
      // what they actually are, recorded beside what they said they were, and
      // `position` is where on this connection's stream they arrived — the
      // part of the account that makes the advance below answerable rather
      // than merely convenient.
      //
      // None of this is a verification result. A frame can be refused long
      // before its signature is ever checked (the public-eligibility check
      // runs first), so nothing recorded here may be read as evidence that
      // these bytes were signed by the actor they name.
      tx.execute(
        `INSERT INTO inbound_quarantine
           (claimed_event_id, bytes_sha256, house_key, incarnation, owner_generation,
            stream, reason, envelope, position, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          frame.eventId,
          cidFromCanonical(frame.envelopeBytes),
          frame.source.houseKey,
          frame.source.incarnation,
          frame.source.ownerGeneration,
          frame.stream,
          reason,
          frame.envelopeBytes,
          frame.position ?? null,
          at,
        ],
      );
      // The transport did deliver something; asking for the same bad bytes
      // forever helps nobody, and the frame is on disk either way — WITH the
      // position it arrived at, written above, inside this transaction. An
      // evidence write that fails takes the whole commit down with it, so a
      // position is never moved past a frame nothing kept.
      advanceCursor();
      return { firstTime: false, disposition: 'refused', reason };
    };

    // (1) What these bytes ARE. Nothing keyed by the claimed id is written
    //     until this answers, because until then the id is only a claim.
    const verdict = handlers.verify(frame);
    if (!verdict.ok) return quarantine(verdict.reason);
    if (verdict.eventId !== frame.eventId) {
      return quarantine(
        `frame announced ${frame.eventId} but its contents are ${verdict.eventId}`,
      );
    }

    // (2) The bytes, under the identity they PROVED. Safe as OR IGNORE now that
    //     only verified content reaches it: two frames with this id carry the
    //     same bytes, because the id is a hash of them.
    //
    //     Before the standing check on purpose. A frame from a session that has
    //     since left is still a real original somebody signed — keep the data,
    //     drop the effect.
    const res = tx.execute(
      'INSERT OR IGNORE INTO inbound_frames (event_id, envelope, first_seen_at) VALUES (?, ?, ?)',
      [frame.eventId, frame.envelopeBytes, at],
    );
    const firstTime = res.changes === 1;

    const record = (
      disposition: 'accepted' | 'refused' | 'not-applicable',
      reason?: string,
    ): void => {
      tx.execute(
        `INSERT INTO inbound_deliveries
           (event_id, house_key, incarnation, owner_generation, stream,
            disposition, reason, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, house_key, incarnation, owner_generation, stream)
         DO UPDATE SET disposition = excluded.disposition,
                       reason = excluded.reason,
                       received_at = excluded.received_at`,
        [
          frame.eventId,
          frame.source.houseKey,
          frame.source.incarnation,
          frame.source.ownerGeneration,
          frame.stream,
          disposition,
          reason ?? null,
          at,
        ],
      );
    };

    // (3) The live owner fence.
    //
    // A connection that opened under generation 1 keeps calling back with 1
    // long after the owner logged out and back in as 2 — the callback holds no
    // clock. Without this it could queue work and, worse, rewind the shared
    // cursor to its own old position, so the live session skips everything
    // between. Keeping the generation only in the cursor's key would hide
    // exactly that: the old callback would still write its effects, just into a
    // row of its own.
    //
    // Nothing is deleted for a departed session. Its cursor and every relation
    // it established stay where they are, which is what makes an ordinary
    // logout resumable rather than destructive.
    if (standing !== undefined) {
      record('refused', standing);
      return { firstTime, disposition: 'refused', reason: standing };
    }

    // (4) Queued even on a repeat delivery: whether the domain still has work
    //     is the domain's question, not the transport's. The consumer's own key
    //     makes this idempotent where it needs to be.
    //
    //     Inside its own savepoint, so that a consumer which writes and then
    //     refuses does not leave those writes behind. Returning a refusal has
    //     to mean nothing happened; a convention saying "do not write before
    //     refusing" would be true right up until someone forgot. A real throw
    //     still takes the whole transaction down, which is the other contract
    //     and stays unchanged.
    let outcome: EnqueueOutcome;
    try {
      outcome = tx.transaction((inner) => {
        const o = handlers.enqueue(inner, frame);
        // not-applicable is left alone here: nothing was written to roll back,
        // and the composed consumers have already isolated their own.
        if (o.status === 'refused') throw new NotAccepted(o);
        return o;
      });
    } catch (err) {
      if (!(err instanceof NotAccepted)) throw err;
      outcome = err.outcome;
    }
    record(outcome.status, outcome.status === 'accepted' ? undefined : outcome.reason);

    // (5) The cursor advances on a consumer refusal too, and that is the
    //     deliberate half of this. The transport delivered what it was asked
    //     to; refusing the CONTENT is not a reason to ask for it again forever.
    //     The bytes are kept and the refusal is recorded against this exact
    //     source, so the decision can be revisited from local state rather than
    //     from the wire.
    advanceCursor();

    return outcome.status === 'accepted'
      ? { firstTime, disposition: 'accepted' }
      : { firstTime, disposition: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  });
}

/**
 * Start a session at this house and return the generation it owns.
 *
 * One logical login per house, not one per connection: personal and world are
 * two streams of the same participation, and a second process attaching is not
 * the owner logging in again. Calling this per connection would have each new
 * one invalidate the last.
 */
export function beginParticipation(
  db: HostDb,
  houseKey: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): number {
  return bumpParticipation(db, houseKey, true, now);
}

/**
 * Leave, without forgetting.
 *
 * Two things happen, and they are different. The generation moves forward, so
 * that nothing still in flight matches the live one — logging out has to stop
 * the old session's effects as surely as logging in elsewhere does. And
 * `active` goes false, because a number alone cannot say "nobody is here": the
 * generation after a logout still looked like a live session, so anything that
 * built a connection from it was accepted and advanced cursors at a house the
 * owner had left.
 *
 * It removes nothing. Cursors and relations survive, and logging back in
 * resumes from them.
 */
export function endParticipation(
  db: HostDb,
  houseKey: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): void {
  bumpParticipation(db, houseKey, false, now);
}

function bumpParticipation(
  db: HostDb,
  houseKey: string,
  active: boolean,
  now: () => number,
): number {
  return db.transaction((tx) => bumpParticipationInTx(tx, houseKey, active, now));
}

/**
 * The bump in whatever transaction the caller holds — so an explicit login can
 * make "the trust still stands" and "the participation begins" one commit
 * boundary instead of two writes with a gap between them.
 */
export function bumpParticipationInTx(
  tx: HostDb,
  houseKey: string,
  active: boolean,
  now: () => number,
): number {
  const cur =
    tx.queryOne<{ owner_generation: number }>(
      'SELECT owner_generation FROM relation_participation WHERE house_key = ?',
      [houseKey],
    )?.owner_generation ?? 0;
  const next = cur + 1;
  tx.execute(
    `INSERT INTO relation_participation (house_key, owner_generation, active, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (house_key)
     DO UPDATE SET owner_generation = excluded.owner_generation,
                   active = excluded.active,
                   updated_at = excluded.updated_at`,
    [houseKey, next, active ? 1 : 0, now()],
  );
  return next;
}

/**
 * The participation at this house: which generation, and whether anyone is in
 * it. Undefined means the owner has never been here.
 *
 * Both halves are returned because a caller building an authorisation list
 * needs to tell "left" from "live", and a bare number cannot.
 */
export function currentParticipation(
  db: HostDb,
  houseKey: string,
): { readonly generation: number; readonly active: boolean } | undefined {
  const row = db.queryOne<{ owner_generation: number; active: number }>(
    'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
    [houseKey],
  );
  if (row === null || row === undefined) return undefined;
  return { generation: row.owner_generation, active: row.active === 1 };
}

/**
 * The position to resume from, or undefined to start from the beginning.
 *
 * Keyed by incarnation as well, so a cursor from before a house's restore is
 * not returned for the incarnation after it: resuming there would skip
 * everything the rebuild changed while looking like an ordinary reconnect.
 */
/**
 * The resume write OUTSIDE a frame commit — the snapshot recovery's move, and
 * only its: after a checkpoint has been reconciled page by page, the published
 * watermark is a position this end may adopt as synced (and ONLY
 * then; an incomplete checkpoint adopts nothing).
 *
 * Never moves backwards: if frames kept arriving during the recovery and the
 * local position is already past the watermark, the live read wins. Positions
 * are delivery seqs (numeric strings); if either side does not parse as one
 * the watermark is adopted rather than guessed about.
 */
export function setResumePosition(
  db: HostDb,
  source: Pick<TrustedSource, 'houseKey' | 'incarnation'>,
  stream: 'personal' | 'world',
  position: string,
  at: number,
): void {
  // The candidate is validated ALWAYS — the no-previous-row path used to
  // bypass parsing entirely, letting an unreadable first write land.
  // parseCursor refuses what it cannot read.
  parseCursor(position);
  const prev = resumePosition(db, source, stream);
  if (!housePositionAdvances(prev, position)) return;
  db.execute(
    `INSERT INTO stream_cursors (house_key, stream, incarnation, position, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(house_key, stream, incarnation)
     DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
    [source.houseKey, stream, source.incarnation, position, at],
  );
}

/**
 * Does `next` name a stream position after `prev`? Both are the house's
 * cursor format — strictly `<generation>.<positive seq>` (the server treats
 * anything else, bare numbers included, as unreadable: a cursor that names
 * no generation cannot be compared to one). Parsed with BigInt, never
 * Number: both halves span the i64 range and a JS double quietly rounds
 * them into positions that do not exist.
 *
 * A `next` that does not parse never overwrites — an unreadable position is
 * not an advance, and writing it would break the next reconnect's resume.
 *
 * Exported because this is the answer for EVERY stream a house serves, and
 * the commit boundary cannot know it: `CommitOptions.advances` is optional and
 * absent means no comparison at all, so a root that assembles the relation
 * chain without handing this in lets a frame write a position behind the one
 * it already holds. It is the roots' one job here, and it is this function.
 */
/** The server's i64 domain: a generation or seq that
 *  overflows it names a position no house can ever honour, and BigInt would
 *  happily carry it — bound both halves before anything compares them. */
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

function parseCursor(raw: string): { generation: bigint; seq: bigint } {
  const dot = raw.indexOf('.');
  if (dot <= 0) throw new Error(`unreadable cursor: ${raw}`);
  const g = raw.slice(0, dot);
  const seq = raw.slice(dot + 1);
  if (!/^-?\d+$/u.test(g) || !/^\d+$/u.test(seq)) throw new Error(`unreadable cursor: ${raw}`);
  const generation = BigInt(g);
  const s = BigInt(seq);
  if (s <= 0n || generation < I64_MIN || generation > I64_MAX || s > I64_MAX) {
    throw new Error(`cursor outside the server's i64 domain: ${raw}`);
  }
  return { generation, seq: s };
}

export function housePositionAdvances(prev: string | undefined, next: string): boolean {
  let parsedNext: { generation: bigint; seq: bigint };
  try {
    parsedNext = parseCursor(next);
  } catch {
    return false; // never adopt an unreadable candidate
  }
  // Nothing stored yet: a well-formed candidate is the first position, and an
  // unreadable one was already refused above. This case used to skip the
  // comparison entirely, which is how debris got written in the first place.
  if (prev === undefined) return true;
  // A prev that does not parse is debris (a legacy bare number, a corrupted
  // row) — a WELL-FORMED next replaces it (the old
  // combined catch refused the repair, freezing the debris in place and
  // blocking every future valid write).
  let parsedPrev: { generation: bigint; seq: bigint };
  try {
    parsedPrev = parseCursor(prev);
  } catch {
    return true; // the well-formed next repairs an unreadable prev
  }
  if (parsedNext.generation !== parsedPrev.generation) return parsedNext.generation > parsedPrev.generation;
  return parsedNext.seq > parsedPrev.seq;
}

export function resumePosition(
  db: HostDb,
  source: Pick<TrustedSource, 'houseKey' | 'incarnation'>,
  stream: 'personal' | 'world',
): string | undefined {
  return (
    db.queryOne<{ position: string }>(
      'SELECT position FROM stream_cursors WHERE house_key = ? AND stream = ? AND incarnation = ?',
      [source.houseKey, stream, source.incarnation],
    )?.position ?? undefined
  );
}
