/**
 * One place where the relation pieces become a working whole.
 *
 * Everything under `social-graph/` and `ingress/inbound-commit.ts` has been
 * host-agnostic and, until now, unreachable: verification, the commit
 * boundary, participation, the consumer, the drain and the producer all
 * existed and nothing called any of them. This is the assembly, and it is
 * deliberately not a root — `index.ts`, `mcp.ts` and `main.ts` each attach it,
 * so a capability cannot end up wired into the gateway and invisible on MCP
 * hosts — which is exactly how a capability goes missing on a host.
 *
 * **The one thing a root may not do is name its own source.** A root says
 * "this frame arrived on my live connection to house H"; the house key,
 * incarnation and participation generation are then read from the session this
 * module opened, never taken from the caller and never from the frame. That is
 * the whole reason the source is trustworthy: it is established at connection
 * time by whoever holds the connection, and everything downstream — the
 * consumer's scope check, the delivery ledger, the cursor — is keyed by it.
 *
 * **What a session is.** One logical login per house, covering every stream
 * that house serves. Reconnecting is not a new login, and a second process
 * attaching is not the owner logging in again — both would otherwise bump the
 * participation generation and invalidate the session already running.
 */
import {
  commitInboundFrame,
  composeConsumers,
  beginParticipation,
  endParticipation,
  currentParticipation,
  resumePosition,
  type CommitResult,
  type EnqueueWork,
  type FrameVerdict,
  type InboundFrame,
  type TrustedSource,
} from '../ingress/inbound-commit.js';
import { verifyInboundEnvelope } from '../ingress/verify-envelope.js';
import type { HostDb } from '../host/host-db.js';
import { drainRelationAttempts, makeRelationEnqueueWork } from './relation-consumer.js';
import { drainDmTodos, makeDmEnqueueWork } from '../messaging/dm-inbound-queue.js';
import type { RelationFrameOutcome } from './relation-consumer.js';
import { RelationAllocator } from './relation-allocator.js';
import { makeSigningReadiness } from './signing-readiness.js';

/** What a root knows when it opens a connection, and cannot know before. */
export interface RelationSession {
  readonly houseKey: string;
  /** The house's restore/rebuild generation, from its handshake. */
  readonly incarnation: string;
  readonly houseSlug?: string;
}

/** One frame off the wire. No source: that is not the root's to assert. */
export interface InboundRelationFrame {
  readonly stream: 'personal' | 'world';
  readonly envelopeBytes: Uint8Array;
  /** The id the frame announces. Checked against the bytes, never trusted. */
  readonly eventId: string;
  /** The transport's own position, when it has one. */
  readonly position?: string;
}

export interface RelationWiringDeps {
  readonly db: HostDb;
  /** Whose mail this is. Threaded into verification. */
  readonly recipientPopclawId: string;
  readonly now?: () => number;
  /**
   * Consumers other than relations — world feed, and whatever else a root
   * wires. The composed verdict is what decides the frame's disposition, so
   * a root that wires only relations will see everything else come back
   * `not-applicable`, which is the honest answer rather than a silent
   * success.
   */
  readonly otherConsumers?: readonly EnqueueWork[];
  /**
   * The DM slow-work processor: called by `drain`, outside any transaction,
   * with the raw envelope bytes of a durably queued DM. Supplying it wires
   * the DM enqueue consumer into the same boundary as relations — one
   * cursor, one fence, no bypass — and makes each `drain` also do the
   * pending DM work for the live sessions. Absent, DMs stay queued and a
   * root keeps whatever transport-level handling it had.
   */
  readonly processDm?: (
    envelopeBytes: Uint8Array,
    source: TrustedSource,
    commit: (fn: (tx: HostDb) => unknown) => { committed: boolean; value?: unknown },
  ) => void;
  /**
   * The read-model bridge for OWNER-directed verified edges, threaded to
   * drainRelationAttempts. Wired by relation-host (which owns the
   * houseKey→slug map and the KnownFollowersStore); absent = no bridge
   * (tests, embedded callers).
   */
  readonly relationReadBridge?: Parameters<typeof drainRelationAttempts>[4];
  /**
   * Does `next` come after `prev` on this transport? Supplied per root because
   * only the transport knows; absent, no comparison is made at all. It
   * constrains the cursor and nothing else — see `CommitOptions.advances`.
   *
   * Every root that receives frames hands in `housePositionAdvances`: the
   * streams this wiring consumes are a house's own, and their positions are
   * its `<log_generation>.<seq>` cursor format.
   */
  readonly advances?: (prev: string | undefined, next: string) => boolean;
  readonly onRefused?: (reason: string) => void;
  /**
   * Who counts as official AT THIS SOURCE HOUSE, for payloads that confer house
   * authority on a public stream.
   *
   * Per source, never the union of mounted houses: a house being official
   * somewhere else says nothing about what it may assert here. Absent, nothing
   * is official and every house-authority payload on the world stream is
   * refused — which is the right default for a root that has not wired its
   * handshake through yet.
   */
  readonly officialActorsFor?: (source: TrustedSource) => (actorId: string) => boolean;
}

