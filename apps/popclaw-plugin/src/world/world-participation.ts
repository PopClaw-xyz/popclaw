import type { popclaw } from '@popclaw/contracts';
import wrapperSchema from '@popclaw/contracts/world-interaction/private-message.schema.json';
import Ajv2020 from 'ajv/dist/2020.js';
import bs58 from 'bs58';
import type { HostDb } from '../host/host-db.js';
import { parseWorldJson } from './json-profile.js';

type Resource = 'agent_turn' | 'outbound_message' | 'owner_notice';
type Channel = 'intent' | 'direct_message';
export interface ParticipationDescriptor {
  version: 1;
  house: { origin: string; house_key: string; incarnation: string };
  actor_id: string; participation_id: string; revision: string;
  window: { id: string; opens_at: string; closes_at: string };
  action_groups: { id: string; intent_kinds: string[]; control_reset: 'window' | 'explicit'; channels?: Channel[] }[];
  opportunities: ParticipationOpportunity[];
  budgets: { id: string; window_id: string; resource: Resource; suggested_limit: number }[];
  dm_response_slot_key?: string;
}
export interface ParticipationOpportunity {
  id: string; source_event_id?: string; action_group_id: string; budget_group_id: string;
  budget_window_id: string; not_before: string; expires_at: string; dedupe_key: string; channels?: Channel[];
}
/** Limits are required owner permission, never descriptor defaults. An optional
 * window_ref narrows the grant to that window; omission grants these kinds across
 * windows subject to all persisted ceilings. Re-granting never resets usage. */
export interface ParticipationLocalPolicy {
  allowed_action_kinds: string[]; expires_at: string; window_ref?: string;
  max_agent_turns: number; max_outbound_messages: number; max_owner_notices: number;
}
export interface ParticipationLimits { agent_turn: number; outbound_message: number; owner_notice: number }
/** Independently owner-configured ceilings survive every window/group/descriptor.
 * Missing ceilings mean zero. Owner messages are counted only when explicitly configured. */
export interface ParticipationCeilings {
  aggregate: ParticipationLimits;
  rolling: { seconds: number; limits: ParticipationLimits };
  count_successful_owner_messages: boolean;
}
/** One persisted grant row applies only to `kind`; the original multi-kind
 * grant input is not repeated, because individual kinds can later be revoked. */
export interface ParticipationGrantView {
  kind: string;
  policy: Omit<ParticipationLocalPolicy, 'allowed_action_kinds'>;
  status: 'current' | 'expired' | 'other_window' | 'kind_not_declared';
}
/** Detached JSON inspection data, never a reservation or permission to send.
 * Descriptor validity excludes local grant/budget/host checks. Missing ceilings
 * remain null; suggested descriptor budgets never become owner configuration. */
export interface ParticipationView {
  house: ParticipationDescriptor['house']; actor_id: string; participation_id: string; evaluated_at: string;
  descriptor: ParticipationDescriptor | null; capability_revision: string | null;
  descriptor_validity: 'missing' | 'fenced' | 'unavailable' | 'not_open' | 'expired' | 'current';
  durable_available: boolean; runtime_fenced: boolean;
  manual: boolean;
  grants: ParticipationGrantView[];
  locks: { kind: string; window_ref: string | null; active: boolean; applies_to_current_window: boolean }[];
  ceilings: ParticipationCeilings | null;
}
export interface ParticipationInvocation {
  opportunityId: string; kind: string; channel: Channel | 'owner_notice';
  /** Set by the trusted egress adapter, never supplied by the model. */
  message: boolean;
  contextValidUntil: string; expectedCapabilityRevision: string;
}
export interface ParticipationReservation {
  reservationId: string; jobId: string; turnId: string; invocation: ParticipationInvocation;
  windowId: string; descriptorRevision: string; dedupeKey: string;
  status: 'reserved' | 'unknown' | 'succeeded' | 'rejected' | 'cancelled'; requestId?: string;
}
export interface ParticipationTurnIdentity { turnReservationId: string; jobId: string; turnId: string }
export type ParticipationTurnOutcome = 'no_action' | 'invalid_output' | 'model_failed' | 'completed';
/** Candidate routes are inspection data, not actual invocations or egress authority. */
export interface ParticipationTurn extends ParticipationTurnIdentity {
  windowId: string; descriptorRevision: string; capabilityRevision: string; contextValidUntil: string;
  status: 'reserved' | 'closed'; outcome?: ParticipationTurnOutcome;
  candidates: ParticipationInvocation[];
}
export interface ParticipationTurnInput {
  jobId: string; turnId: string; opportunityIds: string[];
  expectedCapabilityRevision: string; contextValidUntil: string;
}
export type ParticipationBatchOutcome =
  | { ok: true; invocation: ParticipationInvocation; reservation: ParticipationReservation }
  | { ok: false; invocation: ParticipationInvocation; code: string };
