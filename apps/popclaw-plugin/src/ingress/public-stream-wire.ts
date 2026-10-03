import { decodeEnvelope, checkPublicEnvelopeStructure, L_ENVELOPE_MAX_BYTES } from '../protocol/public-envelope.js';
import { popclaw } from '@popclaw/contracts';
import bs58 from 'bs58';
import type { VerifiedPublicStreamCapability } from '../world/world-capabilities.js';
import { verifyInboundEnvelope } from './verify-envelope.js';

export interface PublicEnvelopePolicy {
  readonly house: VerifiedPublicStreamCapability['house'];
  readonly capabilityRevision: string;
  readonly officialActorIds: readonly string[];
}
export interface VerifiedPublicEnvelope {
  readonly eventId: string;
  readonly kind: string;
  readonly publicScopes: readonly string[];
  readonly envelope: popclaw.event.EventEnvelope;
}
export interface VerifiedPublicFrame extends VerifiedPublicEnvelope {
  readonly frame: popclaw.event.WorldStreamFrame;
}
export type PublicControlType = 'public_boundary' | 'public_checkpoint' | 'public_gap';
export type PublicControl = popclaw.world.PublicStreamBoundary | popclaw.world.PublicStreamCheckpoint | popclaw.world.PublicStreamGap;
// Transport bytes are never replaced by the verification-only encoding below.

const MAX_ENVELOPE_BYTES = L_ENVELOPE_MAX_BYTES;
const U32 = (1n << 32n) - 1n;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const kinds: Readonly<Record<number, string>> = {
  11: 'invite_request', 12: 'quest_dispatch', 13: 'quest_result', 14: 'invite_verified',
  15: 'ranger_registration', 16: 'watch_dispatch', 17: 'watch_heartbeat', 18: 'watch_cancel',
  20: 'follow_declared', 21: 'follow_revoked', 25: 'reply', 26: 'direct_message',
  27: 'post', 28: 'profile', 30: 'mark', 31: 'mark_revoked',
  32: 'poll_dispatch', 33: 'poll_report', 34: 'house_event', 35: 'intent',
};
function fail(code = 'PUBLIC_WIRE_INVALID'): never { throw new Error(code); }

type Shape = 'envelope' | 'actor' | 'recipient' | 'followDeclared' | 'followRevoked' | 'houseEvent'
  | 'snapshot' | 'discovery' | 'boundary' | 'checkpoint' | 'gap' | 'through' | 'frame' | 'projection' | 'origin' | 'verified';
interface Rule { wire: 0 | 2; text?: boolean; repeated?: boolean; shape?: Shape; max?: bigint }
interface WireField { value?: bigint; bytes?: Uint8Array; child?: WireMessage }
interface WireMessage { fields: Map<number, WireField[]>; body?: number }
const string = (repeated = false): Rule => ({ wire: 2, text: true, repeated });
const bytes: Rule = { wire: 2 };
const uint = (max?: bigint): Rule => ({ wire: 0, ...(max === undefined ? {} : { max }) });
const message = (shape: Shape, repeated = false): Rule => ({ wire: 2, shape, repeated });
const shapes: Record<Shape, Readonly<Record<number, Rule>>> = {
  envelope: { 1: string(), 2: message('actor'), 3: message('recipient'), 4: string(), 5: uint(), 6: bytes, 7: string(),
    ...Object.fromEntries(Object.keys(kinds).map(tag => [tag, bytes])),
    20: message('followDeclared'), 21: message('followRevoked'), 34: message('houseEvent') },
  actor: { 1: string(), 2: string(), 3: string(), 4: bytes, 5: uint(1n) },
  recipient: { 1: uint(3n), 2: string(true), 3: string() },
  followDeclared: { 1: string(), 2: uint(1n), 3: uint(), 4: uint(1n) },
  followRevoked: { 1: string(), 2: uint(1n) },
  houseEvent: { 1: string(), 2: uint(U32), 3: bytes, 4: string(true) },
  boundary: { 1: string(), 2: string(true), 3: uint(), 4: uint(1n) },
  checkpoint: { 1: string(), 2: message('through', true), 3: uint() },
  gap: { 1: string(), 2: string(), 3: string(), 4: message('boundary') },
  through: { 1: string(), 2: uint() },
  frame: { 1: uint(), 2: bytes, 3: string(), 4: message('projection'), 5: string(true) },
  projection: { ...Object.fromEntries([1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 23, 24].map(tag => [tag, string()])),
    3: uint(), 17: message('verified', true), 18: message('verified', true), 20: uint(), 21: message('origin'), 22: bytes, 25: uint() },
  snapshot: { 1: message('projection', true) },
  discovery: { 1: uint(1n), 2: bytes },
  origin: { 1: string(), 2: string(), 3: string(), 4: uint(), 5: string() },
  verified: { 1: string(), 2: string(), 3: string(), 4: uint(), 5: string() },
};

