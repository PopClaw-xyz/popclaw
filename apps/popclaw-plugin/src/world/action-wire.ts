import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { jsonObject } from './json-profile.js';
import { validateWorldPayload } from './schema-validator.js';
import { participationDescriptorFromProto, validateParticipationDescriptor } from './world-participation.js';
import type { ActionSelectionEvidenceV1 } from './action-client.js';
import { validateWorldSchema } from './world-capabilities.js';
import type { TrustedWorldCapabilities } from './world-capabilities.js';

/** World messages have no maps/optional scalars. Preserve message presence and
 * repeated positions, recursively eliding implicit scalar defaults like prost. */
export function canonicalWorldCore<T>(codec: { encode(value: T): { finish(): Uint8Array } }, value: T): Uint8Array {
  const normalize = (v: unknown): unknown => {
    if (v instanceof Uint8Array) return new Uint8Array(v);
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('UNSAFE_INTEGER');
    if (Array.isArray(v)) return v.map(normalize);
    if (typeof v !== 'object' || v === null) return v;
    if ('low' in v && 'high' in v && 'unsigned' in v) return v;
    return Object.fromEntries(Object.entries(v).filter(([, c]) => c !== undefined && c !== null && c !== '' && c !== false && c !== 0
      && !((Array.isArray(c) || c instanceof Uint8Array) && !c.length)
      && !(typeof c === 'object' && 'low' in c && 'high' in c && c.low === 0 && c.high === 0)).map(([k, c]) => [k, normalize(c)]));
  };
  return codec.encode(normalize(value) as T).finish();
}
export function worldSigningInput(domain: string, core: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(domain), bytes = new Uint8Array(prefix.length + core.length);
  bytes.set(prefix); bytes.set(core, prefix.length); return bytes;
}
export function worldUint64(value: unknown): string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('UINT64_INVALID');
  const raw = String(value ?? '0');
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || raw.length > 20 || BigInt(raw) > 18446744073709551615n) throw new Error('UINT64_INVALID');
  return raw;
}
export function worldTime(value: unknown): number {
  const raw = worldUint64(value);
  if (BigInt(raw) > 253402300799n) throw new Error('TIME_INVALID');
  return Number(raw);
}
export function sameWorldHouse(a: popclaw.world.IHouseBinding | null | undefined, b: popclaw.world.IHouseBinding): boolean {
  return !!a && a.origin === b.origin && a.houseKey === b.houseKey && a.incarnation === b.incarnation;
}
export function worldPublicKey(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error('KEY_INVALID');
  const bytes = bs58.decode(value);
  if (bytes.length !== 32 || bs58.encode(bytes) !== value) throw new Error('KEY_INVALID');
  return bytes;
}
export function worldKind(capabilities: TrustedWorldCapabilities, direction: 'intent_kinds' | 'event_kinds', kind: string): Record<string, unknown> {
  const entries = capabilities.manifest[direction];
  const found = Array.isArray(entries) && entries.find(entry => jsonObject(entry).kind === kind);
  if (!found) throw new Error('KIND_NOT_DECLARED');
  return jsonObject(found);
}
function opaque(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_./:-]{1,128}$/.test(value)) throw new Error('RESULT_ATTACHMENT_INVALID');
}
export interface StoredActionIdentity {
  actorId: string; requestId: string; requestDigest: string; kind: string; schemaVersion: number;
  capabilities: TrustedWorldCapabilities;
  selection?: ActionSelectionEvidenceV1;
}

/** Authenticate before schema work or granting any attachment authority. The
 * manifest is the one saved with this request, including its delegated key. */
