/**
 * The window between boot and the first successful poll.
 *
 * Both things a fresh install does — pin the configured houses and start the
 * follower poll — are started in the same tick and neither is awaited, so the
 * first pass reaches the house about a quarter of a second before the pin that
 * lets it prove who is asking. The pass is refused with
 * `READ_AUTH_HOUSE_NOT_TRUSTED`, no baseline row is written, and the next
 * attempt is a full interval away.
 *
 * Anyone who follows during that window is learned from the relation stream
 * and left owed an announcement. The baseline that finally arrives used to
 * settle EVERY unannounced row at the house, so that person was filed as
 * history and never introduced — silently, with an empty notification queue
 * and nothing on stderr. The same thing happens sub-second: someone who
 * follows between the house computing the list and the baseline committing is
 * absent from the list, and the blanket settle ate them too.
 *
 * Two facts pinned here. The baseline settles the snapshot it was drawn from
 * and nothing else, so a row the snapshot never named keeps the announcement
 * it is owed. And a pass refused because nothing has pinned the house yet
 * tries again on a short backoff rather than waiting out the interval.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
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
import {
  FOLLOWER_SYNC_INTERVAL_MS,
  KnownFollowersStore,
  announceVerifiedFollowers,
  houseScopedVerifiedGuards,
  type FollowerSyncDeps,
} from '../../../src/social-graph/followers-sync.js';
import { createFollowerSync } from '../../../src/social-graph/follower-sync-service.js';
import { declaringReadAuthority } from '../../helpers/read-authority.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const seed = new Uint8Array(32).fill(23);
const kp = nacl.sign.keyPair.fromSeed(seed);
const ME = bs58.encode(kp.publicKey);
const signer = new MasterKeySigner({ seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: ME });
const BASE = 'https://house.test';
const SLUG = hostDbSlug(BASE);
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

/**
 * A root on a data root whose house may or may not be pinned yet — the state
 * a fresh install is actually in for the first few hundred milliseconds. The
 * house at the other end checks the credential, so an unpinned house refuses
 * exactly as the live one did rather than answering an empty list.
 */
