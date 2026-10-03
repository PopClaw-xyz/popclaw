/** Durable host-turn admission. This journal grants no world action or budget. */
import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';
import type { HouseGate } from './house-lifecycle/manager.js';
import { jsonObject, parseWorldJson } from '../world/json-profile.js';
import { worldPublicKey, worldUint64 } from '../world/action-wire.js';

export interface HostWorldTurnIdentity {
  house: { origin: string; houseKey: string; incarnation: string };
  actorId: string; jobId: string; turnId: string;
}
export interface HostWorldTurnFields extends HostWorldTurnIdentity {
  installationId: string; sessionId: string; fence: string; ticketId: string;
  sessionLeaseExpiresAt: number; ticketExpiresAt: number; validUntil: number;
  /** Digest of the coordinator's context; the complete input is independently hashed below. */
  contextDigest: string; prompt: string;
}
export interface HostWorldTurnInput extends HostWorldTurnFields { inputDigest: string }
export type HostWorldTurnPhase = 'dispatch' | 'read' | 'output';
export interface HostWorldTurnAuthority {
  gate: HouseGate;
  /** Synchronous current-state check. Must throw unless this exact ticket/session remains authorized. */
  check(input: Readonly<HostWorldTurnInput>, phase: HostWorldTurnPhase): void;
}
export interface HostWorldOutputRequest { runId: string; sessionKey: string; prompt: string; terminal: Record<string, unknown> }
export type HostWorldOutputEvidence =
  | { kind: 'bound'; text: string; source: 'terminal_reply_and_dedicated_transcript'; evidence: Record<string, unknown> }
  | { kind: 'unverified'; reason: string; evidence?: Record<string, unknown> };
