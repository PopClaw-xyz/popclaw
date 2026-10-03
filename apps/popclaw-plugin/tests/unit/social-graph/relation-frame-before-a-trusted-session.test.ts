/**
 * A relation frame that arrives before this house has a trusted, live session.
 *
 * On a fresh data root that is the ordinary case, not an edge case. The
 * resource set attaches the chain before it opens the stream, and the trust
 * pin that attach needs is written a few hundred milliseconds later by a loop
 * nobody awaits — so the attach refuses, and nothing ever asked again. The
 * stream itself was fine: mail flowed, the house delivered the follow, and the
 * frame hit one line on stderr and was gone. Observed on a real host on
 * 2026-09-20, where both `followed_you` notices came from the 30-minute poll
 * instead.
 *
 * Gone, not delayed. The transport position a frame carries is written by its
 * COMMIT, so a dropped frame acknowledges nothing — but the connection stays
 * open, the frames behind it commit once a session does appear, and the cursor
 * steps clean over the one that never landed. Nothing re-reads it.
 *
 * So the frame is HELD, the attach is retried on the drain tick that already
 * exists, and the held frames go to the ordinary commit boundary the moment a
 * session stands up. What is not relaxed is the rule itself: an untrusted
 * session still commits nothing, which the control below is there to prove.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { openRelationReception } from '../../../src/social-graph/relation-reception.js';
import {
  KnownFollowersStore,
  announceVerifiedFollowers,
  type FollowerSyncDeps,
} from '../../../src/social-graph/followers-sync.js';
import { grantingReadAuthorityFor } from '../../helpers/read-authority.js';
import { establishHouseTrust } from '../../../src/world/house-trust.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ORIGIN = 'https://late-trust.test';
const SLUG = hostDbSlug(ORIGIN);

const ownerKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
const ME = bs58.encode(ownerKp.publicKey);
const followerKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
const FOLLOWER = bs58.encode(followerKp.publicKey);

function followFrame(houseKey: string, seq: string): Uint8Array {
  const env = {
    actor: { popclawId: FOLLOWER },
    target: {},
    lorehouse: houseKey,
    timestamp: 1_713_657_600,
    followDeclared: { followeePopclawId: ME, order: { seq, houseKey } },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, followerKp.secretKey),
  }).finish();
}

/**
 * Only `Date` is faked, and only so a test can step past the attach retry's
 * backoff without waiting it out in real seconds. The timer functions stay
 * real, because `settle()` below joins the work on the microtask/immediate
 * queue rather than on a clock.
 */
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

/** Step the clock past any backoff the retry may be sitting on. */
const stepPastBackoff = (): void => { vi.setSystemTime(Date.now() + 10 * 60_000); };

/** The retry and the flush are started from the tick, not awaited by it. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((done) => { setImmediate(done); });
};

/** `event <id>` out of a deferral or processing line, so the two can be paired. */
function eventIdIn(line: string): string {
  return /\(event ([^)]+)\)/.exec(line)?.[1] ?? '';
}

