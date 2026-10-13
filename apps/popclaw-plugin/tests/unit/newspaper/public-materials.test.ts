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
import { publicMaterialSource, NewspaperPublicMaterialSource } from '../../../src/newspaper/public-material-source.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';
import { readNewspaperDocument } from '../../../src/newspaper/reading-page.js';
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
import * as learnedWriter from '../../../src/taste/learned-writer.js';
import * as digestClient from '../../../src/world/digest-client.js';
import * as summaryMaterial from '../../../src/newspaper/summary-material.js';
import { withReadCallBudget } from '../../../src/runtime/read-call-budget.js';
import { RemoteHouseReadError } from '../../../src/runtime/house-lifecycle/read-failure.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';

import { PublicFeedDisplay } from '../../../src/ingress/public-feed-display.js';
import { HouseFeedReader } from '../../../src/ingress/house-feed-reader.js';
import * as publicJournal from '../../../src/ingress/public-journal-reader.js';
import { PublicStreamJournal, EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST } from '../../../src/world/scoped-stream-journal.js';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { _resetIssuesForTest, getIssue } from '../../../src/newspaper/issue-store.js';
import * as issueIdentity from '../../../src/newspaper/issue-identity.js';
import { childSessionKey } from '../../../src/newspaper/dedicated-session.js';
const instances: HouseRuntime[] = [];
const displayCleanup: Array<() => void> = [];
beforeEach(() => { _resetIssuesForTest(); _resetBudgetForTest(); NewspaperOutcomeStore.clear(); });
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected network'); })));
afterEach(async () => {
  await Promise.all(instances.splice(0).map(instance => instance.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of displayCleanup.splice(0).reverse()) close();
  vi.unstubAllGlobals();
});

const displayOrigin = 'https://display-runtime.invalid';
const displayPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
const displayPin = Buffer.from(displayPair.publicKey).toString('hex');

/** All initialization is explicit fixture setup; capture must only borrow the
 * selected handle after this setup has finished. No real host files are used. */
async function displayFixture(origin = displayOrigin) {
  const root = mkdtempSync(join(tmpdir(), 'house-runtime-display-'));
  displayCleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb());
  displayCleanup.push(() => db.close());
  runMigrations(db, join(import.meta.dirname, '../../../migrations'));
  establishTrust(db, {origin:origin, houseKey:bs58.encode(displayPair.publicKey), incarnation:'display_house_1'}, 'configured');
  ensureHouseLifecycleSchema(db);
  db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,ack_key_hex) VALUES(?,'fixture','enabled','disconnected',1,?)", [origin, displayPin]);
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: bs58.encode(displayPair.publicKey) });
  displayCleanup.push(() => catalog.close());
  const partition = catalog.open(origin);
  async function observe(log = 'display_log_1', officialIds: unknown = []) {
    const rawBytes = new TextEncoder().encode(JSON.stringify({ official_ids: officialIds, world_interaction: { version: 1,
      public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: log, envelope_baseline: 'public-envelope-02' as const, initial_public_scopes: [] } } }));
    const core = { house: { origin: origin, houseKey: bs58.encode(displayPair.publicKey), incarnation: 'display_house_1' },
      manifestDigest: cidFromCanonical(rawBytes), signedAt: 1 };
    const bytes = popclaw.world.ManifestProof.encode(core).finish(), prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
    const signing = new Uint8Array(prefix.length + bytes.length); signing.set(prefix); signing.set(bytes, prefix.length);
    const prepared = await makeWorldManifestPreparer()({ origin: origin, rawBytes, ackKeyHex: displayPin,
      provenance: 'configured_pin', signal: new AbortController().signal,
      proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...core,
        authoritySignature: nacl.sign.detached(signing, displayPair.secretKey) }).finish()).toString('base64') });
    db.transaction(prepared.commit);
  }
  await observe();
  const maintenance = MaintenanceSession.begin(db, paths, 'display fixture initialization');
  initializePublicStreamJournal({ catalog, origin: origin, maintenance, configuredPin: displayPin });
  maintenance.finish({ recovery: false, reason: 'synthetic journal initialized' });
  db.execute("UPDATE house_participation SET phase='connected',session_id='test_session',house_revision=5,lease_expires_at=?", [Math.floor(Date.now()/1000)+3600]);
  let pin = displayPin;
  const rt = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer: {} as Signer, origins: [origin], publicV1Mode: true,
    executionStores: catalog, configuredPinFor: () => pin });
  instances.push(rt);
  const cacheRecord = vi.fn();
  const house = { baseUrl: origin, slug: hostDbSlug(origin), db: partition.db,
    executionDb: partition.db, dbPath: partition.path, cacheReadOnly: true,
    cache: { record: cacheRecord } } as unknown as HouseStore;
  const openStore = vi.fn(async () => house);
  rt.configureResources({ host: { db } as never, recipientPopclawId: catalog.options.actorId, worldStreamMode: true,
    stores: [house], openStore, isOfficialActor: () => false });
  return { rt, house, db, paths, catalog, partition, cacheRecord, openStore, observe,
    setPin: (value: string) => { pin = value; } };
}


