import type { HostDb } from '../host/host-db.js';
import type { popclaw } from '@popclaw/contracts';
import type { ParticipationActionAuthorityOptions } from '../world/world-action-authority.js';
import type { ParticipationReservation } from '../world/world-participation.js';
import manifestSchema from '@popclaw/contracts/world-interaction/manifest.schema.json';
import Ajv2020 from 'ajv/dist/2020.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { sameWorldHouse, worldPublicKey, worldTime } from '../world/action-wire.js';
import { jsonObject } from '../world/json-profile.js';
import { normalizeHouseOrigin } from './house-lifecycle/control-client.js';

export type WorldEffectAuthorityOptions = ParticipationActionAuthorityOptions;
export interface WorldEffectAuthority {
  check(requestId?: string): ParticipationReservation;
  record(tx: HostDb, eventId: string): void;
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void;
}

const boardShape = new Ajv2020({ strict: false, validateSchema: false }).compile(manifestSchema);
const utf8 = new TextEncoder();
function fail(code: string): never { throw new Error(code); }
function eventId(value: string): void { if (!/^[0-9a-f]{64}$/.test(value)) fail('REQUEST_ID_INVALID'); }

/** A trusted effect path consumes an existing reservation. No budgets, grants,
 * reservations, or signed terminal outcomes are manufactured here. DM is a
 * reserved channel and deliberately never looked up as a manifest intent. */
export function createWorldEffectAuthority(options: WorldEffectAuthorityOptions): WorldEffectAuthority {
  const { db, policy, actorId, participationId, reservationId, jobId } = options;
  const house = structuredClone(options.house), invocation = structuredClone(options.invocation);
  worldPublicKey(house.houseKey); worldPublicKey(actorId);
  if (typeof house.origin !== 'string' || normalizeHouseOrigin(house.origin) !== house.origin
    || typeof house.incarnation !== 'string' || !house.incarnation.length) fail('EFFECT_BINDING_MISMATCH');
  if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(participationId) || !/^[A-Za-z0-9_./:-]{1,128}$/.test(jobId)
    || typeof reservationId !== 'string' || !reservationId.length) fail('EFFECT_ID_INVALID');
  if (!((invocation.channel === 'direct_message' && invocation.kind === 'direct_message' && invocation.message === true)
    || (invocation.channel === 'owner_notice' && invocation.message === false))) fail('EFFECT_CHANNEL_INVALID');
  if (!/^[0-9a-f]{64}$/.test(invocation.expectedCapabilityRevision)) fail('CAPABILITY_REVISION_MISMATCH');
  const assertBinding = (actualDb: HostDb, actualHouse: popclaw.world.IHouseBinding, actualActorId: string) => {
    if (actualDb !== db || !sameWorldHouse(actualHouse, house) || actualActorId !== actorId) fail('EFFECT_BINDING_MISMATCH');
    policy.assertBinding(db, house, actorId, participationId);
    options.readiness.assertBinding(db, house, actorId);
  };
  assertBinding(db, house, actorId);
  const check = (requestId?: string): ParticipationReservation => {
    assertBinding(db, house, actorId);
    const now = worldTime(options.now()), caps = options.capabilities();
    if (!caps || typeof caps.guide !== 'string' || !caps.manifest || !boardShape(caps.manifest.world_interaction)) fail('CAPABILITY_CONTEXT_INCOMPLETE');
    if (!sameWorldHouse(caps.house, house) || caps.capabilityRevision !== invocation.expectedCapabilityRevision) fail('CAPABILITY_REVISION_MISMATCH');
    const board = jsonObject(caps.manifest.world_interaction), guide = utf8.encode(caps.guide);
    worldPublicKey(board.result_authority_pubkey);
    if (guide.byteLength > 524288 || cidFromCanonical(guide) !== jsonObject(board.guide).sha256) fail('GUIDE_DIGEST_MISMATCH');
    if (options.supportsBackgroundTurns() !== true) fail('HOST_BACKGROUND_UNSUPPORTED');
    const ready = options.readiness.view(participationId);
    if (ready.participation_id !== participationId || ready.ready !== true) fail('WORLD_NOT_READY');
    const facts = policy.facts();
    if (!facts || facts.actor_id !== actorId || facts.participation_id !== participationId
      || !sameWorldHouse({ origin: facts.house.origin, houseKey: facts.house.house_key, incarnation: facts.house.incarnation }, house)) fail('PARTICIPATION_BINDING_MISMATCH');
    const result = policy.authorizeReservation({ reservationId, jobId, invocation }, new Date(now * 1000).toISOString().replace('.000Z', 'Z'));
    if (!result.ok) fail(result.code);
    if (requestId !== undefined) { eventId(requestId); if (result.value.requestId !== requestId) fail('EFFECT_REQUEST_MISMATCH'); }
    return structuredClone(result.value);
  };
  return Object.freeze({ check, assertBinding, record(tx: HostDb, id: string): void {
    assertBinding(tx, house, actorId); eventId(id); check();
    const result = policy.associateRequest(reservationId, id);
    if (!result.ok) fail(result.code);
    check(id);
  } });
}
