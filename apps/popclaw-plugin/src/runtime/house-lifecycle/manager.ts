import { houseRecoveryHeld, recoveryRetiredLeave, houseBindingBlocked, readHouseRecoveryStatus, type HouseRecoveryStatus } from '../../world/house-recovery-fence.js';
/**
 * ADR-0051 S2 — HouseLifecycleManager (S2a: the state-machine core; wiring
 * streams/ranger/notifications per house is S2b, done serially by the same
 * integrator).
 *
 * Invariants (work order §2 + two S2a review rounds):
 * - Logout is local-first: one transaction bumps op_seq, sets disabled, and
 *   appends an outbox leave **pinned to the house key/installation**; the
 *   in-memory gate closes immediately. Offline logout→login→crash never
 *   loses the leave ledger.
 * - The leave retry trusts ONLY the house ack key pinned at commit time — a
 *   re-keyed board or foreign-key ack seen during retries never settles; a
 *   legacy house (no control plane) ends at unsupported, never confirmed.
 * - A late ack settles only its own request: enter outcomes land via a
 *   (desired=enabled, op_seq) CAS; leaves settle by their outbox request_id.
 * - The generation gate binds the CAPTURED generation/controller and the
 *   persistent generation (op_seq/session): after logout→login an old task's
 *   handle never revives; after another same-root process commits a logout,
 *   every handle in this process reads isActive=false (persistent rows are
 *   the source of truth).
 * - A plain "repeat login" reuses the original enter generation (pending
 *   reuses the same request; connected reuses entirely — no re-sent enter, no
 *   rotation).
 * - The house ack public key is bound to the origin: a key change is handled
 *   explicitly (AUTH_INVALID), never silently accepted.
 * - stopHost cancels all in-memory gates but does NOT touch desired — it is
 *   not a logout.
 * - Clock contract: milliseconds; manager and control-client each divide by
 *   1000 exactly once.
 */

import { configuredFirstPinPort, configuredPublicPinPort, type ConfiguredFirstPinPort, type ConfiguredPublicPinPort } from './configured-first-pin.js';
import { storageDatabasePathAllowed } from '../../host/storage-maintenance.js';
import { captureLegacyTrust, legacyTrustCurrent, type LegacyTrustCapture } from './legacy-trust.js';
import { emptyControlState, neverControlSubset } from './legacy-history.js';
import type { HouseReadFailureCode } from './read-failure.js';
import type { HostDb } from '../../host/host-db.js';
import type { TrustedManifestInput, PreparedTrustedManifest } from './trusted-manifest.js';
export type { TrustedManifestInput, PreparedTrustedManifest } from './trusted-manifest.js';
import {
  fetchSessionBoard,
  fetchSessionManifest,
  type SessionManifest,
  LifecycleNetworkError,
  normalizeAckKeyHex,
  HouseSessionControlClient,
  HOUSE_SESSION_ENDPOINT,
  newRequestId,
  normalizeHouseOrigin,
  type ControlAck,
  type LifecycleFetch,
  type ControlSigner,
} from './control-client.js';
import {
  commitLocalLogin,
  commitLocalLogout,
  ensureHouseLifecycleSchema,
  listOpenOutbox,
  markEnterFailure,
  markEnterOutcome,
  nextRenewalAt,
  readOutboxRow,
  readParticipation,
  settleOutboxRow,
  type ParticipationRow,
  restoreLegacyLane,
} from './participation-store.js';

/**
 * The durable lifecycle-owner authority (bound by the resident): control
 * traffic is only legitimate while the DURABLE owner row still names this
 * token at the captured generation. Local AbortSignals cannot see another
 * process's takeover — every send and every settle re-reads the row.
 */
export interface OwnerAuthority {
  /** The durable owner generation this process currently holds, or null
   * when it holds none (all control sends refused). */
  captureEpoch(): number | null;
  /** True iff the durable row still names this holder at this generation. */
  isEpochCurrent(epoch: number): boolean;
}

export interface HouseGate {
  readonly origin: string;
  /** Generation at capture time; a higher current generation invalidates this handle. */
  readonly generation: number;
  readonly signal: AbortSignal;
  /**
   * Whether this handle still permits starting/keeping streams and outbound
   * actions: the captured controller is not aborted, the current generation
   * has not moved on, and the persistent row is still enabled+connected
   * (cross-process logouts count). Re-read after every await and before any
   * outbound write — it is never a one-shot decision.
   */
  isActive(): boolean;
  inactiveReason?(): HouseReadFailureCode;
}

export interface LoginResult {
  scope: 'local_installation';
  origin: string;
  status: 'connected' | 'connecting' | 'unsupported';
  sessionId: string;
  errorCode?: string;
  /** Local legacy readiness is independent of remote control unsupported. */
  legacyAvailable?: boolean;
  /** Local refusal, separate from the unsupported remote control plane. */
  legacyRefusal?: string;
  /** Present when a same-root command remains queued for the resident. */
  operationId?: string;
}

export interface LogoutResult {
  scope: 'local_installation';
  origin: string;
  localDisabled: boolean;
  localQuiesced: boolean;
  remoteStatus: 'pending' | 'confirmed' | 'unsupported';
  operationId: string;
}

export interface HouseStatus {
  origin: string;
  desired: 'enabled' | 'disabled';
  phase: string;
  sessionId: string;
  houseRevision: number;
  remoteStatus: string;
  gateActive: boolean;
  streams: { world: 'inactive' | 'active'; inbox: 'inactive' | 'active' };
  recovery?: HouseRecoveryStatus;
}

/**
 * Proof that this login is executing an explicit owner command that is still
 * valid — not a background sweep, and not a replay of a command the world has
 * moved past. The bus mints it only after re-checking the command row against
 * the participation baseline, so holding one means that check passed in THIS
 * round; it is not a standing permission.
 */
export interface LoginAuthority {
  /** The persisted `house_lifecycle_commands` row being executed. */
  readonly requestId: string;
}

