import { execFileSync } from 'node:child_process';
import * as privateReader from '../../../src/world/private-message-reader.js';
import * as schemaValidation from '../../../src/world/schema-validator.js';
import { afterEach, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical, stripDefaultKeys } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { encryptDmBody } from '../../../src/messaging/dm-crypto.js';
import { makeWorldManifestPreparer, readHouseCapabilityView, type HouseCapabilityView } from '../../../src/world/world-capabilities.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializePrivateMessageJournal } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession, publishStorageJson } from '../../../src/host/storage-maintenance.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { WorldRuntime } from '../../../src/runtime/world-runtime.js';
import type { HouseResourceOptions } from '../../../src/runtime/house-lifecycle/resource-set.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';
import { openUnprovisionedPartition } from '../../helpers/unprovisioned-partition.js';
const utf8 = new TextEncoder();
const house = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
const official = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
const recipient = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const houseId = bs58.encode(house.publicKey), officialId = bs58.encode(official.publicKey);
const recipientId = bs58.encode(recipient.publicKey);
const origin = 'https://house.invalid', incarnation = 'inc_1';
const recipientSigner = new MasterKeySigner({ ...recipient, seed: recipient.secretKey.slice(0, 32), popclawId: recipientId });
const guideBytes = utf8.encode('Private message guide.');
const bodySchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const preparer = makeWorldManifestPreparer({ fetch: (async (url: string) => {
  if (!url.endsWith('/v1/guide.md')) throw new Error('UNEXPECTED_FETCH');
  return new Response(guideBytes, { status: 200, headers: { 'content-type': 'text/markdown' } });
}) as typeof fetch });

interface ViewOptions { participation?: boolean; kinds?: string[] }
async function installView(db: HostDb, options: ViewOptions = {}): Promise<HouseCapabilityView> {
  const kinds = options.kinds ?? ['mud.message'];
  const document = {
    world_interaction: { version: 1, private_messages: { version: 1, kinds, participation: options.participation ?? false },
      guide: { path: '/v1/guide.md', sha256: cidFromCanonical(guideBytes), revision: 'guide_r1' } },
    official_ids: [officialId],
    event_kinds: [{ kind: kinds[0], schema_version: 1, transport: 'house', signer: 'official',
      description: 'Private card', body_schema: bodySchema }],
  };
  const rawBytes = utf8.encode(JSON.stringify(document));
  const proof = { house: { origin, houseKey: houseId, incarnation }, manifestDigest: cidFromCanonical(rawBytes), signedAt: 1000 };
  const core = popclaw.world.ManifestProof.encode(stripDefaultKeys(proof)).finish();
  const prefix = utf8.encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
  const signing = new Uint8Array(prefix.length + core.length); signing.set(prefix); signing.set(core, prefix.length);
  const prepared = await preparer({ origin, rawBytes, ackKeyHex: Buffer.from(house.publicKey).toString('hex'),
    proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...proof, authoritySignature: nacl.sign.detached(signing, house.secretKey) }).finish()).toString('base64'),
    provenance: 'loopback_fixture', signal: new AbortController().signal });
  db.transaction(tx => prepared.commit(tx));
  const view = readHouseCapabilityView(db, origin);
  if (!view) throw new Error('VIEW_MISSING');
  return view;
}

