import { recordJoinedGuide } from '../../world/house-guide-context.js';
import type { HouseParticipationAdmissionPort, HouseParticipationReceipt } from './participation-admission.js';
import { stageParticipationPlan, recordParticipationReceipt, entryDigest } from './participation-journal.js';
import { houseRecoveryHeld } from '../../world/house-recovery-fence.js';
import { pinnedBinding } from '../../world/house-binding-pin.js';
import { readVerifiedDeclaration, declarationFingerprint } from '../../world/house-read-declaration.js';

import { storageDatabasePathAllowed, storageDatabaseGeneration } from '../../host/storage-maintenance.js';
import { captureLegacyTrust, legacyTrustCurrent, type LegacyTrustCapture } from './legacy-trust.js';
import { emptyControlState, neverControlSubset, configuredControlSubset, unstartedSessionlessHistory } from './legacy-history.js';

import type { HostDb } from '../../host/host-db.js';

import {
  fetchSessionBoard, fetchSessionManifest, type SessionManifest, LifecycleNetworkError,
  HouseSessionControlClient, newRequestId, normalizeHouseOrigin,
  type ControlAck, type LifecycleFetch, type ControlSigner,
} from './control-client.js';
import { commitLocalLogin, markEnterFailure, markEnterOutcome, readParticipation, type ParticipationRow, restoreLegacyLane } from './participation-store.js';

import type { LoginAuthority, LoginResult, ManagerOptions } from './manager.js';
import { composeFlightSignal } from './flight-signal.js';

interface LoginAttemptAuthority {
  ownerBound: () => boolean;
  baselineSeq: number;
  baselineDesired: string;
  /** Initial normalized selection, including an explicitly empty pin. */
  configuredPin: string;
  intentUnchanged: () => boolean;
  flight: AbortController;
  authorized: () => boolean;
  releaseLogoutFence: () => void;
  /** Present only when an explicit, still-valid owner command is being
   *  executed. Absent on background resume — see `loginHouse`. */
  authority?: LoginAuthority;
}

/** Stable composition inputs; no manager state or mutable flight maps cross this boundary. */
export interface LoginDependencies {
  db: HostDb;
  installationId: string;
  signer: ControlSigner;
  fetchImpl: LifecycleFetch;
  clock: () => number;
  configuredPinFor: (origin: string) => string;
  legacyRecoveryConfigured: (origin: string) => boolean;
  participation: HouseParticipationAdmissionPort | undefined;
  actorId: string | undefined;
  prepareTrustedManifest: ManagerOptions['prepareTrustedManifest'];
  revokeTrustedManifest: ManagerOptions['revokeTrustedManifest'];
  prepareRelationBinding: ManagerOptions['prepareRelationBinding'];
  onRelationBindingRefused: ManagerOptions['onRelationBindingRefused'];
}

/** The manager retains durable authority, local fences, gates, and the shared drain. */
export interface LoginLifecycle {
  captureAuthority(): { authorized: () => boolean; ownerBound: () => boolean };
  captureLogoutRelease(origin: string, authority: LoginAuthority | undefined, direct: boolean, authorized: () => boolean): () => void;
  ownerEpoch(): number | null;
  signals(): { stop: AbortSignal; pause: AbortSignal };
  openGate(origin: string): void;
  closeGate(origin: string): void;
  gateActive(origin: string): boolean;
  isConfiguredParticipation(origin: string): boolean;
  legacyParticipationTrustCurrent(origin: string, trust: LegacyTrustCapture | undefined, configured?: boolean): boolean;
  trackTask(origin: string, operation: Promise<LoginResult>): void;
}

const OUTCOME = { Entered: 1, AlreadyEntered: 2, Rejected: 7 } as const;
export const ERROR_CODE_NAMES: Record<number, string> = {
  1: 'INVALID_HOUSE',
  2: 'HOUSE_LIFECYCLE_UNSUPPORTED',
  3: 'HOUSE_DISABLED',
  4: 'EXECUTOR_BUSY',
  5: 'STALE_OPERATION',
  6: 'SESSION_FENCED',
  7: 'LEASE_EXPIRED',
  8: 'AUTH_INVALID',
  9: 'AUDIENCE_MISMATCH',
  10: 'IDEMPOTENCY_CONFLICT',
  11: 'PERSISTENCE_FAILED',
  12: 'ACTION_RESULT_UNKNOWN',
};

/** Owns complete login operations, including refresh and configured admission. */
export class HouseLoginExecution {
  private readonly loginFlights = new Map<string, AbortController>();
  private readonly db: HostDb;
  private readonly installationId: string;
  private readonly signer: ControlSigner;
  private readonly fetchImpl: LifecycleFetch;
  private readonly clock: () => number;
  private readonly configuredPinFor: (origin: string) => string;
  private readonly legacyRecoveryConfigured: (origin: string) => boolean;
  private readonly participation: LoginDependencies['participation'];
  private readonly actorId: LoginDependencies['actorId'];
  private readonly prepareTrustedManifest: LoginDependencies['prepareTrustedManifest'];
  private readonly revokeTrustedManifest: LoginDependencies['revokeTrustedManifest'];
  private readonly prepareRelationBinding: LoginDependencies['prepareRelationBinding'];
  private readonly onRelationBindingRefused: LoginDependencies['onRelationBindingRefused'];
  constructor(deps: LoginDependencies, private readonly lifecycle: LoginLifecycle) {
    this.db = deps.db;
    this.installationId = deps.installationId;
    this.signer = deps.signer;
    this.fetchImpl = deps.fetchImpl;
    this.clock = deps.clock;
    this.configuredPinFor = deps.configuredPinFor;
    this.legacyRecoveryConfigured = deps.legacyRecoveryConfigured;
    this.participation = deps.participation;
    this.actorId = deps.actorId;
    this.prepareTrustedManifest = deps.prepareTrustedManifest;
    this.revokeTrustedManifest = deps.revokeTrustedManifest;
    this.prepareRelationBinding = deps.prepareRelationBinding;
    this.onRelationBindingRefused = deps.onRelationBindingRefused;
  }

