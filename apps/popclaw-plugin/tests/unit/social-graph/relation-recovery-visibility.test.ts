/**
 * A reconciliation that can never succeed has to say so.
 *
 * `recoverRelationGap` never throws: every failure -- a refused credential, a
 * house that serves no evidence, a spent budget -- comes back as a returned
 * `{recovered: false, reason}`. The call site used to discard that value and
 * hang a `.catch` off a promise that does not reject, while threading in a
 * `deps.log` the recovery function never called. So the gap stayed open, the
 * drain tick retried it every two seconds forever, and not one line was
 * written anywhere. The projection could be permanently missing edges while
 * every surface looked healthy.
 *
 * That channel matters more than it used to: the read-credential contract
 * being drafted may split the snapshot and evidence endpoints into separate
 * purposes, and the one token this sweep signs serves BOTH. If that lands
 * wrong, the symptom is exactly this 401 -- so the 401 must be audible before
 * the change ships, not after.
 *
 * The other half of the rule is that it must stay audible. A warning repeated
 * every two seconds is filtered out by whoever reads logs, which is the same
 * silence wearing a different coat. So: once per distinct reason, and again
 * when the reason changes to a different one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { beginParticipation } from '../../../src/ingress/inbound-commit.js';
import { openRelationAwareInbox } from '../../../src/social-graph/relation-host.js';
import { RelationGapStore } from '../../../src/social-graph/relation-gap-store.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { AnyEventSource, SseFrame } from '../../../src/messaging/inbox-stream-client.js';
import type { ReadAuthority } from '../../../src/identity/read-authority.js';
import {
  declaringReadAuthority,
  silentReadAuthority,
  unknownSchemeReadAuthority,
} from '../../helpers/read-authority.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ORIGIN = 'https://house.popclaw.me';
const NOW = () => 1_700_000_000;

const meKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x4d));
const ME = bs58.encode(meKp.publicKey);
const HOUSE_KEY = ME;

const BODY = new TextEncoder().encode('{"house":{"name":"me","slug":"me"},"official_ids":[]}');

/** Answers the manifest for trust reads, and whatever `snapshotStatus` says
 *  for the sweep's first call. Nothing else is reachable: a snapshot that is
 *  refused never gets as far as evidence. */
function fetchWith(snapshotStatus: () => number, sawSnapshot?: () => void): typeof fetch {
  const digest = cidFromCanonical(BODY);
  const binding = { origin: ORIGIN, houseKey: HOUSE_KEY, incarnation: 'inc-1' };
  const core = popclaw.world.ManifestProof.encode({ house: binding, manifestDigest: digest }).finish();
  const prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
  const signing = new Uint8Array(prefix.length + core.length);
  signing.set(prefix);
  signing.set(core, prefix.length);
  const proof = popclaw.world.ManifestProof.encode({
    house: binding,
    manifestDigest: digest,
    authoritySignature: nacl.sign.detached(signing, meKp.secretKey),
  }).finish();
  const header = Buffer.from(proof).toString('base64');
  return (async (url: string) => {
    if (String(url).includes('/v1/relation-snapshot')) {
      sawSnapshot?.();
      const status = snapshotStatus();
      return { status, ok: false, json: async () => ({}) };
    }
    return {
      status: 200,
      ok: true,
      headers: {
        get: (k: string) => (k.toLowerCase() === 'x-popclaw-manifest-proof' ? header : String(BODY.length)),
      },
      arrayBuffer: async () => BODY.buffer.slice(BODY.byteOffset, BODY.byteOffset + BODY.length),
    };
  }) as unknown as typeof fetch;
}

const signer: Signer = {
  publicKey: async () => meKp.publicKey,
  sign: async () => new Uint8Array(64),
  popclawId: async () => ME,
} as unknown as Signer;