function wire(text: string, options: { sender?: nacl.SignKeyPair; to?: string; plaintext?: boolean; mutate?: (value: popclaw.event.EventEnvelope) => void } = {}): Uint8Array {
  const sender = options.sender ?? official;
  const from = bs58.encode(sender.publicKey);
  const to = options.to ?? recipientId;
  const envelope = popclaw.event.EventEnvelope.fromObject({ actor: { popclawId: from }, target: { scope: 1, targetIds: [to] }, timestamp: 1000,
    directMessage: { fromPopclawId: from, toPopclawId: to, body: options.plaintext ? text : '[encrypted]', ts: 1000,
      ...(options.plaintext ? {} : encryptDmBody(text, to, sender.secretKey)) } });
  options.mutate?.(envelope);
  const canonical = canonicalizeEnvelope(envelope);
  envelope.eventId = cidFromCanonical(canonical);
  envelope.signature = nacl.sign.detached(canonical, sender.secretKey);
  return popclaw.event.EventEnvelope.encode(envelope).finish();
}
function wrapper(revision: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { format: 'popclaw.world-message', version: 1, kind: 'mud.message', schema_version: 1,
    capability_revision: revision, message_id: 'message_1', conversation_ref: 'conversation_1',
    delivery_class: 'conversation', summary: 'Readable summary', body: { text: 'hello' }, ...extra };
}
function stateWrapper(revision: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return wrapper(revision, { delivery_class: 'state', house: { origin, house_key: houseId, incarnation },
    state_ref: 'state/card', state_revision: '10', ...extra });
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
/** `true` is a factory-born partition the offline entrance also prepared,
 * `'factory'` a fresh install with no offline preparation at all, and `false`
 * the published-but-uncertified partition every install carried before the
 * factory existed. */
async function fixture(prepare: boolean | 'factory' = true, residentStore = true, kinds?: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'private-runtime-')), paths = new PopclawPaths(root);
  const db = new LocalHostDb(paths.socialDb()), cacheDb = new LocalHostDb(join(root, 'cache.db'));
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: recipientId });
  const partition = prepare === false
    ? openUnprovisionedPartition({ catalog, db, paths, actorId: recipientId, origin })
    : catalog.open(origin);
  if (prepare === true) {
    const maintenance = MaintenanceSession.begin(db, paths, 'private test setup');
    initializePrivateMessageJournal({ catalog, origin, maintenance });
    maintenance.finish({ recovery: false, reason: 'prepared' });
  }
  const view = await installView(db, { kinds }), pin = Buffer.from(house.publicKey).toString('hex');
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('UNEXPECTED_NETWORK'); });
  const houses = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer: recipientSigner, origins: [origin], executionStores: catalog, fetch, configuredPinFor: () => pin });
  db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,ack_key_hex,session_id,house_revision,lease_expires_at) VALUES(?,'fixture','enabled','connected',1,?,'session_1',3,?)", [origin, pin, Math.floor(Date.now()/1000)+600]);
  const store = { baseUrl: origin, slug: 'house-invalid', db: cacheDb, executionDb: partition.db, dbPath: join(root, 'cache.db'), cache: new WorldFeedCache({ db: cacheDb }) };
  const openStore = vi.fn(async () => store);
  houses.configureResources({ stores: residentStore ? [store] : [], openStore, worldStreamMode: true, host: {} as HouseResourceOptions['host'], recipientPopclawId: recipientId, isOfficialActor: (_house, id) => id === officialId });
  const worlds = new WorldRuntime({ mode: 'commands', houses, signer: recipientSigner, actorId: recipientId, readCapabilities: input => readHouseCapabilityView(db, input) });
  const abort = new AbortController(), gate = { origin, generation: 1, signal: abort.signal, isActive: () => !abort.signal.aborted };
  const onPlain = vi.fn(async () => {}), onError = vi.fn();
  const consumer = residentStore ? worlds.createInboxConsumer({ house: store, gate, onError, onPlain, isOfficialActor: id => id === officialId }) : undefined;
  cleanup.push(async () => { worlds.stop(); consumer?.stop(); await worlds.whenIdle(); await consumer?.whenIdle(); await houses.stop(); catalog.close(); cacheDb.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const receive = async (text: string) => { const raw = wire(text); await consumer!.receive(popclaw.event.EventEnvelope.decode(raw).directMessage!, raw, 'Official'); };
  const read = (query = {}) => houses.runCommand(() => worlds.readPrivateMessages({ house: origin, ...query }));
  return { db, paths, partition, worlds, houses, consumer, onPlain, onError, receive, read, view, abort, fetch,
    openStore, recreate: () => worlds.createInboxConsumer({ house: store, gate, onError, onPlain }) };
}
it('uses certified private storage without requiring action tables and exposes authenticated material locally', async () => {
  const f = await fixture(); expect(f.consumer).toBeDefined();
  expect(f.worlds.readCapabilities(origin)?.privateMessages).toMatchObject({ support: 'supported', ready: true });
  await f.receive(JSON.stringify(wrapper(f.view.verified.capabilityRevision)));
  const result: any = await f.read();
  expect(result.status).toBe('ok'); expect(result.items[0].body).toEqual({ text: 'hello' });
  expect(result.session_id).toBe('session_1'); expect(result.capability_revision).toBe(f.view.verified.capabilityRevision);
  expect(f.onPlain).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  // The private lane needs no action accounting: the provisioned action ledger stays untouched.
  expect(f.partition.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM world_action_client_requests')?.n).toBe(0);
});
it('leaves unprepared storage untouched and reports unsupported local reads', async () => {
  const f = await fixture(false); expect(f.consumer).toBeUndefined();
  await expect(f.read()).rejects.toThrow('PRIVATE_MESSAGE_NOT_PREPARED');
  expect(f.partition.db.queryOne("SELECT name FROM sqlite_master WHERE name='world_private_messages_v2'")).toBeNull();
});
it('serves an empty private read on a fresh install with no offline preparation', async () => {
  const f = await fixture('factory'); expect(f.consumer).toBeDefined();
  const result: any = await f.read();
  expect(result.status).toBe('ok'); expect(result.items).toEqual([]);
  expect(result.session_id).toBe('session_1');
  await f.receive(JSON.stringify(wrapper(f.view.verified.capabilityRevision)));
  const second: any = await f.read();
  expect(second.items[0].body).toEqual({ text: 'hello' });
});
it('routes ordinary DM once and fences fallback when the session changes before its promise resumes', async () => {
  const f = await fixture(); await f.receive('ordinary'); expect(f.onPlain).toHaveBeenCalledTimes(1);
  const pending = f.receive('later');
  f.db.execute("UPDATE house_participation SET session_id='session_2',op_seq=2");
  await pending.catch(() => {}); expect(f.onPlain).toHaveBeenCalledTimes(1);
});
it.each(['execution', 'consumers'])('blocks private reads and receives under the %s recovery hold', async path => {
  const f = await fixture();
  publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'hold', mode: 'recovery', reason: 'test', held: [path], releases: {} });
  await expect(f.read()).rejects.toThrow(); await f.receive(JSON.stringify(wrapper(f.view.verified.capabilityRevision))).catch(() => {});
  expect(f.partition.db.queryAll('SELECT * FROM world_private_messages_v2')).toHaveLength(0); expect(f.onPlain).not.toHaveBeenCalled();
});
it('rejects references from a different session or revision and bounds material responses', async () => {
  const f = await fixture(); await f.receive(JSON.stringify(wrapper(f.view.verified.capabilityRevision, { body: { text: 'x'.repeat(18000) } })));
  const result: any = await f.read(); expect(result.code).toBe('SIZE_LIMIT'); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
  await expect(f.read({ message_id: 'message_1', expected_session_id: 'other', expected_capability_revision: f.view.verified.capabilityRevision })).rejects.toThrow('PRIVATE_REFERENCE_CHANGED');
});

