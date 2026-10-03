import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { PopclawPaths } from '../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../src/host/execution-store.js';
import { PUBLIC_JOURNAL_TABLES } from '../../src/host/execution-store-schema.js';
import { initializePublicStreamJournal } from '../../src/host/execution-store-migration.js';
import { MaintenanceSession } from '../../src/host/storage-maintenance.js';
import { ensureHouseLifecycleSchema } from '../../src/runtime/house-lifecycle/participation-store.js';
import { resolveInstallationId } from '../../src/runtime/house-lifecycle/installation.js';
import { makeWorldManifestPreparer } from '../../src/world/world-capabilities.js';

const pkgRoot = resolve(__dirname, '../..');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const actorSeed = new Uint8Array(32).fill(46), actor = nacl.sign.keyPair.fromSeed(actorSeed), actorId = bs58.encode(actor.publicKey);
const houseKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(47));
async function until(check: () => boolean, detail: () => string = () => '', ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`public root fixture timeout: ${detail()}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}
const sse = (name: string, bytes: Uint8Array) => `event: ${name}\ndata: ${Buffer.from(bytes).toString('base64')}\n\n`;

/**
 * `prebuilt: false` is the newly joined house: the catalog row does not exist
 * before the root starts, so the partition — and with it the public-stream
 * schema — can only come from the product root's own first use. No out-of-band
 * `initializePublicStreamJournal` runs in that case.
 */
async function fixture(mode: string | null = 'public-v1', intent = true, held = false, prebuilt = true) {
  const root = mkdtempSync(join(tmpdir(), 'public-v1-root-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(join(root, 'data')), home = join(root, 'home'), attempts = join(root, 'forbidden-network');
  mkdirSync(home); mkdirSync(join(paths.rootDir(), 'config'), { recursive: true });
  mkdirSync(paths.identityDir(), { recursive: true });
  writeFileSync(join(paths.identityDir(), 'master.key'), JSON.stringify({ version: 1, type: 'master-raw-seed',
    created_at: '2026-01-01T00:00:00Z', public_key: actorId, seed: Buffer.from(actorSeed).toString('hex') }), { mode: 0o600 });
  const envelope = new popclaw.event.EventEnvelope({ actor: { popclawId: actorId, nickname: 'Synthetic' }, timestamp: 1_700_000_000,
    post: { blocks: [{ content: 'Synthetic public root evidence' }] } });
  const canonical = canonicalizeEnvelope(envelope);
  envelope.eventId = cidFromCanonical(canonical); envelope.signature = nacl.sign.detached(canonical, actor.secretKey);
  const original = new Uint8Array(popclaw.event.EventEnvelope.encode(envelope).finish());
  const requests: Array<{ method: string; url: string; authorization?: string }> = [];
  const streams = new Set<ServerResponse>();
  let manifest = '', proof = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    requests.push({ method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization });
    if (url.pathname === '/v1/manifest') {
      response.writeHead(200, { 'content-type': 'application/json', 'x-popclaw-manifest-proof': proof }); response.end(manifest);
    } else if (url.pathname === '/v1/world-stream' && url.searchParams.get('mode') === 'public-v1') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      streams.add(response); response.once('close', () => streams.delete(response));
      response.write(sse('public_boundary', popclaw.world.PublicStreamBoundary.encode({ logIncarnation: 'log_root', highWaterSeq: 1, fullPublic: true }).finish()));
      if (url.searchParams.get('public_after') === '0') response.write(sse('public_frame', popclaw.event.WorldStreamFrame.encode({ seq: 1, kind: 'post', envelope: original }).finish()));
      response.write(sse('public_checkpoint', popclaw.world.PublicStreamCheckpoint.encode({ phase: 'replay', publicThroughSeq: 1 }).finish()));
    } else if (url.pathname === '/v1/world-stream' || url.pathname === '/world-feed/stream' || url.pathname.endsWith('/stream')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': synthetic legacy stream\n\n');
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const origin = `http://127.0.0.1:${address.port}`;
  manifest = JSON.stringify({ house: { name: 'Synthetic public House', slug: 'fixture' }, official_ids: [], world_interaction: { version: 1,
    public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: 'log_root', envelope_baseline: 'public-envelope-01' as const, initial_public_scopes: [] } } });
  const rawBytes = new TextEncoder().encode(manifest), core = { house: { origin, houseKey: bs58.encode(houseKey.publicKey), incarnation: 'house_root' },
    manifestDigest: cidFromCanonical(rawBytes), signedAt: 1 };
  const coreBytes = popclaw.world.ManifestProof.encode(core).finish(), prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
  const signing = new Uint8Array(prefix.length + coreBytes.length); signing.set(prefix); signing.set(coreBytes, prefix.length);
  proof = Buffer.from(popclaw.world.ManifestProof.encode({ ...core, authoritySignature: nacl.sign.detached(signing, houseKey.secretKey) }).finish()).toString('base64');
  writeFileSync(join(paths.rootDir(), 'config/plugin.json'), JSON.stringify({ lore_houses: [origin] }));
  const db = new LocalHostDb(paths.socialDb());
  let storeId: string | undefined;
  try {
    ensureHouseLifecycleSchema(db);
    const pin = Buffer.from(houseKey.publicKey).toString('hex');
    db.transaction((await makeWorldManifestPreparer()({ origin, rawBytes, proofHeader: proof, ackKeyHex: pin,
      provenance: 'configured_pin', signal: new AbortController().signal })).commit);
    if (intent) db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,ack_key_hex,remote_status) VALUES(?,?,'enabled','disconnected',1,?,'unsupported')", [origin, resolveInstallationId(db), pin]);
    if (prebuilt) {
      const catalog = new ExecutionStoreCatalog({ db, paths, actorId });
      try {
        storeId = catalog.open(origin).storeId;
        const maintenance = MaintenanceSession.begin(db, paths, 'synthetic root journal');
        initializePublicStreamJournal({ catalog, origin, maintenance, configuredPin: pin });
        maintenance.finish({ recovery: held, reason: held ? 'synthetic held restore' : 'synthetic ready' });
      } finally { catalog.close(); }
    }
  } finally { db.close(); }
  const guard = join(root, 'guard.mjs');
  writeFileSync(guard, `import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns';
import {appendFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const origin=${JSON.stringify(origin)}, port=${JSON.stringify(String(address.port))};
const deny=()=>{const error=new Error('non-fixture network forbidden');appendFileSync(${JSON.stringify(attempts)},error.stack+'\\n');throw error;};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const target=Array.isArray(args[0])?args[0][0]:args[0];
if(typeof target?.path==='string'||(typeof target==='string'&&target.startsWith('/')))return connect.apply(this,args);
if(target&&typeof target==='object'&&(target.hostname??target.host)==='127.0.0.1'&&String(target.port)===port)return connect.apply(this,args);return deny();};
const allowed=target=>{try{return new URL(typeof target==='string'||target instanceof URL?target:'http://'+(target.hostname??target.host)+':'+target.port).origin===origin;}catch{return false;}};
const request=http.request,get=http.get;
http.request=function(...args){if(!allowed(args[0]))return deny();return request.apply(this,args);};
http.get=function(...args){if(!allowed(args[0]))return deny();return get.apply(this,args);};
https.request=deny;https.get=deny;dns.lookup=deny;dns.resolve=deny;
const fetch=globalThis.fetch;globalThis.fetch=(input,init)=>{if(!allowed(input instanceof Request?input.url:input))return deny();return fetch(input,init);};syncBuiltinESMExports();`);
  const env = { HOME: home, PATH: process.env.PATH ?? '', TMPDIR: root, LANG: 'en_US.UTF-8', POPCLAW_DATA_ROOT: paths.rootDir(),
    POPCLAW_WEB_BASE_URL: origin, POPCLAW_CANVAS_BASE_URL: origin, ...(mode !== null ? { POPCLAW_WORLD_STREAM: mode } : {}) };
  function start(entry = 'mcp.ts', args: string[] = []) {
    const proc = spawn(process.execPath, ['--import', guard, '--import', 'tsx', join(pkgRoot, 'src', entry), ...args],
      { cwd: pkgRoot, env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    let stdout = '', stderr = '', sequence = 0;
    proc.stdout.on('data', value => { stdout += value; }); proc.stderr.on('data', value => { stderr += value; });
    const done = new Promise<number | null>((yes, no) => { proc.once('error', no); proc.once('close', yes); });
    const stop = async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) { await done; return; }
      proc.kill('SIGTERM'); const timer = setTimeout(() => proc.kill('SIGKILL'), 4_000);
      try { await done; } finally { clearTimeout(timer); }
      expect(proc.signalCode).not.toBe('SIGKILL');
    };
    cleanup.push(stop);
    async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
      const id = ++sequence; proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      let message: { result?: Record<string, unknown>; error?: unknown } | undefined;
      await until(() => {
        if (proc.exitCode !== null) throw new Error(stderr);
        message = stdout.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown }).find(value => value.id === id);
        return !!message;
      }, () => stderr);
      expect(message!.error).toBeUndefined(); return message!.result!;
    }
    async function activate() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'public-root-test', version: '1' } });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return capabilities();
    }
    const capabilities = async () => (await rpc('tools/call', { name: 'popclaw_world_capabilities', arguments: { house: origin } })).structuredContent as Record<string, unknown>;
    return { proc, done, stop, rpc, activate, capabilities, stdout: () => stdout, stderr: () => stderr };
  }
  /** The store id the CATALOG names — for `prebuilt: false` only the root
   * itself can have published it, so it is read back rather than remembered. */
  function selectedStoreId(): string {
    if (storeId) return storeId;
    const global = new LocalHostDb(paths.socialDb(), { readOnly: true });
    try { storeId = global.queryOne<{ store_id: string }>('SELECT store_id FROM execution_store_catalog_v1 WHERE origin=?', [origin])?.store_id; }
    finally { global.close(); }
    if (!storeId) throw new Error('FIXTURE_NO_SELECTED_PARTITION');
    return storeId;
  }
  /** Null both when the catalog table has never been created and when it holds
   * no row for this house — before a first use, neither exists. */
  function selectedRow(): { store_id: string; required_tables?: string } | null {
    const global = new LocalHostDb(paths.socialDb(), { readOnly: true });
    try {
      if (!global.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_store_catalog_v1'")) return null;
      return global.queryOne<{ store_id: string; required_tables?: string }>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]) ?? null;
    } finally { global.close(); }
  }
  function execution<T>(read: (db: LocalHostDb) => T): T {
    const db = new LocalHostDb(paths.executionDb(selectedStoreId()), { readOnly: true }); try { return read(db); } finally { db.close(); }
  }
  const noForbidden = () => expect(existsSync(attempts) ? readFileSync(attempts, 'utf8') : '').toBe('');
  return { root, paths, origin, start, execution, selectedRow, get executionPath() { return paths.executionDb(selectedStoreId()); },
    requests, streams, original, eventId: envelope.eventId, noForbidden };
}

