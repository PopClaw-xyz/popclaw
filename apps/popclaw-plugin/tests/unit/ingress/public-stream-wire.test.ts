import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope, cidFromCanonical, popclaw as fixedCodec } from '../../../src/protocol/public-envelope-generated.js';
import { verifyInboundEnvelope } from '../../../src/ingress/verify-envelope.js';
import { decodePublicControl, decodePublicFrame, verifyPublicEnvelope, type PublicEnvelopePolicy } from '../../../src/ingress/public-stream-wire.js';
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(101));
const otherKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(102));
const actor = bs58.encode(key.publicKey), otherActor = bs58.encode(otherKey.publicKey);
const policy: PublicEnvelopePolicy = { house: { origin: 'https://public.invalid', houseKey: actor, incarnation: 'house-one' }, capabilityRevision: 'revision-one', officialActorIds: [actor] };
const ordinaryPolicy = { ...policy, officialActorIds: [] };
const text = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(part => [...part]));
function vint(input: bigint | number): Uint8Array { let n = BigInt(input); const out: number[] = []; while (n >= 128n) { out.push(Number(n & 127n) | 128); n >>= 7n; } out.push(Number(n)); return new Uint8Array(out); }
const scalar = (tag: number, value: bigint | number) => join(vint(tag * 8), vint(value));
const field = (tag: number, bytes: Uint8Array) => join(vint(tag * 8 + 2), vint(bytes.length), bytes);
const BODIES: Record<string, [number, string]> = { inviteRequest: [11, 'invite_request'], questDispatch: [12, 'quest_dispatch'], questResult: [13, 'quest_result'], inviteVerified: [14, 'invite_verified'], rangerRegistration: [15, 'ranger_registration'], watchDispatch: [16, 'watch_dispatch'], watchHeartbeat: [17, 'watch_heartbeat'], watchCancel: [18, 'watch_cancel'], followDeclared: [20, 'follow_declared'], followRevoked: [21, 'follow_revoked'], reply: [25, 'reply'], directMessage: [26, 'direct_message'], post: [27, 'post'], profile: [28, 'profile'], redPacket: [29, 'red_packet'], mark: [30, 'mark'], markRevoked: [31, 'mark_revoked'], pollDispatch: [32, 'poll_dispatch'], pollReport: [33, 'poll_report'], houseEvent: [34, 'legacy-.unknown_fact'], intent: [35, 'intent'] };
function signed(body: Record<string, unknown>, extra: Record<string, unknown> = {}, signer = key): Uint8Array {
  const env = { actor: { popclawId: bs58.encode(signer.publicKey), nickname: 'Wire fixture' }, timestamp: 100, ...body, ...extra };
  const canonical = canonicalizeEnvelope(env);
  return (Object.hasOwn(body, 'redPacket') ? popclaw : fixedCodec).event.EventEnvelope.encode({ ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, signer.secretKey) }).finish();
}
function bodyWire(raw: Uint8Array, bodies: Uint8Array): Uint8Array {
  const header = { ...popclaw.event.EventEnvelope.decode(raw) } as Record<string, unknown>;
  for (const name of Object.keys(BODIES)) delete header[name];
  return join(popclaw.event.EventEnvelope.encode(header).finish(), bodies);
}
const opaque = (scopes: string[] = []) => ({ houseEvent: { kind: 'legacy-.unknown_fact', body: new Uint8Array([255, 0, 7]), publicScopes: scopes } });
function frame(raw: Uint8Array, kind: string, scopes: string[] = [], projection?: popclaw.event.IWorldFeedItem, seq = '9007199254740993'): Uint8Array {
  return popclaw.event.WorldStreamFrame.encode(popclaw.event.WorldStreamFrame.fromObject({ seq, envelope: raw, kind, scopes, ...(projection ? { projection } : {}) })).finish();
}