it('joins an in-flight schema read at stop and exposes no late material', async () => {
  const f = await fixture(); await f.receive(JSON.stringify(wrapper(f.view.verified.capabilityRevision)));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(done => { entered = done; }), blocked = new Promise<void>(done => { release = done; });
  const original = schemaValidation.validateWorldPayload;
  const spy = vi.spyOn(schemaValidation, 'validateWorldPayload').mockImplementation(async (...args) => { entered(); await blocked; return original(...args); });
  const reading = f.read(), rejected = expect(reading).rejects.toThrow(); await started;
  f.worlds.stop(); let joined = false;
  const stopping = f.worlds.whenIdle().then(() => { joined = true; });
  await Promise.resolve(); expect(joined).toBe(false); release(); await rejected; await stopping; spy.mockRestore();
});
it.each(['session', 'revision'])('does not expose a schema read after its %s changes across await', async change => {
  const f = await fixture(); await f.receive(JSON.stringify(wrapper(f.view.verified.capabilityRevision)));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(done => { entered = done; }), blocked = new Promise<void>(done => { release = done; });
  const original = schemaValidation.validateWorldPayload;
  const spy = vi.spyOn(schemaValidation, 'validateWorldPayload').mockImplementation(async (...args) => { entered(); await blocked; return original(...args); });
  const reading = f.read(), rejected = expect(reading).rejects.toThrow(); await started;
  if (change === 'session') f.db.execute("UPDATE house_participation SET session_id='replacement',op_seq=2");
  else f.db.execute('UPDATE world_capability_current_v1 SET active=0');
  release(); await rejected; spy.mockRestore();
});

