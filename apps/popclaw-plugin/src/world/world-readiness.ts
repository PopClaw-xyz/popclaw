import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';
import type { ScopedStreamJournal } from './scoped-stream-journal.js';
import type { TrustedWorldCapabilities } from './world-capabilities.js';
import { canonicalWorldCore, sameWorldHouse, worldPublicKey, verifySubscriptionObservation, worldUint64 } from './action-wire.js';

interface StateRow { subscription: Uint8Array | null; observation: Uint8Array | null; snapshot_ref: string | null; current_anchor: string | null; current_digest: string | null; private_current: number }
interface SnapshotRow { revision: string; core: Uint8Array; digest: string }
interface RefreshRow { participation_id: string; anchor: string; descriptor_digest: string }
export interface WorldReadinessView {
  participation_id: string; ready: boolean; canRefresh: boolean;
  phase: 'state_missing' | 'waiting_publication' | 'publication_failed' | 'replaying' | 'snapshot_stale' | 'ready';
  snapshot?: popclaw.world.WorldSnapshot; snapshot_stale: boolean;
  publication?: popclaw.world.SubscriptionObservation;
}
function opaque(value: string): void { if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(value)) throw new Error('PARTICIPATION_ID_INVALID'); }
function requestId(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('REQUEST_ID_INVALID'); }

/** Separate mutable publication evidence and client replay/snapshot evidence.
 * Input result/private facts are delivered only by the authenticating clients;
 * this store never reads authority out of business JSON or guide text. */
