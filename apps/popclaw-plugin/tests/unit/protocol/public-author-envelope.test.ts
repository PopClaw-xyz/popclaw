import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import { signEnvelope } from '../../../src/identity/sign-envelope.js';
import { makeTestSigner, noDmCrypto } from '../../helpers/test-signer.js';
import { canonicalizeEnvelope, popclaw } from '../../../src/protocol/public-envelope-generated.js';

function trackedSigner() {
  const signer = makeTestSigner('BlackFeather');
  return Object.assign(signer, { popclawId: vi.fn(signer.popclawId.bind(signer)), sign: vi.fn(signer.sign.bind(signer)) });
}
const valid = () => ({ actor: { nickname: 'author' }, post: { blocks: [{ content: 'hello' }] } });
async function refuses(envelope: Record<string, unknown>) {
  const signer = trackedSigner();
  await expect(signEnvelope(signer, envelope)).rejects.toThrow();
  expect(signer.popclawId).not.toHaveBeenCalled();
  expect(signer.sign).not.toHaveBeenCalled();
}

describe('public author envelope signing boundary', () => {
  for (const value of [undefined, null, [], '', 0, {}]) {
    it(`rejects unknown/removed fields before signer access (${String(value)})`, async () => {
      await refuses({ ...valid(), redPacket: value });
      await refuses({ profile: { nickname: 'author', payoutAddresses: value } });
      await refuses({ ...valid(), typo: value });
      await refuses({ ...valid(), event_id: value });
      await refuses({ ...valid(), body: value });
    });
  }
  it('recursively rejects unknown repeated-message fields', async () => {
    await refuses({ post: { blocks: [{ content: 'hello', privateExtra: undefined }] } });
  });
  it('rejects unsupported scalar/container coercions', async () => {
    for (const envelope of [
      { post: { blocks: {} } }, { post: { blocks: [null] } },
      { post: { blocks: [{ content: 42 }] } }, { timestamp: 1.5, post: {} },
      { timestamp: Number.MAX_SAFE_INTEGER + 1, post: {} },
      { post: { blocks: [{ blockType: 2 ** 32 }] } },
      { intent: { params: [1, 2] } }, { intent: { params: 'AA==' } },
    ]) await refuses(envelope);
  });
  it('rejects oneof collisions and missing bodies before signer access', async () => {
    await refuses({ post: {}, profile: {} });
    await refuses({ actor: {} });
  });
  it('does not invoke getters while inspecting message, array or map data', async () => {
    const getter = vi.fn(() => 'surprise');
    const envelope = valid();
    Object.defineProperty(envelope.actor, 'nickname', { get: getter, enumerable: true });
    await refuses(envelope);
    const blocks: unknown[] = [];
    Object.defineProperty(blocks, '0', { get: getter, enumerable: true });
    await refuses({ post: { blocks } });
    const metadata = Object.create(null);
    Object.defineProperty(metadata, 'label', { get: getter, enumerable: true });
    await refuses({ post: { blocks: [{ metadata }] } });
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects inherited message state and protobuf message instances', async () => {
    await refuses(Object.assign(Object.create({ timestamp: 123 }), valid()));
    await refuses(new popclaw.event.EventEnvelope({ post: {} }) as unknown as Record<string, unknown>);
  });
  it('rejects symbols, hidden unknown fields and decorated repeated arrays', async () => {
    await refuses(Object.assign(valid(), { [Symbol('hidden')]: true }));
    await refuses(Object.defineProperty(valid(), 'secret', { value: undefined }));
    const blocks = Object.assign([{ content: 'hello' }], { extra: 1 });
    await refuses({ post: { blocks } });
  });
  it('rejects cycles without signer access', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.post = cyclic;
    await refuses(cyclic);
  });
  it('preserves legal map keys as data, including names that are not profile fields', async () => {
    const metadata = Object.assign(Object.create(null), {
      payoutAddresses: 'literal', unknown: '', constructor: 'literal',
    });
    Object.defineProperty(metadata, '__proto__', { value: 'literal', enumerable: true });
    const envelope = { post: { blocks: [{ content: 'hello', metadata }] } };
    const signer = trackedSigner();
    const result = await signEnvelope(signer, envelope);
    expect(signer.sign.mock.calls[0]![0]).toEqual(canonicalizeEnvelope(envelope));
    const wrapped = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    expect(wrapped.payload.length).toBeGreaterThan(0);
  });
  it('signs the same detached snapshot despite mutation during signer lookup', async () => {
    const body = Uint8Array.of(1, 2, 3);
    const envelope = { actor: { nickname: 'original' }, houseEvent: { kind: 'client.test', body } };
    const expected = canonicalizeEnvelope(envelope);
    const signer = trackedSigner();
    const originalId = signer.popclawId;
    signer.popclawId = vi.fn(async () => {
      envelope.actor.nickname = 'changed'; body.fill(9);
      return originalId();
    });
    const result = await signEnvelope(signer, envelope);
    expect(signer.sign.mock.calls[0]![0]).toEqual(expected);
    const wrapped = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const signed = popclaw.event.EventEnvelope.decode(wrapped.payload);
    expect(signed.actor!.nickname).toBe('original');
    expect(Array.from(signed.houseEvent!.body!)).toEqual([1, 2, 3]);
  });
  it('preserves canonical defaults and explicit optional presence', async () => {
    for (const envelope of [
      { post: {}, timestamp: 0 },
      { post: {}, actor: { deviceId: new Uint8Array(), role: 0 } },
      { intent: { context: { schemaVersion: 0, validUntil: 0 }, params: Buffer.from([1]) } },
    ]) {
      const signer = trackedSigner();
      await signEnvelope(signer, envelope);
      expect(signer.sign.mock.calls[0]![0]).toEqual(canonicalizeEnvelope(envelope));
    }
  });
});