export interface ManagerOptions {
  db: HostDb;
  signer: ControlSigner;
  installationId: string;
  /** Fixed composition selection; only HouseRuntime exposes its selected strategy. */
  configuredPinningMode?: 'static' | 'public-v1';
  fetch?: LifecycleFetch;
  /** Millisecond clock (injected for tests). */
  clock?: () => number;
  retryBackoffMs?: number;
  retryMaxMs?: number;
  /**
   * Operator-configured ack-key pins (shared injection point for ALL entry
   * roots — index/main/mcp pass the same resolver; nobody re-implements
   * trust). Returns the pinned ack public key for an origin (hex or base58,
   * normalized internally), or '' / undefined when the origin is unpinned.
   *
   * Handoff decision: a configured pin ALWAYS beats TOFU — a board advertising a
   * different key than the pin fails closed; without a pin the first explicit
   * login trusts the verified HTTPS origin's discovered key (persisted before
   * the ENTER, insert-if-absent; concurrent first logins with different keys
   * leave exactly one binding and reject the other). Background refresh never
   * creates or rotates pins.
   */
  configuredPinFor?: (origin: string) => string | undefined;
  /** Current composition-root configuration, re-read at each recovery check. */
  legacyRecoveryConfigured?: (origin: string) => boolean;
  /** Verify without writes, then return a synchronous persistence step. */
  prepareTrustedManifest?: (input: TrustedManifestInput) => PreparedTrustedManifest | Promise<PreparedTrustedManifest>;
  revokeTrustedManifest?: (tx: HostDb, origin: string, detail: string) => void;
  /**
   * Establish or confirm this house's RELATION binding, from the bytes this
   * login already fetched.
   *
   * Separate from `prepareTrustedManifest` on purpose. That one is the world
   * path and is gated on a session board's ACK key, so a house without a
   * control plane never reaches it — and the houses we actually deploy have
   * no board. This one is gated on nothing but the manifest and the owner's
   * say-so.
   *
   * The key it binds is also a different key: `HouseBinding.house_key`, which
   * is what a relation is scoped to. Writing it into `ack_key_hex` would mean
   * that the day the house grows a session board with a different key, the
   * pin-conflict check reads it as a key change and fails closed.
   *
   * It runs ONLY with an explicit authority. Establishing what a house is
   * trusted to be is the owner's act; a background sweep may confirm an
   * existing binding and may never create one.
   */
  prepareRelationBinding?: (input: {
    readonly origin: string;
    readonly rawBytes: Uint8Array;
    readonly proofHeader: string | null;
    readonly signal: AbortSignal;
  }) => Promise<{
    /** The refusal reason, or undefined when it bound. It must not throw —
     *  a throw would roll back the caller's transaction, and a block written
     *  in it is a security outcome that has to outlive the round. */
    commit(tx: HostDb): string | undefined;
  }>;
  /**
   * Where a refused relation binding is SAID.
   *
   * There is no logger in here, and a refusal that goes nowhere is the exact
   * failure this whole path exists to avoid: a house silently treated as
   * "no relations" when what actually happened is that its proof did not
   * verify. The manager refuses to swallow one — a root that supplies the
   * preparer supplies this too.
   */
  onRelationBindingRefused?: (origin: string, reason: string) => void;
}

interface GateState {
  generation: number;
  legacyTrust?: LegacyTrustCapture;
  controller: AbortController;
  /** The persistent generation this controller was minted for
   * (`op_seq:session_id`). When the row advances (lease-expired relogin
   * minted a new session WITHOUT a logout), openGate rotates the controller
   * so old captured handles die and the coordinator replaces the stream set. */
  persistGeneration: string;
}

const OUTCOME = { Entered: 1, AlreadyEntered: 2, Renewed: 3, Closed: 4, AlreadyClosed: 5, Superseded: 6, Rejected: 7 } as const;
const LEAVE_SETTLED_OUTCOMES = new Set<number>([OUTCOME.Closed, OUTCOME.AlreadyClosed, OUTCOME.Superseded]);

/** Wire error codes (popclaw.housesession.ErrorCode) by number — surfaced
 * verbatim on verified rejections (finding 4). */
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

export class HouseLifecycleManager {
  /** Read-only handles for the coordinator / roots (legacy seeding). */
  readonly db: HostDb;
  readonly installationId: string;
  readonly configuredFirstPin: ConfiguredFirstPinPort;
  readonly configuredPublicPin: ConfiguredPublicPinPort;
  private readonly localLogoutFences = new Map<string, object>();
  private readonly localLogoutEpochs = new Map<string, number>();
  private readonly signer: ControlSigner;
  private readonly fetchImpl: LifecycleFetch;
  private readonly clock: () => number;
  private readonly retryBackoffMs: number;
  private readonly retryMaxMs: number;
  private readonly prepareTrustedManifest: ManagerOptions['prepareTrustedManifest'];
  private readonly revokeTrustedManifest: ManagerOptions['revokeTrustedManifest'];
  private readonly prepareRelationBinding: ManagerOptions['prepareRelationBinding'];
  private readonly onRelationBindingRefused: ManagerOptions['onRelationBindingRefused'];
  private readonly configuredPinFor: (origin: string) => string;
  private readonly legacyRecoveryConfigured: (origin: string) => boolean;
  private readonly gates = new Map<string, GateState>();
  private readonly loginFlights = new Map<string, AbortController>();
  private readonly leaveWorkers = new Map<string, Promise<void>>();
  private readonly controlTasks = new Set<Promise<void>>();
  private readonly houseControlTasks = new Map<string, Set<Promise<void>>>();
  private readonly recoveryStops = new Map<string, AbortController>();
  private readonly renewFlights = new Map<string, Promise<boolean>>();
  private stopped = false;
  /** Torn down by stopHost: every control fetch links this signal, so a
   * wedged request cannot outlive the host stop (static finding B). */
  private readonly stopController = new AbortController();
  /** Torn down by quiesce() (ownership loss) and re-armed by
   * resumeAfterOwnership() — leave workers link it so their transports die
   * the moment ownership is lost, without the terminal stop. */
  private pauseController = new AbortController();
  /** Bound on the resume drain: even a worker that somehow ignores both its
   * pause signal and the per-stage deadlines cannot park the recovery
   * longer than this (backstop; the normal exit is far faster). */
  private static readonly RESUME_DRAIN_BOUND_MS = 40_000;
  /** Monotonic resume epoch: every quiesce()/stopHost() invalidates in-flight
   * resumeAfterOwnership() calls — their post-drain re-check compares the
   * captured epoch against the current one before arming anything (a resume
   * that drained while ANOTHER quiesce happened must not mint a pause
   * controller for a dead ownership generation). */
  private resumeEpoch = 0;
  /** The resident's durable owner authority, when bound. Unbound managers
   * (unit tests, one-shot CLI) keep the pre-ownership behavior. */
  private ownerAuth: OwnerAuthority | null = null;

  constructor(opts: ManagerOptions) {
    this.db = opts.db;
    this.signer = opts.signer;
    this.installationId = opts.installationId;
    this.fetchImpl = opts.fetch ?? fetch;
    this.clock = opts.clock ?? (() => Date.now());
    this.retryBackoffMs = opts.retryBackoffMs ?? 5_000;
    this.retryMaxMs = opts.retryMaxMs ?? 30_000;
    this.prepareTrustedManifest = opts.prepareTrustedManifest;
    this.revokeTrustedManifest = opts.revokeTrustedManifest;
    this.prepareRelationBinding = opts.prepareRelationBinding;
    this.onRelationBindingRefused = opts.onRelationBindingRefused;
    this.configuredPinFor = (origin) => {
      const pin = opts.configuredPinFor?.(origin) ?? '';
      return pin ? normalizeAckKeyHex(pin) : '';
    };
    this.legacyRecoveryConfigured = opts.legacyRecoveryConfigured ?? (() => false);
    ensureHouseLifecycleSchema(this.db);
    this.configuredFirstPin = configuredFirstPinPort({ db: this.db, installationId: this.installationId,
      selected: () => opts.configuredPinningMode !== 'public-v1',
      configured: this.legacyRecoveryConfigured, configuredPin: this.configuredPinFor,
      fence: origin => this.localLogoutFences.get(origin),
      cancellationEpoch: origin => this.localLogoutEpochs.get(origin) ?? 0, stopped: () => this.stopped,
      seed: origin => { this.seedLegacyHouse(origin); } });
    this.configuredPublicPin = configuredPublicPinPort({ db: this.db,
      selected: () => opts.configuredPinningMode === 'public-v1',
      configured: this.legacyRecoveryConfigured, configuredPin: this.configuredPinFor,
      fence: origin => this.localLogoutFences.get(origin),
      cancellationEpoch: origin => this.localLogoutEpochs.get(origin) ?? 0, stopped: () => this.stopped });
  }

