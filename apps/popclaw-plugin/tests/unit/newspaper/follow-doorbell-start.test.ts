/**
 * `startFollowDoorbell` — the shared starter every resident root calls.
 *
 * The divergence guard next door proves each root CALLS it; this proves what
 * gets called does the job with the dep bundle each root actually hands over,
 * including the MCP/daemon bundle that has no owner push channel.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PendingFollowStore, type FollowIntentRow } from '../../../src/social-graph/pending-follow-store.js';
import {
  startFollowDoorbell,
  DOORBELL_HOT_TICK_MS,
  DOORBELL_WARM_TICK_MS,
  DOORBELL_SLOW_TICK_MS,
  DOORBELL_VIEWING_WINDOW_MS,
  type FollowDoorbellDeps,
} from '../../../src/newspaper/follow-doorbell-service.js';
import { createViewingSignal } from '../../../src/canvas/viewing-signal.js';
import type { Signer } from '../../../src/identity/signer.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const MS = 1_750_000_000_000;
const MIN = 60_000;
const HOUSE = 'https://house.invalid';
/** A production-shaped popclaw id. */
const FOLLOWEE = '7xKvGjWntCHSPQoyY2mLBRTDdQFEAqNsZz4fCcrKVJ9u';

const intent = (id: string, firstTs: number): FollowIntentRow => ({
  owner_popclaw_id: 'self',
  followee_popclaw_id: id,
  followee_label: 'Cloudboat#3m8v',
  first_ts: firstTs,
  latest_ts: firstTs,
  click_count: 1,
});

/**
 * One pending row old enough to surface, written straight to the store. The
 * debounce's quiet leg holds back anything absorbed in the current tick, so a
 * batch that arrived on the wire could never test the surfacing decision on
 * the first tick — and would make a "never claimed" assertion pass for the
 * wrong reason.
 */
function seedRipeBatch(store: PendingFollowStore): void {
  store.absorb([intent(FOLLOWEE, MS - 25 * MIN)], {
    authors: new Map([[FOLLOWEE, { display_name: 'Cloudboat#3m8v', descriptor: null, issue_date: '2026-09-18' }]]),
    followsIn: () => false,
  });
}

/** Never reached: every test injects `pull`, which is the only signing user. */
const signer = { popclawId: async () => 'self', sign: async () => new Uint8Array() } as unknown as Signer;

function harness(over: Partial<FollowDoorbellDeps> = {}) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const store = new PendingFollowStore(db);
  const pulls: number[] = [];
  const enqueued: Array<{ level: string; kind: string; payload: Record<string, unknown> }> = [];
  const info: string[] = [];
  const warn: string[] = [];
  let rows: FollowIntentRow[] = [];
  let active = true;
  const deps: FollowDoorbellDeps = {
    db,
    ownerPopclawId: 'self',
    canvasBaseUrl: 'https://canvas.invalid',
    signer,
    followsIn: () => false,
    notifier: { enqueue: (i) => void enqueued.push(i) },
    runCommand: (work) => work(),
    captureGate: () => ({ isActive: () => active, signal: new AbortController().signal }),
    houseOrigin: HOUSE,
    store,
    logger: { info: (m) => void info.push(m), warn: (m) => void warn.push(m) },
    pull: async (_owner, after) => {
      pulls.push(after);
      const out = rows;
      rows = [];
      return out;
    },
    clock: () => MS,
    localHour: () => 12,
    ...over,
  };
  return {
    deps, store, db, pulls, enqueued, info, warn,
    set rows(v: FollowIntentRow[]) { rows = v; },
    set active(v: boolean) { active = v; },
  };
}

