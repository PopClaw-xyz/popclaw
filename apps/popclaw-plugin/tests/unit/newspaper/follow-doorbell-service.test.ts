import { describe, it, expect, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PendingFollowStore } from '../../../src/social-graph/pending-follow-store.js';
import type { FollowIntentRow } from '../../../src/social-graph/pending-follow-store.js';
import type { FollowableAuthorRow } from '../../../src/newspaper/followable-authors.js';
import {
  surfaceDecision,
  inDeliveryWindow,
  summaryLines,
  buildL1Text,
  doorbellStrings,
  pollIntervalMs,
  tierWithViewing,
  backoffMs,
  createDoorbellService,
  DOORBELL_HOT_TICK_MS,
  DOORBELL_WARM_TICK_MS,
  DOORBELL_SLOW_TICK_MS,
  DOORBELL_VIEWING_WINDOW_MS,
} from '../../../src/newspaper/follow-doorbell-service.js';
import { SAME_PAGE_MIN_INTERVAL_MS } from '../../../src/canvas/sync-answer-client.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const MS = 1_750_000_000_000;
const MIN = 60_000;

/** A production-shaped popclaw id: an author this machine never printed. */
const FOREIGN_ID = '7xKvGjWntCHSPQoyY2mLBRTDdQFEAqNsZz4fCcrKVJ9u';

const T = doorbellStrings('zh-CN');

const p = (display_name: string, descriptor: string | null = null) => ({ display_name, descriptor });

// ---------------------------------------------------------------------------
// Pure decision logic — debounce, window, list, L1 text
// ---------------------------------------------------------------------------

describe('surfaceDecision (double condition, ms everywhere)', () => {
  const firstTs = MS;
  const lastAbsorbAt = MS - 5 * MIN; // quiet long since satisfied on its own

  it('surfaces when first click >= 20min old AND quiet >= 10min', () => {
    expect(surfaceDecision({ firstTs }, lastAbsorbAt, firstTs + 20 * MIN + 5 * MIN)).toEqual({ surface: true });
  });

  it('boundary: 19:59 after first click is not enough (waits exactly the rest)', () => {
    expect(surfaceDecision({ firstTs }, lastAbsorbAt, firstTs + 20 * MIN - 1_000)).toEqual({
      surface: false,
      waitMs: 1_000,
    });
  });

  it('boundary: exactly 20:00 after first click surfaces', () => {
    expect(surfaceDecision({ firstTs }, lastAbsorbAt, firstTs + 20 * MIN)).toEqual({ surface: true });
  });

  it('boundary: 9:59 since last absorb is not enough', () => {
    expect(surfaceDecision({ firstTs: MS - 30 * MIN }, MS, MS + 10 * MIN - 1_000)).toEqual({
      surface: false,
      waitMs: 1_000,
    });
  });

  it('boundary: exactly 10:00 since last absorb surfaces', () => {
    expect(surfaceDecision({ firstTs: MS - 30 * MIN }, MS, MS + 10 * MIN)).toEqual({ surface: true });
  });

  it('waitMs is the longer of the two remainders when both are unsatisfied', () => {
    // first click 15min ago (5min to go), last absorb 3min ago (7min to go).
    const now = MS + 15 * MIN;
    expect(surfaceDecision({ firstTs: MS }, MS + 12 * MIN, now)).toEqual({
      surface: false,
      waitMs: 7 * MIN,
    });
  });

  it('a never-absorbed batch (lastAbsorbAt 0) only waits out the first-click leg', () => {
    expect(surfaceDecision({ firstTs: MS }, 0, MS + 20 * MIN)).toEqual({ surface: true });
  });
});

describe('inDeliveryWindow (8 <= h < 22)', () => {
  it('7 is out, 8 is in, 21 is in, 22 is out', () => {
    expect(inDeliveryWindow(7)).toBe(false);
    expect(inDeliveryWindow(8)).toBe(true);
    expect(inDeliveryWindow(21)).toBe(true);
    expect(inDeliveryWindow(22)).toBe(false);
  });
});

