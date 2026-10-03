/**
 * The DM hand-over must produce a receipt, not merely a call.
 *
 * The wrapper this covers used to call the root's plain consumer without
 * returning its result and without touching the commit executor. The queue
 * then saw `undefined`: not a promise, so the synchronous-processor guard
 * could not fire, and nothing committed, so the row came back as "not
 * committed (no business hand-over)" — indistinguishable from a caller that
 * chose not to commit.
 *
 * The consequence was a loop, not a lost message: the row was never settled,
 * its claim went stale after a minute, it was re-claimed, and `attempts` never
 * grew because neither settle path ran. The same DM went through the consumer
 * again every minute for as long as the process lived. Only the inbox store's
 * duplicate gate kept the owner from being told about it each time — which is
 * why nothing about it looked wrong from outside.
 */
import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { makeDmHandover } from '../../../src/social-graph/relation-host.js';
import type { TrustedSource } from '../../../src/ingress/inbound-commit.js';

const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
const PEER = bs58.encode(kp.publicKey);
const ME = 'me-popclaw-id';
const SOURCE: TrustedSource = { houseKey: 'HOUSE-KEY-1', incarnation: '1', ownerGeneration: 1 };

function dmBytes(body = 'hello'): Uint8Array {
  const env = {
    actor: { popclawId: PEER }, target: {}, timestamp: 1_713_657_600,
    directMessage: { fromPopclawId: PEER, toPopclawId: ME, body, ts: 100 },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, kp.secretKey),
  }).finish();
}

/** The queue's executor: records whether the consumer actually used it. */
function executor() {
  const used: unknown[] = [];
  const commit = (fn: (tx: never) => unknown) => {
    used.push(fn({} as never));
    return { committed: true, value: used[used.length - 1] };
  };
  return { commit, used };
}

const base = { slugOf: (k: string) => `slug:${k}`, nicknameOf: () => 'Peer' };

describe('the DM hand-over', () => {
  it('passes a delivered receipt through without complaint', async () => {
    const e = executor();
    const handover = vi.fn((_dm: unknown, _slug: string) => ({ delivered: true }));
    const process = makeDmHandover({ ...base, handover: handover as never });
    expect(() => process(dmBytes(), SOURCE, e.commit)).not.toThrow();
    // The house slug reaches the consumer resolved, not raw.
    expect(handover.mock.calls[0]?.[1]).toBe('slug:HOUSE-KEY-1');
  });

  it('refuses loudly when no committing consumer is wired', () => {
    // This is the case that used to fall back to the plain consumer and report
    // nothing. A DM handed to something that cannot say whether it landed is a
    // DM nobody can account for, so the wiring fault is named.
    const e = executor();
    const process = makeDmHandover(base);
    expect(() => process(dmBytes(), SOURCE, e.commit)).toThrow('DM_HANDOVER_NOT_WIRED');
  });

  it('surfaces a refusal instead of discarding it', () => {
    const e = executor();
    const process = makeDmHandover({ ...base, handover: () => ({ delivered: false, reason: 'inbox full' }) });
    // The drain turns this into the failure settle: a recorded reason and a
    // backoff, rather than a row retried identically for ever.
    expect(() => process(dmBytes(), SOURCE, e.commit)).toThrow('inbox full');
  });

  it('refuses a promise-returning consumer by name', () => {
    const e = executor();
    // `=> { delivered }` does not stop an async function being passed, and its
    // "receipt" is a pending promise the queue would read as an object.
    const handover = (() => Promise.resolve({ delivered: true })) as never;
    const process = makeDmHandover({ ...base, handover });
    expect(() => process(dmBytes(), SOURCE, e.commit)).toThrow('DM_HANDOVER_MUST_BE_SYNCHRONOUS');
  });

  it('ignores a frame that is not a DM', () => {
    const e = executor();
    const handover = vi.fn(() => ({ delivered: true }));
    const process = makeDmHandover({ ...base, handover });
    const env = { actor: { popclawId: PEER }, target: {}, timestamp: 1, post: {} };
    const canonical = canonicalizeEnvelope(env);
    const bytes = popclaw.event.EventEnvelope.encode({
      ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, kp.secretKey),
    }).finish();
    expect(() => process(bytes, SOURCE, e.commit)).not.toThrow();
    // Not this consumer's mail: it must not be claimed, and it must not be
    // refused either — the relation consumer owns it.
    expect(handover).not.toHaveBeenCalled();
  });
});