  cancel(origin: string, reason: Error): void { this.loginFlights.get(origin)?.abort(reason); }
  cancelAll(reason: Error): void {
    for (const flight of this.loginFlights.values()) flight.abort(reason);
    this.loginFlights.clear();
  }
  hasFlight(origin: string): boolean { return this.loginFlights.has(origin); }
  private nowSecs(): number { return Math.floor(this.clock() / 1000); }
  private configuredControlAbsent(origin: string, row: ParticipationRow | null): boolean {
    return !!row && row.installation_id === this.installationId && row.pending_enter_request_id === null
      && configuredControlSubset(this.db, origin, row);
  }
  async login(input: string, authority: LoginAuthority | undefined, direct: boolean): Promise<LoginResult> {
    const origin = normalizeHouseOrigin(input);
    const { authorized, ownerBound } = this.lifecycle.captureAuthority();
    if (houseRecoveryHeld(this.db, origin)) return {scope:'local_installation',origin,status:'connecting',sessionId:'',errorCode:'AUTH_INVALID'};
    if (!authorized()) return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    const now = this.nowSecs();
    const releaseLogoutFence = this.lifecycle.captureLogoutRelease(origin, authority, direct, authorized);

    const existing = readParticipation(this.db, origin);
    // Connected fastpath is lease-checked AND pin-checked (finding 5): a
    // durable key that no longer matches the operator's configured pin must
    // not be reused — the fastpath would silently bypass the pin. Fall
    // through to the full path, where the pin mismatch is an explicit
    // AUTH_INVALID.
    const configuredPinEarly = this.configuredPinFor(origin);
    if (
      existing?.desired === 'enabled' &&
      existing.phase === 'connected' &&
      existing.session_id &&
      existing.lease_expires_at > now &&
      (!configuredPinEarly || existing.ack_key_hex === configuredPinEarly)
    ) {
      if (this.prepareTrustedManifest) return this.refreshConnectedManifest(origin, existing, authorized, releaseLogoutFence);
      releaseLogoutFence();
      this.lifecycle.openGate(origin);
      return { scope: 'local_installation', origin, status: 'connected', sessionId: existing.session_id };
    }

    // Intent snapshot BEFORE any await (review counter-examples 1+2): a
    // logout landing while this call awaits discovery/signing must stop the
    // login from re-enabling the row afterwards. The snapshot is checked
    // after every await, and commitLocalLogin only applies when the row
    // still matches it (CAS) — cross-process changes abort this login too.
    const baseline = readParticipation(this.db, origin);
    if (!direct && baseline?.desired !== 'enabled') {
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    }
    const baselineSeq = baseline?.op_seq ?? 0;
    const baselineDesired = baseline?.desired ?? 'disabled';
    const intentUnchanged = () => {
      const rowNow = readParticipation(this.db, origin);
      if (!rowNow) return baselineSeq === 0 && baselineDesired === 'disabled';
      return rowNow.op_seq === baselineSeq && rowNow.desired === baselineDesired;
    };

    // Per-call in-flight abort: logoutHouse aborts it, closing the door even
    // for a fetch already in the air (the signal rides the request).
    const flight = new AbortController();
    const prevFlight = this.loginFlights.get(origin);
    prevFlight?.abort(new Error('superseded by a new login call'));
    this.loginFlights.set(origin, flight);
    const register = <T>(p: Promise<T>): Promise<T> =>
      p.finally(() => {
        if (this.loginFlights.get(origin) === flight) this.loginFlights.delete(origin);
      });
    const result = register(this.runAttempt(origin, now, { baselineSeq, baselineDesired, configuredPin: configuredPinEarly, ownerBound, intentUnchanged, flight, authorized, releaseLogoutFence, ...(authority ? { authority } : {}) }));
    this.lifecycle.trackTask(origin, result);
    return result;
  }