describe('startFollowDoorbell', () => {
  it('pulls, absorbs and enqueues the L2 pointer on the very first tick', async () => {
    const h = harness();
    h.rows = [intent(FOLLOWEE, MS - 25 * MIN)];
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    loop.stop();
    expect(h.pulls).toEqual([0]); // the in-memory cursor starts at a full pull
    expect(h.store.listPending().map((r) => r.followee_popclaw_id)).toEqual([FOLLOWEE]);
    expect(h.enqueued).toEqual([{ level: 'L2', kind: 'follow_intent', payload: { count: 1 } }]);
  });

  it('with no publisher it never pulls, and says so once instead of failing quietly', async () => {
    const h = harness({ canvasBaseUrl: null });
    h.rows = [intent(FOLLOWEE, MS - 25 * MIN)];
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    loop.stop();
    expect(h.pulls).toEqual([]);
    expect(h.info.join('\n')).toContain('no publisher configured');
  });

  it('with a publisher configured, it says so once that it started', async () => {
    const h = harness();
    h.rows = [intent(FOLLOWEE, MS - 25 * MIN)];
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    loop.stop();
    expect(h.info.join('\n')).toContain('follow doorbell started');
  });

  it('runs its tick inside the root command lane and under the house gate', async () => {
    const lane: string[] = [];
    const gated: string[] = [];
    const h = harness({
      runCommand: async (work) => {
        lane.push('in');
        try {
          return await work();
        } finally {
          lane.push('out');
        }
      },
      captureGate: (origin) => {
        gated.push(origin);
        return { isActive: () => true, signal: new AbortController().signal };
      },
    });
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    loop.stop();
    expect(lane).toEqual(['in', 'out']);
    expect(gated).toEqual([HOUSE]);
  });

  it('a house the owner is logged out of costs one slow tick, not a spin at zero', async () => {
    const h = harness();
    h.active = false;
    h.rows = [intent(FOLLOWEE, MS - 25 * MIN)];
    const delays: number[] = [];
    const loop = startFollowDoorbell({
      ...h.deps,
      runCommand: async (work) => {
        const d = (await work()) as number;
        delays.push(d);
        return d as never;
      },
    });
    await loop.firstTick;
    loop.stop();
    expect(h.pulls).toEqual([]); // nothing goes on the wire under a dead gate
    expect(delays).toEqual([DOORBELL_SLOW_TICK_MS]);
  });

  it('a root with no push channel absorbs but never CLAIMS the batch it cannot read out', async () => {
    // The MCP/daemon bundle: no `deliverNow`. Claiming is what spends a batch
    // for every root on this data root, and the L1 summary is the only place
    // those names are ever said — so a root that cannot say them must leave
    // the batch claimable by one that can.
    //
    // The batch is seeded rather than pulled, so the quiet window (which holds
    // back anything absorbed this very tick) cannot be what makes this pass.
    const h = harness();
    seedRipeBatch(h.store);
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    loop.stop();
    expect(h.store.listPending()).toHaveLength(1);
    expect(h.store.unreportedFirstTs()).toBe(MS - 25 * MIN); // still unsurfaced
    expect(h.store.listPending()[0]!.first_surfaced_ts).toBeNull();
  });

  it('the same batch, on a root that HAS a push channel, is claimed and delivered', async () => {
    const delivered: string[] = [];
    const h = harness({ deliverNow: async (text) => { delivered.push(text); return true; } });
    seedRipeBatch(h.store);
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    loop.stop();
    expect(delivered).toHaveLength(1);
    expect(h.store.unreportedFirstTs()).toBeNull();
  });

  it('a tick that throws is non-fatal and warns rather than taking the root down', async () => {
    const h = harness({
      pull: async () => {
        throw new Error('canvas down');
      },
      runCommand: async (work) => work(),
    });
    const loop = startFollowDoorbell({
      ...h.deps,
      runCommand: async () => {
        throw new Error('lane closed');
      },
    });
    await expect(loop.firstTick).resolves.toBeUndefined();
    loop.stop();
    expect(h.warn.join('\n')).toContain('follow doorbell tick failed');
  });

  it('opens its own pending store when the root holds none', async () => {
    const h = harness({ store: undefined });
    h.rows = [intent(FOLLOWEE, MS - 25 * MIN)];
    const loop = startFollowDoorbell({ ...h.deps, store: undefined as never });
    await loop.firstTick;
    loop.stop();
    expect(new PendingFollowStore(h.db).listPending()).toHaveLength(1);
  });
});