export function authenticateActionResult(bytes: Uint8Array, request: StoredActionIdentity): popclaw.world.ActionResult {
  if (bytes.length > 1048576) throw new Error('RESULT_SIZE_LIMIT');
  inspectActionWire(bytes, 'SignedActionResult');
  const signed = popclaw.world.SignedActionResult.decode(bytes), r = signed.result;
  if (!r || signed.signature.length !== 64) throw new Error('RESULT_SIGNATURE_INVALID');
  const caps = request.capabilities;
  const key = worldPublicKey(request.selection?.resultAuthorityKey ?? jsonObject(caps.manifest.world_interaction).result_authority_pubkey);
  if (!nacl.sign.detached.verify(worldSigningInput('POPCLAW_WORLD_ACTION_RESULT_V1', canonicalWorldCore(popclaw.world.ActionResult, r)), signed.signature, key)) throw new Error('RESULT_SIGNATURE_INVALID');
  if (!sameWorldHouse(r.house, caps.house) || r.actorId !== request.actorId || r.audienceId !== request.actorId
    || r.requestId !== request.requestId || r.requestDigest !== request.requestDigest || r.kind !== request.kind
    || r.schemaVersion !== request.schemaVersion || r.capabilityRevision !== caps.capabilityRevision) throw new Error('RESULT_BINDING_MISMATCH');
  if (![1, 2, 3, 4, 5].includes(r.status ?? 0) || !r.code || r.code.length > 128) throw new Error('RESULT_INVALID');
  const revision = worldUint64(r.statusRevision); worldTime(r.committedAt);
  if (r.executionId) opaque(r.executionId);
  if ((r.status === 2 || r.status === 3) && !r.executionId) throw new Error('RESULT_INVALID');
  if ((r.status === 1 || r.status === 5) && r.executionId) throw new Error('RESULT_INVALID');
  const terminal = (r.status ?? 0) >= 3, body = r.resultBody ?? new Uint8Array();
  const attachments = r.snapshot || r.subscription || r.participation;
  if (r.status === 5 && (body.length || r.resultDigest || attachments)) throw new Error('RESULT_INVALID');
  // Only the house's pre-admission rejection receipt has no ledger revision.
  if (revision === '0' && (r.status !== 4 || r.executionId || body.length || r.resultDigest || attachments || worldTime(r.committedAt))) throw new Error('RESULT_INVALID');
  if (!terminal && (body.length || r.resultDigest || r.snapshot || r.subscription || r.participation || worldTime(r.committedAt))) throw new Error('RESULT_NOT_TERMINAL');
  if (body.length > 32768 || (r.resultDigest && r.resultDigest !== cidFromCanonical(body)) || (body.length && !r.resultDigest)) throw new Error('RESULT_DIGEST_MISMATCH');
  return popclaw.world.ActionResult.decode(canonicalWorldCore(popclaw.world.ActionResult, r));
}
async function verifyActionBase(bytes: Uint8Array, request: StoredActionIdentity, signal?: AbortSignal): Promise<popclaw.world.ActionResult> {
  const r = authenticateActionResult(bytes, request);
  if (r.status === 3 || r.resultBody.length) await validateWorldPayload(request.selection?.resultSchema ?? jsonObject(worldKind(request.capabilities, 'intent_kinds', request.kind).result_schema), r.resultBody, { maxBytes:32768,signal });
  if (signal?.aborted) throw new Error('ACTION_ABORTED');
  return r;
}

/** Explicit historical attachment decoder. New receipts use the split verifier. */
export async function verifyActionResult(bytes: Uint8Array, request: StoredActionIdentity, signal?: AbortSignal): Promise<popclaw.world.ActionResult> {
  const r = await verifyActionBase(bytes, request, signal), caps = request.capabilities;
  if (r.snapshot) {
    const s = r.snapshot, event = worldKind(caps, 'event_kinds', s.schemaKind ?? '');
    opaque(s.stateRef); worldUint64(s.stateRevision); worldTime(s.asOf);
    if (s.schemaVersion !== event.schema_version) throw new Error('SNAPSHOT_SCHEMA_INVALID');
    await validateWorldPayload(jsonObject(event.body_schema), s.body ?? new Uint8Array(), { maxBytes: 65536, signal });
  }
  if (r.participation) {
    if (canonicalWorldCore(popclaw.world.ParticipationDescriptor, r.participation).length > 65536) throw new Error('PARTICIPATION_SIZE_LIMIT');
    const p = validateParticipationDescriptor(participationDescriptorFromProto(r.participation), caps.house, request.actorId);
    for (const group of p.action_groups) for (const kind of group.intent_kinds) worldKind(caps, 'intent_kinds', kind);
  }
  if (r.subscription) {
    const s = r.subscription;
    if (canonicalWorldCore(popclaw.world.SubscriptionDescriptor, s).length > 65536 || !sameWorldHouse(s.house, caps.house)
      || s.actorId !== request.actorId || !/^[A-Za-z0-9_-]{1,64}$/.test(s.logIncarnation ?? '')) throw new Error('SUBSCRIPTION_INVALID');
    opaque(s.participationId); if (s.barrierId) opaque(s.barrierId); worldUint64(s.descriptorRevision);
    const scopes = s.scopes ?? [];
    if (!scopes.length || scopes.length > 32 || new Set(scopes).size !== scopes.length || scopes.some(scope => !/^[A-Za-z0-9_-]{4,64}$/.test(scope))) throw new Error('SUBSCRIPTION_INVALID');
    if (r.participation && s.participationId !== r.participation.participationId) throw new Error('RESULT_BINDING_MISMATCH');
  }
  if (signal?.aborted) throw new Error('ACTION_ABORTED');
  return popclaw.world.ActionResult.decode(canonicalWorldCore(popclaw.world.ActionResult, r));
}

