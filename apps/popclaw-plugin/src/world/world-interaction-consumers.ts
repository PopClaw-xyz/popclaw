import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import type { InboundEnvelope } from '../ingress/event-ingress.js';
import type { ScopedJournalStatus } from './scoped-stream-journal.js';
import type { WorldActionGate } from './action-client.js';
import { sameWorldHouse, verifySubscriptionObservation, worldPublicKey, type WorldSubscriptionQuery } from './action-wire.js';
import type { TrustedWorldCapabilities } from './world-capabilities.js';
import { WorldParticipation, participationDescriptorFromProto } from './world-participation.js';
import type { WorldReadiness } from './world-readiness.js';
import type { WorldReadStateAuthorityStore } from './world-action-authority.js';
import type { WorldOwnerActionAuthorityStore } from './world-owner-action-authority.js';

function requireResult(result: { ok: boolean; code?: string }): void { if (!result.ok) throw new Error(result.code ?? 'WORLD_POLICY_FAILED'); }
function opaque(id: string): void { if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(id)) throw new Error('PARTICIPATION_ID_INVALID'); }
/** One registry instance per resource keeps runtime failure fences attached to
 * the same policy objects. Registration creates no grant or host job. */
export class WorldPolicyRegistry {
  private readonly policies = new Map<string, WorldParticipation>();
  private readonly house: popclaw.world.IHouseBinding;
  private readonly binding: string;
  constructor(private readonly db: HostDb, house: popclaw.world.IHouseBinding, private readonly actorId: string) {
    worldPublicKey(house.houseKey); worldPublicKey(actorId); this.house = structuredClone(house);
    this.binding = JSON.stringify([house.origin, house.houseKey, house.incarnation, actorId]);
    db.execute('CREATE TABLE IF NOT EXISTS world_policy_registry(binding TEXT NOT NULL, participation_id TEXT NOT NULL, PRIMARY KEY(binding,participation_id))');
  }
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void {
    if (db !== this.db || !sameWorldHouse(this.house, house) || actorId !== this.actorId) throw new Error('POLICY_REGISTRY_BINDING_MISMATCH');
  }
  policy(participationId: string): WorldParticipation {
    opaque(participationId);
    let policy = this.policies.get(participationId);
    if (!policy) {
      this.db.transaction(tx => {
        policy = new WorldParticipation(tx, this.house, this.actorId, participationId);
        tx.execute('INSERT OR IGNORE INTO world_policy_registry(binding,participation_id) VALUES(?,?)', [this.binding, participationId]);
      });
      this.policies.set(participationId, policy!);
    }
    return policy!;
  }
  participationIds(): string[] {
    return this.db.queryAll<{ participation_id: string }>('SELECT participation_id FROM world_policy_registry WHERE binding=? ORDER BY participation_id', [this.binding]).map(row => row.participation_id);
  }
}
export interface WorldResultConsumersOptions {
  db: HostDb; house: popclaw.world.IHouseBinding; actorId: string; gate: WorldActionGate;
  capabilities(): TrustedWorldCapabilities | null;
  registry: WorldPolicyRegistry; readiness: WorldReadiness;
  readState: Pick<WorldReadStateAuthorityStore, 'assertBinding' | 'hasRequest' | 'settle'>;
  ownerActions?: Pick<WorldOwnerActionAuthorityStore, 'assertBinding' | 'hasRequest' | 'settle'>;
  /** Real receiver is mandatory for results carrying subscriptions. The factory
   * is lazy to break construction cycles, not to install a fake/no-op lane. */
  subscriptionReceiver(): { assertBinding(db: HostDb, house: popclaw.world.IHouseBinding): void; installSubscription(descriptor: popclaw.world.ISubscriptionDescriptor): void | Promise<void> } | null;
  now(): number;
}
/** Trusted authenticated ingress callbacks only. ActionClient persists original
 * signed evidence before invoking these and ACKs only after they succeed.
 * Stream callbacks receive already verified envelopes from ScopedWorldStreamClient.
 * This composition never schedules a model turn or grants owner authority. */
