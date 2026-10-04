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
  /** Existing resident observations; the callback is a wakeup, never a grant. */
  readonly observeParticipation?: (changed: (origin: string) => void) => () => void;
  readonly intervalMs?: number;
  /** Test seam for bounded trust and transient HTTP read retries. */
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
  const retryDelays = service.notTrustedRetryDelaysMs ?? NOT_TRUSTED_RETRY_DELAYS_MS;
  let stopped = false;
  let closing = new AbortController();
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | undefined;
  const retries = new Map<string, {attempt: number; timer?: ReturnType<typeof setTimeout>}>();
  const flights = new Map<string, {gate: ActionGate; work: Promise<{count: number; retry: boolean}>}>();
  const pendingWake = new Set<string>();
  const houseFor = (origin: string) => service.houses().find(house => house.baseUrl === origin);
  const active = (origin: string) => !stopped && !!houseFor(origin)
    && (service.captureGate?.(origin).isActive() ?? true);
  const clearRetry = (origin: string) => {
    const state = retries.get(origin);
    if (state?.timer) clearTimeout(state.timer);
    retries.delete(origin);
  };
  const deps: FollowerSyncDeps = {
    ...service.deps,
    verifiedGuards: houseScopedVerifiedGuards(service.db, service.deps.ownerPopclawId, hostDbSlug),
    gateForHouse: house => {
      const captured = service.captureGate?.(house.baseUrl), shutdown = closing.signal;
      return {origin: house.baseUrl,
        signal: captured ? AbortSignal.any([shutdown, captured.signal]) : shutdown,
        isActive: () => !shutdown.aborted && active(house.baseUrl) && (captured?.isActive() ?? true)};
    },
  };
  // All scheduled, observed and explicit passes share one flight per house.
  const runHouse = (house: HouseRef): Promise<{count: number; retry: boolean}> => {
    const existing = flights.get(house.baseUrl);
    if (existing) return existing.work;
    const gate = deps.gateForHouse!(house);
    let retry = false;
    const work = service.runCommand(() => syncFollowers({...deps,
      gateForHouse: () => gate,
      onHouseNotYetTrusted: () => { retry = true; },
      onHouseTransientReadFailure: () => { retry = true; },
    }, [house])).then(count => ({count, retry})).finally(() => {
      flights.delete(house.baseUrl);
      if (pendingWake.delete(house.baseUrl) && active(house.baseUrl)) void pass(house.baseUrl);
    });
    flights.set(house.baseUrl, {gate, work});
    return work;
  };
  const runOnce = async (): Promise<number> => (await Promise.all(service.houses().map(runHouse)))
    .reduce((count, result) => count + result.count, 0);
  const pass = async (origin: string): Promise<void> => {
    const house = houseFor(origin);
    if (!house || !active(origin)) { clearRetry(origin); return; }
    let result: {count: number; retry: boolean};
    try { result = await runHouse(house); }
    catch (err) {
      deps.logger?.warn(`popclaw: follower sync failed (non-fatal): ${String(err)}`);
      return;
    }
    if (!active(origin) || !result.retry) { clearRetry(origin); return; }
    const state = retries.get(origin) ?? {attempt: 0};
    if (state.timer) return;
    const delay = retryDelays[state.attempt];
    if (delay === undefined) return;
    state.attempt += 1;
    state.timer = setTimeout(() => { state.timer = undefined; void pass(origin); }, delay);
    state.timer.unref?.();
    retries.set(origin, state);
  };
  const changed = (origin: string): void => {
    if (!active(origin)) { clearRetry(origin); pendingWake.delete(origin); return; }
    const flight = flights.get(origin);
    if (flight) {
      // Repeated signals for this generation coalesce. A new generation waits
      // for the old fenced read to finish before capturing fresh authority.
      if (!flight.gate.isActive()) pendingWake.add(origin);
      return;
    }
    clearRetry(origin);
    void pass(origin);
  };
  return {
    runOnce,
    start: async () => {
      if (stopped) closing = new AbortController();
      stopped = false;
      unsubscribe ??= service.observeParticipation?.(changed);
      await Promise.all(service.houses().map(house => pass(house.baseUrl)));
      if (stopped || timer !== null) return;
      timer = setInterval(() => {
        for (const house of service.houses()) { clearRetry(house.baseUrl); void pass(house.baseUrl); }
      }, service.intervalMs ?? FOLLOWER_SYNC_INTERVAL_MS);
      timer.unref?.();
    },
    stop: () => {
      stopped = true; closing.abort();
      unsubscribe?.(); unsubscribe = undefined;
      if (timer) clearInterval(timer);
      timer = null;
      for (const origin of retries.keys()) clearRetry(origin);
      pendingWake.clear();
    },
  };
}
