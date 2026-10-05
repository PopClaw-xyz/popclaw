import {afterEach, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalHostAdapter} from '../../../src/host/local-host-adapter.js';
import {PopclawPaths} from '../../../src/host/popclaw-paths.js';
import {registerStorageRuntime} from '../../../src/host/storage-maintenance.js';
import type {HostDb} from '../../../src/host/host-db.js';
import {bootstrapPlugin} from '../../../src/runtime/plugin-bootstrap.js';
import {HouseRuntime} from '../../../src/runtime/house-lifecycle/house-runtime.js';
import {resolveInstallationId} from '../../../src/runtime/house-lifecycle/installation.js';
import {readParticipation} from '../../../src/runtime/house-lifecycle/participation-store.js';
import {localParticipationPort} from '../../../src/host/local-participation.js';
import type {HouseParticipationReason, HouseParticipationAdmissionPort} from '../../../src/runtime/house-lifecycle/participation-admission.js';
import {unstartedSessionlessHistory} from '../../../src/runtime/house-lifecycle/legacy-history.js';
import {stageParticipationPlan} from '../../../src/runtime/house-lifecycle/participation-journal.js';
import {houseReadAuthority} from '../../../src/identity/read-authority.js';
import {makeRelationBindingPreparer, type PreparedRelationBinding} from '../../../src/social-graph/relation-binding.js';
import type {HouseStore} from '../../../src/ingress/world-feed-store.js';
import {hostDbSlug} from '../../../src/ingress/host-slug.js';
import {mintHouse} from '../../helpers/signed-manifest.js';

const ME = 'https://house.popclaw.me';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; }

async function fixture(options: {
  start?: boolean;
  prepare?: (run: () => Promise<PreparedRelationBinding>, db: HostDb) => Promise<PreparedRelationBinding>;
  port?: (port: HouseParticipationAdmissionPort) => HouseParticipationAdmissionPort;
} = {}) {
  vi.stubGlobal('fetch', () => { throw new Error('REAL_NETWORK_FORBIDDEN'); });
  const root = mkdtempSync(join(tmpdir(), 'sessionless-retry-')), paths = new PopclawPaths(root);
  let release!: () => void;
  const host = new LocalHostAdapter({dataRoot: root, logger: {info() {}, warn() {}, error() {}},
    beforeDbInitialize: db => (release = registerStorageRuntime(db, paths))});
  const boot = await bootstrapPlugin(host), db = host.db;
  const house = mintHouse({origin: ME, seed: 109, manifest: {relations: {ordered: 1},
    read_auth: {schemes: ['popclaw-identity-read-v2']}, guide_url: '/guide.md'}});
  let unavailable = false;
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname === '/guide.md') return new Response('synthetic House business guide');
    if (unavailable) return new Response('', {status: 503});
    return house.fetch(url);
  });
  const port = localParticipationPort(() => ({reference: 'synthetic-install-receipt', actorId: boot.popclawId}));
  const prepare = makeRelationBindingPreparer({db});
  const rt = new HouseRuntime({db, signer: boot.signer, actorId: boot.popclawId, origins: [ME],
    participation: options.port?.(port) ?? port, fetch: transport,
    prepareRelationBinding: input => options.prepare ? options.prepare(() => prepare(input), db) : prepare(input),
    readAuthorityFor: origin => houseReadAuthority({db, signer: boot.signer}, origin),
    commandPollMs: 1, commandTimeoutMs: 1000, intentPollMs: 60_000});
  const store = {baseUrl: ME, db, cacheReadOnly: true, dbPath: paths.socialDb(), slug: hostDbSlug(ME), cache: {}} as unknown as HouseStore;
  rt.configureResources({host: {db} as never, recipientPopclawId: boot.popclawId,
    worldStreamMode: true, stores: [store], openStore: async () => store, isOfficialActor: () => false});
  if (options.start !== false) rt.start();
  closes.push(async () => { await rt.stop(); release(); db.close(); rmSync(root, {recursive: true, force: true}); });
  const installationId = resolveInstallationId(db);
  return {rt, db, boot, port, installationId, paths,
    manifestUnavailable: (value: boolean) => { unavailable = value; },
    source: (reason: HouseParticipationReason) => port.capture({reason, origin: ME, actorId: boot.popclawId, installationId})!};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function retainFailure(f: Fixture, reason: HouseParticipationReason, code = 'HOUSE_CONTROL_HISTORY_UNPROVEN') {
  const source = f.source(reason), id = `old-${f.db.queryOne<{n: number}>('SELECT COUNT(*) AS n FROM house_lifecycle_commands')!.n}`;
  f.db.execute(`INSERT INTO house_lifecycle_commands
    (request_id,kind,house_origin,baseline_seq,state,running_epoch,created_at,effect_json,result_json)
    VALUES (?,'login',?,0,'done',1,1,?,?)`, [id, ME, JSON.stringify({participationSource: source}),
    JSON.stringify({scope: 'local_installation', origin: ME, status: 'connecting', sessionId: '', errorCode: code})]);
  return {id, source};
}
function attempts(f: Fixture) { return f.db.queryAll('SELECT * FROM house_participation_attempts'); }
function commands(f: Fixture) { return f.db.queryAll('SELECT * FROM house_lifecycle_commands ORDER BY request_id'); }

