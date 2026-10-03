/** Actual effect adapters for a coordinator bound to one original live resource.
 * Queued owner egress additionally needs WorldRuntime's persisted job checker. */
import type { HostDb } from '../host/host-db.js';
import type { WorldActionClient, WorldActionAuthority, WorldInvokeInput } from '../world/action-client.js';
import { createParticipationActionAuthority } from '../world/world-action-authority.js';
import type { WorldPolicyRegistry } from '../world/world-interaction-consumers.js';
import type { WorldReadiness } from '../world/world-readiness.js';
import type { TrustedWorldCapabilities } from '../world/world-capabilities.js';
import type { ParticipationInvocation, ParticipationReservation } from '../world/world-participation.js';
import { sameWorldHouse } from '../world/action-wire.js';
import type { HouseGate } from './house-lifecycle/manager.js';
import type { HouseSessionCommandContext } from './house-lifecycle/house-runtime.js';
import { withAction } from './house-lifecycle/action-context.js';
import type { createWorldDirectDm, WorldDirectDmView } from './world-direct-dm.js';
import type { WorldTurnEffectInput, WorldTurnEffectReadInput, WorldTurnEffectPort, WorldTurnEffectObservation } from './world-turn-coordinator.js';

type DirectMessage = ReturnType<typeof createWorldDirectDm>;
export interface WorldTurnEffectsOptions {
  db: HostDb; house: WorldTurnEffectInput['house']; actorId: string; gate: HouseGate;
  registry: WorldPolicyRegistry; readiness: WorldReadiness;
  capabilities(): TrustedWorldCapabilities | null;
  supportsBackgroundTurns(): boolean;
  captureSession(): HouseSessionCommandContext;
  client(): WorldActionClient;
  directMessage?(participationId: string): Promise<DirectMessage>;
  /** Check only the original resource lifetime, not new dispatch permission. */
  assertLive(): void;
  now?(): number;
}
export interface WorldTurnEffects { readonly intent: WorldTurnEffectPort; readonly directMessage?: WorldTurnEffectPort }
const clone = <T>(value: T): T => structuredClone(value);
function fail(code: string): never { throw new Error(code); }
function sameRoute(a: Readonly<ParticipationInvocation>, b: Readonly<ParticipationInvocation>): boolean {
  return a.opportunityId === b.opportunityId && a.kind === b.kind && a.channel === b.channel && a.message === b.message
    && a.contextValidUntil === b.contextValidUntil && a.expectedCapabilityRevision === b.expectedCapabilityRevision;
}
function sameReservation(a: Readonly<ParticipationReservation>, b: Readonly<ParticipationReservation>): boolean {
  return a.reservationId === b.reservationId && a.jobId === b.jobId && a.turnId === b.turnId && a.windowId === b.windowId
    && a.descriptorRevision === b.descriptorRevision && a.dedupeKey === b.dedupeKey && sameRoute(a.invocation, b.invocation);
}
function gateSnapshot(value: HouseGate): HouseGate {
  return Object.freeze({ origin: value.origin, generation: value.generation, signal: value.signal, isActive: value.isActive.bind(value) });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function actionFields(input: WorldTurnEffectInput, channel: 'intent' | 'direct_message'): void {
  const { action, invocation } = input;
  if (invocation.channel !== channel || action.channel !== channel || action.kind !== invocation.kind || action.opportunity_id !== invocation.opportunityId) fail('WORLD_TURN_EFFECT_ROUTE_MISMATCH');
  const fields = channel === 'intent' ? ['opportunity_id', 'channel', 'kind', 'params'] : ['opportunity_id', 'channel', 'kind', 'recipient', 'text', 'replyToEventId'];
  if (Object.keys(action).some(key => !fields.includes(key)) || fields.filter(key => key !== 'replyToEventId').some(key => !Object.hasOwn(action, key))) fail('WORLD_TURN_EFFECT_ACTION_INVALID');
  if (channel === 'direct_message' && (invocation.kind !== 'direct_message' || invocation.message !== true)) fail('WORLD_TURN_EFFECT_ROUTE_MISMATCH');
}

/** No reservation, grant, retry, status-query signature or settlement is minted
 * here. Construction and all getters are supplied by the actual resource owner. */
export function createWorldTurnEffects(inputOptions: WorldTurnEffectsOptions): WorldTurnEffects {
  const options = Object.freeze({ ...inputOptions, house: clone(inputOptions.house), gate: gateSnapshot(inputOptions.gate) });
  const { db, house, actorId, registry, readiness } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  registry.assertBinding(db, house, actorId); readiness.assertBinding(db, house, actorId);
  const alive = () => {
    options.assertLive();
    if (options.gate.origin !== house.origin || options.gate.signal.aborted || !options.gate.isActive()) fail('WORLD_TURN_EFFECT_RESOURCE_CLOSED');
  };
  const binding = (input: Pick<WorldTurnEffectReadInput, 'db' | 'house' | 'actorId' | 'participationId' | 'policy'>) => {
    alive();
    if (input.db !== db || !sameWorldHouse(input.house, house) || input.actorId !== actorId) fail('WORLD_TURN_EFFECT_BINDING_MISMATCH');
    registry.assertBinding(db, house, actorId); input.policy.assertBinding(db, house, actorId, input.participationId);
    if (registry.policy(input.participationId) !== input.policy) fail('WORLD_TURN_EFFECT_POLICY_MISMATCH');
  };
  const originalReservation = (input: Pick<WorldTurnEffectReadInput, 'policy' | 'reservation'>): ParticipationReservation => {
    const actual = input.policy.reservations().find(value => value.reservationId === input.reservation.reservationId);
    if (!actual || !sameReservation(actual, input.reservation)
      || (input.reservation.requestId !== undefined && input.reservation.requestId !== actual.requestId)) fail('WORLD_TURN_EFFECT_RESERVATION_MISMATCH');
    return actual;
  };
  const capture = (input: WorldTurnEffectInput, channel: 'intent' | 'direct_message') => {
    const fixed: WorldTurnEffectInput = { ...input, house: clone(input.house), reservation: clone(input.reservation), invocation: clone(input.invocation),
      action: clone(input.action), session: clone(input.session), gate: gateSnapshot(input.gate), check: input.check.bind(input) };
    actionFields(fixed, channel);
    const check = () => {
      binding(fixed);
      if (fixed.gate.origin !== house.origin || fixed.gate.generation !== options.gate.generation || fixed.gate.signal.aborted || !fixed.gate.isActive()) fail('WORLD_TURN_EFFECT_GATE_CLOSED');
      if (!sameRoute(fixed.invocation, fixed.reservation.invocation)) fail('WORLD_TURN_EFFECT_ROUTE_MISMATCH');
      const actual = originalReservation(fixed), authorized = fixed.check();
      if (!sameReservation(authorized, actual) || authorized.requestId !== actual.requestId || authorized.status !== actual.status) fail('WORLD_TURN_EFFECT_RESERVATION_MISMATCH');
      const session = options.captureSession(), saved = fixed.session;
      if (session.sessionId !== saved.sessionId || session.fence !== saved.fence || session.installationId !== saved.installationId
        || session.gate.generation !== saved.generation || saved.generation !== fixed.gate.generation
        || session.gate.origin !== house.origin || session.gate.signal.aborted || !session.gate.isActive()) fail('WORLD_TURN_EFFECT_SESSION_MISMATCH');
      // G0 may renew this same session. Renewal keeps it live but cannot extend
      // the authority captured by the original turn.
      if (!Number.isSafeInteger(saved.leaseExpiresAt) || now() >= saved.leaseExpiresAt) fail('WORLD_TURN_EFFECT_EXPIRED');
      return authorized;
    };
    check();
    return { fixed, check };
  };
  const observation = (input: Pick<WorldTurnEffectReadInput, 'policy' | 'reservation'>, value: WorldTurnEffectObservation) => {
    if (value.requestId !== undefined && (!/^[a-f0-9]{64}$/.test(value.requestId) || originalReservation(input).requestId !== value.requestId)) fail('WORLD_TURN_EFFECT_REQUEST_MISMATCH');
    return value;
  };
  const read = (input: WorldTurnEffectReadInput, channel: 'intent' | 'direct_message') => {
    const fixed = { ...input, house: clone(input.house), reservation: clone(input.reservation), authorizeRead: input.authorizeRead.bind(input) };
    const check = () => {
      fixed.authorizeRead(); binding(fixed);
      if (!/^[a-f0-9]{64}$/.test(fixed.requestId) || fixed.reservation.invocation.channel !== channel
        || fixed.reservation.requestId !== fixed.requestId || originalReservation(fixed).requestId !== fixed.requestId) fail('WORLD_TURN_EFFECT_REQUEST_MISMATCH');
    };
    check(); return { fixed, check };
  };
  const dmObservation = (value: WorldDirectDmView): WorldTurnEffectObservation => ({ status: value.state, code: value.code, ...(value.eventId ? { requestId: value.eventId } : {}) });
  const intent: WorldTurnEffectPort = Object.freeze({
    async dispatch(input: WorldTurnEffectInput): Promise<WorldTurnEffectObservation> {
      const { fixed, check } = capture(input, 'intent');
      if (fixed.action.channel !== 'intent') fail('WORLD_TURN_EFFECT_ROUTE_MISMATCH');
      if (check().requestId) fail('WORLD_TURN_EFFECT_ALREADY_LINKED');
      const invocation: WorldInvokeInput = { house: house.origin, kind: fixed.action.kind, params: clone(fixed.action.params), expected_capability_revision: fixed.invocation.expectedCapabilityRevision };
      const expected = canonical(invocation);
      const base = createParticipationActionAuthority({ db, house, actorId, policy: fixed.policy, participationId: fixed.participationId,
        reservationId: fixed.reservation.reservationId, jobId: fixed.reservation.jobId, invocation: fixed.invocation, readiness,
        capabilities: options.capabilities, supportsBackgroundTurns: options.supportsBackgroundTurns, now });
      const authority: WorldActionAuthority = Object.freeze({ ...base, expiresAt: Math.min(base.expiresAt, fixed.session.leaseExpiresAt),
        assertBinding(...[actualDb, actualHouse, actualActor]: Parameters<NonNullable<WorldActionAuthority['assertBinding']>>) { check(); base.assertBinding!(actualDb, actualHouse, actualActor); },
        assertInput(actual: WorldInvokeInput) { check(); if (canonical(actual) !== expected) fail('WORLD_TURN_EFFECT_INPUT_MISMATCH'); },
        check(attempt: Parameters<WorldActionAuthority['check']>[0]) { check(); base.check(attempt); },
        record(...[tx, requestId]: Parameters<WorldActionAuthority['record']>) { check(); base.record(tx, requestId); check(); },
      });
      check();
      const result = await withAction(fixed.gate, () => options.client().invoke(invocation, authority));
      // Verified consumers may already have settled this reservation. Mapping
      // that observation must not demand another executable reservation.
      return observation(fixed, { status: result.status, code: result.code, requestId: result.request_id });
    },
    async readKnown(input: WorldTurnEffectReadInput): Promise<WorldTurnEffectObservation> {
      const { fixed, check } = read(input, 'intent');
      const row = db.queryOne<{ execution_reference: string | null }>('SELECT execution_reference FROM world_action_client_requests WHERE binding=? AND request_id=?',
        [JSON.stringify([house.origin, house.houseKey, house.incarnation, actorId]), fixed.requestId]);
      if (!row || row.execution_reference === null || canonical(JSON.parse(row.execution_reference)) !== canonical({ kind: 'participation', reservationId: fixed.reservation.reservationId, participationId: fixed.participationId, jobId: fixed.reservation.jobId })) fail('WORLD_TURN_EFFECT_REQUEST_MISMATCH');
      const value = options.client().view(fixed.requestId); check();
      return observation(fixed, { status: value.status, code: value.code, requestId: value.request_id });
    },
  });
  if (!options.directMessage) return Object.freeze({ intent });
  const directMessage: WorldTurnEffectPort = Object.freeze({
    async dispatch(input: WorldTurnEffectInput): Promise<WorldTurnEffectObservation> {
      const { fixed, check } = capture(input, 'direct_message');
      if (fixed.action.channel !== 'direct_message') fail('WORLD_TURN_EFFECT_ROUTE_MISMATCH');
      const action = fixed.action;
      const adapter = await options.directMessage!(fixed.participationId); check();
      const value = await withAction(fixed.gate, () => adapter.send({ reservationId: fixed.reservation.reservationId, jobId: fixed.reservation.jobId,
        invocation: fixed.invocation, recipient: action.recipient, text: action.text,
        ...(action.replyToEventId === undefined ? {} : { replyToEventId: action.replyToEventId }) }));
      return observation(fixed, dmObservation(value));
    },
    async readKnown(input: WorldTurnEffectReadInput): Promise<WorldTurnEffectObservation> {
      const { fixed, check } = read(input, 'direct_message');
      const adapter = await options.directMessage!(fixed.participationId); check();
      const value = await adapter.reconcile(fixed.reservation.reservationId); check();
      if (value.eventId !== fixed.requestId || value.reservationId !== fixed.reservation.reservationId || value.jobId !== fixed.reservation.jobId) fail('WORLD_TURN_EFFECT_REQUEST_MISMATCH');
      return observation(fixed, dmObservation(value));
    },
  });
  return Object.freeze({ intent, directMessage });
}