  /** Bind the durable owner authority (the resident does this at
   * construction). Once bound, leave workers refuse to send or settle
   * unless the durable owner row still names this holder at the captured
   * generation — another process's takeover is visible IMMEDIATELY, not at
   * the next timer tick. */
  bindOwnerAuthority(auth: OwnerAuthority): void {
    this.ownerAuth = auth;
  }

  /**
   * The pin-conflict wall, in ONE place: for a session-carrying house, a
   * configured pin that differs from the durable binding keeps EVERY gate
   * closed — seed-time recovery included. Sessionless rows use the separately captured relation-binding trust
   * check; a relation key never substitutes for a session ACK key.
   *
   * Shared with `HouseRuntime`'s public read lane, which must never be more
   * permissive than this one. That is not hypothetical: the read lane first
   * normalised BOTH sides, so a binding differing from the configured pin only
   * in hex CASE closed the owner's gate and left the read open. Only the
   * CONFIGURED side is normalised (an operator may type either spelling);
   * `ack_key_hex` is compared raw, because this codebase is the only writer of
   * that column and a mismatch there is a fact worth refusing on.
   */
  static pinAgreesWithBinding(row: {session_id: string; ack_key_hex: string}, configuredPin: string): boolean {
    if (!row.session_id) return true;
    const pin = configuredPin ? normalizeAckKeyHex(configuredPin) : '';
    return !pin || row.ack_key_hex === pin;
  }

  /** Per-house generation gate. A handle binds the captured in-memory
   * generation AND the persistent generation (op_seq/session) — after
   * another same-root process logs out and re-logs-in, this process's old
   * handle has an unchanged in-memory generation but the persistent
   * generation has moved on, so isActive must be false. */
  gateFor(originInput: string): HouseGate {
    const origin = normalizeHouseOrigin(originInput);
    const state = this.gates.get(origin);
    const capturedGeneration = state?.generation ?? 0;
    const capturedSignal = state?.controller.signal ?? NEVER_OPENED;
    let capturedRow: ParticipationRow | null = null;
    try { capturedRow = readParticipation(this.db, origin); } catch { /* Unreadable authority remains closed. */ }
    const capturedOpSeq = capturedRow?.op_seq ?? 0;
    const capturedSession = capturedRow?.session_id ?? '';
    const trust = state?.legacyTrust;
    const reason = (): HouseReadFailureCode => {
      try {
        const row = readParticipation(this.db, origin);
        if (this.localLogoutFences.has(origin) || row?.desired === 'disabled') return 'HOUSE_DISABLED';
        if (!storageDatabasePathAllowed(this.db, 'execution')) return 'HOUSE_STORAGE_UNAVAILABLE';
        if (!row || row.phase !== 'connected') return row?.remote_status === 'unsupported' ? 'HOUSE_LIFECYCLE_UNSUPPORTED' : 'HOUSE_CONNECTING';
        if (capturedSession === '' && !legacyTrustCurrent(this.db, trust)) return 'HOUSE_TRUST_REVOKED';
        if (!HouseLifecycleManager.pinAgreesWithBinding(row, this.configuredPinFor(origin))) return 'HOUSE_TRUST_REVOKED';
        return 'HOUSE_ACTION_STALE';
      } catch { return 'HOUSE_TRUST_REVOKED'; }
    };
    return {
      origin,
      generation: capturedGeneration,
      signal: capturedSignal,
      inactiveReason: reason,
      isActive: () => {
        try {
        if (this.stopped || houseBindingBlocked(this.db, origin) || houseRecoveryHeld(this.db, origin) || this.localLogoutFences.has(origin)) return false;
        if (capturedSignal.aborted) return false;
        const current = this.gates.get(origin);
        if (!current || current.generation !== capturedGeneration || current.controller.signal.aborted) {
          return false;
        }
        // Persistent-generation check (cross-process): the row is still
        // enabled+connected AND still the captured op_seq/session — another
        // process's re-login allocated a new generation, invalidating this
        // handle. A SESSION-CARRYING house additionally requires an unexpired
        // server lease (finding 2: permission expires with the lease, without
        // needing another login call; a historical AlreadyEntered ack is not
        // current authority). Legacy-seeded houses (no session) have no lease
        // to expire.
        const row = readParticipation(this.db, origin);
        if (!row) return false;
        if (row.desired !== 'enabled' || row.phase !== 'connected') return false;
        if (row.op_seq !== capturedOpSeq || row.session_id !== capturedSession) return false;
        if (row.session_id && row.lease_expires_at <= this.nowSecs()) return false;
        // Pin-conflict wall (pin-bypass review ①) — see pinAgreesWithBinding.
        if (!HouseLifecycleManager.pinAgreesWithBinding(row, this.configuredPinFor(origin))) return false;
        if (!storageDatabasePathAllowed(this.db, 'execution')) return false;
        if (capturedSession === '' && !legacyTrustCurrent(this.db, trust)) return false;
        return true;
        } catch { return false; }
      },
    };
  }

  /**
   * login: discovery -> house-key binding check -> local intent (reuse or
   * allocate op_seq) -> enter -> verify ack -> CAS write -> open gate. A
   * repeated login while connected reuses the current generation entirely.
   */
  /**
   * `authority` is the owner's still-valid command, carried down from the
   * bus. Its ABSENCE is meaningful: background resume calls this too, on its
   * own schedule, and a round nobody asked for must not be able to establish
   * a house's first trust. Anything that only CONFIRMS what is already
   * trusted needs no authority and gets none.
   */
  async loginHouse(input: string, authority?: LoginAuthority): Promise<LoginResult> {
    return this.loginHouseOperation(input, authority, true);
  }

  private async loginHouseOperation(input: string, authority: LoginAuthority | undefined, direct: boolean): Promise<LoginResult> {
    const origin = normalizeHouseOrigin(input);
    const ownerEpoch = this.ownerAuth?.captureEpoch() ?? null;
    const authorized = () => !this.stopped && (!this.ownerAuth || (
      ownerEpoch !== null && this.ownerAuth.isEpochCurrent(ownerEpoch) && !this.pauseController.signal.aborted
    ));
    if (houseRecoveryHeld(this.db, origin)) return {scope:'local_installation',origin,status:'connecting',sessionId:'',errorCode:'AUTH_INVALID'};
    if (!authorized()) return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
    const now = this.nowSecs();
    const logoutFence = this.localLogoutFences.get(origin);
    // Resident roots require the explicit current command authority. Preserve
    // the existing direct API of unbound managers, while background recovery
    // cannot release either kind of local fence. Success is verified below.
    const releaseLogoutFence = (): void => {
      if ((authority || (direct && this.ownerAuth === null)) && authorized()
        && this.localLogoutFences.get(origin) === logoutFence) {
        this.localLogoutFences.delete(origin);
      }
    };

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
      this.openGate(origin);
      return { scope: 'local_installation', origin, status: 'connected', sessionId: existing.session_id };
    }

