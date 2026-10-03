/**
 * The follower poll, as ONE thing every resident root starts.
 *
 * Being followed used to work on exactly one root. The poll — the only writer
 * of `known_followers_baseline` — was assembled inline in the gateway's
 * `register()`, so on the MCP host and the daemon that table stayed empty for
 * ever. `KnownFollowersStore.unannounced()` joins it, deliberately, so the
 * history a cold personal stream replays is recorded without being introduced;
 * with no baseline row that join matches nothing, and the drain sweep in
 * `relation-host.ts` read an always-empty batch. The relation arrived, the
 * edge was applied, the follower row was written with `announced_at` NULL —
 * and the owner was told nothing, with no error anywhere to explain it.
 *
 * Following worked on those roots and being followed did not: the asymmetry
 * that is hardest to notice, because nothing fails.
 *
 * So the poll lives here, next to `default-house-pinning.ts` — the other thing
 * every resident root has to do and no root may own — and each root starts it
 * from its own service/bootstrap block with the handful of objects only it
 * has: its houses, its command lane, its gate.
 *
 * The guards and the per-house gate are assembled HERE rather than at each
 * root, because they belong to the poll and to nothing else. A root that
 * forgot the guards would take any answer as the whole truth, and a house
 * answering `200 []` would delete every follower it knows — which is also the
 * dedup for these notifications, so everyone would be introduced again.
 */
import type { HostDb } from '../host/host-db.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import type { ActionGate } from '../runtime/house-lifecycle/action-context.js';
import {
  FOLLOWER_SYNC_INTERVAL_MS,
  houseScopedVerifiedGuards,
  syncFollowers,
  type FollowerSyncDeps,
  type HouseRef,
} from './followers-sync.js';

export interface FollowerSyncServiceDeps {
  readonly db: HostDb;
  /**
   * The root's follower deps — the same object its relation-reception leg
   * hands `announceVerifiedFollowers`, so a follow reads identically whichever
   * path noticed it. The poll-only members (`verifiedGuards`, `gateForHouse`)
   * are filled in here.
   */
  readonly deps: FollowerSyncDeps;
  /**
   * Read fresh every pass, never captured: a house can mount after boot, and a
   * list snapshotted at construction would never poll it.
   */
  readonly houses: () => readonly HouseRef[];
  /** The root's command lane, so a pass takes part in shutdown like every other house call. */
  readonly runCommand: <T>(work: () => Promise<T>) => Promise<T>;
  /** One owner per house per pass, captured before the first await. */
  readonly captureGate?: (origin: string) => ActionGate;
  readonly intervalMs?: number;
  /** Test seam for the backoff below. */
  readonly notTrustedRetryDelaysMs?: readonly number[];
}

/**
 * How soon a pass tries again when a house refused it for want of a pin.
 *
 * Every root starts this poll and the default-house pinning in the same tick,
 * and awaits neither — deliberately, so tools answer before any house has
 * replied. The poll therefore reaches the house first, by a wide margin: on a
 * fresh install the pass runs about twelve milliseconds in and the TOFU pin
 * commits around three hundred. The pass is refused, and at a half-hour
 * cadence the install is then silent about being followed for thirty minutes,
 * on every one of its first boots.
 *
 * Two seconds catches that ordinary case. The widening delays cover a house
 * that was briefly unreachable and got pinned on the pinning loop's own 30s
 * retry. And they RUN OUT: a house that stays untrusted falls back to the
 * ordinary cadence rather than becoming a background beacon, which is the
 * same bargain `DEFAULT_PIN_RETRY_DELAYS_MS` makes next door.
 */
export const NOT_TRUSTED_RETRY_DELAYS_MS: readonly number[] = [2_000, 15_000, 60_000, 5 * 60_000];

export interface FollowerSyncService {
  /** One all-houses pass, outside the schedule. Throws what the lane throws. */
  readonly runOnce: () => Promise<number>;
  /** A pass now, then one every interval. Resolves when the boot pass is done; never rejects. */
  readonly start: () => Promise<void>;
  /** Stop the schedule. Safe before, during and after `start`. */
  readonly stop: () => void;
}

export function createFollowerSync(service: FollowerSyncServiceDeps): FollowerSyncService {
  const deps: FollowerSyncDeps = {
    ...service.deps,
    // Per house, the author's VERIFIED facts at that house outrank what its
    // list says. Built from the database rather than taken from the caller so
    // no root can be wired without them.
    verifiedGuards: houseScopedVerifiedGuards(service.db, service.deps.ownerPopclawId, hostDbSlug),
    ...(service.captureGate
      ? { gateForHouse: (house: HouseRef) => service.captureGate!(house.baseUrl) }
      : {}),
  };
  /**
   * One pass, and whether any house refused it for want of a pin. The flag
   * belongs to the pass, not to the service: two passes can overlap when a
   * slow house outlasts the retry that was already scheduled, and a flag
   * shared between them would attribute one pass's refusal to the other.
   */
  const runPass = async (): Promise<{ count: number; notYetTrusted: boolean }> => {
    let notYetTrusted = false;
    const count = await service.runCommand(() => syncFollowers(
      { ...deps, onHouseNotYetTrusted: () => { notYetTrusted = true; } },
      service.houses(),
    ));
    return { count, notYetTrusted };
  };

  // An explicit one-shot, which must not start a background schedule.
  const runOnce = async (): Promise<number> => (await runPass()).count;

  const retryDelays = service.notTrustedRetryDelaysMs ?? NOT_TRUSTED_RETRY_DELAYS_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let stopped = false;

  const pass = async (): Promise<void> => {
    let notYetTrusted = false;
    try {
      notYetTrusted = (await runPass()).notYetTrusted;
    } catch (err) {
      deps.logger?.warn(`popclaw: follower sync failed (non-fatal): ${String(err)}`);
    }
    if (stopped) return;
    if (!notYetTrusted) {
      // Every house answered, so the boot race is over and the next one — a
      // house mounted later, a pin still in flight — gets its own short
      // ladder rather than inheriting a spent one.
      retryAttempt = 0;
      return;
    }
    // One retry in flight at a time, and only while the ladder has rungs
    // left: this is a nudge past a race the pinning loop is already working
    // on, never a second poller.
    const delay = retryDelays[retryAttempt];
    if (delay === undefined || retryTimer !== null) return;
    retryAttempt += 1;
    retryTimer = setTimeout(() => { retryTimer = null; void pass(); }, delay);
    // Never worth keeping a process alive for (ADR-0035's discipline).
    retryTimer.unref?.();
  };

  return {
    runOnce,
    start: async () => {
      stopped = false;
      retryAttempt = 0;
      await pass();
      // A root that stopped while the boot pass was in flight must not leave a
      // timer behind it.
      if (stopped || timer !== null) return;
      timer = setInterval(() => void pass(), service.intervalMs ?? FOLLOWER_SYNC_INTERVAL_MS);
      // Never worth keeping a process alive for (ADR-0035's discipline).
      timer.unref?.();
    },
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}