export interface WorldSubscriptionQuery { requestId: string; nonce: string; result: popclaw.world.IActionResult; capabilities: TrustedWorldCapabilities; resultAuthorityKey?: string }

/** Authenticate query-bound publication facts independently of immutable results. */
export function verifySubscriptionObservation(bytes: Uint8Array, query: WorldSubscriptionQuery): popclaw.world.SubscriptionObservation {
    if (bytes.length > 65536) throw new Error('OBSERVATION_SIZE_LIMIT');
    inspectActionWire(bytes, 'SignedSubscriptionObservation', 65536);
    const signed = popclaw.world.SignedSubscriptionObservation.decode(bytes), observation = signed.observation;
    if (!observation || signed.signature.length !== 64) throw new Error('OBSERVATION_SIGNATURE_INVALID');
    const core = canonicalWorldCore(popclaw.world.SubscriptionObservation, observation);
    if (!nacl.sign.detached.verify(worldSigningInput('POPCLAW_WORLD_SUBSCRIPTION_OBSERVATION_V1', core), signed.signature,
      worldPublicKey(query.resultAuthorityKey ?? jsonObject(query.capabilities.manifest.world_interaction).result_authority_pubkey))) throw new Error('OBSERVATION_SIGNATURE_INVALID');
    const descriptor = query.result.subscription;
    if (!sameWorldHouse(observation.house, query.capabilities.house) || !sameWorldHouse(query.result.house, query.capabilities.house)
      || !query.result.actorId || query.result.requestId !== query.requestId || observation.actorId !== query.result.actorId
      || observation.queryRequestId !== query.requestId || observation.queryNonce !== query.nonce || !descriptor
      || observation.participationId !== descriptor.participationId || observation.barrierId !== (descriptor.barrierId ?? '')
      || worldUint64(observation.descriptorRevision) !== worldUint64(descriptor.descriptorRevision)) throw new Error('OBSERVATION_BINDING_MISMATCH');
    if (observation.version !== 1 || !['waiting_publication', 'published', 'failed'].includes(observation.publicationState ?? '')
      || !/^[A-Za-z0-9_-]{1,64}$/.test(observation.logIncarnation ?? '')) throw new Error('OBSERVATION_INVALID');
    const high = BigInt(worldUint64(observation.highWaterSeq)); worldUint64(observation.observationRevision); worldTime(observation.observedAt);
    const through = observation.publishedThrough ?? [], scopes = descriptor.scopes ?? [];
    if (through.length > 32 || new Set(through.map(s => s.scopeId)).size !== through.length
      || through.some(s => !scopes.includes(s.scopeId ?? '') || BigInt(worldUint64(s.throughSeq)) > high)) throw new Error('OBSERVATION_COVERAGE_INVALID');
    if (observation.publicationState === 'published' && descriptor.barrierId && (through.length !== scopes.length || observation.logIncarnation !== descriptor.logIncarnation)) throw new Error('OBSERVATION_COVERAGE_INVALID');
    return popclaw.world.SubscriptionObservation.decode(core);
}