/** Retain the observer connection across each RPC: data_version catches even
 * committed writes whose final row values happen to match the initial values. */
function storageObservation(db: LocalHostDb, global = false) {
  const schema = db.queryAll<{ type: string; name: string; sql: string | null }>(
    'SELECT type,name,sql FROM sqlite_master ORDER BY type,name');
  const tables = schema.filter(row => row.type === 'table').map(({ name }) => {
    const rows = db.queryAll<Record<string, unknown>>(`SELECT * FROM "${name.replaceAll('"', '""')}"`).map(row => {
      // The resident independently renews its global owner lease. It is not
      // display storage; retain every other field and every other table.
      if (global && name === 'house_lifecycle_owner') {
        const copy = { ...row }; delete copy.renewed_at; return copy;
      }
      return row;
    }).map(row => JSON.stringify(row)).sort();
    return { name, rows };
  });
  return { sha256: createHash('sha256').update(JSON.stringify({ schema, tables })).digest('hex'),
    tables: tables.map(({ name, rows }) => ({ name, count: rows.length })) };
}

async function verifyDisplayQueries(f: Awaited<ReturnType<typeof fixture>>, run: ReturnType<Awaited<ReturnType<typeof fixture>>['start']>, phase: string, history = false) {
  const execution = new LocalHostDb(f.executionPath, { readOnly: true });
  const global = new LocalHostDb(f.paths.socialDb(), { readOnly: true });
  const cacheFiles = () => existsSync(f.paths.lorehousesDir()) ? readdirSync(f.paths.lorehousesDir()).filter(name => name.endsWith('.db')).sort() : [];
  const caches = cacheFiles().map(name => ({ name, db: new LocalHostDb(join(f.paths.lorehousesDir(), name), { readOnly: true }) }));
  const cacheObservation = () => caches.map(({ name, db }) => ({ name, ...storageObservation(db),
    dataVersion: db.queryOne<{ data_version: number }>('PRAGMA data_version')!.data_version }));
  try {
    for (const [name, args] of [
      ['popclaw_show_feed', { limit: 10 }],
      ['popclaw_show_feed', { filter_by_author: history ? actorId : 'Synthetic', limit: 10 }],
      ['popclaw_search_feed', { query: 'Synthetic public root evidence', limit: 10 }],
    ] as const) {
      const before = { execution: storageObservation(execution), global: storageObservation(global, true),
        caches: cacheObservation(), cacheFiles: cacheFiles(),
        dataVersion: execution.queryOne<{ data_version: number }>('PRAGMA data_version')!.data_version };
      const requestCount = f.requests.length;
      const response = await run.rpc('tools/call', { name, arguments: args });
      expect(response.isError).not.toBe(true);
      const content = response.content as Array<{ type: string; text?: string }>;
      const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
      expect(text).toContain('Synthetic public root evidence');
      expect(text).toContain(f.eventId);
      expect(text).toMatch(/local/i);
      if (history) expect(text).toMatch(/history/i);
      const after = { execution: storageObservation(execution), global: storageObservation(global, true),
        caches: cacheObservation(), cacheFiles: cacheFiles(),
        dataVersion: execution.queryOne<{ data_version: number }>('PRAGMA data_version')!.data_version };
      expect(after).toEqual(before);
      expect(f.requests.slice(requestCount)).toEqual([]);
      expect(execution.queryAll('SELECT * FROM world_public_consumers_v1')).toEqual([]);
      for (const db of [execution, ...caches.map(cache => cache.db)]) {
        if (db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_feed'")) {
          expect(db.queryAll('SELECT * FROM world_feed')).toEqual([]);
        }
      }
      // Fixed-candidate evidence stays in the ordinary test log; no synthetic
      // roots survive cleanup and no user-data fixture is involved.
      console.info('PUBLIC_DISPLAY_QUERY_EVIDENCE', JSON.stringify({ phase, name, args, before, after,
        globalExcludedField: 'house_lifecycle_owner.renewed_at', extraRequests: f.requests.slice(requestCount) }));
    }
  } finally { for (const { db } of caches) db.close(); global.close(); execution.close(); }
}