describe('summaryLines', () => {
  it('five entries are all listed, numbered, name #short-sigil (first 4 after #) with descriptor note', () => {
    const pending = [
      p('云舟#3m8v', '写透 XX 那篇'),
      p('阿禾#k2f0'),
      p('levelsio#9xqe', 'a headline'),
      p('青梧#zzzz99', null),
      p('白榆'),
    ];
    expect(summaryLines(pending, T)).toBe(
      '1. 云舟 #3m8v（写透 XX 那篇） 2. 阿禾 #k2f0 3. levelsio #9xqe（a headline） 4. 青梧 #zzzz 5. 白榆',
    );
  });

  it('six entries list five and count the rest (suffix carries its own comma, no extra space)', () => {
    const pending = Array.from({ length: 6 }, (_, i) => p(`人${i}#s${i}000`));
    expect(summaryLines(pending, T)).toBe(
      '1. 人0 #s000 2. 人1 #s100 3. 人2 #s200 4. 人3 #s300 5. 人4 #s400，等 1 位',
    );
  });
});

describe('buildL1Text', () => {
  const pending = [p('云舟#3m8v', '写透 XX 那篇'), p('阿禾#k2f0'), p('levelsio#9xqe')];

  it('pending > 0: head + list + value sentence + reply syntax, no tail without overflow', () => {
    expect(buildL1Text(pending, [], 0, T)).toBe(
      '在报纸上收到 3 位待关注：1. 云舟 #3m8v（写透 XX 那篇） 2. 阿禾 #k2f0 3. levelsio #9xqe' +
        ' —— 关注后，他们的新帖和动向会进你的日报。回「都要」或数字（如「1 3」）都行，没点到的当跳过；「不要」=这批都不要',
    );
  });

  it('pending > 0 with overflow: the cap note and the link-holder tail both appear', () => {
    const text = buildL1Text(pending, [], 3, T)!;
    expect(text).toContain('另有 3 位因量多未记（其中可能包含他人点的）');
    expect(text).toContain('报纸链接别人也能点——非你所点，直接回「不要」');
    expect(text.endsWith('直接回「不要」')).toBe(true);
  });

  it('pending = 0, dropped > 0: the micro notice names them once, display names verbatim', () => {
    expect(buildL1Text([], [{ display_name: '云舟#3m8v' }, { display_name: 'levelsio#9xqe' }], 0, T)).toBe(
      '今天点的 2 位（云舟#3m8v、levelsio#9xqe）都已在关注里，没重复记',
    );
  });

  it('both empty: null (no push at all)', () => {
    expect(buildL1Text([], [], 0, T)).toBeNull();
  });
});

describe('doorbellStrings (lexicon)', () => {
  it('every key resolves in both languages, and no composition leaves a placeholder behind', () => {
    for (const lang of ['en', 'zh-CN'] as const) {
      const s = doorbellStrings(lang);
      expect(s.head.length + s.entry.length + s.valueSentence.length).toBeGreaterThan(0);
    }
    const overflowText = buildL1Text([p('云舟#3m8v', '写透 XX 那篇')], [{ display_name: '阿禾#k2f0' }], 2, doorbellStrings('en'));
    expect(overflowText).not.toContain('{');
    expect(buildL1Text([], [{ display_name: '阿禾#k2f0' }], 0, doorbellStrings('en'))).not.toContain('{');
  });

  it('renders the design L1 in zh (words byte-for-byte; entries joined with one consistent space)', () => {
    expect(buildL1Text([p('云舟#3m8v', '写透 XX 那篇'), p('阿禾#k2f0'), p('levelsio#9xqe')], [], 0, T)).toBe(
      '在报纸上收到 3 位待关注：1. 云舟 #3m8v（写透 XX 那篇） 2. 阿禾 #k2f0 3. levelsio #9xqe' +
        ' —— 关注后，他们的新帖和动向会进你的日报。回「都要」或数字（如「1 3」）都行，没点到的当跳过；「不要」=这批都不要',
    );
  });
});

// ---------------------------------------------------------------------------
// Poll tiering + backoff (pure)
// ---------------------------------------------------------------------------