  /** Explicit repeated login refreshes only authenticated manifest selection.
   * The coordinator fences and joins the old public resource before activating
   * the replacement. Session identity and the execution fence are unchanged. */
  private refreshConnectedManifest(origin: string, baseline: ParticipationRow, authorized: () => boolean, releaseLogoutFence: () => void): Promise<LoginResult> {
    const flight = new AbortController();
    this.loginFlights.get(origin)?.abort(new Error('superseded by explicit manifest refresh'));
    this.loginFlights.set(origin, flight);
    const current = () => {
      const row = readParticipation(this.db, origin);
      return !flight.signal.aborted && authorized() && row?.desired === 'enabled' && row.phase === 'connected'
        && row.op_seq === baseline.op_seq && row.session_id === baseline.session_id && row.ack_key_hex === baseline.ack_key_hex
        && row.lease_expires_at > this.nowSecs();
    };
    const pending: LoginResult = { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    const run = (async (): Promise<LoginResult> => {
      try {
        const signal = composeFlightSignal(flight.signal, this.lifecycle.signals().stop, this.lifecycle.signals().pause);
        const manifest = await fetchSessionManifest(origin, this.fetchImpl, signal);
        if (!current()) return pending;
        const configured = this.configuredPinFor(origin), pin = baseline.ack_key_hex;
        if (!pin || (configured && configured !== pin) || (manifest.board && manifest.board.ack_pubkey !== pin))
          throw new Error('HOUSE_PIN_MISMATCH');
        const prepared = await this.prepareTrustedManifest!({ origin, rawBytes: manifest.rawBytes,
          proofHeader: manifest.proofHeader, ackKeyHex: pin, provenance: configured ? 'configured_pin' : 'persisted_pin', signal });
        const selected = this.db.transaction(tx => {
          if (!current()) return false;
          const currentPin = this.configuredPinFor(origin);
          if (currentPin && currentPin !== pin) throw new Error('HOUSE_PIN_MISMATCH');
          prepared.commit(tx);
          return true;
        });
        if (!selected) return pending;
        releaseLogoutFence();
        this.lifecycle.openGate(origin);
        return { scope: 'local_installation', origin, status: 'connected', sessionId: baseline.session_id };
      } catch (error) {
        if (current()) {
          this.lifecycle.closeGate(origin);
          this.db.transaction(tx => {
            if (!current()) return;
            this.revokeTrustedManifest?.(tx, origin, 'MANIFEST_REFRESH_INVALID');
            tx.execute(`UPDATE house_participation SET phase='connecting',remote_status='error',remote_error=?,updated_at=?
              WHERE house_origin=? AND op_seq=? AND session_id=? AND desired='enabled'`,
              [error instanceof Error ? error.message.slice(0, 256) : 'MANIFEST_REFRESH_INVALID', this.nowSecs(), origin, baseline.op_seq, baseline.session_id]);
          });
        }
        return { ...pending, errorCode: 'AUTH_INVALID' };
      } finally {
        if (this.loginFlights.get(origin) === flight) this.loginFlights.delete(origin);
      }
    })();
    this.lifecycle.trackTask(origin, run);
    return run;
  }

  private async admitSessionless(origin: string, manifest: SessionManifest, baseline: ParticipationRow | null,
    ctx: {authority?: LoginAuthority; ownerBound: () => boolean; flight: AbortController; authorized: () => boolean; intentUnchanged: () => boolean; releaseLogoutFence: () => void}): Promise<LoginResult> {
    const pending = (code: string): LoginResult => ({scope:'local_installation',origin,status:'connecting',sessionId:'',errorCode:code});
    const source = ctx.authority?.participationSource;
    const port = this.participation!;
    const trust = captureLegacyTrust(this.db, origin);
    if (baseline?.desired === 'enabled' && baseline.phase === 'connected' && emptyControlState(baseline)
      && baseline.pending_enter_request_id === null && trust?.binding && this.lifecycle.legacyParticipationTrustCurrent(origin, trust)) {
      // A background confirmation may reuse the selected sessionless lane,
      // but only an explicit owner command may refresh what this House has
      // declared. Keep the durable participation tuple unchanged: the
      // coordinator will compare the refreshed capability key, drain the old
      // public receiver, and open the replacement from cursor zero.
      if (ctx.authority && ctx.ownerBound()) {
        if (!this.prepareRelationBinding) return pending('HOUSE_BINDING_PREPARER_REQUIRED');
        const signal = composeFlightSignal(ctx.flight.signal, this.lifecycle.signals().stop, this.lifecycle.signals().pause);
        const expected = JSON.stringify(baseline);
        const configuration = this.configuredPinFor(origin);
        const storageGeneration = storageDatabaseGeneration(this.db);
        const current = () => !signal.aborted && ctx.authorized() && ctx.intentUnchanged()
          && JSON.stringify(readParticipation(this.db, origin)) === expected
          && this.lifecycle.legacyParticipationTrustCurrent(origin, trust)
          && this.configuredPinFor(origin) === configuration
          && storageDatabasePathAllowed(this.db, 'execution') && storageDatabasePathAllowed(this.db, 'consumers')
          && storageDatabaseGeneration(this.db) === storageGeneration;
        try {
          const prepared = await this.prepareRelationBinding({ origin, rawBytes: new Uint8Array(manifest.rawBytes),
            proofHeader: manifest.proofHeader, signal });
          if (!current()) return pending('STALE_OPERATION');
          const committed = this.db.transaction(tx => {
            if (!current()) return false;
            const refusal = prepared.commit(tx);
            if (refusal !== undefined) throw new Error(refusal);
            return true;
          });
          if (!committed) return pending('STALE_OPERATION');
        } catch (error) {
          if (current()) this.onRelationBindingRefused?.(origin, error instanceof Error ? error.message : 'MANIFEST_REFRESH_INVALID');
          return pending(error instanceof Error ? error.message : 'MANIFEST_REFRESH_INVALID');
        }
      }
      ctx.releaseLogoutFence(); this.lifecycle.openGate(origin);
      return {scope:'local_installation',origin,status:'unsupported',sessionId:'',admission:'configured',legacyAvailable:true};
    }
    if (!source || source.origin !== origin || source.installationId !== this.installationId) return pending('HOUSE_PARTICIPATION_AUTHORITY_REQUIRED');
    if (!this.prepareRelationBinding) return pending('HOUSE_BINDING_PREPARER_REQUIRED');
    const commands = this.db.queryAll<Record<string,unknown>>('SELECT * FROM house_lifecycle_commands WHERE house_origin=? ORDER BY created_at,request_id',[origin]);
    const leaves = this.db.queryAll<Record<string,unknown>>('SELECT * FROM house_lifecycle_outbox WHERE house_origin=? ORDER BY created_at,request_id',[origin]);
    const selectedSessionBoard = !!(trust?.binding && readVerifiedDeclaration(this.db, pinnedBinding(this.db,origin)!)?.sessionBoard);
    if (selectedSessionBoard || (baseline && (!emptyControlState(baseline) || baseline.installation_id !== this.installationId)))
      return pending('HOUSE_CONTROL_HISTORY_NOT_SESSIONLESS');
    // Existing unsupported pending controls require the known host's positive
    // unsent assessment. Empty tokens or an error string are not that proof.
    const nativeKnown = baseline ? baseline.pending_enter_request_id === null && configuredControlSubset(this.db,origin,baseline)
      : commands.every(c => c.kind === 'status' || c.request_id === ctx.authority?.requestId) && leaves.length === 0;
    const retryHistory = !port.assessHistory && !baseline && !nativeKnown && !!ctx.authority?.requestId
      && source.actorId === this.actorId && unstartedSessionlessHistory(this.db,source,ctx.authority.requestId);
    if (!(port.assessHistory ? port.assessHistory(origin,{participation:baseline,commands,leaves,selectedSessionBoard}) : nativeKnown || retryHistory))
      return pending('HOUSE_CONTROL_HISTORY_UNPROVEN');
    const signal = composeFlightSignal(ctx.flight.signal,this.lifecycle.signals().stop,this.lifecycle.signals().pause);
    const expected = JSON.stringify(baseline);
    const evidence = JSON.stringify({commands,leaves,selectedSessionBoard});
    const configuration = this.configuredPinFor(origin);
    const storageGeneration = storageDatabaseGeneration(this.db);
    let plan: ReturnType<typeof stageParticipationPlan> | undefined;
    let receivedPermit = false;
    let receipt: HouseParticipationReceipt | undefined;
    try {
      const prepared = await this.prepareRelationBinding({origin,rawBytes:new Uint8Array(manifest.rawBytes),proofHeader:manifest.proofHeader,signal});
      const current = () => !signal.aborted && ctx.authorized() && ctx.intentUnchanged()
        && JSON.stringify(readParticipation(this.db,origin)) === expected && this.configuredPinFor(origin) === configuration
        && storageDatabasePathAllowed(this.db,'execution') && storageDatabasePathAllowed(this.db,'consumers')
        && storageDatabaseGeneration(this.db) === storageGeneration
        && JSON.stringify({commands:this.db.queryAll('SELECT * FROM house_lifecycle_commands WHERE house_origin=? ORDER BY created_at,request_id',[origin]),
          leaves:this.db.queryAll('SELECT * FROM house_lifecycle_outbox WHERE house_origin=? ORDER BY created_at,request_id',[origin]),selectedSessionBoard}) === evidence
        && (!retryHistory || unstartedSessionlessHistory(this.db,source,ctx.authority!.requestId,plan));
      if (!current()) return pending('STALE_OPERATION');
      const beforeOpSeq = baseline?.op_seq ?? 0, afterOpSeq = beforeOpSeq + 1;
      plan = stageParticipationPlan(this.db,source,{expectedParticipationJson:expected,controlEvidenceJson:evidence,
        manifestDigest:entryDigest(Buffer.from(manifest.rawBytes).toString('base64')),
        bindingDigest:entryDigest({origin,manifest:Buffer.from(manifest.rawBytes).toString('base64'),proof:manifest.proofHeader}),
        configurationDigest:entryDigest(configuration),ownerGeneration:this.lifecycle.ownerEpoch(),
        storageGeneration:entryDigest(storageGeneration),
        beforeOpSeq,afterOpSeq,transitionDigest:entryDigest({origin,installationId:this.installationId,desired:'enabled',phase:'connected',beforeOpSeq,afterOpSeq})});
      const deadlineAtMs = this.clock() + 30_000;
      const decision = await port.admit(plan,{signal,deadlineAtMs});
      if (decision.status !== 'permitted') return pending(decision.status === 'denied' ? decision.code : 'HOUSE_ADMISSION_UNRESOLVED');
      receivedPermit = true;
      // LocalHostDb.transaction uses BEGIN IMMEDIATE. All final checks follow
      // that real write lock; there is no await between permit and receipt.
      this.db.transaction(tx => {
        if (this.clock() >= deadlineAtMs || !current()) throw new Error('STALE_OPERATION');
        const p = plan!;
        if (p.reason === 'initial_me_setup' && tx.queryOne<{state:string}>(`SELECT state FROM house_initial_setup WHERE actor_id=? AND installation_id=?`,[p.actorId,p.installationId])?.state !== 'pending')
          throw new Error('HOUSE_SETUP_ALREADY_RESOLVED');
        decision.permit.beforeCommit(tx,p);
        const refusal = prepared.commit(tx);
        if (refusal !== undefined) throw new Error(refusal);
        // Explicit local join has no invented server ACK, token or pending ENTER.
        tx.execute(`INSERT INTO house_participation (house_origin,installation_id,op_seq,desired,phase,updated_at)
          VALUES (?,?,?,'enabled','connected',?) ON CONFLICT(house_origin) DO UPDATE SET
          installation_id=excluded.installation_id,op_seq=excluded.op_seq,desired='enabled',phase='connected',pending_enter_request_id=NULL,
          remote_status='unsupported',remote_error='no house_session board',updated_at=excluded.updated_at`,[origin,this.installationId,afterOpSeq,this.nowSecs()]);
        recordJoinedGuide(tx, {origin, opSeq: afterOpSeq, rawBytes: manifest.rawBytes, manifestDigest: p.manifestDigest});
        receipt = recordParticipationReceipt(tx,p,this.clock());
      });
      ctx.releaseLogoutFence(); this.lifecycle.closeGate(origin); this.lifecycle.openGate(origin);
      await port.settle(plan.attemptRef,{status:'committed',receipt:receipt!}).catch(() => {});
      return {scope:'local_installation',origin,status:'unsupported',sessionId:'',admission:'configured',legacyAvailable:this.lifecycle.gateActive(origin)};
    } catch (error) {
      if (plan && receivedPermit && !receipt) {
        this.db.execute(`UPDATE house_participation_attempts SET state='not_committed' WHERE attempt_ref=? AND state='prepared'`,[plan.attemptRef]);
        await port.settle(plan.attemptRef,{status:'not_committed',detail:'synchronous SQLite rollback'}).catch(() => {});
      }
      return pending(error instanceof Error ? error.message : 'HOUSE_ADMISSION_FAILED');
    }
  }

  private async runAttempt(
    origin: string,
    now: number,
    ctx: LoginAttemptAuthority,
  ): Promise<LoginResult> {
    const { flight, intentUnchanged, authorized } = ctx;
    const {
      priorRow, hadLegacyLane, recoveryTrust, configuredSelectionCurrent, recoveryCandidate,
      configuredBaseline, configuredScopeAtStart, configuredDeclarationCurrent,
      previouslySelectedSession, configuredControlFacts, configuredCandidate, originalPending, recoveryCurrent,
    } = this.captureHistory(origin, ctx);

    // Trusted discovery first: the manifest board's key exists BEFORE the
    // ENTER is sent and persists in the same transaction as the login intent
    // (review B). Discovery failures split in two: unreachable
    // (LifecycleNetworkError) -> the intent is still committed
    // (desired=enabled/connecting, discovery unknown) and later retries
    // re-discover — "cannot connect" is neither "invalid address" nor a
    // reason to drop the intent; house absent/invalid response ->
    // INVALID_HOUSE, fails now and stores no intent.
    let board: Awaited<ReturnType<typeof fetchSessionBoard>> = null;
    // Per-CALL discovery state (probe 4): a field would leak across houses —
    // A's successful discovery cannot make B's network failure look like a
    // probed-legacy house.
    let discoveryReached = false;
    let discoveredManifest: SessionManifest | null = null;
    const persistedPinBeforeDiscovery = readParticipation(this.db, origin)?.ack_key_hex;
    try {
      discoveredManifest = await fetchSessionManifest(origin, this.fetchImpl, composeFlightSignal(flight.signal, this.lifecycle.signals().stop));
      board = discoveredManifest.board;
      discoveryReached = true;
    } catch (err) {
      if (err instanceof LifecycleNetworkError && !flight.signal.aborted) {
        // fall through with board = null (network window)
      } else if (flight.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
      } else {
        throw new Error(`INVALID_HOUSE: ${String(err)}`, { cause: err });
      }
    }
    if (flight.signal.aborted || !authorized() || !intentUnchanged()
      || (recoveryCandidate && !recoveryCurrent(originalPending, ctx.baselineSeq))) {
      // A logout (or another op) landed during the discovery await — this
      // call must NOT re-enable the house.
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    }
    // The trusted host source authorizes this local transaction, independently
    // of the optional remote session protocol. No optimistic enabled row is written.
    if (this.participation && !board) {
      if (!discoveryReached || discoveredManifest?.sessionBoardAbsent !== true)
        return {scope:'local_installation',origin,status:'connecting',sessionId:'',errorCode:'HOUSE_MANIFEST_UNAVAILABLE'};
      return this.admitSessionless(origin, discoveredManifest, priorRow, ctx);
    }
    // After OUR commit the invariant flips: the row must stay at this login's
    // (op_seq, enabled) — checked before the ENTER is sent and again after
    // the ack arrives (the login itself changed the row, so the pre-login
    // baseline no longer applies).
    const unchangedSinceCommit = () => {
      const rowNow = readParticipation(this.db, origin);
      return authorized() && !!rowNow && rowNow.desired === 'enabled' && rowNow.op_seq === opSeq;
    };
    // The trusted key that persists with the intent: the operator's pin if
    // one exists (pin knowledge does not depend on discovery reaching the
    // house), else the persisted pin, else the discovered session board key
    // under the existing TOFU rule, else '' (unknown).
    const recovering = recoveryCandidate && discoveredManifest?.sessionBoardAbsent === true;
    // A relation pin is not a session ACK key, including a manifest-only
    // outage. Preserve real control evidence or a positively selected board,
    // but never invent ACK authority for the configured sessionless subset.
    const trustedKey = configuredControlFacts && !board && !previouslySelectedSession
      ? persistedPinBeforeDiscovery || '' : this.configuredPinFor(origin) || persistedPinBeforeDiscovery || board?.ack_pubkey || '';

    const requestId = newRequestId();
    // Owner authority and intent CAS share the write lock. Another process
    // cannot acquire a new epoch between this check and the intent write.
    const committed = this.db.transaction(tx => {
      if (flight.signal.aborted || !authorized() || !intentUnchanged()
        || (configuredScopeAtStart && (!this.lifecycle.isConfiguredParticipation(origin) || JSON.stringify(readParticipation(tx, origin)) !== configuredBaseline || (configuredCandidate && !configuredDeclarationCurrent())))
        || (recoveryCandidate && !recoveryCurrent(originalPending, ctx.baselineSeq))) return null;
      return commitLocalLogin(
      tx,
      origin,
      this.installationId,
      requestId,
      now,
      trustedKey,
      // CAS: only when the row still matches the pre-await snapshot.
      { opSeq: ctx.baselineSeq, desired: ctx.baselineDesired as 'enabled' | 'disabled' },
      );
    });
    if (!committed || committed.mode === 'aborted') {
      // Lost the race against a concurrent change — never re-enabled.
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    }
    const { opSeq, mode, ackKeyHex, pendingEnterRequestId } = committed;
    const fail = (status: 'error' | 'unsupported', error: string, settled = false): void => {
      this.db.transaction(tx => {
        if (!flight.signal.aborted && unchangedSinceCommit()) {
          markEnterFailure(tx, origin, opSeq, status, error, now, settled);
        }
      });
    };
    const configuredCommitBaseline = JSON.stringify(readParticipation(this.db, origin));
    const effectiveRequestId = mode === 'reuse-pending' && pendingEnterRequestId ? pendingEnterRequestId : requestId;

    // Configured pin beats everything (handoff §18:26): the board must
    // advertise EXACTLY the pinned key; anything else fails closed — a
    // re-keyed or hostile house cannot override the operator's pin, and TOFU
    // never applies to a pinned origin.
    const configuredPin = this.configuredPinFor(origin);
    const pinConflict = (board && configuredPin && board.ack_pubkey !== configuredPin)
      || (board && ackKeyHex && ackKeyHex !== board.ack_pubkey);
    if (pinConflict) {
      return this.rejectPinConflict(origin, now, opSeq, board!, configuredPin, flight, unchangedSinceCommit);
    }
    // The relation binding, before the world preparer: it needs no board, so
    // it is the only one a board-less house can reach at all. A refusal here
    // is not fatal to the login — the house still carries mail and the world
    // path is judged on its own terms — but it must be SAID, never swallowed
    // into a quieter path that looks like "this house has no relations".
    let relationCommitted = false;
    let relationRefused = false;
    if (this.prepareRelationBinding && discoveredManifest && ctx.authority) {
      try {
        const prepared = await this.prepareRelationBinding({
          origin,
          rawBytes: new Uint8Array(discoveredManifest.rawBytes),
          proofHeader: discoveredManifest.proofHeader,
          signal: composeFlightSignal(flight.signal, this.lifecycle.signals().stop, this.lifecycle.signals().pause),
        });
        // The refusal travels OUT of the transaction, not through it. A
        // throw would roll back a block this very commit may have written,
        // and a block is the one refusal that has to outlive the round.
        let refusal: string | undefined;
        this.db.transaction(tx => {
          if (flight.signal.aborted || !unchangedSinceCommit() || !configuredSelectionCurrent()
            || (configuredScopeAtStart && (!this.lifecycle.isConfiguredParticipation(origin) || JSON.stringify(readParticipation(tx, origin)) !== configuredCommitBaseline || (configuredCandidate && !configuredDeclarationCurrent())))
            || (recovering && !recoveryCurrent(pendingEnterRequestId, opSeq))) return;
          refusal = prepared.commit(tx);
          // Keep any security block the commit records; a refusal does not
          // throw and roll it back. Only successful confirmation qualifies.
          relationCommitted = refusal === undefined;
          relationRefused = refusal !== undefined;
        });
        if (refusal !== undefined) this.onRelationBindingRefused?.(origin, refusal);
      } catch (err) {
        // Not fatal to the login: the house still carries mail, and the world
        // path is judged on its own terms. But it is never quiet.
        relationRefused = true;
        this.onRelationBindingRefused?.(origin, String(err));
      }
    }
    if (this.prepareTrustedManifest && discoveredManifest && ackKeyHex) {
      try {
        const prepared = await this.prepareTrustedManifest({origin,
          rawBytes: new Uint8Array(discoveredManifest.rawBytes), proofHeader: discoveredManifest.proofHeader,
          ackKeyHex,
          provenance: configuredPin ? 'configured_pin' : persistedPinBeforeDiscovery ? 'persisted_pin'
            : origin.startsWith('https:') ? 'https_tofu' : 'loopback_fixture',
          signal: composeFlightSignal(flight.signal, this.lifecycle.signals().stop)});
        this.db.transaction(tx => {
          if (flight.signal.aborted || !unchangedSinceCommit()) return;
          const currentPin = this.configuredPinFor(origin);
          const currentRow = readParticipation(tx, origin);
          if ((currentPin && currentPin !== ackKeyHex) || currentRow?.ack_key_hex !== ackKeyHex) {
            throw new Error('trusted manifest pin changed during preparation');
          }
          prepared.commit(tx);
        });
      } catch {
        if (!flight.signal.aborted && unchangedSinceCommit()) {
          this.lifecycle.closeGate(origin);
          this.db.transaction(tx => {
            if (flight.signal.aborted || !unchangedSinceCommit()) return;
            this.revokeTrustedManifest?.(tx, origin, 'MANIFEST_TRUST_INVALID');
            markEnterFailure(tx, origin, opSeq, 'error', 'trusted manifest validation failed', now);
          });
        }
        return {scope: 'local_installation', origin, status: 'connecting', sessionId: '', errorCode: 'AUTH_INVALID'};
      }
    }
    if (discoveredManifest && !ackKeyHex) this.db.transaction(tx => {
      if (!flight.signal.aborted && unchangedSinceCommit()) this.revokeTrustedManifest?.(tx, origin, 'HOUSE_PIN_UNAVAILABLE');
    });
    if (!board) {
      // Network window (board unknown, but not an explicit 404/bad JSON):
      // the intent is already committed, status connecting, retry will
      // re-discover. unsupported only when THIS round's discovery completed
      // and found no house_session. Having a configured PIN changes nothing
      // here (finding 7): a pin says WHICH key to trust, not that the house
      // supports the control plane — offline stays unknown/connecting.
      if (!discoveryReached) {
        return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
      }
      fail('unsupported', 'no house_session board', configuredCandidate && !ackKeyHex);
      // The control plane is unsupported; the lane is not. A house that was
      // serving before this login goes back to serving after it.
      const canRecover = () => recovering && relationCommitted && discoveredManifest?.sessionBoardAbsent === true
        && recoveryCurrent(pendingEnterRequestId, opSeq);
      let restored = false;
      this.db.transaction(tx => {
        if (flight.signal.aborted || !unchangedSinceCommit()) return;
        const current = readParticipation(tx, origin);
        const oldLaneAllowed = hadLegacyLane && emptyControlState(current) && configuredSelectionCurrent()
          && recoveryTrust !== undefined
          && (recoveryTrust.binding === null ? (legacyTrustCurrent(tx, recoveryTrust) || relationCommitted)
            : relationCommitted && legacyTrustCurrent(tx, recoveryTrust));
        const confirmedTrust = captureLegacyTrust(tx, origin);
        const configuredAllowed = configuredCandidate && this.lifecycle.isConfiguredParticipation(origin)
          && discoveredManifest?.sessionBoardAbsent === true && relationCommitted && emptyControlState(current)
          && configuredSelectionCurrent() && confirmedTrust?.binding !== null && confirmedTrust !== undefined
          && this.lifecycle.legacyParticipationTrustCurrent(origin, confirmedTrust, true)
          && storageDatabasePathAllowed(tx, 'execution') && storageDatabasePathAllowed(tx, 'consumers');
        if (configuredAllowed || (!configuredScopeAtStart && (oldLaneAllowed || canRecover()))) {
          restoreLegacyLane(tx, origin, opSeq, now);
          restored = readParticipation(tx, origin)?.phase === 'connected';
        }
      });
      if (restored) { ctx.releaseLogoutFence(); this.lifecycle.closeGate(origin); this.lifecycle.openGate(origin); }
      if (configuredCandidate && restored && this.lifecycle.gateActive(origin)) {
        return { scope: 'local_installation', origin, status: 'unsupported', sessionId: '', admission: 'configured', legacyAvailable: true, errorCode: 'HOUSE_LIFECYCLE_UNSUPPORTED' };
      }
      return { scope: 'local_installation', origin, status: 'unsupported', sessionId: '', errorCode: 'HOUSE_LIFECYCLE_UNSUPPORTED', legacyAvailable: restored && this.lifecycle.gateActive(origin),
        ...(!restored ? {legacyRefusal: relationRefused ? 'AUTH_INVALID' : discoveredManifest?.sessionBoardAbsent !== true
          ? 'MANIFEST_SESSION_DECLARATION_INVALID' : configuredScopeAtStart ? 'HOUSE_CONFIGURED_JOIN_NOT_AUTHORIZED' : 'LEGACY_RECOVERY_NOT_AUTHORIZED'} : {}) };
    }
    // Pre-send re-check (review C + counter-example 2): this generation may
    // have been disabled while awaiting manifest/signing (a logout in this
    // process aborted the flight, or a same-root process committed) — the
    // ENTER is not sent at all, and the signal rides the request so an
    // in-flight fetch is torn down too.
    if (flight.signal.aborted || !unchangedSinceCommit()) {
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    }

    const client = new HouseSessionControlClient(origin, this.signer, board, this.fetchImpl, board.ack_pubkey, this.clock);
    let ack: ControlAck;
    try {
      ack = await client.enter({
        opSeq,
        requestId: effectiveRequestId,
        installationId: this.installationId,
        signal: flight.signal,
        // Cross-manager gate (round-3 probe 1, re-pinned after f0c533b1's
        // regression): the client invokes this AFTER its internal awaits
        // (key fetch + signing) and immediately before the send. A second
        // manager's logout on the shared SQLite is invisible to local
        // AbortSignals — the persistent row is the truth. The hook MUST
        // throw to cancel the send.
        authorizeSend: () => {
          if (this.lifecycle.signals().stop.aborted || flight.signal.aborted || !unchangedSinceCommit()) {
            throw new Error('enter canceled: the house state changed while signing');
          }
        },
      });
    } catch (err) {
      if (flight.signal.aborted || !authorized()) {
        return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
      }
      fail('error', `enter network error: ${String(err)}`);
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    }
    if (flight.signal.aborted || !unchangedSinceCommit()) {
      // Disabled while the ENTER was in the air — its ack settles nothing
      // (the CAS below would refuse it anyway; skip early).
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    }
    if (!ack.verified) {
      fail('error', 'enter ack failed verification (foreign key or mismatched request)');
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    }
    if (ack.outcome === OUTCOME.Rejected) {
      // A VERIFIED rejection is a definitive answer: settle the pending enter
      // so the next explicit login takes a fresh request/seq (probe 3) —
      // replaying a decided BUSY would be busy forever. The STRUCTURED code
      // is surfaced to the caller (finding 4): EXECUTOR_BUSY et al. are not
      // generic "connecting" states.
      const code = ERROR_CODE_NAMES[ack.errorCode] ?? `CODE_${ack.errorCode}`;
      fail('error', `enter rejected: ${code}`, true);
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '', errorCode: code };
    }
    return this.applyReceipt(origin, opSeq, board, ack, flight, unchangedSinceCommit, ctx.releaseLogoutFence);
  }

