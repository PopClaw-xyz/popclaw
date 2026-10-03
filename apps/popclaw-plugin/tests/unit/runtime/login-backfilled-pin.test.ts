/**
 * A pin backfilled onto a pending login must reach the verifier that round.
 *
 * `commitLocalLogin` has two paths that both bind a key, and until now only
 * one of them reported what it bound. The `fresh` path returns
 * `row.ack_key_hex || discoveredAckKeyHex` — the key actually committed. The
 * `reuse-pending` path writes `discoveredAckKeyHex` into the empty column and
 * then returns the value it read BEFORE that write: the empty string.
 *
 * That is reachable on an ordinary first login. Discovery is a network window
 * the first time (no board, no configured or persisted pin), so the intent
 * commits with an empty key and an unsettled pending enter. The next login
 * discovers the board, takes the reuse-pending path, and backfills.
 *
 * The caller reads that return value four times, and the empty string is the
 * wrong answer to all four (`manager.ts:517` pin-conflict comparison,
 * `:547` the preparer gate, `:559` the commit-time CAS, `:576` the revoke).
 * The last one is the damaging one: the house's capability view is REVOKED as
 * `HOUSE_PIN_UNAVAILABLE` in the same round the key landed in the database.
 * The session still enters, so nothing looks broken — the house just quietly
 * loses its verified capabilities until some later explicit login happens to
 * take the connected fastpath and refresh them.
 *
 * So this asserts on the two things the owner would actually notice: the
 * verifier runs, and the capability view is not revoked.
 */
import { afterEach, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';

const origin = 'https://backfill.invalid';
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const ackKeyHex = Buffer.from(key.publicKey).toString('hex');
const raw = '{"house_session":' + JSON.stringify({
  version: 1, endpoint: '/v1/house-session', ack_pubkey: ackKeyHex,
  operations: ['enter', 'renew', 'leave', 'status'], lease_seconds: 90, renew_interval_seconds: 30,
}) + '}';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.reverse()) await f(); cleanup.length = 0; });

function fixture() {
  const db = new InMemoryHostDb();
  cleanup.push(() => db.close());
  // Login 1 cannot reach the house; login 2 can. Nothing else differs.
  let reachable = false;
  const prepared: string[] = [];
  const revoked: string[] = [];
  const manager = new HouseLifecycleManager({
    db,
    installationId: 'backfill-install',
    signer: {
      publicKey: async () => key.publicKey,
      popclawId: async () => bs58.encode(key.publicKey),
      sign: async b => nacl.sign.detached(b, key.secretKey),
    },
    fetch: vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (!reachable) throw new Error('offline');
      if (!init?.method || init.method === 'GET') {
        return new Response(raw, { headers: { 'X-Popclaw-Manifest-Proof': 'proof-bytes' } });
      }
      return new Response('', { status: 503 });
    }),
    retryBackoffMs: 60000,
    prepareTrustedManifest: input => { prepared.push(input.ackKeyHex); return { commit: () => undefined }; },
    revokeTrustedManifest: (_tx, _o, detail) => { revoked.push(detail); },
  });
  cleanup.push(async () => { manager.stopHost(); await manager.waitForQuiet(); });
  return { db, manager, prepared, revoked, reach: () => { reachable = true; } };
}

it('the pin backfilled onto a pending login is verified, not revoked', async () => {
  const s = fixture();

  // 1. Offline first login: intent committed, no key, pending enter unsettled.
  await s.manager.loginHouse(origin);
  const after1 = s.db.queryOne<{ ack_key_hex: string; pending_enter_request_id: string | null }>(
    'SELECT ack_key_hex, pending_enter_request_id FROM house_participation WHERE house_origin = ?', [origin]);
  expect(after1?.ack_key_hex).toBe('');
  expect(after1?.pending_enter_request_id).not.toBeNull();
  expect(s.prepared).toEqual([]);

  // 2. The house is reachable now. This login backfills the key.
  s.reach();
  await s.manager.loginHouse(origin);

  // The key did land in the database — that part always worked.
  expect(s.db.queryOne<{ ack_key_hex: string }>(
    'SELECT ack_key_hex FROM house_participation WHERE house_origin = ?', [origin])?.ack_key_hex).toBe(ackKeyHex);

  // And the round that landed it must have verified it.
  expect(s.prepared).toEqual([ackKeyHex]);
  // Revoking the capability view here says "this house has no usable pin",
  // which is the opposite of what just happened.
  expect(s.revoked).not.toContain('HOUSE_PIN_UNAVAILABLE');
});