/**
 * One connection's session, fixed at the moment it was opened.
 *
 * The source is a property of the handle, not something looked up by house key
 * when a frame arrives. That distinction is the whole point: a callback still
 * holding a connection from before a logout kept working if the source was
 * fetched fresh, because it would be handed whatever session is current now —
 * so an old connection's frames were committed under a generation that had
 * nothing to do with them. A handle carries the generation it was born with,
 * and the commit boundary refuses it once that generation is no longer live.
 */
export interface RelationSessionHandle {
  /** Fixed at creation. Never re-read, never replaced. */
  readonly source: TrustedSource;
  /** Commit one frame that arrived on THIS connection. */
  receive(frame: InboundRelationFrame): CommitResult;
  /** Where to resume this house's stream from, if anywhere. */
  resumeFrom(stream: 'personal' | 'world'): string | undefined;
  /**
   * The owner is leaving this house. Moves the participation forward and marks
   * it inactive, which stops every session in flight — including this one.
   * Cursors and relations stay; leaving is not forgetting.
   */
  leave(): void;
  /**
   * This connection is closing, and that is all. Participation is untouched:
   * another process on the same data root may still be attached, and a
   * reconnect is not a logout.
   */
  detach(): void;
}

export interface RelationWiring {
  /**
   * The one database this wiring was created on. An explicit add's
   * activation and the handle built from it must land on the same db —
   * exposing it lets an assembly refuse the cross-db splice (activate on one
   * data root, connect on another) instead of trusting the caller.
   */
  readonly db: HostDb;
  /**
   * The owner logging in at this house. Moves the participation forward, which
   * invalidates any session still in flight from before.
   *
   * This is the explicit act. It is NOT what a reconnect does, and not what a
   * second process attaching does — either of those calling this would knock
   * the other one out, which is how one data root with two hosts ends up
   * unable to keep a single stream alive.
   */
  login(session: RelationSession): RelationSessionHandle;
  /**
   * An ordinary connection joining the participation that is already live.
   *
   * A reconnect, a second MCP process, the gateway and the CLI on one data
   * root: all of these attach. Nothing moves, so nobody is knocked out. There
   * has to be something to attach TO — if the owner has not logged in here, or
   * has logged out, this returns undefined rather than quietly logging them
   * back in.
   */
  attach(session: RelationSession): RelationSessionHandle | undefined;
  /**
   * A handle pinned to a generation an explicit activation just wrote.
   *
   * The generation is handed in, never re-read: an explicit add that just
   * committed its own activation uses THIS number, and if the world has
   * already moved past it — another login superseded ours in the instant
   * between the commit and the connection — there is no handle to hand out
   * rather than one that borrows the newer session's standing. Callers that
   * merely want "whatever is live" use `attach`; this is for the one act that
   * knows which generation it created.
   */
  handleAt(session: RelationSession, ownerGeneration: number): RelationSessionHandle | undefined;
  /** The sessions this process holds that are still the live participation. */
  liveSources(): readonly TrustedSource[];
  /**
   * Judge what has been queued, for every house this process is connected to.
   *
   * One drain over the whole authorised set rather than one per house: the
   * consumer's fairness rotation is a single piece of state, so splitting the
   * drain by house would let whichever house was called first keep taking the
   * first pass. Rotation domain and authorisation domain are the same domain.
   */
  drain(limit?: number): RelationFrameOutcome[];
}