  private captureHistory(origin: string, ctx: LoginAttemptAuthority) {
    const { flight, authorized } = ctx;
    // A working legacy lane: enabled, connected, and session-less because the
    // house has no control plane to hold a session. Read BEFORE this round
    // moves anything, so the board-less path below can put it back.
    const priorRow = readParticipation(this.db, origin);
    const hadLegacyLane =
      priorRow?.desired === 'enabled' && priorRow.phase === 'connected' && emptyControlState(priorRow);
    // This admission is explicit, existing trust only, and bounded to the
    // supported sticky-key/full-leave-ledger in-place history contract.
    const recoveryTrust = captureLegacyTrust(this.db, origin);
    // The proof was prepared for this immutable configuration selection.
    // A changed or unreadable resolver cannot authorize the old operation.
    const configuredSelectionCurrent = (): boolean => {
      try { return this.configuredPinFor(origin) === ctx.configuredPin; }
      catch { return false; }
    };
    const recoveryCandidate = !!ctx.authority && ctx.ownerBound() && priorRow?.installation_id === this.installationId && priorRow?.desired === 'enabled' && priorRow.phase === 'connecting'
      && priorRow.remote_status === 'unsupported' && recoveryTrust?.binding !== null && recoveryTrust !== undefined
      && this.legacyRecoveryConfigured(origin) && neverControlSubset(this.db, origin, priorRow);
    // The ordinary configured entry is an explicit act, not recovery based
    // on old-version history. Normal sessionless leaves remain in the ledger.
    // Any control authority left on the row prevents this admission.
    const configuredBaseline = JSON.stringify(priorRow);
    const configuredScopeAtStart = this.lifecycle.isConfiguredParticipation(origin);
    let priorBinding: ReturnType<typeof pinnedBinding>;
    let priorDeclaration: ReturnType<typeof readVerifiedDeclaration>;
    let configuredTrustReadable = false;
    if (configuredScopeAtStart) {
      try {
        priorBinding = pinnedBinding(this.db, origin);
        priorDeclaration = priorBinding ? readVerifiedDeclaration(this.db, priorBinding) : undefined;
        configuredTrustReadable = true;
      } catch { /* Unreadable trust cannot authorize configured admission. */ }
    }
    const configuredDeclaration = declarationFingerprint(priorDeclaration);
    const configuredDeclarationCurrent = () => {
      if (!configuredTrustReadable) return false;
      try {
        const binding = pinnedBinding(this.db, origin);
        return declarationFingerprint(binding ? readVerifiedDeclaration(this.db, binding) : undefined) === configuredDeclaration;
      } catch { return false; }
    };
    const previouslySelectedSession = priorDeclaration?.sessionBoard === true;
    const configuredControlFacts = configuredScopeAtStart && configuredControlSubset(this.db, origin, priorRow);
    const configuredCandidate = !!ctx.authority && configuredScopeAtStart && configuredTrustReadable
      && !previouslySelectedSession && this.configuredControlAbsent(origin, priorRow);
    const originalPending = priorRow?.pending_enter_request_id;
    const recoveryCurrent = (pending: string | null | undefined, seq: number): boolean => {
      if (!recoveryCandidate) return false;
      try {
        const row = readParticipation(this.db, origin);
        return authorized() && !flight.signal.aborted && this.legacyRecoveryConfigured(origin)
          && configuredSelectionCurrent()
          && legacyTrustCurrent(this.db, recoveryTrust) && row?.desired === 'enabled'
          && row.op_seq === seq && row.pending_enter_request_id === pending
          && row.installation_id === priorRow?.installation_id && neverControlSubset(this.db, origin, row);
      } catch { return false; }
    };

    return { priorRow, hadLegacyLane, recoveryTrust, configuredSelectionCurrent, recoveryCandidate, configuredBaseline, configuredScopeAtStart, configuredDeclarationCurrent, previouslySelectedSession, configuredControlFacts, configuredCandidate, originalPending, recoveryCurrent };
  }

