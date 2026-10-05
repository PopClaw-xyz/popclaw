import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * C0 characterization of the MCP composition root (src/mcp.ts
 * `buildRuntime` + the shutdown `main()` wires), through the production entry:
 * `src/mcp.ts` spawned under tsx, as tests/integration/mcp-stdio.test.ts and
 * tests/helpers/mcp-handoff-harness.ts run it. `POPCLAW_RECEIVE_ON_START=1`
 * ignites the real lazy runtime; closing stdin is the real stop path
 * (`lifecycle.stop()` → `shutdown()` → `process.exit`).
 *
 * Observation is a `--import` preload (tests/helpers/root-assembly-mcp-preload.ts)
 * that patches prototypes of the classes the root instantiates and appends one
 * line per call to a file. What lives only in closures cannot be seen from
 * there — see the SKIPPED list at the bottom of this file.
 *
 * Completion points are events, never sleeps: `build.returning` (the build
 * reached the construction of its return value — every synchronous boot
 * statement before it has run; it does NOT mean the build promise resolved
 * or that any asynchronous work those statements started has finished), a
 * named component call, or the child's `close` (exited AND its stdio
 * drained, so stderr is complete).
 *
 * Offline: lore-house and Canvas both point at an unroutable loopback port
 * (`canvas_base_url` in plugin.json outranks POPCLAW_CANVAS_BASE_URL and the
 * public default), so the page-state and doorbell loops reach nothing either.
 *
 * Everything here pins CURRENT behaviour ahead of the shared-assembly move
 * (refactor-assembly-design §5/§6 C0). Drift rows carry their number from the
 * roots difference table; they are evidence, not endorsements.
 */

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TSX = join(pkgRoot, 'node_modules/tsx/dist/loader.mjs');
const PRELOAD = join(pkgRoot, 'tests/helpers/root-assembly-mcp-preload.ts');
/** Unroutable on purpose: every lore-house call fails, as in mcp-stdio. */
const HOUSE = 'http://127.0.0.1:9';
const STORE_DB = 'db.close:127-0-0-1-9.db';
const HOST_DB = 'db.close:my-social-assets.db';
const EXEC_DB = 'db.close:(execution store)';