export class WorldReadiness {
  private readonly binding: string;
  private readonly invalidated = new Set<string>();
  private readonly house: popclaw.world.IHouseBinding;
  constructor(private readonly db: HostDb, house: popclaw.world.IHouseBinding, private readonly actorId: string, private readonly stream: ScopedStreamJournal) {
    this.house = structuredClone(house);
    worldPublicKey(house.houseKey); worldPublicKey(actorId);
    stream.assertBinding(db, house);
    this.binding = JSON.stringify([house.origin, house.houseKey, house.incarnation, actorId]);
    db.transaction(tx => {
      tx.execute(`CREATE TABLE IF NOT EXISTS world_readiness_invalidations (binding TEXT NOT NULL, participation_id TEXT NOT NULL, PRIMARY KEY(binding,participation_id))`);
      tx.execute(`CREATE TABLE IF NOT EXISTS world_readiness (
        binding TEXT NOT NULL, participation_id TEXT NOT NULL, subscription BLOB, observation BLOB,
        snapshot_ref TEXT, current_anchor TEXT, current_digest TEXT, private_current INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(binding,participation_id))`);
      tx.execute(`CREATE TABLE IF NOT EXISTS world_readiness_snapshots (
        binding TEXT NOT NULL, state_ref TEXT NOT NULL, revision TEXT NOT NULL, core BLOB NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(binding,state_ref))`);
      tx.execute(`CREATE TABLE IF NOT EXISTS world_readiness_refreshes (
        binding TEXT NOT NULL, request_id TEXT NOT NULL, participation_id TEXT NOT NULL, anchor TEXT NOT NULL,
        descriptor_digest TEXT NOT NULL, PRIMARY KEY(binding,request_id))`);
    });
  }
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void {
    if (db !== this.db || !sameWorldHouse(house, this.house) || actorId !== this.actorId) throw new Error('READINESS_BINDING_MISMATCH');
  }
  /** Fail closed before attempting storage; a transient DB failure must not
   * revive the last successful state in this running resource. */
  invalidate(participationId: string): void {
    opaque(participationId); this.invalidated.add(participationId);
    this.db.execute('INSERT OR IGNORE INTO world_readiness_invalidations(binding,participation_id) VALUES(?,?)', [this.binding, participationId]);
  }
  /** Trusted consumer calls only after all verified facts/policy commits succeed. */
  clearInvalidation(participationId: string): void {
    opaque(participationId);
    this.db.execute('DELETE FROM world_readiness_invalidations WHERE binding=? AND participation_id=?', [this.binding, participationId]);
    this.invalidated.delete(participationId);
  }
  subscriptionFor(participationId: string): popclaw.world.SubscriptionDescriptor | undefined {
    const raw = this.state(participationId)?.subscription;
    return raw ? popclaw.world.SubscriptionDescriptor.decode(raw) : undefined;
  }
  refreshParticipation(actionRequestId: string): string | undefined {
    requestId(actionRequestId);
    return this.db.queryOne<RefreshRow>('SELECT participation_id FROM world_readiness_refreshes WHERE binding=? AND request_id=?', [this.binding, actionRequestId])?.participation_id;
  }
  private state(id: string, db = this.db): StateRow | null {
    opaque(id);
    return db.queryOne<StateRow>('SELECT * FROM world_readiness WHERE binding=? AND participation_id=?', [this.binding, id]);
  }
  private ensure(id: string, tx: HostDb): void {
    opaque(id); tx.execute('INSERT OR IGNORE INTO world_readiness(binding,participation_id) VALUES(?,?)', [this.binding, id]);
  }
  /** Called only after ActionClient verified the full signed result and schemas.
   * A result may establish a subscription/snapshot without making it current. */
  recordResult(result: popclaw.world.IActionResult): { refreshed: boolean } {
    if (!sameWorldHouse(result.house, this.house) || result.actorId !== this.actorId || result.audienceId !== this.actorId) throw new Error('RESULT_BINDING_MISMATCH');
    requestId(result.requestId ?? '');
    if ((result.status ?? 0) < 3) return { refreshed: false };
    return this.db.transaction(tx => {
      const refresh = tx.queryOne<RefreshRow>('SELECT * FROM world_readiness_refreshes WHERE binding=? AND request_id=?', [this.binding, result.requestId!]);
      const id = result.subscription?.participationId || result.participation?.participationId || refresh?.participation_id;
      if (!id) return { refreshed: false };
      if (refresh && refresh.participation_id !== id) throw new Error('RESULT_BINDING_MISMATCH');
      this.ensure(id, tx);
      if (result.subscription && !this.subscription(id, result.subscription, tx)) return { refreshed: false };
      if (result.snapshot) {
        const incoming = result.snapshot, ref = incoming.stateRef ?? '';
        opaque(ref);
        const revision = worldUint64(incoming.stateRevision), core = canonicalWorldCore(popclaw.world.WorldSnapshot, incoming), digest = cidFromCanonical(core);
        const previous = tx.queryOne<SnapshotRow>('SELECT * FROM world_readiness_snapshots WHERE binding=? AND state_ref=?', [this.binding, ref]);
        if (previous && BigInt(revision) < BigInt(previous.revision)) return { refreshed: false };
        if (previous && revision === previous.revision && digest !== previous.digest) throw new Error('SNAPSHOT_REVISION_CONFLICT');
        tx.execute(`INSERT INTO world_readiness_snapshots(binding,state_ref,revision,core,digest) VALUES(?,?,?,?,?)
          ON CONFLICT(binding,state_ref) DO UPDATE SET revision=excluded.revision,core=excluded.core,digest=excluded.digest`, [this.binding, ref, revision, core, digest]);
        const state = this.state(id, tx)!;
        const current = result.status === 3 && !!refresh && refresh.anchor === this.anchor(state)
          && refresh.descriptor_digest === this.descriptorDigest(state);
        // Equal duplicate results cannot erase a successfully refreshed snapshot.
        const keep = previous?.digest === digest && state.snapshot_ref === ref;
        tx.execute('UPDATE world_readiness SET snapshot_ref=?,current_anchor=?,current_digest=?,private_current=0 WHERE binding=? AND participation_id=?',
          [ref, current ? refresh.anchor : keep ? state.current_anchor : null, current ? digest : keep ? state.current_digest : null, this.binding, id]);
        return { refreshed: current };
      }
      return { refreshed: false };
    });
  }
  private subscription(id: string, descriptor: popclaw.world.ISubscriptionDescriptor, tx: HostDb): boolean {
    if (!sameWorldHouse(descriptor.house, this.house) || descriptor.actorId !== this.actorId || descriptor.participationId !== id) throw new Error('SUBSCRIPTION_BINDING_MISMATCH');
    const core = canonicalWorldCore(popclaw.world.SubscriptionDescriptor, descriptor), oldBytes = this.state(id, tx)!.subscription;
    if (oldBytes) {
      const old = popclaw.world.SubscriptionDescriptor.decode(oldBytes);
      if (BigInt(worldUint64(descriptor.descriptorRevision)) < BigInt(worldUint64(old.descriptorRevision))) return false;
      if (worldUint64(descriptor.descriptorRevision) === worldUint64(old.descriptorRevision)) {
        if (cidFromCanonical(core) !== cidFromCanonical(oldBytes)) throw new Error('DESCRIPTOR_REVISION_CONFLICT');
        return true;
      }
    }
    tx.execute('UPDATE world_readiness SET subscription=?,observation=NULL,current_anchor=NULL,private_current=0 WHERE binding=? AND participation_id=?', [core, this.binding, id]);
    return true;
  }
  /** Verified state-class descriptors can establish current unscoped facts.
   * Once a subscription exists, private arrival cannot bypass its replay gate. */
  recordPrivateDescriptor(participationId: string): void {
    this.db.transaction(tx => {
      this.ensure(participationId, tx);
      tx.execute('UPDATE world_readiness SET private_current=1 WHERE binding=? AND participation_id=?', [this.binding, participationId]);
    });
  }
  private descriptorDigest(state: StateRow): string { return cidFromCanonical(state.subscription ?? new Uint8Array()); }
  private anchor(state: StateRow): string | null { return state.subscription ? this.stream.replayAnchor() : 'unscoped'; }
  /** Called in ActionAuthority.record's transaction AFTER the local read-state
   * grant and captured session checks. A label such as purpose=snapshot does
   * not call this by itself; the coordinator supplies the authorization. */
  recordRefresh(tx: HostDb, participationId: string, actionRequestId: string): void {
    if (tx !== this.db) throw new Error('READINESS_DATABASE_MISMATCH');
    requestId(actionRequestId); this.ensure(participationId, tx);
    const state = this.state(participationId, tx)!, anchor = this.anchor(state);
    if (!anchor || (state.subscription && !this.publicationReady(state))) throw new Error('WORLD_REPLAY_NOT_READY');
    const old = tx.queryOne<RefreshRow>('SELECT * FROM world_readiness_refreshes WHERE binding=? AND request_id=?', [this.binding, actionRequestId]);
    if (old) {
      if (old.participation_id !== participationId) throw new Error('REFRESH_REQUEST_CONFLICT');
      // Original refresh attempt cannot acquire a newer catch-up anchor on retry.
      return;
    }
    tx.execute('INSERT INTO world_readiness_refreshes(binding,request_id,participation_id,anchor,descriptor_digest) VALUES(?,?,?,?,?)',
      [this.binding, actionRequestId, participationId, anchor, this.descriptorDigest(state)]);
  }
  /** Fresh-query-bound observation, independently authenticated from the
   * immutable action. Old descriptor observations never replace the current one. */
  acceptObservation(bytes: Uint8Array, query: { requestId: string; nonce: string; result: popclaw.world.IActionResult; capabilities: TrustedWorldCapabilities }): void {
    const observation = verifySubscriptionObservation(bytes, query);
    if (!sameWorldHouse(observation.house, this.house) || observation.actorId !== this.actorId) throw new Error('OBSERVATION_BINDING_MISMATCH');
    const descriptor = query.result.subscription!;
    const core = canonicalWorldCore(popclaw.world.SubscriptionObservation, observation);
    this.db.transaction(tx => {
      const id = descriptor.participationId ?? '', state = this.state(id, tx);
      if (!state?.subscription) throw new Error('SUBSCRIPTION_NOT_INSTALLED');
      if (cidFromCanonical(state.subscription) !== cidFromCanonical(canonicalWorldCore(popclaw.world.SubscriptionDescriptor, descriptor))) return;
      if (state.observation) {
        const old = popclaw.world.SubscriptionObservation.decode(state.observation);
        if (BigInt(worldUint64(observation.observationRevision)) < BigInt(worldUint64(old.observationRevision))) return;
        if (worldUint64(observation.observationRevision) === worldUint64(old.observationRevision) && cidFromCanonical(core) !== cidFromCanonical(state.observation)) throw new Error('SUBSCRIPTION_OBSERVATION_CONFLICT');
        if (old.publicationState === 'published' && observation.publicationState === 'waiting_publication') throw new Error('PUBLICATION_ROLLBACK');
      }
      tx.execute('UPDATE world_readiness SET observation=? WHERE binding=? AND participation_id=?', [core, this.binding, id]);
    });
  }
  private publicationReady(state: StateRow): boolean {
    if (!state.subscription) return true;
    if (!state.observation) return false;
    const subscription = popclaw.world.SubscriptionDescriptor.decode(state.subscription), observation = popclaw.world.SubscriptionObservation.decode(state.observation);
    if (observation.publicationState !== 'published' || observation.logIncarnation !== subscription.logIncarnation
      || this.stream.status().logIncarnation !== subscription.logIncarnation || !this.stream.status().caughtUp) return false;
    const cursors = new Map(this.stream.cursorVector().map(c => [c.scopeId!, BigInt(worldUint64(c.afterSeq))]));
    return subscription.scopes.every(scope => cursors.has(scope)) && observation.publishedThrough.every(mark =>
      cursors.has(mark.scopeId ?? '') && cursors.get(mark.scopeId ?? '')! >= BigInt(worldUint64(mark.throughSeq)));
  }
  view(participationId: string): WorldReadinessView {
    const view = this.evidenceView(participationId);
    if (this.invalidated.has(participationId) || this.db.queryOne('SELECT 1 FROM world_readiness_invalidations WHERE binding=? AND participation_id=?', [this.binding, participationId])) return { ...view, ready: false, phase: 'state_missing', snapshot_stale: true };
    return view;
  }
  private evidenceView(participationId: string): WorldReadinessView {
    const state = this.state(participationId);
    const base: WorldReadinessView = { participation_id: participationId, ready: false, canRefresh: false, phase: 'state_missing', snapshot_stale: true };
    if (!state) return { ...base, canRefresh: true };
    base.canRefresh = !!this.anchor(state) && this.publicationReady(state);
    const row = state.snapshot_ref ? this.db.queryOne<SnapshotRow>('SELECT * FROM world_readiness_snapshots WHERE binding=? AND state_ref=?', [this.binding, state.snapshot_ref]) : null;
    if (row) base.snapshot = popclaw.world.WorldSnapshot.decode(row.core);
    if (state.observation) base.publication = popclaw.world.SubscriptionObservation.decode(state.observation);
    if (state.subscription) {
      if (!base.publication || base.publication.publicationState === 'waiting_publication') return { ...base, phase: 'waiting_publication' };
      if (base.publication.publicationState === 'failed') return { ...base, phase: 'publication_failed' };
      if (!this.publicationReady(state)) return { ...base, phase: 'replaying' };
    }
    if (!state.subscription && state.private_current) return { ...base, ready: true, phase: 'ready',
      snapshot_stale: !base.snapshot || !state.current_anchor || state.current_anchor !== this.anchor(state) || state.current_digest !== row?.digest };
    if (!base.snapshot) return base;
    if (!state.current_anchor || state.current_anchor !== this.anchor(state) || state.current_digest !== row?.digest) return { ...base, phase: 'snapshot_stale' };
    return { ...base, ready: true, phase: 'ready', snapshot_stale: false };
  }
}