export interface HostWorldTurnHost {
  readonly id: string;
  createSessionKey(token: string): string;
  isAvailable(): Promise<boolean>;
  run(input: { runId: string; sessionKey: string; prompt: string }): Promise<unknown>;
  waitForRun(input: { runId: string; timeoutMs: number }): Promise<unknown>;
  readOutput(input: HostWorldOutputRequest): Promise<HostWorldOutputEvidence>;
}
export type HostWorldTurnState = 'unknown' | 'accepted' | 'pending' | 'completed_unverified' | 'completed' | 'cancel_pending';
export interface HostWorldTurnView {
  state: HostWorldTurnState; runId: string; requestedSessionKey: string; acceptedSessionKey: string | null;
  inputDigest: string; promptDigest: string; validUntil: number; cancelReason: string | null;
  runtime: { harness: string; provider: string; model: string } | null;
  lastWait: Record<string, unknown> | null;
  output?: { text: string; trust: 'untrusted_model_output'; source: 'terminal_reply_and_dedicated_transcript' };
}
interface Row {
  identity: string; host_id: string; run_id: string; session_key: string; input_json: string; input_digest: string; prompt_digest: string;
  state: HostWorldTurnState; accepted_session: string | null; runtime_json: string | null; wait_json: string | null;
  output_json: string | null; cancel_reason: string | null;
}
const MAX_JSON = 1048576;
const digest = (text: string) => cidFromCanonical(new TextEncoder().encode(text));
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,128}$/.test(value);
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function ownObject(value: unknown): Record<string, unknown> {
  const result = jsonObject(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(result)) || Object.getOwnPropertySymbols(result).length
    || Object.values(Object.getOwnPropertyDescriptors(result)).some(d => !d.enumerable || !('value' in d))) throw new Error('HOST_WORLD_TURN_INPUT_INVALID');
  return result;
}
function fields(value: HostWorldTurnFields, sealed: boolean): HostWorldTurnFields {
  const source = ownObject(value), house = ownObject(source.house);
  const allowed = ['house', 'actorId', 'jobId', 'turnId', 'installationId', 'sessionId', 'fence', 'ticketId',
    'sessionLeaseExpiresAt', 'ticketExpiresAt', 'validUntil', 'contextDigest', 'prompt', ...(sealed ? ['inputDigest'] : [])];
  if (Object.keys(source).some(key => !allowed.includes(key)) || Object.keys(house).some(key => !['origin', 'houseKey', 'incarnation'].includes(key))) throw new Error('HOST_WORLD_TURN_INPUT_INVALID');
  if (typeof house.origin !== 'string' || house.origin.length > 253) throw new Error('HOST_WORLD_TURN_INPUT_INVALID');
  const origin = new URL(house.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== house.origin || origin.username || origin.password) throw new Error('HOST_WORLD_TURN_INPUT_INVALID');
  worldPublicKey(house.houseKey); worldPublicKey(source.actorId);
  for (const name of ['jobId', 'turnId', 'installationId', 'sessionId']) if (!opaque(source[name])) throw new Error('HOST_WORLD_TURN_INPUT_INVALID');
  // G1 tickets are canonical JSON identities containing the complete policy
  // binding. Preserve the original string; do not replace it with a short ID.
  if (typeof source.ticketId !== 'string' || !source.ticketId.length || [...source.ticketId].some(char => {
    const point = char.codePointAt(0)!; return point < 32 || (point >= 127 && point <= 159);
  })
    || new TextEncoder().encode(source.ticketId).length > 8192) throw new Error('HOST_WORLD_TURN_TICKET_INVALID');
  if (!opaque(house.incarnation) || typeof source.fence !== 'string' || worldUint64(source.fence) === '0'
    || typeof source.contextDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.contextDigest) || typeof source.prompt !== 'string' || !source.prompt.length) throw new Error('HOST_WORLD_TURN_INPUT_INVALID');
  for (const name of ['sessionLeaseExpiresAt', 'ticketExpiresAt', 'validUntil']) {
    if (!Number.isSafeInteger(source[name]) || (source[name] as number) <= 0 || (source[name] as number) > 253402300799) throw new Error('HOST_WORLD_TURN_EXPIRY_INVALID');
  }
  if ((source.validUntil as number) > Math.min(source.sessionLeaseExpiresAt as number, source.ticketExpiresAt as number)) throw new Error('HOST_WORLD_TURN_EXPIRY_INVALID');
  const result: HostWorldTurnFields = { house: { origin: house.origin, houseKey: house.houseKey as string, incarnation: house.incarnation },
    actorId: source.actorId as string, jobId: source.jobId as string, turnId: source.turnId as string,
    installationId: source.installationId as string, sessionId: source.sessionId as string, fence: source.fence, ticketId: source.ticketId as string,
    sessionLeaseExpiresAt: source.sessionLeaseExpiresAt as number, ticketExpiresAt: source.ticketExpiresAt as number,
    validUntil: source.validUntil as number, contextDigest: source.contextDigest, prompt: source.prompt };
  // Also reject malformed Unicode rather than hashing replacement UTF-8 bytes.
  parseWorldJson(new TextEncoder().encode(JSON.stringify(result)), MAX_JSON);
  return result;
}
export function sealHostWorldTurnInput(value: HostWorldTurnFields): HostWorldTurnInput {
  const captured = fields(value, false);
  return immutable({ ...captured, inputDigest: digest(JSON.stringify(captured)) });
}
function capture(value: HostWorldTurnInput): HostWorldTurnInput {
  const captured = fields(value, true), inputDigest = digest(JSON.stringify(captured));
  if (value.inputDigest !== inputDigest) throw new Error('HOST_WORLD_TURN_DIGEST_MISMATCH');
  return immutable({ ...captured, inputDigest });
}
function captureAuthority(authority: HostWorldTurnAuthority): HostWorldTurnAuthority {
  if (!authority || typeof authority.check !== 'function') throw new Error('HOST_WORLD_TURN_AUTHORITY_REQUIRED');
  const source = authority.gate;
  if (!source || !source.signal || typeof source.isActive !== 'function') throw new Error('HOST_WORLD_TURN_GATE_CLOSED');
  // Keep the original capability identity, while its checks continue reading
  // current durable authority. Replacing a caller object cannot revive a turn.
  const gate = Object.freeze({ origin: source.origin, generation: source.generation, signal: source.signal, isActive: source.isActive.bind(source) });
  return Object.freeze({ gate, check: authority.check.bind(authority) });
}
function identity(value: HostWorldTurnIdentity): string {
  const house = value.house;
  if (!house || typeof house.origin !== 'string' || typeof house.houseKey !== 'string' || !opaque(house.incarnation)
    || typeof value.actorId !== 'string' || !opaque(value.jobId) || !opaque(value.turnId)) throw new Error('HOST_WORLD_TURN_IDENTITY_INVALID');
  return JSON.stringify([house.origin, house.houseKey, house.incarnation, value.actorId, value.jobId, value.turnId]);
}
/** Store only bounded JSON snapshots of host evidence, never live mutable SDK objects. */
export function captureHostWorldTurnEvidence(value: unknown): Record<string, unknown> {
  let nodes = 0;
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 32) throw new Error('HOST_WORLD_TURN_EVIDENCE_INVALID');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => copy(child, depth + 1));
    const object = ownObject(item), result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(object)) if (child !== undefined) result[key] = copy(child, depth + 1);
    return result;
  }
  const result = jsonObject(copy(value, 0)), text = JSON.stringify(result);
  if (new TextEncoder().encode(text).length > MAX_JSON) throw new Error('HOST_WORLD_TURN_EVIDENCE_INVALID');
  return immutable(result);
}
const errorEvidence = (error: unknown) => ({ name: error instanceof Error ? error.name : 'Error',
  message: (error instanceof Error ? error.message : String(error)).slice(0, 2048) });
