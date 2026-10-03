#!/usr/bin/env tsx
/**
 * UNSIGNED ISOLATED DIAGNOSTIC — NOT an accepted test, NOT signed off, NOT part
 * of any suite. It needs a live reference House and is therefore run by hand.
 *
 * It drives ONE world action end to end through the REAL product MCP stdio root:
 *
 *   spawned src/mcp.ts  ->  owner confirmation over real `elicitation/create`
 *   ->  ownerCommandContext  ->  durable HouseCommandBus push  ->  preparePushEffect
 *   ->  the Python reference House  ->  original signed receipt verified locally
 *   ->  popclaw_world_action_status settles the same original request.
 *
 * Nothing here registers its own CallTool handler and nothing spies on the push:
 * the only client-side code is a raw JSON-RPC peer on the child's stdio. Every
 * frame in both directions, plus the child's stderr, is appended to an evidence
 * log, and the effect is read back from the reference House's own HTTP API.
 *
 * Cases (`--case`): main | unprovisioned | decline | cancel | logout | crash
 *                   | crash-expired | takeover | all
 *
 * A failing case fails the RUN (non-zero exit); every verification read is a
 * READ-ONLY connection, and a failed read is never a zero or an empty list.
 *
 * Usage:
 *   node --import tsx scripts/diagnose-mcp-real-root-owner-action.ts \
 *     --origin http://127.0.0.1:18989 --evidence /abs/dir \
 *     [--reference-sha <sha>] [--plugin-sha <sha>] [--case all]
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostDb } from '../src/host/local-host-db.js';
import { LocalHostAdapter } from '../src/host/local-host-adapter.js';
import { PopclawPaths } from '../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../src/host/execution-store.js';
import { initializeActionReceiptJournal } from '../src/host/execution-store-migration.js';
import { MaintenanceSession } from '../src/host/storage-maintenance.js';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES = ['main', 'unprovisioned', 'decline', 'cancel', 'logout', 'crash', 'crash-expired', 'takeover'] as const;
type Case = typeof CASES[number];
/** `resident.ts:76` — the lifecycle owner lease TTL this root is built with. */
const OWNER_LEASE_TTL_MS = 30_000;
/** How long before the dead lease expires the takeover case fires its invoke. */
const INVOKE_BEFORE_EXPIRY_MS = 8_000;

interface Args { origin: string; evidence: string; referenceSha?: string; pluginSha?: string; case: string }
function parseArgs(): Args {
  const flags = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) flags.set(process.argv[i]!, process.argv[i + 1]!);
  const origin = flags.get('--origin'), evidence = flags.get('--evidence');
  assert.ok(origin && new URL(origin).origin === origin, '--origin must be a canonical origin');
  assert.ok(evidence && resolve(evidence) === evidence, '--evidence must be an absolute directory');
  return { origin, evidence, referenceSha: flags.get('--reference-sha'), pluginSha: flags.get('--plugin-sha'),
    case: flags.get('--case') ?? 'all' };
}