describe('public envelope original wire and producer trust', () => {
  it('covers all 21 body tags and exact durable routing names', () => {
    // followDeclared/followRevoked moved here in `.01.6`: a relation original is
    // owed to its two participants' personal streams and is never a public
    // fact, so the public lane refuses it on the body type alone. It still has
    // a routing name in BODIES, because the personal streams still use it.
    const denied = new Set(['redPacket', 'watchHeartbeat', 'directMessage', 'followDeclared', 'followRevoked', 'mark', 'markRevoked', 'pollDispatch', 'intent']);
    for (const [name, [, kind]] of Object.entries(BODIES)) {
      const raw = signed(name === 'houseEvent' ? opaque() : { [name]: {} });
      if (denied.has(name)) expect(() => verifyPublicEnvelope(raw, policy), name).toThrow();
      else expect(verifyPublicEnvelope(raw, policy).kind, name).toBe(kind);
    }
  });
  it('refuses a relation original on the public lane as NOT_PUBLIC, ordered or not', () => {
    // The whole ruled matrix, on the path production actually calls. `order` is
    // field 5 on FollowDeclared and field 3 on FollowRevoked; a present-but-
    // empty `order` is distinct from an absent one and neither is public.
    for (const [name, tag, orderTag] of [['followDeclared', 20, 5], ['followRevoked', 21, 3]] as const) {
      for (const [shape, body] of [
        ['order absent', { [name]: { followeePopclawId: otherActor } }],
        ['order present', { [name]: { followeePopclawId: otherActor, order: { seq: 7, houseKey: 'house' } } }],
        ['default fields', { [name]: {} }],
      ] as const) {
        expect(() => verifyPublicEnvelope(signed(body), policy), `${name} ${shape}`).toThrow('NOT_PUBLIC');
      }
      // order present but entirely default: only reachable by building the wire.
      const empty = bodyWire(signed({ [name]: {} }), field(tag, field(orderTag, new Uint8Array())));
      expect(() => verifyPublicEnvelope(empty, policy), `${name} order empty`).toThrow('NOT_PUBLIC');
    }
  });
  it('still reports a malformed relation envelope as the wire fault it is', () => {
    // The exclusion must not mask a structural error into NOT_PUBLIC: the wire
    // check runs first, so bad bytes are still named as bad bytes.
    const raw = signed({ followDeclared: { followType: 0 } });
    expect(() => verifyPublicEnvelope(bodyWire(raw, field(20, field(99, new Uint8Array()))), policy)).toThrow('UNSUPPORTED_FIELD');
    expect(() => verifyPublicEnvelope(bodyWire(raw, field(20, join(scalar(2, 0), scalar(2, 0)))), policy)).toThrow('DUPLICATE_FIELD');
    // And a badly signed public positive is still a signature failure.
    expect(() => verifyPublicEnvelope(signed(opaque(), {}, otherKey), policy)).toThrow('OFFICIAL_SOURCE_MISMATCH');
  });
  it('preserves opaque unknown zero-version/empty HouseEvents, Profile and signed scope order', () => {
    for (const body of [opaque(), opaque(['scopeB', 'scopeA']), { houseEvent: { kind: '-.x_' } }, { profile: {} }]) {
      const raw = signed(body), verified = verifyPublicEnvelope(raw, policy);
      expect(verified.eventId).toBe(popclaw.event.EventEnvelope.decode(raw).eventId);
      if (verified.envelope.houseEvent) expect(verified.envelope.houseEvent.schemaVersion ?? 0).toBe(0);
    }
    expect(verifyPublicEnvelope(signed(opaque(['scopeB', 'scopeA'])), policy).publicScopes).toEqual(['scopeB', 'scopeA']);
  });
  it('checks THIS house official set and accepts ordinary public with empty official IDs', () => {
    expect(verifyPublicEnvelope(signed({ profile: {} }), ordinaryPolicy).eventId).toHaveLength(64);
    for (const name of ['houseEvent', 'questDispatch', 'inviteVerified', 'watchDispatch', 'watchCancel']) {
      const raw = signed(name === 'houseEvent' ? opaque() : { [name]: {} });
      expect(() => verifyPublicEnvelope(raw, ordinaryPolicy)).toThrow('OFFICIAL_SOURCE_MISMATCH');
      expect(() => verifyPublicEnvelope(raw, { ...policy, officialActorIds: [otherActor] })).toThrow('OFFICIAL_SOURCE_MISMATCH');
    }
    expect(() => verifyPublicEnvelope(signed(opaque(), {}, otherKey), policy)).toThrow('OFFICIAL_SOURCE_MISMATCH');
  });
  it('rejects absent/duplicate/multiple/unknown body and repeated envelope fields', () => {
    expect(() => verifyPublicEnvelope(signed({}), policy)).toThrow();
    const raw = signed({ post: {} });
    for (const tag of [1, 2, 3, 4, 5, 6, 7]) {
      const extra = tag === 5 ? scalar(tag, 0) : field(tag, new Uint8Array());
      expect(() => verifyPublicEnvelope(join(extra, extra, raw), policy), `duplicate ${tag}`).toThrow();
    }
    for (const tag of [27, 26, 99]) expect(() => verifyPublicEnvelope(bodyWire(raw, join(field(tag, new Uint8Array()), field(27, new Uint8Array()))), policy)).toThrow();
    expect(() => verifyPublicEnvelope(join(raw, field(99, new Uint8Array())), policy)).toThrow();
  });
  it('rejects raw scope/filter/privacy and malformed existing target IDs while preserving GROUP duplicate order', () => {
    for (const target of [{ scope: 1 }, { scope: 3 }, { scope: 4 }, { scope: -1 }, { filterCriteria: 'undefined' }, ...['', 'a', '0OIl', '中文', bs58.encode(new Uint8Array(31)), bs58.encode(new Uint8Array(33))].map(id => ({ scope: 2, targetIds: [actor, id] }))]) {
      expect(() => verifyPublicEnvelope(signed({ post: {} }, { target }), policy)).toThrow();
    }
    expect(verifyPublicEnvelope(signed({ post: {} }, { target: { scope: 2, targetIds: [otherActor, actor, otherActor] } }), policy).envelope.target?.targetIds).toEqual([otherActor, actor, otherActor]);
    expect(verifyPublicEnvelope(signed({ post: {} }, { target: {} }), policy).eventId).toHaveLength(64);
    expect(() => verifyPublicEnvelope(signed({ post: {} }, { target: { scope: 2 } }), policy)).toThrow();
    expect(() => verifyPublicEnvelope(signed({ post: {} }, { target: { targetIds: [actor] } }), policy)).toThrow();
  });
  it('rejects Follow private/unknown values and duplicate privacy even when unsubscribed', () => {
    // These were privacy-field refusals before `.01.6`. The body type now
    // decides first, so the expected error is NOT_PUBLIC — asserted by name,
    // because a bare toThrow() here would pass no matter which rule fired and
    // would keep passing if both were deleted.
    for (const value of [1, 2, -1, 2147483647]) {
      for (const body of [{ followDeclared: { followType: value } }, { followDeclared: { tasteSubscriptionVisibility: value, tasteSubscribed: false } }, { followRevoked: { followType: value } }]) expect(() => verifyPublicEnvelope(signed(body), policy)).toThrow('NOT_PUBLIC');
    }
    // A duplicate singular privacy field is still a wire fault, not NOT_PUBLIC.
    const raw = signed({ followDeclared: { followType: 0, tasteSubscriptionVisibility: 0 } });
    const encoded = popclaw.event.FollowDeclared.encode(popclaw.event.EventEnvelope.decode(raw).followDeclared!).finish();
    for (const tag of [2, 4]) expect(() => verifyPublicEnvelope(bodyWire(raw, field(20, join(scalar(tag, 1), encoded))), policy)).toThrow('DUPLICATE_FIELD');
  });
  it('rejects unknown or ambiguous Actor/Recipient/Follow/HouseEvent wrapper structures', () => {
    const raw = signed({ post: {} });
    for (const [tag, nested] of [[2, field(9, text('unknown'))], [3, field(9, text('unknown'))], [3, join(scalar(1, 1), scalar(1, 0))], [3, field(1, text('wrong'))]] as const) expect(() => verifyPublicEnvelope(join(field(tag, nested), raw), policy)).toThrow();
    const he = signed(opaque()), body = popclaw.event.HouseEvent.encode(popclaw.event.EventEnvelope.decode(he).houseEvent!).finish();
    for (const extra of [field(5, text('unknown')), field(1, text('other.kind')), field(2, text('wrong'))]) expect(() => verifyPublicEnvelope(bodyWire(he, field(34, join(body, extra))), policy)).toThrow();
    const follow = signed({ followDeclared: {} });
    expect(() => verifyPublicEnvelope(bodyWire(follow, field(20, field(5, text('unknown')))), policy)).toThrow();
  });
  it('enforces scope limits and legacy kind grammar without interpreted schema rules', () => {
    for (const scopes of [['same', 'same'], ['bad.scope'], ['abc'], ['a'.repeat(65)], Array.from({ length: 33 }, (_, i) => `scope_${i}`)]) expect(() => verifyPublicEnvelope(signed(opaque(scopes)), policy)).toThrow();
    for (const kind of ['', 'Upper.x', 'a.b.c', 'a.b-c', 'a'.repeat(128) + '.x']) expect(() => verifyPublicEnvelope(signed({ houseEvent: { kind } }), policy)).toThrow();
    expect(verifyPublicEnvelope(signed(opaque(Array.from({ length: 32 }, (_, i) => `scope_${i}`))), policy).publicScopes).toHaveLength(32);
  });
  it('uses actual CID/signature and accepts legal field ordering without raw re-encode equality', () => {
    const raw = signed(opaque()), env = popclaw.event.EventEnvelope.decode(raw);
    const reordered = join(field(34, popclaw.event.HouseEvent.encode(env.houseEvent!).finish()), field(6, env.signature), scalar(5, 100), field(2, popclaw.identity.ActorInfo.encode(env.actor!).finish()), field(1, text(env.eventId)));
    expect(verifyPublicEnvelope(reordered, policy).eventId).toBe(env.eventId);
    env.signature[0] = env.signature[0]! ^ 1;
    expect(() => verifyPublicEnvelope(popclaw.event.EventEnvelope.encode(env).finish(), policy)).toThrow('SIGNATURE_INVALID');
    env.eventId = '0'.repeat(64);
    expect(() => verifyPublicEnvelope(popclaw.event.EventEnvelope.encode(env).finish(), policy)).toThrow('CID_MISMATCH');
  });
  it('preserves Rust canonical semantics for explicit zero HouseEvent schema_version', () => {
    // Baseline canonical bytes omit schemaVersion. The raw equivalent writes
    // tag 2=0 explicitly, as accepted by the Rust public-envelope boundary.
    const raw = signed(opaque()), env = popclaw.event.EventEnvelope.decode(raw);
    const explicit = bodyWire(raw, field(34, join(popclaw.event.HouseEvent.encode(env.houseEvent!).finish(), scalar(2, 0))));
    expect(verifyInboundEnvelope(explicit, { publicStream: true, isOfficialActor: id => id === actor }).eventId).toBe(env.eventId);
    expect(verifyPublicEnvelope(explicit, policy).eventId).toBe(env.eventId);
    expect(new Uint8Array(decodePublicFrame(frame(explicit, 'legacy-.unknown_fact'), policy).frame.envelope)).toEqual(explicit);
  });
});

