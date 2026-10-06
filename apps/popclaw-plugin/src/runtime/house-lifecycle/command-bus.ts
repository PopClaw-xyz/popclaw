import { localDatabasePath } from '../../host/local-host-db.js';
import { houseBindingBlocked } from '../../world/house-recovery-fence.js';
import { storageDatabasePathAllowed } from '../../host/storage-maintenance.js';
/** Same-data-root request/reply IPC. SQLite is the transport, so commands
 * survive a caller exit or owner takeover without a second network daemon. */
import type { PushResult } from '../../egress/event-egress.js';
import type { HostDb } from '../../host/host-db.js';
import type { HouseLifecycleCoordinator } from './coordinator.js';
import type { HouseStatus, LoginResult, LogoutResult, OwnerAuthority } from './manager.js';
import { newRequestId, normalizeHouseOrigin } from './control-client.js';
import { readParticipation } from './participation-store.js';
import { captureLegacyTrust, legacyTrustCurrent, type LegacyTrustCapture } from './legacy-trust.js';
import { serializeLegacyPushCapture, parseLegacyPushCapture } from './push-capture.js';
import { captureHousePushEffect, parseHousePushEffect, type HousePushEffectReference } from './push-effect.js';

export type HouseCommandPort = Pick<HouseLifecycleCoordinator,
  'loginHouse' | 'logoutHouse' | 'getHouseStatus' | 'knownHouseOrigins'> & {
  reconfirmHouse?(decisionId: string, origin: string): Promise<unknown>;
};
/** /v1/push uses Axum's Bytes extractor with its unchanged 2 MiB default. */
export const MAX_IPC_PUSH_BYTES = 2 * 1024 * 1024;
export interface CommandPushResult extends PushResult {
  readonly operationId: string;
  readonly state: 'pending' | 'unknown' | 'failed' | 'done';
  readonly errorCode?: 'STALE_OPERATION' | 'ACTION_RESULT_UNKNOWN';
}
export interface PushOperation {
  readonly operationId: string;
  readonly state: 'pending' | 'running' | 'done';
  readonly result?: CommandPushResult;
}
/** Executor must call authorizeSend after its awaits, immediately before HTTP.
 * This local authority does not assert atomicity with a remote business commit. */
export interface PushExecutionContext {
  readonly operationId: string;
  readonly effectReference?: HousePushEffectReference;
  readonly opSeq: number;
  readonly sessionId: string;
  readonly houseRevision: number;
  readonly ackKeyHex: string;
  readonly installationId: string;
  readonly ownerEpoch: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  isActive(): boolean;
  authorizeSend(): void;
}
import type { HouseParticipationSource } from './participation-admission.js';
interface CommandRow {
  request_id: string;
  kind: 'login' | 'status' | 'push' | 'recovery';
  house_origin: string;
  baseline_seq: number;
  state: 'pending' | 'running' | 'done';
  running_epoch: number | null;
  result_json: string | null;
  payload_bytes: Uint8Array | null;
  effect_json: string | null;
  session_id: string | null;
  house_revision: number | null;
  ack_key_hex: string | null;
  installation_id: string | null;
  deadline_at: number | null;
}
export interface HouseCommandBusOptions {
  db: HostDb;
  whenReady?: () => Promise<void>;
  captureLogin?: (origin: string) => HouseParticipationSource | undefined;
  coordinator: HouseCommandPort;
  authority: OwnerAuthority;
  executePush?: (origin: string, bytes: Uint8Array, context: PushExecutionContext) => Promise<PushResult>;
  /** Absolute action lifetime starts at enqueue; caller wait timeout is separate. */
  pushDeadlineMs?: number;
  pollMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

// Notifications are hints only: SQLite remains the durable transport. Other
// processes and epoch takeovers are covered by the bounded idle timer.
const localWakeups = new Map<string | HostDb, Set<() => void>>();

export class HouseCommandBus implements HouseCommandPort {
  private readonly stoppedSignal = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private idleDelay = 0;
  private readonly wakeKey: string | HostDb;
  private readonly onWake = () => { if (this.started) this.wake(); };
  private readonly executions = new Map<string, Promise<void>>();
  private readonly origins = new Set<string>();
  private readonly callers = new Set<Promise<unknown>>();
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  constructor(private readonly opts: HouseCommandBusOptions) {
    this.pollMs = opts.pollMs ?? 50;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.wakeKey = localDatabasePath(opts.db) ?? opts.db;
    opts.db.execute(`CREATE TABLE IF NOT EXISTS house_lifecycle_commands (
      request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, house_origin TEXT NOT NULL,
      baseline_seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      running_epoch INTEGER, result_json TEXT, created_at INTEGER NOT NULL
    )`);
    opts.db.transaction(tx => {
      const columns = new Set(tx.queryAll<{ name: string }>('PRAGMA table_info(house_lifecycle_commands)').map(c => c.name));
      for (const [name, type] of Object.entries({ payload_bytes: 'BLOB', effect_json: 'TEXT', session_id: 'TEXT', house_revision: 'INTEGER', ack_key_hex: 'TEXT', installation_id: 'TEXT', deadline_at: 'INTEGER' })) {
        if (!columns.has(name)) tx.execute(`ALTER TABLE house_lifecycle_commands ADD COLUMN ${name} ${type}`);
      }
    });
    opts.db.execute('CREATE INDEX IF NOT EXISTS house_commands_pending ON house_lifecycle_commands(state, created_at)');
    const listeners = localWakeups.get(this.wakeKey) ?? new Set<() => void>();
    listeners.add(this.onWake);
    localWakeups.set(this.wakeKey, listeners);
  }