    // Intent snapshot BEFORE any await (review counter-examples 1+2): a
    // logout landing while this call awaits discovery/signing must stop the
    // login from re-enabling the row afterwards. The snapshot is checked
    // after every await, and commitLocalLogin only applies when the row
    // still matches it (CAS) — cross-process changes abort this login too.
    const baseline = readParticipation(this.db, origin);
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
    const result = register(this.loginHouseInner(origin, now, { baselineSeq, baselineDesired, configuredPin: configuredPinEarly, intentUnchanged, flight, authorized, releaseLogoutFence, ...(authority ? { authority } : {}) }));
    const task = result.then(() => undefined, () => undefined).finally(() => { this.controlTasks.delete(task); });
    this.controlTasks.add(task);
    const houseTasks = this.houseControlTasks.get(origin) ?? new Set<Promise<void>>();
    houseTasks.add(task); this.houseControlTasks.set(origin, houseTasks);
    void task.finally(() => { houseTasks.delete(task); });
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
        const signal = composeFlightSignal(flight.signal, this.stopController.signal, this.pauseController.signal);
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
        this.openGate(origin);
        return { scope: 'local_installation', origin, status: 'connected', sessionId: baseline.session_id };
      } catch (error) {
        if (current()) {
          this.closeGate(origin);
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
    const task = run.then(() => undefined, () => undefined).finally(() => this.controlTasks.delete(task));
    this.controlTasks.add(task);
    const houseTasks = this.houseControlTasks.get(origin) ?? new Set<Promise<void>>();
    houseTasks.add(task); this.houseControlTasks.set(origin, houseTasks);
    void task.finally(() => { houseTasks.delete(task); });
    return run;
  }

  private async loginHouseInner(
    origin: string,
    now: number,
    ctx: {
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
    },
  ): Promise<LoginResult> {
    const { flight, intentUnchanged, authorized } = ctx;
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
    const recoveryCandidate = !!ctx.authority && this.ownerAuth !== null && priorRow?.installation_id === this.installationId && priorRow?.desired === 'enabled' && priorRow.phase === 'connecting'
      && priorRow.remote_status === 'unsupported' && recoveryTrust?.binding !== null && recoveryTrust !== undefined
      && this.legacyRecoveryConfigured(origin) && neverControlSubset(this.db, origin, priorRow);
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
      discoveredManifest = await fetchSessionManifest(origin, this.fetchImpl, composeFlightSignal(flight.signal, this.stopController.signal));
      board = discoveredManifest.board;
      discoveryReached = true;
    } catch (err) {
      if (err instanceof LifecycleNetworkError && !flight.signal.aborted) {
        // fall through with board = null (network window)
      } else if (flight.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
      } else {
        throw new Error(`INVALID_HOUSE: ${String(err)}`);
      }
    }
    if (flight.signal.aborted || !authorized() || !intentUnchanged()
      || (recoveryCandidate && !recoveryCurrent(originalPending, ctx.baselineSeq))) {
      // A logout (or another op) landed during the discovery await — this
      // call must NOT re-enable the house.
      return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
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
    const trustedKey = this.configuredPinFor(origin) || persistedPinBeforeDiscovery || board?.ack_pubkey || '';

    const requestId = newRequestId();
    // Owner authority and intent CAS share the write lock. Another process
    // cannot acquire a new epoch between this check and the intent write.
    const committed = this.db.transaction(tx => {
      if (flight.signal.aborted || !authorized() || !intentUnchanged()
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
    const effectiveRequestId = mode === 'reuse-pending' && pendingEnterRequestId ? pendingEnterRequestId : requestId;

    // Configured pin beats everything (handoff §18:26): the board must
    // advertise EXACTLY the pinned key; anything else fails closed — a
    // re-keyed or hostile house cannot override the operator's pin, and TOFU
    // never applies to a pinned origin.
    const configuredPin = this.configuredPinFor(origin);
    const pinConflict = (board && configuredPin && board.ack_pubkey !== configuredPin)
      || (board && ackKeyHex && ackKeyHex !== board.ack_pubkey);
    if (pinConflict) {
      const why = configuredPin && board!.ack_pubkey !== configuredPin
        ? 'board ack key differs from the configured pin'
        : 'house ack key changed; explicit re-confirmation required';
      // Trust-binding rejection REVOkES execution immediately (pin-bypass
      // review ②): close the open gate and demote the durable phase so the
      // coordinator stops the old stream set. A stale pending is NOT written
      // (this rejection settled nothing server-side); the ORIGINAL leave
      // outbox rows keep their own pinned keys.
      this.closeGate(origin);
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
          signal: composeFlightSignal(flight.signal, this.stopController.signal),
        });
        // The refusal travels OUT of the transaction, not through it. A
        // throw would roll back a block this very commit may have written,
        // and a block is the one refusal that has to outlive the round.
        let refusal: string | undefined;
        this.db.transaction(tx => {
          if (flight.signal.aborted || !unchangedSinceCommit()
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
          signal: composeFlightSignal(flight.signal, this.stopController.signal)});
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
          this.closeGate(origin);
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
      fail('unsupported', 'no house_session board');
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
        if (oldLaneAllowed || canRecover()) {
          restoreLegacyLane(tx, origin, opSeq, now);
          restored = readParticipation(tx, origin)?.phase === 'connected';
        }
      });
      if (restored) { ctx.releaseLogoutFence(); this.closeGate(origin); this.openGate(origin); }
      return { scope: 'local_installation', origin, status: 'unsupported', sessionId: '', errorCode: 'HOUSE_LIFECYCLE_UNSUPPORTED', legacyAvailable: restored && this.gateFor(origin).isActive(),
        ...(!restored ? {legacyRefusal: relationRefused ? 'AUTH_INVALID' : discoveredManifest?.sessionBoardAbsent !== true
          ? 'MANIFEST_SESSION_DECLARATION_INVALID' : 'LEGACY_RECOVERY_NOT_AUTHORIZED'} : {}) };
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
          if (this.stopped || flight.signal.aborted || !unchangedSinceCommit()) {
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
      ctx.releaseLogoutFence();
      this.openGate(origin);
      return { scope: 'local_installation', origin, status: 'connected', sessionId: ack.sessionId };
    }
    return { scope: 'local_installation', origin, status: 'connecting', sessionId: '' };
  }

  /** Renew only an existing live session, under its pinned key and captured
   * owner epoch. This path never discovers a board, enters or takes over. */
  renewHouse(input: string): Promise<boolean> {
    const origin = normalizeHouseOrigin(input);
    const existing = this.renewFlights.get(origin);
    if (existing) return existing;
    const row = readParticipation(this.db, origin);
    if (!row?.session_id || !row.ack_key_hex || row.installation_id !== this.installationId) return Promise.resolve(false);
    const gate = this.gateFor(origin);
    const ownerEpoch = this.ownerAuth?.captureEpoch() ?? null;
    const ownerCurrent = () => !this.ownerAuth || (ownerEpoch !== null && this.ownerAuth.isEpochCurrent(ownerEpoch));
    if (!gate.isActive() || !ownerCurrent() || this.pauseController.signal.aborted) return Promise.resolve(false);
    const signal = composeFlightSignal(gate.signal, this.pauseController.signal, this.stopController.signal);
    const current = () => {
      if (this.stopped || signal.aborted || !ownerCurrent()) return false;
      const pin = this.configuredPinFor(origin);
      if (pin && pin !== row.ack_key_hex) return false;
      const latest = readParticipation(this.db, origin);
      // Deliberately no old lease deadline check at settlement: the server
      // may have renewed before expiry but its valid ACK arrived after it.
      return latest?.desired === 'enabled' && latest.phase === 'connected'
        && latest.op_seq === row.op_seq && latest.session_id === row.session_id
        && latest.house_revision === row.house_revision && latest.ack_key_hex === row.ack_key_hex;
    };
    const result = this.renewHouseInner(row, gate, signal, current).finally(() => {
      if (this.renewFlights.get(origin) === result) this.renewFlights.delete(origin);
    });
    this.renewFlights.set(origin, result);
    const task = result.then(() => undefined, () => undefined).finally(() => { this.controlTasks.delete(task); });
    this.controlTasks.add(task);
    const houseTasks = this.houseControlTasks.get(origin) ?? new Set<Promise<void>>();
    houseTasks.add(task); this.houseControlTasks.set(origin, houseTasks);
    void task.finally(() => { houseTasks.delete(task); });
    return result;
  }

  /** Called by the resident poll. Disabled, legacy and fenced rows do no I/O. */
  async renewDueSessions(): Promise<void> {
    if (this.stopped || this.pauseController.signal.aborted) return;
    const rows = this.db.queryAll<{ house_origin: string }>(
      `SELECT house_origin FROM house_participation WHERE desired = 'enabled'
       AND phase = 'connected' AND session_id != '' AND renew_after <= ? AND lease_expires_at > ?`,
      [this.nowSecs(), this.nowSecs()],
    );
    await Promise.all(rows.map(row => this.renewHouse(row.house_origin)));
  }

  /** Recover only undecided network attempts or our own expired session.
   * A definitive rejection (in particular EXECUTOR_BUSY) never starts a
   * background takeover loop; the owner must explicitly request login again. */
  async resumeEnabledSessions(): Promise<void> {
    if (this.stopped || this.pauseController.signal.aborted) return;
    const epoch = this.ownerAuth?.captureEpoch() ?? null;
    const authorized = () => !this.ownerAuth || (epoch !== null && this.ownerAuth.isEpochCurrent(epoch));
    if (!authorized()) return;
    const rows = this.db.queryAll<ParticipationRow>(
      `SELECT * FROM house_participation WHERE desired = 'enabled' AND renew_after <= ? AND (
        (pending_enter_request_id IS NOT NULL AND (remote_status = 'none' OR remote_error LIKE 'enter network error:%'))
        OR ((phase = 'connected' OR (phase = 'connecting' AND remote_status = 'confirmed'))
          AND session_id != '' AND lease_expires_at <= ?)
      )`, [this.nowSecs(), this.nowSecs()],
    );
    await Promise.all(rows.map(async row => {
      if (!authorized() || this.loginFlights.has(row.house_origin) || this.renewFlights.has(row.house_origin)) return;
      const reserved = this.db.transaction(tx => {
        const latest = readParticipation(tx, row.house_origin);
        if (!authorized() || latest?.op_seq !== row.op_seq || latest.desired !== 'enabled') return false;
        tx.execute('UPDATE house_participation SET renew_after = ? WHERE house_origin = ?',
          [this.nowSecs() + Math.max(1, Math.ceil(this.retryBackoffMs / 1000)), row.house_origin]);
        return true;
      });
      if (reserved) await this.loginHouseOperation(row.house_origin, undefined, false);
    }));
  }

  private async renewHouseInner(row: ParticipationRow, gate: HouseGate, signal: AbortSignal, current: () => boolean): Promise<boolean> {
    const origin = row.house_origin;
    const board = { version: 1 as const, endpoint: HOUSE_SESSION_ENDPOINT, ack_pubkey: row.ack_key_hex, operations: [] as readonly string[] };
    const client = new HouseSessionControlClient(origin, this.signer, board, this.fetchImpl, row.ack_key_hex, this.clock);
    // A failed/unknown renewal has a bounded retry cadence, including after
    // process restart. Reserve the next attempt before any network await.
    const reserved = this.db.transaction(tx => {
      if (!current()) return false;
      tx.execute('UPDATE house_participation SET renew_after = ? WHERE house_origin = ?',
        [this.nowSecs() + Math.max(1, Math.ceil(this.retryBackoffMs / 1000)), origin]);
      return true;
    });
    if (!reserved) return false;
    let ack: ControlAck;
    try {
      ack = await client.renew({
        opSeq: row.op_seq, requestId: newRequestId(), installationId: this.installationId,
        targetSessionId: row.session_id, expectedHouseRevision: row.house_revision, signal,
        authorizeSend: () => { if (!current() || !gate.isActive()) throw new Error('renew canceled: authority changed'); },
      });
    } catch (err) {
      this.db.transaction(tx => {
        if (current()) tx.execute('UPDATE house_participation SET remote_error = ? WHERE house_origin = ?', [`renew network error: ${String(err)}`, origin]);
      });
      return false;
    }
    let leaseGap = false;
    let fenced = false;
    const applied = this.db.transaction(tx => {
      if (!current()) return false;
      if (ack.verified && ack.outcome === OUTCOME.Rejected) {
        const code = ERROR_CODE_NAMES[ack.errorCode] ?? `CODE_${ack.errorCode}`;
        fenced = true;
        tx.execute("UPDATE house_participation SET phase = 'reconnecting', remote_status = 'error', remote_error = ? WHERE house_origin = ?", [`renew rejected: ${code}`, origin]);
        return false;
      }
      if (!ack.verified || ack.outcome !== OUTCOME.Renewed || ack.errorCode !== 0
        || !ack.sessionActive || ack.sessionId !== row.session_id || ack.houseRevision !== row.house_revision
        || ack.leaseExpiresAt <= this.nowSecs() || ack.leaseExpiresAt < row.lease_expires_at || !ack.inboxReadToken) {
        tx.execute('UPDATE house_participation SET remote_error = ? WHERE house_origin = ?', ['renew ack failed session/fence/lease verification', origin]);
        return false;
      }
      leaseGap = row.lease_expires_at <= this.nowSecs();
      tx.execute(`UPDATE house_participation SET lease_expires_at = ?, inbox_read_token = ?,
        renew_after = ?, updated_at = ?, remote_error = '' WHERE house_origin = ?`,
      [ack.leaseExpiresAt, ack.inboxReadToken, nextRenewalAt(this.nowSecs(), ack.leaseExpiresAt, row.renew_interval_seconds), this.nowSecs(), origin]);
      return true;
    });
    if (fenced || (applied && leaseGap)) this.closeGate(origin);
    if (applied && leaseGap) this.openGate(origin);
    return applied;
  }

  /**
   * logout: local transaction first (op_seq+1 / disabled / outbox leave
   * pinned to the house key), in-memory gate closed immediately, then the
   * restricted async retry worker settles the remote side.
   */
  async logoutHouse(input: string): Promise<LogoutResult> {
    const origin = normalizeHouseOrigin(input);
    // Local cancellation survives a failed durable logout. First-pin attempts
    // must not mistake the unchanged row for unchanged owner intent.
    this.localLogoutEpochs.set(origin, (this.localLogoutEpochs.get(origin) ?? 0) + 1);
    this.localLogoutFences.set(origin, {});
    const requestId = newRequestId();
    // Abort any in-flight login for this house FIRST — its discovery/signing/
    // fetch awaits must not resume into a re-enabled row (review counter-
    // examples 1+2), and its in-air ENTER is torn down via the signal.
    this.loginFlights.get(origin)?.abort(new Error(`logout: ${origin}`));
    const row = readParticipation(this.db, origin);
    // Trust sources for the leave pin, in order (handoff §18:26 + round-3
    // probe): the operator's configured pin beats everything and fills an
    // empty binding; else the durable binding; else unknown. A configured pin
    // on a legacy-classified house still wins — the operator's pin is an
    // explicit trust statement that outranks a stale 'unsupported' snapshot.
    const configuredPin = this.configuredPinFor(origin);
    const pinnedKey = row?.ack_key_hex || configuredPin;
    // Three states (review): key bound -> the leave goes under the pinned
    // key; probed legacy (an earlier discovery explicitly found no control
    // plane) -> terminal unsupported; discovery never completed (network
    // window) -> unknown, an empty-key outbox row is written and classified
    // on retry — "no ack yet" is never treated as "no control plane".
    const knownLegacy = !pinnedKey && row?.remote_status === 'unsupported';
    let committed = false;
    try {
      commitLocalLogout(this.db, origin, this.installationId, requestId, this.nowSecs(), pinnedKey);
      committed = true;
    } catch (err) {
      // PERSISTENCE_FAILED: the memory gate STILL closes (the proto requires
      // it even when cross-restart persistence cannot be guaranteed), and the
      // caller gets an explicit PERSISTENCE_FAILED — never a fake success.
      throw new Error(`PERSISTENCE_FAILED: local logout transaction failed: ${String(err)}`);
    } finally {
      this.closeGate(origin);
    }
    void committed;
    if (configuredPin && !row?.ack_key_hex) {
      // Backfill AFTER the commit: on a first-ever logout the row did not
      // exist when the pin was read. The operator's pin fills an empty
      // binding (handoff §18:26) — never overwriting an existing one.
      this.db.execute(
        "UPDATE house_participation SET ack_key_hex = ? WHERE house_origin = ? AND ack_key_hex = ''",
        [configuredPin, origin],
      );
    }
    let remote: LogoutResult['remoteStatus'] = 'pending';
    if (knownLegacy) {
      settleOutboxRow(this.db, requestId, 'unsupported', this.nowSecs());
      remote = 'unsupported';
    } else {
      this.spawnLeaveWorker(requestId);
    }
    return {
      scope: 'local_installation',
      origin,
      localDisabled: true,
      localQuiesced: true,
      remoteStatus: remote,
      operationId: requestId,
    };
  }

  async getHouseStatus(input: string): Promise<HouseStatus> {
    const origin = normalizeHouseOrigin(input);
    const row = readParticipation(this.db, origin);
    const gate = this.gateFor(origin);
    const recovery = readHouseRecoveryStatus(this.db,origin);
    return {
      origin,
      desired: row?.desired ?? 'disabled',
      phase: row?.phase ?? 'disconnected',
      sessionId: row?.session_id ?? '',
      houseRevision: row?.house_revision ?? 0,
      remoteStatus: row?.remote_status ?? 'none',
      gateActive: gate.isActive(),
      // The manager owns permission, not sockets. The coordinator supplies
      // actual receiving state when a resident has opened stream resources.
      streams: { world: 'inactive', inbox: 'inactive' },
      ...(recovery ? {recovery}:{}),
    };
  }

  /**
   * ADR-0051 migration rule: a house present in the legacy `lore_houses`
   * config that has never been touched by the new command keeps its
   * static-connect behavior — desired=enabled, phase=connected, no session,
   * no ack key (the legacy lane). An existing row is NEVER overwritten.
   */
  seedLegacyHouse(origin: string): boolean {
    ensureHouseLifecycleSchema(this.db);
    const res = this.db.execute(
      `INSERT INTO house_participation
         (house_origin, installation_id, op_seq, desired, phase, session_id,
          house_revision, lease_expires_at, inbox_read_token, ack_key_hex,
          pending_enter_request_id, remote_status, remote_error, updated_at)
       VALUES (?, ?, 0, 'enabled', 'connected', '', 0, 0, '', '', NULL, 'none', '', 0)
       ON CONFLICT(house_origin) DO NOTHING`,
      [origin, this.installationId],
    );
    // Open the gate for the row whether it was just seeded or already
    // existed: a RESTART must restore streams for a still-valid enabled
    // legacy row (the gate's isActive() consults the durable row, so a
    // logged-out house stays closed — this never revives anything).
    this.openGate(origin);
    return res.changes > 0;
  }

  /** Stop all host-side activity (streams/retry workers/gates) but keep
   * desired — this is NOT a logout. TERMINAL: a stopped manager never
   * re-arms; ownership loss must use quiesce() instead (review finding 5). */
  stopHost(): void {
    this.stopped = true;
    this.resumeEpoch += 1;
    for (const state of this.gates.values()) state.controller.abort(new Error('stopHost'));
    this.gates.clear();
    for (const flight of this.loginFlights.values()) flight.abort(new Error('stopHost'));
    this.loginFlights.clear();
    this.stopController.abort(new Error('stopHost'));
    this.pauseController.abort(new Error('stopHost'));
  }

  /**
   * RECOVERABLE ownership loss (review finding 5): tear down everything
   * in-memory — gates (captured handles die), login flights, leave-worker
   * transports — WITHOUT the terminal `stopped` flag. A later
   * resumeAfterOwnership() re-arms; durable desired/outbox rows are
   * untouched (losing ownership is not a logout).
   */
  quiesce(): void {
    // Invalidate any in-flight resume FIRST: its drain may still be waiting
    // on old workers, and when it wakes it must not re-arm a dead attempt.
    this.resumeEpoch += 1;
    for (const state of this.gates.values()) {
      state.controller.abort(new Error('lifecycle ownership lost'));
    }
    this.gates.clear();
    for (const flight of this.loginFlights.values()) {
      flight.abort(new Error('lifecycle ownership lost'));
    }
    this.loginFlights.clear();
    // Leave workers observe the pause signal in their loops/sleeps and exit
    // WITHOUT settling anything; resume re-spawns them from the durable
    // outbox rows.
    this.pauseController.abort(new Error('lifecycle ownership lost'));
  }

  /** Re-arm after ownership was (re)gained: DRAIN the old generation's
   * workers first (their captured pause signal is aborted, so they exit
   * without settling), then mint the fresh pause signal and rescan the
   * durable outbox. Spawning while an old worker still holds the requestId
   * would skip it (dedup) and leave the pending row unowned after the old
   * worker's exit — the resume race the review pinned. Gates are re-opened
   * by the resident's re-seed pass (seedLegacyHouse). */
  async resumeAfterOwnership(): Promise<void> {
    if (this.stopped) return;
    // Capture THIS resume's epoch: a quiesce/stop during the drain bumps it,
    // and the post-drain re-check (below) abandons the attempt — a stale
    // resume must never mint a pause controller or restart workers for a
    // dead ownership generation. The drain itself is bounded: old workers
    // exit on their captured pause signal (aborted) or their request
    // timeout (every control fetch carries one), so a hung transport cannot
    // park the new owner's control plane forever.
    const epoch = this.resumeEpoch;
    // Backstop bound: with every control stage deadline-bounded workers exit
    // within ~30s of their hung stage; this cap guarantees recovery even if
    // a future regression reintroduces an unbounded await. The deadline
    // handle is cleared when the drain wins — an empty drain must not leave
    // a 40s ref'd Timeout holding the process open.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      drainTimer = setTimeout(resolve, HouseLifecycleManager.RESUME_DRAIN_BOUND_MS);
    });
    try {
      await Promise.race([this.waitForQuiet(), bound]);
    } finally {
      clearTimeout(drainTimer);
    }
    if (this.stopped || this.resumeEpoch !== epoch) return;
    this.pauseController = new AbortController();
    await this.resumePendingOperations();
  }

  /**
   * Startup resume (called by the S2b coordinator): replays ONLY unsettled
   * leaves from the persistent outbox; disabled houses never re-handshake or
   * re-subscribe; enabled houses are started by the coordinator via gates.
   */
  async resumePendingOperations(): Promise<void> {
    for (const row of listOpenOutbox(this.db)) {
      this.spawnLeaveWorker(row.request_id);
    }
  }

  /** Stop only the recovered House. The durable fence was written before this
   * call; remote effects already in flight may still finish as evidence. */
  async quiesceHouse(origin: string): Promise<void> {
    if (!houseRecoveryHeld(this.db, origin)) throw new Error('HOUSE_RECOVERY_FENCE_REQUIRED');
    this.localLogoutEpochs.set(origin, (this.localLogoutEpochs.get(origin) ?? 0) + 1);
    this.localLogoutFences.set(origin, {});
    this.loginFlights.get(origin)?.abort(new Error('HOUSE_RECOVERY_HELD'));
    this.closeGate(origin);
    this.recoveryStops.get(origin)?.abort(new Error('HOUSE_RECOVERY_HELD'));
    const leaves = this.db.queryAll<{request_id: string}>('SELECT request_id FROM house_lifecycle_outbox WHERE house_origin=?', [origin]);
    await Promise.allSettled([...this.houseControlTasks.get(origin) ?? [],
      ...leaves.flatMap(row => this.leaveWorkers.get(row.request_id) ? [this.leaveWorkers.get(row.request_id)!] : []),
      ...(this.renewFlights.get(origin) ? [this.renewFlights.get(origin)!] : [])]);
    this.recoveryStops.delete(origin);
  }

  /** Drain all control work before a root releases its database. */
  async waitForQuiet(): Promise<void> {
    while (this.leaveWorkers.size > 0 || this.controlTasks.size > 0) {
      await Promise.allSettled([...this.leaveWorkers.values(), ...this.controlTasks]);
    }
  }

  // --- internals ---------------------------------------------------------

  private spawnLeaveWorker(requestId: string): void {
    // Dedup (review in-flight reminder): a live worker for this request
    // already owns it — resumePendingOperations overlapping an exiting old
    // worker must not double-run the same outbox row.
    if (this.leaveWorkers.has(requestId)) return;
    // The pause signal is captured HERE, per generation: quiesce aborts it;
    // a later resumeAfterOwnership() mints a NEW controller whose fresh
    // signal this old worker never sees (reading the current controller
    // after a resume would revive it).
    const pauseSignal = this.pauseController.signal;
    const worker = this.runLeaveRetry(requestId, pauseSignal)
      .catch((err: unknown) => {
        this.db.execute(
          `UPDATE house_participation SET remote_error = ?, updated_at = ?
           WHERE house_origin = (SELECT house_origin FROM house_lifecycle_outbox WHERE request_id = ?)
             AND desired = 'disabled'`,
          [String(err), this.nowSecs(), requestId],
        );
      })
      .finally(() => {
        // Identity guard: only remove OUR registration — a newer worker for
        // the same request (post-resume respawn) may already own the slot.
        if (this.leaveWorkers.get(requestId) === worker) {
          this.leaveWorkers.delete(requestId);
        }
      });
    this.leaveWorkers.set(requestId, worker);
  }

  /**
   * Restricted leave-retry worker: exponential backoff, sends only leaves.
   * Verification uses ONLY the house key **pinned in the outbox row at
   * commit time** — no board re-discovery (a disabled house does not loop
   * manifest requests forever); re-keyed acks never settle and surface as
   * remote_error.
   */
  private async runLeaveRetry(requestId: string, pauseSignal: AbortSignal): Promise<void> {
    let row = readOutboxRow(this.db, requestId);
    if (!row || row.settled_at !== null) return;
    const origin = row.house_origin;
    if (recoveryRetiredLeave(this.db, origin, row.op_seq)) return;

    if (!row.ack_key_hex) {
      // Unknown state (empty key at commit). Trust sources, in order —
      // background classification NEVER creates the first binding (finding 6
      // + follow-up: only an explicit login may TOFU):
      //   1. the operator's configured pin (operator-provided trust — the
      //      background may adopt it directly);
      //   2. the participation row's key, if an explicit login already
      //      persisted one (trusted discovery persists BEFORE its ENTER);
      //   3. otherwise: keep the outbox row PENDING and surface why — no
      //      board fetch, no binding writes, no TOFU from background traffic.
      const pin = this.configuredPinFor(origin);
      const rowKey = readParticipation(this.db, origin)?.ack_key_hex ?? '';
      const trusted = pin || rowKey;
      if (trusted) {
        // After every await (there were none here, but the guard is the
        // rule): check stopped before writing anything.
        if (this.stopped) return;
        this.db.execute(
          'UPDATE house_lifecycle_outbox SET ack_key_hex = ? WHERE request_id = ? AND settled_at IS NULL',
          [trusted, requestId],
        );
      } else {
        this.db.execute(
          `UPDATE house_participation
           SET remote_error = 'leave pending: no trusted house key (await an explicit login or a configured pin)', updated_at = ?
           WHERE house_origin = ? AND desired = 'disabled'`,
          [this.nowSecs(), origin],
        );
        return; // stays pending; retried on the next resume/startup
      }
    }
    row = readOutboxRow(this.db, requestId);
    if (!row || row.settled_at !== null || !row.ack_key_hex) return;

    const pinnedBoard = {
      version: 1 as const,
      endpoint: HOUSE_SESSION_ENDPOINT,
      ack_pubkey: row.ack_key_hex,
      operations: [] as readonly string[],
    };
    const client = new HouseSessionControlClient(
      origin,
      this.signer,
      pinnedBoard,
      this.fetchImpl,
      row.ack_key_hex,
      this.clock,
    );
    const recoveryStop = this.recoveryStops.get(origin) ?? new AbortController();
    this.recoveryStops.set(origin, recoveryStop);
    const stopSignal = composeFlightSignal(this.stopController.signal, pauseSignal, recoveryStop.signal);
    // Durable owner epoch at worker start (resume-review probe 2): a manager
    // bound to an owner authority only sends/settles while the ROW still
    // names this holder at this generation. null = not an authority holder:
    // the worker refuses to send at all (the resident owner retries).
    const ownerEpoch = this.ownerAuth?.captureEpoch() ?? null;
    let delay = this.retryBackoffMs;
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    // quiesce() aborts the CAPTURED pause signal: exit WITHOUT settling
    // (review finding 5) — resume re-spawns from the durable outbox. Only
    // the captured signal is consulted: the current controller may already
    // be a fresh post-resume one whose signal is NOT aborted.
    while (!this.stopped && !pauseSignal.aborted && !recoveryStop.signal.aborted && Date.now() < deadline) {
      if (recoveryRetiredLeave(this.db, origin, row.op_seq)) return;
      const stillOpen = readOutboxRow(this.db, requestId);
      if (!stillOpen || stillOpen.settled_at !== null) return;
      let settled = false;
      let keyChanged = false;
      try {
        // Each retry re-signs the time window (fresh nonce); the semantic
        // request_id/op_seq never change.
        const ack = await client.leave({
          opSeq: row.op_seq,
          requestId,
          installationId: row.installation_id || this.installationId,
          nonce: `retry-${Date.now()}`,
          signal: stopSignal,
          // Pre-send durable-owner check (after signing, before the POST):
          // another process's takeover between sign and send cancels the
          // send — zero posts from a dead epoch, independent of timer
          // callbacks (resume-review probe 'sign').
          authorizeSend: () => {
            if (recoveryRetiredLeave(this.db, origin, row!.op_seq)) throw new Error('HOUSE_RECOVERY_OLD_LEAVE');
            if (!this.ownerAuth) return;
            if (ownerEpoch === null || !this.ownerAuth.isEpochCurrent(ownerEpoch)) {
              throw new Error('leave send refused: durable owner epoch lost');
            }
          },
        });
        if (pauseSignal.aborted || recoveryStop.signal.aborted || recoveryRetiredLeave(this.db, origin, row.op_seq)) {
          // Ownership lost while this request was in flight: the verified
          // ack settles NOTHING here — the next owner's worker replays the
          // same request_id (server idempotency returns the same decision).
          return;
        }
        if (this.ownerAuth && (ownerEpoch === null || !this.ownerAuth.isEpochCurrent(ownerEpoch))) {
          // A DURABLE takeover landed while the request was in flight (the
          // local pause signal never fired — different process). The ack
          // settles nothing; the new owner's worker replays the request_id.
          return;
        }
        if (ack.verified && LEAVE_SETTLED_OUTCOMES.has(ack.outcome)) {
          settleOutboxRow(this.db, requestId, 'confirmed', this.nowSecs());
          settled = true;
        } else if (!ack.verified) {
          // Re-keyed/crossed ack: never settles; record the error and keep
          // backing off (a real key change needs explicit handling).
          keyChanged = true;
        }
      } catch {
        // network/HTTP error → backoff and retry, UNLESS the durable owner
        // epoch is gone: a dead-epoch worker has nothing to retry — the
        // current owner's resume respawns the outbox row. Exiting here (no
        // backoff sleep) also keeps waitForQuiet bounded under fake timers.
        if (this.ownerAuth && (ownerEpoch === null || !this.ownerAuth.isEpochCurrent(ownerEpoch))) {
          return;
        }
      }
      if (settled) return;
      if (keyChanged) {
        this.db.execute(
          `UPDATE house_participation SET remote_error = 'leave ack failed verification (house key changed?)', updated_at = ?
           WHERE house_origin = ? AND desired = 'disabled'`,
          [this.nowSecs(), origin],
        );
      }
      if (!(await this.interruptibleSleep(delay, pauseSignal))) return;
      delay = Math.min(delay * 2, this.retryMaxMs);
    }
  }

  /** Interruptible sleep against the worker's CAPTURED pause signal: false
   * immediately after stopHost or the quiesce that aborted it. */
  private async interruptibleSleep(ms: number, pauseSignal: AbortSignal): Promise<boolean> {
    const step = 100;
    let waited = 0;
    while (waited < ms) {
      if (this.stopped || pauseSignal.aborted) return false;
      await sleep(Math.min(step, ms - waited));
      waited += step;
    }
    return !this.stopped && !pauseSignal.aborted;
  }

  private openGate(origin: string): void {
    // Polling or a durable-change hint cannot undo a failed local logout.
    if (this.localLogoutFences.has(origin)) { this.closeGate(origin); return; }
    const row = readParticipation(this.db, origin);
    const persistGeneration = row ? `${row.op_seq}:${row.session_id}` : '';
    const existing = this.gates.get(origin);
    if (
      existing &&
      !existing.controller.signal.aborted &&
      existing.persistGeneration === persistGeneration
    ) {
      return; // same persistent generation — keep the live controller
    }
    if (existing) {
      existing.controller.abort(new Error(`gate superseded (persistent generation advanced): ${origin}`));
    }
    this.gates.set(origin, {
      generation: (existing?.generation ?? 0) + 1,
      controller: new AbortController(),
      persistGeneration,
      ...(row?.session_id === '' ? {legacyTrust: captureLegacyTrust(this.db, origin)} : {}),
    });
  }

  private closeGate(origin: string): void {
    const existing = this.gates.get(origin);
    if (existing) {
      existing.controller.abort(new Error(`house disabled: ${origin}`));
    }
  }

  private nowSecs(): number {
    return Math.floor(this.clock() / 1000);
  }
}

const NEVER_OPENED: AbortSignal = (() => {
  const c = new AbortController();
  c.abort(new Error('gate never opened'));
  return c.signal;
})();

/** Union of the per-call flight signal and the manager stop signal. */
function composeFlightSignal(...input: (AbortSignal | undefined)[]): AbortSignal {
  const signals = input.filter((s): s is AbortSignal => !!s);
  if (signals.length === 0) return new AbortController().signal;
  const anyOf = (AbortSignal as unknown as { any?: (ss: AbortSignal[]) => AbortSignal }).any;
  if (anyOf) return anyOf(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { ParticipationRow };