describe('pollIntervalMs (followable_authors tiering)', () => {
  const TTL = 48 * 60 * 60 * 1000;

  it('no unexpired rows: 30min slow probe', () => {
    expect(pollIntervalMs([], MS)).toBe(DOORBELL_SLOW_TICK_MS);
  });

  it('earliest publish under 2h old: 90s hot tick', () => {
    expect(pollIntervalMs([{ expires_at: MS + TTL - 30 * MIN }], MS)).toBe(DOORBELL_HOT_TICK_MS);
  });

  it('earliest publish exactly 2h old is already warm (5min), as is anything older', () => {
    expect(pollIntervalMs([{ expires_at: MS + TTL - 2 * 60 * MIN }], MS)).toBe(DOORBELL_WARM_TICK_MS);
    expect(pollIntervalMs([{ expires_at: MS + TTL - 3 * 60 * MIN }], MS)).toBe(DOORBELL_WARM_TICK_MS);
  });

  it('a fresher second issue does not un-hot an older unexpired one (spec: earliest decides)', () => {
    expect(
      pollIntervalMs([{ expires_at: MS + TTL - 3 * 60 * MIN }, { expires_at: MS + TTL - 5 * MIN }], MS),
    ).toBe(DOORBELL_WARM_TICK_MS);
  });
});

describe('tierWithViewing (the tier follows the reader, not the publisher)', () => {
  it('no answer ever: the publish-based tier is the whole answer', () => {
    expect(tierWithViewing(DOORBELL_SLOW_TICK_MS, null, MS)).toBe(DOORBELL_SLOW_TICK_MS);
    expect(tierWithViewing(DOORBELL_WARM_TICK_MS, null, MS)).toBe(DOORBELL_WARM_TICK_MS);
  });

  it('a fresh page-state answer puts a root that never published on the hot tick', () => {
    expect(tierWithViewing(DOORBELL_SLOW_TICK_MS, MS - MIN, MS)).toBe(DOORBELL_HOT_TICK_MS);
    expect(tierWithViewing(DOORBELL_WARM_TICK_MS, MS - MIN, MS)).toBe(DOORBELL_HOT_TICK_MS);
  });

  it('boundary: one ms inside the window is still hot, exactly the window is not', () => {
    expect(tierWithViewing(DOORBELL_SLOW_TICK_MS, MS - DOORBELL_VIEWING_WINDOW_MS + 1, MS)).toBe(
      DOORBELL_HOT_TICK_MS,
    );
    expect(tierWithViewing(DOORBELL_SLOW_TICK_MS, MS - DOORBELL_VIEWING_WINDOW_MS, MS)).toBe(
      DOORBELL_SLOW_TICK_MS,
    );
  });

  it('it only ever takes the FASTER of the two: a hot publish tier is never slowed by viewing', () => {
    expect(tierWithViewing(DOORBELL_HOT_TICK_MS, null, MS)).toBe(DOORBELL_HOT_TICK_MS);
    expect(tierWithViewing(DOORBELL_HOT_TICK_MS, MS - MIN, MS)).toBe(DOORBELL_HOT_TICK_MS);
  });

  it('the window outlives the same-page answer brake, or a page left open would flicker out of hot', () => {
    // The plugin answers about one page at most every SAME_PAGE_MIN_INTERVAL_MS
    // (5min), so anything at or under that would drop the tier between two
    // answers about the page the reader is still looking at.
    expect(DOORBELL_VIEWING_WINDOW_MS).toBeGreaterThan(SAME_PAGE_MIN_INTERVAL_MS);
    expect(DOORBELL_VIEWING_WINDOW_MS).toBe(10 * MIN);
  });
});

describe('backoffMs', () => {
  it('doubles per consecutive failure, capped at the 30min slow tick; success resets via failCount 0', () => {
    expect(backoffMs(DOORBELL_HOT_TICK_MS, 0)).toBe(90_000);
    expect(backoffMs(DOORBELL_HOT_TICK_MS, 1)).toBe(180_000);
    expect(backoffMs(DOORBELL_HOT_TICK_MS, 4)).toBe(1_440_000);
    expect(backoffMs(DOORBELL_HOT_TICK_MS, 5)).toBe(DOORBELL_SLOW_TICK_MS);
    expect(backoffMs(DOORBELL_WARM_TICK_MS, 2)).toBe(20 * MIN);
    expect(backoffMs(DOORBELL_SLOW_TICK_MS, 3)).toBe(DOORBELL_SLOW_TICK_MS);
  });
});

