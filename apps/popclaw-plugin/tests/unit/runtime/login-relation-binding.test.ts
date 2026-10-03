/**
 * Establishing what a house is trusted to be is the owner's act.
 *
 * `loginHouse` has two callers that arrive identically: the command bus
 * running an explicit owner command, and `resumeEnabledSessions` running
 * every couple of seconds on its own schedule. Until the authority seam
 * existed, no rule could tell them apart — so "only an explicit login may
 * establish a house's first trust" could not be written down, let alone
 * checked.
 *
 * The other half matters just as much. The world preparer is gated on a
 * session board's ACK key, and BOTH deployed houses have no session board,
 * so that path is unreachable for every house a real user has. The relation
 * binding is gated on the manifest alone, which is why it is a separate hook
 * and not a branch inside the other one.
 */
import { afterEach, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';

const origin = 'https://boardless.invalid';
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
// No `house_session`: exactly the shape both deployed houses serve.
const raw = '{"house":{"name":"Boardless","slug":"boardless"},"relations":{"ordered":1}}';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.reverse()) await f(); cleanup.length = 0; });

function fixture(opts: { prepareRefuses?: boolean; commitRefuses?: boolean } = {}) {
  const db = new InMemoryHostDb();
  cleanup.push(() => db.close());
  const relationPrepared: string[] = [];
  const worldPrepared: string[] = [];
  const refusals: string[] = [];
  const manager = new HouseLifecycleManager({
    db,
    installationId: 'relbind-install',
    signer: {
      publicKey: async () => key.publicKey,
      popclawId: async () => bs58.encode(key.publicKey),
      sign: async b => nacl.sign.detached(b, key.secretKey),
    },
    fetch: vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return new Response(raw, { headers: { 'X-Popclaw-Manifest-Proof': 'proof-bytes' } });
      }
      return new Response('', { status: 503 });
    }),
    retryBackoffMs: 60000,
    prepareRelationBinding: async (input) => {
      if (opts.prepareRefuses) throw new Error('MANIFEST_PROOF_BINDING_MISMATCH');
      relationPrepared.push(input.origin);
      return {
        commit: (tx) => {
          // Stands in for the block a key disagreement writes: a durable row
          // the refusal is supposed to LEAVE BEHIND.
          if (opts.commitRefuses) {
            tx.execute('CREATE TABLE IF NOT EXISTS security_outcome (detail TEXT)');
            tx.execute("INSERT INTO security_outcome VALUES ('blocked')");
            return 'HOUSE_INCARNATION_CHANGED';
          }
          return undefined;
        },
      };
    },
    onRelationBindingRefused: (o, reason) => { refusals.push(`${o}: ${reason}`); },
    prepareTrustedManifest: (input) => { worldPrepared.push(input.origin); return { commit: () => undefined }; },
  });
  cleanup.push(async () => { manager.stopHost(); await manager.waitForQuiet(); });
  return { db, manager, relationPrepared, worldPrepared, refusals };
}

it('an explicit login binds a board-less house; the world path never reaches it', async () => {
  const s = fixture();
  await s.manager.loginHouse(origin, { requestId: 'owner-command-1' });

  expect(s.relationPrepared).toEqual([origin]);
  // The whole reason this is a separate hook: with no `house_session` there
  // is no ACK key, so the world preparer is not reachable for this house at
  // all. If this ever became non-empty, the two paths would have merged and
  // the relation binding would have inherited the board gate.
  expect(s.worldPrepared).toEqual([]);
});

it('a login nobody asked for confirms, and cannot establish — the control', async () => {
  const s = fixture();
  // Same call, same house, same bytes. The only difference is that no owner
  // command is being executed — which is what background resume looks like.
  await s.manager.loginHouse(origin);

  expect(s.relationPrepared).toEqual([]);
});

it('a proof that does not verify is said out loud, not turned into "no relations"', async () => {
  const s = fixture({ prepareRefuses: true });
  await s.manager.loginHouse(origin, { requestId: 'owner-command-2' });

  expect(s.relationPrepared).toEqual([]);
  // The dangerous outcome is the quiet one: a house whose proof failed
  // looking exactly like a house that never offered relations.
  expect(s.refusals).toHaveLength(1);
  expect(s.refusals[0]).toContain('MANIFEST_PROOF_BINDING_MISMATCH');
});

it('a refused commit is reported without erasing what it wrote', async () => {
  const s = fixture({ commitRefuses: true });
  await s.manager.loginHouse(origin, { requestId: 'owner-command-3' });

  // Said out loud.
  expect(s.refusals).toHaveLength(1);
  expect(s.refusals[0]).toContain('HOUSE_INCARNATION_CHANGED');
  // And the row survived. A refusal that travels by throwing would have taken
  // the caller's transaction down with it, and a block is exactly the kind of
  // refusal that has to outlive the round that discovered it — the one
  // outcome worth remembering would be the one that erased its own record.
  expect(s.db.queryOne('SELECT detail FROM security_outcome')).toEqual({ detail: 'blocked' });
});