describe('raw control fields and uint64 presence', () => {
  it('keeps max uint64 and absent versus present zero exact', () => {
    const max = (1n << 64n) - 1n;
    expect(decodePublicControl('public_boundary', join(field(1, text('log')), scalar(3, max))).highWaterSeq.toString()).toBe(max.toString());
    expect(decodePublicControl('public_checkpoint', field(1, text('replay'))).publicThroughSeq == null).toBe(true);
    expect(decodePublicControl('public_checkpoint', scalar(3, 0)).publicThroughSeq?.toString()).toBe('0');
    const cp = decodePublicControl('public_checkpoint', join(field(2, join(field(1, text('scopeA')), scalar(2, max))), scalar(3, max)));
    expect(cp.publicThroughSeq?.toString()).toBe(max.toString()); expect(cp.scopes[0]?.throughSeq?.toString()).toBe(max.toString());
  });
  it('rejects duplicate/unknown/wrong-wire controls and nested ambiguous ScopeThrough/Boundary', () => {
    for (const type of ['public_boundary', 'public_checkpoint', 'public_gap'] as const) for (const raw of [join(field(1, text('x')), field(1, text('y'))), field(99, text('unknown')), scalar(1, 1)]) expect(() => decodePublicControl(type, raw)).toThrow();
    for (const raw of [join(scalar(3, 1), scalar(3, 2)), scalar(4, 2)]) expect(() => decodePublicControl('public_boundary', raw)).toThrow();
    for (const scope of [join(field(1, text('a')), field(1, text('b'))), field(3, text('unknown')), join(scalar(2, 1), scalar(2, 2))]) expect(() => decodePublicControl('public_checkpoint', field(2, scope))).toThrow();
    expect(() => decodePublicControl('public_gap', field(4, field(99, text('unknown'))))).toThrow();
  });
  it('rejects malformed UTF-8, illegal keys, truncated lengths and overflowing uint64', () => {
    for (const raw of [field(1, new Uint8Array([255])), new Uint8Array([0]), new Uint8Array([128]), new Uint8Array([10, 9]), join(vint(24), new Uint8Array(10).fill(255), new Uint8Array([1]))]) expect(() => decodePublicControl('public_boundary', raw)).toThrow();
  });
  it('leaves selection/high-water/gap reason semantics to the journal', () => {
    const value = decodePublicControl('public_gap', popclaw.world.PublicStreamGap.encode({ reason: 'future-reason', lane: 'connection', boundary: { scopes: ['scopeB', 'scopeA'] } }).finish());
    expect(value.reason).toBe('future-reason'); expect(value.boundary?.scopes).toEqual(['scopeB', 'scopeA']);
  });
});