// ---------------------------------------------------------------------------
// Service shell — tick with everything injected
// ---------------------------------------------------------------------------

interface PullStep {
  after: number;
  rows?: FollowIntentRow[];
  error?: Error;
}

function intent(followee: string, firstTs: number, latestTs = firstTs): FollowIntentRow {
  return {
    owner_popclaw_id: 'self',
    followee_popclaw_id: followee,
    followee_label: `${followee}-label`,
    first_ts: firstTs,
    latest_ts: latestTs,
    click_count: 1,
  };
}

function authorRow(
  popclaw_id: string,
  over: Partial<FollowableAuthorRow> = {},
): FollowableAuthorRow {
  return {
    issue_date: '2026-08-31',
    popclaw_id,
    display_name: `${popclaw_id}名#sig${popclaw_id}`,
    descriptor: `desc-${popclaw_id}`,
    expires_at: MS + 48 * 60 * 60 * 1000,
    ...over,
  };
}

function makeShell(opts: { follows?: string[] } = {}) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const store = new PendingFollowStore(db);
  let nowMs = MS;
  let hour = 12;
  let authorRows: FollowableAuthorRow[] = [];
  const pulls: PullStep[] = [];
  const pullCalls: number[] = [];
  const enqueued: Array<{ level: string; kind: string; payload: Record<string, unknown> }> = [];
  const delivered: string[] = [];
  const warns: string[] = [];
  let lastViewingAnswerMs: number | null = null;
  const svc = createDoorbellService({
    ownerPopclawId: 'self',
    lastViewingAnswerMs: () => lastViewingAnswerMs,
    pull: async (_owner, afterMs) => {
      pullCalls.push(afterMs);
      const step = pulls.shift();
      if (!step) return [];
      if (step.error) throw step.error;
      if (step.after !== afterMs) throw new Error(`pull cursor: expected after=${step.after}, got ${afterMs}`);
      return step.rows ?? [];
    },
    store,
    followsIn: (id) => (opts.follows ?? []).includes(id),
    readFollowableAuthors: () => authorRows,
    notifier: { enqueue: (i) => enqueued.push(i) },
    deliverNow: async (text) => {
      delivered.push(text);
      return true;
    },
    clock: () => nowMs,
    localHour: () => hour,
    strings: () => doorbellStrings('zh-CN'),
    logger: { info: () => {}, warn: (m) => warns.push(m) },
  });
  return {
    svc, store, db, enqueued, delivered, warns, pullCalls,
    get pulls() { return pulls; },
    get authorRows() { return authorRows; },
    set authorRows(v: FollowableAuthorRow[]) { authorRows = v; },
    set nowMs(v: number) { nowMs = v; },
    get nowMs() { return nowMs; },
    set hour(v: number) { hour = v; },
    set lastViewingAnswerMs(v: number | null) { lastViewingAnswerMs = v; },
  };
}