it('joins through the normal initial entry with five retained unstarted failures and preserves their exact rows and identity', async () => {
  const f = await fixture();
  retainFailure(f, 'explicit_owner_join');
  for (let i = 0; i < 4; i++) retainFailure(f, 'initial_me_setup');
  const prior = commands(f), actor = f.boot.popclawId;
  expect(readParticipation(f.db, ME)).toBeNull();
  expect(await f.rt.activateInitialMe()).toMatchObject({admission: 'configured'});
  expect(commands(f).filter(row => prior.some(old => old.request_id === row.request_id))).toEqual(prior);
  expect(await f.boot.signer.popclawId()).toBe(actor);
  expect(attempts(f)).toHaveLength(1);
  expect(attempts(f)[0]).toMatchObject({state: 'committed'});
  expect(f.db.queryOne('SELECT state FROM house_initial_setup')).toEqual({state: 'completed'});
  expect(await f.rt.readHouseGuide(ME)).toMatchObject({status: 'available', guide: 'synthetic House business guide'});
  expect(await f.rt.activateInitialMe()).toBeUndefined();
});

it('retries a normal manifest outage before admission without erasing the failed command', async () => {
  const f = await fixture(); f.manifestUnavailable(true);
  expect(await f.rt.activateInitialMe()).toMatchObject({errorCode: 'HOUSE_MANIFEST_UNAVAILABLE'});
  expect(readParticipation(f.db, ME)).toBeNull(); expect(attempts(f)).toHaveLength(0);
  const prior = commands(f);
  f.manifestUnavailable(false);
  expect(await f.rt.activateInitialMe()).toMatchObject({admission: 'configured'});
  expect(commands(f).filter(row => row.request_id === prior[0]!.request_id)).toEqual(prior);
  expect(attempts(f)).toHaveLength(1);
});

it('lets the final normal request proceed after two login requests queued before the resident starts', async () => {
  const f = await fixture({start: false});
  const explicit = f.rt.commands.loginHouse(ME);
  // The durable queue orders equal timestamps by request ID, not caller order.
  // Model the earlier CLI request with a distinct timestamp before MCP enqueue.
  f.db.execute('UPDATE house_lifecycle_commands SET created_at=1');
  const initial = f.rt.activateInitialMe();
  f.rt.start();
  expect(await explicit).toMatchObject({errorCode: 'HOUSE_CONTROL_HISTORY_UNPROVEN'});
  expect(await initial).toMatchObject({admission: 'configured'});
  expect(commands(f)).toHaveLength(2); expect(attempts(f)).toHaveLength(1);
});