function runtimeMetadata(value: unknown): HostWorldTurnView['runtime'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const runtime = value as Record<string, unknown>;
  if (['harness', 'provider', 'model'].some(key => typeof runtime[key] !== 'string' || !runtime[key]
    || (runtime[key] as string).trim() !== runtime[key] || (runtime[key] as string).length > 256)) return null;
  return { harness: runtime.harness as string, provider: runtime.provider as string, model: runtime.model as string };
}

export class HostWorldTurn {
  private readonly database: HostDb;
  private stopped = false;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly touched = new Set<string>();
  constructor(private readonly options: { db: HostDb; host: HostWorldTurnHost; now?(): number }) {
    this.database = options.db;
    this.options = Object.freeze({ ...options });
    if (!opaque(options.host.id)) throw new Error('HOST_WORLD_TURN_HOST_INVALID');
    options.db.execute(`CREATE TABLE IF NOT EXISTS host_world_turns_v1 (
      identity TEXT PRIMARY KEY, ticket_key TEXT NOT NULL UNIQUE, host_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
      session_key TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL, input_digest TEXT NOT NULL, prompt_digest TEXT NOT NULL,
      state TEXT NOT NULL, accepted_session TEXT, runtime_json TEXT, wait_json TEXT, output_json TEXT, cancel_reason TEXT)`);
    options.db.execute(`CREATE TABLE IF NOT EXISTS host_world_turn_audit_v1 (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, kind TEXT NOT NULL, evidence_json TEXT NOT NULL, recorded_at INTEGER NOT NULL)`);
  }
  assertDatabase(db: HostDb): void {
    if (db !== this.database) throw new Error('HOST_WORLD_TURN_DATABASE_MISMATCH');
  }
  private now(): number {
    const value = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('HOST_WORLD_TURN_CLOCK_INVALID');
    return value;
  }
  private row(key: string, db = this.options.db): Row {
    const row = db.queryOne<Row>('SELECT * FROM host_world_turns_v1 WHERE identity=?', [key]);
    if (!row) throw new Error('HOST_WORLD_TURN_NOT_KNOWN');
    if (row.host_id !== this.options.host.id) throw new Error('HOST_WORLD_TURN_HOST_MISMATCH');
    return row;
  }
  private input(row: Row): HostWorldTurnInput { return capture(JSON.parse(row.input_json) as HostWorldTurnInput); }
  private event(key: string, kind: string, evidence: Record<string, unknown>, db = this.options.db): void {
    db.execute('INSERT INTO host_world_turn_audit_v1(identity,kind,evidence_json,recorded_at) VALUES(?,?,?,?)',
      [key, kind, JSON.stringify(evidence), this.now()]);
  }
  private assert(input: HostWorldTurnInput, authority: HostWorldTurnAuthority, phase: HostWorldTurnPhase): void {
    if (!authority || typeof authority.check !== 'function') throw new Error('HOST_WORLD_TURN_AUTHORITY_REQUIRED');
    const gate = authority.gate;
    const gated = () => !this.stopped && gate && gate.origin === input.house.origin && Number.isSafeInteger(gate.generation)
      && !gate.signal.aborted && gate.isActive();
    if (!gated()) throw new Error('HOST_WORLD_TURN_GATE_CLOSED');
    const checked: unknown = authority.check(input, phase);
    if (checked !== undefined) {
      if (checked && typeof (checked as Promise<unknown>).then === 'function') void Promise.resolve(checked).catch(() => {});
      throw new Error('HOST_WORLD_TURN_AUTHORITY_INVALID');
    }
    if (!gated()) throw new Error('HOST_WORLD_TURN_GATE_CLOSED');
    if (phase !== 'read' && this.now() >= input.validUntil) throw new Error('HOST_WORLD_TURN_EXPIRED');
  }
  private current(key: string, input: HostWorldTurnInput, authority: HostWorldTurnAuthority, phase: HostWorldTurnPhase): boolean {
    try { this.assert(input, authority, phase); return true; }
    catch (error) { this.cancelKey(key, errorEvidence(error).message); return false; }
  }
  private tracked<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(() => { this.tasks.delete(task); }, () => { this.tasks.delete(task); });
    return task;
  }
  private state(key: string, state: HostWorldTurnState, db = this.options.db): void {
    db.execute(`UPDATE host_world_turns_v1 SET state=CASE
      WHEN state IN ('cancel_pending','completed') THEN state
      WHEN state='completed_unverified' AND ? IN ('unknown','accepted','pending') THEN state ELSE ? END WHERE identity=?`, [state, state, key]);
  }
  private result(key: string, includeOutput = false): HostWorldTurnView {
    const row = this.row(key), input = this.input(row);
    return { state: row.state, runId: row.run_id, requestedSessionKey: row.session_key, acceptedSessionKey: row.accepted_session,
      inputDigest: row.input_digest, promptDigest: row.prompt_digest, validUntil: input.validUntil, cancelReason: row.cancel_reason,
      runtime: row.runtime_json ? JSON.parse(row.runtime_json) : null, lastWait: row.wait_json ? JSON.parse(row.wait_json) : null,
      ...(includeOutput && row.state === 'completed' && row.output_json ? { output: JSON.parse(row.output_json) } : {}) };
  }
  /** Local audit view; it never exposes an output as authorized for a downstream action. */
  view(value: HostWorldTurnIdentity): HostWorldTurnView { return this.result(identity(value)); }
  audit(value: HostWorldTurnIdentity): Array<{ kind: string; evidence: Record<string, unknown> }> {
    const key = identity(value); this.row(key);
    return this.options.db.queryAll<{ kind: string; evidence_json: string }>('SELECT kind,evidence_json FROM host_world_turn_audit_v1 WHERE identity=? ORDER BY seq', [key])
      .map(row => ({ kind: row.kind, evidence: JSON.parse(row.evidence_json) as Record<string, unknown> }));
  }
  async startOnce(value: HostWorldTurnInput, authority: HostWorldTurnAuthority): Promise<HostWorldTurnView> {
    const input = capture(value), key = identity(input);
    authority = captureAuthority(authority);
    this.assert(input, authority, 'dispatch');
    const created = this.options.db.transaction(tx => {
      const token = globalThis.crypto.randomUUID(), runId = `popclaw-world-turn:${token}`, sessionKey = this.options.host.createSessionKey(token);
      if (typeof sessionKey !== 'string' || !/^[a-z0-9][a-z0-9:_-]{1,255}$/.test(sessionKey)) throw new Error('HOST_WORLD_TURN_SESSION_INVALID');
      const inserted = tx.execute(`INSERT OR IGNORE INTO host_world_turns_v1
        (identity,ticket_key,host_id,run_id,session_key,input_json,input_digest,prompt_digest,state) VALUES(?,?,?,?,?,?,?,?, 'unknown')`,
      [key, JSON.stringify([input.house.origin, input.house.houseKey, input.house.incarnation, input.actorId, input.ticketId]),
        this.options.host.id, runId, sessionKey, JSON.stringify(input), input.inputDigest, digest(input.prompt)]);
      const row = tx.queryOne<Row>('SELECT * FROM host_world_turns_v1 WHERE identity=?', [key]);
      if (!row) throw new Error('HOST_WORLD_TURN_TICKET_REUSED');
      if (row.host_id !== this.options.host.id || row.input_digest !== input.inputDigest || row.input_json !== JSON.stringify(input)) throw new Error('HOST_WORLD_TURN_INPUT_CONFLICT');
      this.assert(input, authority, 'dispatch');
      if (inserted.changes) this.event(key, 'dispatch_intent', { runId, sessionKey, inputDigest: input.inputDigest, promptDigest: digest(input.prompt) }, tx);
      return inserted.changes === 1;
    });
    this.touched.add(key);
    if (!created) return this.result(key);
    return this.tracked(this.dispatch(key, input, authority));
  }
  private async dispatch(key: string, input: HostWorldTurnInput, authority: HostWorldTurnAuthority): Promise<HostWorldTurnView> {
    try {
      const available = await this.options.host.isAvailable();
      if (!this.current(key, input, authority, 'dispatch')) return this.result(key);
      if (available !== true) { this.event(key, 'host_unavailable', { available: false }); return this.result(key); }
      const row = this.row(key);
      if (row.state === 'cancel_pending') return this.result(key);
      const raw = await this.options.host.run(Object.freeze({ runId: row.run_id, sessionKey: row.session_key, prompt: input.prompt }));
      const ack = captureHostWorldTurnEvidence(raw), runtime = runtimeMetadata(ack.runtime);
      this.options.db.transaction(tx => {
        this.event(key, 'run_ack', ack, tx);
        if (ack.runId === row.run_id && ack.sessionKey === row.session_key && runtime) {
          tx.execute('UPDATE host_world_turns_v1 SET accepted_session=?,runtime_json=? WHERE identity=?', [row.session_key, JSON.stringify(runtime), key]);
          this.state(key, 'accepted', tx);
        }
      });
      this.current(key, input, authority, 'dispatch');
    } catch (error) {
      this.event(key, 'dispatch_error', errorEvidence(error));
      this.current(key, input, authority, 'dispatch');
    }
    return this.result(key);
  }
  async reconcile(value: HostWorldTurnIdentity, authority: HostWorldTurnAuthority, options: { timeoutMs: number }): Promise<HostWorldTurnView> {
    const key = identity(value), row = this.row(key), input = this.input(row);
    authority = captureAuthority(authority);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 30000) throw new Error('HOST_WORLD_TURN_WAIT_INVALID');
    this.assert(input, authority, 'read'); this.touched.add(key);
    return this.tracked(this.reconcileKnown(key, input, authority, options.timeoutMs));
  }
  private async reconcileKnown(key: string, input: HostWorldTurnInput, authority: HostWorldTurnAuthority, timeoutMs: number): Promise<HostWorldTurnView> {
    try {
      if (this.row(key).state === 'completed') return this.current(key, input, authority, 'output') ? this.result(key, true) : this.result(key);
      const available = await this.options.host.isAvailable();
      if (!this.current(key, input, authority, 'read')) return this.result(key);
      if (available !== true) { this.event(key, 'host_unavailable', { available: false }); return this.result(key); }
      const row = this.row(key), wait = captureHostWorldTurnEvidence(await this.options.host.waitForRun({ runId: row.run_id, timeoutMs }));
      this.options.db.transaction(tx => {
        this.event(key, 'wait', wait, tx);
        tx.execute('UPDATE host_world_turns_v1 SET wait_json=? WHERE identity=?', [JSON.stringify(wait), key]);
        this.state(key, wait.runId !== row.run_id ? 'unknown' : wait.status === 'ok' ? 'completed_unverified' : wait.status === 'pending' ? 'pending' : 'unknown', tx);
      });
      if (!this.current(key, input, authority, 'read')) return this.result(key);
      if (wait.runId !== row.run_id || wait.status !== 'ok') return this.result(key);
      if (!this.current(key, input, authority, 'output') || this.row(key).state === 'cancel_pending') return this.result(key);
      if (!row.accepted_session || !row.runtime_json || !Number.isSafeInteger(wait.startedAt) || !Number.isSafeInteger(wait.endedAt)
        || (wait.startedAt as number) < 0 || (wait.endedAt as number) < (wait.startedAt as number) || wait.pendingError === true
        || wait.providerStarted === false || wait.yielded === true) return this.result(key);
      // Availability itself is not model authorization, and can change after the wait.
      const readable = await this.options.host.isAvailable();
      if (!this.current(key, input, authority, 'output') || this.row(key).state === 'cancel_pending') return this.result(key);
      if (readable !== true) return this.result(key);
      const evidence = captureHostWorldTurnEvidence(await this.options.host.readOutput(Object.freeze({
        runId: row.run_id, sessionKey: row.accepted_session, prompt: input.prompt, terminal: wait })));
      this.event(key, 'output_evidence', evidence);
      if (!this.current(key, input, authority, 'output') || this.row(key).state === 'cancel_pending') return this.result(key);
      if (evidence.kind !== 'bound' || typeof evidence.text !== 'string' || evidence.source !== 'terminal_reply_and_dedicated_transcript') return this.result(key);
      this.options.db.transaction(tx => {
        this.assert(input, authority, 'output');
        if (this.row(key, tx).state === 'cancel_pending') return;
        tx.execute("UPDATE host_world_turns_v1 SET state='completed',output_json=? WHERE identity=?", [JSON.stringify({
          text: evidence.text, trust: 'untrusted_model_output', source: evidence.source }), key]);
      });
      return this.result(key, true);
    } catch (error) {
      this.event(key, 'reconcile_error', errorEvidence(error));
      this.current(key, input, authority, 'read');
      return this.result(key);
    }
  }
  private cancelKey(key: string, reason: string): void {
    this.options.db.transaction(tx => {
      const row = this.row(key, tx);
      if (row.state === 'cancel_pending') return;
      tx.execute("UPDATE host_world_turns_v1 SET state='cancel_pending',cancel_reason=? WHERE identity=?", [reason.slice(0, 1024), key]);
      this.event(key, 'cancel_local', { reason: reason.slice(0, 1024), remoteStopped: false }, tx);
    });
  }
  cancelLocal(value: HostWorldTurnIdentity, reason: string): HostWorldTurnView {
    const key = identity(value); this.cancelKey(key, reason); return this.result(key);
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const key of this.touched) this.cancelKey(key, 'HOST_WORLD_TURN_STOPPED');
  }
  /** Join only SDK promises actually called; there is no background model-lifecycle loop. */
  async whenIdle(): Promise<void> { while (this.tasks.size) await Promise.allSettled([...this.tasks]); }
}