describe('createDoorbellService.tick — tiering and cursor', () => {
  it('hot issue (fresh publish) → 90s; warm → 5min; no paper of our own → 30min, and every tier still pulls', async () => {
    const h = makeShell();
    h.authorRows = [authorRow('B', { expires_at: MS + 48 * 60 * 60 * 1000 - 30 * MIN })];
    expect(await h.svc.tick()).toBe(DOORBELL_HOT_TICK_MS);
    h.authorRows = [authorRow('B', { expires_at: MS + 48 * 60 * 60 * 1000 - 3 * 60 * MIN })];
    expect(await h.svc.tick()).toBe(DOORBELL_WARM_TICK_MS);
    h.authorRows = [];
    expect(await h.svc.tick()).toBe(DOORBELL_SLOW_TICK_MS);
    // Owner ruling 2026-09-13: intents are credited to the READER, so a
    // machine that has published nothing still has its own clicks waiting on
    // other people's papers. Our own author set only paces the loop now.
    expect(h.pullCalls).toEqual([0, 0, 0]);
  });

  it('a root that never published but is being READ right now polls hot, and goes slow again when the window lapses', async () => {
    // The defect this replaces: the tier read the publisher's own
    // `followable_authors`, so the identity that actually RECEIVES intents —
    // the reader who just clicked ➕ — sat on the 30-minute probe for ever.
    const h = makeShell();
    h.authorRows = []; // never published anything
    h.lastViewingAnswerMs = MS - MIN;
    expect(await h.svc.tick()).toBe(DOORBELL_HOT_TICK_MS);
    h.lastViewingAnswerMs = MS - DOORBELL_VIEWING_WINDOW_MS;
    expect(await h.svc.tick()).toBe(DOORBELL_SLOW_TICK_MS);
  });

  it('a failing pull still backs off from the viewing-derived tier, not around it', async () => {
    const h = makeShell();
    h.authorRows = [];
    h.lastViewingAnswerMs = MS - MIN;
    h.pulls.push({ after: 0, error: new Error('canvas down') });
    expect(await h.svc.tick()).toBe(180_000); // 90s hot, doubled once
  });

  it('pull cursor starts at 0 and advances to the batch max latest_ts; empty batches keep it', async () => {
    const h = makeShell();
    h.authorRows = [authorRow('B'), authorRow('C')];
    h.pulls.push({ after: 0, rows: [intent('B', MS - 25 * MIN, MS - 24 * MIN), intent('C', MS - 20 * MIN, MS - 20 * MIN)] });
    await h.svc.tick();
    expect(h.pullCalls).toEqual([0]);
    h.pulls.push({ after: MS - 20 * MIN, rows: [] });
    await h.svc.tick();
    expect(h.pullCalls).toEqual([0, MS - 20 * MIN]);
    h.pulls.push({ after: MS - 20 * MIN, rows: [] });
    await h.svc.tick();
    expect(h.pullCalls).toEqual([0, MS - 20 * MIN, MS - 20 * MIN]);
  });

  it('a failed pull backs off exponentially, keeps its cursor, and a success resets the delay', async () => {
    const h = makeShell();
    h.authorRows = [authorRow('B', { expires_at: MS + 48 * 60 * 60 * 1000 - 30 * MIN })];
    h.pulls.push({ after: 0, error: new Error('canvas down') });
    expect(await h.svc.tick()).toBe(180_000);
    h.pulls.push({ after: 0, error: new Error('canvas down') });
    expect(await h.svc.tick()).toBe(360_000);
    expect(h.pullCalls).toEqual([0, 0]); // cursor did not advance on failure
    expect(h.warns.length).toBeGreaterThan(0);
    h.pulls.push({ after: 0, rows: [] });
    expect(await h.svc.tick()).toBe(DOORBELL_HOT_TICK_MS);
  });

  it.each([undefined, null, 'bad-time', String(MS), NaN, Infinity, -Infinity, Number.MAX_VALUE, 1e100, MS + 0.5])(
    'rejects a mixed batch with latest_ts=%s without absorbing or advancing its cursor', async (latestTs) => {
      const h = makeShell();
      h.authorRows = [authorRow('B'), authorRow('C'), authorRow('D')];
      const previous = MS - 25 * MIN;
      h.pulls.push({ after: 0, rows: [intent('B', previous)] });
      await h.svc.tick();
      const pending = intent('C', MS - MIN);
      const invalid = { ...intent('D', MS - MIN), latest_ts: latestTs } as unknown as FollowIntentRow;
      h.pulls.push({ after: previous, rows: [pending, invalid] });
      expect(await h.svc.tick()).toBe(2 * DOORBELL_HOT_TICK_MS);
      expect(h.svc.backingOff()).toBe(true);
      expect(h.store.listPending().map((row) => row.followee_popclaw_id)).toEqual(['B']);
      expect(h.enqueued).toHaveLength(1);
      expect(h.delivered).toEqual([]);

      h.pulls.push({ after: previous, rows: [pending, intent('D', MS - MIN)] });
      expect(await h.svc.tick()).toBe(DOORBELL_HOT_TICK_MS);
      expect(h.svc.backingOff()).toBe(false);
      h.pulls.push({ after: MS - MIN, rows: [] });
      await h.svc.tick();
      expect(h.pullCalls).toEqual([0, previous, previous, MS - MIN]);
      expect(h.store.listPending().map((row) => row.followee_popclaw_id)).toEqual(['B', 'C', 'D']);
      expect(h.enqueued).toHaveLength(2);
    },
  );

  it.each([Number.MAX_SAFE_INTEGER + 1, MS + 0.5])('rejects invalid first_ts=%s before changing the batch', async (firstTs) => {
    const h = makeShell();
    h.authorRows = [authorRow('B')];
    h.pulls.push({ after: 0, rows: [intent('B', firstTs, MS)] });
    expect(await h.svc.tick()).toBe(2 * DOORBELL_HOT_TICK_MS);
    expect(h.store.listPending()).toEqual([]);
    expect(h.enqueued).toEqual([]);
    h.pulls.push({ after: 0, rows: [intent('B', MS)] });
    expect(await h.svc.tick()).toBe(DOORBELL_HOT_TICK_MS);
    expect(h.pullCalls).toEqual([0, 0]);
    expect(h.store.listPending()).toHaveLength(1);
  });

  it('keeps the initial cursor at zero after a missing timestamp instead of sending NaN on later pulls', async () => {
    const h = makeShell();
    h.authorRows = [authorRow('B')];
    const invalid: Partial<FollowIntentRow> = intent('B', MS - MIN);
    delete invalid.latest_ts;
    h.pulls.push({ after: 0, rows: [invalid as FollowIntentRow] });
    await h.svc.tick();
    h.pulls.push({ after: 0, rows: [intent('B', MS - MIN)] });
    await h.svc.tick();
    await h.svc.tick();
    expect(h.pullCalls).toEqual([0, 0, MS - MIN]);
    expect(h.store.listPending()).toHaveLength(1);
  });

  it('still advances over well-formed refused intents without adding pending rows', async () => {
    const h = makeShell();
    h.pulls.push({ after: 0, rows: [intent('self', MS - 2 * MIN), intent('invalid-id', MS - MIN)] });
    await h.svc.tick();
    await h.svc.tick();
    expect(h.pullCalls).toEqual([0, MS - MIN]);
    expect(h.store.listPending()).toEqual([]);
    expect(h.svc.backingOff()).toBe(false);
  });

  it('keeps the cursor when absorption rolls back and retries the valid batch once', async () => {
    const h = makeShell();
    h.authorRows = [authorRow('B'), authorRow('C')];
    const rows = [intent('B', MS - 2 * MIN), intent('C', MS - MIN)];
    const followsIn = vi.spyOn(h.store, 'absorb').mockImplementationOnce((intents, opts) => {
      return PendingFollowStore.prototype.absorb.call(h.store, intents, {
        ...opts,
        followsIn: (id) => {
          if (id === 'C') throw new Error('absorption failed on second row');
          return false;
        },
      });
    });
    h.pulls.push({ after: 0, rows });
    expect(await h.svc.tick()).toBe(2 * DOORBELL_HOT_TICK_MS);
    expect(h.store.listPending()).toEqual([]);
    expect(h.enqueued).toEqual([]);
    h.pulls.push({ after: 0, rows });
    expect(await h.svc.tick()).toBe(DOORBELL_HOT_TICK_MS);
    await h.svc.tick();
    expect(h.pullCalls).toEqual([0, 0, MS - MIN]);
    expect(h.store.listPending().map((row) => row.followee_popclaw_id)).toEqual(['B', 'C']);
    expect(h.enqueued).toEqual([{ level: 'L2', kind: 'follow_intent', payload: { count: 2 } }]);
    followsIn.mockRestore();
  });
});