it('retries a stage-before-journal stale snapshot after another login is enqueued during prepare', async () => {
  const entered = deferred(), gate = deferred(); let calls = 0;
  const f = await fixture({prepare: async run => { if (++calls === 1) { entered.resolve(); await gate.promise; } return run(); }});
  const first = f.rt.activateInitialMe();
  try {
    await entered.promise;
    const second = f.rt.activateInitialMe();
    gate.resolve();
    expect(await first).toMatchObject({errorCode: 'STALE_OPERATION'});
    expect(await second).toMatchObject({admission: 'configured'});
    expect(commands(f)).toHaveLength(2); expect(attempts(f)).toHaveLength(1);
  } finally { gate.resolve(); }
});

it('refuses the same error string after admission was actually called and its attempt remains', async () => {
  let admissions = 0, preparations = 0;
  const f = await fixture({prepare: run => { preparations++; return run(); },
    port: port => ({...port, admit: async () => { admissions++; throw new Error('HOUSE_CONTROL_HISTORY_UNPROVEN'); }})});
  expect(await f.rt.activateInitialMe()).toMatchObject({errorCode: 'HOUSE_CONTROL_HISTORY_UNPROVEN'});
  expect(attempts(f)).toHaveLength(1); expect(attempts(f)[0]).toMatchObject({state: 'prepared'});
  expect(readParticipation(f.db, ME)).toBeNull();
  expect(await f.rt.activateInitialMe()).toMatchObject({errorCode: 'HOUSE_CONTROL_HISTORY_UNPROVEN'});
  expect(admissions).toBe(1); expect(preparations).toBe(1); expect(attempts(f)).toHaveLength(1);
});

function seedAttempt(f: Fixture, intent: string, operation: string, state = 'prepared') {
  f.db.execute(`INSERT INTO house_participation_attempts VALUES (?,?,?,?,?,?,?,NULL)`,
    [`attempt-${operation}`, `key-${operation}`, intent, operation, 'synthetic-digest',
      JSON.stringify({origin: 'https://other.invalid'}), state]);
}
it('checks every operation of a retained intent even when the journal plan names another origin', async () => {
  let preparations = 0;
  const f = await fixture({prepare: run => { preparations++; return run(); }});
  const old = retainFailure(f, 'explicit_owner_join');
  seedAttempt(f, old.source.originalIntentRef, 'another-operation', 'not_committed');
  expect(await f.rt.activateInitialMe()).toMatchObject({errorCode: 'HOUSE_CONTROL_HISTORY_UNPROVEN'});
  expect(preparations).toBe(0); expect(attempts(f)).toHaveLength(1);
  expect(readParticipation(f.db, ME)).toBeNull();
});

it.each(['pending', 'running', 'control', 'leave', 'unknown-result', 'foreign-source', 'schema', 'restore'] as const)(
  'refuses %s history with one changed fact after a positive SQLite proof', async change => {
    const f = await fixture({start: false}), old = retainFailure(f, 'explicit_owner_join');
    const current = retainFailure(f, 'initial_me_setup');
    f.db.execute("UPDATE house_lifecycle_commands SET state='running',result_json=NULL WHERE request_id=?", [current.id]);
    expect(unstartedSessionlessHistory(f.db, current.source, current.id)).toBe(true);
    switch (change) {
      case 'pending': f.db.execute("UPDATE house_lifecycle_commands SET state='pending' WHERE request_id=?", [old.id]); break;
      case 'running': f.db.execute("UPDATE house_lifecycle_commands SET state='running' WHERE request_id=?", [old.id]); break;
      case 'control': f.db.execute("UPDATE house_lifecycle_commands SET session_id='synthetic-control-session' WHERE request_id=?", [old.id]); break;
      case 'leave': f.db.execute(`INSERT INTO house_lifecycle_outbox
        (request_id,house_origin,op,op_seq,ack_key_hex,installation_id,created_at)
        VALUES ('synthetic-leave',?,'leave',1,'',?,1)`, [ME, f.installationId]); break;
      case 'unknown-result': f.db.execute('UPDATE house_lifecycle_commands SET result_json=? WHERE request_id=?',
        [JSON.stringify({scope: 'local_installation', origin: ME, status: 'connecting', sessionId: '', errorCode: 'UNKNOWN_ERROR'}), old.id]); break;
      case 'foreign-source': f.db.execute('UPDATE house_lifecycle_commands SET effect_json=? WHERE request_id=?',
        [JSON.stringify({participationSource: {...old.source, installationId: 'another-installation'}}), old.id]); break;
      case 'schema': f.db.execute('ALTER TABLE house_participation_attempts ADD COLUMN unknown_proof TEXT'); break;
      case 'restore': f.db.execute('CREATE TABLE storage_restore_applied_v1(epoch TEXT)'); f.db.execute("INSERT INTO storage_restore_applied_v1 VALUES('synthetic-restore')"); break;
    }
    expect(unstartedSessionlessHistory(f.db, current.source, current.id)).toBe(false);
    expect(readParticipation(f.db, ME)).toBeNull();
  });