export function createWorldResultConsumers(options: WorldResultConsumersOptions) {
  const { db, actorId, gate, registry, readiness, readState, ownerActions } = options;
  const house = structuredClone(options.house);
  registry.assertBinding(db, house, actorId); readiness.assertBinding(db, house, actorId); readState.assertBinding(db, house, actorId); ownerActions?.assertBinding(db, house, actorId);
  const active = () => {
    if (gate.origin !== house.origin || gate.signal.aborted || !gate.isActive()) throw new Error('HOUSE_GATE_CLOSED');
  };
  const current = (revision: string | undefined): boolean => {
    const caps = options.capabilities();
    return !!caps && sameWorldHouse(caps.house, house) && caps.capabilityRevision === revision;
  };
  const invalidate = (ids: readonly string[]) => {
    let failure: unknown;
    for (const id of ids) {
      try { readiness.invalidate(id); } catch (error) { failure ??= error; }
      try { requireResult(registry.policy(id).invalidate('untrusted')); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };
  const sync = (id: string) => {
    const policy = registry.policy(id), descriptor = policy.facts(), revision = policy.capabilityRevision();
    if (!descriptor) return;
    if (!current(revision) || !readiness.view(id).ready) { requireResult(policy.invalidate('untrusted')); return; }
    requireResult(policy.mergeAuthenticatedDescriptor(descriptor, { source: 'verified_action_result', trustedCurrent: true, capabilityRevision: revision! }, new Date(options.now() * 1000).toISOString().replace('.000Z', 'Z')));
  };
  return {
    async onResult(result: popclaw.world.ActionResult): Promise<void> {
      active();
      if (!sameWorldHouse(result.house, house) || result.actorId !== actorId || result.audienceId !== actorId) throw new Error('RESULT_BINDING_MISMATCH');
      const id = result.subscription?.participationId || result.participation?.participationId || readiness.refreshParticipation(result.requestId);
      if (id) opaque(id);
      try {
        const state = readiness.recordResult(result);
        let acceptedDescriptor = false;
        if (id && result.subscription) {
          const receiver = options.subscriptionReceiver();
          if (!receiver) throw new Error('SCOPED_RECEIVER_REQUIRED');
          receiver.assertBinding(db, house);
          const descriptor = readiness.subscriptionFor(id);
          if (!descriptor) throw new Error('SUBSCRIPTION_NOT_INSTALLED');
          active(); await receiver.installSubscription(descriptor); active();
        }
        if (result.participation) {
          const merged = registry.policy(result.participation.participationId!).mergeAuthenticatedDescriptor(participationDescriptorFromProto(result.participation), {
            source: 'verified_action_result', trustedCurrent: current(result.capabilityRevision) && readiness.view(id!).ready,
            capabilityRevision: result.capabilityRevision,
          }, new Date(options.now() * 1000).toISOString().replace('.000Z', 'Z'));
          requireResult(merged); acceptedDescriptor = merged.ok && merged.value !== 'old';
        }
        if (result.status >= 3) {
          const status = ({ 3: 'succeeded', 4: 'rejected', 5: 'cancelled' } as const)[result.status as 3 | 4 | 5];
          if (!status) throw new Error('RESULT_STATUS_INVALID');
          for (const pid of registry.participationIds()) {
            const policy = registry.policy(pid);
            if (policy.reservations().some(reservation => reservation.requestId === result.requestId)) requireResult(policy.settle(result.requestId, status));
          }
          if (readState.hasRequest(result.requestId)) readState.settle(result.requestId, status);
          if (ownerActions?.hasRequest(result.requestId)) ownerActions.settle(result.requestId, status);
        }
        // Only this result's affected participation can regain availability.
        // A result under an old manifest never acquires a current manifest tag.
        if (id && current(result.capabilityRevision) && (acceptedDescriptor || state.refreshed)) { readiness.clearInvalidation(id); sync(id); }
        active();
      } catch (error) { if (id) invalidate([id]); throw error; }
    },
    onProgress(bytes: Uint8Array, query: WorldSubscriptionQuery): void {
      active();
      // Authenticate before selecting what to invalidate: arbitrary network
      // bytes must not acquire a policy-denial capability.
      const observation = verifySubscriptionObservation(bytes, query);
      if (!sameWorldHouse(observation.house, house) || observation.actorId !== actorId) throw new Error('OBSERVATION_BINDING_MISMATCH');
      const id = observation.participationId;
      try { readiness.acceptObservation(bytes, query); sync(id); active(); }
      catch (error) { invalidate([id]); throw error; }
    },
    onWorldEvent(event: InboundEnvelope): void {
      active();
      if (!/^[a-f0-9]{64}$/.test(event.eventId) || event.envelope.eventId !== event.eventId) throw new Error('WORLD_SOURCE_ID_INVALID');
      for (const id of registry.participationIds()) requireResult(registry.policy(id).sourceArrived(event.eventId));
      active();
    },
    onStreamState(state: ScopedJournalStatus): void {
      active();
      // Catch-up alone cannot grant readiness or replay an old host job.
      if (state.stale || !state.caughtUp) for (const id of registry.participationIds()) {
        if (readiness.subscriptionFor(id)) requireResult(registry.policy(id).invalidate('gap'));
      }
    },
  };
}
