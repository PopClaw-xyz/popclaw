import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { uploadCanvas } from '../../../src/egress/canvas-egress.js';
import { noteContextTokenBudget, _resetBudgetForTest } from '../../../src/newspaper/host-budget.js';
import { publicMaterialSource } from '../../../src/newspaper/public-material-source.js';
import { NewspaperOutcomeStore, NewspaperStageStore, runDedicatedNewspaper, type NewspaperDispatchRecord } from '../../../src/newspaper/dedicated-session.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializePublicStreamJournal } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession } from '../../../src/host/storage-maintenance.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { Signer } from '../../../src/identity/signer.js';
import { commitLocalLogout, ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { makeWorldManifestPreparer } from '../../../src/world/world-capabilities.js';
import type { HouseStore } from '../../../src/ingress/world-feed-store.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';

import { PublicFeedDisplay } from '../../../src/ingress/public-feed-display.js';
import { PublicStreamJournal, EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST } from '../../../src/world/scoped-stream-journal.js';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { _resetIssuesForTest, getIssue } from '../../../src/newspaper/issue-store.js';
import { childSessionKey } from '../../../src/newspaper/dedicated-session.js';
const instances: HouseRuntime[] = [];
const displayCleanup: Array<() => void> = [];
beforeEach(() => { _resetIssuesForTest(); _resetBudgetForTest(); NewspaperOutcomeStore.clear(); });
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected network'); })));
afterEach(async () => {
  await Promise.all(instances.splice(0).map(instance => instance.stop()));
  vi.restoreAllMocks();
  for (const close of displayCleanup.splice(0).reverse()) close();
  vi.unstubAllGlobals();
});

const displayOrigin = 'https://display-runtime.invalid';
const displayPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
const displayPin = Buffer.from(displayPair.publicKey).toString('hex');

/** All initialization is explicit fixture setup; capture must only borrow the
 * selected handle after this setup has finished. No real host files are used. */
async function displayFixture() {
  const root = mkdtempSync(join(tmpdir(), 'house-runtime-display-'));
  displayCleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb());
  displayCleanup.push(() => db.close());
  runMigrations(db, join(import.meta.dirname, '../../../migrations'));
  establishTrust(db, {origin:displayOrigin, houseKey:bs58.encode(displayPair.publicKey), incarnation:'display_house_1'}, 'configured');
  ensureHouseLifecycleSchema(db);
  db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,ack_key_hex) VALUES(?,'fixture','enabled','disconnected',1,?)", [displayOrigin, displayPin]);
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: bs58.encode(displayPair.publicKey) });
  displayCleanup.push(() => catalog.close());
  const partition = catalog.open(displayOrigin);
  async function observe(log = 'display_log_1', officialIds: unknown = []) {
    const rawBytes = new TextEncoder().encode(JSON.stringify({ official_ids: officialIds, world_interaction: { version: 1,
      public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: log, envelope_baseline: 'public-envelope-01' as const, initial_public_scopes: [] } } }));
    const core = { house: { origin: displayOrigin, houseKey: bs58.encode(displayPair.publicKey), incarnation: 'display_house_1' },
      manifestDigest: cidFromCanonical(rawBytes), signedAt: 1 };
    const bytes = popclaw.world.ManifestProof.encode(core).finish(), prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
    const signing = new Uint8Array(prefix.length + bytes.length); signing.set(prefix); signing.set(bytes, prefix.length);
    const prepared = await makeWorldManifestPreparer()({ origin: displayOrigin, rawBytes, ackKeyHex: displayPin,
      provenance: 'configured_pin', signal: new AbortController().signal,
      proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...core,
        authoritySignature: nacl.sign.detached(signing, displayPair.secretKey) }).finish()).toString('base64') });
    db.transaction(prepared.commit);
  }
  await observe();
  const maintenance = MaintenanceSession.begin(db, paths, 'display fixture initialization');
  initializePublicStreamJournal({ catalog, origin: displayOrigin, maintenance, configuredPin: displayPin });
  maintenance.finish({ recovery: false, reason: 'synthetic journal initialized' });
  db.execute("UPDATE house_participation SET phase='connected',session_id='test_session',house_revision=5,lease_expires_at=?", [Math.floor(Date.now()/1000)+3600]);
  let pin = displayPin;
  const rt = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer: {} as Signer, origins: [displayOrigin], publicV1Mode: true,
    executionStores: catalog, configuredPinFor: () => pin });
  instances.push(rt);
  const cacheRecord = vi.fn();
  const house = { baseUrl: displayOrigin, slug: 'display-runtime-invalid', db: partition.db,
    executionDb: partition.db, dbPath: partition.path, cacheReadOnly: true,
    cache: { record: cacheRecord } } as unknown as HouseStore;
  const openStore = vi.fn(async () => house);
  rt.configureResources({ host: { db } as never, recipientPopclawId: catalog.options.actorId, worldStreamMode: true,
    stores: [house], openStore, isOfficialActor: () => false });
  return { rt, house, db, paths, catalog, partition, cacheRecord, openStore, observe,
    setPin: (value: string) => { pin = value; } };
}


