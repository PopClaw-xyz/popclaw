import { mintHouse } from '../helpers/signed-manifest.js';
import { publishStorageJson, MaintenanceSession } from '../../src/host/storage-maintenance.js';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { WORLD_COMMAND_HELP, WORLD_COMMAND_SCHEMAS } from '../../src/commands/popclaw-world.js';
import { PopclawPaths } from '../../src/host/popclaw-paths.js';
import { hostDbSlug } from '../../src/ingress/host-slug.js';
import { verifyExecutionPartition, type ExecutionCatalogRow } from '../../src/host/execution-store.js';
import { FRESH_PARTITION_REQUIRED_TABLES } from '../../src/host/execution-partition-factory.js';

const pkgRoot = resolve(__dirname, '../..');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'house-entry-process-')); roots.push(root);
  const home = join(root, 'home'), data = join(root, 'data'), attempts = join(root, 'network-attempts');
  mkdirSync(home); mkdirSync(join(data, 'config'), {recursive: true});
  writeFileSync(join(data, 'config/plugin.json'), JSON.stringify({lore_houses: ['http://127.0.0.1:19991']}));
  const guard = join(root, 'offline.mjs');
  writeFileSync(guard, `import net from 'node:net';
import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns';
import {appendFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const deny = () => { const error = new Error('offline entry test forbids networking'); appendFileSync(${JSON.stringify(attempts)}, error.stack + '\\n'); throw error; };
// tsx uses a local Unix socket for loader IPC. Permit that transport only;
// all TCP connections, DNS and HTTP remain forbidden and counted.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof target?.path === 'string' || (typeof target === 'string' && target.startsWith('/'))) return connect.apply(this, args);
  return deny();
};
http.request = deny; http.get = deny;
https.request = deny; https.get = deny; dns.lookup = deny; dns.resolve = deny;
globalThis.fetch = deny; syncBuiltinESMExports();`);
  // Deliberately do not inherit process.env (tokens, production config or host hooks).
  const env = {HOME: home, PATH: process.env.PATH ?? '', TMPDIR: root, LANG: 'en_US.UTF-8',
    POPCLAW_DATA_ROOT: data, POPCLAW_WEB_BASE_URL: 'http://127.0.0.1:19991', POPCLAW_CANVAS_BASE_URL: 'http://127.0.0.1:19991'};
  return {root, data, attempts, guard, env};
}

function child(entry: string, args: string[], box: ReturnType<typeof sandbox>) {
  const proc = spawn(process.execPath, ['--import', box.guard, '--import', 'tsx', join(pkgRoot, 'src', entry), ...args],
    {cwd: pkgRoot, env: box.env, stdio: ['pipe', 'pipe', 'pipe']}) as ChildProcessWithoutNullStreams;
  let stdout = '', stderr = '';
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', chunk => {stdout += chunk;}); proc.stderr.on('data', chunk => {stderr += chunk;});
  const done = new Promise<number | null>((resolveExit, reject) => {proc.on('error', reject); proc.on('close', resolveExit);});
  return {proc, done, stdout: () => stdout, stderr: () => stderr};
}

async function stop(run: ReturnType<typeof child>) {
  if (run.proc.exitCode !== null || run.proc.signalCode !== null) {await run.done; return;}
  run.proc.kill('SIGTERM');
  const timer = setTimeout(() => run.proc.kill('SIGKILL'), 2000);
  try {await run.done;} finally {clearTimeout(timer);}
}

