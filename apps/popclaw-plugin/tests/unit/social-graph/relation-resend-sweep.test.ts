/**
 * A follow whose push timed out recovers without the owner doing it again.
 *
 * `resendPending` existed in this tree with no caller anywhere: any follow
 * whose push failed sat in `relation_outbox` for good, and the only way it
 * ever reached the house was the owner typing the command a second time. The
 * roots now hand the sweep to the drain tick.
 *
 * What the sweep must and must not do:
 *   - re-send the SAME stored bytes. A house absorbs a duplicate original by
 *     dedup; a freshly signed one is a new statement about the same edge.
 *   - keep the sequence number. A second number on one edge is a second fact,
 *     and the ordered engine is entitled to treat it as a fork.
 *   - stop when the round is over. A logout or a stop between ticks must not
 *     put another request on the wire.
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { createRelationProducer } from '../../../src/social-graph/relation-producer.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { popclaw } from '@popclaw/contracts';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOUSE_A = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';
const HOUSE_B = '6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM';
const FOLLOWEE = '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM';

function fixture(opts: { firstPushFails?: boolean } = {}) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const seed = new Uint8Array(32).fill(71);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const signer = new MasterKeySigner({ seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: bs58.encode(kp.publicKey) });

  let houseKey = HOUSE_A;
  let houseSlug = 'h1';
  let calls = 0;
  // Argument order matters here: the bytes come first. Getting it the other
  // way round put the injected failure on the wrong call and made the retry
  // case pass for the wrong reason.
  const push = vi.fn(async (bytes: Uint8Array, _slug: string | undefined) => {
    calls += 1;
    if (opts.firstPushFails && calls === 1) throw new Error('house unreachable');
    // A receipt has to NAME the event it acknowledges — anything else is not
    // acceptance, and the producer is right to leave the row unsent. A fake
    // that returned a fixed string made every push look unacknowledged and
    // would have made the "already sent" case pass for the wrong reason.
    const sp = popclaw.identity.SignedPayload.decode(bytes);
    const eventId = popclaw.event.EventEnvelope.decode(sp.payload as Uint8Array).eventId;
    return { status: 200, eventId } as never;
  });
  const producer = createRelationProducer({
    db, signer,
    resolveScope: () => ({ support: 'supported', houseKey, houseSlug }) as never,
    signingReadiness: () => 'ready' as never,
    push,
    recordPendingIntent: () => {},
    now: () => 1_713_657_600,
  });
  return { db, producer, push,
    // A different HOUSE, which means a different slug as well as a different
    // key. Changing only the key at the same slug is a re-key, and is
    // correctly refused — a different thing from following someone at a
    // second house.
    moveToOtherHouse: () => { houseKey = HOUSE_B; houseSlug = 'h2'; },
    outbox: () => db.queryAll<{ seq: number; sent_at: number | null }>(
      'SELECT CAST(seq AS INTEGER) AS seq, sent_at FROM relation_outbox ORDER BY seq') };
}


describe('the resend sweep', () => {
  it('re-sends a timed-out follow with no second command from the owner', async () => {
    const f = fixture({ firstPushFails: true });
    await f.producer.declare(FOLLOWEE, {});
    expect(f.outbox()).toEqual([{ seq: 1, sent_at: null }]);
    const first = f.push.mock.calls[0]![0];

    await f.producer.resendPending({});

    // Sent now, and by the sweep alone.
    expect(f.outbox()).toEqual([{ seq: 1, sent_at: expect.any(Number) }]);
    // The SAME bytes: dedup absorbs a repeat, a re-signature would not.
    expect(f.push.mock.calls[1]![0]).toEqual(first);
    expect(f.push).toHaveBeenCalledTimes(2);
  });

  it('allocates no new sequence number', async () => {
    const f = fixture({ firstPushFails: true });
    await f.producer.declare(FOLLOWEE, {});

    await f.producer.resendPending({});

    // One row, one number. A second number on this edge would be a second
    // statement, which the ordered engine may read as a fork.
    expect(f.outbox().map((r) => r.seq)).toEqual([1]);
  });

  it('sends nothing once the round is over', async () => {
    const f = fixture({ firstPushFails: true });
    await f.producer.declare(FOLLOWEE, {});
    const before = f.push.mock.calls.length;

    await f.producer.resendPending({ stillValid: () => false });

    expect(f.push.mock.calls.length).toBe(before);
    expect(f.outbox()).toEqual([{ seq: 1, sent_at: null }]); // still owed, not lost
  });

  it('leaves an already-delivered follow alone', async () => {
    const f = fixture();
    await f.producer.declare(FOLLOWEE, {});
    expect(f.outbox()[0]!.sent_at).not.toBeNull();

    await f.producer.resendPending({});

    // The sweep is for what never landed. Re-pushing what did would put the
    // same bytes on the wire forever, every tick.
    expect(f.push).toHaveBeenCalledTimes(1);
  });
});
