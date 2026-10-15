import { HouseLoginExecution, ERROR_CODE_NAMES } from './login-execution.js';
import { composeFlightSignal } from './flight-signal.js';

import type { HouseParticipationAdmissionPort, HouseParticipationSource } from './participation-admission.js';
import { cancelInitialSetup } from './participation-journal.js';
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

import { houseKeyFromAckHex } from '../../world/house-binding.js';
import { pinnedBinding } from '../../world/house-binding-pin.js';
import { readVerifiedDeclaration } from '../../world/house-read-declaration.js';
import { configuredFirstPinPort, configuredPublicPinPort, type ConfiguredFirstPinPort, type ConfiguredPublicPinPort } from './configured-first-pin.js';
import { storageDatabasePathAllowed } from '../../host/storage-maintenance.js';
import { captureLegacyTrust, legacyTrustCurrent, type LegacyTrustCapture } from './legacy-trust.js';
import { emptyControlState } from './legacy-history.js';
import type { HouseReadFailureCode } from './read-failure.js';
import type { HostDb } from '../../host/host-db.js';
import type { TrustedManifestInput, PreparedTrustedManifest } from './trusted-manifest.js';
export type { TrustedManifestInput, PreparedTrustedManifest } from './trusted-manifest.js';
import { normalizeAckKeyHex, HouseSessionControlClient, HOUSE_SESSION_ENDPOINT, newRequestId, normalizeHouseOrigin, type ControlAck, type LifecycleFetch, type ControlSigner } from './control-client.js';
import { commitLocalLogout, ensureHouseLifecycleSchema, listOpenOutbox, nextRenewalAt, readOutboxRow, readParticipation, settleOutboxRow, type ParticipationRow } from './participation-store.js';

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
  /** Verified local participation; this does not claim a remote session. */
  admission?: 'configured';
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
  readonly participationSource?: HouseParticipationSource;
}

export interface ManagerOptions {
  participation?: HouseParticipationAdmissionPort;
  actorId?: string;
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
  configuredTrustRequired: boolean;
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
export { ERROR_CODE_NAMES } from './login-execution.js';

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
  private readonly configuredPinFor: (origin: string) => string;
  private readonly legacyRecoveryConfigured: (origin: string) => boolean;
  private readonly gates = new Map<string, GateState>();
  private readonly loginExecution: HouseLoginExecution;
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
  private readonly configuredPinningMode: 'static' | 'public-v1';
  private readonly configuredParticipationRequired: boolean;