async function newspaperFixture(avatar = false) {
  const f = await displayFixture();
  const captured = f.rt.capturePublicDisplay(f.house);
  const journal = new PublicStreamJournal({ executionDb: f.partition.db, capability: captured.capability,
    producerPolicy: captured.producerPolicy, selection: { fullPublic: true, scopes: [] }, consumerContracts: [],
    approvedConsumerMappingDigest: EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST,
    gate: { origin: displayOrigin, signal: new AbortController().signal, isActive: () => true } });
  journal.activate();
  const boundary = popclaw.world.PublicStreamBoundary.fromObject({ logIncarnation: 'display_log_1', highWaterSeq: '100', fullPublic: true });
  const generation = journal.begin(boundary, popclaw.world.PublicStreamBoundary.encode(boundary).finish(), journal.request());
  const body = 'Astronomy journal material faithfully retained for the normal personalized daily paper.';
  const e = { actor: { popclawId: bs58.encode(displayPair.publicKey), nickname: 'Journal author' }, timestamp: Math.floor(Date.now()/1000), post: { blocks: [{ content: body }] } };
  const bytes = canonicalizeEnvelope(e), eventId = cidFromCanonical(bytes);
  const raw = popclaw.event.EventEnvelope.encode({ ...e, eventId, signature: nacl.sign.detached(bytes, displayPair.secretKey) }).finish();
  journal.append(generation, popclaw.event.WorldStreamFrame.encode({ seq: 1, kind: 'post', envelope: raw, ...(avatar ? { projection: { eventId, platform: 'popclaw', platformPostId: eventId, authorPopclawId: bs58.encode(displayPair.publicKey), actorVerified: [{ platform:'x', handle:'astronomy_fixture' }] } } : {}) }).finish());
  const cacheDb = new LocalHostDb(join(f.paths.socialDb(), '..', 'empty-cache.db')); displayCleanup.push(() => cacheDb.close());
  const cache = new WorldFeedCache({ db: cacheDb }); await cache.start();
  const display = new PublicFeedDisplay({ sources: () => [{ origin: displayOrigin, slug: f.house.slug, capture: () => f.rt.capturePublicDisplay(f.house) }] });
  const runtime = { houseRuntime: f.rt, publicFeedDisplay: display, worldFeedCache: cache,
    inboxStore: { recent: () => [] }, socialGraph: { followsIn: () => false },
    boot: { nickname: 'Synthetic owner', webBaseUrl: 'https://example.invalid', loreHouseUrls: [],
      canvasBaseUrl: 'https://canvas.invalid', signer: { popclawId: vi.fn(async () => 'SyntheticPublisher'),
      sign: vi.fn(async (bytes: Uint8Array) => nacl.sign.detached(bytes, displayPair.secretKey)) } as unknown as Signer },
    uploadCanvas: vi.fn(async (options: Parameters<typeof uploadCanvas>[0]) => { options.assertCurrent?.(); return { url: 'https://canvas.invalid/paper?t=fixture' }; }),
    paths: f.paths };
  let fetchImage: Parameters<typeof registerPopclawTools>[0]['fetchImage'];
  let logger: ((message: string) => void) | undefined;
  function tools(sessionKey = childSessionKey('public-material-fixture')) {
    const registered = new Map<string, (id: string, args: unknown) => Promise<{text: string}>>();
    const api = { logger: { info: (message: string) => logger?.(message) }, registerTool(t: unknown) { const resolved = typeof t === 'function' ? t({ sessionKey }) : t;
      const tool = resolved as {name: string; execute: (id: string,args: unknown) => Promise<{text: string}>}; registered.set(tool.name, tool.execute); } };
    registerPopclawTools({ api, fetchImage, runtime: async () => runtime } as unknown as Parameters<typeof registerPopclawTools>[0]);
    return (name: string, args: unknown) => registered.get(name)!('fixture-call', args);
  }
  return { ...f, cache, runtime, tools, eventId, body, journal, generation, raw, setFetchImage: (value: typeof fetchImage) => { fetchImage = value; }, setLogger: (value: typeof logger) => { logger = value; } };
}