// Fixed field grammar for the existing signed messages; no protocol reflection.
const ACTION_WIRE: Record<string, Record<number, readonly [string, boolean]>> = {
  ActionGroup: { 1: ['string', false], 2: ['string', true], 3: ['string', false], 4: ['string', true] },
  ActionResult: { 1: ['HouseBinding', false], 2: ['string', false], 3: ['string', false], 4: ['string', false], 5: ['string', false], 6: ['string', false], 7: ['ActionStatus', false], 8: ['uint64', false], 9: ['string', false], 10: ['string', false], 11: ['uint32', false], 12: ['string', false], 13: ['bytes', false], 14: ['string', false], 15: ['int64', false], 16: ['WorldSnapshot', false], 17: ['SubscriptionDescriptor', false], 18: ['ParticipationDescriptor', false] },
  ActionStatusResponse: { 1: ['SignedActionResult', false], 2: ['SignedSubscriptionObservation', false] },
  Budget: { 1: ['string', false], 2: ['string', false], 3: ['string', false], 4: ['uint32', false] },
  HouseBinding: { 1: ['string', false], 2: ['string', false], 3: ['string', false] },
  ManifestProof: { 1: ['HouseBinding', false], 2: ['string', false], 3: ['int64', false], 4: ['bytes', false] },
  Opportunity: { 1: ['string', false], 2: ['string', false], 3: ['string', false], 4: ['string', false], 5: ['string', false], 6: ['int64', false], 7: ['int64', false], 8: ['string', false], 9: ['string', true] },
  ParticipationDescriptor: { 1: ['uint32', false], 2: ['HouseBinding', false], 3: ['string', false], 4: ['string', false], 5: ['uint64', false], 6: ['string', false], 7: ['int64', false], 8: ['int64', false], 9: ['ActionGroup', true], 10: ['Opportunity', true], 11: ['Budget', true], 12: ['string', false] },
  ScopeThrough: { 1: ['string', false], 2: ['uint64', false] },
  SignedActionResult: { 1: ['ActionResult', false], 2: ['bytes', false] },
  SignedSubscriptionObservation: { 1: ['SubscriptionObservation', false], 2: ['bytes', false] },
  SubscriptionDescriptor: { 1: ['HouseBinding', false], 2: ['string', false], 3: ['string', false], 4: ['uint64', false], 5: ['string', false], 6: ['string', true], 7: ['string', false] },
  SubscriptionObservation: { 1: ['uint32', false], 2: ['HouseBinding', false], 3: ['string', false], 4: ['string', false], 5: ['string', false], 6: ['uint64', false], 7: ['uint64', false], 8: ['string', false], 9: ['string', false], 10: ['uint64', false], 11: ['ScopeThrough', true], 12: ['string', false], 13: ['string', false], 14: ['int64', false] },
  WorldSnapshot: { 1: ['string', false], 2: ['uint64', false], 3: ['int64', false], 4: ['string', false], 5: ['uint32', false], 6: ['bytes', false] },
};

/** Bound and inspect original wire before generated decoders can skip evidence.
 * Field order may differ from canonical order; singular duplicates, unknown
 * fields, explicit defaults and nonminimal integer encodings are unsupported. */