export function createRelationWiring(deps: RelationWiringDeps): RelationWiring {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  // The handles this PROCESS holds. Participation lives in the database and is
  // shared; which connections are open, and under which incarnation, is not.
  const handles = new Set<RelationSessionHandle>();

  const enqueue = composeConsumers([
    makeRelationEnqueueWork({
      recipientPopclawId: deps.recipientPopclawId,
      nowFn: now,
      ...(deps.onRefused ? { onRefused: (_f, reason) => deps.onRefused?.(reason) } : {}),
    }),
    // The DM consumer rides the same boundary whenever there is slow work to
    // hand it to — absent processDm, it still declines non-DM frames, so a
    // wiring without it behaves exactly as before.
    ...(deps.processDm
      ? [makeDmEnqueueWork({ recipientPopclawId: deps.recipientPopclawId, now })]
      : []),
    ...(deps.otherConsumers ?? []),
  ]);

  /**
   * Verification, with the context the STREAM calls for.
   *
   * The personal inbox carries the owner's mail: a DM addressed to them, or a
   * relation naming them — and `verifyInboundEnvelope` enforces exactly that
   * when it is given a recipient, refusing anything else as
   * `INBOX_PAYLOAD_MISMATCH`. Applying the same context to the world stream
   * would refuse every ordinary public post, which is the one thing that
   * stream is for.
   *
   * But a world frame is not "no context". It is the PUBLIC one, and dropping
   * the recipient without putting that in its place left the public surface
   * unchecked: a properly signed PRIVATE post, or a conditional audience, went
   * straight through to a world consumer. `publicStream` is what refuses those,
   * and `isOfficialActor` is what decides whether a payload claiming house
   * authority may claim it HERE — scoped to this source, because a house being
   * official somewhere else says nothing about what it may assert at this one.
   *
   * A DM is refused either way: it needs a recipient to be verified against at
   * all, and the public surface refuses it outright besides. That belt and
   * braces is the verifier's, not a second guard added here.
   *
   * Either way this is the real verification — a successful return has already
   * recomputed the CID over the canonical bytes and compared it with the id
   * inside the envelope, so the id it yields is proved by the bytes.
   */
  const verify = (frame: InboundFrame): FrameVerdict => {
    try {
      const env = verifyInboundEnvelope(
        frame.envelopeBytes,
        frame.stream === 'personal'
          ? { recipientPopclawId: deps.recipientPopclawId }
          : {
              publicStream: true,
              // Nothing is official until a root says who is. Refusing a
              // house-authority payload is the safe half of not knowing.
              isOfficialActor: deps.officialActorsFor?.(frame.source) ?? (() => false),
            },
      );
      if (!env.eventId) return { ok: false, reason: 'envelope carries no event id' };
      return { ok: true, eventId: env.eventId };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  const makeHandle = (source: TrustedSource): RelationSessionHandle => {
    // Closing a connection has to stop the closure, not just forget it. Taking
    // the handle out of the set left `receive` perfectly usable: a detached
    // connection still committed frames and still moved the cursor, because
    // nothing it captured had changed.
    let closed = false;
    const handle: RelationSessionHandle = {
      source,
      receive(frame) {
        if (closed) {
          return {
            firstTime: false,
            disposition: 'refused',
            reason: `this connection to ${source.houseKey} is closed`,
          };
        }
        const inbound: InboundFrame = {
          eventId: frame.eventId,
          envelopeBytes: frame.envelopeBytes,
          // The handle's own source, not a lookup. An old connection cannot
          // borrow the standing of a newer one.
          source,
          stream: frame.stream,
          ...(frame.position !== undefined ? { position: frame.position } : {}),
        };
        return commitInboundFrame(
          deps.db,
          inbound,
          { verify, enqueue },
          { now, ...(deps.advances ? { advances: deps.advances } : {}) },
        );
      },
      resumeFrom: (stream) => resumePosition(deps.db, source, stream),
      leave() {
        // Only the session that is still live may end it. An unconditional
        // logout let a handle from a session that had already been replaced
        // log out the one that replaced it: old.login → old.leave →
        // fresh.login → old.leave, and `fresh` was refused as "the owner has
        // left". Idempotent for the same reason — leaving twice is one
        // departure, not two.
        closed = true;
        handles.delete(handle);
        deps.db.transaction((tx) => {
          const current = tx.queryOne<{ owner_generation: number; active: number }>(
            'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
            [source.houseKey],
          );
          if (current?.active !== 1 || current.owner_generation !== source.ownerGeneration) return;
          endParticipation(tx, source.houseKey, now);
        });
      },
      detach() {
        closed = true;
        handles.delete(handle);
      },
    };
    handles.add(handle);
    return handle;
  };

  const sourceFor = (session: RelationSession, ownerGeneration: number): TrustedSource => ({
    houseKey: session.houseKey,
    incarnation: session.incarnation,
    ownerGeneration,
    ...(session.houseSlug !== undefined ? { houseSlug: session.houseSlug } : {}),
  });

  return {
    db: deps.db,
    login(session) {
      return makeHandle(sourceFor(session, beginParticipation(deps.db, session.houseKey, now)));
    },

    attach(session) {
      const current = currentParticipation(deps.db, session.houseKey);
      if (current === undefined || !current.active) return undefined;
      return makeHandle(sourceFor(session, current.generation));
    },

    handleAt(session, ownerGeneration) {
      const current = currentParticipation(deps.db, session.houseKey);
      if (current === undefined || !current.active || current.generation !== ownerGeneration) {
        return undefined;
      }
      return makeHandle(sourceFor(session, ownerGeneration));
    },

    liveSources() {
      // Cross-checked against the database rather than trusted from the set: a
      // session this process opened may have been superseded by a login
      // elsewhere, and a backlog must not take effect under a generation that
      // is no longer the live one.
      return [...handles]
        .map((h) => h.source)
        .filter((s) => {
          const current = currentParticipation(deps.db, s.houseKey);
          return current?.active === true && current.generation === s.ownerGeneration;
        });
    },

    drain(limit) {
      const live = this.liveSources();
      const relations = drainRelationAttempts(deps.db, live, now, limit, deps.relationReadBridge);
      if (deps.processDm !== undefined) drainDmTodos(deps.db, live, deps.processDm, limit, now);
      return relations;
    },
  };
}

/**
 * The signing gate, assembled the one correct way.
 *
 * Exported so no root has to know that the gate needs both the allocator and
 * the database — the database because the identity round is read from it
 * rather than asserted by a caller, and a caller asserting its own origin is
 * exactly the case this gate exists to survive.
 */
export function relationSigningReadiness(
  db: HostDb,
  now: () => number = () => Math.floor(Date.now() / 1000),
): (houseKey: string, followee: string) => ReturnType<ReturnType<typeof makeSigningReadiness>> {
  return makeSigningReadiness({ allocator: new RelationAllocator(db, now), db });
}