describe('public frame binding and mirrored attribution', () => {
  it('retains full seq, original opaque bytes, exact signed scopes and absent projection', () => {
    const raw = signed(opaque(['scopeB', 'scopeA'])), result = decodePublicFrame(frame(raw, 'legacy-.unknown_fact', ['scopeB', 'scopeA']), policy);
    expect(result.frame.seq.toString()).toBe('9007199254740993'); expect(result.frame.envelope).toEqual(raw); expect(result.publicScopes).toEqual(['scopeB', 'scopeA']); expect(result.frame.projection).toBeNull();
  });
  it('rejects mismatched kind/scopes, duplicate/unknown frame fields and unsigned inner data', () => {
    const raw = signed(opaque(['scopeB', 'scopeA']));
    for (const [kind, scopes] of [['post', ['scopeB', 'scopeA']], ['legacy-.unknown_fact', ['scopeA', 'scopeB']], ['legacy-.unknown_fact', ['scopeB']]] as [string, string[]][]) expect(() => decodePublicFrame(frame(raw, kind, scopes), policy)).toThrow();
    const encoded = frame(raw, 'legacy-.unknown_fact', ['scopeB', 'scopeA']);
    for (const extra of [scalar(1, 1), field(2, raw), field(3, text('post')), field(9, new Uint8Array())]) expect(() => decodePublicFrame(join(encoded, extra), policy)).toThrow();
    expect(() => decodePublicFrame(frame(popclaw.event.EventEnvelope.encode({ post: {} }).finish(), 'post'), policy)).toThrow();
  });
  it('binds projection to content CID while retaining mirrored author/platform baked data', () => {
    const raw = signed({ post: { blocks: [{ content: 'mirrored' }], origin: { platform: 'x', postId: 'source-post', createdAt: 123 } } });
    const eventId = popclaw.event.EventEnvelope.decode(raw).eventId;
    const projection = { eventId, authorPopclawId: otherActor, platform: 'x', platformPostId: 'source-post', textPreview: 'mirrored', actorVerified: [{ platform: 'x', handle: 'source_author' }] };
    const result = decodePublicFrame(frame(raw, 'post', [], projection), policy);
    expect(result.frame.projection?.authorPopclawId).toBe(otherActor); expect(result.frame.projection?.platformPostId).toBe('source-post');
    for (const bad of [{ ...projection, eventId: '0'.repeat(64) }, { ...projection, envelope: raw }]) expect(() => decodePublicFrame(frame(raw, 'post', [], bad), policy)).toThrow();
    const profile = signed({ profile: {} });
    expect(() => decodePublicFrame(frame(profile, 'profile', [], { eventId: popclaw.event.EventEnvelope.decode(profile).eventId }), policy)).toThrow();
  });
});