/** Strict envelope/privacy/control wrappers; typed body structure is checked below. */
function scan(raw: Uint8Array, shape: Shape): WireMessage {
  let offset = 0;
  const out: WireMessage = { fields: new Map() };
  const varint = (): bigint => {
    let result = 0n;
    for (let index = 0; index < 10; index++) {
      const byte = raw[offset++];
      if (byte === undefined || (index === 9 && byte > 1)) fail();
      result |= BigInt(byte & 127) << BigInt(index * 7);
      if ((byte & 128) === 0) return result;
    }
    return fail();
  };
  while (offset < raw.length) {
    const key = varint(), tagValue = key >> 3n;
    if (!tagValue || tagValue > 0x1fff_ffffn) fail();
    const tag = Number(tagValue), rule = shapes[shape][tag];
    if (!rule || Number(key & 7n) !== rule.wire || (!rule.repeated && out.fields.has(tag))) fail();
    if (shape === 'envelope' && kinds[tag]) {
      if (out.body !== undefined) fail();
      out.body = tag;
    }
    const field: WireField = {};
    if (rule.wire === 0) {
      field.value = varint();
      if (rule.max !== undefined && field.value > rule.max) fail();
    } else {
      const length = varint();
      if (length > BigInt(raw.length - offset)) fail();
      field.bytes = raw.subarray(offset, offset + Number(length));
      offset += Number(length);
      if (rule.text) { try { utf8.decode(field.bytes); } catch { fail(); } }
      if (rule.shape) field.child = scan(field.bytes, rule.shape);
    }
    const list = out.fields.get(tag) ?? [];
    list.push(field); out.fields.set(tag, list);
  }
  return out;
}

export function verifyPublicEnvelope(raw: Uint8Array, policy: PublicEnvelopePolicy): VerifiedPublicEnvelope {
  if (!raw.length || raw.length > MAX_ENVELOPE_BYTES) fail('PUBLIC_ENVELOPE_SIZE_INVALID');
  const bodyTag = checkPublicEnvelopeStructure(raw);
  const envelope = decodeEnvelope(raw);
  const target = envelope.target;
  if (target) {
    if (![0, 2].includes(target.scope ?? 0) || target.filterCriteria) fail('PUBLIC_ENVELOPE_TARGET_INVALID');
    for (const id of target.targetIds ?? []) {
      // A 32-byte key has at most 44 Base58 characters. Bound the decoder;
      // registration, uniqueness and GROUP nonemptiness are not new rules.
      if (id.length > 44) fail('PUBLIC_ENVELOPE_TARGET_INVALID');
      try { if (bs58.decode(id).length !== 32) fail('PUBLIC_ENVELOPE_TARGET_INVALID'); }
      catch { fail('PUBLIC_ENVELOPE_TARGET_INVALID'); }
    }
  }
  if ((envelope.followDeclared?.followType ?? 0) !== 0
    || (envelope.followDeclared?.tasteSubscriptionVisibility ?? 0) !== 0
    || (envelope.followRevoked?.followType ?? 0) !== 0) fail('PUBLIC_ENVELOPE_FOLLOW_PRIVATE');
  const houseEvent = envelope.houseEvent;
  const publicScopes = [...(houseEvent?.publicScopes ?? [])];
  if (houseEvent && (!/^[a-z0-9-]+\.[a-z0-9_]+$/.test(houseEvent.kind ?? '') || (houseEvent.kind?.length ?? 0) > 128)) fail('PUBLIC_ENVELOPE_KIND_INVALID');
  if (publicScopes.length > 32 || new Set(publicScopes).size !== publicScopes.length
    || publicScopes.some(scope => !/^[A-Za-z0-9_-]{4,64}$/.test(scope))) fail('PUBLIC_ENVELOPE_SCOPES_INVALID');
  verifyInboundEnvelope(raw, { publicStream: true, isOfficialActor: id => policy.officialActorIds.includes(id) });
  return { eventId: envelope.eventId, kind: houseEvent?.kind ?? kinds[bodyTag]!, publicScopes, envelope };
}