  start(): void {
    if (this.started || this.stoppedSignal.signal.aborted) return;
    this.started = true;
    this.wake();
  }

  private schedule(): void {
    if (!this.started || this.stoppedSignal.signal.aborted) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const activity = this.pump();
      this.idleDelay = activity ? this.pollMs : Math.min(1_000, Math.max(this.pollMs, this.idleDelay * 2));
      this.schedule();
    }, this.idleDelay);
    this.timer.unref?.();
  }

  private wake(): void {
    if (this.stoppedSignal.signal.aborted) return;
    this.idleDelay = this.pollMs;
    this.pump();
    this.schedule();
  }

  private notifyLocal(): void {
    if (!this.started) this.pump();
    for (const wake of localWakeups.get(this.wakeKey) ?? []) wake();
  }

  loginHouse(input: string, authority?: import('./manager.js').LoginAuthority): Promise<LoginResult> {
    const source = authority?.participationSource ?? this.opts.captureLogin?.(normalizeHouseOrigin(input));
    return this.trackCaller(this.loginHouseInner(input, source));
  }

  private async loginHouseInner(input: string, source?: HouseParticipationSource): Promise<LoginResult> {
    if (!storageDatabasePathAllowed(this.opts.db, 'execution')) throw new Error('STORAGE_RECOVERY_HELD');
    const origin = normalizeHouseOrigin(input);
    const requestId = newRequestId();
    const pending: LoginResult = { scope: 'local_installation', origin, status: 'connecting', sessionId: '', operationId: requestId };
    if (this.stoppedSignal.signal.aborted) return pending;
    this.enqueue(requestId, 'login', origin, source);
    return await this.wait<LoginResult>(requestId) ?? pending;
  }

  reconfirmHouse(decisionId: string, origin: string): Promise<unknown> {
    return this.trackCaller(this.reconfirmHouseInner(decisionId,origin));
  }
  private async reconfirmHouseInner(decisionId: string, origin: string): Promise<unknown> {
    if (this.stoppedSignal.signal.aborted) throw new Error('HOUSE_RUNTIME_STOPPED');
    this.enqueue(decisionId, 'recovery', origin);
    return await this.wait<unknown>(decisionId) ?? {status:'held',decision_id:decisionId,origin};
  }

  /** One durable operation per invocation. An uncertain result must be queried
   * with its operationId, never automatically retried as a new push. */
  push(input: string, bytes: Uint8Array, effectReference?: HousePushEffectReference): Promise<CommandPushResult> {
    return this.trackCaller(this.pushInner(input, bytes, effectReference));
  }

  private async pushInner(input: string, bytes: Uint8Array, effectReference?: HousePushEffectReference): Promise<CommandPushResult> {
    const effect = effectReference === undefined ? undefined : captureHousePushEffect(effectReference);
    const origin = normalizeHouseOrigin(input);
    const operationId = newRequestId();
    if (this.stoppedSignal.signal.aborted) return this.pushFailure(operationId, 409, 'command bus stopped', 'STALE_OPERATION');
    if (bytes.byteLength > MAX_IPC_PUSH_BYTES) return this.pushFailure(operationId, 413, 'signed payload exceeds 2 MiB');
    const deadlineAt = Date.now() + Math.max(1, this.opts.pushDeadlineMs ?? 30_000);
    const enqueued = this.opts.db.transaction(tx => {
      if (!storageDatabasePathAllowed(this.opts.db, 'execution')) return false;
      const row = readParticipation(tx, origin);
      if (houseBindingBlocked(tx,origin) || !row || row.desired !== 'enabled' || row.phase !== 'connected'
        || (row.session_id !== '' && row.lease_expires_at <= Math.floor(Date.now() / 1000))) return false;
      let effectJson = effect === undefined ? null : JSON.stringify(effect);
      if (row.session_id === '') {
        const trust = captureLegacyTrust(tx, origin);
        if (!trust) return false;
        effectJson = serializeLegacyPushCapture(trust, effect);
      }
      tx.execute(`INSERT INTO house_lifecycle_commands
        (request_id,kind,house_origin,baseline_seq,created_at,payload_bytes,effect_json,session_id,house_revision,ack_key_hex,installation_id,deadline_at)
        VALUES (?,'push',?,?,?,?,?,?,?,?,?,?)`,
      [operationId, origin, row.op_seq, Date.now(), new Uint8Array(bytes), effectJson, row.session_id, row.house_revision, row.ack_key_hex, row.installation_id, deadlineAt]);
      return true;
    });
    if (!enqueued) return this.pushFailure(operationId, 409, 'house participation is not active', 'STALE_OPERATION');
    try {
      this.notifyLocal();
      const result = await this.wait<CommandPushResult>(operationId);
      if (result) return result;
      // stop() still awaits this continuation before the caller may close SQLite.
      const operation = this.readPushOperation(operationId);
      if (operation?.result) return operation.result;
      if (operation?.state === 'pending') return { status: 0, operationId, state: 'pending', detail: `operation ${operationId}: queued; execution not confirmed` };
    } catch {
      // Enqueue committed: owner execution may already have reached the remote.
      // Preserve the durable ID even when authority or result reads fail.
    }
    return this.pushUnknown(operationId);
  }

  getPushOperation(operationId: string): PushOperation | null {
    if (this.stoppedSignal.signal.aborted) return null;
    return this.readPushOperation(operationId);
  }

  private readPushOperation(operationId: string): PushOperation | null {
    const row = this.opts.db.queryOne<CommandRow>("SELECT * FROM house_lifecycle_commands WHERE request_id = ? AND kind = 'push'", [operationId]);
    return row ? { operationId, state: row.state, ...(row.result_json ? { result: JSON.parse(row.result_json) as CommandPushResult } : {}) } : null;
  }

  private pushFailure(operationId: string, status: number, detail: string, errorCode?: 'STALE_OPERATION'): CommandPushResult {
    return { status, operationId, state: 'failed', detail: `operation ${operationId}: ${detail}`, ...(errorCode ? { errorCode } : {}) };
  }
  private pushUnknown(operationId: string): CommandPushResult {
    return { status: 0, operationId, state: 'unknown', errorCode: 'ACTION_RESULT_UNKNOWN', detail: `operation ${operationId}: remote result unknown; query this operation before any further action` };
  }

  private pushCurrent(row: CommandRow): boolean {
    if (houseBindingBlocked(this.opts.db,row.house_origin)) return false;
    if (row.deadline_at === null || row.deadline_at <= Date.now()) return false;
    const latest = readParticipation(this.opts.db, row.house_origin);
    return !!latest && latest.desired === 'enabled' && latest.phase === 'connected'
      && latest.op_seq === row.baseline_seq && latest.session_id === row.session_id
      && latest.house_revision === row.house_revision && latest.ack_key_hex === row.ack_key_hex
      && latest.installation_id === row.installation_id
      && (latest.session_id === '' || latest.lease_expires_at > Math.floor(Date.now() / 1000));
  }

  /** Local disable/outbox commit must never wait for the owner or an IPC
   * reply. The manager is owner-bound; a reader cannot send that leave. */
  logoutHouse(input: string): Promise<LogoutResult> {
    if (this.stoppedSignal.signal.aborted) return Promise.reject(new Error('lifecycle command bus stopped'));
    return this.trackCaller(this.opts.coordinator.logoutHouse(input));
  }

  getHouseStatus(input: string): Promise<HouseStatus> {
    return this.trackCaller(this.getHouseStatusInner(input));
  }

  private async getHouseStatusInner(input: string): Promise<HouseStatus> {
    const origin = normalizeHouseOrigin(input);
    if (this.stoppedSignal.signal.aborted) throw new Error('lifecycle command bus stopped');
    const requestId = newRequestId();
    this.enqueue(requestId, 'status', origin);
    const result = await this.wait<HouseStatus>(requestId);
    if (result) return result;
    if (this.stoppedSignal.signal.aborted) throw new Error('lifecycle command bus stopped');
    return this.opts.coordinator.getHouseStatus(origin);
  }

  knownHouseOrigins(): string[] {
    return this.stoppedSignal.signal.aborted ? [] : this.opts.coordinator.knownHouseOrigins();
  }

  /** Root first cancels resident resources/control work, then awaits this
   * drain before closing SQLite. No completion callback touches a stopped DB. */
  async stop(): Promise<void> {
    this.stoppedSignal.abort();
    if (this.timer) clearTimeout(this.timer);
    this.started = false;
    const listeners = localWakeups.get(this.wakeKey);
    listeners?.delete(this.onWake);
    if (!listeners?.size) localWakeups.delete(this.wakeKey);
    this.timer = null;
    await Promise.allSettled([...this.executions.values(), ...this.callers]);
  }

  private enqueue(requestId: string, kind: CommandRow['kind'], origin: string, source?: HouseParticipationSource): void {
    this.opts.db.transaction(tx => {
      const baseline = readParticipation(tx, origin)?.op_seq ?? 0;
      const expectedEpoch = kind === 'recovery' ? tx.queryOne<{generation:number;holder:string}>('SELECT generation,holder FROM house_lifecycle_owner WHERE id=1') : null;
      tx.execute(`INSERT INTO house_lifecycle_commands
        (request_id, kind, house_origin, baseline_seq, created_at, running_epoch, effect_json) VALUES (?,?,?,?,?,?,?)`,
      [requestId, kind, origin, baseline, Date.now(), expectedEpoch?.holder ? expectedEpoch.generation : null, source ? JSON.stringify({participationSource:source}) : null]);
    });
    this.notifyLocal();
  }

  /** Track the entire public call, including timeout fallbacks after polling. */
  private trackCaller<T>(result: Promise<T>): Promise<T> {
    this.callers.add(result);
    void result.then(() => this.callers.delete(result), () => this.callers.delete(result));
    return result;
  }

  private async wait<T>(requestId: string): Promise<T | undefined> {
    const deadline = performance.now() + this.timeoutMs;
    while (!this.stoppedSignal.signal.aborted && performance.now() < deadline) {
      const row = this.opts.db.queryOne<CommandRow>('SELECT * FROM house_lifecycle_commands WHERE request_id = ?', [requestId]);
      if (row?.state === 'done' && row.result_json) {
        const result = JSON.parse(row.result_json) as T & { error?: string };
        if (result.error) throw new Error(result.error);
        return result;
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.stoppedSignal.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, this.pollMs);
        this.stoppedSignal.signal.addEventListener('abort', done, { once: true });
      });
    }
    return undefined;
  }

  private pump(): boolean {
    if (!storageDatabasePathAllowed(this.opts.db, 'execution')) return false;
    if (this.stoppedSignal.signal.aborted) return false;
    const epoch = this.opts.authority.captureEpoch();
    if (epoch === null) return false;
    try {
      // A claimed push may already have reached a non-idempotent remote
      // consumer. Epoch takeover records uncertainty instead of replaying it.
      this.opts.db.transaction(tx => {
        if (!this.opts.authority.isEpochCurrent(epoch)) return;
        // A held approval belongs to the resident generation present when
        // it was consumed, even if the caller exited before command enqueue.
        if (tx.queryOne("SELECT 1 FROM sqlite_master WHERE type='table' AND name='house_recovery_decisions_v1'")) {
          tx.execute(`UPDATE house_recovery_decisions_v1 SET state='failed',detail='HOUSE_RECOVERY_INTERRUPTED'
            WHERE state IN ('approved','applying') AND (approved_epoch IS NULL OR approved_epoch != ?)
            AND decision_id IN (SELECT decision_id FROM house_recovery_fences_v1 WHERE state='held')`,[epoch]);
        }
        const orphaned = tx.queryAll<CommandRow>("SELECT * FROM house_lifecycle_commands WHERE kind = 'push' AND state = 'running' AND running_epoch != ?", [epoch]);
        for (const row of orphaned) tx.execute("UPDATE house_lifecycle_commands SET state = 'done', result_json = ?, payload_bytes = NULL WHERE request_id = ?", [JSON.stringify(this.pushUnknown(row.request_id)), row.request_id]);
      });
      const busy = [...this.origins];
      const excludeBusy = busy.length ? `AND house_origin NOT IN (${busy.map(() => '?').join(',')})` : '';
      const rows = this.opts.db.queryAll<CommandRow>(`SELECT * FROM house_lifecycle_commands
        WHERE (state = 'pending' OR (state = 'running' AND running_epoch != ?)) ${excludeBusy}
        ORDER BY created_at, request_id LIMIT 32`, [epoch, ...busy]);
      for (const row of rows) {
        if (this.executions.has(row.request_id) || this.origins.has(row.house_origin)) continue;
        const claimed = this.opts.db.transaction(tx => {
          if (this.stoppedSignal.signal.aborted || !this.opts.authority.isEpochCurrent(epoch)) return false;
          if (row.kind === 'recovery' && (row.state !== 'pending' || row.running_epoch !== epoch)) {
            tx.execute("UPDATE house_lifecycle_commands SET state='done',result_json=? WHERE request_id=?",[JSON.stringify({error:'HOUSE_RECOVERY_INTERRUPTED'}),row.request_id]);
            return false;
          }
          if (row.kind === 'push' && !this.pushCurrent(row)) {
            const result = this.pushFailure(row.request_id, row.deadline_at !== null && row.deadline_at <= Date.now() ? 408 : 409,
              row.deadline_at !== null && row.deadline_at <= Date.now() ? 'deadline expired before execution' : 'captured participation changed', 'STALE_OPERATION');
            tx.execute("UPDATE house_lifecycle_commands SET state = 'done', result_json = ?, payload_bytes = NULL WHERE request_id = ? AND state = 'pending'", [JSON.stringify(result), row.request_id]);
            return false;
          }
          return tx.execute(`UPDATE house_lifecycle_commands SET state = 'running', running_epoch = ?
            WHERE request_id = ? AND (state = 'pending' OR (state = 'running' AND running_epoch != ?))`,
          [epoch, row.request_id, epoch]).changes === 1;
        });
        if (!claimed) continue;
        this.origins.add(row.house_origin);
        const task = this.execute(row, epoch).catch(err => {
          this.opts.log?.(row.kind === 'push' ? `lifecycle IPC push persistence failed: ${row.request_id}` : `lifecycle IPC execution failed: ${String(err)}`);
          // A push may already have committed remotely: persist uncertainty
          // without replay. Idempotent control commands can be requeued.
          try {
            this.opts.db.transaction(tx => {
              if (this.stoppedSignal.signal.aborted || !this.opts.authority.isEpochCurrent(epoch)) return;
              if (row.kind === 'push') {
                tx.execute(`UPDATE house_lifecycle_commands SET state = 'done', result_json = ?, payload_bytes = NULL
                  WHERE request_id = ? AND state = 'running' AND running_epoch = ?`, [JSON.stringify(this.pushUnknown(row.request_id)), row.request_id, epoch]);
                return;
              }
              tx.execute(`UPDATE house_lifecycle_commands SET state = 'pending'
                WHERE request_id = ? AND state = 'running' AND running_epoch = ?`, [row.request_id, epoch]);
            });
          } catch (retryError) { this.opts.log?.(row.kind === 'push' ? `lifecycle IPC push result persistence failed: ${row.request_id}` : `lifecycle IPC retry persistence failed: ${String(retryError)}`); }
        }).finally(() => { this.executions.delete(row.request_id); this.origins.delete(row.house_origin); this.idleDelay = this.pollMs; this.schedule(); });
        this.executions.set(row.request_id, task);
      }
      return rows.length > 0;
    } catch (err) { this.opts.log?.(`lifecycle IPC poll failed: ${String(err)}`); return false; }
  }

  private async execute(row: CommandRow, epoch: number): Promise<void> {
    if (this.opts.whenReady) await this.opts.whenReady();
    if (row.kind === 'push') { await this.executePush(row, epoch); return; }
    let result: LoginResult | HouseStatus | { error: string };
    try {
      if (row.kind === 'recovery') {
        if (!this.opts.coordinator.reconfirmHouse) throw new Error('HOUSE_RECOVERY_UNAVAILABLE');
        result = await this.opts.coordinator.reconfirmHouse(row.request_id, row.house_origin) as {error:string};
      } else if (row.kind === 'login') {
        const latest = readParticipation(this.opts.db, row.house_origin);
        const seq = latest?.op_seq ?? 0;
        // One enabled advance is our interrupted ENTER (or a coalesced
        // duplicate login). Logout always increments the seq to disabled;
        // logout then login requires two advances and cancels the old request.
        const valid = seq === row.baseline_seq || (seq === row.baseline_seq + 1 && latest?.desired === 'enabled');
        // The authority travels ONLY on the valid branch. `valid` was just
        // re-checked against the live participation, so it says this command
        // still describes the world — which is the whole of what the
        // authority asserts.
        result = valid ? await this.opts.coordinator.loginHouse(row.house_origin, { requestId: row.request_id, ...(row.effect_json ? JSON.parse(row.effect_json) as {participationSource?:HouseParticipationSource} : {}) }) : {
          scope: 'local_installation', origin: row.house_origin, status: 'connecting', sessionId: '', errorCode: 'STALE_OPERATION',
        };
      } else result = await this.opts.coordinator.getHouseStatus(row.house_origin);
    } catch (err) { result = { error: String(err) }; }
    if (this.stoppedSignal.signal.aborted) return;
    this.opts.db.transaction(tx => {
      if (!this.opts.authority.isEpochCurrent(epoch)) return;
      tx.execute(`UPDATE house_lifecycle_commands SET state = 'done', result_json = ?
        WHERE request_id = ? AND state = 'running' AND running_epoch = ?`, [JSON.stringify(result), row.request_id, epoch]);
    });
  }
  private async executePush(row: CommandRow, epoch: number): Promise<void> {
    let effectReference: HousePushEffectReference | undefined;
    let trust: LegacyTrustCapture | undefined;
    let effectValid = true;
    try {
      if (row.session_id === '') {
        const capture = parseLegacyPushCapture(row.effect_json);
        if (capture.trust.origin !== row.house_origin) throw new Error('HOUSE_COMMAND_CAPTURE_ORIGIN');
        trust = capture.trust;
        effectReference = capture.effect ?? undefined;
      } else if (row.effect_json !== null) effectReference = parseHousePushEffect(row.effect_json);
    } catch { effectValid = false; }
    const isActive = () => {
      try { return !this.stoppedSignal.signal.aborted && this.opts.authority.isEpochCurrent(epoch)
        && storageDatabasePathAllowed(this.opts.db, 'execution') && this.pushCurrent(row)
        && (row.session_id !== '' || legacyTrustCurrent(this.opts.db, trust)); }
      catch { return false; }
    };
    const context: PushExecutionContext = Object.freeze({
      operationId: row.request_id, ...(effectReference ? {effectReference} : {}), opSeq: row.baseline_seq, sessionId: row.session_id!,
      houseRevision: row.house_revision!, ackKeyHex: row.ack_key_hex!, installationId: row.installation_id!,
      ownerEpoch: epoch, deadlineAt: row.deadline_at!, signal: this.stoppedSignal.signal, isActive,
      authorizeSend: () => { if (!isActive()) throw new Error('STALE_OPERATION'); },
    });
    let result: CommandPushResult;
    if (!effectValid) result = this.pushFailure(row.request_id, 409, 'missing or invalid immutable command capture/effect reference', 'STALE_OPERATION');
    else if (!isActive()) result = this.pushFailure(row.request_id, 409, 'captured participation changed before execution', 'STALE_OPERATION');
    else if (!this.opts.executePush) result = this.pushFailure(row.request_id, 503, 'owner push executor unavailable');
    else {
      try {
        context.authorizeSend();
        const receipt = await this.opts.executePush(row.house_origin, new Uint8Array(row.payload_bytes!), context);
        // A real receipt is evidence even if logout/deadline elapsed while it
        // travelled back. It does not re-authorize the old session.
        result = receipt.status === 0 || (trust && !legacyTrustCurrent(this.opts.db, trust)) ? this.pushUnknown(row.request_id)
          : { ...receipt, operationId: row.request_id, state: 'done' };
      } catch { result = this.pushUnknown(row.request_id); }
    }
    if (this.stoppedSignal.signal.aborted) return;
    this.opts.db.transaction(tx => {
      if (!this.opts.authority.isEpochCurrent(epoch)) return;
      tx.execute(`UPDATE house_lifecycle_commands SET state = 'done', result_json = ?, payload_bytes = NULL
        WHERE request_id = ? AND state = 'running' AND running_epoch = ?`, [JSON.stringify(result), row.request_id, epoch]);
    });
  }

}