const roots: string[] = [];
const children: Array<{ child: ReturnType<typeof spawn>; closed: Promise<unknown> }> = [];
afterEach(async () => {
  // Wait for each child to be fully gone before its data root is deleted.
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function spawnMcp(mode = '') {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-assembly-mcp-'));
  roots.push(root);
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'plugin.json'), JSON.stringify({ lore_houses: [HOUSE], canvas_base_url: HOUSE }));
  const file = join(root, 'c0-events.log');
  const initialDiagnostics = mode.startsWith('initial-soft-failure');
  const receipt = join(root, 'setup-receipt.json');
  if (initialDiagnostics && !mode.endsWith('no-evidence')) writeFileSync(receipt, JSON.stringify({format:1,digest:'synthetic-package-digest',
    root,package:dirname(pkgRoot),popclawId:'synthetic-actor',initialMe:{version:1,purpose:'initial_me_setup',origin:'https://house.popclaw.me',
      setupId:'synthetic-setup',actorId:'synthetic-actor',dataRoot:root}}));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env['POPCLAW_MCP_ENABLE_RANGER'];
  delete env['POPCLAW_WORLD_STREAM'];
  delete env['POPCLAW_SETUP_RECEIPT'];
  Object.assign(env, {
    POPCLAW_DATA_ROOT: root, POPCLAW_NOTIFICATION_CONSUMER: 'mcp:c0-characterization', POPCLAW_RECEIVE_ON_START: '1',
    LOG_LEVEL: initialDiagnostics ? 'info' : 'silent', C0_PROBE_FILE: file, C0_MODE: mode,
  });
  if(initialDiagnostics) {
    env['POPCLAW_RECEIVE_ON_START']='0';
    if(!mode.endsWith('no-evidence'))env['POPCLAW_SETUP_RECEIPT']=receipt;
  }
  const child = spawn(process.execPath, ['--import', TSX, '--import', PRELOAD, join(pkgRoot, 'src/mcp.ts')],
    { cwd: pkgRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data',(chunk:string)=>{stdout+=chunk;});
  child.stdout.resume();
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  // 'close', not 'exit': the process has exited AND its stdio has ended.
  const exited = new Promise<number | null>(done => child.on('close', code => done(code)));
  children.push({ child, closed: exited });
  const events = (): string[] => existsSync(file) ? readFileSync(file, 'utf-8').split('\n').filter(Boolean) : [];
  const waitFor = async (event: string, timeoutMs = 20_000): Promise<void> => {
    const until = Date.now() + timeoutMs;
    while (!events().includes(event)) {
      if (Date.now() > until || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`timed out waiting for ${event}; events=${JSON.stringify(events())}; stderr=${stderr.slice(-2000)}`);
      }
      await new Promise(done => setTimeout(done, 20));
    }
  };
  return { child, events, waitFor, exited, stderr: () => stderr, stdout: () => stdout, closeStdin: () => child.stdin.end() };
}

describe('MCP initial setup diagnostics',()=>{
  for(const evidence of [true,false])it(`normal initialized callback exposes bounded results; setup evidence=${evidence}`,async()=>{
    const mcp=spawnMcp(evidence?'initial-soft-failure':'initial-soft-failure-no-evidence');
    const send=(message:unknown)=>mcp.child.stdin.write(JSON.stringify(message)+'\n');
    const waitFrame=async(id:number)=>{
      await vi.waitFor(()=>expect(mcp.stdout().split('\n').filter(Boolean).map(line=>JSON.parse(line)).some(frame=>frame.id===id)).toBe(true),{timeout:20_000,interval:20});
    };
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'synthetic-startup-diagnostics',version:'1'}}});
    await waitFrame(1);
    send({jsonrpc:'2.0',method:'notifications/initialized'});
    // An unknown tool crosses the existing initialSetup wait without executing
    // any business body. The response is the startup completion barrier.
    send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'synthetic_diagnostic_barrier',arguments:{}}});
    await waitFrame(2);
    mcp.closeStdin();expect(await mcp.exited).toBe(0);
    const logs=mcp.stderr().split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    if(evidence){
      expect(logs).toContainEqual(expect.objectContaining({stage:'initial_me',status:'connecting',errorCode:'HOUSE_CONTROL_HISTORY_UNPROVEN',hasOperationId:true}));
      expect(logs).toContainEqual(expect.objectContaining({stage:'house_guide',status:'unavailable',code:'HOUSE_GUIDE_CONTEXT_STALE'}));
      expect(mcp.events().filter(e=>e==='houses.initial-me')).toHaveLength(1);
      expect(mcp.events().filter(e=>e==='houses.initial-guide')).toHaveLength(1);
    }else{
      expect(logs).toContainEqual(expect.objectContaining({stage:'initial_me',status:'not_started',reason:'setup_evidence_unavailable'}));
      expect(mcp.events()).not.toContain('houses.initial-me');expect(mcp.events()).not.toContain('houses.initial-guide');
      expect(mcp.events()).not.toContain('houses.start');
    }
    expect(mcp.stderr()).not.toContain('SYNTHETIC_PRIVATE_SESSION');expect(mcp.stderr()).not.toContain('SYNTHETIC_PRIVATE_OPERATION');
    for(const line of mcp.stdout().split('\n').filter(Boolean))expect(JSON.parse(line).jsonrpc).toBe('2.0');
  },60_000);
});

/** The component calls that make up a shutdown/cleanup sequence (house commands are timer noise). */
const sequence = (events: string[]) => events.filter(e => e !== 'houses.runCommand');

describe("MCP root — shutdown sequence ('mcp-legacy', row 28)", () => {
  it('stdin end: worlds, then houses, then house-store DB, execution stores, storage release (unconditional), host DB; exit 0', async () => {
    const mcp = spawnMcp();
    await mcp.waitFor('build.returning');
    const from = mcp.events().length;
    mcp.closeStdin();
    const code = await mcp.exited;
    expect({ code, events: sequence(mcp.events().slice(from)) }).toEqual({
      code: 0,
      events: [
        'worlds.stop',
        'houses.stop', 'worlds.whenIdle',
        STORE_DB,
        'executionStores.close', EXEC_DB,
        'release',
        HOST_DB,
      ],
    });
  }, 60_000);

  it('the first throwing step aborts the rest: no DB closed, storage not released, exit 1', async () => {
    const mcp = spawnMcp('houses-stop-throws');
    await mcp.waitFor('build.returning');
    const from = mcp.events().length;
    mcp.closeStdin();
    const code = await mcp.exited;
    expect({ code, events: sequence(mcp.events().slice(from)) }).toEqual({
      code: 1,
      events: ['worlds.stop', 'houses.stop'],
    });
  }, 60_000);
});