describe('public author scalar and schema fidelity', () => {
  it('preserves full-range Long and decimal-string canonical bytes', async () => {
    const longs = [
      popclaw.event.EventEnvelope.fromObject({ timestamp: '0' }).timestamp,
      popclaw.event.EventEnvelope.fromObject({ timestamp: '9007199254740993' }).timestamp,
      popclaw.event.EventEnvelope.fromObject({ timestamp: '18446744073709551615' }).timestamp,
    ];
    const envelopes = [
      ...[0, Number.MAX_SAFE_INTEGER, '0', '9007199254740993', '18446744073709551615', ...longs].map(timestamp => ({ post: {}, timestamp })),
      ...[0, -1, '0', { low: 0, high: 0, unsigned: false }, popclaw.event.EventEnvelope.fromObject({ timestamp: '0' }).timestamp, '9007199254740993', '9223372036854775807', '-9223372036854775808'].map(validUntil => ({ intent: { context: { validUntil } } })),
    ];
    for (const envelope of envelopes) {
        const signer = trackedSigner();
        await signEnvelope(signer, envelope);
        expect(signer.sign.mock.calls[0]![0]).toEqual(canonicalizeEnvelope(envelope));
    }
  });
  it('rejects lossy, ambiguous and out-of-range integers', async () => {
    for (const timestamp of [1n, '-0', '00', '01', '1e3', '18446744073709551616', '-1', NaN, Infinity,
      { low: 2 ** 32, high: 0 }, { low: 0, high: 0, extra: undefined }, { low: 0, high: 0, unsigned: 'false' },
    ]) await refuses({ post: {}, timestamp });
  });
  it('never calls an author Long method or reads inherited words', async () => {
    const toNumber = vi.fn(() => { throw new Error('must not run'); });
    const words = Object.assign(Object.create({ toNumber }), { low: 1, high: 0, unsigned: false });
    const signer = trackedSigner();
    await signEnvelope(signer, { post: {}, timestamp: words });
    expect(toNumber).not.toHaveBeenCalled();
    await refuses({ post: {}, timestamp: Object.create({ low: 1, high: 0 }) });
    const getter = vi.fn(() => 1);
    await refuses({ post: {}, timestamp: Object.defineProperty({ high: 0 }, 'low', { get: getter }) });
    expect(getter).not.toHaveBeenCalled();
    await refuses({ post: {}, timestamp: Object.defineProperty({ high: 0 }, 'low', { value: 1 }) });
    const protoGetter = vi.fn(() => () => 1);
    const badPrototype = Object.defineProperty({}, 'toNumber', { get: protoGetter });
    await refuses({ post: {}, timestamp: Object.assign(Object.create(badPrototype), { low: 1, high: 0 }) });
    expect(protoGetter).not.toHaveBeenCalled();
  });
  it('detaches Long words and maps before an asynchronous signer runs', async () => {
    const timestamp = { low: 9, high: 1, unsigned: false };
    const metadata = { label: 'original' };
    const envelope = { post: { blocks: [{ metadata }] }, timestamp };
    const expected = canonicalizeEnvelope(envelope);
    const signer = trackedSigner();
    const originalId = signer.popclawId;
    signer.popclawId = vi.fn(async () => { timestamp.low = 1; metadata.label = 'changed'; return originalId(); });
    await signEnvelope(signer, envelope);
    expect(signer.sign.mock.calls[0]![0]).toEqual(expected);
  });
  it('rejects typed-array proxies/decorations without calling their iterators', async () => {
    const iterator = vi.fn(() => { throw new Error('must not run'); });
    const proxy = new Proxy(new Uint8Array([1]), { get(target, key) { return key === Symbol.iterator ? iterator : Reflect.get(target, key); } });
    await refuses({ intent: { params: proxy } });
    const bytes = Object.assign(new Uint8Array([1]), { extra: undefined });
    await refuses({ intent: { params: bytes } });
    expect(iterator).not.toHaveBeenCalled();
  });
  it('preserves optional known null/undefined omission and open enum numbers', async () => {
    const envelope = { post: { blocks: [{ blockType: 1234, content: undefined }] }, actor: null, timestamp: undefined };
    const signer = trackedSigner();
    await signEnvelope(signer, envelope);
    expect(signer.sign.mock.calls[0]![0]).toEqual(canonicalizeEnvelope(envelope));
  });
  it('validates map values while preserving map key order canonicalization', async () => {
    await refuses({ post: { blocks: [{ metadata: { label: null } }] } });
    await refuses({ post: { blocks: [{ metadata: { label: { value: 'wrong type' } } }] } });
    const signer = trackedSigner();
    const envelope = { post: { blocks: [{ metadata: { z: 'last', '': 'empty key', a: 'first' } }] } };
    await signEnvelope(signer, envelope);
    expect(signer.sign.mock.calls[0]![0]).toEqual(canonicalizeEnvelope(envelope));
  });
});