it('actual MCP receives exact raw bytes without session/inbox/Ranger and actual CLI remains a reader', async () => {
  const f = await fixture(), run = f.start(); await run.activate();
  await until(() => f.execution(db => db.queryAll('SELECT * FROM world_public_events_v1').length) === 1, run.stderr);
  expect(f.execution(db => new Uint8Array(db.queryOne<{envelope: Uint8Array}>('SELECT envelope FROM world_public_events_v1')!.envelope))).toEqual(f.original);
  await until(() => f.execution(db => db.queryOne<{phase: string}>('SELECT phase FROM world_public_bindings_v1')?.phase) === 'live', run.stderr);
  expect(await run.capabilities()).toMatchObject({ context_complete: false, public_reception: { mode: 'public-v1', support: 'supported',
    receive: { caughtUp: true, publicAfter: '1' }, consumers: { cache: 'unsupported', notifications: 'unsupported', ranger: 'unsupported' } } });
  await verifyDisplayQueries(f, run, 'received');
  const before = f.requests.filter(request => request.url.includes('mode=public-v1')).length;
  const reader = f.start('main.ts', ['world', 'capabilities', f.origin]);
  await until(() => reader.proc.exitCode !== null, reader.stderr);
  expect(await reader.done).toBe(0);
  expect(JSON.parse(reader.stdout()).public_reception.transport).toBe('inactive');
  expect(f.requests.filter(request => request.url.includes('mode=public-v1'))).toHaveLength(before);
  expect(f.requests.filter(request => request.method !== 'GET' || request.url.includes('/inbox/') || request.url.includes('/world-feed/') || request.authorization)).toEqual([]);
  const db = new LocalHostDb(f.paths.socialDb(), { readOnly: true });
  try { expect(db.queryOne<{session_id: string}>('SELECT session_id FROM house_participation')?.session_id).toBe(''); } finally { db.close(); }
  await run.stop(); await until(() => f.streams.size === 0);
  f.noForbidden();
}, 40_000);