  private rejectPinConflict(origin: string, now: number, opSeq: number,
    board: NonNullable<SessionManifest['board']>, configuredPin: string,
    flight: AbortController, unchangedSinceCommit: () => boolean): LoginResult {
      const why = configuredPin && board.ack_pubkey !== configuredPin
        ? 'board ack key differs from the configured pin'
        : 'house ack key changed; explicit re-confirmation required';
      // Trust-binding rejection REVOkES execution immediately (pin-bypass
      // review ②): close the open gate and demote the durable phase so the
      // coordinator stops the old stream set. A stale pending is NOT written
      // (this rejection settled nothing server-side); the ORIGINAL leave
      // outbox rows keep their own pinned keys.
      this.lifecycle.closeGate(origin);
      // CAS on op_seq (review follow-up): another same-root process may have
      // completed a HIGHER-generation login while this rejection was in
      // flight — the stale rejection must not demote it. The old
      // session_id/lease/token are KEPT as history/evidence: they authorize
      // nothing anymore (the gate is closed and phase is demoted), but a
      // local trust rejection does not erase a session identity the server
      // still holds. Leave outbox rows keep their own pinned keys untouched.
      this.db.transaction(tx => {
        if (flight.signal.aborted || !unchangedSinceCommit()) return;
        markEnterFailure(tx, origin, opSeq, 'error', why, now);
        this.revokeTrustedManifest?.(tx, origin, 'HOUSE_PIN_MISMATCH');
        tx.execute(
        `UPDATE house_participation SET phase = 'connecting', updated_at = ?
         WHERE house_origin = ? AND desired = 'enabled' AND op_seq = ?`,
        [now, origin, opSeq],
        );
      });
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '', errorCode: 'AUTH_INVALID' };
  }

  private applyReceipt(origin: string, opSeq: number, board: NonNullable<SessionManifest['board']>,
    ack: ControlAck, flight: AbortController, unchangedSinceCommit: () => boolean,
    releaseLogoutFence: () => void): LoginResult {
    // Finding 2: a historical ALREADY_ENTERED receipt is only authority for a
    // session whose lease is still live IN THE RECEIPT — an expired-lease
    // AlreadyEntered means the server is reporting a stale idempotent replay,
    // not current permission (the server's lazy expiry will close it on the
    // next touch anyway).
    let connected = false;
    // CAS write: a false return (disabled while waiting / op_seq overtaken)
    // must not report connected and must not open the gate (review C).
    const applied = this.db.transaction(tx => {
      if (flight.signal.aborted || !unchangedSinceCommit()) return false;
      connected = (ack.outcome === OUTCOME.Entered || ack.outcome === OUTCOME.AlreadyEntered)
        && ack.sessionActive && ack.leaseExpiresAt > this.nowSecs();
      return markEnterOutcome(tx, origin, opSeq, {
      sessionId: ack.sessionId,
      houseRevision: ack.houseRevision,
      phase: connected ? 'connected' : 'connecting',
      ackKeyHex: board.ack_pubkey,
      leaseExpiresAt: ack.leaseExpiresAt,
      inboxReadToken: ack.inboxReadToken,
      renewIntervalSeconds: board.renew_interval_seconds,
      now: this.nowSecs(),
      });
    });
    if (connected && applied) {
      releaseLogoutFence();
      this.lifecycle.openGate(origin);
      return { scope: 'local_installation', origin, status: 'connected', sessionId: ack.sessionId };
    }
    return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
  }

}