it('actual non-owner child gathers signed protected journal materials while the real old cache is empty', async () => {
  const f = await newspaperFixture();
  expect(f.cache.recentForReading(20)).toEqual([]);
  expect(f.runtime.publicFeedDisplay.read().items[0]?.body).toBe(f.body);
  expect(f.rt.resident.authority.captureEpoch()).toBeNull();
  const result = await f.tools()('popclaw_newspaper', { hours: 24 });
  expect(result.text).toContain('candidate_basis');
  expect(result.text).toContain('Astronomy');
  expect(fetch).not.toHaveBeenCalled();
});

function snapshot(db: LocalHostDb) {
  return db.queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map(({ name }) => [name, db.queryAll(`SELECT * FROM ${name}`)]);
}
async function gather(f: Awaited<ReturnType<typeof newspaperFixture>>) {
  const out = await f.tools()('popclaw_newspaper', { hours: 24 });
  const token = /candidate_basis="([A-Za-z0-9_-]+)"/.exec(out.text)?.[1];
  expect(token, out.text).toBeTruthy();
  return { token: token!, issue: getIssue(token!, f.paths.newspaperManifestsDir())! };
}
async function pick(f: Awaited<ReturnType<typeof newspaperFixture>>, token: string) {
  _resetIssuesForTest();
  const out = await f.tools()('popclaw_newspaper', { candidate_basis: token, picks: { taste: [1] } });
  const name = readdirSync(f.paths.newspaperManifestsDir()).find(n => !n.startsWith('c') && n.endsWith('.json'));
  expect(name, out.text).toBeTruthy();
  const material = name!.slice(0,-5);
  return { token: material, issue: getIssue(material, f.paths.newspaperManifestsDir())!, text: out.text };
}
async function publish(f: Awaited<ReturnType<typeof newspaperFixture>>, token: string) {
  _resetIssuesForTest();
  const issue = getIssue(token, f.paths.newspaperManifestsDir())!;
  const items = Object.fromEntries(issue.pulse.map((p,i) => [String(p.itemNumber ?? i+1), { q: p.text, h: 'Verified daily material', s: 'A faithful summary of astronomy material.' }]));
  return f.tools()('popclaw_publish_newspaper', { edit: { basis: token, masthead: 'Synthetic personal paper', teaser: 'A synthetic edition', items } });
}
it('gather → disk re-registration → picks → basis-only actual publish returns its fake URL without journal/cache writes', async () => {
  const f = await newspaperFixture(), before = snapshot(f.partition.db), globalBefore = snapshot(f.db);
  f.partition.db.execute('PRAGMA query_only=ON'); f.db.execute('PRAGMA query_only=ON');
  try {
  const candidate = await gather(f);
  expect(candidate.issue.publicMaterials?.references).toHaveLength(candidate.issue.pulse.length);
  const material = await pick(f, candidate.token);
  const result = await publish(f, material.token);
  expect(result.text).toContain('https://canvas.invalid/paper?t=fixture');
  expect(readFileSync(f.paths.lastNewspaperHtml(), 'utf8')).toContain('A faithful summary');
  expect(snapshot(f.partition.db)).toEqual(before); expect(snapshot(f.db)).toEqual(globalBefore);
  expect(f.cache.recentForReading(10)).toEqual([]); expect(f.cacheRecord).not.toHaveBeenCalled();
  expect(f.rt.resident.authority.captureEpoch()).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  } finally { f.partition.db.execute('PRAGMA query_only=OFF'); f.db.execute('PRAGMA query_only=OFF'); }
});
it('partial non-owner coverage, renew fields, new observations and an unrelated scope preserve old retained material', async () => {
  const f = await newspaperFixture(), candidate = await gather(f);
  expect(candidate.issue.publicCoverage?.[0]?.incomplete).toBe(true);
  f.db.execute("UPDATE house_participation SET lease_expires_at=lease_expires_at+3600,inbox_read_token='renewed',renew_after=renew_after+60,updated_at=updated_at+1");
  // A newer relay observation of the same event has its own projection. It must
  // not replace the old referenced frame's evidence or invalidate its metadata.
  const next = { actor: { popclawId: bs58.encode(displayPair.publicKey), nickname:'Later author' }, timestamp: Math.floor(Date.now()/1000), post: { blocks:[{content:'Another independent astronomy frame'}] } };
  const bytes = canonicalizeEnvelope(next), eventId = cidFromCanonical(bytes);
  const raw = popclaw.event.EventEnvelope.encode({ ...next,eventId,signature:nacl.sign.detached(bytes,displayPair.secretKey) }).finish();
  f.journal.append(f.generation,popclaw.event.WorldStreamFrame.encode({seq:2,kind:'post',envelope:raw}).finish());
  // Current projection is a replaceable relay observation, not the old
  // referenced frame. Targeted validation uses only that frame's projection.
  f.partition.db.execute("UPDATE world_public_events_v1 SET current_projection=?,projection_log='display_log_1',projection_seq='2' WHERE event_id=?", [
    popclaw.event.WorldFeedItem.encode({eventId:f.eventId,platform:'popclaw',platformPostId:f.eventId,actorNickname:'New observation',markCount:9}).finish(),f.eventId]);
  f.partition.db.execute("UPDATE world_public_bindings_v1 SET selection_json=?", [JSON.stringify({ fullPublic: true, scopes: ['unrelated_scope'] })]);
  f.partition.db.execute("UPDATE world_public_cursors_v1 SET after_seq='2'");
  const status = f.rt.publicReadStatus(displayOrigin);
  const transport = vi.spyOn(f.rt, 'publicReadStatus').mockReturnValue({ ...status, transport: 'active' });
  const material = await pick(f, candidate.token);
  expect(material.issue.pulse[0]?.author).toBe('Journal author');
  transport.mockReturnValue(status);
  expect((await publish(f, material.token)).text).toContain('https://canvas.invalid/paper?t=fixture');
});
it.each(['logout', 'expired lease', 'changed pin', 'changed capability', 'changed partition', 'storage hold', 'missing association', 'changed frame'])(
  'used public material refuses picks after %s, preserving the candidate ledger', async change => {
  const f = await newspaperFixture(), c = await gather(f);
  if (change === 'logout') commitLocalLogout(f.db, displayOrigin, f.rt.manager.installationId, 'synthetic_logout', Math.floor(Date.now()/1000), displayPin);
  if (change === 'expired lease') f.db.execute('UPDATE house_participation SET lease_expires_at=1');
  if (change === 'changed pin') f.setPin('00'.repeat(32));
  if (change === 'changed capability') await f.observe('rotated_log');
  if (change === 'changed partition') f.db.execute("UPDATE execution_store_catalog_v1 SET actor_id='another_actor'");
  if (change === 'storage hold') MaintenanceSession.begin(f.db, f.paths, 'synthetic hold');
  if (change === 'missing association') f.partition.db.execute('DELETE FROM world_public_associations_v1');
  if (change === 'changed frame') f.partition.db.execute("UPDATE world_public_frames_v1 SET frame_bytes=x'00'");
  const before = readFileSync(join(f.paths.newspaperManifestsDir(), c.token+'.json'), 'utf8');
  _resetIssuesForTest();
  const out = await f.tools()('popclaw_newspaper', { candidate_basis: c.token, picks_flat: [1] });
  expect(out.text).toContain('Gather a fresh candidate page');
  expect(readFileSync(join(f.paths.newspaperManifestsDir(), c.token+'.json'), 'utf8')).toBe(before);
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled(); expect(existsSync(f.paths.lastNewspaperHtml())).toBe(false);
});
it.each(['basis removed', 'coverage removed', 'body changed', 'frame reference changed'])(
  'trusted public runtime refuses tampered disk material: %s', async change => {
  const f = await newspaperFixture(), c = await gather(f), m = await pick(f,c.token);
  const file = join(f.paths.newspaperManifestsDir(), m.token+'.json'), raw = JSON.parse(readFileSync(file,'utf8'));
  if (change === 'basis removed') { delete raw.issue.publicMaterials; delete raw.issue.mode; }
  if (change === 'coverage removed') delete raw.issue.publicCoverage;
  if (change === 'body changed') raw.issue.pulse[0].text = 'Invented body not present in the signed journal.';
  if (change === 'frame reference changed') raw.issue.publicMaterials.references[0].sequence = '99';
  writeFileSync(file,JSON.stringify(raw));
  const out = await publish(f,m.token);
  expect(out.text).toContain('Gather a fresh candidate page');
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled(); expect(existsSync(f.paths.lastNewspaperHtml())).toBe(false);
});
it('actual admitted issue is rechecked after signer await before local save', async () => {
  const f = await newspaperFixture(), c = await gather(f), m = await pick(f,c.token);
  vi.spyOn(f.runtime.boot.signer,'popclawId').mockImplementation(async () => { f.db.execute('UPDATE house_participation SET lease_expires_at=1'); return 'SyntheticPublisher'; });
  const out = await publish(f,m.token);
  expect(out.text).toContain('Gather a fresh candidate page');
  expect(existsSync(f.paths.lastNewspaperHtml())).toBe(false); expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});