async function host() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const minted = mintHouse({ origin: ORIGIN, manifest: { relations: { ordered: 1 } } });
  // A house that can be taken off the air. Counting the MANIFEST reads is how
  // the retry's rate is measured: the confirm reaches the wire only once the
  // pin and the participation are both in place, so every one of these is one
  // attach attempt that actually cost a round trip.
  let manifestFails = false;
  let manifestReads = 0;
  const houseFetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string }).url ?? input);
    if (url.includes('/v1/manifest')) {
      manifestReads += 1;
      if (manifestFails) return new Response('down', { status: 503 });
    }
    return minted.fetch(input);
  }) as unknown as typeof globalThis.fetch;
  const logs: string[] = [];
  const followerDeps: FollowerSyncDeps = {
    ownerPopclawId: ME,
    store: new KnownFollowersStore(db, () => 1000),
    notifier: new SqliteNotifier(db, () => 1000),
    socialGraph: { following: () => [] },
    // No poll runs in this file at all, and a house that refuses the list
    // could not be the reason anybody was announced if one did.
    fetch: (async () => new Response('unavailable', { status: 503 })) as unknown as typeof globalThis.fetch,
    readAuthorityFor: grantingReadAuthorityFor,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  };

  const r = await openRelationReception({
    db,
    recipientPopclawId: ME,
    signer: {} as never,
    // Granting, because the credential is not what these cases are about and
    // a fixture signer that throws would decide the outcome here for a reason
    // that has nothing to do with follows.
    readAuthorityFor: grantingReadAuthorityFor,
    onMessage: () => {},
    fetch: houseFetch,
    notifyNewFollowers: (news) => announceVerifiedFollowers(followerDeps, news),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    // Long enough never to fire on its own; `start()` runs one tick by hand.
    drainIntervalMs: 600_000,
  });
  const house = { slug: SLUG, baseUrl: ORIGIN } as never;

  return {
    db, minted, house, logs,
    reception: r,
    attach: () => r.hooks.attachRelations!(house, {} as never),
    frame: (seq = '1', position = '1.1') =>
      r.hooks.onFrame!(house, {} as never, followFrame(minted.houseKey, seq), position),
    resumeFrom: () => r.hooks.resumeFrom!(house, {} as never),
    /** What the default-house pinning loop commits a moment after boot. */
    trustLands: async () => {
      const first = await establishHouseTrust(db, ORIGIN, { fetch: minted.fetch as never });
      if (!first.ok) throw new Error(`fixture could not establish trust: ${first.refusal}`);
      r.host.wiring.login({ houseKey: minted.houseKey, incarnation: minted.incarnation, houseSlug: SLUG });
    },
    tick: async () => { stepPastBackoff(); r.host.start(); await settle(); },
    /** One tick that does NOT skip the backoff — the clock moves by `ms` only. */
    tickAfter: async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
      r.host.start();
      await settle();
    },
    houseGoesDown: () => { manifestFails = true; },
    houseComesBack: () => { manifestFails = false; },
    manifestReads: () => manifestReads,
    /** End this session the way a leave elsewhere does, then log back in. */
    sessionEndsAndReturns: () => {
      r.host.leave(SLUG);
      r.host.wiring.login({ houseKey: minted.houseKey, incarnation: minted.incarnation, houseSlug: SLUG });
    },
    edges: () => db.queryAll<{ follower_popclaw_id: string; state: string }>(
      'SELECT follower_popclaw_id, state FROM relation_edges'),
    announced: () => db.queryAll<{ kind: string; payload_json: string }>(
      'SELECT kind, payload_json FROM notification_queue ORDER BY id',
    ).map((row) => ({
      kind: row.kind,
      follower: String((JSON.parse(row.payload_json) as { followerPopclawId?: string }).followerPopclawId ?? ''),
    })),
    baselines: () => db.queryAll('SELECT house_slug FROM known_followers_baseline'),
    lines: (fragment: string) => logs.filter((l) => l.includes(fragment)),
    stop: () => { r.stop(); db.close(); },
  };
}

