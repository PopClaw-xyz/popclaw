/**
 * A follow arriving on a transport the chain does not own becomes an edge.
 *
 * This is the receiving half, and until now it was not connected to anything.
 * The assembly that knows how to take a relation frame had no caller and no
 * test; the three roots passed `HouseResourceSet` no `onFrame`; so a relation
 * original that reached a running plugin hit one line — "relation events are
 * being dropped" — and the follower list never moved.
 *
 * So this does not assert that hooks exist. It drives the same four hooks a
 * root hands `configureResources`, in the order a resource set calls them,
 * and asserts the EDGE. The control below feeds the identical frame with the
 * house never attached: if that also produced an edge, the case above would
 * be passing for a reason unrelated to the wiring.
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { openRelationReception } from '../../../src/social-graph/relation-reception.js';
import { declaringReadAuthority } from '../../helpers/read-authority.js';
import { establishHouseTrust } from '../../../src/world/house-trust.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ORIGIN = 'https://reception.test';
const SLUG = 'reception-test';
const ME = 'me-popclaw-id';
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

async function reception() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const minted = mintHouse({ origin: ORIGIN, manifest: { relations: { ordered: 1 } } });
  const warnings: string[] = [];
  const r = await openRelationReception({
    db,
    recipientPopclawId: ME,
    signer: {} as never,
    readAuthorityFor: declaringReadAuthority(db, {} as never),
    onMessage: () => {},
    fetch: minted.fetch as unknown as typeof globalThis.fetch,
    log: { warn: (m) => warnings.push(m) },
    // The drain is the production schedule; these cases commit and read
    // directly, so no timer is wanted.
    drainIntervalMs: 0,
  });
  // Two facts a real login has to leave behind, and today does not: the pin
  // this house is trusted under, and the local participation the session
  // stands on. `attach` CONFIRMS both; it never establishes them — which is
  // why wiring reception is necessary and not sufficient, and why the login
  // work has to land beside it.
  const first = await establishHouseTrust(db, ORIGIN, { fetch: minted.fetch as never });
  if (!first.ok) throw new Error(`fixture could not establish first trust: ${first.refusal}`);
  r.host.wiring.login({ houseKey: minted.houseKey, incarnation: minted.incarnation, houseSlug: SLUG });
  const house = { slug: SLUG, baseUrl: ORIGIN } as never;
  return { db, r, minted, house, warnings,
    edges: () => db.queryAll<{ follower_popclaw_id: string; state: string; house_key: string }>(
      'SELECT follower_popclaw_id, state, house_key FROM relation_edges') };
}

describe('a relation frame on a transport the chain does not own', () => {
  it('lands as an edge, through the hooks a root hands the resource set', async () => {
    const t = await reception();

    // 1. What HouseResourceSet does before it opens the stream.
    const attached = await t.r.hooks.attachRelations!(t.house, {} as never);
    expect(attached).toEqual({ ok: true });

    // 2. What it does when a verified non-DM envelope arrives.
    await t.r.hooks.onFrame!(t.house, {} as never, followFrame(t.minted.houseKey, '1'), '1.1');
    // The boundary commits the frame; the drain turns it into business state.
    // In production that is this host's own timer; here it is called directly
    // so the assertion is about the commit, not about a clock.
    t.r.host.wiring.drain(20);

    expect(t.edges()).toEqual([
      { follower_popclaw_id: FOLLOWER, state: 'following', house_key: t.minted.houseKey },
    ]);
    // And the cursor the next reconnect would resume from is the one that landed.
    expect(t.r.hooks.resumeFrom!(t.house, {} as never)).toBe('1.1');
    t.r.stop();
  });

  /**
   * The comparator is the ROOT's to supply, and a helper that exists is not a
   * root that uses it. `CommitOptions.advances` is optional and absent by
   * default — no comparison at all — so a chain assembled without it happily
   * writes a position the house issued BEFORE the one it already holds, and
   * the next reconnect resumes from there, behind frames nobody will send
   * again. This drives the assembly every root actually builds
   * (`openRelationReception` → `openRelationAwareInbox` → `createRelationWiring`),
   * through the same hooks a resource set calls.
   */
  it('refuses an old or unreadable position at the root, not only in the helper', async () => {
    const t = await reception();
    await t.r.hooks.attachRelations!(t.house, {} as never);
    const at = (seq: string, position: string) =>
      t.r.hooks.onFrame!(t.house, {} as never, followFrame(t.minted.houseKey, seq), position);

    await at('1', '1.5');
    expect(t.r.hooks.resumeFrom!(t.house, {} as never)).toBe('1.5');

    // Earlier on the same log: the live session has already read past it.
    await at('2', '1.2');
    expect(t.r.hooks.resumeFrom!(t.house, {} as never)).toBe('1.5');

    // A bare number names no log generation, so the house could never have
    // issued it and nothing can compare it to what we hold.
    await at('3', '7');
    expect(t.r.hooks.resumeFrom!(t.house, {} as never)).toBe('1.5');

    // The control: a genuinely later position does move, so the three
    // assertions above are about the comparison and not about a dead cursor.
    await at('4', '1.9');
    expect(t.r.hooks.resumeFrom!(t.house, {} as never)).toBe('1.9');
    t.r.stop();
  });

  it('refuses the same frame when the house was never attached — the control', async () => {
    const t = await reception();
    // No attachRelations call: the resource set opened a stream for a house
    // the chain does not hold a session for.
    await t.r.hooks.onFrame!(t.house, {} as never, followFrame(t.minted.houseKey, '1'), '1.1');
    t.r.host.wiring.drain(20);

    expect(t.edges()).toEqual([]);
    expect(t.warnings.join('\n')).toContain('no trusted, live session');
    t.r.stop();
  });

  it('refuses a house whose proof is signed by another key', async () => {
    const t = await reception();
    const impostor = mintHouse({
      origin: ORIGIN, seed: 21,
      signWith: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(99)).secretKey,
    });
    const r2 = await openRelationReception({
      db: t.db, recipientPopclawId: ME, signer: {} as never, onMessage: () => {},
      readAuthorityFor: declaringReadAuthority(t.db, {} as never),
      fetch: impostor.fetch as unknown as typeof globalThis.fetch, drainIntervalMs: 0,
    });
    const attached = await r2.hooks.attachRelations!(t.house, {} as never);
    expect(attached.ok).toBe(false);
    r2.stop();
    t.r.stop();
  });
});