function root(options: { readonly pinned?: boolean } = {}) {
  const db = new LocalHostDb(':memory:');
  runMigrations(db, MIGRATIONS);
  const pin = (): void => {
    establishTrust(db, { origin: BASE, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'configured', () => 1_700_000_000);
  };
  if (options.pinned !== false) pin();

  let served: string[] = [];
  // One read authority is resolved per house per pass — and it is resolved
  // BEFORE the request, so counting it counts the passes that were refused
  // for want of a pin as well as the ones that reached the house.
  let passes = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
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
    if (!ok) return new Response('[]', { status: 401 });
    return new Response(JSON.stringify(served.map((popclaw_id) => ({ popclaw_id }))), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;

  const deps: FollowerSyncDeps = {
    ownerPopclawId: ME,
    store: new KnownFollowersStore(db, () => 1000),
    notifier: new SqliteNotifier(db, () => 1000),
    socialGraph: { following: () => [] },
    fetch: fetchImpl,
    readAuthorityFor: (house) => {
      const authority = declaringReadAuthority(db, signer)(house.baseUrl);
      return (purpose) => { passes += 1; return authority(purpose); };
    },
  };

  const announced = (): { kind: string; followerPopclawId: string }[] =>
    db.queryAll<{ kind: string; payload_json: string }>(
      'SELECT kind, payload_json FROM notification_queue ORDER BY id',
      [],
    ).map((r) => ({ kind: r.kind, followerPopclawId: String(JSON.parse(r.payload_json).followerPopclawId ?? '') }));

  return {
    db,
    pin,
    announced,
    store: new KnownFollowersStore(db, () => 1000),
    passCount: () => passes,
    serve: (ids: string[]) => { served = ids; },
    /** The adjudicated edge the relation stream writes alongside the cache row. */
    edge: (follower: string, state = 'following') => db.execute(
      `INSERT INTO relation_edges
         (house_key, follower_popclaw_id, followee_popclaw_id, state, conflicted, updated_at)
       VALUES (?, ?, ?, ?, 0, 1)`,
      [HOUSE_KEY, follower, ME, state],
    ),
    /** The drain sweep in relation-host.ts, as it runs: whatever is owed, announced. */
    sweep: () => announceVerifiedFollowers(
      { ...deps, verifiedGuards: houseScopedVerifiedGuards(db, ME, hostDbSlug) },
      new KnownFollowersStore(db, () => 1000).unannounced(),
    ),
    service: (extra: { readonly notTrustedRetryDelaysMs?: readonly number[] } = {}) => createFollowerSync({
      db,
      // A fresh store per service, as a second root on this data root has:
      // the debt lives in the row, never in a process's memory.
      deps: { ...deps, store: new KnownFollowersStore(db, () => 1000) },
      houses: () => [{ slug: SLUG, baseUrl: BASE }],
      runCommand: (work) => work(),
      ...extra,
    }),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('a follower who arrives before the baseline does', () => {
  it('is still announced when the first poll is one the house list predates', async () => {
    const r = root();
    // The boot poll was refused — the pin had not committed yet — so this
    // house has no baseline. Someone genuinely new then follows, and the
    // relation stream applies the edge and writes the cache row.
    expect(r.store.hasBaseline(SLUG)).toBe(false);
    r.store.noteVerifiedFollow(SLUG, 'zeta');
    r.edge('zeta');
    // The house's own answer is from before zeta, and names only the people
    // the owner already had.
    r.serve(['early']);

    expect(await r.service().runOnce()).toBe(0);

    // The baseline exists now, and the people it was drawn from are history:
    // nobody was introduced by establishing it.
    expect(r.store.hasBaseline(SLUG)).toBe(true);
    expect(r.announced()).toEqual([]);
    // But zeta was never in that snapshot, so the debt on their row survives
    // it — and the sweep that runs the moment a baseline exists pays it.
    expect(r.store.unannounced()).toEqual([{ houseSlug: SLUG, followerId: 'zeta' }]);

    expect(await r.sweep()).toBe(1);
    expect(r.announced()).toEqual([{ kind: 'followed_you', followerPopclawId: 'zeta' }]);

    // Exactly once: the row is settled, so the next sweep owes nothing.
    expect(r.store.unannounced()).toEqual([]);
    expect(await r.sweep()).toBe(0);
    expect(r.announced()).toEqual([{ kind: 'followed_you', followerPopclawId: 'zeta' }]);
    r.db.close();
  });
});

describe('a first pass that reaches a house nothing has pinned yet', () => {
  it('tries again on a short backoff instead of waiting out the interval', async () => {
    vi.useFakeTimers();
    const r = root({ pinned: false });
    r.serve(['early']);
    const loop = r.service({ notTrustedRetryDelaysMs: [2_000] });

    await loop.start();
    // Refused: there is no verified binding to sign a credential against.
    expect(r.store.hasBaseline(SLUG)).toBe(false);

    // The pinning loop commits its pin, a fraction of a second into boot.
    r.pin();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(r.store.hasBaseline(SLUG)).toBe(true);
    expect(r.store.list(SLUG)).toEqual(['early']);
    loop.stop();
    r.db.close();
  });

  it('stops retrying once the delays run out, and never before its own pass', async () => {
    vi.useFakeTimers();
    const r = root({ pinned: false });
    r.serve(['early']);
    const loop = r.service({ notTrustedRetryDelaysMs: [2_000, 5_000] });

    await loop.start();
    // Two bounded retries, and then nothing until the ordinary cadence: a
    // house that stays untrusted must not become a background beacon.
    await vi.advanceTimersByTimeAsync(FOLLOWER_SYNC_INTERVAL_MS - 1);
    expect(r.passCount()).toBe(3);

    loop.stop();
    r.db.close();
  });
});