it('actual newly joined house reaches the public display with no out-of-band journal initializer', async () => {
  const f = await fixture('public-v1', true, false, false);
  // Nothing built the partition beforehand: no catalog row, no store file.
  expect(f.selectedRow()).toBeNull();
  const run = f.start(); await run.activate();
  await until(() => f.execution(db => db.queryAll('SELECT * FROM world_public_events_v1').length) === 1, run.stderr);
  expect(f.execution(db => new Uint8Array(db.queryOne<{envelope: Uint8Array}>('SELECT envelope FROM world_public_events_v1')!.envelope))).toEqual(f.original);
  await until(() => f.execution(db => db.queryOne<{phase: string}>('SELECT phase FROM world_public_bindings_v1')?.phase) === 'live', run.stderr);
  expect(await run.capabilities()).toMatchObject({ public_reception: { mode: 'public-v1', support: 'supported',
    receive: { caughtUp: true, publicAfter: '1' } } });
  // The root itself published the eight names it now reads through.
  expect(JSON.parse(f.selectedRow()!.required_tables ?? '[]')).toEqual(expect.arrayContaining([...PUBLIC_JOURNAL_TABLES]));
  await verifyDisplayQueries(f, run, 'newly-joined');
  await run.stop(); await until(() => f.streams.size === 0);
  // The per-frame fence agrees on the row the root published for itself.
  const db = new LocalHostDb(f.paths.socialDb());
  const catalog = new ExecutionStoreCatalog({ db, paths: f.paths, actorId });
  try { expect(catalog.isPublicJournalCurrent(f.origin, catalog.open(f.origin))).toBe(true); }
  finally { catalog.close(); db.close(); }
  f.noForbidden();
}, 40_000);