export function inspectActionWire(raw: Uint8Array, message: string, maxBytes = 1048576, shallow = false): Map<number, Uint8Array[]> {
  if (!(raw instanceof Uint8Array) || raw.length > maxBytes) throw new Error('RESULT_SIZE_LIMIT');
  const schema = ACTION_WIRE[message]; if (!schema) throw new Error('RESULT_WIRE_UNSUPPORTED');
  let offset = 0;
  const values = new Map<number, Uint8Array[]>();
  function varint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= raw.length) throw new Error('RESULT_WIRE_INVALID');
      const byte = raw[offset++]!;
      if (i === 9 && byte > 1) throw new Error('RESULT_WIRE_INVALID');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) {
        if (i > 0 && byte === 0) throw new Error('RESULT_WIRE_UNSUPPORTED'); return value;
      }
    }
    throw new Error('RESULT_WIRE_INVALID');
  }
  while (offset < raw.length) {
    const tag = varint(); if (tag > 4294967295n) throw new Error('RESULT_WIRE_INVALID');
    const field = Number(tag >> 3n), wire = Number(tag & 7n), descriptor = schema[field];
    if (!descriptor) throw new Error('RESULT_WIRE_UNSUPPORTED');
    const [type, repeated] = descriptor;
    if (!repeated && values.has(field)) throw new Error('RESULT_WIRE_DUPLICATE');
    const numeric = ['uint32', 'uint64', 'int64', 'bool', 'ActionStatus'].includes(type);
    if (wire !== (numeric ? 0 : 2)) throw new Error('RESULT_WIRE_INVALID');
    let value: Uint8Array;
    if (numeric) {
      const start = offset, number = varint();
      if ((!repeated && number === 0n) || ((type === 'uint32' || type === 'ActionStatus') && number > 4294967295n) || (type === 'bool' && number > 1n)) throw new Error('RESULT_WIRE_UNSUPPORTED');
      value = raw.slice(start, offset);
    } else {
      const size = varint(); if (size > BigInt(raw.length - offset)) throw new Error('RESULT_WIRE_INVALID');
      const length = Number(size); value = raw.slice(offset, offset + length); offset += length;
      if (type === 'string' || type === 'bytes') {
        if (!repeated && !length) throw new Error('RESULT_WIRE_UNSUPPORTED');
        if (type === 'string') new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
      } else if (!shallow) inspectActionWire(value, type, maxBytes);
    }
    const previous = values.get(field) ?? []; previous.push(value); values.set(field, previous);
  }
  return values;
}
export function extractActionStatusResponse(raw: Uint8Array): { sourceBytes: Uint8Array; signedResultBytes: Uint8Array; observationBytes?: Uint8Array } {
  if (!(raw instanceof Uint8Array) || raw.length > 1048576) throw new Error('RESULT_SIZE_LIMIT');
  const sourceBytes = new Uint8Array(raw), fields = inspectActionWire(sourceBytes, 'ActionStatusResponse', 1048576, true);
  const signedResultBytes = fields.get(1)?.[0]; if (!signedResultBytes) throw new Error('ACTION_RESULT_UNKNOWN');
  const observationBytes = fields.get(2)?.[0];
  return { sourceBytes, signedResultBytes, ...(observationBytes ? { observationBytes } : {}) };
}

export type ActionAttachmentKind = 'snapshot' | 'subscription' | 'participation';
export interface ActionAttachmentDisposition {
  kind: ActionAttachmentKind; digest: string; validation: 'valid' | 'invalid' | 'unsupported';
  install: 'not_selected' | 'pending' | 'applied' | 'failed' | 'blocked'; reason: string;
  selection: null; dependencyGroup: string | null; idempotencyIdentity: string;
  retry: { attempts: number; nextAt: number | null };
}
export interface VerifiedActionReceipt {
  result: popclaw.world.ActionResult;
  attachmentContract: { outcome: 'valid' | 'violated' | 'unsupported'; reason: string };
  attachments: ActionAttachmentDisposition[];
}
/** Authentication and base semantics survive independent attachment failures.
 * No validator here constructs a subscription, participation store or installer. */