async function boundedExit(run: ReturnType<typeof child>, ms = 15000): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run.done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CLI did not exit: ${run.stderr()}`)), ms);
    })]);
  } finally {if (timer) clearTimeout(timer);}
}

function assertNoHouseCommands(box: ReturnType<typeof sandbox>) {
  const db = new LocalHostDb(join(box.data, 'vault/social/my-social-assets.db'));
  try {
    expect(db.queryAll('SELECT kind FROM house_lifecycle_commands')).toEqual([]);
    expect(db.queryAll('SELECT * FROM house_participation')).toEqual([]);
    expect(db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_participation_policy'")).toBeNull();
  } finally {db.close();}
}

describe('actual source process house entrypoints, isolated and offline', () => {
  it('MCP initialize/tools/list expose house and exact world schemas without runtime, SQLite or network', async () => {
    const box = sandbox(), run = child('mcp.ts', [], box);
    let seq = 0;
    async function request(method: string, params: unknown) {
      const id = ++seq;
      run.proc.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        for (const line of run.stdout().split('\n').slice(0,-1).filter(Boolean)) {
          const message = JSON.parse(line) as {id?: number; error?: unknown; result?: Record<string, unknown>};
          if (message.id === id) {expect(message.error).toBeUndefined(); return message.result!;}
        }
        if (run.proc.exitCode !== null) throw new Error(run.stderr());
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      throw new Error(`MCP ${method} timed out: ${run.stderr()}`);
    }
    try {
      await request('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'house-entry-test', version: '1'}});
      run.proc.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
      const result = await request('tools/list', {});
      const tools = result.tools as Array<{name: string; inputSchema: {type: string; required: string[]}}>;
      expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
      expect(readdirSync(box.data)).toEqual(['config']);
      expect(run.stderr()).not.toMatch(/NEW IDENTITY CREATED|identity loaded/);
      for (const name of ['popclaw_house_login', 'popclaw_house_logout']) {
        expect(tools.find(tool => tool.name === name)?.inputSchema).toMatchObject({type: 'object', required: ['host']});
      }
      for (const [command, schema] of Object.entries(WORLD_COMMAND_SCHEMAS)) {
        const matching = tools.filter(tool => tool.name === `popclaw_world_${command}`);
        expect(matching).toHaveLength(1);
        expect(matching[0]!.inputSchema).toEqual(schema);
      }
    } finally {await stop(run);}
  }, 25000);

  it.each([['--help', 0], ['not-a-command', 2]] as const)('CLI %s exits cheaply', async (arg, expectedCode) => {
    const box = sandbox(), run = child('main.ts', [arg], box);
    try {
      expect(await boundedExit(run)).toBe(expectedCode);
      expect(run.stdout() + run.stderr()).toContain('popclaw');
      expect(readdirSync(box.data)).toEqual(['config']);
      expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
    } finally {await stop(run);}
  }, 20000);

  it.each(['capabilities', 'action-status'] as const)('CLI world %s reads local context without login or networking', async command => {
    const box = sandbox(), origin = 'http://127.0.0.1:19991';
    const run = child('main.ts', ['world', command, origin, ...(command === 'action-status' ? ['a'.repeat(64)] : [])], box);
    try {
      expect(await boundedExit(run)).toBe(command === 'capabilities' ? 0 : 1);
      if (command === 'capabilities') {
        expect(JSON.parse(run.stdout())).toMatchObject({ code: 'CAPABILITY_CONTEXT_INCOMPLETE', context_complete: false, house: { origin } });
        expect(existsSync(new PopclawPaths(box.data).lorehousesDir())).toBe(false);
      } else {
        expect(run.stderr()).toContain('REQUEST_NOT_KNOWN');
        const dbPath = new PopclawPaths(box.data).lorehouseDb(hostDbSlug(origin));
        expect(existsSync(dbPath)).toBe(true);
        const db = new LocalHostDb(dbPath);
        try {expect(db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_participation_policy'")).toBeNull();}
        finally {db.close();}
      }
      expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
      assertNoHouseCommands(box);
    } finally {await stop(run);}
  }, 20000);

  it.each(['revoke', 'takeover', 'resume'] as const)('CLI world participation %s is now an unknown command that cannot reach an existing policy', async operation => {
    const box = sandbox(), origin = 'http://127.0.0.1:19991';
    const dbPath = new PopclawPaths(box.data).lorehouseDb(hostDbSlug(origin));
    const db = new LocalHostDb(dbPath);
    try {
      db.execute('CREATE TABLE world_participation_policy (binding TEXT PRIMARY KEY, state TEXT NOT NULL)');
      db.execute('INSERT INTO world_participation_policy VALUES (?,?)', ['existing-owner-policy', '{"unchanged":true}']);
    } finally {db.close();}
    const before = readFileSync(dbPath);
    const run = child('main.ts', ['world', 'participation', operation, origin, 'part_1'], box);
    try {
      // The tool and its CLI entrance are retired: `participation` takes the
      // same cheap unknown-command lane as any other word, before any bootstrap.
      expect(await boundedExit(run)).toBe(2);
      expect(run.stderr()).toContain('WORLD_CLI_ARGS_INVALID: unknown or missing command');
      expect(run.stderr()).toContain(WORLD_COMMAND_HELP);
      expect(run.stderr()).not.toContain('participation');
      expect(readFileSync(dbPath)).toEqual(before);
      // The social store the run would have had to open never comes into being,
      // so no world_participation_policy table can be created either.
      expect(existsSync(new PopclawPaths(box.data).socialDb())).toBe(false);
      expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
    } finally {await stop(run);}
  }, 20000);

  it('CLI world invoke waiting on stdin exits 143 after SIGTERM with no command or policy write', async () => {
    const box = sandbox(), run = child('main.ts', ['world', 'invoke', 'http://127.0.0.1:19991', 'reading.annotate',
      '--params-json', '-', '--expected-capability-revision', 'a'.repeat(64)], box);
    // Keep stdin open: this probes the real pending-input cancellation path.
    try {
      const deadline = Date.now() + 15000;
      while (!run.stderr().includes('popclaw-plugin starting')) {
        if (run.proc.exitCode !== null || Date.now() >= deadline) throw new Error(`CLI failed before its boot marker: ${run.stderr()}`);
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      expect(run.proc.kill('SIGTERM')).toBe(true);
      expect(await boundedExit(run, 4000)).toBe(143);
      expect(run.proc.exitCode).toBe(143);
      expect(run.stdout()).toBe('');
      expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
      expect(existsSync(new PopclawPaths(box.data).lorehousesDir())).toBe(false);
      assertNoHouseCommands(box);
    } finally {await stop(run);}
  }, 22000);

  it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('CLI starting marker has cancellation installed before %s can arrive', async (signal, code) => {
    const box = sandbox(), observation = join(box.root, 'starting-signal-handlers.json');
    // Deliver at the write itself, rather than hoping the parent wins the
    // small gap between a published boot marker and signal registration.
    writeFileSync(box.guard, readFileSync(box.guard, 'utf8') + `