it('Canvas last signing await revocation prevents actual HTTP and reports the already saved local paper', async () => {
  const f = await newspaperFixture(), c = await gather(f), m = await pick(f,c.token);
  const previous = getGlobalDispatcher(), agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  let requests = 0;
  agent.get('https://canvas.invalid').intercept({ path: '/v1/canvas', method: 'POST' }).reply(() => { requests++; return { statusCode: 200, data: JSON.stringify({ url: 'https://canvas.invalid/actual-mock-result' }) }; });
  f.runtime.uploadCanvas.mockImplementation(uploadCanvas);
  vi.spyOn(f.runtime.boot.signer,'sign').mockImplementation(async bytes => { f.db.execute('UPDATE house_participation SET lease_expires_at=1'); return nacl.sign.detached(bytes,displayPair.secretKey); });
  try {
    const out = await publish(f,m.token);
    expect(requests).toBe(0); expect(existsSync(f.paths.lastNewspaperHtml())).toBe(true);
    expect(out.text).toContain('local paper was saved'); expect(out.text).toContain('Delivery stopped');
    expect(out.text).not.toContain('actual-mock-result');
    expect(NewspaperOutcomeStore.get(childSessionKey('public-material-fixture'))?.ok).toBe(false);
  } finally { setGlobalDispatcher(previous); await agent.close(); }
});
it('synthetic taste, bond alias and inbox remain in candidate, materials and final HTML', async () => {
  const f = await newspaperFixture(), id = bs58.encode(displayPair.publicKey);
  mkdirSync(join(f.paths.tasteDir(),'learned'),{recursive:true});
  writeFileSync(join(f.paths.tasteDir(),'learned','dreamed.md'), '---\ntags: [astronomy]\nmute: []\n---\nSynthetic taste prefers detailed astronomy writing.');
  Object.assign(f.runtime, { nameOf: () => 'Synthetic friend', bondsStore: { get: () => ({tier:'friend',remarkName:'Synthetic friend'}), list: () => [{popclawId:id,nickname:'Journal author',remarkName:'Synthetic friend',tier:'friend'}], recentDynamics: () => [{summary:'Discussed astronomy together'}] },
    inboxStore: { recent: () => [{ ts: Math.floor(Date.now()/1000), fromPopclawId:id,toPopclawId:'SyntheticPublisher',body:'Synthetic private ping for this test only.',receivedAtMs:Date.now() }] } });
  const out = await f.tools()('popclaw_newspaper', {hours:24});
  expect(out.text).toContain('Synthetic taste'); expect(out.text).toContain('Synthetic friend');
  const token = /candidate_basis="([A-Za-z0-9_-]+)"/.exec(out.text)![1]!;
  const material = await pick(f,token);
  expect(material.issue.pulse[0]?.reasons?.join(' ')).toContain('astronomy');
  expect(material.issue.pings[0]?.bodyPreview).toContain('Synthetic private ping');
  expect((await publish(f,material.token)).text).toContain('https://canvas.invalid/paper?t=fixture');
  const html = readFileSync(f.paths.lastNewspaperHtml(),'utf8');
  expect(html).toContain('Synthetic friend'); expect(html).toContain('Synthetic private ping');
});
it('initially unavailable optional house contributes status while another house makes a normal personalized paper', async () => {
  const f = await newspaperFixture(), source = publicMaterialSource(f.runtime)!;
  const actual = f.rt.publicMaterialSources.bind(f.rt);
  vi.spyOn(f.rt,'publicMaterialSources').mockImplementation(() => [...actual(), { origin:'https://missing.invalid', slug:'missing-invalid', capture: () => { throw new Error('UNAVAILABLE'); } }]);
  f.runtime.boot.loreHouseUrls = ['https://missing.invalid'] as never;
  const c = await gather(f), m = await pick(f,c.token);
  expect(c.issue.publicCoverage?.find(s => s.slug==='missing-invalid')?.unavailable).toBe(true);
  source.validate(m.issue);
  const out = await publish(f,m.token); expect(out.text).toContain('https://canvas.invalid/paper?t=fixture');
  const html = readFileSync(f.paths.lastNewspaperHtml(),'utf8');
  expect(html).toContain('public materials unavailable');
  expect(html).not.toContain('Nothing new from this lore-house today');
});
it('partial with no usable body is not reported as confirmed empty', async () => {
  const f = await newspaperFixture();
  f.partition.db.execute('DELETE FROM world_public_associations_v1');
  const out = await f.tools()('popclaw_newspaper',{hours:24});
  expect(out.text).toContain('coverage is incomplete'); expect(out.text).not.toContain('Nothing came in');
});
it('explicit unsupported draft-only request stops before material collection or dispatch', async () => {
  const f = await newspaperFixture();
  const read = vi.spyOn(f.rt,'publicMaterialSources');
  const out = await f.tools()('popclaw_newspaper',{no_upload:true});
  expect(out.text).toContain('not supported'); expect(read).not.toHaveBeenCalled(); expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});