describe('MCP root — failed-boot cleanup (row 29)', () => {
  it('after houses are built: drains worlds/houses, closes the store DB then execution stores, releases, closes the host DB', async () => {
    const mcp = spawnMcp('boot-fails');
    await mcp.waitFor(HOST_DB);
    const events = mcp.events();
    expect(sequence(events.slice(events.indexOf('boot.fail') + 1))).toEqual([
      'worlds.stop', 'houses.stop', 'worlds.whenIdle',
      STORE_DB,
      'executionStores.close', EXEC_DB,
      'release',
      HOST_DB,
    ]);
  }, 60_000);

  it('CURRENT BEHAVIOUR: a boot that fails after relation reception opened leaves its drain timer running; its next tick hits the closed host DB and the process dies', async () => {
    const mcp = spawnMcp('boot-fails');
    await mcp.waitFor(HOST_DB);
    const code = await Promise.race([mcp.exited, new Promise<'alive'>(done => setTimeout(() => done('alive'), 10_000))]);
    expect({
      code,
      closedDb: mcp.stderr().includes('The database connection is not open'),
      fromDrainTick: /drainTick[^\n]*relation-host\.ts/.test(mcp.stderr()),
    }).toEqual({ code: 1, closedDb: true, fromDrainTick: true });
  }, 60_000);
});

describe('MCP root — boot order and drift rows pinned as current behaviour', () => {
  it('boot order: social graph started, resources configured, houses started, a house-bus command issued, build returned (the open-boot control for #7)', async () => {
    const mcp = spawnMcp();
    // One snapshot, taken once the build has reached its return value: by then
    // everything the build does synchronously after houses.start has happened.
    await mcp.waitFor('build.returning');
    const events = mcp.events();
    mcp.closeStdin();
    await mcp.exited;
    const boot = events.filter(e => /^(socialGraph\.start|houses\.configure|houses\.start|build\.returning)/.test(e));
    const start = events.indexOf('houses.start');
    expect({
      boot,
      commandBetweenStartAndReturn: events.slice(start + 1, events.indexOf('build.returning')).includes('houses.runCommand'),
    }).toEqual({
      boot: ['socialGraph.start', 'houses.configure refreshMs=(absent)', 'houses.start', 'build.returning'],
      // Something is on the house bus before the build returns: DM recovery
      // and/or a loop's first pass. This does not tell which (removing DM
      // recovery alone leaves it true); it is the control for #7 below.
      commandBetweenStartAndReturn: true,
    });
  }, 60_000);

  it('#24 handshake refresh interval is not set: configureResources gets no refreshMs (resource-set default applies)', async () => {
    const mcp = spawnMcp();
    await mcp.waitFor('build.returning');
    const configured = mcp.events().filter(e => e.startsWith('houses.configure'));
    mcp.closeStdin();
    await mcp.exited;
    expect(configured).toEqual(['houses.configure refreshMs=(absent)']);
  }, 60_000);

  it('#7 closing fired mid-boot (held in SocialGraph.start): the build still returns, houses are not started, HouseRuntime.runCommand is never called (so no DM recovery on the bus); the normal shutdown runs', async () => {
    // Not covered here: the four inline loops. Pinning and page-state never go
    // through the house bus, so "no runCommand" does not show that the loops
    // were skipped (see NOT COVERED below).
    const mcp = spawnMcp('hold-boot');
    await mcp.waitFor('socialGraph.start');
    const from = mcp.events().length;
    mcp.closeStdin();
    const code = await mcp.exited;
    const tail = mcp.events().slice(from);
    const booted = tail.slice(0, tail.indexOf('worlds.stop'));
    expect({ code, booted, shutdown: sequence(tail.slice(tail.indexOf('worlds.stop'))) }).toEqual({
      code: 0,
      booted: ['houses.configure refreshMs=(absent)', 'build.returning'],
      shutdown: ['worlds.stop', 'houses.stop', 'worlds.whenIdle', STORE_DB, 'executionStores.close', EXEC_DB, 'release', HOST_DB],
    });
  }, 60_000);
});

/*
 * NOT COVERED for the MCP root at C0 (owed by the C2 candidate, which must
 * drive the production MCP ports / root wiring, not only assembleRuntime with
 * fake ports — review of 3a087be8 §3):
 * - Runtime bag key set: the bag never leaves the child process.
 * - #16 follower-sync deps / #17 reply-ping bondContext: both objects are
 *   built inline and handed to function exports, which this ESM preload does
 *   not replace. Possible without src change: #17 through a controlled feed
 *   into the real onContent, which reaches configureResources.
 * - #18 invite notifier houseOrigin: reachable only through popclaw_status and
 *   a transport answering /v1/invites; needs a controlled transport, not a
 *   live house.
 * - The four inline loops (pinning, follower sync, doorbell, page-state):
 *   their construction/start under the closing and storage gates, and their
 *   stop in shutdown. "No runCommand" in #7 does not cover them.
 * - Shutdown steps that live in closures: the loop stops, owner authorization
 *   stop, and the ABSENCE of relationReception.stop (row 28).
 */