const write = process.stderr.write;
process.stderr.write = function (chunk, ...args) {
  const result = write.call(this, chunk, ...args);
  if (String(chunk).includes('popclaw-plugin starting')) {
    appendFileSync(${JSON.stringify(observation)}, JSON.stringify({SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM')}));
    process.kill(process.pid, ${JSON.stringify(signal)});
  }
  return result;
};`);
    const run = child('main.ts', ['world', 'invoke', 'http://127.0.0.1:19991', 'reading.annotate',
      '--params-json', '-', '--expected-capability-revision', 'a'.repeat(64)], box);
    try {
      const deadline = Date.now() + 15000;
      while (!existsSync(observation)) {
        if (run.proc.exitCode !== null || run.proc.signalCode !== null || Date.now() >= deadline) {
          throw new Error(`CLI failed before its boot marker: ${run.stderr()}`);
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      const exitCode = await boundedExit(run, 4000);
      expect({exitCode, signalCode: run.proc.signalCode,
        handlers: JSON.parse(readFileSync(observation, 'utf8'))}).toEqual({exitCode: code, signalCode: null,
        handlers: {SIGINT: 1, SIGTERM: 1}});
      expect(run.proc.exitCode).toBe(code);
      expect(run.proc.signalCode).toBeNull();
      expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({SIGINT: 1, SIGTERM: 1});
      expect(run.stdout()).toBe('');
      expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
      expect(existsSync(new PopclawPaths(box.data).lorehousesDir())).toBe(false);
      assertNoHouseCommands(box);
    } finally {await stop(run);}
  }, 22000);

  it.each([['--help', 0], ['not-a-command', 2]] as const)('CLI world %s uses its cheap command lane', async (arg, expectedCode) => {
    const box = sandbox(), run = child('main.ts', ['world', arg], box);
    try {
      expect(await run.done).toBe(expectedCode);
      expect(run.stdout() + run.stderr()).toContain(WORLD_COMMAND_HELP);
      expect(readdirSync(box.data)).toEqual(['config']);
      expect(readdirSync(box.env.HOME)).toEqual([]);
      expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
      expect(run.stderr()).not.toMatch(/NEW IDENTITY CREATED|identity loaded/);
    } finally {await stop(run);}
  }, 20000);

  it.each(['maintenance','recovery','failed-boot'] as const)('MCP %s gate is applied on actual tool activation',async mode=>{
    const box=sandbox(), paths=new PopclawPaths(box.data),origin='http://127.0.0.1:19991';
    if(mode==='recovery') {
      const first=child('main.ts',['world','capabilities',origin],box);
      try{expect(await boundedExit(first)).toBe(0);}finally{await stop(first);}
    }
    if (mode === 'failed-boot') writeFileSync(join(box.data,'config/plugin.json'), JSON.stringify({lore_houses:[]}));
    else publishStorageJson(paths.storageControlFile(),{version:1,epoch:'c'.repeat(32),mode,reason:'synthetic storage gate',held:['execution','consumers','notifications'],releases:{}});
    const run=child('mcp.ts',[],box);let seq=0;
    async function rpc(method:string,params:unknown):Promise<Record<string,unknown>>{
      const id=++seq;run.proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
      const deadline=Date.now()+15000;
      while(Date.now()<deadline){
        for(const line of run.stdout().split('\n').slice(0,-1).filter(Boolean)){
          const message=JSON.parse(line) as {id?:number;result?:Record<string,unknown>;error?:unknown};
          if(message.id===id){expect(message.error).toBeUndefined();return message.result!;}
        }
        if(run.proc.exitCode!==null)throw new Error(run.stderr());
        await new Promise(resolveWait=>setTimeout(resolveWait,20));
      }
      throw new Error('MCP activation timeout: '+run.stderr());
    }
    try{
      await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'storage-test',version:'1'}});
      run.proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
      const result=await rpc('tools/call',{name:'popclaw_world_capabilities',arguments:{house:origin}});
      if(mode==='failed-boot'){
        expect(result.isError).toBe(true);
        expect((await rpc('tools/call',{name:'popclaw_world_capabilities',arguments:{house:origin}})).isError).toBe(true);
        const db=new LocalHostDb(paths.socialDb());
        try {
          expect(db.queryAll('SELECT token,pid FROM storage_runtime_participants_v1')).toEqual([]);
          MaintenanceSession.begin(db,paths,'failed boot has fully closed').assertCurrent();
        } finally {db.close();}
      }else if(mode==='maintenance'){
        expect(JSON.stringify(result)).toContain('STORAGE_MAINTENANCE_PENDING');
        expect(existsSync(paths.socialDb())).toBe(false);
        expect(existsSync(join(paths.identityDir(),'master.key'))).toBe(false);
      }else{
        expect(JSON.stringify(result)).toContain('CAPABILITY_CONTEXT_INCOMPLETE');
        const pending=await rpc('tools/call',{name:'popclaw_notifications',arguments:{}});
        expect(JSON.stringify(pending)).toContain('STORAGE_RECOVERY_HELD');
      }
      expect(existsSync(box.attempts)?readFileSync(box.attempts,'utf8'):'').toBe('');
    }finally{await stop(run);}
  },30000);

  it('CLI maintenance is checked before identity/database bootstrap', async () => {
    const box=sandbox(), paths=new PopclawPaths(box.data);
    publishStorageJson(paths.storageControlFile(), {version:1,epoch:'a'.repeat(32),mode:'maintenance',reason:'synthetic migration',held:['execution','consumers','notifications'],releases:{}});
    const run=child('main.ts',['login','http://127.0.0.1:19991'],box);
    try {
      expect(await boundedExit(run)).toBe(1);
      expect(run.stderr()).toContain('STORAGE_MAINTENANCE_PENDING');
      expect(existsSync(paths.socialDb())).toBe(false);
      expect(existsSync(join(paths.identityDir(),'master.key'))).toBe(false);
      expect(existsSync(box.attempts)?readFileSync(box.attempts,'utf8'):'').toBe('');
    } finally {await stop(run);}
  },20000);

  it('CLI restored-root hold allows local capability inspection but never enqueues a copied-authority login',async()=>{
    const box=sandbox(), paths=new PopclawPaths(box.data), origin='http://127.0.0.1:19991';
    const initial=child('main.ts',['world','capabilities',origin],box);
    try{expect(await boundedExit(initial)).toBe(0);}finally{await stop(initial);}
    const key=readFileSync(join(paths.identityDir(),'master.key'));
    publishStorageJson(paths.storageControlFile(),{version:1,epoch:'b'.repeat(32),mode:'recovery',reason:'older synthetic backup',held:['execution','consumers','notifications'],releases:{}});
    const inspect=child('main.ts',['world','capabilities',origin],box);
    try{expect(await boundedExit(inspect)).toBe(0);}finally{await stop(inspect);}
    const login=child('main.ts',['login',origin],box);
    try{
      expect(await boundedExit(login)).toBe(1);
      expect(login.stderr()).toContain('STORAGE_RECOVERY_HELD');
      assertNoHouseCommands(box);
      expect(readFileSync(join(paths.identityDir(),'master.key'))).toEqual(key);
      expect(existsSync(box.attempts)?readFileSync(box.attempts,'utf8'):'').toBe('');
    }finally{await stop(login);}
  },30000);

  it('CLI login without an owner durably queues and reports pending without remote traffic', async () => {
    const box = sandbox(), run = child('main.ts', ['login', 'http://127.0.0.1:19992'], box);
    try {
      expect(await run.done).toBe(1);
      expect(run.stdout()).toContain('queued locally');
      expect(run.stdout()).toContain('server session is not confirmed');
      expect(run.stdout()).not.toContain('Logged in to');
      expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
      const db = new LocalHostDb(join(box.data, 'vault/social/my-social-assets.db'));
      try {
        expect(db.queryAll('SELECT kind, house_origin, state FROM house_lifecycle_commands')).toEqual([
          {kind: 'login', house_origin: 'http://127.0.0.1:19992', state: 'pending'},
        ]);
        expect(db.queryAll('SELECT * FROM house_participation')).toEqual([]);
      } finally {db.close();}
      expect(readFileSync(join(box.data, 'config/plugin.json'), 'utf8')).toContain('19991');
    } finally {await stop(run);}
  }, 45000);
});

async function seedFirstReleasePublic(box: ReturnType<typeof sandbox>, origin = 'http://127.0.0.1:19991') {
  const { popclaw } = await import('@popclaw/contracts');
  const { cidFromCanonical, stripDefaultKeys } = await import('@popclaw/algorithms');
  const { default: nacl } = await import('tweetnacl'); const { default: bs58 } = await import('bs58');
  const { makeWorldManifestPreparer } = await import('../../src/world/world-capabilities.js');
  const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
  const rawBytes = new TextEncoder().encode(JSON.stringify({ world_interaction: { version: 1,
    public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: 'log_1', envelope_baseline: 'public-envelope-01' as const, initial_public_scopes: ['sc_public'] } } }));
  const core = { house: { origin, houseKey: bs58.encode(key.publicKey), incarnation: 'first_release_house' }, manifestDigest: cidFromCanonical(rawBytes), signedAt: '1' };
  const bytes = popclaw.world.ManifestProof.encode(stripDefaultKeys(core)).finish(), prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
  const signing = new Uint8Array(prefix.length + bytes.length); signing.set(prefix); signing.set(bytes, prefix.length);
  const proof = popclaw.world.ManifestProof.encode({ ...core, authoritySignature: nacl.sign.detached(signing, key.secretKey) } as any).finish();
  const db = new LocalHostDb(new PopclawPaths(box.data).socialDb());
  try { db.transaction((await makeWorldManifestPreparer({ fetch: async () => { throw new Error('NO_GUIDE_FETCH'); } })({ origin, rawBytes,
    proofHeader: Buffer.from(proof).toString('base64'), ackKeyHex: Buffer.from(key.publicKey).toString('hex'), provenance: 'configured_pin', signal: new AbortController().signal })).commit); }
  finally { db.close(); }
  return { origin, revision: core.manifestDigest };
}
it('actual CLI reads the new global view and refuses invoke before creating action storage', async () => {
  const box = sandbox(), { origin, revision } = await seedFirstReleasePublic(box);
  const inspect = child('main.ts', ['world', 'capabilities', origin], box);
  try {
    expect(await boundedExit(inspect)).toBe(0);
    expect(JSON.parse(inspect.stdout())).toMatchObject({ capability_revision: revision, code: 'WORLD_LOCAL_UNSUPPORTED', context_complete: false,
      blocks: { public_stream: { validation: 'valid', support: 'unsupported', ready: false } } });
  } finally { await stop(inspect); }
  const params = join(box.root, 'params.json'); writeFileSync(params, '{}');
  const invoke = child('main.ts', ['world', 'invoke', origin, 'booking.reserve', '--params-json', params, '--expected-capability-revision', revision], box);
  try { expect(await boundedExit(invoke)).toBe(1); expect(invoke.stderr()).toContain('WORLD_LOCAL_UNSUPPORTED'); }
  finally { await stop(invoke); }
  expect(existsSync(new PopclawPaths(box.data).lorehousesDir())).toBe(false);
  expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
  assertNoHouseCommands(box);
}, 30000);
it('actual MCP reads the same new global view under restored-root holds without activation', async () => {
  const box = sandbox(), origin = 'http://127.0.0.1:19991';
  const initialize = child('main.ts', ['world', 'capabilities', origin], box);
  try { expect(await boundedExit(initialize)).toBe(0); } finally { await stop(initialize); }
  const { revision } = await seedFirstReleasePublic(box);
  publishStorageJson(new PopclawPaths(box.data).storageControlFile(), { version: 1, epoch: 'd'.repeat(32), mode: 'recovery', reason: 'first-release observation hold', held: ['execution', 'consumers', 'notifications'], releases: {} });
  const run = child('mcp.ts', [], box);
  let seq = 0;
  async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++seq; run.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      for (const line of run.stdout().split('\n').slice(0,-1).filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown };
        if (message.id === id) { expect(message.error).toBeUndefined(); return message.result!; }
      }
      if (run.proc.exitCode !== null) throw new Error(run.stderr());
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    throw new Error('MCP first-release timeout: ' + run.stderr());
  }
  try {
    // Declares elicitation on purpose, and it is the ONLY spawned client here that does.
    // That is what makes `serverBox.current = server` observable: with the box set this
    // client CAN be asked, so the refusal below has to come from the capability
    // projection; with the box unset it would come from the owner gate instead. The
    // sibling case below keeps `capabilities: {}` and proves the gate itself.
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'first-release-test', version: '1' } });
    run.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const result = await rpc('tools/call', { name: 'popclaw_world_capabilities', arguments: { house: origin } });
    expect(result.structuredContent).toMatchObject({ capability_revision: revision, code: 'WORLD_LOCAL_UNSUPPORTED', context_complete: false,
      blocks: { public_stream: { validation: 'valid', support: 'unsupported', ready: false } } });
    const invoke = await rpc('tools/call', { name: 'popclaw_world_invoke', arguments: { house: origin, kind: 'booking.reserve', params: {}, expected_capability_revision: revision } });
    // This host CAN ask its owner, so the owner gate is passed and the refusal is
    // the capability projection's, exactly as before this lane existed — and the
    // action still never reaches a dialog, so nothing is signed, attempted or
    // queued. Delete `serverBox.current = server` in src/mcp.ts and this flips to
    // OWNER_CONFIRMATION_UNAVAILABLE: this assertion is that line's only guard.
    expect(invoke.isError).toBe(true); expect(JSON.stringify(invoke)).toContain('WORLD_LOCAL_UNSUPPORTED');
    expect(JSON.stringify(invoke)).not.toContain('OWNER_CONFIRMATION_UNAVAILABLE');
    expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
    assertNoHouseCommands(box);
  } finally { await stop(run); }
}, 30000);

it('normal MCP startup keeps ordinary loopback handshake/SSE while new typed commands stay unsupported', async () => {
  const { createServer } = await import('node:http');
  const received: Array<{ method: string; url: string }> = [];
  const server = createServer((request, response) => {
    received.push({ method: request.method ?? '', url: request.url ?? '' });
    if (request.method === 'GET' && request.url === '/v1/manifest') {
      response.writeHead(200, { 'content-type': 'application/json', 'X-Popclaw-Manifest-Proof': signedHouse.proofHeader });
      response.end(Buffer.from(signedHouse.bodyBytes));
    } else if (request.method === 'GET' && (request.url?.startsWith('/world-feed/stream') || /^\/inbox\/[1-9A-HJ-NP-Za-km-z]{32,44}\/stream$/.test(request.url ?? ''))) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.write(': synthetic ordinary stream\n\n');
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const origin = `http://127.0.0.1:${address.port}`, box = sandbox();
  const signedHouse = mintHouse({ origin, seed: 27, incarnation: 'first_release_house', manifest: { official_ids: [] } });
  writeFileSync(join(box.data, 'config/plugin.json'), JSON.stringify({ lore_houses: [origin] }));
  box.env.POPCLAW_WEB_BASE_URL = origin; box.env.POPCLAW_CANVAS_BASE_URL = origin;
  // Allow only this owned loopback fixture and tsx's Unix loader socket.
  // No ambient credentials, production origin, external HTTP or DNS is inherited.
  writeFileSync(box.guard, `import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns';
import {appendFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const origin = ${JSON.stringify(origin)}, port = ${JSON.stringify(String(address.port))};
const deny = () => { const error = new Error('non-fixture networking forbidden'); appendFileSync(${JSON.stringify(box.attempts)}, error.stack + '\\n'); throw error; };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof target?.path === 'string' || (typeof target === 'string' && target.startsWith('/'))) return connect.apply(this, args);
  if (target && typeof target === 'object' && (target.hostname ?? target.host) === '127.0.0.1' && String(target.port) === port) return connect.apply(this, args);
  return deny();
};
const request = http.request, get = http.get;
const allowed = target => { try { return new URL(typeof target === 'string' || target instanceof URL ? target : 'http://' + (target.hostname ?? target.host) + ':' + target.port).origin === origin; } catch { return false; } };
http.request = function (...args) { if (!allowed(args[0])) return deny(); return request.apply(this, args); };
http.get = function (...args) { if (!allowed(args[0])) return deny(); return get.apply(this, args); };
https.request = deny; https.get = deny; dns.lookup = deny; dns.resolve = deny;
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => { if (!allowed(input instanceof Request ? input.url : input)) return deny(); return fetch(input, init); };
syncBuiltinESMExports();`);
  let run: ReturnType<typeof child> | undefined;
  try {
    const { revision } = await seedFirstReleasePublic(box, origin); run = child('mcp.ts', [], box);
    let seq = 0;
    async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
      const id = ++seq; run!.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        for (const line of run!.stdout().trim().split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown };
          if (message.id === id) { expect(message.error).toBeUndefined(); return message.result!; }
        }
        if (run!.proc.exitCode !== null) throw new Error(run!.stderr());
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      throw new Error('normal MCP fixture timeout: ' + run!.stderr());
    }
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'normal-first-release-test', version: '1' } });
    run.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const result = await rpc('tools/call', { name: 'popclaw_world_capabilities', arguments: { house: origin } });
    expect(result.structuredContent).toMatchObject({ capability_revision: revision, code: 'WORLD_LOCAL_UNSUPPORTED', blocks: { public_stream: { validation: 'valid', support: 'unsupported', ready: false } } });
    const invoke = await rpc('tools/call', { name: 'popclaw_world_invoke', arguments: { house: origin, kind: 'booking.reserve', params: {}, expected_capability_revision: revision } });
    // The refusal now comes one gate earlier: this client declared no elicitation
    // (`capabilities: {}`), so the owner cannot be asked at all and the action is
    // refused before the capability projection could report the generic
    // WORLD_LOCAL_UNSUPPORTED — which the capabilities read above still reports.
    // Either way nothing is signed, attempted or queued, which is what follows.
    expect(invoke.isError).toBe(true); expect(JSON.stringify(invoke)).toContain('OWNER_CONFIRMATION_UNAVAILABLE');
    // The doorbell and the page-state sync are legs every resident root owes,
    // this real MCP process included: nothing else collects a reader's ➕ off
    // the canvas, and nothing else tells the canvas which authors on a page
    // this reader follows. Waited for rather than slept past — they are the
    // one thing here that leaves on a timer of its own.
    const doorbell = (url: string) => url.startsWith('/v1/follow-intents?owner=');
    const pageState = (url: string) => url.startsWith('/v1/sync-requests?owner=');
    const expected: Array<(url: string) => boolean> = [
      url => url === '/v1/manifest',
      url => url.startsWith('/world-feed/stream'),
      doorbell,
      pageState,
    ];
    const startupDeadline = Date.now() + 10000;
    while (Date.now() < startupDeadline && !expected.every(want => received.some(r => want(r.url)))) {
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    expect(received).toEqual(expect.arrayContaining([{ method: 'GET', url: '/v1/manifest' }, expect.objectContaining({ method: 'GET', url: expect.stringContaining('/world-feed/stream') })]));
    expect(received.filter(request => doorbell(request.url))).not.toEqual([]);
    expect(received.filter(request => pageState(request.url))).not.toEqual([]);
    expect(received.filter(request => !(request.method === 'GET' && (request.url === '/v1/manifest' || request.url.startsWith('/world-feed/stream') || doorbell(request.url) || pageState(request.url) || /^\/inbox\/[1-9A-HJ-NP-Za-km-z]{32,44}\/stream$/.test(request.url))))).toEqual([]);
    expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
    const db = new LocalHostDb(new PopclawPaths(box.data).socialDb(), { readOnly: true });
    try {
      expect(db.queryAll('SELECT kind FROM house_lifecycle_commands')).toEqual([]);
      // A real MCP root, started with no script and no out-of-band step, comes
      // up with its execution ledgers already built: the storage precondition
      // for the owner-confirmation step holds here, which before this was the
      // silent `ACTION_RECEIPT_PROTECTION_INCOMPLETE` every fresh install hit.
      // Storage readiness is not house support: this fixture's house declares
      // no actions, so the capability block above is still unsupported.
      const rows = db.queryAll<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1');
      expect(rows).not.toEqual([]);
      for (const row of rows) {
        expect(JSON.parse(row.required_tables ?? '[]').sort()).toEqual([...FRESH_PARTITION_REQUIRED_TABLES]);
        const execution = new LocalHostDb(new PopclawPaths(box.data).executionDb(row.store_id), { readOnly: true });
        try {
          verifyExecutionPartition(execution, row, row.actor_id);
          for (const table of FRESH_PARTITION_REQUIRED_TABLES)
            expect(execution.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`)?.n).toBe(0);
          // Nothing a lifecycle owns was created along the way. The public
          // tables are storage the factory provisions; a binding, a log profile
          // and a cursor are what a subscription is made of, and none exists.
          expect(execution.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_participation_policy'")).toBeNull();
          for (const table of ['world_public_bindings_v1', 'world_public_log_profiles_v1', 'world_public_cursors_v1'] as const)
            expect(execution.queryAll(`SELECT * FROM "${table}"`)).toEqual([]);
        } finally { execution.close(); }
      }
    } finally { db.close(); }
  } finally {
    if (run) await stop(run); server.closeAllConnections();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
}, 30000);