describe('a relation frame that reaches a house with no trusted session yet', () => {
  it('is applied and announced once the session stands up, with no poll involved', async () => {
    const t = await host();
    // The boot order a fresh data root actually has: the chain is asked to
    // attach before anything has pinned the house, and refuses.
    expect(await t.attach()).toEqual({ ok: false, reason: 'HOUSE_NOT_TRUSTED' });

    // The house delivers the follow anyway — its stream is perfectly healthy.
    await t.frame();
    const deferred = t.lines('relation frame deferred at');
    expect(deferred).toHaveLength(1);
    // Nothing has been applied, and no cursor has moved past it.
    expect(t.edges()).toEqual([]);
    expect(t.resumeFrom()).toBeUndefined();

    // The pinning loop commits, a fraction of a second into boot.
    await t.trustLands();

    // The tick that already exists retries the attach and hands over what it
    // held; the next one turns it into business state.
    await t.tick();
    await t.tick();

    expect(t.edges()).toEqual([{ follower_popclaw_id: FOLLOWER, state: 'following' }]);
    expect(t.announced()).toEqual([{ kind: 'followed_you', follower: FOLLOWER }]);
    // No poll pass ran, and none could have: nothing wrote a baseline.
    expect(t.baselines()).toEqual([]);
    // The cursor now stands exactly where the held frame put it.
    expect(t.resumeFrom()).toBe('1.1');

    // And the pair a reader of the log can match: the frame that was deferred
    // is the frame that was processed.
    const processed = t.lines('relation frame processed after deferral at');
    expect(processed).toHaveLength(1);
    expect(eventIdIn(processed[0]!)).toBe(eventIdIn(deferred[0]!));
    expect(eventIdIn(deferred[0]!)).not.toBe('');
    t.stop();
  });

  it('applies nothing while the session stays untrusted — the control', async () => {
    const t = await host();
    await t.attach();
    await t.frame();

    // Ticks all it likes: no pin, no session, nothing committed. The retry is
    // a retry, not a way around the confirm.
    await t.tick();
    await t.tick();
    await t.tick();

    expect(t.edges()).toEqual([]);
    expect(t.announced()).toEqual([]);
    // Held, not dropped — the difference the case above depends on.
    expect(t.lines('relation frame deferred at')).toHaveLength(1);
    expect(t.lines('relation frame processed after deferral at')).toEqual([]);
    t.stop();
  });

  it('keeps held frames in the order the house sent them', async () => {
    const t = await host();
    await t.attach();
    await t.frame('1', '1.1');
    await t.frame('2', '1.2');
    await t.trustLands();
    await t.tick();
    await t.tick();

    const processed = t.lines('relation frame processed after deferral at');
    const deferred = t.lines('relation frame deferred at');
    expect(processed).toHaveLength(2);
    expect(processed.map(eventIdIn)).toEqual(deferred.map(eventIdIn));
    // The later position wins, which it can only do if the earlier frame was
    // committed first.
    expect(t.resumeFrom()).toBe('1.2');
    // One edge, one announcement: two frames from the same follower are one
    // fact however they were held.
    expect(t.announced()).toEqual([{ kind: 'followed_you', follower: FOLLOWER }]);
    t.stop();
  });

  it('asks again on the re-auth ladder, not once every tick', async () => {
    const t = await host();
    // The pathological shape: the pin stands, so the confirm gets as far as
    // the wire — and the house keeps refusing there. Without a rate, a held
    // frame would buy this house a round trip every couple of seconds for as
    // long as it stayed down.
    await t.trustLands();
    t.houseGoesDown();
    expect((await t.attach()).ok).toBe(false);
    await t.frame();
    const afterFirstRetry = t.manifestReads();

    // Sixty seconds of ticks at the production cadence.
    for (let i = 0; i < 30; i += 1) await t.tickAfter(2_000);
    const asked = t.manifestReads() - afterFirstRetry;

    // The ladder doubles from a second, so a minute buys five or six tries.
    // The assertion that matters is the gap between the two numbers: thirty
    // ticks, nowhere near thirty asks.
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(10);
    // Still held, still nothing applied — backing off is not giving up.
    expect(t.edges()).toEqual([]);
    expect(t.lines('relation frame deferred at')).toHaveLength(1);

    // And it is a rate, not a wall: the house comes back and the next try
    // the ladder allows lands.
    t.houseComesBack();
    await t.tick();
    await t.tick();
    expect(t.edges()).toEqual([{ follower_popclaw_id: FOLLOWER, state: 'following' }]);
    expect(t.announced()).toEqual([{ kind: 'followed_you', follower: FOLLOWER }]);
    t.stop();
  });

  it('starts the ladder over after a success, instead of carrying the streak', async () => {
    const t = await host();
    await t.trustLands();
    t.houseGoesDown();
    await t.attach();
    await t.frame();
    for (let i = 0; i < 30; i += 1) await t.tickAfter(2_000);
    t.houseComesBack();
    await t.tick();
    await t.tick();
    expect(t.edges()).toEqual([{ follower_popclaw_id: FOLLOWER, state: 'following' }]);

    // The session ends and the owner logs back in, so this house needs
    // attaching again — and it is down again.
    t.sessionEndsAndReturns();
    t.houseGoesDown();
    await t.frame('2', '1.2');
    // The frame kicks a retry of its own and does not await it. Join that
    // first, or the number being measured is one this retry is about to
    // change anyway — and the case would pass for the wrong reason.
    await settle();
    const beforeWait = t.manifestReads();

    // One and a half seconds. A ladder still carrying the earlier streak
    // would be waiting tens of seconds and ask nothing; one that started over
    // waits a second and asks.
    await t.tickAfter(1_500);
    expect(t.manifestReads()).toBeGreaterThan(beforeWait);
    t.stop();
  });

  it('refuses to hold more than the bound, so the transport re-reads instead', async () => {
    const t = await host();
    await t.attach();
    // A hundred frames is the bound. The hundred-and-first is refused, and
    // refusing it is what reaches the transport's replay boundary: that
    // connection is abandoned without having acknowledged anything, so the
    // house sends these again rather than this process hoarding them.
    for (let i = 1; i <= 100; i += 1) await t.frame(String(i), `1.${i}`);
    expect(t.lines('relation frame deferred at')).toHaveLength(100);

    expect(() => t.frame('101', '1.101')).toThrow(/RELATION_SESSION_NOT_TRUSTED/);
    expect(t.lines('relation frame deferred at')).toHaveLength(100);
    // Nothing applied by any of it: the bound is about how much may be held,
    // not about relaxing what an untrusted session may do.
    expect(t.edges()).toEqual([]);
    expect(t.announced()).toEqual([]);

    await t.trustLands();
    await t.tick();
    await t.tick();
    expect(t.lines('relation frame processed after deferral at')).toHaveLength(100);

    // The transport replays the one it was refused.
    await t.frame('101', '1.101');
    await t.tick();

    // A hundred and one declarations from ONE person are one follower and one
    // announcement, however they were held and however often they were sent.
    expect(t.edges()).toEqual([{ follower_popclaw_id: FOLLOWER, state: 'following' }]);
    expect(t.announced()).toEqual([{ kind: 'followed_you', follower: FOLLOWER }]);
    t.stop();
  });

  it('does not hold a frame that arrives after a session is already attached', async () => {
    const t = await host();
    await t.trustLands();
    expect(await t.attach()).toEqual({ ok: true });
    await t.frame();

    // Straight to the boundary: no deferral line, and the drain has it.
    expect(t.lines('relation frame deferred at')).toEqual([]);
    await t.tick();
    expect(t.edges()).toEqual([{ follower_popclaw_id: FOLLOWER, state: 'following' }]);
    t.stop();
  });
});