/**
 * The cadence half: the tier follows the identity that RECEIVES intents.
 *
 * Every assertion here is about SCHEDULING — which timer is in flight and when
 * it fires — read off vitest's fake clock, never off wall time. The root under
 * test never published anything, which is exactly the reader the old
 * publish-derived tier left on the 30-minute probe.
 */
describe('startFollowDoorbell — the viewing signal paces the loop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Fake timers plus a signal and a clock that read the same faked `Date`. */
  function viewingHarness(over: Partial<FollowDoorbellDeps> = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(MS);
    const viewing = createViewingSignal(() => Date.now());
    // Assigned onto the harness rather than spread: its `rows`/`active` are
    // setters over closure state, and a spread would flatten them into dead
    // data properties.
    return Object.assign(harness({ clock: () => Date.now(), viewing, ...over }), { viewing });
  }

  it('a root that never published, whose page-state loop just answered, pulls again on the hot tick', async () => {
    const h = viewingHarness();
    h.viewing.noteAnswer(); // a paired browser of ours opened a paper
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    expect(h.pulls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DOORBELL_HOT_TICK_MS - 1);
    expect(h.pulls).toHaveLength(1); // not a moment early
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pulls).toHaveLength(2); // 90s, not the 30 minutes the old tier gave a reader

    // ... and once the window lapses with no further answers, back to slow:
    // neither a hot nor a warm interval buys another pull.
    await vi.advanceTimersByTimeAsync(DOORBELL_VIEWING_WINDOW_MS + DOORBELL_HOT_TICK_MS);
    const settled = h.pulls.length;
    await vi.advanceTimersByTimeAsync(DOORBELL_WARM_TICK_MS);
    expect(h.pulls).toHaveLength(settled);
    loop.stop();
  });

  it('an answer mid-sleep reschedules the pending pull to the hot tick — not to zero, and not twice', async () => {
    const h = viewingHarness();
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    expect(h.pulls).toHaveLength(1); // then asleep on the 30-minute slow tier

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(h.pulls).toHaveLength(1);

    h.viewing.noteAnswer();
    expect(h.pulls).toHaveLength(1); // does NOT fire immediately: no tight loop
    expect(vi.getTimerCount()).toBe(1); // exactly one timer in flight, never two

    await vi.advanceTimersByTimeAsync(DOORBELL_HOT_TICK_MS - 1);
    expect(h.pulls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pulls).toHaveLength(2); // and not the remaining 25 minutes
    loop.stop();
  });

  it('a second answer inside the shortened sleep does not re-arm it shorter still', async () => {
    const h = viewingHarness();
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    h.viewing.noteAnswer();
    await vi.advanceTimersByTimeAsync(30_000);
    h.viewing.noteAnswer(); // 60s still to run — already sooner than the hot tick
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.pulls).toHaveLength(1); // the original 90s deadline stands
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pulls).toHaveLength(2);
    loop.stop();
  });

  it('failure backoff still wins: an open browser does not un-back-off a failing canvas', async () => {
    let attempts = 0;
    const h = viewingHarness({
      pull: async () => {
        attempts += 1;
        throw new Error('canvas down');
      },
    });
    h.viewing.noteAnswer();
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    expect(attempts).toBe(1); // hot base (viewing), one failure → 180s

    h.viewing.noteAnswer(); // the browser is still open; the canvas is still down
    await vi.advanceTimersByTimeAsync(DOORBELL_HOT_TICK_MS + 1_000);
    expect(attempts).toBe(1); // a shortened sleep would have fired by now
    await vi.advanceTimersByTimeAsync(DOORBELL_HOT_TICK_MS);
    expect(attempts).toBe(2); // the doubled 180s, exactly as before
    loop.stop();
  });

  it('a logged-out house keeps its slow tick: an open browser is not a reason to wake a dead gate', async () => {
    // Counted on the gate, not on the pull: a dead gate pulls nothing either
    // way, so only the number of TICKS can tell a slow loop from a hot one.
    let ticks = 0;
    const h = viewingHarness({
      captureGate: () => {
        ticks += 1;
        return { isActive: () => false, signal: new AbortController().signal };
      },
    });
    h.viewing.noteAnswer();
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    expect(ticks).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    h.viewing.noteAnswer();
    await vi.advanceTimersByTimeAsync(DOORBELL_HOT_TICK_MS + 1_000);
    expect(ticks).toBe(1); // the 30-minute sleep stands
    expect(h.pulls).toHaveLength(0); // and nothing went on the wire
    expect(vi.getTimerCount()).toBe(1); // still exactly the one slow timer
    loop.stop();
  });

  it('stop() unsubscribes from the signal: a later answer arms nothing', async () => {
    const h = viewingHarness();
    const loop = startFollowDoorbell(h.deps);
    await loop.firstTick;
    loop.stop();
    expect(vi.getTimerCount()).toBe(0);
    h.viewing.noteAnswer();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DOORBELL_SLOW_TICK_MS);
    expect(h.pulls).toHaveLength(1);
  });
});

