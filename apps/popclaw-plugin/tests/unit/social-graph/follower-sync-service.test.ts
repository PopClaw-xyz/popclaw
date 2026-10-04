/**
 * The poll every resident root starts, at the level where all three share it.
 *
 * Being followed used to work on one root only: the poll was assembled inline
 * in the gateway's register(), and it is the only writer of
 * `known_followers_baseline`. On the MCP host and the daemon that table stayed
 * empty, `unannounced()` joins it, and so the relation arrived, the edge was
 * applied, the follower row was written — and nobody was ever told.
 *
 * These cases are about the two halves of that: that a root which runs this
 * service does establish the baseline and does announce what arrives after it,
 * and that establishing the baseline still introduces nobody — including the
 * people a cold personal stream wrote into the cache before the first sync,
 * who are the ones a careless fix floods the owner with.
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { INBOX_TOKEN_HEADER, readCredentialMessage } from '../../../src/identity/read-credential.js';
import { KnownFollowersStore } from '../../../src/social-graph/followers-sync.js';
import { createFollowerSync, type FollowerSyncServiceDeps } from '../../../src/social-graph/follower-sync-service.js';
import { declaringReadAuthority } from '../../helpers/read-authority.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const seed = new Uint8Array(32).fill(71);
const kp = nacl.sign.keyPair.fromSeed(seed);
const ME = bs58.encode(kp.publicKey);
const signer = new MasterKeySigner({ seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: ME });
const BASE = 'https://house.test';
const SLUG = hostDbSlug(BASE);
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

/**
 * A fresh root: the house pinned, its read scheme declared, and a house at the
 * other end that actually CHECKS the credential — an always-answering stub
 * would let a poll that asks the wrong way look healthy.
 */
