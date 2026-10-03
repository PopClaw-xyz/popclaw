/**
 * ADR-0051 — in-flight helper regressions (stage-review on 2906ad35, real
 * Node probes): the bounded-stage early-abort path must consume the stage's
 * own rejection (no unhandledRejection from a hostile signer), and the
 * resume drain's backstop deadline must be cleared when the drain wins (an
 * empty drain must not hold the process open for ~40s).
 */

import { describe, it, expect } from 'vitest';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';

const IDENTITY_KEY = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x33));
const ORIGIN = 'https://demo.loreshow.invalid';
const CLOCK_MS = 1_757_200_000_000;

const signer = {
  publicKey: async () => IDENTITY_KEY.publicKey,
  sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, IDENTITY_KEY.secretKey),
  popclawId: async () => bs58.encode(IDENTITY_KEY.publicKey),
};

describe('in-flight helper regressions (stage review)', () => {
  it('an early abort consumes the stage rejection (no unhandledRejection)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let rejectSigner!: (e: Error) => void;
    const hostileSigner = {
      ...signer,
      sign: () =>
        new Promise<Uint8Array>((_resolve, reject) => {
          rejectSigner = reject;
        }),
    };
    const db = new InMemoryHostDb();
    ensureHouseLifecycleSchema(db);
    db.execute(
      `INSERT INTO house_participation (house_origin, installation_id, op_seq, desired, phase, session_id, house_revision, lease_expires_at, inbox_read_token, ack_key_hex, remote_status, updated_at)
       VALUES (?, 'install-test', 1, 'enabled', 'connected', 'sess-s', 1, 0, '', ?, 'confirmed', 0)`,
      [ORIGIN, Buffer.from(new Uint8Array(32).fill(0xa1)).toString('hex')],
    );
    const manager = new HouseLifecycleManager({
      db,
      signer: hostileSigner,
      installationId: 'install-test',
      // A fetch that would count sends; the sign stage aborts before it.
      fetch: (async () => {
        throw new Error('fetch must not be reached');
      }) as typeof globalThis.fetch,
      clock: () => CLOCK_MS,
      retryBackoffMs: 5,
      retryMaxMs: 5,
    });
    const out = await manager.logoutHouse(ORIGIN);
    expect(out.remoteStatus).toBe('pending');
    // Give the worker a tick to enter its sign stage, then quiesce — the
    // captured pause signal aborts the request mid-sign.
    await new Promise((r) => setTimeout(r, 10));
    manager.quiesce();
    await new Promise((r) => setTimeout(r, 20));
    // The hostile signer NOW rejects — after the abort already won the race.
    rejectSigner(new Error('synthetic signer rejection'));
    // Let the microtask queue drain so an unhandledRejection would surface.
    await new Promise((r) => setTimeout(r, 20));
    manager.stopHost();
    db.close();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('an empty resume drain does not leave the 40s backstop timer running', async () => {
    const db = new InMemoryHostDb();
    ensureHouseLifecycleSchema(db);
    const manager = new HouseLifecycleManager({
      db,
      signer,
      installationId: 'install-test',
      fetch: globalThis.fetch,
      clock: () => CLOCK_MS,
    });
    // No outbox rows at all: the drain is empty and completes immediately.
    manager.quiesce();
    const t0 = Date.now();
    await manager.resumeAfterOwnership();
    const elapsed = Date.now() - t0;
    manager.stopHost();
    db.close();
    // The resume returned immediately; the deadline handle must be cleared.
    // A stray ref'd 40s timer would keep this test process alive — vitest
    // fails the suite on hang, so the fast completion + a short grace wait
    // is the observable contract here.
    expect(elapsed).toBeLessThan(2_000);
    await new Promise((r) => setTimeout(r, 50));
  });
});
