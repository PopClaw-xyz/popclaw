/**
 * Owns the complete per-House reception lifecycle. The host supplies the
 * clock (maintain), transport serials and synchronous departure effects;
 * this registry never schedules, opens a transport or drains business work.
 *
 * Active attachments, requested origins, held debt and historical aliases
 * have different lifetimes. In particular, explicit leave ends participation
 * but retains origin/alias/retry metadata; observed invalidation removes the
 * active origin without manufacturing another durable logout.
 */
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import { reauthBackoffMs, type InboxCursorReset } from '../messaging/inbox-stream-client.js';
import { confirmHouseTrustForSession } from '../world/house-trust.js';
import type { RelationSessionHandle, RelationWiring } from './relation-wiring.js';
import { RelationGapStore } from './relation-gap-store.js';

export type RelationAttachResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface RelationReception {
  onFrame(envelopeBytes: Uint8Array, houseSlug: string, position: string | undefined): void;
  resumePosition(houseSlug: string): string | undefined;
  onCursorReset(houseSlug: string, reset: InboxCursorReset, connectionSerial: number): void;
}

/** A captured candidate, not a new authority token. Snapshot completion still rechecks it. */
export interface RelationRecoveryTarget {
  readonly origin: string;
  readonly handle: RelationSessionHandle;
}

export interface RelationHouseRegistry {
  /** Confirmed before legacy transports are constructed; no mutable handles escape here. */
  readonly configured: readonly { readonly origin: string; readonly reason?: string }[];
  /** One startup confirmation; the host awaits each at its original opening boundary. */
  confirmConfigured(origin: string): Promise<void>;
  /** Bind a legacy stream's transport-assigned slug to its already confirmed session. */
  bindConfiguredStream(origin: string, slug: string): void;
  attach(origin: string, slug: string): Promise<RelationAttachResult>;
  handleFor(slug: string): RelationSessionHandle | undefined;
  trustedHandleFor(slug: string): RelationSessionHandle | undefined;
  slugForHouseKey(key: string): string | undefined;
  hasHouseAliases(): boolean;
  leave(slug: string): void;
  readonly reception: RelationReception;
  /** False means a departure callback stopped this round before deferred processing. */
  maintain(): boolean;
  recoveryTarget(key: string, incarnation: string): RelationRecoveryTarget | undefined;
  isStopped(): boolean;
  stop(): void;
}

export interface RelationHouseRegistryDeps {
  readonly db: HostDb;
  readonly wiring: Pick<RelationWiring, 'handleAt'>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly log?: { readonly info?: (message: string) => void; readonly warn?: (message: string) => void };
  /** With an external supplier, undefined means no live connection and rejects a reset. */
  readonly currentConnectionSerialOf?: (slug: string) => number | undefined;
  /** Legacy host-owned transport; missing serial retains the historical compatibility case. */
  readonly ownedConnectionSerialOf: (slug: string) => number | undefined;
  /** Stops the matching transport and notifies listeners synchronously, in that order. */
  readonly onDeparture: (slug: string, kind: 'explicit' | 'observed') => void;
}

/**
 * How many frames one house may have waiting for a session that has not
 * become trusted yet.
 *
 * Not a tuning knob so much as a place to stop: past it, holding more is no
 * longer protecting the frames, and the transport's own replay boundary is
 * the better keeper of them (it reconnects having acknowledged nothing, so
 * the house re-sends). Generous enough that the case this exists for — the
 * few hundred milliseconds between a fresh install's first stream and its
 * first trust pin — never reaches it.
 */
const DEFERRED_FRAME_LIMIT = 100;

/** One frame held because its house had no session to commit it under. */
interface DeferredFrame {
  readonly envelopeBytes: Uint8Array;
  readonly eventId: string;
  readonly position?: string;
}