function root() {
  const db = new LocalHostDb(':memory:');
  runMigrations(db, MIGRATIONS);
  establishTrust(db, { origin: BASE, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'configured', () => 1_700_000_000);

  let served: string[] = [];
  let status = 200;
  let releaseRead: Promise<void> | undefined;
  const purposesRefused: string[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const header = ((init?.headers ?? {}) as Record<string, string>)[INBOX_TOKEN_HEADER] ?? '';
    const [version, id, ts, sig] = header.split('.');
    let ok = false;
    try {
      ok = header.split('.').length === 4 && version === 'v2' && id === ME
        && nacl.sign.detached.verify(
          new TextEncoder().encode(
            readCredentialMessage('relation-list', ME, { origin: BASE, houseKey: HOUSE_KEY }, Number(ts)),
          ),
          Buffer.from(sig!, 'base64'),
          kp.publicKey,
        );
    } catch { ok = false; }
    if (!ok) { purposesRefused.push(String(url)); return new Response('[]', { status: 401 }); }
    const listed = served.slice();
    await releaseRead;
    if (status !== 200) return new Response('', { status });
    return new Response(JSON.stringify(listed.map((popclaw_id) => ({ popclaw_id }))), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });

  const store = new KnownFollowersStore(db, () => 1000);
  const service = (extra: Partial<FollowerSyncServiceDeps> = {}) => createFollowerSync({
    db,
    houses: () => [{ slug: SLUG, baseUrl: BASE }],
    runCommand: (work) => work(),
    deps: {
      ownerPopclawId: ME,
      // A fresh store per service, as a second root on this data root has:
      // the debt lives in the row, never in a process's memory.
      store: new KnownFollowersStore(db, () => 1000),
      notifier: new SqliteNotifier(db, () => 1000),
      socialGraph: { following: () => [] },
      fetch: fetchImpl,
      readAuthorityFor: (house) => declaringReadAuthority(db, signer)(house.baseUrl),
    },
    ...extra,
  });

  const announced = (): { kind: string; followerPopclawId: string }[] =>
    db.queryAll<{ kind: string; payload_json: string }>(
      'SELECT kind, payload_json FROM notification_queue ORDER BY id',
      [],
    ).map((r) => ({ kind: r.kind, followerPopclawId: String(JSON.parse(r.payload_json).followerPopclawId ?? '') }));

  return {
    db, store, announced, purposesRefused, fetchImpl,
    status: (code: number) => { status = code; },
    hold: (promise?: Promise<void>) => { releaseRead = promise; },
    serve: (ids: string[]) => { served = ids; },
    service,
  };
}

describe('the follower poll as every resident root starts it', () => {
  it('owes nothing for a follower it found in a projection rather than witnessed', () => {
    const r = root();
    // The catch-up pass fills in cache rows for edges an earlier build had
    // already adjudicated. It saw none of them arrive, so every one of them
    // may be someone the owner has had all along, and the telling waits.
    r.store.noteVerifiedFollow(SLUG, 'early', { witnessed: false });

    expect(r.store.unannounced()).toEqual([]);
    // The control: a declaration this client took delivery of is owed at
    // once, so the line above is about the evidence, not an empty table.
    r.store.noteVerifiedFollow(SLUG, 'witnessed');
    expect(r.store.unannounced()).toEqual([{ houseSlug: SLUG, followerId: 'witnessed' }]);
    r.db.close();
  });

  it('the first pass establishes the baseline and introduces nobody it merely listed', async () => {
    const r = root();
    // Already at the house, and known here only because the catch-up pass
    // read the projection — nothing witnessed this follow happen.
    r.store.noteVerifiedFollow(SLUG, 'early', { witnessed: false });
    r.serve(['early']);

    expect(await r.service().runOnce()).toBe(0);

    expect(r.store.hasBaseline(SLUG)).toBe(true);
    expect(r.announced()).toEqual([]);
    // And the debt is settled, not merely unswept: a row left NULL here is
    // handed to the relation drain the moment the baseline exists, which is
    // the whole back catalogue arriving at once.
    expect(r.store.unannounced()).toEqual([]);
    expect(r.store.list(SLUG)).toEqual(['early']);
    r.db.close();
  });

  it('announces someone who arrives after the baseline, exactly once', async () => {
    const r = root();
    r.serve(['early']);
    await r.service().runOnce();                 // baseline

    r.serve(['early', 'late']);
    expect(await r.service().runOnce()).toBe(1);
    expect(r.announced()).toEqual([{ kind: 'followed_you', followerPopclawId: 'late' }]);

    // A later pass finds nothing new, and a restart — a brand-new service over
    // the same data root — must not introduce them a second time.
    r.serve(['early', 'late']);
    expect(await r.service().runOnce()).toBe(0);
    expect(await r.service().runOnce()).toBe(0);
    expect(r.announced()).toEqual([{ kind: 'followed_you', followerPopclawId: 'late' }]);
    expect(r.purposesRefused).toEqual([]);
    r.db.close();
  });

  it('a scheduled loop runs a pass at boot and stops when it is stopped', async () => {
    const r = root();
    r.serve(['early']);
    const loop = r.service();
    await loop.start();
    expect(r.store.hasBaseline(SLUG)).toBe(true);
    loop.stop();

    // Stopping is the whole off-switch: nothing is left to fire afterwards.
    r.serve(['early', 'late']);
    await new Promise((done) => setTimeout(done, 20));
    expect(r.announced()).toEqual([]);
    r.db.close();
  });
});


describe('a running follower poll observes normal late participation', () => {
  function lifecycle() {
    const r = root();
    let active = false, generation = 0, present = true;
    let changed: ((origin: string) => void) | undefined;
    let subscribed = false;
    const loop = r.service({
      houses: () => present ? [{slug: SLUG, baseUrl: BASE}] : [],
      captureGate: origin => {
        const captured = generation;
        return {origin, signal: new AbortController().signal, isActive: () => active && captured === generation};
      },
      observeParticipation: listener => {
        changed = listener; subscribed = true;
        return () => { subscribed = false; changed = undefined; };
      },
      notTrustedRetryDelaysMs: [20, 40],
    });
    return {...r, loop,
      join: () => { active = true; generation += 1; changed?.(BASE); },
      leave: () => { active = false; generation += 1; changed?.(BASE); },
      remove: () => { present = false; changed?.(BASE); },
      wake: (origin = BASE) => changed?.(origin),
      subscribed: () => subscribed,
    };
  }

  it('late join reaches a real 503 and retries normally without concurrent same-house reads', async () => {
    const r = lifecycle();
    let release!: () => void;
    r.hold(new Promise<void>(resolve => { release = resolve; }));
    r.status(503);
    try {
      await r.loop.start();
      expect(r.fetchImpl).not.toHaveBeenCalled();
      r.join();
      await vi.waitFor(() => expect(r.fetchImpl).toHaveBeenCalledTimes(1));
      r.wake(); r.wake(); r.wake('https://other.test');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(r.fetchImpl).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(r.fetchImpl.mock.calls.length).toBeGreaterThan(1));
      expect(r.store.hasBaseline(SLUG)).toBe(false);
      r.status(200); r.serve(['early']);
      await vi.waitFor(() => expect(r.store.hasBaseline(SLUG)).toBe(true));
      expect(r.store.list(SLUG)).toEqual(['early']);
      expect(r.announced()).toEqual([]);
      expect(r.fetchImpl.mock.calls.every(call => String(call[0]).startsWith(BASE + '/followers/'))).toBe(true);
    } finally {r.loop.stop(); r.db.close();}
  });

  it('leave and rejoin during an old read captures the new generation without overlap', async () => {
    const r = lifecycle();
    let release!: () => void;
    r.serve(['old']);
    r.hold(new Promise<void>(resolve => { release = resolve; }));
    try {
      await r.loop.start(); r.join();
      await vi.waitFor(() => expect(r.fetchImpl).toHaveBeenCalledTimes(1));
      r.leave(); r.serve(['new']); r.join();
      expect(r.fetchImpl).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(r.store.hasBaseline(SLUG)).toBe(true));
      expect(r.fetchImpl).toHaveBeenCalledTimes(2);
      expect(r.store.list(SLUG)).toEqual(['new']);
      expect(r.announced()).toEqual([]);
    } finally {r.loop.stop(); r.db.close();}
  });

  it.each([401, 403])('an explicit HTTP %s refusal is not retried', async status => {
    const r = lifecycle(); r.status(status);
    try {
      await r.loop.start(); r.join();
      await vi.waitFor(() => expect(r.fetchImpl).toHaveBeenCalledTimes(1));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(r.fetchImpl).toHaveBeenCalledTimes(1);
      expect(r.store.hasBaseline(SLUG)).toBe(false);
    } finally {r.loop.stop(); r.db.close();}
  });

  it.each(['leave', 'remove', 'stop'] as const)('%s prevents an old read from committing or restarting', async ending => {
    const r = lifecycle();
    let release!: () => void;
    r.hold(new Promise<void>(resolve => { release = resolve; }));
    r.status(200);
    try {
      await r.loop.start(); r.join();
      await vi.waitFor(() => expect(r.fetchImpl).toHaveBeenCalledTimes(1));
      if (ending === 'stop') r.loop.stop(); else r[ending]();
      release();
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(r.fetchImpl).toHaveBeenCalledTimes(1);
      expect(r.store.hasBaseline(SLUG)).toBe(false);
      if (ending === 'stop') expect(r.subscribed()).toBe(false);
    } finally {r.loop.stop(); r.db.close();}
  });
});