describe('createDoorbellService.tick — the never-throw contract', () => {
  it('resolves (backing off) instead of rejecting when the author-set read itself throws', async () => {
    const h = makeShell();
    h.authorRows = [authorRow('B')];
    const svc = createDoorbellService({
      ownerPopclawId: 'self',
      pull: async () => [],
      store: h.store,
      followsIn: () => false,
      readFollowableAuthors: () => {
        throw new Error('social db exploded');
      },
      notifier: { enqueue: () => {} },
      deliverNow: async () => true,
      clock: () => MS,
      localHour: () => 12,
      strings: () => doorbellStrings('zh-CN'),
      logger: { info: () => {}, warn: () => {} },
    });
    // tier read failed before the tier was known → falls back to the slow
    // interval and counts as one failure (the slow cap absorbs the rung)
    await expect(svc.tick()).resolves.toBe(DOORBELL_SLOW_TICK_MS);
  });
});

describe('createDoorbellService.tick — absorb wiring and L2', () => {
  it('absorbs pulled intents against the unexpired author set via followsIn; strangers never land', async () => {
    const h = makeShell();
    h.authorRows = [authorRow('B')];
    h.pulls.push({ after: 0, rows: [intent('B', MS - 25 * MIN), intent('X', MS - 25 * MIN)] });
    await h.svc.tick();
    expect(h.store.listPending().map((r) => r.followee_popclaw_id)).toEqual(['B']);
    expect(h.store.listPending()[0]).toMatchObject({ display_name: 'B名#sigB', descriptor: 'desc-B' });
  });

  it('a followee from someone else\'s paper is absorbed too, named by the intent label (owner ruling 2026-09-13)', async () => {
    const h = makeShell();
    h.authorRows = []; // this machine published nothing; the click happened on a friend's paper
    h.pulls.push({ after: 0, rows: [{ ...intent(FOREIGN_ID, MS - 25 * MIN), followee_label: '云舟#3m8v' }] });
    await h.svc.tick();
    expect(h.store.listPending()).toHaveLength(1);
    expect(h.store.listPending()[0]).toMatchObject({
      followee_popclaw_id: FOREIGN_ID,
      display_name: '云舟#3m8v',
      descriptor: doorbellStrings('zh-CN').foreignDescriptor,
    });
  });

  it('new pending absorption enqueues one L2 follow_intent with the pending total', async () => {
    const h = makeShell();
    h.authorRows = [authorRow('B'), authorRow('C')];
    h.pulls.push({ after: 0, rows: [intent('B', MS - 25 * MIN), intent('C', MS - 25 * MIN)] });
    await h.svc.tick();
    expect(h.enqueued).toEqual([{ level: 'L2', kind: 'follow_intent', payload: { count: 2 } }]);
  });

  it('a dropped-only batch refreshes the quiet clock but enqueues no L2', async () => {
    const h = makeShell({ follows: ['B'] });
    h.authorRows = [authorRow('B')];
    h.pulls.push({ after: 0, rows: [intent('B', MS - 25 * MIN)] });
    await h.svc.tick();
    expect(h.enqueued).toEqual([]);
    expect(h.store.listPending()).toEqual([]); // an already-followed author is never offered again
    expect(h.store.hasDroppedUnreported()).toEqual([{ display_name: 'B名#sigB' }]);
    // first click 25min old but the click just arrived: quiet window must hold it back
    expect(h.delivered).toEqual([]);
  });

  it('same author in two live issues: the newer issue supplies the display fields', async () => {
    const h = makeShell();
    h.authorRows = [
      authorRow('B', { issue_date: '2026-08-30', display_name: '旧名#old0', descriptor: '旧文' }),
      authorRow('B', { issue_date: '2026-08-31', display_name: '新名#new0', descriptor: '新文' }),
    ];
    h.pulls.push({ after: 0, rows: [intent('B', MS - 25 * MIN)] });
    await h.svc.tick();
    expect(h.store.listPending()[0]).toMatchObject({ display_name: '新名#new0', descriptor: '新文' });
  });
});