it('budget-discarded observations are absent from the candidate basis and are not later dependencies', async () => {
  const f = await newspaperFixture();
  for (let seq=2; seq<=60; seq++) {
    const e = {actor:{popclawId:bs58.encode(displayPair.publicKey),nickname:'Journal author'},timestamp:Math.floor(Date.now()/1000),post:{blocks:[{content:`Astronomy item ${seq} `+'x'.repeat(2000)}]}};
    const bytes=canonicalizeEnvelope(e),eventId=cidFromCanonical(bytes);
    const raw=popclaw.event.EventEnvelope.encode({...e,eventId,signature:nacl.sign.detached(bytes,displayPair.secretKey)}).finish();
    f.journal.append(f.generation,popclaw.event.WorldStreamFrame.encode({seq,kind:'post',envelope:raw}).finish());
  }
  noteContextTokenBudget(childSessionKey('public-material-fixture'), 1000);
  const c=await gather(f);
  expect(c.issue.pulse.length).toBeLessThan(60);
  expect(c.issue.publicMaterials!.references).toHaveLength(c.issue.pulse.length);
  const used=new Set(c.issue.publicMaterials!.references.map(r=>r.eventId));
  const discarded=f.partition.db.queryAll<{event_id:string}>('SELECT event_id FROM world_public_frames_v1').find(r=>!used.has(r.event_id))!;
  f.partition.db.execute("UPDATE world_public_frames_v1 SET frame_bytes=x'00' WHERE event_id=?",[discarded.event_id]);
  const m=await pick(f,c.token);
  expect(m.issue.publicMaterials!.references).toHaveLength(m.issue.pulse.length);
  expect((await publish(f,m.token)).text).toContain('https://canvas.invalid/paper?t=fixture');
});