export function createRelationHouseRegistry(
  deps: RelationHouseRegistryDeps,
): RelationHouseRegistry {
  const wiring = deps.wiring;
  const slugByHouseKey = new Map<string, string>();
  const gaps = new RelationGapStore(deps.db);
  // Terminal state is shared with the host through isStopped(), never copied.
  let disposed = false;
  // Streams follow the participation: a house with a standing pin AND a
  // live session gets its stream (relations and, once the DM consumer is
  // bridged onto the same reliable boundary, mail); a house without either
  // gets nothing — no connection, no reconnect, no callbacks on the owner's
  // behalf. Compatibility for pre-relation installs is a migration question,
  // not a reason to read a logged-out house's mail.
  // Attach-only, and the confirm answers FOR A SESSION: the binding and the
  // owner generation come out of the same verifying transaction, so the
  // handle is built on what was verified — never a fresh "current"
  // generation an interleaved relogin could splice onto an old confirm.
  const confirmSession = (url: string) => confirmHouseTrustForSession(deps.db, url, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    // Loopback is this machine, not an arbitrary insecure origin.
    ...(isLoopbackOrigin(url) ? { allowInsecureOrigin: true } : {}),
  });
  const handleFromConfirmation = (confirmed: Awaited<ReturnType<typeof confirmSession>>):
    { readonly handle: RelationSessionHandle } | { readonly reason: string } => {
    if (!confirmed.ok) return { reason: confirmed.refusal };
    const handle = wiring.handleAt(
      { houseKey: confirmed.binding.houseKey, incarnation: confirmed.binding.incarnation },
      confirmed.ownerGeneration,
    );
    // Never splice a replacement generation onto an older confirmation.
    if (handle === undefined) return { reason: 'the live session changed during startup' };
    return { handle };
  };
  const confirmHandleAt = async (url: string) => handleFromConfirmation(await confirmSession(url));
  const relationAttached: { origin: string; reason?: string; handle?: RelationSessionHandle }[] = [];

  const handleBySlug = new Map<string, RelationSessionHandle>();
  const originBySlug = new Map<string, string>();
  /**
   * Where each house was asked to be attached — whether or not it worked.
   *
   * The attach is tried once, when the resource set opens the house and
   * before its stream reads a byte, and on a fresh data root it loses a race
   * it cannot win: the trust pin this confirm needs is written a few hundred
   * milliseconds later by a loop that is not awaited. Nothing retried it, so
   * the process kept a house it could take no relations from for its whole
   * life, and the only sign was one line on stderr. Keeping the origin is
   * what lets the tick below ask again.
   */
  const attachOriginBySlug = new Map<string, string>();
  const attachInFlight = new Set<string>();
  /** Consecutive refusals per house, and the wall clock the next try is owed. */
  const attachFailures = new Map<string, number>();
  const attachNotBefore = new Map<string, number>();
  /** Last refusal said out loud per house, so a retry loop is not a shout. */
  const lastAttachRefusal = new Map<string, string>();
  /**
   * Frames that reached a house whose session was not trusted yet.
   *
   * They used to be dropped with a line, and dropping them loses them: the
   * position this frame carries is written by the COMMIT, so nothing
   * acknowledges it — but the connection stays open, the next frames commit
   * once the session does stand up, and the cursor jumps clean over the one
   * that never landed. Nothing re-reads it. The 30-minute follower poll was
   * the only thing that could repair the damage, and only for follows.
   *
   * So they are held here, in arrival order, and handed to the boundary the
   * moment a session stands up. Held, not applied: an untrusted session
   * commits nothing, which is the rule this defers to rather than weakens.
   */
  const deferredBySlug = new Map<string, DeferredFrame[]>();
  /**
   * Bring one house into the chain, remembering where it was even if the
   * confirm refuses. Shared by the public `attach` and by the retry below, so
   * a house that becomes trustworthy later joins on exactly the same terms it
   * would have joined on at boot — nothing here is a weaker confirm.
   */
  const attachAt = async (
    origin: string,
    houseSlug: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
    if (disposed) return { ok: false as const, reason: 'this reception host has been stopped' };
    attachOriginBySlug.set(houseSlug, origin);
    const outcome = await confirmHandleAt(origin);
    if (!('handle' in outcome)) return { ok: false as const, reason: outcome.reason };
    if (disposed) return { ok: false as const, reason: 'this reception host has been stopped' };
    // Registered in all three maps together: the frame path reads
    // handleBySlug, the trust re-check reads originBySlug, and the DM
    // hand-over resolves a house key back to this slug. A house present in
    // one and missing from another is how a frame ends up committed under
    // the wrong house's name.
    handleBySlug.set(houseSlug, outcome.handle);
    originBySlug.set(houseSlug, origin);
    slugByHouseKey.set(outcome.handle.source.houseKey, houseSlug);
    return { ok: true as const };
  };
  /**
   * A stable, non-secret name for one frame, for the deferral line and the
   * line that says it was processed. The event id is the frame's own name;
   * its transport position is the fallback for bytes that will not decode,
   * which cannot be committed either but should still be traceable.
   */
  const frameRef = (eventId: string, position: string | undefined): string =>
    eventId || position || 'unidentified';
  /** Hand every held frame to the boundary, in the order the house sent them. */
  const flushDeferred = (houseSlug: string): void => {
    const queue = deferredBySlug.get(houseSlug);
    const handle = handleBySlug.get(houseSlug);
    if (queue === undefined || handle === undefined) return;
    while (queue.length > 0) {
      const frame = queue[0]!;
      try {
        handle.receive({
          stream: 'personal',
          envelopeBytes: frame.envelopeBytes,
          eventId: frame.eventId,
          ...(frame.position !== undefined ? { position: frame.position } : {}),
        });
      } catch (err) {
        // The boundary itself failed, which is not this frame's fault and not
        // something the next frame should be committed past. Leave it at the
        // head and let the next tick try again.
        deps.log?.warn?.(
          `popclaw: relation frame held at ${houseSlug} (event ${frameRef(frame.eventId, frame.position)}) ` +
            `could not be committed — ${String(err)}`,
        );
        return;
      }
      queue.shift();
      deps.log?.info?.(
        `popclaw: relation frame processed after deferral at ${houseSlug} ` +
          `(event ${frameRef(frame.eventId, frame.position)})`,
      );
    }
    deferredBySlug.delete(houseSlug);
  };
  /**
   * Ask again for a house that is holding frames it cannot commit.
   *
   * Driven by the arrival of a frame and by the drain tick — no schedule of
   * its own, and nothing runs at all for a house with nothing waiting. The
   * bound is the debt itself: a house only gets retried while it is sending
   * us relation frames we have not been able to take, which is exactly when
   * asking again is worth a round trip.
   */
  const retryAttach = async (houseSlug: string): Promise<void> => {
    if (disposed || handleBySlug.has(houseSlug) || attachInFlight.has(houseSlug)) return;
    const origin = attachOriginBySlug.get(houseSlug);
    if (origin === undefined) return; // nobody ever asked for this house
    // The tick is the schedule; the ladder is the RATE. Without it, a house
    // whose pin stands but whose manifest keeps failing would be asked again
    // every couple of seconds for as long as it held a frame — the same
    // beacon the inbox stream's own re-auth ladder exists to prevent, so this
    // climbs THAT ladder rather than a second set of numbers.
    const notBefore = attachNotBefore.get(houseSlug);
    if (notBefore !== undefined && Date.now() < notBefore) return;
    attachInFlight.add(houseSlug);
    try {
      const outcome = await attachAt(origin, houseSlug);
      if (!outcome.ok) {
        const failures = (attachFailures.get(houseSlug) ?? 0) + 1;
        attachFailures.set(houseSlug, failures);
        attachNotBefore.set(houseSlug, Date.now() + reauthBackoffMs(failures));
        // On change only. A house that stays untrusted is retried on every
        // tick that holds a frame, and saying the same sentence every couple
        // of seconds is not visibility.
        if (lastAttachRefusal.get(houseSlug) !== outcome.reason) {
          lastAttachRefusal.set(houseSlug, outcome.reason);
          deps.log?.warn?.(
            `popclaw: relation session at ${houseSlug} still not attachable — ${outcome.reason}`,
          );
        }
        return;
      }
      lastAttachRefusal.delete(houseSlug);
      // A success is the end of the streak, not merely a gap in it: the next
      // refusal after this one starts at the bottom of the ladder again.
      attachFailures.delete(houseSlug);
      attachNotBefore.delete(houseSlug);
      deps.log?.info?.(
        `popclaw: relation session attached at ${houseSlug} after ` +
          `${deferredBySlug.get(houseSlug)?.length ?? 0} deferred frame(s)`,
      );
    } catch (err) {
      deps.log?.warn?.(`popclaw: relation attach retry at ${houseSlug} failed — ${String(err)}`);
      return;
    } finally {
      attachInFlight.delete(houseSlug);
    }
    flushDeferred(houseSlug);
  };
  const defer = (houseSlug: string, envelopeBytes: Uint8Array, position: string | undefined): void => {
    const queue = deferredBySlug.get(houseSlug) ?? [];
    if (queue.length >= DEFERRED_FRAME_LIMIT) {
      // The safety valve, and it is the same mechanism as the hold: throwing
      // reaches the transport's replay boundary, which abandons this
      // connection's queue and reconnects WITHOUT having acknowledged
      // anything. The house replays from where we actually are. Holding an
      // unbounded backlog for a house that never becomes trusted would be
      // the other way to lose it.
      throw new Error(
        `RELATION_SESSION_NOT_TRUSTED: ${houseSlug} already has ${queue.length} relation frames waiting ` +
          'for a trusted, live session; this one is refused so the transport re-reads it later',
      );
    }
    const eventId = announcedEventId(envelopeBytes);
    queue.push({ envelopeBytes, eventId, ...(position !== undefined ? { position } : {}) });
    deferredBySlug.set(houseSlug, queue);
    deps.log?.warn?.(
      `popclaw: relation frame deferred at ${houseSlug} (event ${frameRef(eventId, position)}): ` +
        'no trusted, live session yet — not acknowledged, held until one attaches',
    );
    void retryAttach(houseSlug);
  };
  // The three reception callbacks, named rather than inline: the transport
  // that invokes them belongs to the host or its resource set. A root whose
  // personal stream is owned by HouseResourceSet supplies the SAME three and
  // opens nothing here — which is the documented arrangement (see
  // `HouseResourceOptions.onFrame`: one personal transport per house, owned
  // there, gated there, reconnected there).
  const receiveFrame = (envelopeBytes: Uint8Array, houseSlug: string, position: string | undefined): void => {
    const handle = handleBySlug.get(houseSlug);
    // A queue that is not empty outranks a handle that has just appeared:
    // the held frames are older, and committing this one first would write
    // a position past them.
    if (handle === undefined || (deferredBySlug.get(houseSlug)?.length ?? 0) > 0) {
      defer(houseSlug, envelopeBytes, position);
      return;
    }
    handle.receive({
      stream: 'personal',
      envelopeBytes,
      eventId: announcedEventId(envelopeBytes),
      ...(position !== undefined ? { position } : {}),
    });
  };
  const resumePositionFor = (houseSlug: string): string | undefined => {
    const handle = handleBySlug.get(houseSlug);
    if (handle === undefined) return undefined;
    // An open gap means the cursor this handle would resume from is dead —
    // the house already said it could not honour it, and resending it just
    // re-earns the reset on every reconnect. Read on from the log's head
    // (frames that arrive still commit through the ordinary boundary); the
    // gap marker, not the cursor, carries the debt until reconciliation.
    const gap = gaps.openFor(handle.source.houseKey, handle.source.incarnation);
    if (gap !== undefined) return undefined;
    return handle.resumeFrom('personal');
  };
  const noteCursorReset = (houseSlug: string, reset: InboxCursorReset, connectionSerial: number): void => {
    // The house could not honour our cursor: it has skipped past us, and the
    // projection behind that cursor is no longer known complete. Record the
    // debt durably — loud once here, and the resume above goes quiet about
    // it — until the recovery consumer reconciles a snapshot checkpoint.
    // The mark is LIFECYCLE-FENCED and atomic: a disposed
    // host never writes, and the handle must STILL be trusted (pin
    // unblocked, participation live at its generation) in the same
    // transaction that writes — a stale connection's reset does not mark
    // debts for a world that has moved on.
    if (disposed) return;
    // The connection era: a reset arriving on a
    // connection that has since been REPLACED (our own reconnect after a
    // network error, or a lease-loss stop) is a stale connection's word —
    // delivery-time trust checks cannot see this, only the serial can.
    const currentSerial = deps.currentConnectionSerialOf !== undefined
      ? deps.currentConnectionSerialOf(houseSlug)
      : deps.ownedConnectionSerialOf(houseSlug);
    // With a supplier, `undefined` means no live connection — stale. Without
    // one, it means this assembly opened no stream for the house, and the
    // era cannot be judged, so the reset is taken at its word as before.
    const stale = deps.currentConnectionSerialOf !== undefined
      ? currentSerial !== connectionSerial
      : currentSerial !== undefined && connectionSerial !== currentSerial;
    if (stale) {
      deps.log?.warn?.(
        `popclaw: cursor reset at ${houseSlug} arrived on a replaced connection — ignored as stale`,
      );
      return;
    }
    const handle = handleBySlug.get(houseSlug);
    const origin = originBySlug.get(houseSlug) ?? '';
    if (handle === undefined) {
      // No trusted session: nothing to reconcile under, and no cursor of
      // ours was in play. The house's word still gets said out loud.
      deps.log?.warn?.(
        `popclaw: cursor reset at ${houseSlug} (${reset.reason}) with no trusted session — nothing to reconcile under`,
      );
      return;
    }
    const marked = deps.db.transaction(() => {
      if (!handleStillTrusted(deps.db, handle, origin)) return false;
      gaps.mark({
        houseKey: handle.source.houseKey,
        incarnation: handle.source.incarnation,
        reason: reset.reason,
        logGeneration: reset.logGeneration,
        floor: reset.floor,
        at: deps.now?.() ?? Math.floor(Date.now() / 1000),
      });
      return true;
    });
    if (!marked) {
      deps.log?.warn?.(
        `popclaw: cursor reset at ${houseSlug} (${reset.reason}) under a stale session — not marked; the tick will detach it`,
      );
      return;
    }
    deps.log?.warn?.(
      `popclaw: cursor reset at ${houseSlug} (${reset.reason}; log generation ${reset.logGeneration}, floor ${reset.floor}) — ` +
        'relation projection may be missing edges; reconciliation required, resume position suppressed until it completes',
    );
  };

  return {
    get configured() {
      return relationAttached.map(({ origin, reason }) => ({ origin, ...(reason !== undefined ? { reason } : {}) }));
    },
    async confirmConfigured(origin) {
      if (disposed) return;
      // Exactly one awaited confirmation, as in the host's original startup
      // loop. A synchronous factory also leaves empty-host startup synchronous.
      const outcome = handleFromConfirmation(await confirmSession(origin));
      if (disposed) return;
      relationAttached.push('handle' in outcome
        ? { origin, handle: outcome.handle }
        : { origin, reason: outcome.reason });
    },
    bindConfiguredStream(origin, slug) {
      if (disposed) return;
      const handle = relationAttached.find((a) => a.origin === origin)?.handle;
      if (handle !== undefined) {
        handleBySlug.set(slug, handle);
        originBySlug.set(slug, origin);
        slugByHouseKey.set(handle.source.houseKey, slug);
      }
      attachOriginBySlug.set(slug, origin);
    },
    async attach(origin, houseSlug) {
      const outcome = await attachAt(origin, houseSlug);
      // A house that joins on this call may already be holding frames from a
      // stream that started reading before it: an explicit re-attach after a
      // re-login is the same moment as the tick's retry, and owes them the
      // same flush.
      if (outcome.ok) {
        lastAttachRefusal.delete(houseSlug);
        flushDeferred(houseSlug);
      }
      return outcome;
    },
    handleFor: (slug) => handleBySlug.get(slug),
    trustedHandleFor(slug) {
      const handle = handleBySlug.get(slug);
      if (handle === undefined) return undefined;
      return handleStillTrusted(deps.db, handle, originBySlug.get(slug) ?? '') ? handle : undefined;
    },
    slugForHouseKey: (key) => slugByHouseKey.get(key),
    hasHouseAliases: () => slugByHouseKey.size > 0,
    leave(slug) {
      const handle = handleBySlug.get(slug);
      if (handle === undefined) return;
      handle.leave();
      handleBySlug.delete(slug);
      deps.onDeparture(slug, 'explicit');
    },
    maintain() {
      if (disposed) return false;
      // Cross-host leave: another process (the CLI, another host) may have
      // ended a participation this process is still attached to. The fence
      // already refuses the dead handle's COMMITS; this stops its READING —
      // a logged-out house's stream does not keep connecting and reconnecting
      // just because this process happened to hold it open.
      for (const [slug, handle] of [...handleBySlug]) {
        if (!handleStillTrusted(deps.db, handle, originBySlug.get(slug) ?? '')) {
          handleBySlug.delete(slug);
          originBySlug.delete(slug);
          deps.onDeparture(slug, 'observed');
          // Notification is synchronous: stop from the first departure must
          // leave subsequent houses and held debt untouched this round.
          if (disposed) return false;
        }
      }
      if (disposed) return false; // a callback stopped the host mid-round
      // Houses holding frames they could not commit. The attach is retried on
      // THIS clock rather than one of its own, and only for a house that is
      // actually owed something — a house with nothing waiting costs nothing
      // here. Whichever way a session appears, the held frames go to the
      // boundary before this tick's drain turns anything into business state.
      for (const houseSlug of [...deferredBySlug.keys()]) {
        if (handleBySlug.has(houseSlug)) flushDeferred(houseSlug);
        else void retryAttach(houseSlug);
      }
      return true;
    },
    recoveryTarget(key, incarnation) {
      // Preserve first-match selection, including refusal of a stale first
      // alias instead of silently choosing a later handle for the same key.
      for (const [slug, handle] of handleBySlug) {
        if (handle.source.houseKey !== key || handle.source.incarnation !== incarnation) continue;
        const origin = originBySlug.get(slug);
        if (origin === undefined || !handleStillTrusted(deps.db, handle, origin)) return undefined;
        return { origin, handle };
      }
      return undefined;
    },
    reception: { onFrame: receiveFrame, resumePosition: resumePositionFor, onCursorReset: noteCursorReset },
    isStopped: () => disposed,
    stop() { disposed = true; },
  };
}

