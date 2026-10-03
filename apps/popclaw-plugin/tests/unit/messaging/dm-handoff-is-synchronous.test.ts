/**
 * The DM hand-over is synchronous on purpose, and saying so out loud is the
 * point of this file.
 *
 * `drainDmTodos` settles each row inside the processor's own transaction and
 * then, the moment `process` RETURNS, revokes the commit authority — that is
 * what makes "the business write landed" and "the row is settled" one fact
 * instead of two. An async processor breaks the assumption invisibly: the call
 * returns at its first await, authority is revoked while the real work is
 * still queued, the row is reported as `not committed (no business hand-over)`,
 * and the eventual commit is rejected by an expiry it never saw coming. The DM
 * is neither delivered nor retried as a failure anybody looks at.
 *
 * `=> void` does not stop an async function being passed — a Promise IS a
 * valid `void` expression to TypeScript. So the contract is enforced here, at
 * runtime, and loudly: persist the hand-over synchronously and let the
 * existing async consumer do the slow part afterwards, on the drain.
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { verifyInboundEnvelope } from '../../../src/ingress/verify-envelope.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { makeDmEnqueueWork, drainDmTodos } from '../../../src/messaging/dm-inbound-queue.js';
import { beginParticipation, commitInboundFrame } from '../../../src/ingress/inbound-commit.js';
import type { TrustedSource } from '../../../src/ingress/inbound-commit.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
const SENDER = bs58.encode(kp.publicKey);
const ME = 'me-popclaw-id';
const SOURCE: TrustedSource = { houseKey: 'HOUSE-KEY-1', incarnation: '1', ownerGeneration: 1, houseSlug: 'h1' };

function dmEnvelopeBytes(): Uint8Array {
  const env = {
    actor: { popclawId: SENDER },
    target: {},
    timestamp: 1_713_657_600,
    directMessage: { fromPopclawId: SENDER, toPopclawId: ME, body: 'hello', ts: 100 },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, kp.secretKey),
  }).finish();
}

function seeded() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const enqueue = makeDmEnqueueWork({ recipientPopclawId: ME });
  const bytes = dmEnvelopeBytes();
  const generation = beginParticipation(db, SOURCE.houseKey);
  const source: TrustedSource = { ...SOURCE, ownerGeneration: generation };
  // Seed through the real commit point: it is what writes the frame row the
  // drain joins against, so enqueueing directly would leave nothing to drain
  // and every assertion below would pass over an empty list.
  const committed = commitInboundFrame(db, {
    source,
    stream: 'personal',
    envelopeBytes: bytes,
    eventId: popclaw.event.EventEnvelope.decode(bytes).eventId,
  }, {
    verify: (f) => {
      try {
        const env = verifyInboundEnvelope(f.envelopeBytes, { recipientPopclawId: ME });
        return { ok: true, eventId: env.eventId };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    enqueue,
  });
  expect(committed.disposition).toBe('accepted');
  return { db, source };
}

describe('the DM hand-over contract', () => {
  it('delivers when the processor commits synchronously', async () => {
    const { db, source } = seeded();
    let handedOver = 0;
    const results = drainDmTodos(db, [source], (_bytes, _src, commit) => {
      const out = commit(() => { handedOver += 1; return 'ok'; });
      expect(out.committed).toBe(true);
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(handedOver).toBe(1);
  });

  it('refuses an async processor loudly instead of reporting a silent no-hand-over', async () => {
    const { db, source } = seeded();
    let committedLate = false;
    const asyncProcess = (async (_b: Uint8Array, _s: TrustedSource, commit: (fn: () => unknown) => { committed: boolean }) => {
      await Promise.resolve();
      committedLate = commit(() => 'too late').committed;
    }) as unknown as Parameters<typeof drainDmTodos>[2];

    const results = drainDmTodos(db, [source], asyncProcess);

    // The row must NOT come back as an ordinary "caller chose not to commit".
    // That reading is indistinguishable from a healthy skip, and it is how a
    // DM disappears without anyone being told.
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(String(results[0]?.error)).toContain('DM_PROCESSOR_MUST_BE_SYNCHRONOUS');

    // And the late commit is still rejected — naming the mistake must not also
    // start accepting it.
    await Promise.resolve();
    await Promise.resolve();
    expect(committedLate).toBe(false);
  });
});