describe('createDoorbellService.tick — surfacing (mutex, window, expiry)', () => {
  function shellWithPending(over: { follows?: string[] } = {}) {
    const h = makeShell(over);
    h.authorRows = [authorRow('B')];
    h.pulls.push({ after: 0, rows: [intent('B', MS - 25 * MIN, MS - 24 * MIN)] });
    return h;
  }

  it('does not surface on the absorb tick; surfaces on the next quiet tick via claim, exactly once', async () => {
    const h = shellWithPending();
    await h.svc.tick(); // absorb at MS; quiet since absorb = 0
    expect(h.delivered).toEqual([]);
    h.nowMs = MS + 11 * MIN; // 36min since first click, 11min quiet
    h.pulls.push({ after: MS - 24 * MIN, rows: [] });
    await h.svc.tick();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toContain('在报纸上收到 1 位待关注');
    expect(h.delivered[0]).toContain('1. B名 #sigB（desc-B）');
    expect(h.delivered[0]).not.toContain('报纸链接别人也能点'); // overflow 0 → no tail
    // the claim consumed the batch: nothing re-delivers on later ticks
    h.nowMs = MS + 30 * MIN;
    await h.svc.tick();
    expect(h.delivered).toHaveLength(1);
  });

  it('out of the delivery window: holds without claiming, delivers at the 8am opening', async () => {
    const h = shellWithPending();
    await h.svc.tick();
    h.nowMs = MS + 11 * MIN;
    h.hour = 23;
    h.pulls.push({ after: MS - 24 * MIN, rows: [] });
    await h.svc.tick();
    expect(h.delivered).toEqual([]);
    expect(h.store.listPending()[0]?.first_surfaced_ts).toBeNull(); // not claimed while held
    h.hour = 8;
    h.nowMs = MS + 12 * MIN;
    await h.svc.tick();
    expect(h.delivered).toHaveLength(1);
  });

  it('overflow from the absorb tick rides along on the eventual L1 (cap note + link tail)', async () => {
    const h = makeShell();
    const ids = Array.from({ length: 21 }, (_, i) => `P${i}`);
    h.authorRows = ids.map((id) => authorRow(id));
    h.pulls.push({
      after: 0,
      rows: ids.map((id, i) => intent(id, MS - 25 * MIN + i, MS - 24 * MIN)),
    });
    await h.svc.tick(); // cap 20 → overflow 1
    expect(h.store.listPending()).toHaveLength(20);
    h.nowMs = MS + 11 * MIN;
    h.pulls.push({ after: MS - 24 * MIN, rows: [] });
    await h.svc.tick();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toContain('，等 15 位');
    expect(h.delivered[0]).toContain('另有 1 位因量多未记（其中可能包含他人点的）');
    expect(h.delivered[0]).toContain('报纸链接别人也能点——非你所点，直接回「不要」');
  });

  it('a dropped-only batch surfaces the micro notice after the quiet window', async () => {
    const h = makeShell({ follows: ['B'] });
    h.authorRows = [authorRow('B')];
    h.pulls.push({ after: 0, rows: [intent('B', MS - 25 * MIN, MS - 24 * MIN)] });
    await h.svc.tick();
    expect(h.delivered).toEqual([]);
    h.nowMs = MS + 11 * MIN;
    h.pulls.push({ after: MS - 24 * MIN, rows: [] });
    await h.svc.tick();
    expect(h.delivered).toEqual(['今天点的 1 位（B名#sigB）都已在关注里，没重复记']);
  });

  it('rows past the 48h TTL are expired by the sweep before they could surface', async () => {
    const h = makeShell();
    h.authorRows = [authorRow('B')];
    h.pulls.push({ after: 0, rows: [intent('B', MS - 49 * 60 * MIN, MS - 49 * 60 * MIN)] });
    await h.svc.tick();
    expect(h.delivered).toEqual([]);
    expect(h.store.listPending()).toEqual([]);
    expect(
      dbStatus(h.db, 'B'),
    ).toBe('expired');
  });
});

function dbStatus(db: InMemoryHostDb, followee: string): string | null {
  return db.queryOne<{ status: string }>('SELECT status FROM pending_follows WHERE followee_popclaw_id = ?', [
    followee,
  ])?.status ?? null;
}