describe('EventBuilder public author migration', () => {
  it('retains e75380b6 invite content, CID and signed bytes without discarded envelope.platform', async () => {
    const { EventBuilder } = await import('../../../src/event/event-builder.js');
    const signer = makeTestSigner('BlackFeather');
    vi.spyOn(Date, 'now').mockReturnValue(1747526400000);
    try {
      const envelope = await new EventBuilder(signer, 'BlackFeather').buildInviteRequest({
        platform: 'x', handle: 'blackfeather_ai', replace: true,
        proofUrl: 'https://x.com/blackfeather_ai/status/1', mirrorOptin: true,
      });
      expect(envelope).not.toHaveProperty('platform');
      expect(envelope.inviteRequest).toEqual({ platform: 'x', handle: 'blackfeather_ai', nickname: 'BlackFeather',
        replace: true, proofUrl: 'https://x.com/blackfeather_ai/status/1', mirrorOptin: true });
      const signed = await signEnvelope(signer, envelope);
      // Captured from the unmodified fixed source, including both signatures.
      expect(signed.eventId).toBe('e9ba7b67c5e7a087659f0e01b20206d87a1257542897ccd41b2dab6ffd9c4516');
      expect(Buffer.from(signed.signedPayloadBytes).toString('hex')).toBe('0a98020a4065396261376236376335653761303837363539663065303162323032303664383761313235373534323839376363643431623264616236666664396334353136123c0a2c374c685a38783663384b6d7735503957746e6d345436453759636254705a374e3774665a63714c527635634d120c426c61636b466561746865722880c6a4c10632406644e7dbf73d65fdaa3cb6011bd37114cac583125d4840ee53f849128c10e6b3e800ce4d4f5000c7db8932e43a807c90b71a517a3548086b9da3986c5030f90f5a4e0a0178120f626c61636b666561746865725f61691a0c426c61636b466561746865722801322668747470733a2f2f782e636f6d2f626c61636b666561746865725f61692f7374617475732f31380112406cbc2e8608585897d0235e24a1150cc9d02ed77cf0972f04a0db0f0a4a5e3bf529200ca5b3c4281b03c7426a42b03a41c514a77630adba2f62d7bdc58e9913061a205e3202f71ff769039b63bbc1b9e87707d360239fda0bb752ab87a6eff8e21eba');
    } finally { vi.restoreAllMocks(); }
  });
});


const publicVectors = JSON.parse(readFileSync(new URL('../../../../../protocol/packages/contracts/fixtures/public-baseline.json', import.meta.url), 'utf8')) as {
  signed: Array<{ name: string; wire_hex: string; canonical_hex: string; cid: string; signer_seed_hex: string; signed_payload_hex: string }>
};
describe('immutable public signed vectors through author validation', () => {
  for (const vector of publicVectors.signed) it(vector.name, async () => {
    // Explicit test-only conversion to author DTOs preserves own field presence;
    // the production boundary itself never coerces arbitrary protobuf instances.
    const decoded = popclaw.event.EventEnvelope.decode(Buffer.from(vector.wire_hex, 'hex'));
    const envelope = popclaw.event.EventEnvelope.toObject(decoded);
    delete envelope.eventId; delete envelope.signature;
    const key = nacl.sign.keyPair.fromSeed(Buffer.from(vector.signer_seed_hex, 'hex'));
    const signer = {
      ...noDmCrypto, publicKey: async () => key.publicKey,
      popclawId: vi.fn(async () => bs58.encode(key.publicKey)),
      sign: vi.fn(async (bytes: Uint8Array) => nacl.sign.detached(bytes, key.secretKey)),
    };
    const result = await signEnvelope(signer, envelope);
    expect(Buffer.from(signer.sign.mock.calls[0]![0]).toString('hex')).toBe(vector.canonical_hex);
    expect(result.eventId).toBe(vector.cid);
    if (vector.name === 'map_order_signed') {
      // JavaScript orders integer-like map keys before other own keys. The
      // existing signer preserves that output order; the immutable canonical
      // bytes/CID still match above. Preserve the exact e75380b6 output digest.
      expect(createHash('sha256').update(result.signedPayloadBytes).digest('hex')).toBe('dbb9ac69b283751ca67ccc00cb6c89d9381f02b8f45a0dbca9c57c595f09cd25');
    } else {
      expect(Buffer.from(result.signedPayloadBytes).toString('hex')).toBe(vector.signed_payload_hex);
    }
  });
});