it.each([false, true])('actual public root with held=%s never opens an unauthorized public slot', async held => {
  const f = await fixture('public-v1', held, held), run = f.start();
  await run.activate();
  const status = await run.capabilities();
  expect(status).toMatchObject({ public_reception: { transport: 'inactive', support: 'unsupported' } });
  expect(f.requests.filter(request => request.url.includes('/v1/world-stream') || request.url.includes('/inbox/') || request.url.includes('/world-feed/'))).toEqual([]);
  expect(f.execution(db => db.queryAll('SELECT * FROM world_public_events_v1'))).toEqual([]);
  f.noForbidden();
}, 30_000);

it.each([null, '1'])('actual mode %s preserves its separately selected legacy transport', async mode => {
  const f = await fixture(mode, false), run = f.start(); await run.activate();
  const endpoint = mode === '1' ? '/v1/world-stream' : '/world-feed/stream';
  await until(() => f.requests.some(request => request.url.startsWith(endpoint)), run.stderr);
  expect(f.requests.some(request => request.url.includes('mode=public-v1'))).toBe(false);
  expect(await run.capabilities()).toMatchObject({ public_reception: { mode: 'unselected', support: 'unsupported' } });
  f.noForbidden();
}, 30_000);

it('normal actual startup refuses a missing protected journal table without recreating it', async () => {
  const f = await fixture();
  const global = new LocalHostDb(f.paths.socialDb(), { readOnly: true });
  let storeId: string;
  try { storeId = global.queryOne<{store_id: string}>('SELECT store_id FROM execution_store_catalog_v1')!.store_id; }
  finally { global.close(); }
  const damaged = new LocalHostDb(f.paths.executionDb(storeId));
  try { damaged.execute('DROP TABLE world_public_imports_v1'); } finally { damaged.close(); }
  const run = f.start(); await run.activate();
  await until(() => run.stderr().includes('EXECUTION_REQUIRED_TABLE_MISSING'), run.stderr);
  expect(await run.capabilities()).toMatchObject({ public_reception: { support: 'unsupported', transport: 'inactive' } });
  expect(f.requests.some(request => request.url.includes('/v1/world-stream'))).toBe(false);
  expect(f.execution(db => db.queryOne("SELECT name FROM sqlite_master WHERE name='world_public_imports_v1'"))).toBeNull();
  f.noForbidden();
}, 30_000);

it('actual replacement resident resumes the durable public position without duplicating the raw event', async () => {
  const f = await fixture(), first = f.start(); await first.activate();
  await until(() => f.execution(db => db.queryOne<{phase: string}>('SELECT phase FROM world_public_bindings_v1')?.phase) === 'live', first.stderr);
  await first.stop(); await until(() => f.streams.size === 0);
  const second = f.start(); await second.activate();
  await until(() => f.requests.some(request => new URL(request.url, f.origin).searchParams.get('public_after') === '1'), second.stderr);
  await until(() => f.execution(db => db.queryOne<{phase: string}>('SELECT phase FROM world_public_bindings_v1')?.phase) === 'live', second.stderr);
  expect(f.execution(db => db.queryAll('SELECT * FROM world_public_events_v1'))).toHaveLength(1);
  expect(f.streams.size).toBe(1);
  await verifyDisplayQueries(f, second, 'restarted');
  const logout = await second.rpc('tools/call', { name: 'popclaw_house_logout', arguments: { host: f.origin } });
  expect(logout.isError).not.toBe(true);
  await until(() => f.streams.size === 0, second.stderr);
  expect(await second.capabilities()).toMatchObject({ public_reception: { transport: 'inactive' } });
  await verifyDisplayQueries(f, second, 'logged-out', true);
  await second.stop();
  const publicSlots = f.requests.filter(request => request.url.includes('mode=public-v1')).length;
  const third = f.start(); await third.activate();
  expect(await third.capabilities()).toMatchObject({ public_reception: { transport: 'inactive' } });
  await verifyDisplayQueries(f, third, 'restarted-after-logout', true);
  expect(f.requests.filter(request => request.url.includes('mode=public-v1'))).toHaveLength(publicSlots);
  expect(f.streams.size).toBe(0);
  f.noForbidden();
}, 40_000);