it('does not downgrade an advertised private consumer when certified storage is corrupt', async () => {
  const f = await fixture(); f.partition.db.execute('CREATE INDEX illegal_private_index ON world_private_messages_v2(message_id)');
  expect(f.recreate).toThrow(); expect(f.onPlain).not.toHaveBeenCalled();
});
it('rechecks the session after reader cleanup before exposing material', async () => {
  const f = await fixture(); await f.receive(JSON.stringify(wrapper(f.view.verified.capabilityRevision)));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(done => { entered = done; }), blocked = new Promise<void>(done => { release = done; });
  const original = privateReader.createPrivateMessageReader;
  const spy = vi.spyOn(privateReader, 'createPrivateMessageReader').mockImplementation(options => {
    const reader = original(options);
    return { ...reader, whenIdle: async () => { entered(); await blocked; await reader.whenIdle(); } };
  });
  const reading = f.read(); await started;
  f.db.execute("UPDATE house_participation SET session_id='after_join',op_seq=2"); release();
  await expect(reading).rejects.toThrow(); spy.mockRestore();
});
it('carries the original authenticated plaintext to ordinary fallback without decrypting twice', async () => {
  const f = await fixture(); const spy = vi.spyOn(recipientSigner, 'openDm');
  await f.receive('ordinary authenticated text');
  expect(spy).toHaveBeenCalledTimes(1);
  expect(f.onPlain.mock.calls[0]).toHaveLength(4);
  expect((f.onPlain.mock.calls[0] as unknown[])[3]).toEqual({ originalText: 'ordinary authenticated text' }); spy.mockRestore();
});
it('reads a state anchor only under the returned session and capability binding', async () => {
  const f = await fixture(); await f.receive(JSON.stringify(stateWrapper(f.view.verified.capabilityRevision)));
  const result: any = await f.read({ state_ref: 'state/card', expected_session_id: 'session_1', expected_capability_revision: f.view.verified.capabilityRevision });
  expect(result.state).toMatchObject({ stateRef: 'state/card', revision: '10', messageValid: true });
});

it('uses existing read-only storage in a command-only root without opening or creating a House cache', async () => {
  const f = await fixture(true, false);
  const before = f.db.queryAll('SELECT * FROM execution_store_catalog_v1');
  const result: any = await f.read();
  expect(result).toMatchObject({ status: 'ok', items: [] });
  expect(f.openStore).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  expect(f.db.queryAll('SELECT * FROM execution_store_catalog_v1')).toEqual(before);
  expect(f.worlds.readCapabilities(origin)?.privateMessages.ready).toBe(true);
});

it.skipIf(!process.env.POPCLAW_PRIVATE_SDK_HELPER)('composes the fixed SDK, real host crypto and actual G0 certified session reader', async () => {
  const f = await fixture(true, true, ['example.private']);
  const result = JSON.parse(execFileSync(process.execPath, ['--import', process.env.POPCLAW_PRIVATE_SDK_LOADER!, process.env.POPCLAW_PRIVATE_SDK_HELPER!], {
    input: JSON.stringify({ senderSeedHex: '16'.repeat(32), recipientSeedHex: '17'.repeat(32),
      capabilityRevision: f.view.verified.capabilityRevision, origin, timestamp: Math.floor(Date.now()/1000) }),
    encoding: 'utf8', maxBuffer: 262144,
  }));
  const signed = popclaw.identity.SignedPayload.decode(Buffer.from(result.signedPayloadBase64, 'base64'));
  const envelope = popclaw.event.EventEnvelope.decode(signed.payload!);
  await f.consumer!.receive(envelope.directMessage!, signed.payload!, 'SDK official');
  const read: any = await f.read();
  expect(read).toMatchObject({ status: 'ok', session_id: 'session_1', capability_revision: f.view.verified.capabilityRevision });
  expect(read.items[0]).toMatchObject({ messageId: 'g0-sdk-private-1', eventId: result.eventId,
    kind: 'example.private', body: { text: 'G0 SDK private message' } });
  await f.consumer!.receive(envelope.directMessage!, signed.payload!, 'Replay');
  expect(f.partition.db.queryAll('SELECT * FROM world_private_messages_v2')).toHaveLength(1);
  expect(f.onPlain).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
});