function exactUint64(decoded: { toString(): string } | number | null | undefined, expected: bigint): void {
  if (decoded == null || (typeof decoded === 'number' && !Number.isSafeInteger(decoded)) || decoded.toString() !== expected.toString()) fail('PUBLIC_WIRE_UINT64_INVALID');
}
function value(wire: WireMessage, tag: number): bigint { return wire.fields.get(tag)?.[0]?.value ?? 0n; }
function boundaryPrecision(decoded: popclaw.world.IPublicStreamBoundary, wire: WireMessage): void {
  exactUint64(decoded.highWaterSeq, value(wire, 3));
}
export function decodePublicControl(type: 'public_boundary', raw: Uint8Array): popclaw.world.PublicStreamBoundary;
export function decodePublicControl(type: 'public_checkpoint', raw: Uint8Array): popclaw.world.PublicStreamCheckpoint;
export function decodePublicControl(type: 'public_gap', raw: Uint8Array): popclaw.world.PublicStreamGap;
export function decodePublicControl(type: PublicControlType, raw: Uint8Array): PublicControl;
export function decodePublicControl(type: PublicControlType, raw: Uint8Array): PublicControl {
  if (type === 'public_boundary') {
    const wire = scan(raw, 'boundary'), result = popclaw.world.PublicStreamBoundary.decode(raw);
    boundaryPrecision(result, wire); return result;
  }
  if (type === 'public_checkpoint') {
    const wire = scan(raw, 'checkpoint'), result = popclaw.world.PublicStreamCheckpoint.decode(raw);
    const scopes = wire.fields.get(2) ?? [];
    result.scopes.forEach((scope, index) => exactUint64(scope.throughSeq, value(scopes[index]!.child!, 2)));
    if (wire.fields.has(3)) exactUint64(result.publicThroughSeq, value(wire, 3));
    else if (result.publicThroughSeq != null) fail('PUBLIC_WIRE_UINT64_PRESENCE_INVALID');
    return result;
  }
  if (type !== 'public_gap') fail('PUBLIC_WIRE_CONTROL_INVALID');
  const wire = scan(raw, 'gap'), result = popclaw.world.PublicStreamGap.decode(raw);
  const boundary = wire.fields.get(4)?.[0]?.child;
  if (boundary) {
    if (!result.boundary) fail();
    boundaryPrecision(result.boundary, boundary);
  }
  return result;
}
export function decodePublicFrame(raw: Uint8Array, policy: PublicEnvelopePolicy): VerifiedPublicFrame {
  const wire = scan(raw, 'frame'), frame = popclaw.event.WorldStreamFrame.decode(raw);
  exactUint64(frame.seq, value(wire, 1));
  if (value(wire, 1) === 0n) fail('PUBLIC_FRAME_SEQUENCE_INVALID');
  const verified = verifyPublicEnvelope(frame.envelope, policy);
  if (frame.kind !== verified.kind || frame.scopes.length !== verified.publicScopes.length
    || frame.scopes.some((scope, index) => scope !== verified.publicScopes[index])) fail('PUBLIC_FRAME_BINDING_INVALID');
  if (frame.projection && (!['post', 'reply', 'houseEvent'].includes(verified.envelope.body ?? '')
    || frame.projection.eventId !== verified.eventId || frame.projection.envelope?.length)) fail('PUBLIC_FRAME_PROJECTION_INVALID');
  // Baked platform/author/verified attribution belongs to the trusted relay;
  // mirror author identity need not equal the actor that signed the envelope.
  return { frame, ...verified };
}

/** Inspect every original carrier occurrence before a protobuf decoder can merge it.
 * Projection-only material is allowed solely as a supplement to a verified frame. */
export function inspectPublicCarrier(raw: Uint8Array, shape: 'frame' | 'projection' | 'snapshot' | 'discovery', projectionOnly = false): Uint8Array[] {
  if (raw.length > 8 * 1024 * 1024) fail('PUBLIC_CARRIER_SIZE_INVALID');
  const wire = scan(raw, shape), envelopes: Uint8Array[] = [];
  const inspectProjection = (item: WireMessage, supplement: boolean) => {
    const envelope = item.fields.get(22)?.[0]?.bytes;
    if (envelope?.length) { checkPublicEnvelopeStructure(envelope); envelopes.push(envelope); }
    else if (!supplement) fail('PUBLIC_ENVELOPE_EVIDENCE_REQUIRED');
  };
  if (shape === 'snapshot') for (const field of wire.fields.get(1) ?? []) inspectProjection(field.child!, false);
  else if (shape === 'projection') inspectProjection(wire, projectionOnly);
  else {
    const envelope = wire.fields.get(2)?.[0]?.bytes;
    if (envelope) { checkPublicEnvelopeStructure(envelope); envelopes.push(envelope); }
    else if (shape !== 'discovery' || value(wire, 1) !== 1n) fail('PUBLIC_ENVELOPE_EVIDENCE_REQUIRED');
    if (shape === 'frame' && wire.fields.get(4)?.[0]?.child) inspectProjection(wire.fields.get(4)![0]!.child!, true);
  }
  return envelopes;
}