async function newspaperFixture(avatar = false, origin = displayOrigin) {
  const f = await displayFixture(origin);
  const captured = f.rt.capturePublicDisplay(f.house);
  const journal = new PublicStreamJournal({ executionDb: f.partition.db, capability: captured.capability,
    producerPolicy: captured.producerPolicy, selection: { fullPublic: true, scopes: [] }, consumerContracts: [],
    approvedConsumerMappingDigest: EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST,
    gate: { origin: origin, signal: new AbortController().signal, isActive: () => true } });
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
  const display = new PublicFeedDisplay({ sources: () => [{ origin, slug: f.house.slug, capture: () => f.rt.capturePublicDisplay(f.house) }] });
  const runtime = { houseRuntime: f.rt, publicFeedDisplay: display, worldFeedCache: cache,
    houseFeedReader: new HouseFeedReader({ db: f.db, houses: f.rt, stores: () => [f.house] }),
    inboxStore: { recent: () => [] }, socialGraph: { followsIn: () => false },
    boot: { nickname: 'Synthetic owner', webBaseUrl: 'https://example.invalid', loreHouseUrls: [],
      canvasBaseUrl: 'https://canvas.invalid', signer: { popclawId: vi.fn(async () => 'SyntheticPublisher'),
      sign: vi.fn(async (bytes: Uint8Array) => nacl.sign.detached(bytes, displayPair.secretKey)) } as unknown as Signer },
    uploadCanvas: vi.fn(async (options: Parameters<typeof uploadCanvas>[0]) => { options.assertCurrent?.(); return { url: 'https://canvas.invalid/paper?t=fixture' }; }),
    paths: f.paths };
  let worldDeps: Parameters<typeof registerPopclawTools>[0]['getWorldDeps'];
  let fetchImage: Parameters<typeof registerPopclawTools>[0]['fetchImage'];
  let logger: ((message: string) => void) | undefined;
  function tools(sessionKey = childSessionKey('public-material-fixture')) {
    const registered = new Map<string, (id: string, args: unknown) => Promise<{text: string}>>();
    const api = { logger: { info: (message: string) => logger?.(message) }, registerTool(t: unknown) { const resolved = typeof t === 'function' ? t({ sessionKey }) : t;
      const tool = resolved as {name: string; execute: (id: string,args: unknown) => Promise<{text: string}>}; registered.set(tool.name, tool.execute); } };
    registerPopclawTools({ api, fetchImage, getWorldDeps: worldDeps, runtime: async () => runtime } as unknown as Parameters<typeof registerPopclawTools>[0]);
    return (name: string, args: unknown) => registered.get(name)!('fixture-call', args);
  }
  return { ...f, cache, runtime, tools, eventId, body, journal, generation, raw, setWorldDeps: (value: typeof worldDeps) => { worldDeps = value; }, setFetchImage: (value: typeof fetchImage) => { fetchImage = value; }, setLogger: (value: typeof logger) => { logger = value; } };
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

it('collects the complete newspaper window once through the local House reader', async () => {
  const f = await newspaperFixture();
  const checkpoint = popclaw.world.PublicStreamCheckpoint.fromObject({ phase: 'replay', scopes: [], publicThroughSeq: '100' });
  f.journal.checkpoint(f.generation, checkpoint, popclaw.world.PublicStreamCheckpoint.encode(checkpoint).finish());
  const reader = new HouseFeedReader({ db: f.db, houses: f.rt, stores: () => [f.house] });
  const source = publicMaterialSource({ ...f.runtime, houseFeedReader: reader })!;
  const scan = vi.spyOn(publicJournal, 'readPublicJournal');
  const batch = await source.prepareCollect();
  expect(batch.items.map(item => item.eventId)).toEqual([f.eventId]);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(scan.mock.calls[0]![3]).toMatchObject({ completeWindow: true, ownProjection: true });
  expect(batch.coverage[0]).toMatchObject({ checkpointHighWater: '100', incomplete: true });
  expect(batch.references[0]).toMatchObject({ eventId: f.eventId, sequence: '1' });
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps an acquired newspaper window fixed while the resident receives a later checkpoint', async () => {
  const f = await newspaperFixture();
  const checkpoint = popclaw.world.PublicStreamCheckpoint.fromObject({ phase: 'replay', scopes: [], publicThroughSeq: '100' });
  f.journal.checkpoint(f.generation, checkpoint, popclaw.world.PublicStreamCheckpoint.encode(checkpoint).finish());
  const reader = new HouseFeedReader({ db: f.db, houses: f.rt, stores: () => [f.house] });
  const acquire = reader.prepare.bind(reader);
  vi.spyOn(reader, 'prepare').mockImplementationOnce(async query => {
    const prepared = await acquire(query);
    const e = { actor: { popclawId: bs58.encode(displayPair.publicKey) }, timestamp: Math.floor(Date.now()/1000),
      post: { blocks: [{ content: 'Later resident material belongs to the next acquisition.' }] } };
    const bytes = canonicalizeEnvelope(e), eventId = cidFromCanonical(bytes);
    const envelope = popclaw.event.EventEnvelope.encode({ ...e, eventId, signature: nacl.sign.detached(bytes, displayPair.secretKey) }).finish();
    f.journal.append(f.generation, popclaw.event.WorldStreamFrame.encode({ seq: 101, kind: 'post', envelope }).finish());
    const next = popclaw.world.PublicStreamCheckpoint.fromObject({ phase: 'live', scopes: [], publicThroughSeq: '101' });
    f.journal.checkpoint(f.generation, next, popclaw.world.PublicStreamCheckpoint.encode(next).finish());
    return prepared;
  });
  const source = publicMaterialSource({ ...f.runtime, houseFeedReader: reader })!;
  const first = await source.prepareCollect();
  expect(first.items.map(item => item.eventId)).toEqual([f.eventId]);
  expect(first.coverage[0]).toMatchObject({ checkpointHighWater: '100' });
  const next = await source.prepareCollect();
  expect(next.items).toHaveLength(2);
  expect(next.coverage[0]).toMatchObject({ checkpointHighWater: '101' });
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
it('structured full-document reading enforces the real signed-public source validator before returning text', async () => {
  const f = await newspaperFixture(), candidate = await gather(f);
  const source = publicMaterialSource(f.runtime)!;
  const validateMaterials = vi.fn((current: Parameters<typeof source.validate>[0]) => source.validate(current));
  const opts = { manifestDir: f.paths.newspaperManifestsDir(), validateMaterials };
  expect(readNewspaperDocument(candidate.token, opts).text).toContain(f.body);
  expect(validateMaterials).toHaveBeenCalledOnce();
  f.db.execute('UPDATE house_participation SET lease_expires_at=1');
  expect(() => readNewspaperDocument(candidate.token, opts)).toThrow();
  expect(validateMaterials).toHaveBeenCalledTimes(2);
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
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

it('off-page observations stay in the complete candidate basis and remain verified dependencies', async () => {
  const f = await newspaperFixture();
  for (let seq=2; seq<=60; seq++) {
    const e = {actor:{popclawId:bs58.encode(displayPair.publicKey),nickname:'Journal author'},timestamp:Math.floor(Date.now()/1000),post:{blocks:[{content:`Astronomy item ${seq} `+'x'.repeat(2000)}]}};
    const bytes=canonicalizeEnvelope(e),eventId=cidFromCanonical(bytes);
    const raw=popclaw.event.EventEnvelope.encode({...e,eventId,signature:nacl.sign.detached(bytes,displayPair.secretKey)}).finish();
    f.journal.append(f.generation,popclaw.event.WorldStreamFrame.encode({seq,kind:'post',envelope:raw}).finish());
  }
  noteContextTokenBudget(childSessionKey('public-material-fixture'), 1000);
  // This checks retained material, not token shape. Keep its page ID valid so
  // random minting cannot trip the separate provenance gate first.
  vi.spyOn(issueIdentity, 'mintIssueToken').mockReturnValue('tok_public_material_fixture');
  const c=await gather(f);
  expect(c.issue.pulse.length).toBe(60);
  expect(c.issue.publicMaterials!.references).toHaveLength(c.issue.pulse.length);
  const tail = c.issue.publicMaterials!.references.at(-1)!;
  f.partition.db.execute("UPDATE world_public_frames_v1 SET frame_bytes=x'00' WHERE event_id=?",[tail.eventId]);
  const out = await f.tools(childSessionKey('public-material-fixture'))('popclaw_newspaper', { candidate_token: c.token, picks_flat: [60] });
  expect(out.text).toContain('Gather a fresh candidate page');
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});

it.each([true,false])('historical child collection with checkpoint=%s reports incomplete coverage without leaking content', async checkpointed => {
  const f=await newspaperFixture();
  f.partition.db.execute('DELETE FROM world_public_associations_v1');
  if(checkpointed) {
    const checkpoint={phase:'replay',publicThroughSeq:100};
    f.journal.checkpoint(f.generation,checkpoint,popclaw.world.PublicStreamCheckpoint.encode(checkpoint).finish());
  }
  const records: NewspaperDispatchRecord[]=[];
  let child='';
  const result=await runDedicatedNewspaper({makeIssueHint:()=> 'material-receipt-test', recordDispatch:r=>records.push(r),
    subagent:{run:async({sessionKey})=>{child=sessionKey; await f.tools(sessionKey)('popclaw_newspaper',{hours:24});return {runId:'synthetic-no-model'};},
      waitForRun:async()=>({status:'ok'}),deleteSession:async()=>{}}});
  // A non-owner's retained checkpoint does not prove current remote coverage.
  expect(records[0]?.stage?.collection).toBe('partial-no-material');
  expect(result).toContain('coverage was incomplete');
  expect(result).not.toContain('without publishing a receipt');
  expect(JSON.stringify(records[0]?.stage)).not.toContain('Astronomy');
  expect(NewspaperStageStore.take(child)).toBeUndefined();
});
it('later candidate collection clears an earlier empty stage and real publication receipt wins',async()=>{
  const key=childSessionKey('precedence');
  NewspaperStageStore.collectionFailed(key, { code: 'HOUSE_REMOTE_TIMEOUT' });
  NewspaperStageStore.collection(key,'partial-no-material');
  NewspaperStageStore.note(key,'candidatePage');
  expect(NewspaperStageStore.peek(key)?.collection).toBeUndefined();
  expect(NewspaperStageStore.peek(key)?.collectionFailure).toBeUndefined();
  const result=await runDedicatedNewspaper({makeIssueHint:()=> 'precedence',subagent:{
    run:async({sessionKey})=>{NewspaperStageStore.collectionFailed(sessionKey,{code:'HOUSE_REMOTE_TIMEOUT'});NewspaperOutcomeStore.set(sessionKey,{ok:true,receiptText:'Actual saved and delivered receipt'});return {runId:'no-model'};},
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


it('registered newspaper freezes the complete summary through reading, selection and publication without re-reading it', async () => {
  const f = await newspaperFixture();
  const snapshot = JSON.parse(readFileSync(new URL('../../fixtures/world-summary-snapshot.json', import.meta.url), 'utf8'));
  const fetchSummary = vi.fn(async () => ({ window_hours: 24, generated_at_ms: snapshot.generated_at_ms,
    total_posts: 1, distinct_authors: 2, authors: {}, hot_posts: [], snapshot }));
  const fetchGuideText = vi.fn(async () => '---\nstreams:\n  - name: summary\n    endpoint: /v1/world-summary\n---\nPublic summary');
  const clients = { origin: displayOrigin, guideClient: {fetchGuideText}, summaryClient: {fetchSummary} };
  Object.assign(f.runtime.boot, { popclawId: bs58.encode(displayPair.publicKey), loreHouseUrl: displayOrigin });
  f.runtime.boot.signer.popclawId = async () => bs58.encode(displayPair.publicKey);
  f.setWorldDeps(async () => ({ ...clients, newspaperSummary: clients, origin: displayOrigin,
    snapshotClient: {fetchSnapshot: async () => []}, resolveClient: {resolve: async () => []}, webBaseUrl: f.runtime.boot.webBaseUrl }));
  const sourceScan = vi.spyOn(f.runtime.houseFeedReader, 'prepare');
  const candidate = await gather(f);
  expect(candidate.issue).toMatchObject({worldSummary: {origin: displayOrigin, snapshotId: snapshot.snapshot_id,
    cutoffAtMs: snapshot.cutoff_at_ms, generatedAtMs: snapshot.generated_at_ms}});
  const frozen = (candidate.issue as unknown as {worldSummary:{text:string}}).worldSummary;
  expect(frozen.text).toContain('Builds tools for public conversation.');
  expect(readNewspaperDocument(candidate.token,{manifestDir:f.paths.newspaperManifestsDir(),
    validateMaterials: issue => publicMaterialSource(f.runtime)!.validate(issue)}).text).toContain(frozen.text);
  const saved = readNewspaperDocument(candidate.token,{manifestDir:f.paths.newspaperManifestsDir()});
  const page = await f.tools()('popclaw_newspaper',{page_cursor:`${candidate.token}.${saved.version}.0`});
  expect(page.text).toContain(snapshot.snapshot_id);
  snapshot.snapshot_id = 'later-summary-does-not-replace-this-edition';
  const material = await pick(f,candidate.token);
  expect((material.issue as unknown as {worldSummary:unknown}).worldSummary).toEqual((candidate.issue as unknown as {worldSummary:unknown}).worldSummary);
  expect(readNewspaperDocument(material.token,{manifestDir:f.paths.newspaperManifestsDir(),
    validateMaterials: issue => publicMaterialSource(f.runtime)!.validate(issue)}).text).toContain(frozen.text);
  const published = await publish(f,material.token);
  expect(published.text).toContain('https://canvas.invalid/paper?t=fixture');
  expect(f.runtime.uploadCanvas).toHaveBeenCalledTimes(1);
  expect(fetchSummary).toHaveBeenCalledTimes(1);
  expect(fetchGuideText).toHaveBeenCalledTimes(1);
  expect(sourceScan).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});


it('independent optional context does not steal the signed material read budget', async () => {
  const f = await newspaperFixture();
  let startedAt = 0;
  const starts: Record<string, number> = {};
  Object.assign(f.runtime.boot, { loreHouseUrls: [displayOrigin] });
  vi.spyOn(digestClient, 'readHouseDigestUrl').mockReturnValue(`${displayOrigin}/declared-digest`);
  vi.spyOn(digestClient, 'refreshHouseDigest').mockImplementation(async () => {
    starts.digest = Date.now() - startedAt;
    await new Promise(resolve => setTimeout(resolve, 3000));
    return undefined;
  });
  f.setWorldDeps(async () => ({ newspaperSummary: {} }) as never);
  vi.spyOn(summaryMaterial, 'prepareSummaryMaterial').mockImplementation(async () => {
    starts.summary = Date.now() - startedAt;
    await new Promise(resolve => setTimeout(resolve, 1490));
    return undefined;
  });
  const acquire = f.runtime.houseFeedReader.prepare.bind(f.runtime.houseFeedReader);
  vi.spyOn(f.runtime.houseFeedReader, 'prepare').mockImplementation(async query => {
    starts.material = Date.now() - startedAt;
    await new Promise(resolve => setTimeout(resolve, 8000));
    return acquire(query);
  });
  // Real filesystem promises must not race a synthetic clock jump.
  vi.spyOn(learnedWriter, 'readLearnedTaste').mockResolvedValue({ tags: [], mute: [], summary: '' });
  vi.spyOn(learnedWriter, 'readTasteProfile').mockResolvedValue('');
  vi.useFakeTimers();
  startedAt = Date.now();
  try {
    let finishedAt = 0;
    const result = f.tools()('popclaw_newspaper', { hours: 24 }).then(out => { finishedAt = Date.now() - startedAt; return out; });
    await vi.advanceTimersByTimeAsync(10001);
    const out = await result;
    expect(out.text).toContain('candidate_basis');
    expect(out.text).toContain(f.body);
    expect(starts).toEqual({ digest: 0, summary: 0, material: 0 });
    expect(finishedAt).toBe(8000);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await vi.advanceTimersByTimeAsync(20000);
  }
});

it('a failed collection carries its actual read diagnosis through the child and parent receipt', async () => {
  const f = await newspaperFixture();
  const failure = { code: 'HOUSE_REMOTE_TIMEOUT' as const, diagnostic: {
    budget: 'read-call' as const, phase: 'before-fetch' as const, cause: 'timeout' as const,
    timeoutMs: 10000, elapsedMs: 10001, cancellation: 'deadline' as const,
  } };
  vi.spyOn(f.runtime.houseFeedReader, 'prepare').mockRejectedValue(new RemoteHouseReadError(failure));
  const records: NewspaperDispatchRecord[] = [];
  let childText = '';
  const parent = await runDedicatedNewspaper({ makeIssueHint: () => 'read-failure-test', recordDispatch: r => records.push(r),
    subagent: { run: async ({ sessionKey }) => {
      childText = (await f.tools(sessionKey)('popclaw_newspaper', { hours: 24 })).text;
      return { runId: 'synthetic-read-failure' };
    }, waitForRun: async () => ({ status: 'ok' }), deleteSession: async () => {} } });
  expect(childText).toContain('phase=before-fetch');
  expect(childText).toContain('elapsed_ms=10001');
  expect(parent).toContain('HOUSE_REMOTE_TIMEOUT');
  expect(parent).toContain('phase=before-fetch');
  expect(parent).not.toContain('without publishing a receipt');
  expect(records[0]?.stage).toMatchObject({ collectionFailure: failure,
    candidatePage: false, materialPage: false, publishCalled: false, publishAccepted: false });
  expect(JSON.stringify(records)).not.toContain(f.body);
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});


function syntheticClockContext(f: Awaited<ReturnType<typeof newspaperFixture>>) {
  vi.spyOn(learnedWriter, 'readLearnedTaste').mockResolvedValue({ tags: [], mute: [], summary: '' });
  vi.spyOn(learnedWriter, 'readTasteProfile').mockResolvedValue('');
  vi.useFakeTimers();
  return f.tools();
}

it('revalidates signed material acquired before optional context changes the actual House authority', async () => {
  const f = await newspaperFixture();
  Object.assign(f.runtime.boot, { loreHouseUrls: [displayOrigin] });
  vi.spyOn(digestClient, 'readHouseDigestUrl').mockReturnValue(`${displayOrigin}/declared-digest`);
  vi.spyOn(digestClient, 'refreshHouseDigest').mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    f.db.execute('UPDATE house_participation SET lease_expires_at=1');
    return undefined;
  });
  const call = syntheticClockContext(f);
  const result = call('popclaw_newspaper', { hours: 24 });
  await vi.advanceTimersByTimeAsync(1100);
  expect((await result).text).toContain('Gather a fresh candidate page');
  expect(existsSync(f.paths.newspaperManifestsDir())).toBe(false);
});

it('allows valid signed collection to finish after ten seconds without a whole-gather deadline', async () => {
  const f = await newspaperFixture();
  const acquire = f.runtime.houseFeedReader.prepare.bind(f.runtime.houseFeedReader);
  vi.spyOn(f.runtime.houseFeedReader, 'prepare').mockImplementation(async query => {
    await new Promise(resolve => setTimeout(resolve, 11000));
    return acquire(query);
  });
  const call = syntheticClockContext(f);
  const result = call('popclaw_newspaper', { hours: 24 });
  await vi.advanceTimersByTimeAsync(11001);
  expect((await result).text).toContain('candidate_basis');
  expect(fetch).not.toHaveBeenCalled();
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});

it.each(['cancel', 'sibling-error'] as const)('parallel collection retains the %s fence for a late source ignoring abort', async mode => {
  const f = await newspaperFixture();
  const acquire = f.runtime.houseFeedReader.prepare.bind(f.runtime.houseFeedReader);
  vi.spyOn(f.runtime.houseFeedReader, 'prepare').mockImplementation(async query => {
    await new Promise(resolve => setTimeout(resolve, 11000));
    return acquire(query);
  });
  if (mode === 'sibling-error') {
    Object.assign(f.runtime.boot, { loreHouseUrls: [displayOrigin] });
    vi.spyOn(digestClient, 'readHouseDigestUrl').mockReturnValue(`${displayOrigin}/declared-digest`);
    vi.spyOn(digestClient, 'refreshHouseDigest').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      throw new Error('synthetic-context-failure');
    });
  }
  const call = syntheticClockContext(f), controller = new AbortController();
  const result = mode === 'cancel'
    ? withReadCallBudget({ signal: controller.signal }, () => call('popclaw_newspaper', { hours: 24 }))
      .then(() => 'unexpected-success', error => String(error))
    : call('popclaw_newspaper', { hours: 24 }).then(out => out.text);
  if (mode === 'cancel') setTimeout(() => controller.abort(), 100);
  await vi.advanceTimersByTimeAsync(10001);
  const text = await result;
  if (mode === 'cancel') { expect(text).toContain('ActionInactiveError'); expect(text).not.toContain('HOUSE_REMOTE_TIMEOUT'); }
  if (mode === 'sibling-error') expect(text).toContain('synthetic-context-failure');
  await vi.advanceTimersByTimeAsync(2000);
  expect(existsSync(f.paths.newspaperManifestsDir())).toBe(false);
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});

it('records only bounded read diagnostic fields and clears them after a successful candidate', () => {
  const key = childSessionKey('safe-diagnosis');
  const failure = NewspaperStageStore.collectionFailed(key, { code: 'HOUSE_REMOTE_TIMEOUT',
    origin: 'https://example.invalid/private?credential=never-store', diagnostic: {
      phase: 'fetch', cause: 'timeout', elapsedMs: Infinity, timeoutMs: 10000,
      requestId: 'https://example.invalid/private?secret=never-store',
    } });
  expect(failure).toEqual({ code: 'HOUSE_REMOTE_TIMEOUT', diagnostic: { phase: 'fetch', cause: 'timeout', timeoutMs: 10000 } });
  expect(JSON.stringify(NewspaperStageStore.peek(key))).not.toContain('never-store');
  NewspaperStageStore.note(key, 'candidatePage');
  expect(NewspaperStageStore.peek(key)?.collectionFailure).toBeUndefined();
});


async function costFixture(count: number, origin = displayOrigin) {
  const f = await newspaperFixture(false, origin);
  for (let seq = 2; seq <= count; seq++) {
    const e = { actor: { popclawId: bs58.encode(displayPair.publicKey), nickname: 'Journal author' },
      timestamp: Math.floor(Date.now()/1000), post: { blocks: [{ content: `Astronomy material ${seq}: a distinct verified journal observation for local cost measurement.` }] } };
    const bytes = canonicalizeEnvelope(e), eventId = cidFromCanonical(bytes);
    const raw = popclaw.event.EventEnvelope.encode({ ...e, eventId,
      signature: nacl.sign.detached(bytes, displayPair.secretKey) }).finish();
    f.journal.append(f.generation, popclaw.event.WorldStreamFrame.encode({ seq, kind: 'post', envelope: raw }).finish());
  }
  return f;
}

it.each([8, 16])('keeps full partition verification constant for %i signed local candidates', async count => {
  const f = await costFixture(count);
  const integrity = vi.spyOn(f.partition.db, 'queryOne');
  const selected = vi.spyOn(f.catalog, 'verifySelected');
  const capture = vi.spyOn(f.rt, 'capturePublicMaterial');
  const verify = vi.spyOn(nacl.sign.detached, 'verify');
  const scan = vi.spyOn(publicJournal, 'readPublicJournal');
  const start = performance.now();
  const candidate = await gather(f);
  const profile = { elapsedMs: performance.now()-start, candidates: candidate.issue.pulse.length,
    integrity: integrity.mock.calls.filter(([sql]) => sql === 'PRAGMA integrity_check').length,
    selected: selected.mock.calls.length, capture: capture.mock.calls.length,
    verify: verify.mock.calls.length, scan: scan.mock.calls.length };
  console.log('LOCAL_JOURNAL_PROFILE', JSON.stringify(profile));
  expect(profile.candidates).toBe(count);
  expect(fetch).not.toHaveBeenCalled();
  // Keep both full material validations and their real signature checks.
  expect(profile.verify).toBe(3*count);
  expect(profile.scan).toBe(1+2*count);
  // One collection capture, plus initial and final captures per validation.
  expect(profile.capture).toBe(5);
  expect(profile.integrity).toBe(12);
}, 30_000);

it('returns valid signed candidates after more than ten seconds of modeled synchronous local verification', async () => {
  const f = await costFixture(8), query = f.partition.db.queryOne.bind(f.partition.db);
  const baseline = Date.now(); let modeledMs = 0, integrityChecks = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => baseline+modeledMs);
  vi.spyOn(f.partition.db, 'queryOne').mockImplementation((...args) => {
    const result = query(...args);
    if (args[0] === 'PRAGMA integrity_check') { integrityChecks++; modeledMs += 1000; }
    return result;
  });
  const session = childSessionKey('local-cost-regression');
  const result = await f.tools(session)('popclaw_newspaper', { hours: 24 });
  const manifests = existsSync(f.paths.newspaperManifestsDir()) ? readdirSync(f.paths.newspaperManifestsDir()).filter(n => n.endsWith('.json')) : [];
  console.log('MODELED_LOCAL_CPU', JSON.stringify({ modeledMs, integrityChecks, manifests: manifests.length,
    stage: NewspaperStageStore.peek(session), candidateReturned: result.text.includes('candidate_basis') }));
  expect(fetch).not.toHaveBeenCalled();
  expect(modeledMs).toBeGreaterThan(10000);
  expect(integrityChecks).toBe(12);
  expect(result.text).toContain('candidate_basis');
}, 30_000);


it.each(['later frame', 'revoked lease', 'catalog replacement', 'mounted handle replacement'])(
  'multi-reference validation rejects %s during a local read', async change => {
  const f = await costFixture(2), candidate = await gather(f), source = publicMaterialSource(f.runtime)!;
  expect(() => source.validate(candidate.issue)).not.toThrow();
  const original = publicJournal.readPublicJournal;
  let calls = 0;
  vi.spyOn(publicJournal, 'readPublicJournal').mockImplementation((...args) => {
    const result = original(...args);
    if (++calls === 1) {
      if (change === 'later frame') f.partition.db.execute("UPDATE world_public_frames_v1 SET frame_bytes=x'00' WHERE event_id=?", [candidate.issue.pulse[1]!.eventId]);
      if (change === 'revoked lease') f.db.execute('UPDATE house_participation SET lease_expires_at=1');
      if (change === 'catalog replacement') f.db.execute("UPDATE execution_store_catalog_v1 SET store_id='replaced_store'");
      if (change === 'mounted handle replacement') {
        const replacement = new LocalHostDb(join(f.paths.socialDb(), '..', 'replacement.db'));
        displayCleanup.push(() => replacement.close()); Object.assign(f.house, { executionDb: replacement });
      }
    }
    return result;
  });
  expect(() => source.validate(candidate.issue)).toThrow();
  expect(fetch).not.toHaveBeenCalled(); expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});

it('full final partition recheck rejects damage after the last signed reference', async () => {
  const f = await costFixture(2), candidate = await gather(f), source = publicMaterialSource(f.runtime)!;
  expect(() => source.validate(candidate.issue)).not.toThrow();
  const original = publicJournal.readPublicJournal;
  let calls = 0;
  vi.spyOn(publicJournal, 'readPublicJournal').mockImplementation((...args) => {
    const result = original(...args);
    if (++calls === candidate.issue.pulse.length) {
      // Valid table names, identity, schema and signed frames remain unchanged.
      // A cheap currentness fence cannot detect a row violating its real CHECK.
      f.partition.db.execute('PRAGMA ignore_check_constraints=ON');
      f.partition.db.execute('UPDATE world_public_cursors_v1 SET stale=2');
      f.partition.db.execute('PRAGMA ignore_check_constraints=OFF');
    }
    return result;
  });
  expect(() => source.validate(candidate.issue)).toThrow('EXECUTION_PARTITION_CORRUPT');
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});

it.each(['frame', 'lease', 'partition identity'])(
  'starts a fresh validation on the next call after %s changes', async change => {
  const f = await costFixture(2), candidate = await gather(f), source = publicMaterialSource(f.runtime)!;
  expect(() => source.validate(candidate.issue)).not.toThrow();
  if (change === 'frame') f.partition.db.execute("UPDATE world_public_frames_v1 SET frame_bytes=x'00'");
  if (change === 'lease') f.db.execute('UPDATE house_participation SET lease_expires_at=1');
  if (change === 'partition identity') f.partition.db.execute("UPDATE execution_partition_identity_v1 SET actor_id='replacement'");
  expect(() => source.validate(candidate.issue)).toThrow();
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});


it.each(['execution DB', 'capability', 'producer policy'])(
  'final recapture rejects a different %s even with the same authority string', async change => {
  const f = await costFixture(2), candidate = await gather(f), source = publicMaterialSource(f.runtime)!;
  const original = f.rt.capturePublicMaterial.bind(f.rt);
  const replacement = new LocalHostDb(join(f.paths.socialDb(), '..', 'unselected.db'));
  displayCleanup.push(() => replacement.close());
  let calls = 0;
  vi.spyOn(f.rt, 'capturePublicMaterial').mockImplementation(house => {
    const captured = original(house);
    if (++calls !== 2) return captured;
    if (change === 'execution DB') return { ...captured, executionDb: replacement };
    if (change === 'capability') return { ...captured, capability: { ...captured.capability, capabilityRevision: 'changed' } };
    return { ...captured, producerPolicy: { ...captured.producerPolicy, officialActorIds: ['changed'] } };
  });
  expect(() => source.validate(candidate.issue)).toThrow('NEWSPAPER_PUBLIC_SOURCE_UPDATED');
  expect(calls).toBe(2);
  expect(f.runtime.uploadCanvas).not.toHaveBeenCalled();
});


async function twoSourceCandidate() {
  const a = await costFixture(2), b = await costFixture(2, 'https://second-display.invalid');
  const first = await gather(a), second = await gather(b);
  const source = new NewspaperPublicMaterialSource({ publicMaterialSources: () => [
    ...a.rt.publicMaterialSources(), ...b.rt.publicMaterialSources(),
  ] });
  const issue = { ...first.issue, pulse: [...first.issue.pulse, ...second.issue.pulse],
    byHouse: { ...first.issue.byHouse, ...second.issue.byHouse },
    publicCoverage: [...first.issue.publicCoverage!, ...second.issue.publicCoverage!],
    publicMaterials: { version: 1 as const, references: [
      ...first.issue.publicMaterials!.references, ...second.issue.publicMaterials!.references,
    ] } };
  return { a, b, source, issue };
}

it('fully rechecks both real source partitions after reading all references', async () => {
  const { a, b, source, issue } = await twoSourceCandidate();
  const first = vi.spyOn(a.rt, 'capturePublicMaterial'), second = vi.spyOn(b.rt, 'capturePublicMaterial');
  expect(() => source.validate(issue)).not.toThrow();
  expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
});

it('final full recheck detects earlier-source corruption while reading a later source', async () => {
  const { a, b, source, issue } = await twoSourceCandidate();
  expect(() => source.validate(issue)).not.toThrow();
  const original = publicJournal.readPublicJournal;
  vi.spyOn(publicJournal, 'readPublicJournal').mockImplementation((...args) => {
    const result = original(...args);
    if (args[2].origin === b.house.baseUrl) {
      a.partition.db.execute('PRAGMA ignore_check_constraints=ON');
      a.partition.db.execute('UPDATE world_public_cursors_v1 SET stale=2');
      a.partition.db.execute('PRAGMA ignore_check_constraints=OFF');
    }
    return result;
  });
  expect(() => source.validate(issue)).toThrow('EXECUTION_PARTITION_CORRUPT');
});

it('last currentness fence detects earlier-source revocation during later-source recapture', async () => {
  const { a, b, source, issue } = await twoSourceCandidate();
  expect(() => source.validate(issue)).not.toThrow();
  const original = b.rt.capturePublicMaterial.bind(b.rt);
  let captures = 0;
  vi.spyOn(b.rt, 'capturePublicMaterial').mockImplementation(house => {
    const captured = original(house);
    if (++captures === 2) a.db.execute('UPDATE house_participation SET lease_expires_at=1');
    return captured;
  });
  expect(() => source.validate(issue)).toThrow('NEWSPAPER_PUBLIC_AUTHORITY_CHANGED');
  expect(captures).toBe(2);
});