it.each(['empty','partial-no-material'] as const)('actual child collection %s reaches a content-free, accurate dispatcher receipt', async outcome => {
  const f=await newspaperFixture();
  f.partition.db.execute('DELETE FROM world_public_associations_v1');
  if(outcome==='empty') {
    const checkpoint={phase:'replay',publicThroughSeq:100};
    f.journal.checkpoint(f.generation,checkpoint,popclaw.world.PublicStreamCheckpoint.encode(checkpoint).finish());
  }
  const records: NewspaperDispatchRecord[]=[];
  let child='';
  const result=await runDedicatedNewspaper({makeIssueHint:()=> 'material-receipt-test', recordDispatch:r=>records.push(r),
    subagent:{run:async({sessionKey})=>{child=sessionKey; await f.tools(sessionKey)('popclaw_newspaper',{hours:24});return {runId:'synthetic-no-model'};},
      waitForRun:async()=>({status:'ok'}),deleteSession:async()=>{}}});
  expect(records[0]?.stage?.collection).toBe(outcome);
  expect(result).toContain(outcome==='empty'?'no usable newspaper materials':'coverage was incomplete');
  expect(result).not.toContain('without publishing a receipt');
  expect(JSON.stringify(records[0]?.stage)).not.toContain('Astronomy');
  expect(NewspaperStageStore.take(child)).toBeUndefined();
});
it('later candidate collection clears an earlier empty stage and real publication receipt wins',async()=>{
  const key=childSessionKey('precedence');
  NewspaperStageStore.collection(key,'partial-no-material');
  NewspaperStageStore.note(key,'candidatePage');
  expect(NewspaperStageStore.peek(key)?.collection).toBeUndefined();
  const result=await runDedicatedNewspaper({makeIssueHint:()=> 'precedence',subagent:{
    run:async({sessionKey})=>{NewspaperStageStore.collection(sessionKey,'source-refused');NewspaperOutcomeStore.set(sessionKey,{ok:true,receiptText:'Actual saved and delivered receipt'});return {runId:'no-model'};},
    waitForRun:async()=>({status:'ok'}),deleteSession:async()=>{}}});
  expect(result).toContain('Actual saved and delivered receipt');
  expect(result).not.toContain('could not be verified');
});
it('normal Canvas path reaches the actual upload implementation and returns only its received mock URL',async()=>{
  const f=await newspaperFixture(),c=await gather(f),m=await pick(f,c.token);
  const previous=getGlobalDispatcher(),agent=new MockAgent();agent.disableNetConnect();setGlobalDispatcher(agent);
  let requests=0;
  agent.get('https://canvas.invalid').intercept({path:'/v1/canvas',method:'POST'}).reply(()=>{requests++;return {statusCode:200,data:JSON.stringify({url:'https://canvas.invalid/actual-mock-result?t=fixture'})};});
  f.runtime.uploadCanvas.mockImplementation(uploadCanvas);
  try{expect((await publish(f,m.token)).text).toContain('https://canvas.invalid/actual-mock-result?t=fixture');expect(requests).toBe(1);}
  finally{setGlobalDispatcher(previous);await agent.close();}
});