class Evidence {
  constructor(readonly file: string) { writeFileSync(file, ''); }
  line(direction: string, payload: unknown): void {
    appendFileSync(this.file, `${new Date().toISOString()} ${direction} ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
  }
}

interface Frame { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, unknown>;
  result?: Record<string, unknown>; error?: { message?: string; code?: number } }

/** A raw JSON-RPC peer over the child's stdio. It also answers server->client requests. */
class McpPeer {
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, (f: Frame) => void>();
  onElicit: (params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown> =
    () => ({ action: 'accept', content: { confirm: true } });
  readonly elicitations: Record<string, unknown>[] = [];
  readonly stdoutLines: string[] = [];
  stderr = '';
  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly evidence: Evidence) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        this.stdoutLines.push(line);
        this.evidence.line('S->C', line);
        // Deliberately intolerant: a non-JSON-RPC line on fd 1 must surface here.
        const frame = JSON.parse(line) as Frame;
        if (frame.method && frame.id !== undefined) { void this.serve(frame); continue; }
        if (typeof frame.id === 'number') this.pending.get(frame.id)?.(frame);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => { this.stderr += chunk; this.evidence.line('STDERR', chunk.trimEnd()); });
  }
  private send(value: unknown): void {
    this.evidence.line('C->S', value);
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private async serve(frame: Frame): Promise<void> {
    if (frame.method !== 'elicitation/create') {
      this.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `unhandled ${frame.method}` } });
      return;
    }
    this.elicitations.push(frame.params ?? {});
    try { this.send({ jsonrpc: '2.0', id: frame.id, result: await this.onElicit(frame.params ?? {}) }); }
    catch (error) { this.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: String(error) } }); }
  }
  request(method: string, params: unknown = {}, timeoutMs = 180_000): Promise<Frame> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`TIMEOUT ${method}`)), timeoutMs);
      this.pending.set(id, frame => { clearTimeout(timer); res(frame); });
    });
  }
  notify(method: string, params: unknown = {}): void { this.send({ jsonrpc: '2.0', method, params }); }
  kill(): void { this.child.kill('SIGKILL'); }
}

/** A data root with an identity, this house configured, and the action receipt
 *  journal provisioned. That last step has NO production caller (see the report);
 *  it is performed here, out of band, with nothing running on the root. */
function seedRoot(origin: string, label: string, provisionReceiptJournal = true): { root: string; actorId: string } {
  const root = mkdtempSync(join(tmpdir(), `w3-${label}-`));
  const seed = nacl.randomBytes(32), pair = nacl.sign.keyPair.fromSeed(seed);
  const actorId = bs58.encode(pair.publicKey);
  mkdirSync(join(root, 'vault', 'social', 'identity'), { recursive: true });
  mkdirSync(join(root, 'config', 'cadence'), { recursive: true });
  writeFileSync(join(root, 'vault', 'social', 'identity', 'master.key'), JSON.stringify({
    version: 1, type: 'master-raw-seed', created_at: new Date().toISOString(),
    public_key: actorId, seed: Buffer.from(seed).toString('hex') }), { mode: 0o600 });
  writeFileSync(join(root, 'config', 'plugin.json'), JSON.stringify({ lore_houses: [origin], nickname: `w3 ${label}` }));
  writeFileSync(join(root, 'config', 'cadence', 'cadence.json'), JSON.stringify({ schemaVersion: 1, delivery: { primaryLanguage: 'en' } }));
  const paths = new PopclawPaths(root);
  const host = new LocalHostAdapter({ dataRoot: root, logger: { info() {}, warn() {}, error() {} } });
  const catalog = new ExecutionStoreCatalog({ db: host.db, paths, actorId });
  try {
    catalog.open(origin);
    if (provisionReceiptJournal) {
      const maintenance = MaintenanceSession.begin(host.db, paths, 'w3 isolated diagnostic: action receipt journal');
      initializeActionReceiptJournal({ catalog, origin, maintenance });
      maintenance.finish({ recovery: false, reason: 'w3 isolated diagnostic: action receipt journal prepared' });
    }
  } finally { catalog.close(); host.db.close(); }
  return { root, actorId };
}

async function start(root: string, evidence: Evidence, capabilities: Record<string, unknown> = { elicitation: { form: {} } }): Promise<McpPeer> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(pluginRoot, 'src', 'mcp.ts')], {
    cwd: pluginRoot,
    env: { ...process.env, POPCLAW_DATA_ROOT: root, POPCLAW_NOTIFICATION_CONSUMER: 'w3-diagnostic' },
    stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  const peer = new McpPeer(child, evidence);
  const init = await peer.request('initialize', { protocolVersion: '2025-06-18', capabilities,
    clientInfo: { name: 'w3-real-root-diagnostic', version: '0' } });
  assert.equal((init.result?.['serverInfo'] as { name?: string } | undefined)?.name, 'popclaw');
  peer.notify('notifications/initialized');
  return peer;
}

const text = (frame: Frame): string =>
  ((frame.result?.['content'] as Array<{ text?: string }> | undefined) ?? []).map(b => b.text ?? '').join('\n');
/** The tools return one text block that ends with the structured JSON line. */
function body(frame: Frame): Record<string, unknown> {
  const lines = text(frame).split('\n').filter(line => line.trim().startsWith('{'));
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

interface Footprint { seq: string; source_event_id: string; ranger_id: string; place: string; status: string }
async function footprints(origin: string, actorId: string): Promise<Footprint[]> {
  const response = await fetch(`${origin}/ranger-map/v1/footprints?ranger_id=${actorId}&limit=100`,
    { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200, 'reference business read failed');
  return ((await response.json()) as { items: Footprint[] }).items;
}

interface CommandRow { request_id: string; kind: string; state: string; running_epoch: number | null;
  result_json: string | null; payload_bytes: Uint8Array | null; created_at: number; deadline_at: number | null }
const COMMAND_COLUMNS = 'request_id,kind,state,running_epoch,result_json,payload_bytes,created_at,deadline_at';
/** A table that does not exist yet is a STATE; anything else is a failed read.
 *  Neither may be swallowed into an empty list or a zero, because several
 *  negative cases assert exactly those zeros. */
const missingTable = (error: unknown): boolean => /no such table/i.test(String((error as Error)?.message ?? error));
/** Read the live host DB through a second READ-ONLY connection: verification
 *  must not be able to mutate (or migrate, or WAL-recover) what it verifies. */
function openRead(file: string): LocalHostDb { return new LocalHostDb(file, { readOnly: true }); }
function readCommands(root: string): CommandRow[] {
  const db = openRead(new PopclawPaths(root).socialDb());
  try { return db.queryAll<CommandRow>(`SELECT ${COMMAND_COLUMNS} FROM house_lifecycle_commands WHERE kind='push' ORDER BY created_at`); }
  finally { db.close(); }
}
type Count = number | 'table-absent' | 'store-absent';
function readActionRows(root: string, origin: string, actorId: string): { requests: Count; receipts: Count } {
  const paths = new PopclawPaths(root);
  const db = openRead(paths.socialDb());
  try {
    const row = db.queryOne<{ store_id: string }>('SELECT store_id FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
    if (!row) return { requests: 'store-absent', receipts: 'store-absent' };
    const execution = openRead(paths.executionDb(row.store_id));
    try {
      const count = (sql: string): Count => {
        try { return execution.queryOne<{ n: number }>(sql)!.n; }
        catch (error) { if (missingTable(error)) return 'table-absent'; throw error; }
      };
      void actorId;
      return { requests: count('SELECT COUNT(*) AS n FROM world_action_client_requests'),
        receipts: count('SELECT COUNT(*) AS n FROM world_action_client_evidence') };
    } finally { execution.close(); }
  } finally { db.close(); }
}

const PARAMS = Object.freeze({ place: 'Real MCP root', latitude: '30.2700', longitude: '120.1500',
  status: 'Isolated diagnostic through the real MCP stdio root' });

/** Login, then read the capability revision the House actually published. */
async function loginAndRevision(peer: McpPeer, origin: string, evidence: Evidence): Promise<string> {
  const login = await peer.request('tools/call', { name: 'popclaw_house_login', arguments: { host: origin } });
  evidence.line('NOTE', { stage: 'login', isError: login.result?.['isError'], text: text(login).slice(0, 4000) });
  assert.ok(!login.result?.['isError'], `login failed: ${text(login).slice(0, 500)}`);
  const caps = await peer.request('tools/call', { name: 'popclaw_world_capabilities', arguments: { house: origin } });
  const view = body(caps);
  const revision = view['capability_revision'] as string;
  const kind = ((view['blocks'] as Record<string, { kinds?: Record<string, { support?: string; ready?: boolean }> }>)
    ['actions']?.kinds ?? {})['rangermap.check_in'];
  evidence.line('NOTE', { stage: 'capabilities', revision, kind });
  assert.equal(kind?.support, 'supported', 'action kind must report supported');
  assert.equal(kind?.ready, true, 'action kind must report ready');
  return revision;
}

interface CaseReport { case: Case; [key: string]: unknown }

async function runCase(name: Case, args: Args): Promise<CaseReport> {
  if (name === 'takeover') return runTakeoverCase(args);
  const evidence = new Evidence(join(args.evidence, `frames-${name}.log`));
  // `unprovisioned` is the control: exactly what an ordinary install looks like,
  // because no composition root ever calls initializeActionReceiptJournal.
  const { root, actorId } = seedRoot(args.origin, name, name !== 'unprovisioned');
  evidence.line('NOTE', { stage: 'seeded', case: name, root, actorId, origin: args.origin,
    referenceSha: args.referenceSha, pluginSha: args.pluginSha, node: process.version });
  const report: CaseReport = { case: name, root, actorId, evidence: evidence.file };
  const peer = await start(root, evidence);
  try {
    if (name === 'unprovisioned') {
      const login = await peer.request('tools/call', { name: 'popclaw_house_login', arguments: { host: args.origin } });
      assert.ok(!login.result?.['isError'], 'login must still succeed without the receipt journal');
      const caps = await peer.request('tools/call', { name: 'popclaw_world_capabilities', arguments: { house: args.origin } });
      const view = body(caps);
      const kinds = (view['blocks'] as Record<string, { kinds?: Record<string, unknown> }>)['actions']?.kinds ?? {};
      report['capabilityRevision'] = view['capability_revision'];
      report['kindWithoutJournal'] = kinds['rangermap.check_in'];
      const invoke = await peer.request('tools/call', { name: 'popclaw_world_invoke', arguments: { house: args.origin,
        kind: 'rangermap.check_in', params: { ...PARAMS }, expected_capability_revision: view['capability_revision'] } });
      report['invokeIsError'] = invoke.result?.['isError'] ?? false;
      report['invokeText'] = text(invoke).slice(0, 600);
      report['elicitations'] = peer.elicitations.length;
      report['footprintsAtReturn'] = (await footprints(args.origin, actorId)).map(f => f.source_event_id);
      assert.equal(report['invokeIsError'], true, 'an unprovisioned root must refuse the action');
      assert.equal(report['elicitations'], 0, 'an unprovisioned root must not even ask the owner');
      assert.deepEqual(report['footprintsAtReturn'], []);
      evidence.line('NOTE', { stage: 'case-report', report });
      peer.kill();
      return report;
    }
    const revision = await loginAndRevision(peer, args.origin, evidence);
    report['capabilityRevision'] = revision;
    const invokeArgs = { house: args.origin, kind: 'rangermap.check_in', params: { ...PARAMS },
      expected_capability_revision: revision };
    assert.deepEqual(await footprints(args.origin, actorId), [], 'fresh identity must start with no footprint');

    if (name === 'decline') peer.onElicit = () => ({ action: 'accept', content: { confirm: false } });
    if (name === 'cancel') peer.onElicit = () => ({ action: 'cancel' });
    if (name === 'logout') {
      // Log out of the house WHILE the owner dialog is on screen, then accept.
      peer.onElicit = async () => {
        const out = await peer.request('tools/call', { name: 'popclaw_house_logout', arguments: { host: args.origin } });
        evidence.line('NOTE', { stage: 'logout-during-wait', isError: out.result?.['isError'], text: text(out).slice(0, 2000) });
        report['logoutText'] = text(out).slice(0, 600);
        await sleep(500);
        return { action: 'accept', content: { confirm: true } };
      };
    }

    const crashing = name === 'crash' || name === 'crash-expired';
    let killWatch: Promise<void> | undefined;
    if (crashing) {
      // Kill the MCP process the instant the durable push row exists, so a
      // queued push outlives the call that created it. Nothing is written here.
      killWatch = (async () => {
        const db = openRead(new PopclawPaths(root).socialDb());
        try {
          const deadline = Date.now() + 120_000;
          while (Date.now() < deadline) {
            let live: CommandRow | undefined;
            try {
              live = db.queryAll<CommandRow>(`SELECT ${COMMAND_COLUMNS} FROM house_lifecycle_commands WHERE kind='push' AND state!='done'`)[0];
            } catch (error) {
              // The table does not exist until the bus starts. Any OTHER read
              // failure means this watch is blind and must not look patient.
              if (!missingTable(error)) throw error;
            }
            if (live) {
              report['killedOnRow'] = { request_id: live.request_id, state: live.state, hasPayload: !!live.payload_bytes };
              evidence.line('NOTE', { stage: 'crash-kill', row: report['killedOnRow'] });
              peer.kill();
              return;
            }
            await sleep(1);
          }
          evidence.line('NOTE', { stage: 'crash-kill', missed: true });
        } finally { db.close(); }
      })();
    }

    const startedAt = Date.now();
    let invoke: Frame | undefined, invokeError: string | undefined;
    const call = peer.request('tools/call', { name: 'popclaw_world_invoke', arguments: invokeArgs }, 120_000)
      .then(frame => { invoke = frame; }, error => { invokeError = String(error); });
    // A killed child never answers, so the crash cases stop waiting the moment
    // the kill lands: the restart must happen inside the queued push's deadline.
    await (killWatch ? Promise.race([call, killWatch.then(() => sleep(200))]) : call);
    const returnedAt = Date.now();
    report['elapsedMs'] = returnedAt - startedAt;
    report['elicitations'] = peer.elicitations.length;
    if (peer.elicitations[0]) report['ownerMessage'] = (peer.elicitations[0]['message'] as string)?.split('\n');
    if (invoke) {
      report['invokeIsError'] = invoke.result?.['isError'] ?? false;
      report['invokeText'] = text(invoke).slice(0, 1200);
      if (!invoke.result?.['isError']) report['invokeBody'] = body(invoke);
    } else report['invokeError'] = invokeError;

    // THE TIMING MEASUREMENT: the durable queue's state at the instant the call
    // returned, read from a separate connection, before anything else happens.
    report['commandsAtReturn'] = readCommands(root).map(row => ({ request_id: row.request_id, state: row.state,
      hasPayload: !!row.payload_bytes, result: row.result_json ? JSON.parse(row.result_json) as unknown : null }));
    report['footprintsAtReturn'] = (await footprints(args.origin, actorId)).map(f => ({ seq: f.seq, source_event_id: f.source_event_id, place: f.place }));
    report['actionRowsAtReturn'] = crashing ? null : readActionRows(root, args.origin, actorId);

    if (name === 'main') {
      const b = report['invokeBody'] as Record<string, unknown>;
      assert.equal(b['status'], 'succeeded', 'the real root must settle the action as succeeded');
      assert.equal(b['receipt_durable'], true, 'the verified original receipt must be durable');
      const status = await peer.request('tools/call', { name: 'popclaw_world_action_status',
        arguments: { house: args.origin, request_id: b['request_id'] } });
      report['statusBody'] = body(status);
      assert.equal((report['statusBody'] as Record<string, unknown>)['request_id'], b['request_id'],
        'status must answer for the same original request');
      report['footprintsAfterStatus'] = (await footprints(args.origin, actorId)).map(f => f.source_event_id);
    }

    if (crashing) {
      // Nothing is touched on the data root. Start a SECOND real MCP root on it
      // and see what the durable bus does with the push the dead call left behind.
      // `crash` restarts INSIDE the row's 30 s deadline (command-bus.ts:128), so
      // the bus really reconsiders sending it; `crash-expired` waits it out.
      await sleep(name === 'crash-expired' ? 32_000 : 1000);
      report['restartDelayMs'] = name === 'crash-expired' ? 32_000 : 1000;
      report['commandsAfterKill'] = readCommands(root).map(row => ({ request_id: row.request_id, state: row.state, hasPayload: !!row.payload_bytes,
        result: row.result_json ? JSON.parse(row.result_json) as unknown : null }));
      report['footprintsAfterKill'] = (await footprints(args.origin, actorId)).map(f => f.source_event_id);
      const revived = await start(root, evidence);
      try {
        await revived.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
        // The orphan sweep only runs once the revived root holds the lifecycle
        // owner lease (command-bus.ts pump -> authority.captureEpoch()), which
        // takes tens of seconds after a hard kill, so watch rather than peek.
        const watched: unknown[] = [];
        for (let i = 0; i < 24; i++) {
          await sleep(5000);
          watched.push({ atMs: (i + 1) * 5000, commands: readCommands(root).map(row => ({ request_id: row.request_id, state: row.state,
            hasPayload: !!row.payload_bytes, result: row.result_json ? JSON.parse(row.result_json) as unknown : null })),
            footprints: (await footprints(args.origin, actorId)).length });
          const rows = readCommands(root);
          if (rows.length && rows.every(row => row.state === 'done')) break;
        }
        report['restartWatch'] = watched;
        report['commandsAfterRestart'] = readCommands(root).map(row => ({ request_id: row.request_id, state: row.state, hasPayload: !!row.payload_bytes,
          result: row.result_json ? JSON.parse(row.result_json) as unknown : null }));
        report['footprintsAfterRestart'] = (await footprints(args.origin, actorId)).map(f => f.source_event_id);
        const status = await revived.request('tools/call', { name: 'popclaw_world_action_status',
          arguments: { house: args.origin, request_id: (readActionRequestIds(root, args.origin)[0] ?? 'x'.repeat(64)) } });
        report['statusAfterRestart'] = status.result?.['isError'] ? text(status).slice(0, 400) : body(status);
        report['footprintsAfterStatusRestart'] = (await footprints(args.origin, actorId)).map(f => f.source_event_id);
      } finally { revived.kill(); }
    }

    if (name === 'decline' || name === 'cancel' || name === 'logout') {
      assert.equal(report['invokeIsError'], true, 'a refused confirmation must be a tool error');
      assert.deepEqual(report['footprintsAtReturn'], [], 'a refused confirmation must leave no effect on the House');
    }
  } finally {
    peer.kill();
    evidence.line('NOTE', { stage: 'case-report', report });
  }
  return report;
}

interface OwnerLeaseRow { generation: number; holder: string; renewed_at: number }
interface ParticipationRow { op_seq: number; desired: string; phase: string; session_id: string;
  house_revision: number; lease_expires_at: number; ack_key_hex: string; installation_id: string }
/** ADR-0051 S2b: ONE lifecycle owner per data root, TTL 30 s, renewal at TTL/3
 *  (`owner-lease.ts`). Read it to see a takeover happen, never to cause one. */
function readOwnerLease(root: string): OwnerLeaseRow | null {
  const db = openRead(new PopclawPaths(root).socialDb());
  try { return db.queryOne<OwnerLeaseRow>('SELECT generation,holder,renewed_at FROM house_lifecycle_owner WHERE id=1') ?? null; }
  catch (error) { if (missingTable(error)) return null; throw error; }
  finally { db.close(); }
}
function readParticipationRow(root: string, origin: string): ParticipationRow | null {
  const db = openRead(new PopclawPaths(root).socialDb());
  try {
    return db.queryOne<ParticipationRow>(`SELECT op_seq,desired,phase,session_id,house_revision,lease_expires_at,ack_key_hex,installation_id
      FROM house_participation WHERE house_origin=?`, [origin]) ?? null;
  } catch (error) { if (missingTable(error)) return null; throw error; }
  finally { db.close(); }
}
const commandSnapshot = (row: CommandRow, at = Date.now()) => ({ request_id: row.request_id, state: row.state,
  running_epoch: row.running_epoch, hasPayload: !!row.payload_bytes, deadlineInMs: row.deadline_at === null ? null : row.deadline_at - at,
  result: row.result_json ? JSON.parse(row.result_json) as unknown : null });

/**
 * THE GATE THE KILL RUNS NEVER REACHED (report caveat 3): a queued push that is
 * still `pending`, whose action deadline is still valid, looked at by a root
 * that has TAKEN OVER the lifecycle lease from the dead root that created it.
 *
 * Both kill runs had already moved the row to `running`, where the orphan sweep
 * (`command-bus.ts:262-264`) answers first with ACTION_RESULT_UNKNOWN, so the
 * `pushCurrent()` re-check at `command-bus.ts:274-278` was never the decider.
 *
 * A live owner claims its own row microseconds after enqueue, in the same
 * synchronous `pushInner` -> `pump()` block, so no external kill can land in
 * between. The only way a row is BORN pending and STAYS pending is that the
 * process that enqueued it is not the lifecycle owner: `pump()` returns at once
 * when `captureEpoch()` is null (`command-bus.ts:256-258`). So:
 *
 *   Z = the old owner root (holds the lease, executes A's login)
 *   A = the actor root (second process on the same data root, never the owner;
 *       it owns the elicitation, the permit and the durable action request)
 *   C = the NEW root, started so that its `resident.start()` -> `tryAcquire()`
 *       lands just after Z's dead lease expires, i.e. a real takeover at a
 *       bumped generation, with the row's 30 s deadline still running.
 *
 * Nothing is patched and no row is fabricated: the multi-root topology is the
 * documented one (`owner-lease.ts`: "the others submit through it").
 */
async function runTakeoverCase(args: Args): Promise<CaseReport> {
  const name: Case = 'takeover';
  const evidence = new Evidence(join(args.evidence, `frames-${name}.log`));
  const { root, actorId } = seedRoot(args.origin, name);
  evidence.line('NOTE', { stage: 'seeded', case: name, root, actorId, origin: args.origin,
    referenceSha: args.referenceSha, pluginSha: args.pluginSha, node: process.version });
  const report: CaseReport = { case: name, root, actorId, evidence: evidence.file };
  const old = await start(root, new Evidence(join(args.evidence, `frames-${name}-Z-old-owner.log`)));
  const actor = await start(root, new Evidence(join(args.evidence, `frames-${name}-A-actor.log`)));
  let next: McpPeer | undefined;
  try {
    // Z becomes the lifecycle owner by being the first root to build a runtime.
    await old.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
    const ownerBefore = readOwnerLease(root);
    assert.ok(ownerBefore, 'the old owner must hold the lifecycle lease');
    report['leaseBeforeKill'] = ownerBefore;

    // A logs in THROUGH Z (durable IPC), so A never owns the lifecycle.
    const revision = await loginAndRevision(actor, args.origin, evidence);
    report['capabilityRevision'] = revision;
    const leaseAfterLogin = readOwnerLease(root);
    assert.deepEqual(leaseAfterLogin, ownerBefore, 'the actor root must not have taken the lifecycle lease');
    report['participationBeforeKill'] = readParticipationRow(root, args.origin);
    assert.deepEqual(await footprints(args.origin, actorId), [], 'fresh identity must start with no footprint');

    // Kill the owner. Its lease row stays until TTL expiry; nothing pumps.
    old.kill();
    const expiresAt = ownerBefore.renewed_at + OWNER_LEASE_TTL_MS;
    report['ownerKilledAt'] = Date.now();
    report['leaseExpiresAt'] = expiresAt;
    evidence.line('NOTE', { stage: 'old-owner-killed', expiresInMs: expiresAt - Date.now() });

    // Invoke while the dead lease still has a few seconds to run: the row is
    // then enqueued with a full 30 s deadline and cannot be claimed by anyone.
    const waitMs = expiresAt - Date.now() - INVOKE_BEFORE_EXPIRY_MS;
    assert.ok(waitMs > 0, `no room left before the dead lease expires: ${waitMs} ms`);
    await sleep(waitMs);
    const watcher = openRead(new PopclawPaths(root).socialDb());
    let killed: ReturnType<typeof commandSnapshot> | undefined;
    const killWatch = (async () => {
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        let live: CommandRow | undefined;
        try { live = watcher.queryAll<CommandRow>(`SELECT ${COMMAND_COLUMNS} FROM house_lifecycle_commands WHERE kind='push'`)[0]; }
        catch (error) { if (!missingTable(error)) throw error; }
        if (live) {
          killed = commandSnapshot(live);
          actor.kill();   // the permit dies with the process that holds it
          evidence.line('NOTE', { stage: 'actor-killed', row: killed, leaseNow: readOwnerLease(root) });
          return;
        }
        await sleep(1);
      }
      throw new Error('the actor root never enqueued a push row');
    })();
    const invokeArgs = { house: args.origin, kind: 'rangermap.check_in', params: { ...PARAMS },
      expected_capability_revision: revision };
    const call = actor.request('tools/call', { name: 'popclaw_world_invoke', arguments: invokeArgs }, 40_000)
      .then(frame => { report['actorInvokeText'] = text(frame).slice(0, 600); },
        error => { report['actorInvokeError'] = String(error); });
    try { await Promise.race([call, killWatch]); await killWatch; } finally { watcher.close(); }
    report['elicitations'] = actor.elicitations.length;
    report['rowAtActorKill'] = killed;
    report['leaseAtActorKill'] = readOwnerLease(root);

    // The three conditions the reviewer asked for, asserted rather than assumed.
    assert.equal(killed?.state, 'pending', 'the queued push must still be pending when its root dies');
    assert.equal(killed?.running_epoch, null, 'a pending row must never carry a running epoch');
    assert.ok((killed?.deadlineInMs ?? 0) > 0, 'the action deadline must still be valid at the kill');
    assert.deepEqual(report['leaseAtActorKill'], ownerBefore, 'the dead owner must still name the lease at the kill');

    // The NEW root: spawned now, but its runtime (and therefore its
    // `tryAcquire()`) is triggered only once the dead lease has expired.
    next = await start(root, new Evidence(join(args.evidence, `frames-${name}-C-new-root.log`)));
    const untilExpiry = expiresAt - Date.now();
    report['newRootTriggeredInMs'] = untilExpiry;
    if (untilExpiry > 0) await sleep(untilExpiry + 200);
    const triggeredAt = Date.now();
    const status = await next.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
    report['newRootStatusIsError'] = status.result?.['isError'] ?? false;
    const leaseAfter = readOwnerLease(root);
    report['leaseAfterTakeover'] = leaseAfter;
    report['takeoverAfterMs'] = Date.now() - triggeredAt;

    // Watch the row decide, at 5 ms, so a claim by the new root is visible
    // even if the executor fails immediately afterwards.
    const transitions: unknown[] = [];
    let last = '';
    const deadline = Date.now() + 45_000;
    let settled: ReturnType<typeof commandSnapshot> | undefined;
    while (Date.now() < deadline) {
      const rows = readCommands(root);
      const row = rows[0];
      if (row) {
        const snapshot = commandSnapshot(row);
        const shape = JSON.stringify([snapshot.state, snapshot.running_epoch, snapshot.result]);
        if (shape !== last) { last = shape; transitions.push({ atMs: Date.now() - triggeredAt, ...snapshot }); }
        if (row.state === 'done') { settled = snapshot; break; }
      }
      await sleep(5);
    }
    report['rowTransitions'] = transitions;
    report['rowSettled'] = settled;
    report['participationAtSettle'] = readParticipationRow(root, args.origin);
    report['actionRowsAtSettle'] = readActionRows(root, args.origin, actorId);
    report['footprintsAtSettle'] = (await footprints(args.origin, actorId)).map(f => f.source_event_id);
    await sleep(5000);
    report['footprintsAfterSettle'] = (await footprints(args.origin, actorId)).map(f => f.source_event_id);
    report['newRootStderrTail'] = next.stderr.split('\n').slice(-12).join('\n');

    assert.ok(leaseAfter && ownerBefore.holder !== leaseAfter.holder && leaseAfter.generation > ownerBefore.generation,
      'the new root must have taken the lifecycle lease at a new generation');
    assert.ok(settled, 'the queued push must reach a durable verdict');
    assert.ok((settled.deadlineInMs ?? 0) > 0, `the deadline must still have been valid at the verdict: ${JSON.stringify(settled)}`);
    assert.deepEqual(report['footprintsAtSettle'], [], 'the new root must not replay the action into the House');
    assert.deepEqual(report['footprintsAfterSettle'], [], 'and must not send it late either');
    evidence.line('NOTE', { stage: 'case-report', report });
    return report;
  } finally {
    old.kill(); actor.kill(); next?.kill();
    evidence.line('NOTE', { stage: 'case-report-final', report });
  }
}

function readActionRequestIds(root: string, origin: string): string[] {
  const paths = new PopclawPaths(root);
  const db = openRead(paths.socialDb());
  try {
    const row = db.queryOne<{ store_id: string }>('SELECT store_id FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
    if (!row) return [];
    const execution = openRead(paths.executionDb(row.store_id));
    try { return execution.queryAll<{ request_id: string }>('SELECT request_id FROM world_action_client_requests').map(r => r.request_id); }
    finally { execution.close(); }
  } finally { db.close(); }
}

async function main(): Promise<void> {
  const args = parseArgs();
  mkdirSync(args.evidence, { recursive: true });
  const selected: Case[] = args.case === 'all' ? [...CASES] : [args.case as Case];
  for (const name of selected) assert.ok(CASES.includes(name), `unknown case ${name}`);
  const manifest = await (await fetch(`${args.origin}/v1/manifest`, { signal: AbortSignal.timeout(8000) })).json() as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    label: 'UNSIGNED ISOLATED DIAGNOSTIC — not signed off, not an accepted test',
    startedAt: new Date().toISOString(), node: process.version,
    pluginSha: args.pluginSha, referenceSha: args.referenceSha, origin: args.origin,
    houseKey: (manifest['world_interaction'] as { actions?: { result_authority_pubkey?: string } })?.actions?.result_authority_pubkey,
    cases: [] as CaseReport[],
  };
  const failed: string[] = [];
  for (const name of selected) {
    process.stderr.write(`\n=== case ${name} ===\n`);
    try { (summary['cases'] as CaseReport[]).push(await runCase(name, args)); }
    catch (error) {
      failed.push(name);
      (summary['cases'] as CaseReport[]).push({ case: name, failed: String(error), stack: (error as Error)?.stack } as CaseReport);
    }
  }
  // A failed case must fail the RUN. A zero in a negative case means nothing
  // if the process that produced it can exit 0 after throwing.
  summary['failedCases'] = failed;
  const file = join(args.evidence, 'summary.json');
  writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.stderr.write(`\nSUMMARY ${file}\n`);
  if (failed.length) {
    process.stderr.write(`FAILED CASES ${failed.join(' ')}\n`);
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
