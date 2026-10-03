import type { HostDb } from '../host/host-db.js';

/**
 * Duty badge: with several popclaw processes alive under one
 * `POPCLAW_DATA_ROOT`, elects the one that does the work which must happen
 * exactly once globally (world-feed SSE subscription + reply-ping routing).
 *
 * **It is not a door bolt.** A bolt would stop the second process from
 * starting, which would amputate the whole "one passport, every AI tool"
 * promise — the OpenClaw plugin resident while popclaw-mcp runs under Claude
 * Code is the DEFAULT shape for our beta users, not an exotic case. This
 * elects *work*, never a *server*: any process can post, reply and read the
 * bond book (SQLite coordinates that itself via WAL + busy_timeout); only
 * ingest picks one.
 *
 * Handover is safe because the world-feed SSE backfills everything on every
 * (re)connect (`WorldFeedStreamClient`'s `limit: 100_000`, deduped by INSERT
 * OR REPLACE), so whoever takes over automatically fills the gap — no cursor
 * needs to be handed across.
 *
 * Crash residue is cleared by the TTL: a dead holder stops renewing and the
 * badge becomes claimable. That is exactly why this is cheaper than a startup
 * lock — no stale-lock adjudication, no pid liveness probing.
 *
 * ponytail: single-row table + polling renewal. When the v2 daemon lands it
 * simply becomes the permanent holder and everyone else degrades to reader —
 * this is the daemon's scaffolding, not a throwaway.
 */
interface ListenerEntry {
  readonly cb: { onAcquired?: () => void; onLost?: () => void };
  /** The last badge epoch this listener was told about. A reentrant
   * release→tryAcquire inside another listener's callback announces both
   * transitions itself; the OUTER loop's stale direction must not arrive a
   * second time. */
  lastEpoch: number;
}

export class DutyLease {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Everyone the badge's transitions must tell — one lease, many governed workloads. */
  private readonly listeners: ListenerEntry[] = [];
  /** Bumped on every state change; an announce only ever tells a listener
   * about an epoch it has not heard. */
  private epoch = 0;
  private held = false;

  constructor(
    private readonly db: HostDb,
    private readonly token: string,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Claim the badge. true = this process is on duty.
   *
   * One statement expresses all three cases — nobody on duty, lease expired,
   * already mine (renewal, or same token after a restart): if the WHERE does
   * not hold there are 0 changes, and that means someone else is on duty.
   * SQLite gives us the atomicity; no surrounding transaction needed, the
   * single UPSERT *is* the critical section.
   */
  tryAcquire(): boolean {
    const t = this.now();
    const changes = this.db.execute(
      `INSERT INTO duty_lease (id, holder, renewed_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, renewed_at = excluded.renewed_at
       WHERE duty_lease.holder = excluded.holder OR duty_lease.renewed_at < ?`,
      [this.token, t, t - this.ttlMs],
    ).changes;
    const wasHeld = this.held;
    const nowHeld = changes === 1;
    // State FIRST, then the announcement: a listener calling isHeld() or
    // release() from inside onAcquired sees the badge it was just told
    // about, not the previous one.
    this.held = nowHeld;
    this.announce(wasHeld, nowHeld);
    return this.held;
  }

  /** Tell every listener about a transition. No transition, no call. One
   * listener's throw never eats the state change or the other listeners. */
  private announce(was: boolean, now: boolean): void {
    if (was === now) return;
    this.epoch += 1;
    const epoch = this.epoch;
    for (const entry of [...this.listeners]) {
      // Per-listener freshness AND per-listener epoch: a reentrant
      // release→tryAcquire inside an earlier callback announced both its own
      // transitions already; this loop's stale direction would be a
      // duplicate. Only speak if this listener has not heard this epoch.
      if (entry.lastEpoch >= epoch) continue; // already heard this or newer
      entry.lastEpoch = epoch;
      try {
        if (now && this.held) entry.cb.onAcquired?.();
        else if (!now && !this.held) entry.cb.onLost?.();
      } catch {
        /* a failing listener is isolated; the badge's state is already set */
      }
    }
  }

  /** Whether this process is on duty (last known, no query). */
  isHeld(): boolean {
    return this.held;
  }

  /**
   * An immutable execution right for ONE holding round of the badge.
   *
   * A workload that spans awaits (a resend sweep pushing p1 then p2) cannot
   * ask `isHeld()` after each await: release→reacquire makes it true again,
   * and true would then authorise the OLD round's remainder under the NEW
   * round's name. The token pins the epoch it was minted at; loss, release,
   * or a later re-acquire — any transition — invalidates it permanently, and
   * only a fresh `runToken()` mint names the new round.
   */
  runToken(): { readonly epoch: number; valid(): boolean } | undefined {
    if (!this.held) return undefined;
    const epoch = this.epoch;
    return { epoch, valid: () => this.held && this.epoch === epoch };
  }

  /**
   * Start renewing (when holding) or re-claiming (when not).
   *
   * - On duty → renew. Losing it (only possible if this process stalled past
   *   the TTL) fires `onLost` so the caller stops its background work rather
   *   than ingesting alongside the new holder.
   * - Off duty → keep trying. After the holder exits or crashes the badge
   *   expires, gets taken over, and `onAcquired` starts the work here.
   *
   * Heartbeat is a third of the TTL: one GC pause or network hiccup must not
   * cost us the badge.
   */
  /** Join the transitions without owning the heartbeat: several workloads
   * (the world feeds, the reception chain) can share ONE badge per process. */
  addTransitionListener(cb: { onAcquired?: () => void; onLost?: () => void }): void {
    // The same registration twice is one listener: a repeated start() must
    // not double-notify its caller.
    if (this.listeners.some((l) => l.cb === cb)) return;
    this.listeners.push({ cb, lastEpoch: -1 });
  }

  start(cb: { onAcquired?: () => void; onLost?: () => void } = {}): void {
    this.addTransitionListener(cb);
    this.startHeartbeat();
  }

  /** Begin (or keep) the renewal/competition loop. Idempotent. */
  startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // tryAcquire announces whatever transition it finds — renewal,
      // takeover, or loss — to every listener.
      this.tryAcquire();
    }, Math.max(1000, Math.floor(this.ttlMs / 3)));
    this.timer.unref?.(); // never hold the process open just to heartbeat
  }

  /** Stop listening to this badge's transitions (a disposed workload must
   * not be revived by a later acquire). Idempotent. */
  removeTransitionListener(cb: { onAcquired?: () => void; onLost?: () => void }): void {
    const i = this.listeners.findIndex((l) => l.cb === cb);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /** Stop renewing and hand the badge back so the next process takes over now. */
  release(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.held) return;
    this.db.execute('DELETE FROM duty_lease WHERE id = 1 AND holder = ?', [this.token]);
    const wasHeld = this.held;
    this.held = false;
    this.announce(wasHeld, false);
  }
}