function silentTransport() {
  return class {
    onmessage: ((e: SseFrame) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    addEventListener(): void {}
    close(): void {}
  } as unknown as new (url: string, init?: { readonly headers?: Record<string, string> }) => AnyEventSource;
}

async function waitFor<T>(read: () => T, accepts: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = read();
    if (accepts(v)) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not reached');
}

describe('a relation gap that cannot be closed', () => {
  let db: InMemoryHostDb;
  // Stopped here, not at the end of each test: a `waitFor` that times out
  // never reaches the test's own stop(), and a drain tick surviving
  // db.close() drowns the real assertion failure in hundreds of
  // "database connection is not open".
  const opened: Array<{ stop: () => void }> = [];
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    establishTrust(db, { origin: ORIGIN, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'tofu', NOW);
    beginParticipation(db, HOUSE_KEY, NOW);
    new RelationGapStore(db).mark({
      houseKey: HOUSE_KEY, incarnation: 'inc-1',
      reason: 'below_floor', logGeneration: '5', floor: '120', at: NOW(),
    });
  });
  afterEach(() => {
    for (const h of opened.splice(0)) h.stop();
    db.close();
  });

  async function openHost(
    snapshotStatus: () => number,
    readAuthorityFor: (origin: string) => ReadAuthority = declaringReadAuthority(db, signer),
  ) {
    const warns: string[] = [];
    const infos: string[] = [];
    let snapshotRequests = 0;
    const host = await openRelationAwareInbox(
      {
        db,
        recipientPopclawId: ME,
        signer,
        readAuthorityFor,
        now: NOW,
        fetch: fetchWith(snapshotStatus, () => { snapshotRequests += 1; }),
        eventSourceCtor: silentTransport(),
        onMessage: () => {},
        drainIntervalMs: 5,
        streamReconnectDelayMs: 0,
        startStreams: false,
        log: { warn: (m: string) => { warns.push(m); }, info: (m: string) => { infos.push(m); } },
      } as never,
      [ORIGIN],
    );
    opened.push(host);
    return { host, warns, infos, snapshotRequests: () => snapshotRequests };
  }

  it('is reported -- the refusal reaches a log instead of a discarded value', async () => {
    const { host, warns } = await openHost(() => 401);
    const first = await waitFor(() => warns, (w) => w.length > 0);
    // The reason has to name what actually happened. "recovery failed" tells
    // nobody whether to fix a key, a house, or a budget.
    expect(first[0]).toContain('401');
    expect(first[0]).toContain(HOUSE_KEY.slice(0, 8));
    host.stop();
  });

  it('a house that declares no read scheme is refused before a request goes out', async () => {
    // 401 would be the answer if a request were made. Nothing must be made:
    // the refusal is decided from the declaration, not learned from a reply.
    const t = await openHost(() => 401, silentReadAuthority(db, signer));
    const said = await waitFor(() => t.warns, (w) => w.length > 0);
    expect(said[0]).toContain('READ_AUTH_NOT_DECLARED');
    expect(t.snapshotRequests()).toBe(0);
    t.host.stop();
  });

  it('a house that names a scheme this build does not speak is refused the same way', async () => {
    const t = await openHost(() => 401, unknownSchemeReadAuthority(db, signer));
    const said = await waitFor(() => t.warns, (w) => w.length > 0);
    expect(said[0]).toContain('READ_AUTH_SCHEME_UNSUPPORTED');
    // Not "try the other one and see": a 401 never triggers a hunt through
    // schemes, and neither does a name with a 2 in it.
    expect(t.snapshotRequests()).toBe(0);
    t.host.stop();
  });

  it('is reported once, not once every tick', async () => {
    const { host, warns } = await openHost(() => 401);
    await waitFor(() => warns, (w) => w.length > 0);
    // Many ticks at 5ms. A per-tick warning would be dozens of lines, and a
    // log nobody can read is the same silence in a different coat.
    await new Promise((r) => setTimeout(r, 120));
    expect(warns).toHaveLength(1);
    host.stop();
  });

  it('says it again when the reason becomes a different one', async () => {
    let status = 401;
    const { host, warns } = await openHost(() => status);
    await waitFor(() => warns, (w) => w.length > 0);

    // A house that stops refusing the credential and starts refusing the
    // question is a different problem with a different fix. Suppressing it
    // because something was already said about this gap would hide the only
    // evidence that anything changed.
    status = 403;
    const both = await waitFor(() => warns, (w) => w.length > 1);
    expect(both[1]).toContain('403');
    host.stop();
  });

  it('a gap someone else closed is reported closed, not left reading "still open"', async () => {
    // Several roots share one data root, and whichever completes a checkpoint
    // closes the gap for all of them. A process that only reported on its OWN
    // sweeps left its last word about a settled debt saying "still open" --
    // and, because no later sweep runs for a gap that no longer exists,
    // nothing ever corrected it.
    const { host, warns, infos } = await openHost(() => 401);
    await waitFor(() => warns, (w) => w.length > 0);

    new RelationGapStore(db).clear(HOUSE_KEY, 'inc-1');

    const closed = await waitFor(() => infos, (i) => i.length > 0);
    expect(closed[0]).toContain('closed');
    expect(closed[0]).toContain(HOUSE_KEY.slice(0, 8));
    // And it does not keep complaining about a debt that is settled.
    const after = warns.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(warns).toHaveLength(after);
    host.stop();
  });
});

/**
 * The sweep has to be REACHED, not merely to exist. It sat in this tree with
 * no caller at all, which is why a timed-out follow only ever recovered when
 * the owner typed the command again.
 */
describe('the drain tick and the resend sweep', () => {
  let db: InMemoryHostDb;
  const opened: Array<{ stop: () => void }> = [];
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    establishTrust(db, { origin: ORIGIN, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'tofu', NOW);
    beginParticipation(db, HOUSE_KEY, NOW);
  });
  afterEach(() => {
    for (const h of opened.splice(0)) h.stop();
    db.close();
  });

  it('runs the sweep on its own, and stops running it once the host is stopped', async () => {
    let calls = 0;
    let lastStillValid: (() => boolean) | undefined;
    const host = await openRelationAwareInbox(
      {
        db, recipientPopclawId: ME, signer, now: NOW,
        fetch: (async () => new Response('{}', { status: 500 })) as unknown as typeof globalThis.fetch,
        eventSourceCtor: silentTransport(), onMessage: () => {},
        drainIntervalMs: 5, streamReconnectDelayMs: 0, startStreams: false,
        resendRelations: (stillValid: () => boolean) => {
          calls += 1;
          lastStillValid = stillValid;
          return Promise.resolve([]);
        },
      } as never,
      [ORIGIN],
    );
    opened.push(host);

    await waitFor(() => calls, (n) => n > 0);
    // The round's authority is live while the host is, and refuses after it
    // stops — that is what keeps a logout from putting one more request out.
    expect(lastStillValid!()).toBe(true);
    host.stop();
    expect(lastStillValid!()).toBe(false);

    const seen = calls;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(seen);
  });
});