it('used source revocation after collection and budgeting refuses before candidate ledger persistence',async()=>{
  const f=await newspaperFixture();
  f.setLogger(message=>{if(message.startsWith('popclaw: newspaper candidate page built')) f.db.execute('UPDATE house_participation SET lease_expires_at=1');});
  const out=await f.tools()('popclaw_newspaper',{hours:24});
  expect(out.text).toContain('Gather a fresh candidate page');
  expect(existsSync(f.paths.newspaperManifestsDir())).toBe(false);
});
it('avatar await revocation prevents local paper and publication while retaining the named material page',async()=>{
  const f=await newspaperFixture(true),c=await gather(f),m=await pick(f,c.token);
  const fetchImage=vi.fn(async()=>{f.db.execute('UPDATE house_participation SET lease_expires_at=1');return null;});
  f.setFetchImage(fetchImage);
  const out=await publish(f,m.token);
  expect(fetchImage).toHaveBeenCalled();
  expect(out.text).toContain('Gather a fresh candidate page');
  expect(existsSync(f.paths.lastNewspaperHtml())).toBe(false);expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
  expect(getIssue(m.token,f.paths.newspaperManifestsDir())).toBeTruthy();
});
it('an unavailable public source never falls back to the legacy cache adapter',async()=>{
  const f=await newspaperFixture();
  const read=vi.spyOn(f.cache,'recentForReading').mockImplementation(()=>{throw new Error('Legacy fallback must not run');});
  f.db.execute('UPDATE house_participation SET lease_expires_at=1');
  const out=await f.tools()('popclaw_newspaper',{hours:24});
  expect(out.text).toContain('public materials unavailable');expect(read).not.toHaveBeenCalled();
});