describe('public-only canonical compatibility and strict nested metadata', () => {
  it.each([
    { invalid: [0x80], alias: '' },
    { invalid: [0xc0, 0x80], alias: '\ufffd' },
  ] satisfies Array<{ invalid: number[]; alias: string }>)('rejects invalid typed UTF-8 that the pinned codec aliases away from the signed value ($invalid)', ({ invalid, alias }) => {
    const valid = signed({ profile: { nickname: '\u0000' } });
    const raw = bodyWire(valid, field(28, field(1, new Uint8Array(invalid))));
    // The permissive decoder never reconstructs the signed NUL from invalid
    // wire (pinned vendor codec: [0x80] decodes to '', [0xc0,0x80] to U+FFFD;
    // the old pre-pin codec aliased both to NUL). Whatever the alias, the
    // strict guard still rejects the raw bytes — that is the protection.
    expect(popclaw.event.EventEnvelope.decode(raw).profile?.nickname).toBe(alias);
    expect(verifyPublicEnvelope(valid, policy).eventId).toHaveLength(64);
    expect(() => verifyPublicEnvelope(raw, policy)).toThrow();
  });
  it('rejects malformed UTF-8 in repeated nested typed messages and map keys/values', () => {
    const invalid = new Uint8Array([0x80]);
    const payout = signed({ profile: { payoutAddresses: [{ chain: '\u0000', address: 'address' }] } });
    expect(() => verifyPublicEnvelope(bodyWire(payout, field(28, field(8,
      join(field(1, invalid), field(2, text('address')))))), policy)).toThrow();
    for (const badKey of [true, false]) {
      const key = badKey ? '\u0000' : 'key', value = badKey ? 'value' : '\u0000';
      const raw = signed({ post: { blocks: [{ metadata: { [key]: value } }] } });
      const entry = join(field(1, badKey ? invalid : text(key)), field(2, badKey ? text(value) : invalid));
      expect(() => verifyPublicEnvelope(bodyWire(raw, field(27, field(1, field(3, entry)))), policy)).toThrow();
    }
  });
  it('rejects unknown and duplicate singular fields while preserving repeated/map and opaque values', () => {
    const raw = signed({ profile: { nickname: 'last', tasteTags: ['same', 'same'] } });
    const body = popclaw.profile.Profile.encode(popclaw.event.EventEnvelope.decode(raw).profile!).finish();
    const unknown = join(field(99, new Uint8Array([0xff, 0x80])), scalar(100, (1n << 64n) - 1n),
      vint(101 * 8 + 1), new Uint8Array(8), vint(102 * 8 + 5), new Uint8Array(4),
      vint(103 * 8 + 3), field(1, new Uint8Array([0xff])), vint(103 * 8 + 4));
    expect(() => verifyPublicEnvelope(bodyWire(raw, field(28, join(field(1, text('first')), body, unknown))), policy)).toThrow();
    expect(verifyPublicEnvelope(raw, policy).envelope.profile?.tasteTags).toEqual(['same', 'same']);
    const mapped = signed({ post: { blocks: [{ content: 'valid unicode 中😀', metadata: { a: '', z: 'last' } }] } });
    expect(verifyPublicEnvelope(mapped, policy).eventId).toHaveLength(64);
    expect(new Uint8Array(verifyPublicEnvelope(signed(opaque()), policy).envelope.houseEvent!.body!)).toEqual(new Uint8Array([255, 0, 7]));
  });
  it('rejects every malformed known occurrence and wrong typed wire even when decoding could hide it', () => {
    const profile = signed({ profile: { nickname: 'last' } });
    const body = popclaw.profile.Profile.encode(popclaw.event.EventEnvelope.decode(profile).profile!).finish();
    for (const bad of [field(1, new Uint8Array([0x80])), scalar(1, 0), field(7, new Uint8Array([0]))]) {
      expect(() => verifyPublicEnvelope(bodyWire(profile, field(28, join(bad, body))), policy)).toThrow();
    }
    const post = signed({ post: {} });
    for (const bad of [field(1, scalar(2, 0)), field(1, field(3, scalar(1, 0))), field(99, new Uint8Array([0xff])).slice(0, -1),
      join(vint(99 * 8 + 3), vint(98 * 8 + 4))]) {
      expect(() => verifyPublicEnvelope(bodyWire(post, field(27, bad)), policy)).toThrow();
    }
  });
  it('rejects unknown typed groups at every depth', () => {
    const raw = signed({ profile: {} });
    const nested = (levels: number) => join(...Array.from({ length: levels }, () => vint(99 * 8 + 3)),
      ...Array.from({ length: levels }, () => vint(99 * 8 + 4)));
    expect(() => verifyPublicEnvelope(bodyWire(raw, field(28, nested(99))), policy)).toThrow('UNSUPPORTED_FIELD');
    expect(() => verifyPublicEnvelope(bodyWire(raw, field(28, nested(100))), policy)).toThrow();
  });
  it('matches the accepted Rust seed-7 explicit-default/reordered envelope fixture exactly', () => {
    // Same fixture as lore-house bus/public_envelope.rs signed_house() and
    // real_signature_preserves_original_legal_wire_encodings (accepted A).
    const rustKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const rustActor = bs58.encode(rustKey.publicKey);
    const env = {
      actor: { popclawId: rustActor, nickname: 'n' },
      houseEvent: { kind: 'unknown-.fact_1', body: new Uint8Array([0, 255, 7]), publicScopes: ['scopeB', 'scopeA'] },
    };
    const canonical = canonicalizeEnvelope(env), cid = cidFromCanonical(canonical);
    const signature = nacl.sign.detached(canonical, rustKey.secretKey);
    const raw = join(field(34, join(popclaw.event.HouseEvent.encode(env.houseEvent).finish(), scalar(2, 0))), field(6, signature), scalar(5, 0), field(2, popclaw.identity.ActorInfo.encode(env.actor).finish()), field(1, text(cid)));
    const captured = { ...policy, officialActorIds: [rustActor] };
    expect(verifyInboundEnvelope(raw, { publicStream: true, isOfficialActor: id => id === rustActor }).eventId).toBe(cid);
    expect(verifyPublicEnvelope(raw, captured).eventId).toBe(cid);
    const original = new Uint8Array(raw);
    const checked = decodePublicFrame(frame(raw, env.houseEvent.kind, env.houseEvent.publicScopes), captured);
    expect(new Uint8Array(checked.frame.envelope)).toEqual(original);
    expect(raw).toEqual(original);
  });
  it('preserves optional zero/empty Actor presence and sorted map canonical semantics', () => {
    const raw = signed({ post: { blocks: [{ content: 'map', metadata: { z: '', a: 'first' } }] } }, {
      actor: { popclawId: actor, nickname: 'n', supersedes: '', deviceId: new Uint8Array(), role: 0 },
    });
    const decoded = verifyPublicEnvelope(raw, policy).envelope;
    expect(Object.hasOwn(decoded.actor!, 'deviceId')).toBe(true);
    expect(Object.hasOwn(decoded.actor!, 'supersedes')).toBe(true);
    expect(Object.hasOwn(decoded.actor!, 'role')).toBe(true);
    expect(decoded.actor?.role).toBe(0);
    const noPresence = popclaw.event.EventEnvelope.decode(raw);
    delete noPresence.actor!.deviceId;
    expect(() => verifyPublicEnvelope(popclaw.event.EventEnvelope.encode(noPresence).finish(), policy)).toThrow('CID_MISMATCH');
  });
  it('rejects raw scalar overflow, repeated projection metadata and unknown nested origin/verified fields', () => {
    const raw = signed({ post: {} });
    for (const bad of [scalar(1, 1n << 32n), scalar(1, (1n << 64n) - 1n)]) {
      expect(() => verifyPublicEnvelope(join(field(3, bad), raw), policy)).toThrow();
    }
    const id = popclaw.event.EventEnvelope.decode(raw).eventId;
    const base = join(scalar(1, 1), field(2, raw), field(3, text('post')));
    for (const projection of [join(field(19, text(id)), field(19, text(id))), join(field(19, text(id)), field(21, field(99, text('unknown')))), join(field(19, text(id)), field(17, field(99, text('unknown'))))]) {
      expect(() => decodePublicFrame(join(base, field(4, projection)), policy)).toThrow();
    }
    expect(decodePublicFrame(frame(raw, 'post', [], undefined, '18446744073709551615'), policy).frame.seq.toString()).toBe('18446744073709551615');
    expect(() => decodePublicFrame(frame(raw, 'post', [], undefined, '0'), policy)).toThrow();
  });
});
