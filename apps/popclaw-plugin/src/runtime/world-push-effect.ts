import { decodeEnvelope, canonicalizeEnvelope } from '../protocol/public-envelope.js';
/** Reconstruct original world intent authority in the actual sending process. */
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import type { HostDb } from '../host/host-db.js';
import type { WorldActionAuthority, WorldInvokeInput } from '../world/action-client.js';
import { createParticipationActionAuthority } from '../world/world-action-authority.js';
import { WorldOwnerActionAuthorityStore } from '../world/world-owner-action-authority.js';
import { sameWorldHouse, worldPublicKey, worldTime, worldUint64 } from '../world/action-wire.js';
import { jsonObject, parseWorldJson } from '../world/json-profile.js';
import type { TrustedWorldCapabilities } from '../world/world-capabilities.js';
import type { WorldResource } from './world-resource.js';
import type { PushExecutionContext } from './house-lifecycle/command-bus.js';
import { captureHousePushEffect, type HousePushEffectReference } from './house-lifecycle/push-effect.js';

interface RequestRow {
  request_id: string; request_bytes: Uint8Array; request_digest: string; execution_reference: string | null;
  kind: string; schema_version: number; capabilities: string; valid_until: number; latest_result: Uint8Array | null;
}
export interface WorldIntentPushEffectOptions {
  db: HostDb; house: popclaw.world.IHouseBinding; actorId: string;
  ref: HousePushEffectReference; bytes: Uint8Array; context: PushExecutionContext;
  capabilities(): TrustedWorldCapabilities | null;
  /** The original active resource, with its real in-memory fail-closed state. */
  resource?: Pick<WorldResource, 'readiness' | 'readState' | 'registry'> & { isActive(): boolean };
  supportsBackgroundTurns(): boolean;
  now(): number;
}
function fail(): never { throw new Error('WORLD_PUSH_EFFECT_BINDING_MISMATCH'); }
const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((value,index) => value === right[index]);
const utf8 = new TextEncoder();

/** Synchronous owner preparation, called after the runtime has opened its actual
 * same-house DB. The returned checker rereads original rows and current policy
 * at every HTTP boundary. It does not allocate, grant, sign, associate or send. */
export function prepareWorldIntentPushEffect(options: WorldIntentPushEffectOptions): () => void {
  const {db,actorId,context,resource} = options;
  const house = structuredClone(options.house), bytes = new Uint8Array(options.bytes), ref = captureHousePushEffect(options.ref);
  if (ref.kind !== 'world_intent') fail();
  if (ref.executionReference.kind === 'native_policy') throw new Error('WORLD_LOCAL_UNSUPPORTED');
  const reference = JSON.stringify(ref), scope = JSON.stringify([house.origin,house.houseKey,house.incarnation,actorId]);
  const actorKey = worldPublicKey(actorId), houseKey = worldPublicKey(house.houseKey);
  context.authorizeSend();
  const row = (): RequestRow => {
    const stored = db.queryOne<RequestRow>('SELECT * FROM world_action_client_requests WHERE binding=? AND request_id=?',[scope,ref.requestId]);
    if (!stored || !stored.execution_reference || stored.request_digest !== cidFromCanonical(bytes) || !equal(stored.request_bytes,bytes)) fail();
    const savedRef = captureHousePushEffect({version:1,kind:'world_intent',requestId:ref.requestId,
      executionReference: parseWorldJson(utf8.encode(stored.execution_reference),32768)});
    if (JSON.stringify(savedRef) !== reference) fail();
    if (stored.latest_result && (popclaw.world.SignedActionResult.decode(stored.latest_result).result?.status ?? 0) >= 3) throw new Error('WORLD_PUSH_REQUEST_TERMINAL');
    return stored;
  };
  const original = row(), caps = JSON.parse(original.capabilities) as TrustedWorldCapabilities;
  const signed = popclaw.identity.SignedPayload.decode(bytes), envelope = decodeEnvelope(signed.payload);
  const canonical = canonicalizeEnvelope(envelope), intent = envelope.intent, wire = intent?.context;
  if (!equal(signed.signerPubkey,actorKey) || !nacl.sign.detached.verify(signed.payload,signed.signature,actorKey)
    || !nacl.sign.detached.verify(canonical,envelope.signature,actorKey) || envelope.eventId !== ref.requestId
    || cidFromCanonical(canonical) !== ref.requestId || envelope.actor?.popclawId !== actorId
    || envelope.body !== 'intent' || envelope.lorehouse !== house.origin || intent?.lorehouse !== house.origin || !wire
    || wire.houseOrigin !== house.origin || wire.houseKey !== house.houseKey || wire.incarnation !== house.incarnation
    || !sameWorldHouse(caps.house,house) || wire.capabilityRevision !== caps.capabilityRevision
    || intent.intentKind !== original.kind || wire.schemaVersion !== original.schema_version
    || worldTime(wire.validUntil) !== original.valid_until || wire.sessionId !== context.sessionId
    || worldUint64(wire.fence) !== String(context.houseRevision)
    || [...houseKey].map(b=>b.toString(16).padStart(2,'0')).join('') !== context.ackKeyHex.toLowerCase()) fail();
  const invocation: WorldInvokeInput = {house:house.origin!,kind:original.kind,
    params:jsonObject(parseWorldJson(intent.params ?? new Uint8Array(),16384)),expected_capability_revision:caps.capabilityRevision};
  let authority: WorldActionAuthority;
  const pointer = ref.executionReference;
  if (pointer.kind === 'owner_action') {
    authority = new WorldOwnerActionAuthorityStore({db,house,actorId,capabilities:options.capabilities,now:options.now}).authority(pointer.reservationId);
  } else {
    if (!resource || !resource.isActive()) throw new Error('WORLD_PUSH_RESOURCE_UNAVAILABLE');
    resource.readiness.assertBinding(db,house,actorId);
    if (pointer.kind === 'read_state') authority = resource.readState.authority(pointer.reservationId);
    else {
      const policy = resource.registry.policy(pointer.participationId);
      policy.assertDatabase(db);
      const reservation = policy.reservations().find(value => value.reservationId === pointer.reservationId && value.jobId === pointer.jobId);
      if (!reservation) throw new Error('WORLD_PUSH_RESERVATION_UNKNOWN');
      authority = createParticipationActionAuthority({db,house,actorId,policy,participationId:pointer.participationId,
        reservationId:pointer.reservationId,jobId:pointer.jobId,invocation:reservation.invocation,
        capabilities:options.capabilities,readiness:resource.readiness,supportsBackgroundTurns:options.supportsBackgroundTurns,now:options.now});
    }
  }
  const check = () => {
    context.authorizeSend();
    if (pointer.kind !== 'owner_action' && !resource!.isActive()) throw new Error('WORLD_PUSH_RESOURCE_UNAVAILABLE');
    const current = row();
    if (current.kind !== original.kind || current.schema_version !== original.schema_version
      || current.capabilities !== original.capabilities || current.valid_until !== original.valid_until) fail();
    const resolved = captureHousePushEffect({version:1,kind:'world_intent',requestId:ref.requestId,executionReference:authority.executionReference});
    if (JSON.stringify(resolved) !== reference) fail();
    const now = worldTime(options.now());
    if (now >= original.valid_until || now >= worldTime(authority.expiresAt)) throw new Error('ACTION_EXPIRED');
    authority.assertBinding?.(db,house,actorId);
    authority.assertInput?.(structuredClone(invocation));
    authority.check({kind:original.kind,validUntil:original.valid_until,requestId:ref.requestId});
    context.authorizeSend();
  };
  check(); return check;
}