export async function verifyActionReceipt(raw: Uint8Array, request: StoredActionIdentity, signal?: AbortSignal): Promise<VerifiedActionReceipt> {
  if (!request.selection) throw new Error('ACTION_CONTEXT_UNSUPPORTED');
  const result = await verifyActionBase(raw, request, signal), selection = request.selection, caps = request.capabilities;
  const attachments: ActionAttachmentDisposition[] = [];
  const digest = cidFromCanonical(canonicalWorldCore(popclaw.world.ActionResult, result));
  for (const kind of ['snapshot', 'subscription', 'participation'] as const) {
    const attachment = result[kind]; if (!attachment) continue;
    const encoded = kind === 'snapshot' ? canonicalWorldCore(popclaw.world.WorldSnapshot, result.snapshot!)
      : kind === 'subscription' ? canonicalWorldCore(popclaw.world.SubscriptionDescriptor, result.subscription!)
      : canonicalWorldCore(popclaw.world.ParticipationDescriptor, result.participation!);
    const item: ActionAttachmentDisposition = { kind, digest: cidFromCanonical(encoded), validation: 'valid', install: 'not_selected', reason: 'INSTALLER_NOT_SELECTED',
      selection: null, dependencyGroup: selection.consistency === 'none' ? null : digest, idempotencyIdentity: `${request.requestId}:${digest}:${kind}`, retry: { attempts: 0, nextAt: null } };
    try {
      if (!selection.allowed.includes(kind)) throw new Error('ATTACHMENT_NOT_ALLOWED');
      if (encoded.length > 65536) throw new Error('ATTACHMENT_SIZE_LIMIT');
      if (kind === 'snapshot') {
        const s = result.snapshot!; opaque(s.stateRef); worldUint64(s.stateRevision); worldTime(s.asOf);
        const declared = caps.manifest.event_kinds;
        const matches = Array.isArray(declared) ? declared.filter(row => row && typeof row === 'object' && (row as Record<string,unknown>).kind === s.schemaKind) : [];
        if (matches.length !== 1) throw new Error('ATTACHMENT_VALIDATOR_UNSUPPORTED');
        const event = jsonObject(matches[0]);
        if (s.schemaVersion !== event.schema_version) throw new Error('SNAPSHOT_SCHEMA_INVALID');
        try { validateWorldSchema(event.body_schema); } catch { throw new Error('ATTACHMENT_VALIDATOR_UNSUPPORTED'); }
        await validateWorldPayload(jsonObject(event.body_schema), s.body ?? new Uint8Array(), { maxBytes: 65536, signal });
      } else if (kind === 'subscription') {
        const s = result.subscription!;
        if (!sameWorldHouse(s.house, caps.house) || s.actorId !== request.actorId || !/^[A-Za-z0-9_-]{1,64}$/.test(s.logIncarnation ?? '')) throw new Error('SUBSCRIPTION_INVALID');
        opaque(s.participationId); if (s.barrierId) opaque(s.barrierId); worldUint64(s.descriptorRevision);
        const scopes = s.scopes ?? [];
        if (!scopes.length || scopes.length > 32 || new Set(scopes).size !== scopes.length || scopes.some(scope => !/^[A-Za-z0-9_-]{4,64}$/.test(scope))) throw new Error('SUBSCRIPTION_INVALID');
      } else {
        if (result.participation!.version !== 1) throw new Error('ATTACHMENT_VALIDATOR_UNSUPPORTED');
        const p = validateParticipationDescriptor(participationDescriptorFromProto(result.participation!), caps.house, request.actorId);
        const selected = jsonObject(jsonObject(caps.manifest.world_interaction).actions).kinds;
        for (const group of p.action_groups) for (const kindName of group.intent_kinds) {
          if (!Array.isArray(selected) || !selected.includes(kindName)) throw new Error('PARTICIPATION_KIND_INVALID');
          worldKind(caps, 'intent_kinds', kindName);
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new Error('ACTION_ABORTED');
      item.reason = error instanceof Error ? error.message.slice(0,256) : 'ATTACHMENT_INVALID';
      item.validation = item.reason === 'ATTACHMENT_VALIDATOR_UNSUPPORTED' ? 'unsupported' : 'invalid'; item.install = 'blocked';
    }
    attachments.push(item);
  }
  let contract: VerifiedActionReceipt['attachmentContract'] = { outcome: 'valid', reason: 'ATTACHMENT_CONTRACT_VALID' };
  if (attachments.some(a => a.validation === 'unsupported')) contract = { outcome: 'unsupported', reason: 'ATTACHMENT_VALIDATOR_UNSUPPORTED' };
  if (attachments.some(a => a.validation === 'invalid')) contract = { outcome: 'violated', reason: 'ATTACHMENT_INVALID' };
  if (result.status === 3 && selection.requiredOnSuccess.some(kind => !result[kind])) contract = { outcome: 'violated', reason: 'REQUIRED_ATTACHMENT_MISSING' };
  let consistencyFailure: string | null = null;
  if (result.subscription && result.participation && result.subscription.participationId !== result.participation.participationId) consistencyFailure = 'ATTACHMENT_PARTICIPATION_MISMATCH';
  if (selection.consistency !== 'none' && attachments.length) {
    if (!result.subscription || (selection.consistency === 'snapshot_barrier' && (!result.snapshot || !result.subscription.barrierId))) consistencyFailure = 'ATTACHMENT_CONSISTENCY_INCOMPLETE';
  }
  if (selection.consistency === 'stream' && result.subscription?.barrierId) consistencyFailure = 'ATTACHMENT_STREAM_BARRIER_FORBIDDEN';
  if (consistencyFailure) {
    contract = { outcome: 'violated', reason: consistencyFailure };
    for (const item of attachments) { item.install = 'blocked'; if (item.validation === 'valid') item.reason = consistencyFailure; }
  }
  if (signal?.aborted) throw new Error('ACTION_ABORTED');
  return { result, attachmentContract: contract, attachments };
}