export type ParticipationResult<T = void> = { ok: true; value: T } | { ok: false; code: string };
type Grant = { kind: string; policy: ParticipationLocalPolicy; epoch: number };
type Lock = { kind: string; window: string | null; active: boolean };
type Charge = { resource: Resource; at: number; window: string; units: number; kind: string; turnId?: string; poolTracked?: true };
type PoolCharge = Charge & { budgetGroupId: string };
type StoredReservation = ParticipationReservation & { grantKind: string; epoch: number; kinds: string[]; charges: Charge[] };
type CapturedTurnRoute = { invocation: ParticipationInvocation; grantKind: string; epoch: number };
type StoredTurn = Omit<ParticipationTurn, 'candidates'> & {
  canonical: string; routes: CapturedTurnRoute[]; dedupeKeys: string[];
  attempts: { attemptId: string; canonical: string; reservationId: string }[];
};
interface State {
  descriptor?: ParticipationDescriptor; capabilityRevision?: string; available: boolean; manual: boolean;
  grants: Grant[]; locks: Lock[]; epochs: { kind: string; epoch: number }[];
  slots: { window: string; key: string | null }[]; windows: string[];
  sources: string[]; charges: Charge[]; poolCharges: PoolCharge[]; reservations: StoredReservation[];
  batches: { jobId: string; canonical: string; outcomes: ParticipationBatchOutcome[] }[];
  ownerMessages: string[]; ceilings?: ParticipationCeilings; turns: StoredTurn[];
}
const shape = new Ajv2020({ strict: false, validateSchema: false }).compile({
  ...wrapperSchema.$defs.participation_descriptor, $defs: wrapperSchema.$defs,
});
const opaquePattern = /^[A-Za-z0-9_./:-]{1,128}$/;
const kindPattern = /^[a-z0-9]{1,24}(\.[a-z0-9_]{1,24}){1,2}$/;
function fail(code: string): never { throw new Error(code); }
function opaque(value: string): void { if (typeof value !== 'string' || !opaquePattern.test(value)) fail('IDENTIFIER_INVALID'); }
function time(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) fail('TIME_INVALID');
  const at = Date.parse(value);
  if (!Number.isFinite(at) || new Date(at).toISOString().replace('.000Z', 'Z') !== value) fail('TIME_INVALID');
  return at / 1000;
}
function publicKey(value: string): void {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) fail('BINDING_INVALID');
  try { if (bs58.decode(value).length !== 32 || bs58.encode(bs58.decode(value)) !== value) fail('BINDING_INVALID'); }
  catch { fail('BINDING_INVALID'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function limits(value: ParticipationLimits): void {
  if (!value || Object.keys(value).sort().join() !== 'agent_turn,outbound_message,owner_notice') fail('POLICY_INVALID');
  for (const count of Object.values(value)) if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) fail('POLICY_INVALID');
}
function policyLimit(policy: ParticipationLocalPolicy, resource: Resource): number {
  return resource === 'agent_turn' ? policy.max_agent_turns : resource === 'outbound_message' ? policy.max_outbound_messages : policy.max_owner_notices;
}

function descriptorShape(value: unknown): ParticipationDescriptor {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const parsed = parseWorldJson(bytes, 65536);
  if (!shape(parsed)) fail('DESCRIPTOR_SCHEMA_INVALID');
  return parsed as unknown as ParticipationDescriptor;
}
/** Validates authenticated JSON facts; this function does not authenticate or grant authority. */
export function validateParticipationDescriptor(value: unknown, house: popclaw.world.IHouseBinding, actorId: string): ParticipationDescriptor {
  const d = descriptorShape(value);
  publicKey(d.house.house_key); publicKey(d.actor_id);
  if (d.house.origin !== house.origin || d.house.house_key !== house.houseKey || d.house.incarnation !== house.incarnation || d.actor_id !== actorId) fail('DESCRIPTOR_BINDING_MISMATCH');
  if (BigInt(d.revision) > 18446744073709551615n) fail('UINT64_INVALID');
  const opens = time(d.window.opens_at); const closes = time(d.window.closes_at);
  if (opens >= closes) fail('WINDOW_INVALID');
  for (const rows of [d.action_groups, d.budgets, d.opportunities]) if (new Set(rows.map(row => row.id)).size !== rows.length) fail('DESCRIPTOR_DUPLICATE_ID');
  if (d.budgets.some(b => b.window_id !== d.window.id)) fail('BUDGET_WINDOW_MISMATCH');
  const dedupe = new Map<string, boolean>();
  for (const o of d.opportunities) {
    if (!d.action_groups.some(g => g.id === o.action_group_id) || !d.budgets.some(b => b.id === o.budget_group_id)) fail('OPPORTUNITY_REFERENCE_INVALID');
    if (o.budget_window_id !== d.window.id || time(o.not_before) < opens || time(o.not_before) >= time(o.expires_at) || time(o.expires_at) > closes) fail('OPPORTUNITY_WINDOW_INVALID');
    const dm = o.channels?.includes('direct_message') === true;
    if (dm && d.dm_response_slot_key !== undefined && o.dedupe_key !== d.dm_response_slot_key) fail('RESPONSE_SLOT_INVALID');
    if (dedupe.has(o.dedupe_key) && !(dm && dedupe.get(o.dedupe_key) && o.dedupe_key === d.dm_response_slot_key)) fail('DEDUPE_KEY_DUPLICATE');
    dedupe.set(o.dedupe_key, dm);
  }
  return d;
}

/** Generated proto values are adapted without rounding uint64 revisions. Caller
 * must authenticate the containing ActionResult/private wrapper first. */
export function participationDescriptorFromProto(p: popclaw.world.IParticipationDescriptor): unknown {
  const stamp = (v: unknown): string => {
    const raw = String(v ?? '0');
    if ((typeof v === 'number' && !Number.isSafeInteger(v)) || !/^(0|-?[1-9][0-9]*)$/.test(raw) || BigInt(raw) < -62167219200n || BigInt(raw) > 253402300799n) fail('TIME_INVALID');
    return new Date(Number(raw) * 1000).toISOString().replace('.000Z', 'Z');
  };
  if (typeof p.revision === 'number' && !Number.isSafeInteger(p.revision)) fail('UINT64_INVALID');
  return {
    version: p.version, house: { origin: p.house?.origin, house_key: p.house?.houseKey, incarnation: p.house?.incarnation },
    actor_id: p.actorId, participation_id: p.participationId, revision: String(p.revision ?? '0'),
    window: { id: p.windowId, opens_at: stamp(p.windowOpensAt), closes_at: stamp(p.windowClosesAt) },
    action_groups: (p.actionGroups ?? []).map(g => ({ id: g.id, intent_kinds: g.intentKinds, control_reset: g.controlReset, ...(g.channels?.length ? { channels: g.channels } : {}) })),
    budgets: (p.budgets ?? []).map(b => ({ id: b.id, window_id: b.windowId, resource: b.resource, suggested_limit: b.suggestedLimit ?? 0 })),
    opportunities: (p.opportunities ?? []).map(o => ({ id: o.id, action_group_id: o.actionGroupId, budget_group_id: o.budgetGroupId, budget_window_id: o.budgetWindowId,
      not_before: stamp(o.notBefore), expires_at: stamp(o.expiresAt), dedupe_key: o.dedupeKey,
      ...(o.sourceEventId ? { source_event_id: o.sourceEventId } : {}), ...(o.channels?.length ? { channels: o.channels } : {}) })),
    ...(p.dmResponseSlotKey ? { dm_response_slot_key: p.dmResponseSlotKey } : {}),
  };
}

/** Durable policy only: no timers, model, signing, host wakeup or egress. All
 * mutators are synchronous HostDb transactions. A returned token is an identity
 * to re-check before each real send, not permission to bypass the G0/egress gates.
 * The host registry must reuse the same instance for its binding for its entire
 * lifetime: rebuilding it must not bypass a failed-persistence invalidation.
 * After a database failure/restart, readiness must be freshly verified. */
export class WorldParticipation {
  private invalidated = false;
  private readonly binding: string;
  private readonly house: popclaw.world.IHouseBinding;
  constructor(private readonly db: HostDb, house: popclaw.world.IHouseBinding, private readonly actorId: string, private readonly participationId: string) {
    publicKey(house.houseKey ?? ''); publicKey(actorId); opaque(participationId);
    if (!house.origin || !/^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(house.origin) || !/^[A-Za-z0-9_-]{1,64}$/.test(house.incarnation ?? '')) fail('BINDING_INVALID');
    this.house = clone(house);
    this.binding = canonical([house.origin, house.houseKey, house.incarnation, actorId, participationId]);
    db.execute('CREATE TABLE IF NOT EXISTS world_participation_policy (binding TEXT PRIMARY KEY, state TEXT NOT NULL)');
    db.transaction(tx => {
      // Preserve reservations/control created by the initial single-entity
      // implementation, but only for its explicitly recorded participation.
      // Existing entity rows always win; no other participation inherits it.
      const legacy = tx.queryOne<{ state: string }>('SELECT state FROM world_participation_policy WHERE binding=?', [canonical([house.origin, house.houseKey, house.incarnation, actorId])]);
      const inherited = legacy && (JSON.parse(legacy.state) as State).descriptor?.participation_id === participationId ? legacy.state : undefined;
      tx.execute('INSERT OR IGNORE INTO world_participation_policy(binding,state) VALUES (?,?)', [this.binding, inherited ?? JSON.stringify({
        available: false, manual: false, grants: [], locks: [], epochs: [], slots: [], windows: [], sources: [], charges: [], poolCharges: [], reservations: [], batches: [], ownerMessages: [],
      })]);
    });
  }
  /** Request bytes and their reservation link must share this exact HostDb
   * transaction handle; a second connection/database cannot join its rollback. */
  assertDatabase(db: HostDb): void {
    if (db !== this.db) fail('PARTICIPATION_DATABASE_MISMATCH');
  }
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string, participationId: string): void {
    if (db !== this.db || canonical([house.origin, house.houseKey, house.incarnation, actorId, participationId]) !== this.binding) fail('PARTICIPATION_BINDING_MISMATCH');
  }
  private read(db = this.db): State {
    const state = JSON.parse(db.queryOne<{ state: string }>('SELECT state FROM world_participation_policy WHERE binding=?', [this.binding])!.state) as State;
    state.poolCharges ??= [];
    state.turns ??= [];
    return state;
  }
  private change<T>(fn: (state: State) => T): ParticipationResult<T> {
    try {
      const value = this.db.transaction(tx => {
        const state = this.read(tx); const result = fn(state);
        tx.execute('UPDATE world_participation_policy SET state=? WHERE binding=?', [JSON.stringify(state), this.binding]);
        return result;
      });
      return { ok: true, value };
    } catch (error) { return { ok: false, code: error instanceof Error ? error.message : 'POLICY_STORAGE_ERROR' }; }
  }
  mergeAuthenticatedDescriptor(value: unknown, evidence: { source: 'verified_action_result' | 'verified_private_state'; trustedCurrent: boolean; capabilityRevision: string }, now: string): ParticipationResult<'installed' | 'duplicate' | 'old'> {
    try {
      if (!['verified_action_result', 'verified_private_state'].includes(evidence.source) || !/^[0-9a-f]{64}$/.test(evidence.capabilityRevision)) fail('DESCRIPTOR_UNTRUSTED');
      time(now);
    } catch (error) {
      this.invalidate('untrusted');
      return { ok: false, code: error instanceof Error ? error.message : 'DESCRIPTOR_INVALID' };
    }
    const result = this.change(state => {
      const old = state.descriptor;
      const incoming = descriptorShape(value);
      if (incoming.participation_id !== this.participationId) fail('PARTICIPATION_ID_MISMATCH');
      const frozen = state.slots.find(s => s.window === incoming.window.id);
      if (frozen?.key && (!old || BigInt(incoming.revision) > BigInt(old.revision)) &&
        (frozen.key !== (incoming.dm_response_slot_key ?? null) || (frozen.key !== null && incoming.opportunities.some(o => o.channels?.includes('direct_message') && o.dedupe_key !== frozen.key)))) fail('RESPONSE_SLOT_IMMUTABLE');
      const descriptor = validateParticipationDescriptor(incoming, this.house, this.actorId);
      if (old && BigInt(descriptor.revision) < BigInt(old.revision)) return 'old' as const;
      if (old && descriptor.revision === old.revision && canonical(descriptor) !== canonical(old)) fail('DESCRIPTOR_REVISION_CONFLICT');
      const slot = state.slots.find(s => s.window === descriptor.window.id);
      if (slot?.key && slot.key !== (descriptor.dm_response_slot_key ?? null)) fail('RESPONSE_SLOT_IMMUTABLE');
      if (old && old.window.id !== descriptor.window.id && state.windows.includes(descriptor.window.id)) fail('WINDOW_REUSE_REJECTED');
      if (!slot) state.slots.push({ window: descriptor.window.id, key: descriptor.dm_response_slot_key ?? null });
      else if (!slot.key && descriptor.dm_response_slot_key) slot.key = descriptor.dm_response_slot_key;
      if (!state.windows.includes(descriptor.window.id)) state.windows.push(descriptor.window.id);
      state.descriptor = descriptor;
      state.capabilityRevision = evidence.capabilityRevision;
      state.available = evidence.trustedCurrent && time(now) < time(descriptor.window.closes_at);
      return old?.revision === descriptor.revision ? 'duplicate' as const : 'installed' as const;
    });
    if (!result.ok) this.invalidate('untrusted');
    else if (result.value !== 'old' && evidence.trustedCurrent === true) this.invalidated = false;
    return result;
  }
  /** Gap/untrusted/expired state disables execution only; facts remain readable. */
  invalidate(reason: 'gap' | 'untrusted' | 'expired'): ParticipationResult {
    this.invalidated = true;
    if (!['gap', 'untrusted', 'expired'].includes(reason)) return { ok: false, code: 'INVALIDATION_REASON_INVALID' };
    return this.change(s => { s.available = false; });
  }
  facts(): ParticipationDescriptor | undefined { return this.read().descriptor; }
  capabilityRevision(): string | undefined { return this.read().capabilityRevision; }
  /** Reads one durable snapshot plus this resource's failed-persistence fence.
   * Evaluation never expires, revokes, refreshes or otherwise writes policy. */
  view(now: string): ParticipationView {
    const at = time(now), state = this.read(), descriptor = state.descriptor;
    const descriptorValidity: ParticipationView['descriptor_validity'] = this.invalidated ? 'fenced'
      : !descriptor ? 'missing' : !state.available ? 'unavailable'
      : at < time(descriptor.window.opens_at) ? 'not_open' : at >= time(descriptor.window.closes_at) ? 'expired' : 'current';
    return clone({
      house: { origin: this.house.origin!, house_key: this.house.houseKey!, incarnation: this.house.incarnation! },
      actor_id: this.actorId, participation_id: this.participationId, evaluated_at: now,
      descriptor: descriptor ?? null, capability_revision: state.capabilityRevision ?? null,
      descriptor_validity: descriptorValidity, durable_available: state.available, runtime_fenced: this.invalidated, manual: state.manual,
      grants: state.grants.map(grant => {
        const { expires_at, window_ref, max_agent_turns, max_outbound_messages, max_owner_notices } = grant.policy;
        const status: ParticipationGrantView['status'] = at >= time(expires_at) ? 'expired'
          : window_ref !== undefined && window_ref !== descriptor?.window.id ? 'other_window'
          : !descriptor?.action_groups.some(group => group.intent_kinds.includes(grant.kind)) ? 'kind_not_declared' : 'current';
        return { kind: grant.kind, policy: { expires_at, ...(window_ref !== undefined ? { window_ref } : {}),
          max_agent_turns, max_outbound_messages, max_owner_notices }, status };
      }),
      locks: state.locks.map(lock => ({ kind: lock.kind, window_ref: lock.window, active: lock.active,
        applies_to_current_window: !!descriptor && (lock.window === null || lock.window === descriptor.window.id) })),
      ceilings: state.ceilings ?? null,
    });
  }
  configureCeilings(value: ParticipationCeilings): ParticipationResult {
    return this.change(s => {
      limits(value.aggregate); limits(value.rolling?.limits);
      if (!Number.isSafeInteger(value.rolling.seconds) || value.rolling.seconds < 1 || typeof value.count_successful_owner_messages !== 'boolean') fail('POLICY_INVALID');
      s.ceilings = clone(value);
    });
  }
  grant(policy: ParticipationLocalPolicy): ParticipationResult {
    return this.change(s => {
      const d = s.descriptor;
      if (!d || (policy.window_ref !== undefined && policy.window_ref !== d.window.id)) fail('POLICY_WINDOW_MISMATCH');
      if (!Array.isArray(policy.allowed_action_kinds) || !policy.allowed_action_kinds.length || new Set(policy.allowed_action_kinds).size !== policy.allowed_action_kinds.length) fail('POLICY_INVALID');
      time(policy.expires_at);
      limits({ agent_turn: policy.max_agent_turns, outbound_message: policy.max_outbound_messages, owner_notice: policy.max_owner_notices });
      for (const kind of policy.allowed_action_kinds) {
        if (!kindPattern.test(kind) || kind.length > 64 || !d.action_groups.some(g => g.intent_kinds.includes(kind))) fail('KIND_NOT_IN_GROUP');
        const epoch = this.bump(s, kind);
        s.grants = s.grants.filter(g => g.kind !== kind);
        s.grants.push({ kind, epoch, policy: clone(policy) });
      }
    });
  }
  private bump(s: State, kind: string): number {
    const row = s.epochs.find(e => e.kind === kind);
    if (row) return ++row.epoch;
    s.epochs.push({ kind, epoch: 1 }); return 1;
  }
  revoke(kinds: string[]): ParticipationResult {
    return this.change(s => { for (const kind of kinds) { this.bump(s, kind); s.grants = s.grants.filter(g => g.kind !== kind); } });
  }
  /** Commit this before the owner's external replacement, even if it later fails. */
  takeover(scope: { whole: true } | { groupId: string }): ParticipationResult {
    return this.change(s => {
      if ('whole' in scope) {
        s.manual = true;
        for (const grant of s.grants) this.bump(s, grant.kind);
      } else {
        const group = s.descriptor?.action_groups.find(g => g.id === scope.groupId);
        if (!group) fail('GROUP_UNKNOWN');
        for (const kind of group.intent_kinds) {
          this.bump(s, kind);
          s.locks.push({ kind, window: group.control_reset === 'explicit' ? null : s.descriptor!.window.id, active: true });
        }
      }
    });
  }
  resume(scope: { whole: true } | { kinds: string[] }): ParticipationResult {
    return this.change(s => {
      if ('whole' in scope) s.manual = false;
      else for (const kind of scope.kinds) { for (const lock of s.locks.filter(l => l.kind === kind)) lock.active = false; }
    });
  }
  /** CID/signature validation belongs to ingress. This method records facts only. */
  sourceArrived(verifiedEventId: string): ParticipationResult {
    return this.change(s => {
      if (!/^[0-9a-f]{64}$/.test(verifiedEventId)) fail('SOURCE_EVENT_INVALID');
      if (!s.sources.includes(verifiedEventId)) s.sources.push(verifiedEventId);
    });
  }
  private current(s: State, now: number): ParticipationDescriptor {
    const d = s.descriptor;
    if (this.invalidated || !s.available || !d) fail('DESCRIPTOR_UNAVAILABLE');
    if (now < time(d.window.opens_at) || now >= time(d.window.closes_at)) fail('OPPORTUNITY_EXPIRED');
    if (s.manual) fail('PARTICIPATION_MANUAL');
    return d;
  }
  private gate(s: State, inv: ParticipationInvocation, now: number, requiredGrantKind?: string): { opportunity: ParticipationOpportunity; grant: Grant; kinds: string[] } {
    const d = this.current(s, now);
    const opportunity = d.opportunities.find(o => o.id === inv.opportunityId);
    const group = d.action_groups.find(g => g.id === opportunity?.action_group_id);
    if (!opportunity || !group || (inv.channel !== 'direct_message' && !group.intent_kinds.includes(inv.kind)) || (inv.channel === 'direct_message' && inv.kind !== 'direct_message')) fail('KIND_NOT_IN_GROUP');
    const kinds = inv.channel === 'direct_message' ? group.intent_kinds : [inv.kind];
    // DM cannot route around any controlled kind in its shared expression group.
    if (s.locks.some(l => l.active && kinds.includes(l.kind) && (l.window === null || l.window === d.window.id))) fail('GROUP_TAKEOVER_ACTIVE');
    const grant = s.grants.find(g => (requiredGrantKind === undefined || g.kind === requiredGrantKind) && kinds.includes(g.kind) && (g.policy.window_ref === undefined || g.policy.window_ref === d.window.id) && now < time(g.policy.expires_at));
    if (!grant) fail('GRANT_MISSING');
    if (now < time(opportunity.not_before) || now >= time(opportunity.expires_at) || time(inv.contextValidUntil) <= now || time(inv.contextValidUntil) > time(opportunity.expires_at) || time(inv.contextValidUntil) > now + 300) fail('OPPORTUNITY_EXPIRED');
    if (opportunity.source_event_id && !s.sources.includes(opportunity.source_event_id)) fail('SOURCE_NOT_ARRIVED');
    if (inv.expectedCapabilityRevision !== s.capabilityRevision) fail('CAPABILITY_REVISION_MISMATCH');
    if (typeof inv.message !== 'boolean' || !['intent', 'direct_message', 'owner_notice'].includes(inv.channel)) fail('INVOCATION_INVALID');
    if (inv.channel === 'direct_message' && !inv.message) fail('INVOCATION_INVALID');
    return { opportunity, grant, kinds };
  }
  private channels(d: ParticipationDescriptor, o: ParticipationOpportunity, inv: ParticipationInvocation): void {
    if (inv.channel === 'owner_notice') return;
    const group = d.action_groups.find(g => g.id === o.action_group_id)!;
    if (!(group.channels ?? ['intent']).includes(inv.channel) || !(o.channels ?? ['intent']).includes(inv.channel)) fail('CHANNEL_NOT_IN_GROUP');
  }
  private budget(s: State, grant: Grant, resource: Resource, units: number, now: number): void {
    const d = s.descriptor!;
    const used = (predicate: (c: Charge) => boolean) => s.charges.filter(c => c.resource === resource && predicate(c)).reduce((sum, c) => sum + c.units, 0);
    if (!s.ceilings || used(c => c.window === d.window.id) + units > policyLimit(grant.policy, resource) ||
      used(() => true) + units > s.ceilings.aggregate[resource] ||
      used(c => c.at > now - s.ceilings!.rolling.seconds) + units > s.ceilings.rolling.limits[resource]) fail('BUDGET_EXHAUSTED');
  }
  private poolBudget(s: State, opportunity: ParticipationOpportunity, units: number): void {
    const d = s.descriptor!;
    const budget = d.budgets.find(b => b.id === opportunity.budget_group_id)!;
    const used = s.poolCharges.filter(c => c.window === d.window.id && c.budgetGroupId === budget.id).reduce((sum, c) => sum + c.units, 0);
    // Legacy rows recorded only one resource-wide pool. Preserve that occupied
    // capacity conservatively; never infer unused pools or refund old sends.
    const legacy = s.charges.filter(c => !c.poolTracked && c.window === d.window.id && c.resource === budget.resource).reduce((sum, c) => sum + c.units, 0);
    if (used + legacy + units > budget.suggested_limit) fail('BUDGET_EXHAUSTED');
  }
  private poolCharge(s: State, inv: ParticipationInvocation, opportunity: ParticipationOpportunity, turnId: string, now: number): PoolCharge | undefined {
    const d = s.descriptor!;
    const budget = d.budgets.find(b => b.id === opportunity.budget_group_id)!;
    if (budget.resource === 'agent_turn' && s.poolCharges.some(c => c.window === d.window.id && c.budgetGroupId === budget.id && c.turnId === turnId)) return undefined;
    return { resource: budget.resource, budgetGroupId: budget.id, at: now, window: d.window.id, units: 1, kind: inv.kind, turnId, poolTracked: true };
  }
  private validateBudgetClass(d: ParticipationDescriptor, inv: ParticipationInvocation, opportunity: ParticipationOpportunity): void {
    const resource = d.budgets.find(b => b.id === opportunity.budget_group_id)!.resource;
    if (inv.channel === 'owner_notice' && inv.message) fail('INVOCATION_INVALID');
    // Classification comes from trusted egress, not descriptor budget labels.
    // Both directions reject: neither a message nor a decision may switch pools.
    const expected: Resource = inv.channel === 'owner_notice' ? 'owner_notice' : inv.message ? 'outbound_message' : 'agent_turn';
    if (resource !== expected) fail('BUDGET_GROUP_MISMATCH');
  }
  private requestedCharges(s: State, inv: ParticipationInvocation, opportunity: ParticipationOpportunity, turnId: string, now: number): Charge[] {
    const d = s.descriptor!;
    this.validateBudgetClass(d, inv, opportunity);
    const resources: Resource[] = [
      ...(!s.charges.some(c => c.resource === 'agent_turn' && c.turnId === turnId && c.window === d.window.id) ? ['agent_turn' as const] : []),
      ...(inv.channel === 'owner_notice' ? ['owner_notice' as const] : inv.message ? ['outbound_message' as const] : []),
    ];
    return resources.map(resource => ({ resource, at: now, window: d.window.id, units: 1, kind: inv.kind, poolTracked: true, ...(resource === 'agent_turn' ? { turnId } : {}) }));
  }
  private dedupeOccupied(s: State, key: string): boolean {
    return s.reservations.some(r => r.dedupeKey === key) || s.turns.some(t => t.dedupeKeys.includes(key));
  }
  private turnView(t: StoredTurn, routes = t.routes): ParticipationTurn {
    return clone({ turnReservationId: t.turnReservationId, jobId: t.jobId, turnId: t.turnId,
      windowId: t.windowId, descriptorRevision: t.descriptorRevision, capabilityRevision: t.capabilityRevision,
      contextValidUntil: t.contextValidUntil, status: t.status, ...(t.outcome ? { outcome: t.outcome } : {}),
      candidates: [...new Map(routes.map(r => [canonical(r.invocation), r.invocation])).values()] });
  }
  private turnRow(s: State, identity: ParticipationTurnIdentity): StoredTurn {
    const t = s.turns.find(row => row.turnReservationId === identity.turnReservationId);
    if (!t || t.jobId !== identity.jobId || t.turnId !== identity.turnId) fail('TURN_MISMATCH');
    return t;
  }
  private turnCurrent(s: State, t: StoredTurn): void {
    if (this.invalidated) fail('DESCRIPTOR_UNAVAILABLE');
    if (s.descriptor?.window.id !== t.windowId || s.descriptor?.revision !== t.descriptorRevision || s.capabilityRevision !== t.capabilityRevision) fail('TURN_OBSOLETE');
  }
  private capturedGate(s: State, route: CapturedTurnRoute, inv: ParticipationInvocation, at: number) {
    const checked = this.gate(s, inv, at, route.grantKind);
    if ((s.epochs.find(e => e.kind === route.grantKind)?.epoch ?? 0) !== route.epoch) fail('RESERVATION_CANCELLED');
    this.validateBudgetClass(s.descriptor!, inv, checked.opportunity);
    return checked;
  }
  /** Before any model effect: the committed creator alone may launch one turn.
   * Exact recovery returns created=false even after finish/expiry; never relaunch.
   * Candidate channel/resource checks do not pre-charge outbound attempts. */
  reserveTurn(input: ParticipationTurnInput, now: string): ParticipationResult<{ created: boolean; ticket: ParticipationTurn }> {
    if (this.invalidated) return { ok: false, code: 'DESCRIPTOR_UNAVAILABLE' };
    return this.change(s => {
      opaque(input.jobId); opaque(input.turnId); const at = time(now);
      if (!Array.isArray(input.opportunityIds) || !input.opportunityIds.length || input.opportunityIds.length > 64 || new Set(input.opportunityIds).size !== input.opportunityIds.length) fail('BATCH_INVALID');
      for (const id of input.opportunityIds) opaque(id);
      const exact = canonical(input), previous = s.turns.find(t => t.jobId === input.jobId);
      if (previous) {
        if (previous.canonical !== exact) fail('JOB_ID_CONFLICT');
        return { created: false, ticket: this.turnView(previous) };
      }
      if (s.batches.some(b => b.jobId === input.jobId)) fail('JOB_ID_CONFLICT');
      if (s.turns.some(t => t.turnId === input.turnId) || s.reservations.some(r => r.turnId === input.turnId) || s.batches.some(b => (JSON.parse(b.canonical) as { turnId?: string }).turnId === input.turnId)) fail('TURN_ID_CONFLICT');
      const d = this.current(s, at); const until = time(input.contextValidUntil);
      if (until <= at) fail('OPPORTUNITY_EXPIRED');
      if (input.expectedCapabilityRevision !== s.capabilityRevision) fail('CAPABILITY_REVISION_MISMATCH');
      const routes: CapturedTurnRoute[] = [], dedupeKeys = new Set<string>(), pools = new Map<string, PoolCharge>();
      for (const id of input.opportunityIds) {
        const o = d.opportunities.find(o => o.id === id);
        if (!o || this.dedupeOccupied(s, o.dedupe_key)) continue;
        const group = d.action_groups.find(g => g.id === o.action_group_id)!;
        const resource = d.budgets.find(b => b.id === o.budget_group_id)!.resource;
        const expires = new Date(Math.min(until, time(o.expires_at), at + 300) * 1000).toISOString().replace('.000Z', 'Z');
        for (const kind of group.intent_kinds) {
          const channels: ParticipationInvocation['channel'][] = resource === 'owner_notice' ? ['owner_notice'] : ['intent', ...(resource === 'outbound_message' ? ['direct_message' as const] : [])];
          for (const channel of channels) {
            const inv: ParticipationInvocation = { opportunityId: id, kind: channel === 'direct_message' ? 'direct_message' : kind,
              channel, message: resource === 'outbound_message', contextValidUntil: expires, expectedCapabilityRevision: input.expectedCapabilityRevision };
            try {
              const { grant } = this.gate(s, inv, at, kind);
              this.validateBudgetClass(d, inv, o); this.poolBudget(s, o, 1);
              this.budget(s, grant, 'agent_turn', 1, at);
              if (resource !== 'agent_turn') this.budget(s, grant, resource, 1, at);
              this.channels(d, o, inv);
              routes.push({ invocation: inv, grantKind: grant.kind, epoch: s.epochs.find(e => e.kind === grant.kind)?.epoch ?? 0 });
              dedupeKeys.add(o.dedupe_key);
              if (resource === 'agent_turn' && !pools.has(o.budget_group_id)) pools.set(o.budget_group_id, {
                resource, budgetGroupId: o.budget_group_id, at, window: d.window.id, units: 1, kind, turnId: input.turnId, poolTracked: true,
              });
            } catch { /* Other captured candidates can remain independently viable. */ }
          }
        }
      }
      if (!routes.length) fail('TURN_NOT_ELIGIBLE');
      const t: StoredTurn = { turnReservationId: canonical([this.binding, 'model_turn', input.jobId]), jobId: input.jobId, turnId: input.turnId,
        windowId: d.window.id, descriptorRevision: d.revision, capabilityRevision: input.expectedCapabilityRevision, contextValidUntil: input.contextValidUntil,
        status: 'reserved', canonical: exact, routes, dedupeKeys: [...dedupeKeys], attempts: [] };
      s.charges.push({ resource: 'agent_turn', at, window: d.window.id, units: 1, kind: routes[0]!.grantKind, turnId: input.turnId, poolTracked: true });
      s.poolCharges.push(...pools.values()); s.turns.push(t);
      return { created: true, ticket: this.turnView(t) };
    });
  }
  /** Recheck after every asynchronous boundary before the one actual model call.
   * This read does not launch/relaunch or grant host readiness; G0 must also check
   * its captured HostGate/readiness/capabilities. Invalid siblings are filtered. */
  authorizeTurn(identity: ParticipationTurnIdentity, now: string): ParticipationResult<ParticipationTurn> {
    try {
      const s = this.read(), t = this.turnRow(s, identity), at = time(now);
      if (t.status !== 'reserved') fail('TURN_CLOSED');
      this.turnCurrent(s, t);
      const routes = t.routes.filter(route => {
        try {
          const inv = route.invocation, { opportunity, grant } = this.capturedGate(s, route, inv, at);
          const resource = s.descriptor!.budgets.find(b => b.id === opportunity.budget_group_id)!.resource;
          this.poolBudget(s, opportunity, resource === 'agent_turn' ? 0 : 1);
          this.budget(s, grant, 'agent_turn', 0, at);
          if (resource !== 'agent_turn') this.budget(s, grant, resource, 1, at);
          this.channels(s.descriptor!, opportunity, inv); return true;
        } catch { return false; }
      });
      if (!routes.length) fail('TURN_NOT_ELIGIBLE');
      return { ok: true, value: this.turnView(t, routes) };
    } catch (error) { return { ok: false, code: error instanceof Error ? error.message : 'POLICY_STORAGE_ERROR' }; }
  }
  /** Reserve only an actual classified attempt; the model turn already costs one.
   * Retry identity is durable, including after turn close. Existing request bytes
   * still require authorizeReservation and the original action-client journal. */
  reserveAttempt(input: ParticipationTurnIdentity & { attemptId: string; invocation: ParticipationInvocation }, now: string): ParticipationResult<ParticipationReservation> {
    if (this.invalidated) return { ok: false, code: 'DESCRIPTOR_UNAVAILABLE' };
    return this.change(s => {
      opaque(input.attemptId); const at = time(now), t = this.turnRow(s, input), exact = canonical(input);
      const previous = t.attempts.find(a => a.attemptId === input.attemptId);
      if (previous) {
        if (previous.canonical !== exact) fail('ATTEMPT_ID_CONFLICT');
        const r = s.reservations.find(r => r.reservationId === previous.reservationId);
        if (!r) fail('RESERVATION_UNKNOWN');
        return clone(r);
      }
      if (t.status !== 'reserved') fail('TURN_CLOSED');
      this.turnCurrent(s, t);
      const inv = input.invocation, candidates = t.routes.filter(r => r.invocation.opportunityId === inv.opportunityId);
      if (!candidates.length) fail('OPPORTUNITY_NOT_RESERVED');
      const matching = candidates.filter(r => r.invocation.kind === inv.kind && r.invocation.channel === inv.channel && r.invocation.message === inv.message);
      if (!matching.length) fail('INVOCATION_NOT_CAPTURED');
      if (inv.expectedCapabilityRevision !== t.capabilityRevision || time(inv.contextValidUntil) > time(matching[0]!.invocation.contextValidUntil)) fail('TURN_CONTEXT_MISMATCH');
      let selected: { route: CapturedTurnRoute; opportunity: ParticipationOpportunity; grant: Grant; kinds: string[] } | undefined;
      let lastError = 'RESERVATION_CANCELLED';
      for (const route of matching) {
        try {
          const checked = this.capturedGate(s, route, inv, at);
          const resource = s.descriptor!.budgets.find(b => b.id === checked.opportunity.budget_group_id)!.resource;
          this.poolBudget(s, checked.opportunity, resource === 'agent_turn' ? 0 : 1);
          this.budget(s, checked.grant, 'agent_turn', 0, at);
          if (resource !== 'agent_turn') this.budget(s, checked.grant, resource, 1, at);
          this.channels(s.descriptor!, checked.opportunity, inv);
          selected = { route, ...checked }; break;
        } catch (error) { lastError = error instanceof Error ? error.message : 'INVOCATION_INVALID'; }
      }
      if (!selected) fail(lastError);
      const { route, opportunity, grant, kinds } = selected;
      if (s.reservations.some(r => r.dedupeKey === opportunity.dedupe_key)) fail('DEDUPE_KEY_RESERVED');
      const charges = this.requestedCharges(s, inv, opportunity, t.turnId, at);
      if (charges.some(c => c.resource === 'agent_turn')) fail('TURN_CHARGE_MISSING');
      const pool = this.poolCharge(s, inv, opportunity, t.turnId, at);
      const r: StoredReservation = { reservationId: canonical([this.binding, 'turn_attempt', t.jobId, input.attemptId]), jobId: t.jobId, turnId: t.turnId,
        invocation: clone(inv), windowId: t.windowId, descriptorRevision: t.descriptorRevision, dedupeKey: opportunity.dedupe_key,
        grantKind: grant.kind, epoch: route.epoch, kinds, charges, status: 'reserved' };
      s.charges.push(...charges); if (pool) s.poolCharges.push(pool); s.reservations.push(r);
      t.attempts.push({ attemptId: input.attemptId, canonical: exact, reservationId: r.reservationId });
      return clone(r);
    });
  }
  /** Local model outcome only. No action result, quota refund, or implicit retry. */
  finishTurn(input: ParticipationTurnIdentity & { outcome: ParticipationTurnOutcome }, now: string): ParticipationResult {
    return this.change(s => {
      time(now); const t = this.turnRow(s, input);
      if (!['no_action', 'invalid_output', 'model_failed', 'completed'].includes(input.outcome)) fail('RESULT_INVALID');
      if (t.status === 'closed') { if (t.outcome !== input.outcome) fail('RESULT_CONFLICT'); return; }
      if (input.outcome === 'no_action' && t.attempts.length) fail('TURN_OUTCOME_CONFLICT');
      t.status = 'closed'; t.outcome = input.outcome;
    });
  }
  /** Each invocation passes independently. Accepted siblings and their shared
   * turn charge commit in one transaction; failed siblings spend nothing. The
   * trusted host owns turnId; never reuse it across actual host turns. Replaying
   * a job returns identities, never dispatches. Storage failure rolls back all. */
  reserveBatch(input: { jobId: string; turnId: string; invocations: ParticipationInvocation[] }, now: string): ParticipationResult<ParticipationBatchOutcome[]> {
    if (this.invalidated) return { ok: false, code: 'DESCRIPTOR_UNAVAILABLE' };
    return this.change(s => {
      opaque(input.jobId); opaque(input.turnId); const at = time(now);
      if (!input.invocations.length || input.invocations.length > 64) fail('BATCH_INVALID');
      if (s.turns.some(t => t.jobId === input.jobId)) fail('JOB_ID_CONFLICT');
      if (s.turns.some(t => t.turnId === input.turnId)) fail('TURN_ID_CONFLICT');
      const previous = s.batches.find(b => b.jobId === input.jobId);
      const exact = canonical(input);
      if (previous) {
        if (previous.canonical !== exact) fail('JOB_ID_CONFLICT');
        return clone(previous.outcomes);
      }
      // A turn identity belongs to exactly one batch; a later job cannot mint a free turn.
      if (s.reservations.some(r => r.turnId === input.turnId)) fail('TURN_ID_CONFLICT');
      const outcomes: ParticipationBatchOutcome[] = [];
      for (const inv of input.invocations) {
        try {
        const { opportunity, grant, kinds } = this.gate(s, inv, at);
        const charges = this.requestedCharges(s, inv, opportunity, input.turnId, at);
        const poolCharge = this.poolCharge(s, inv, opportunity, input.turnId, at);
        this.poolBudget(s, opportunity, poolCharge ? 1 : 0);
        for (const charge of charges.filter(c => c.resource !== 'agent_turn')) this.budget(s, grant, charge.resource, charge.units, at);
        // Even subsequent batched decisions must still obey lowered turn limits.
        if (!charges.some(c => c.resource === 'agent_turn')) this.budget(s, grant, 'agent_turn', 0, at);
        if (this.dedupeOccupied(s, opportunity.dedupe_key)) fail('DEDUPE_KEY_RESERVED');
        for (const charge of charges.filter(c => c.resource === 'agent_turn')) this.budget(s, grant, charge.resource, charge.units, at);
        this.channels(s.descriptor!, opportunity, inv);
        const reservation: StoredReservation = {
          reservationId: canonical([this.binding, input.jobId, opportunity.id]), jobId: input.jobId, turnId: input.turnId,
          invocation: clone(inv), windowId: s.descriptor!.window.id, descriptorRevision: s.descriptor!.revision,
          dedupeKey: opportunity.dedupe_key, grantKind: grant.kind, epoch: s.epochs.find(e => e.kind === grant.kind)?.epoch ?? 0, kinds,
          charges, status: 'reserved',
        };
        s.charges.push(...charges); s.reservations.push(reservation);
        if (poolCharge) s.poolCharges.push(poolCharge);
        outcomes.push({ ok: true, invocation: clone(inv), reservation: clone(reservation) });
        } catch (error) { outcomes.push({ ok: false, invocation: clone(inv), code: error instanceof Error ? error.message : 'INVOCATION_INVALID' }); }
      }
      s.batches.push({ jobId: input.jobId, canonical: exact, outcomes });
      return clone(outcomes);
    });
  }
  reserveNotice(input: { jobId: string; turnId: string; invocation: Omit<ParticipationInvocation, 'channel' | 'message'> }, now: string): ParticipationResult<ParticipationBatchOutcome[]> {
    return this.reserveBatch({ jobId: input.jobId, turnId: input.turnId, invocations: [{ ...input.invocation, channel: 'owner_notice', message: false }] }, now);
  }
  /** Check immediately before EACH actual send. Changed job/kind/opportunity,
   * owner control, revision, policy epoch or current validity rejects the token. */
  authorizeReservation(input: { reservationId: string; jobId: string; invocation: ParticipationInvocation }, now: string): ParticipationResult<ParticipationReservation> {
    try {
      if (this.invalidated) fail('DESCRIPTOR_UNAVAILABLE');
      const s = this.read(); const at = time(now);
      const r = s.reservations.find(row => row.reservationId === input.reservationId);
      if (!r || r.jobId !== input.jobId || canonical(r.invocation) !== canonical(input.invocation)) fail('RESERVATION_MISMATCH');
      if (r.status !== 'reserved' && r.status !== 'unknown') fail('RESERVATION_TERMINAL');
      if (s.descriptor?.window.id !== r.windowId || s.descriptor?.revision !== r.descriptorRevision) fail('RESERVATION_OBSOLETE');
      // Legacy reservations without a recorded grant identity retain their
      // charges, but cannot infer a replacement grant from current group state.
      if (!r.grantKind) fail('RESERVATION_CANCELLED');
      const { opportunity, grant } = this.gate(s, input.invocation, at, r.grantKind);
      if ((s.epochs.find(e => e.kind === grant.kind)?.epoch ?? 0) !== r.epoch) fail('RESERVATION_CANCELLED');
      this.validateBudgetClass(s.descriptor, input.invocation, opportunity);
      this.poolBudget(s, opportunity, 0);
      for (const resource of new Set([...r.charges.map(c => c.resource), 'agent_turn' as const])) this.budget(s, grant, resource, 0, at);
      this.channels(s.descriptor!, opportunity, input.invocation);
      return { ok: true, value: clone(r) };
    } catch (error) { return { ok: false, code: error instanceof Error ? error.message : 'POLICY_STORAGE_ERROR' }; }
  }
  associateRequest(reservationId: string, requestId: string): ParticipationResult {
    return this.change(s => {
      if (!/^[0-9a-f]{64}$/.test(requestId)) fail('REQUEST_ID_INVALID');
      const r = s.reservations.find(row => row.reservationId === reservationId);
      if (!r) fail('RESERVATION_UNKNOWN');
      if ((r.requestId && r.requestId !== requestId) || s.reservations.some(other => other !== r && other.requestId === requestId)) fail('REQUEST_ID_CONFLICT');
      r.requestId = requestId;
    });
  }
  /** Signed terminal evidence is verified by caller; unknown is not completion.
   * No state here refunds units, including rejection/cancellation. */
  settle(requestId: string, status: ParticipationReservation['status']): ParticipationResult {
    return this.change(s => {
      const r = s.reservations.find(row => row.requestId === requestId);
      if (!r) fail('RESERVATION_UNKNOWN');
      if (!['unknown', 'succeeded', 'rejected', 'cancelled'].includes(status)) fail('RESULT_INVALID');
      if (!['reserved', 'unknown'].includes(r.status) && r.status !== status) fail('RESULT_CONFLICT');
      r.status = status;
    });
  }
  recordSuccessfulOwnerMessage(verifiedRequestId: string, now: string): ParticipationResult {
    return this.change(s => {
      if (!/^[0-9a-f]{64}$/.test(verifiedRequestId)) fail('REQUEST_ID_INVALID');
      const at = time(now);
      if (s.ownerMessages.includes(verifiedRequestId)) return;
      s.ownerMessages.push(verifiedRequestId);
      if (s.ceilings?.count_successful_owner_messages) s.charges.push({ resource: 'outbound_message', window: s.descriptor?.window.id ?? '', at, units: 1, kind: 'owner', poolTracked: true });
    });
  }
  /** Read-only candidates. Calling this after replay cannot create a host job. */
  eligibleOpportunities(now: string): ParticipationOpportunity[] {
    if (this.invalidated) return [];
    const s = this.read(); const at = time(now);
    try { this.current(s, at); } catch { return []; }
    return s.descriptor!.opportunities.filter(o => {
      if (this.dedupeOccupied(s, o.dedupe_key)) return false;
      const group = s.descriptor!.action_groups.find(g => g.id === o.action_group_id)!;
      const resource = s.descriptor!.budgets.find(b => b.id === o.budget_group_id)!.resource;
      return group.intent_kinds.some(kind => {
        const inv: ParticipationInvocation = { opportunityId: o.id, kind, channel: resource === 'owner_notice' ? 'owner_notice' : 'intent', message: resource === 'outbound_message',
          contextValidUntil: new Date(Math.min(time(o.expires_at), at + 300) * 1000).toISOString().replace('.000Z', 'Z'), expectedCapabilityRevision: s.capabilityRevision! };
        // A DM-only group or opportunity remains eligible under the same
        // explicit intersection used at send time.
        const intentAllowed = (group.channels ?? ['intent']).includes('intent') && (o.channels ?? ['intent']).includes('intent');
        if (!intentAllowed && group.channels?.includes('direct_message') && o.channels?.includes('direct_message')) { inv.channel = 'direct_message'; inv.kind = 'direct_message'; inv.message = true; }
        try {
          const { grant } = this.gate(s, inv, at);
          this.poolBudget(s, o, 1);
          for (const charge of this.requestedCharges(s, inv, o, '', at)) this.budget(s, grant, charge.resource, 1, at);
          this.channels(s.descriptor!, o, inv); return true;
        } catch { return false; }
      });
    });
  }
  reservations(): ParticipationReservation[] { return this.read().reservations; }
  usage(): ReadonlyArray<{ resource: Resource; at: number; window: string; units: number }> { return this.read().charges; }
  budgetUsage(): ReadonlyArray<{ budgetGroupId: string; resource: Resource; at: number; window: string; units: number }> { return this.read().poolCharges; }
}