  private readonly participation: HouseParticipationAdmissionPort | undefined;
  private readonly actorId: string | undefined;
  constructor(opts: ManagerOptions) {
    this.participation = opts.participation;
    this.actorId = opts.actorId;
    this.configuredPinningMode = opts.configuredPinningMode ?? 'static';
    // HouseRuntime selects this policy for the whole native configured lane.
    // It remains required on a new runtime even for an origin removed from config.
    this.configuredParticipationRequired = opts.configuredPinningMode === 'static';
    this.db = opts.db;
    this.signer = opts.signer;
    this.installationId = opts.installationId;
    this.fetchImpl = opts.fetch ?? fetch;
    this.clock = opts.clock ?? (() => Date.now());
    this.retryBackoffMs = opts.retryBackoffMs ?? 5_000;
    this.retryMaxMs = opts.retryMaxMs ?? 30_000;
    this.configuredPinFor = (origin) => {
      const pin = opts.configuredPinFor?.(origin) ?? '';
      return pin ? normalizeAckKeyHex(pin) : '';
    };
    this.legacyRecoveryConfigured = opts.legacyRecoveryConfigured ?? (() => false);
    ensureHouseLifecycleSchema(this.db);
    this.configuredFirstPin = configuredFirstPinPort({ db: this.db, installationId: this.installationId,
      // An admission port owns static participation; config cannot preseed it.
      selected: () => !this.participation && opts.configuredPinningMode !== 'public-v1',
      configured: this.legacyRecoveryConfigured, configuredPin: this.configuredPinFor,
      fence: origin => this.localLogoutFences.get(origin),
      cancellationEpoch: origin => this.localLogoutEpochs.get(origin) ?? 0, stopped: () => this.stopped,
      seed: origin => { this.seedLegacyHouse(origin); } });
    this.configuredPublicPin = configuredPublicPinPort({ db: this.db,
      selected: () => opts.configuredPinningMode === 'public-v1',
      configured: this.legacyRecoveryConfigured, configuredPin: this.configuredPinFor,
      fence: origin => this.localLogoutFences.get(origin),
      cancellationEpoch: origin => this.localLogoutEpochs.get(origin) ?? 0, stopped: () => this.stopped });
    this.loginExecution = new HouseLoginExecution({
      db: this.db, installationId: this.installationId, signer: this.signer,
      fetchImpl: this.fetchImpl, clock: this.clock, configuredPinFor: this.configuredPinFor,
      legacyRecoveryConfigured: this.legacyRecoveryConfigured, participation: this.participation,
      actorId: this.actorId, prepareTrustedManifest: opts.prepareTrustedManifest,
      revokeTrustedManifest: opts.revokeTrustedManifest, prepareRelationBinding: opts.prepareRelationBinding,
      onRelationBindingRefused: opts.onRelationBindingRefused,
    }, {
      captureAuthority: () => {
        const ownerEpoch = this.ownerAuth?.captureEpoch() ?? null;
        return { ownerBound: () => this.ownerAuth !== null,
          authorized: () => !this.stopped && (!this.ownerAuth || (ownerEpoch !== null
            && this.ownerAuth.isEpochCurrent(ownerEpoch) && !this.pauseController.signal.aborted)) };
      },
      captureLogoutRelease: (origin, authority, direct, authorized) => {
        const fence = this.localLogoutFences.get(origin);
        return () => {
          if ((authority || (direct && this.ownerAuth === null)) && authorized()
            && this.localLogoutFences.get(origin) === fence) this.localLogoutFences.delete(origin);
        };
      },
      ownerEpoch: () => this.ownerAuth?.captureEpoch() ?? null,
      signals: () => ({ stop: this.stopController.signal, pause: this.pauseController.signal }),
      openGate: origin => this.openGate(origin), closeGate: origin => this.closeGate(origin),
      gateActive: origin => this.gateFor(origin).isActive(),
      isConfiguredParticipation: origin => this.isConfiguredParticipation(origin),
      legacyParticipationTrustCurrent: (origin, trust, configured) => this.legacyParticipationTrustCurrent(origin, trust, configured),
      trackTask: (origin, operation) => {
        const task = operation.then(() => undefined, () => undefined).finally(() => this.controlTasks.delete(task));
        this.controlTasks.add(task);
        const houseTasks = this.houseControlTasks.get(origin) ?? new Set<Promise<void>>();
        houseTasks.add(task); this.houseControlTasks.set(origin, houseTasks);
        void task.finally(() => houseTasks.delete(task));
      },
    });
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

  /** Positively selected ordinary entry, independent of a failed session request. */
  isConfiguredParticipation(origin: string): boolean {
    return this.configuredPinningMode === 'static' && this.legacyRecoveryConfigured(origin);
  }

  /** Shared by resident and foreground reads: configuration names an origin,
   * but only its verified binding can open that origin's sessionless lane. */
  legacyParticipationTrustCurrent(origin: string, trust: LegacyTrustCapture | undefined,
    configured = this.isConfiguredParticipation(origin)): boolean {
    try {
      if (!legacyTrustCurrent(this.db, trust)) return false;
      if (!this.participation && (configured || this.configuredParticipationRequired) && (!this.isConfiguredParticipation(origin) || !trust?.binding)) return false;
      const pin = this.configuredPinFor(origin);
      return !pin || trust?.binding?.houseKey === houseKeyFromAckHex(pin);
    } catch { return false; }
  }

  /** Per-house generation gate. A handle binds the captured in-memory
   * generation AND the persistent generation (op_seq/session) — after
   * another same-root process logs out and re-logs-in, this process's old
   * handle has an unchanged in-memory generation but the persistent
   * generation has moved on, so isActive must be false. */
  /** A local read must respect logout even if its durable transaction failed.
   * Reuse the existing revocation epoch; receiving ownership is not involved. */
  captureLocalReadFence(input: string): () => boolean {
    const origin = normalizeHouseOrigin(input);
    const epoch = this.localLogoutEpochs.get(origin) ?? 0;
    const allowed = !this.stopped && !this.localLogoutFences.has(origin);
    return () => allowed && !this.stopped && !this.localLogoutFences.has(origin)
      && (this.localLogoutEpochs.get(origin) ?? 0) === epoch;
  }

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
        if (capturedSession === '' && !this.legacyParticipationTrustCurrent(origin, trust, state?.configuredTrustRequired ?? this.isConfiguredParticipation(origin))) return 'HOUSE_TRUST_REVOKED';
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
        if (capturedSession === '' && !this.legacyParticipationTrustCurrent(origin, trust, state?.configuredTrustRequired ?? this.isConfiguredParticipation(origin))) return false;
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
    return this.loginExecution.login(input, authority, true);
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

  /** Recover only undecided network attempts or our own expired session,
   * including a verified LEASE_EXPIRED renewal of that session.
   * Other definitive rejections (in particular EXECUTOR_BUSY) never start a
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
      if (!authorized() || this.loginExecution.hasFlight(row.house_origin) || this.renewFlights.has(row.house_origin)) return;
      const reserved = this.db.transaction(tx => {
        const latest = readParticipation(tx, row.house_origin);
        if (!authorized() || latest?.op_seq !== row.op_seq || latest.desired !== 'enabled') return false;
        tx.execute('UPDATE house_participation SET renew_after = ? WHERE house_origin = ?',
          [this.nowSecs() + Math.max(1, Math.ceil(this.retryBackoffMs / 1000)), row.house_origin]);
        return true;
      });
      if (reserved) await this.loginExecution.login(row.house_origin, undefined, false);
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
        // The original ENTER remains confirmed history, not live authority.
        // Only this verified expiry may use the existing expired-session
        // recovery selector; all other rejections keep its stop boundary.
        const expired = ack.errorCode === 7 && !ack.sessionActive
          && !this.localLogoutFences.has(origin) && !houseBindingBlocked(tx, origin)
          && !houseRecoveryHeld(tx, origin) && storageDatabasePathAllowed(tx, 'execution');
        tx.execute('UPDATE house_participation SET phase = ?, remote_status = ?, remote_error = ? WHERE house_origin = ?',
          [expired ? 'connecting' : 'reconnecting', expired ? 'confirmed' : 'error', `renew rejected: ${code}`, origin]);
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
    if (this.participation && this.actorId && origin === 'https://house.popclaw.me') this.db.transaction(tx => cancelInitialSetup(tx,this.actorId!,this.installationId));
    if (this.participation) this.db.execute(`UPDATE house_initial_setup SET state='cancelled' WHERE original_intent_ref IN
      (SELECT original_intent_ref FROM house_participation_attempts WHERE json_extract(plan_json,'$.origin')=?)`,[origin]);
    const requestId = newRequestId();
    // Abort any in-flight login for this house FIRST — its discovery/signing/
    // fetch awaits must not resume into a re-enabled row (review counter-
    // examples 1+2), and its in-air ENTER is torn down via the signal.
    this.loginExecution.cancel(origin, new Error(`logout: ${origin}`));
    const row = readParticipation(this.db, origin);
    // Trust sources for the leave pin, in order (handoff §18:26 + round-3
    // probe): the operator's configured pin beats everything and fills an
    // empty binding; else the durable binding; else unknown. A configured pin
    // on a legacy-classified house still wins — the operator's pin is an
    // explicit trust statement that outranks a stale 'unsupported' snapshot.
    const configuredPin = this.configuredPinFor(origin);
    let binding: ReturnType<typeof pinnedBinding>;
    if (this.isConfiguredParticipation(origin)) {
      try { binding = pinnedBinding(this.db, origin); } catch { /* Local logout never grants trust. */ }
    }
    const configuredWithoutSession = this.isConfiguredParticipation(origin) && emptyControlState(row)
      && row.installation_id === this.installationId && binding !== undefined
      && readVerifiedDeclaration(this.db, binding)?.sessionBoard === false;
    const pinnedKey = configuredWithoutSession ? '' : row?.ack_key_hex || configuredPin;
    // Three states (review): key bound -> the leave goes under the pinned
    // key; probed legacy (an earlier discovery explicitly found no control
    // plane) -> terminal unsupported; discovery never completed (network
    // window) -> unknown, an empty-key outbox row is written and classified
    // on retry — "no ack yet" is never treated as "no control plane".
    const knownLegacy = configuredWithoutSession || (!pinnedKey && row?.remote_status === 'unsupported');
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
    if (configuredPin && !row?.ack_key_hex && !configuredWithoutSession) {
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
    this.loginExecution.cancelAll(new Error('stopHost'));
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
    this.loginExecution.cancelAll(new Error('lifecycle ownership lost'));
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
    this.loginExecution.cancel(origin, new Error('HOUSE_RECOVERY_HELD'));
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
      configuredTrustRequired: this.isConfiguredParticipation(origin),
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


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { ParticipationRow };