/** Is this handle CURRENTLY trustworthy — not merely cached?
 *
 * A handle in the map proves a confirmation once succeeded; it proves
 * nothing about NOW. This is the ONE definition (the tick, the badge's
 * start paths, and the roots' world gates all reuse it): the
 * participation is live at the generation the handle captured, AND the
 * pin still binds the same origin to the same key and incarnation with
 * no block. A blocked pin — an incarnation change confirmed elsewhere
 * while we held nothing — changes none of the participation facts,
 * which is exactly why the pin is checked HERE and not left to the
 * tick.
 */
export function handleStillTrusted(
  db: HostDb,
  handle: RelationSessionHandle,
  origin: string,
): boolean {
  const part = db.queryOne<{ owner_generation: number; active: number }>(
    'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
    [handle.source.houseKey],
  );
  if (part === null || part.active !== 1 || part.owner_generation !== handle.source.ownerGeneration) {
    return false;
  }
  const pin = db.queryOne<{ house_key: string; incarnation: string }>(
    'SELECT house_key, incarnation FROM house_binding_pin WHERE origin = ? AND blocked_reason IS NULL',
    [origin],
  );
  return pin !== null && pin.house_key === handle.source.houseKey && pin.incarnation === handle.source.incarnation;
}

/** loopback origins: this machine, not the network. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

/** The id the envelope announces, read only so the commit can check it against the bytes. */
function announcedEventId(envelopeBytes: Uint8Array): string {
  try {
    return popclaw.event.EventEnvelope.decode(envelopeBytes).eventId ?? '';
  } catch {
    return '';
  }
}