it.each(['extra-attempt', 'changed-own-digest'] as const)(
  'does not commit when %s changes only the journal while admission awaits', async change => {
    const entered = deferred(), gate = deferred(); let intent = '', attempt = '';
    const f = await fixture({port: port => ({...port, admit: async (plan, lifetime) => {
      intent = plan.originalIntentRef; attempt = plan.attemptRef; entered.resolve(); await gate.promise;
      return port.admit(plan, lifetime);
    }})});
    retainFailure(f, 'initial_me_setup');
    const joining = f.rt.activateInitialMe();
    try {
      await entered.promise;
      if (change === 'extra-attempt') seedAttempt(f, intent, 'concurrent-operation');
      else f.db.execute("UPDATE house_participation_attempts SET plan_digest='changed' WHERE attempt_ref=?", [attempt]);
      gate.resolve();
      expect(await joining).toMatchObject({errorCode: 'STALE_OPERATION'});
      expect(readParticipation(f.db, ME)).toBeNull();
      expect(f.db.queryOne('SELECT origin FROM house_binding_pin WHERE origin=?', [ME])).toBeNull();
      expect(f.db.queryOne('SELECT state,receipt_json FROM house_participation_attempts WHERE attempt_ref=?', [attempt]))
        .toEqual({state: 'not_committed', receipt_json: null});
    } finally { gate.resolve(); }
  });

it.each(['{}', '{"origin":7}'])(
  'refuses a retained journal with unknown intent and unprovable House ownership: %s', async planJson => {
    const f = await fixture({start: false});
    retainFailure(f, 'explicit_owner_join');
    const current = retainFailure(f, 'initial_me_setup');
    f.db.execute("UPDATE house_lifecycle_commands SET state='running',result_json=NULL WHERE request_id=?", [current.id]);
    expect(unstartedSessionlessHistory(f.db, current.source, current.id)).toBe(true);
    seedAttempt(f, 'unrelated-intent', 'unknown-operation');
    f.db.execute('UPDATE house_participation_attempts SET plan_json=?', [planJson]);
    expect(unstartedSessionlessHistory(f.db, current.source, current.id)).toBe(false);
  });

it('excludes an attempt positively assigned to another House and another intent', async () => {
  const f = await fixture({start: false});
  retainFailure(f, 'explicit_owner_join');
  const current = retainFailure(f, 'initial_me_setup');
  f.db.execute("UPDATE house_lifecycle_commands SET state='running',result_json=NULL WHERE request_id=?", [current.id]);
  const source = f.port.capture({reason: 'explicit_owner_join', origin: 'https://other.invalid',
    actorId: f.boot.popclawId, installationId: f.installationId})!;
  stageParticipationPlan(f.db, source, {expectedParticipationJson: 'null', controlEvidenceJson: '{}',
    manifestDigest: 'synthetic-manifest', bindingDigest: 'synthetic-binding', configurationDigest: 'synthetic-config',
    ownerGeneration: 1, storageGeneration: 'synthetic-storage', beforeOpSeq: 0, afterOpSeq: 1, transitionDigest: 'synthetic-transition'});
  expect(unstartedSessionlessHistory(f.db, current.source, current.id)).toBe(true);
});