describe('startFollowDoorbell — finite first-trust wake', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('keeps a canceled startup pull stale and starts one independent pull under new permission', async () => {
    vi.useFakeTimers(); vi.setSystemTime(MS);
    let finish!: (rows: FollowIntentRow[]) => void;
    let started!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    const old = new AbortController(); const fresh = new AbortController();
    let current = old;
    const cursors: number[] = [];
    const h = harness({ clock: Date.now,
      captureGate: () => { const captured = current; return { signal: captured.signal, isActive: () => !captured.signal.aborted }; },
      pull: async (_owner, after) => {
        cursors.push(after);
        if (cursors.length === 1) { started(); return new Promise<FollowIntentRow[]>(resolve => { finish = resolve; }); }
        return [intent(FOLLOWEE, MS - MIN)];
      } });
    const loop = startFollowDoorbell(h.deps); await reached;
    old.abort(); current = fresh;
    loop.firstTrustChanged(); loop.firstTrustChanged();
    finish([intent(FOLLOWEE, MS - MIN)]); await loop.firstTick;
    expect(h.store.listPending()).toEqual([]); // old result was canceled
    expect(h.enqueued).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(cursors).toEqual([0, 0]); // no old cursor advance or payload replay
    expect(h.store.listPending()).toHaveLength(1); expect(h.enqueued).toHaveLength(1);
    loop.firstTrustChanged(); await vi.advanceTimersByTimeAsync(1);
    expect(cursors).toHaveLength(2); expect(vi.getTimerCount()).toBe(1);
    loop.stop(); h.db.close();
  });
  it('wakes a blocked startup once but rechecks a logout before the scheduled new tick', async () => {
    vi.useFakeTimers(); const h = harness({ clock: Date.now }); h.active = false;
    const loop = startFollowDoorbell(h.deps); await loop.firstTick;
    h.active = true; loop.firstTrustChanged(); h.active = false;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pulls).toEqual([]); expect(vi.getTimerCount()).toBe(1);
    loop.firstTrustChanged(); await vi.advanceTimersByTimeAsync(1);
    expect(h.pulls).toEqual([]); loop.stop(); h.db.close();
  });
  it.each(['inactive', 'stopped', 'completed', 'backoff'] as const)('a first-trust hint grants no extra work when %s', async state => {
    vi.useFakeTimers(); let attempts = 0;
    const h = harness({ clock: Date.now, pull: async () => { attempts++; if (state === 'backoff') throw new Error('offline'); return []; } });
    if (state === 'inactive' || state === 'stopped') h.active = false;
    const loop = startFollowDoorbell(h.deps); await loop.firstTick;
    if (state === 'stopped') { loop.stop(); h.active = true; }
    loop.firstTrustChanged(); loop.firstTrustChanged(); await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(state === 'completed' || state === 'backoff' ? 1 : 0);
    expect(vi.getTimerCount()).toBe(state === 'stopped' ? 0 : 1);
    loop.stop(); h.db.close();
  });
});
