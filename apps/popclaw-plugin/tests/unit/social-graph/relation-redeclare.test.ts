/**
 * Saying the same thing again is not a new thing to say.
 *
 * Running `follow` twice used to mint a second numbered statement. Those are
 * not interchangeable: re-sending the same bytes is absorbed by the house's
 * dedup, while a fresh sequence number is a new fact — one the followee's
 * machine has to take seriously, one more line in a log that records what
 * CHANGED, and a `since` that moves for a relation that did not.
 *
 * The fix deliberately does not suppress. The queue that re-sends
 * unacknowledged originals has no caller in this build, so asking again is
 * currently the owner's only way to retry something that never reached the
 * house — silently doing nothing would turn a duplicate into a dead end.
 *
 * Half of these cases exist to catch the fix going too far. An unfollow then
 * a follow is genuinely three statements; the same person at a second house
 * is a separate edge; turning on taste subscription is a real change. Each of
 * those must still mint a new sequence number, and each is a way this could
 * have been written that would look right until someone lost a follow.
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

describe('following someone who is already followed', () => {
  it('finishes the statement already made instead of making a new one', async () => {
    const f = fixture();
    const first = await f.producer.declare(FOLLOWEE, {});
    const again = await f.producer.declare(FOLLOWEE, {});

    expect(again).toMatchObject({ mode: 'ordered', restated: true, seq: 1n });
    // The same statement, not a new one: same id, one row, one number used.
    expect(again).toMatchObject({ eventId: (first as { eventId: string }).eventId });
    expect(f.outbox()).toHaveLength(1);
    // And nothing was sent a second time, because the first one landed.
    expect(f.push).toHaveBeenCalledTimes(1);
  });

  it('re-sends the original when the first attempt never reached the house', async () => {
    const f = fixture({ firstPushFails: true });
    await f.producer.declare(FOLLOWEE, {});
    expect(f.outbox()[0]!.sent_at).toBeNull();

    const again = await f.producer.declare(FOLLOWEE, {});

    // The owner's second ask is the retry — this is the whole reason the fix
    // does not simply do nothing. Suppressing it would leave the original
    // queued for a sweep that this build never runs.
    expect(again).toMatchObject({ mode: 'ordered', restated: true, transport: 'accepted', seq: 1n });
    expect(f.outbox()[0]!.sent_at).not.toBeNull();
    // The SAME bytes. A re-send is absorbed by the house's dedup; a new
    // statement would not be.
    expect(f.push.mock.calls[1]![0]).toEqual(f.push.mock.calls[0]![0]);
  });

  it('an unfollow then a follow is still three statements', async () => {
    const f = fixture();
    await f.producer.declare(FOLLOWEE, {});
    await f.producer.revoke(FOLLOWEE);
    const third = await f.producer.declare(FOLLOWEE, {});

    // Over-suppression would collapse this to one, and the ordered engine
    // would lose the very history it exists to keep.
    expect(third).toMatchObject({ seq: 3n });
    expect(third).not.toHaveProperty('restated');
    expect(f.outbox().map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('the same person at a second house is a separate edge, starting again at one', async () => {
    const f = fixture();
    await f.producer.declare(FOLLOWEE, {});
    f.moveToOtherHouse();
    const atB = await f.producer.declare(FOLLOWEE, {});

    expect(atB).toMatchObject({ seq: 1n, houseKey: HOUSE_B });
    expect(atB).not.toHaveProperty('restated');
  });

  it('turning on taste subscription is a real change, not a restatement', async () => {
    const f = fixture();
    await f.producer.declare(FOLLOWEE, {});
    const upgraded = await f.producer.declare(FOLLOWEE, { tasteSubscribed: true });

    expect(upgraded).toMatchObject({ seq: 2n });
    expect(upgraded).not.toHaveProperty('restated');
  });
});
