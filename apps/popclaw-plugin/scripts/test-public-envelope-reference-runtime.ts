#!/usr/bin/env tsx
/**
 * Opt-in real loopback interoperability with the public-envelope reference House.
 * No installed identity, preset manifest/ack, or legacy SDK helper is used.
 *
 * Before restart:
 *   node --import tsx scripts/test-public-envelope-reference-runtime.ts \
 *     --origin http://127.0.0.1:18787 --house-key <trusted-base58-key> --reference-sha <sha>
 * The final JSON exposes a state path (0600, under a fresh 0700 temporary root).
 * Stop/restart the reference process on the SAME server data directory, then:
 *   node --import tsx scripts/test-public-envelope-reference-runtime.ts \
 *     --origin http://127.0.0.1:18787 --house-key <same-trusted-key> \
 *     --phase after-restart --state <state-path> --reference-sha <same-sha>
 * Equivalent input is one JSON object on stdin when no arguments are supplied.
 * Only the second phase reports complete. It removes all temporary client secrets.
 * Failures retain a private diagnostic root, original request/receipt files and
 * ephemeral fixture identities; stderr contains only paths, stage and a redacted stack.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { LocalHostDb } from '../src/host/local-host-db.js';
import { LocalHostAdapter } from '../src/host/local-host-adapter.js';
import { PopclawPaths } from '../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../src/host/execution-store.js';
import { initializeActionReceiptJournal, initializePublicStreamJournal } from '../src/host/execution-store-migration.js';
import { MaintenanceSession } from '../src/host/storage-maintenance.js';
import { MasterKeySigner } from '../src/identity/master-key-signer.js';
import { HouseRuntime } from '../src/runtime/house-lifecycle/house-runtime.js';
import { readParticipation } from '../src/runtime/house-lifecycle/participation-store.js';
import { publicProducerPolicy } from '../src/runtime/house-lifecycle/public-read-resources.js';
import { WorldRuntime } from '../src/runtime/world-runtime.js';
import { readHouseCapabilityView } from '../src/world/world-capabilities.js';
import { WorldFeedCache } from '../src/ingress/world-feed-cache.js';
import { hostDbSlug } from '../src/ingress/host-slug.js';
import { PublicV1Receiver } from '../src/ingress/public-world-stream-client.js';
import { EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST, preparePublicStreamJournal } from '../src/world/scoped-stream-journal.js';
import { verifyPublicEnvelope } from '../src/ingress/public-stream-wire.js';
import { verifyInboundEnvelope } from '../src/ingress/verify-envelope.js';
import { signDirectMessage } from '../src/messaging/sign-message.js';
import { readDmBody } from '../src/messaging/dm-plaintext.js';
import { InboxStore } from '../src/messaging/inbox-store.js';
import { makeInboxOnMessage } from '../src/runtime/inbox-consumer.js';
import type { WorldInvokeInput } from '../src/world/action-client.js';

interface Input { origin: string; houseKey: string; phase?: 'before-restart' | 'after-restart'; state?: string; referenceSha?: string }
interface SavedAction { requestId: string; receipt: string; factId: string; factEnvelope: string }
interface SavedState {
  format: 'public-envelope-reference-runtime-v1'; origin: string; houseKey: string; referenceSha?: string;
  root: string; senderSeed: string; recipientSeed: string; capabilityRevision: string; logIncarnation: string;
  actions: [SavedAction, SavedAction];
  publicCursor: string; inboxLastEventId: string; privateEventIds: string[];
}
let stage = 'input';
let diagnosticRoot: string | undefined;
let diagnosticFile: string | undefined;
const secrets = new Set<string>();
function rememberSecret(value: string | Uint8Array) {
  if (typeof value === 'string') { if (value) secrets.add(value); }
  else { secrets.add(Buffer.from(value).toString('hex')); secrets.add(Buffer.from(value).toString('base64')); }
}
function safeStack(error: unknown): string {
  // Keep the error headline and original stack frames. Assertion object dumps
  // can contain buffers, so they never go to the terminal or diagnostic index.
  const raw = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : 'Error: non-Error failure';
  let text = raw.split('\n').filter((line, index) => index === 0 || /^\s+at /.test(line)).join('\n');
  for (const secret of secrets) if (secret.length > 8) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/itk-[A-Za-z0-9._~-]+/g, '[redacted-token]');
}
async function atStage<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  stage = label; return work();
}
function privateFile(path: string, bytes: string | Uint8Array) {
  writeFileSync(path, bytes, { mode: 0o600 }); chmodSync(path, 0o600);
}
/** Read-only extraction: never retry a request or alter a receipt during failure capture. */
function preservePeerEvidence(peer: Peer) {
  const directory = join(peer.root, 'failure-evidence'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const requests: Record<string, unknown>[] = [], receipts: Record<string, unknown>[] = [], extractionErrors: string[] = [];
  const has = (db: Peer['db'], table: string) => !!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]);
  if (has(peer.partition.db, 'world_action_client_requests')) {
    for (const [index, row] of peer.partition.db.queryAll<{ request_id: string; request_bytes: Uint8Array; request_digest: string }>(
      'SELECT request_id,request_bytes,request_digest FROM world_action_client_requests ORDER BY request_id').entries()) {
      const file = `request-${index + 1}.signed-payload.pb`;
      privateFile(join(directory, file), row.request_bytes);
      const entry: Record<string, unknown> = { requestId: row.request_id, signedPayloadFile: file, storedRequestDigest: row.request_digest, signedPayloadSha256: hash(row.request_bytes) };
      try {
        const envelope = popclaw.identity.SignedPayload.decode(row.request_bytes).payload;
        const envelopeFile = `request-${index + 1}.event-envelope.pb`; privateFile(join(directory, envelopeFile), envelope);
        entry.envelopeFile = envelopeFile; entry.envelopeSha256 = hash(envelope);
      } catch (error) { extractionErrors.push(safeStack(error)); }
      requests.push(entry);
    }
  }
  const recordReceipt = (bytes: Uint8Array, source: string) => {
    const file = `receipt-${receipts.length + 1}.signed-action-result.pb`; privateFile(join(directory, file), bytes);
    const entry: Record<string, unknown> = { source, file, sha256: hash(bytes) };
    try {
      const result = popclaw.world.SignedActionResult.decode(bytes).result;
      entry.requestId = result?.requestId; entry.requestDigest = result?.requestDigest;
    } catch (error) { extractionErrors.push(safeStack(error)); }
    receipts.push(entry);
  };
  if (has(peer.partition.db, 'world_action_client_evidence')) {
    for (const row of peer.partition.db.queryAll<{ source_kind: string; signed_result_bytes: Uint8Array }>('SELECT source_kind,signed_result_bytes FROM world_action_client_evidence')) {
      recordReceipt(row.signed_result_bytes, `action-journal:${row.source_kind}`);
    }
  }
  if (has(peer.db, 'house_lifecycle_commands')) {
    for (const row of peer.db.queryAll<{ result_json: string }>("SELECT result_json FROM house_lifecycle_commands WHERE kind='push' AND result_json IS NOT NULL")) {
      try {
        const value: unknown = JSON.parse(row.result_json).signedActionResultBase64;
        if (typeof value === 'string' && value.length > 0) recordReceipt(Buffer.from(value, 'base64'), 'completed-house-command-push');
      } catch (error) { extractionErrors.push(safeStack(error)); }
    }
  }
  privateFile(join(directory, 'index.json'), JSON.stringify({ actorId: peer.actorId, requests, receipts, extractionErrors }, null, 2));
  return directory;
}
const params = Object.freeze({ place: 'Isolated TS runtime interop', latitude: '35.6762', longitude: '139.6503', status: 'Encrypted peer and public receipt QA' });
const kind = 'rangermap.check_in';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, detail?: () => unknown, ms = 20_000) {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() >= end) throw new Error(`${label}: ${JSON.stringify(detail?.() ?? 'deadline exceeded')}`);
    await sleep(40);
  }
}
function parseInput(): Input {
  if (process.argv.length === 2) return JSON.parse(readFileSync(0, 'utf8')) as Input;
  const flags = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert.ok(['--origin', '--house-key', '--phase', '--state', '--reference-sha'].includes(key) && value, 'invalid argument');
    assert.ok(!flags.has(key), 'duplicate argument'); flags.set(key, value!);
  }
  return { origin: flags.get('--origin')!, houseKey: flags.get('--house-key')!,
    phase: flags.get('--phase') as Input['phase'], state: flags.get('--state'), referenceSha: flags.get('--reference-sha') };
}
function validate(input: Input) {
  const url = new URL(input.origin);
  assert.equal(url.origin, input.origin, 'origin must be a canonical origin without credentials or path');
  assert.equal(url.hostname, '127.0.0.1', 'only explicit IPv4 loopback is permitted');
  assert.equal(url.protocol, 'http:', 'fixture uses loopback HTTP');
  assert.equal(bs58.decode(input.houseKey).length, 32, 'trusted House key must be a 32-byte base58 public key');
  assert.ok(!input.phase || ['before-restart', 'after-restart'].includes(input.phase), 'invalid phase');
  if (input.referenceSha) assert.match(input.referenceSha, /^[0-9a-f]{40}$/);
}
function safeState(path: string): SavedState {
  const absolute = realpathSync(path), root = dirname(absolute), temporary = realpathSync(tmpdir());
  assert.equal(dirname(root), temporary, 'continuation must be inside this harness temporary directory');
  assert.ok(basename(root).startsWith('public-envelope-reference-'), 'unrecognized temporary root');
  assert.equal(basename(absolute), 'continuation.json');
  assert.equal(lstatSync(absolute).mode & 0o077, 0, 'continuation secrets must be owner-only');
  const state = JSON.parse(readFileSync(absolute, 'utf8')) as SavedState;
  assert.equal(state.format, 'public-envelope-reference-runtime-v1');
  assert.equal(realpathSync(state.root), root);
  assert.ok(/^[0-9a-f]{64}$/.test(state.senderSeed) && /^[0-9a-f]{64}$/.test(state.recipientSeed), 'invalid fixture key material');
  return state;
}

/** Trace only public stream resume arguments; never copy headers, tokens, or signed requests to logs. */
function transportFor(origin: string, requests: string[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin, 'runtime attempted a non-fixture origin');
    if (url.pathname === '/v1/world-stream') requests.push(url.pathname + url.search);
    return fetch(input, { ...init, redirect: 'error' });
  };
}
class Peer {
  readonly root: string;
  readonly signer: MasterKeySigner;
  readonly actorId: string;
  readonly paths: PopclawPaths;
  readonly host: LocalHostAdapter;
  readonly db;
  readonly cacheDb: LocalHostDb;
  readonly catalog: ExecutionStoreCatalog;
  readonly partition;
  readonly store;
  readonly requests: string[] = [];
  readonly wireDeliveries = new Map<string, number>();
  readonly inboxStore: InboxStore;
  readonly messages = new Map<string, { body: string; raw: Uint8Array }>();
  readonly runtimeErrors: string[] = [];
  houses!: HouseRuntime;
  worlds!: WorldRuntime;
  private running = false;
  private checkInsIssued = 0;
  constructor(readonly input: Input, root: string, readonly seed: Uint8Array, fresh: boolean) {
    this.root = root; mkdirSync(root, { recursive: true, mode: 0o700 });
    rememberSecret(seed);
    const pair = nacl.sign.keyPair.fromSeed(seed); rememberSecret(pair.secretKey); this.actorId = bs58.encode(pair.publicKey);
    this.signer = new MasterKeySigner({ seed, ...pair, popclawId: this.actorId });
    this.paths = new PopclawPaths(root);
    this.host = new LocalHostAdapter({ dataRoot: root, logger: { info() {}, warn() {}, error() {} } });
    this.db = this.host.db; this.inboxStore = new InboxStore(this.db);
    if (fresh) this.db.execute('CREATE TABLE fixture_dm_business_effects(event_id TEXT PRIMARY KEY, deliveries INTEGER NOT NULL)');
    this.cacheDb = new LocalHostDb(join(root, 'cache.db'));
    this.catalog = new ExecutionStoreCatalog({ db: this.db, paths: this.paths, actorId: this.actorId });
    this.partition = this.catalog.open(input.origin);
    this.store = { baseUrl: input.origin, slug: hostDbSlug(input.origin), db: this.cacheDb, executionDb: this.partition.db,
      dbPath: join(root, 'cache.db'), cache: new WorldFeedCache({ db: this.cacheDb }) };
    if (fresh) {
      const maintenance = MaintenanceSession.begin(this.db, this.paths, 'Isolated reference interoperability action receipts');
      initializeActionReceiptJournal({ catalog: this.catalog, origin: input.origin, maintenance });
      maintenance.finish({ recovery: false, reason: 'Fresh isolated action receipt partition prepared' });
    }
  }
  view() {
    const view = readHouseCapabilityView(this.db, this.input.origin);
    assert.ok(view, 'real login must commit an authenticated capability view');
    assert.equal(view.verified.house.houseKey, this.input.houseKey);
    return view;
  }
  async start() {
    assert.equal(this.running, false);
    const input = this.input;
    const transport = transportFor(input.origin, this.requests);
    this.houses = new HouseRuntime({ db: this.db, signer: this.signer, origins: [input.origin], executionStores: this.catalog,
      publicV1Mode: true, configuredPinFor: () => Buffer.from(bs58.decode(input.houseKey)).toString('hex'),
      fetch: transport, intentPollMs: 100, log: message => { if (/error|failed|invalid|unsupported/i.test(message)) this.runtimeErrors.push(message); } });
    this.worlds = new WorldRuntime({ mode: 'commands', houses: this.houses, signer: this.signer, actorId: this.actorId,
      fetch: transport, readCapabilities: origin => readHouseCapabilityView(this.db, origin), fixtureOwnerAuthorization: {
        authorize: async candidate => {
          const fixed: WorldInvokeInput = { house: input.origin, kind, params: { ...params }, expected_capability_revision: this.view().verified.capabilityRevision };
          assert.deepEqual(candidate, fixed, 'fixture permission is restricted to the exact check-in input');
          assert.equal(basename(this.root), 'sender', 'only the designated fixture actor may invoke');
          assert.ok(this.checkInsIssued < 2, 'fixture grants exactly two check-ins');
          const index = ++this.checkInsIssued, generation = this.houses;
          return { jobId: `isolated-reference-check-in-${index}`, expiresAt: Math.floor(Date.now() / 1000) + 240,
            assertCurrent: () => { assert.ok(this.running && this.houses === generation, 'fixture permission expired with its runtime'); } };
        },
      } });
    const consumeInbox = makeInboxOnMessage({ signer: this.signer, inboxStore: this.inboxStore, socialLog: undefined,
      dmMediaDir: () => this.paths.dmMediaDir(), info() {}, warn() {},
      onPlainDm: arrival => {
        assert.ok(arrival.item.eventId, 'business delivery must retain the original envelope CID');
        // The production settlement and its real SQLite transaction gate the measured business effect.
        this.inboxStore.settleNotification(arrival.item.id, 'queued', () => {
          this.db.execute('INSERT INTO fixture_dm_business_effects VALUES(?,1) ON CONFLICT(event_id) DO UPDATE SET deliveries=deliveries+1', [arrival.item.eventId!]);
        });
      } });
    this.houses.configureResources({ host: this.host, stores: [this.store], openStore: async () => this.store,
      worldStreamMode: true, recipientPopclawId: this.actorId, isOfficialActor: (_store, actor) => publicProducerPolicy(this.view()).officialActorIds.includes(actor),
      onInbox: async (house, _gate, dm, raw, nickname) => {
        const body = readDmBody(dm, this.signer);
        assert.ok(body !== null, 'ordinary encrypted inbox message must decrypt');
        const envelope = verifyInboundEnvelope(raw, { recipientPopclawId: this.actorId });
        this.wireDeliveries.set(envelope.eventId!, (this.wireDeliveries.get(envelope.eventId!) ?? 0) + 1);
        await consumeInbox(dm, house.slug, raw, nickname);
        this.messages.set(envelope.eventId!, { body, raw: new Uint8Array(raw) });
      } });
    this.running = true; this.houses.start(); await this.houses.manager.resumeAfterOwnership();
  }
  async login() {
    const login = await this.houses.commands.loginHouse(this.input.origin);
    assert.equal(login.status, 'connected', `login failed (${login.status}); ${this.runtimeErrors.slice(-4).join('; ')}`);
    assert.ok(login.sessionId, 'login must return an actual House session');
    const row = readParticipation(this.db, this.input.origin)!;
    assert.ok(row.inbox_read_token, 'verified session must persist inbox token'); rememberSecret(row.inbox_read_token);
    const view = this.view(); assert.equal(view.publicStream.validation, 'valid');
    return view;
  }
  async provisionPublic() {
    await this.stop();
    const maintenance = MaintenanceSession.begin(this.db, this.paths, 'Authenticated isolated public journal preparation');
    initializePublicStreamJournal({ catalog: this.catalog, origin: this.input.origin, maintenance,
      configuredPin: Buffer.from(bs58.decode(this.input.houseKey)).toString('hex') });
    maintenance.finish({ recovery: false, reason: 'Verified real manifest captured; stopped runtime fully joined' });
    await this.start(); await this.login(); await this.caughtUp();
  }
  async caughtUp() {
    await until(() => this.houses.publicReadStatus(this.input.origin).receive?.caughtUp === true, 'public receiver did not catch up',
      () => this.houses.publicReadStatus(this.input.origin));
  }
  cursor(): string {
    return this.partition.db.queryOne<{ after_seq: string }>("SELECT after_seq FROM world_public_cursors_v1 WHERE lane='public' AND log_incarnation=?", [this.view().publicStreamCapability!.publicStream.log_incarnation])!.after_seq;
  }
  token(): string { const token = readParticipation(this.db, this.input.origin)!.inbox_read_token; rememberSecret(token); return token; }
  async stop() {
    if (!this.running) return; this.running = false;
    this.worlds.stop(); await this.worlds.whenIdle(); await this.houses.stop();
  }
  async close() { await this.stop(); this.catalog.close(); this.cacheDb.close(); this.db.close(); }
}

interface SseFrame { id: string; event: string; bytes: Uint8Array }
/** A bounded real HTTP reader exposes Last-Event-ID, which the ordinary runtime callback does not expose. */
async function readInboxFrame(input: Input, peer: Peer, after = '0'): Promise<SseFrame> {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(`${input.origin}/inbox/${peer.actorId}/stream`, { headers: {
      'x-popclaw-inbox-token': peer.token(), 'Last-Event-ID': after }, signal: abort.signal, redirect: 'error' });
    assert.equal(response.status, 200, 'recipient session token must open inbox'); assert.ok(response.body);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    try {
      for (;;) {
        const chunk = await reader.read(); assert.equal(chunk.done, false, 'inbox ended before an envelope');
        pending += decoder.decode(chunk.value, { stream: true }); pending = pending.replace(/\r\n/g, '\n');
        let at: number;
        while ((at = pending.indexOf('\n\n')) >= 0) {
          const message = pending.slice(0, at); pending = pending.slice(at + 2);
          const lines = message.split('\n'), event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
          if (event !== 'envelope') continue;
          const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim() ?? '';
          assert.match(id, /^[1-9][0-9]*$/, 'inbox original frame must provide a resume ID');
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
          return { id, event, bytes: Buffer.from(data, 'base64') };
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  } finally { clearTimeout(timer); abort.abort(); }
}
/** Retain a bounded carrier even if reading it fails; never put its contents in an error message. */
async function saveDmResponse(response: Response, path: string) {
  const limit = 64 * 1024, chunks: Uint8Array[] = [];
  let length = 0, truncated = false;
  const reader = response.body?.getReader();
  try {
    if (reader) for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = limit - length;
      if (chunk.value.length > remaining) {
        chunks.push(chunk.value.slice(0, remaining)); length += remaining; truncated = true; break;
      }
      chunks.push(chunk.value); length += chunk.value.length;
    }
  } finally {
    privateFile(path, Buffer.concat(chunks, length));
    await reader?.cancel().catch(() => {});
  }
  return { bytes: Buffer.concat(chunks, length), truncated };
}
function safeResponseCode(bytes: Uint8Array, truncated: boolean): string {
  if (truncated) return 'RESPONSE_TRUNCATED';
  try {
    const document = JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown; code?: unknown };
    const error = document.error;
    const candidate = error && typeof error === 'object' && 'code' in error ? error.code
      : typeof error === 'string' ? error : document.code;
    // Protocol identifiers only: never echo a server error message, arbitrary JSON or body bytes.
    if (typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(candidate)) return candidate;
  } catch { /* A non-JSON carrier is still available in the private evidence directory. */ }
  return 'UNCLASSIFIED_RESPONSE';
}
async function sendDm(input: Input, sender: Peer, recipient: Peer, label: string) {
  const body = `Isolated encrypted reference message ${label} ${randomUUID()}`;
  const signed = await signDirectMessage(sender.signer, { toPopclawId: recipient.actorId, nickname: 'Isolated TS peer', body });
  const envelopeBytes = popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes).payload;
  const directory = join(sender.root, 'dm-evidence', `attempt-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Capture the actual generated originals before the POST. No plaintext or identity secrets are serialized here.
  privateFile(join(directory, 'signed-payload.pb'), signed.signedPayloadBytes);
  privateFile(join(directory, 'event-envelope.pb'), envelopeBytes);
  const evidence = { stage, eventId: signed.eventId, signedPayloadSha256: hash(signed.signedPayloadBytes), envelopeSha256: hash(envelopeBytes),
    signedPayloadFile: 'signed-payload.pb', envelopeFile: 'event-envelope.pb', responseFile: 'response-body.bin' };
  privateFile(join(directory, 'index.json'), JSON.stringify(evidence, null, 2));
  const envelope = popclaw.event.EventEnvelope.decode(envelopeBytes);
  assert.ok((envelope.directMessage?.ciphertext?.length ?? 0) > 0);
  assert.ok(!Buffer.from(signed.signedPayloadBytes).includes(Buffer.from(body)), 'plaintext must not occur on wire');
  const pushed = await fetch(`${input.origin}/v1/push`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' },
    body: new Uint8Array(signed.signedPayloadBytes), signal: AbortSignal.timeout(15_000), redirect: 'error' });
  privateFile(join(directory, 'index.json'), JSON.stringify({ ...evidence, httpStatus: pushed.status, responseReadComplete: false }, null, 2));
  const response = await saveDmResponse(pushed, join(directory, 'response-body.bin'));
  const code = pushed.ok ? 'OK' : safeResponseCode(response.bytes, response.truncated);
  privateFile(join(directory, 'index.json'), JSON.stringify({ ...evidence, httpStatus: pushed.status, code,
    responseReadComplete: true, responseTruncated: response.truncated, responseBytesRetained: response.bytes.length }, null, 2));
  if (!pushed.ok) throw new Error(`DM_PUSH_HTTP_${pushed.status}:${code}`);
  return { eventId: signed.eventId, body };
}

async function assertDelivered(recipient: Peer, dm: { eventId: string; body: string }) {
  await until(() => recipient.messages.has(dm.eventId), 'ordinary HouseRuntime inbox did not deliver encrypted DM');
  assert.equal(recipient.messages.get(dm.eventId)!.body, dm.body);
}
function assertDurableDmDedup(peer: Peer, ids: readonly string[]) {
  for (const id of ids) {
    assert.equal(peer.db.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM inbox WHERE event_id=?', [id])!.count, 1, 'replayed DM must have one durable InboxStore row');
    assert.equal(peer.db.queryOne<{ deliveries: number }>('SELECT deliveries FROM fixture_dm_business_effects WHERE event_id=?', [id])?.deliveries, 1, 'replayed DM must not repeat business consumption');
  }
}
async function assertWrongRecipientToken(input: Input, sender: Peer, recipient: Peer) {
  const response = await fetch(`${input.origin}/inbox/${recipient.actorId}/stream`, { headers: { 'x-popclaw-inbox-token': sender.token() },
    signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.equal(response.status, 401, 'another real actor session token must not read this inbox'); await response.arrayBuffer();
}
function assertNoPublicDm(peer: Peer, privateIds: readonly string[]) {
  const rows = peer.partition.db.queryAll<{ event_id: string; envelope: Uint8Array }>('SELECT event_id,envelope FROM world_public_events_v1');
  const policy = publicProducerPolicy(peer.view());
  for (const row of rows) {
    assert.ok(!privateIds.includes(row.event_id), 'private message CID leaked into public journal');
    const verified = verifyPublicEnvelope(row.envelope, policy);
    assert.ok(!verified.envelope.directMessage, 'public journal must contain only qualified public envelopes');
  }
}
async function receiptBytes(response: Response): Promise<Uint8Array> {
  const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length <= 1_500_000, 'receipt carrier exceeded fixture bound');
  if (media === 'application/x-protobuf') return bytes;
  assert.equal(media, 'application/json', 'reference receipt needs a known HTTP carrier');
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes)).receipt_base64;
  assert.ok(typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'missing or malformed receipt_base64');
  const original = Buffer.from(value, 'base64'); assert.ok(original.length > 0);
  assert.equal(original.toString('base64'), value, 'receipt base64 must be canonical');
  return original;
}
interface Footprint { seq: string; source_event_id: string; ranger_id: string; place: string; latitude: string; longitude: string; status: string }
async function businessRead(input: Input, sender: Peer, actionIds: readonly [string, string]) {
  const prefix = stage;
  async function get(path: string) {
    stage = `${prefix}.${path.includes('/map?') ? 'latest-map' : path.includes('/by-event/') ? 'by-event' : 'actor-history'}`;
    const response = await fetch(new URL(path, input.origin), { signal: AbortSignal.timeout(5000), redirect: 'error' });
    assert.equal(response.status, 200, 'reference business read failed'); return response.json();
  }
  const history = await get(`/ranger-map/v1/footprints?ranger_id=${sender.actorId}&limit=100`) as { items: Footprint[]; next_before: string | null };
  assert.equal(history.items.length, 2, 'two distinct request CIDs must produce exactly two immutable footprints');
  assert.equal(history.next_before, null);
  assert.deepEqual(history.items.map(row => row.source_event_id), [...actionIds].reverse());
  for (const row of history.items) {
    assert.equal(row.ranger_id, sender.actorId);
    for (const key of ['place', 'latitude', 'longitude', 'status'] as const) assert.equal(row[key], params[key]);
    assert.deepEqual(await get(`/ranger-map/v1/footprints/by-event/${row.source_event_id}`), row);
  }
  const latest: Footprint[] = []; let cursor: string | null = null, pages = 0;
  do {
    assert.ok(++pages <= 100, 'map pagination exceeded fixture bound');
    const page = await get(`/ranger-map/v1/map?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`) as { items: Footprint[]; next_cursor: string | null };
    latest.push(...page.items.filter(row => row.ranger_id === sender.actorId)); cursor = page.next_cursor;
  } while (cursor);
  assert.equal(latest.length, 1, 'the latest map must contain one row for this actor');
  assert.equal(latest[0]!.source_event_id, actionIds[1], 'the latest map must point to the second request');
  assert.deepEqual(latest[0], history.items[0]);
}
async function checkIn(sender: Peer) {
  const prefix = stage;
  const input: WorldInvokeInput = { house: sender.input.origin, kind, params: { ...params }, expected_capability_revision: sender.view().verified.capabilityRevision };
  const result = await sender.houses.runCommand(async () => {
    const authority = await atStage(`${prefix}.authority`, () => sender.worlds.actionAuthority(input));
    return atStage(`${prefix}.invoke`, () => sender.worlds.client(input.house).invoke(input, authority));
  });
  stage = `${prefix}.durable-receipt`;
  assert.equal(result.status, 'succeeded', `real WorldRuntime action result ${JSON.stringify(result)}`);
  assert.equal(result.receipt_durable, true, 'verified receipt must be durable in ActionReceiptJournal');
  const evidence = sender.partition.db.queryOne<{ signed_result_bytes: Uint8Array }>("SELECT signed_result_bytes FROM world_action_client_evidence WHERE request_id=? AND source_kind='push_result'", [result.request_id]);
  assert.ok(evidence, 'actual signed push receipt must be retained');
  return { requestId: result.request_id, receipt: evidence.signed_result_bytes };
}
async function replayReceipt(input: Input, sender: Peer, requestId: string, expected: Uint8Array) {
  const request = sender.partition.db.queryOne<{ request_bytes: Uint8Array }>('SELECT request_bytes FROM world_action_client_requests WHERE request_id=?', [requestId]);
  assert.ok(request, 'original signed action request must remain durable');
  for (let i = 0; i < 2; i++) {
    const response: Response = await fetch(`${input.origin}/v1/push`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array(request.request_bytes), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    assert.ok(response.ok, `original request retry HTTP ${response.status}`);
    assert.deepEqual(Buffer.from(await receiptBytes(response)), Buffer.from(expected), 'exact original request must return identical signed receipt bytes');
  }
}
function fact(peer: Peer, requestId: string) {
  const rows = peer.partition.db.queryAll<{ event_id: string; envelope: Uint8Array }>("SELECT event_id,envelope FROM world_public_events_v1 WHERE kind='rangermap.checked_in'");
  return rows.find(row => {
    const event = popclaw.event.EventEnvelope.decode(row.envelope).houseEvent!;
    return Buffer.from(event.body ?? new Uint8Array()).includes(Buffer.from(requestId));
  });
}
async function startScopeReceiver(input: Input, root: string, peer: Peer, fresh: boolean, auditFull = false) {
  const db = new LocalHostDb(join(root, auditFull ? `public-audit-${randomUUID()}.db` : 'scope-only.db')), controller = new AbortController();
  const capability = peer.view().publicStreamCapability!, scopes = capability.publicStream.initial_public_scopes;
  assert.ok(scopes.length > 0, 'reference check-in must declare a scoped public lane');
  const options = { executionDb: db, capability, producerPolicy: publicProducerPolicy(peer.view()),
    gate: { origin: input.origin, signal: controller.signal, isActive: () => !controller.signal.aborted },
    selection: { fullPublic: auditFull, scopes: auditFull ? [] : [...scopes] }, consumers: [], consumerContracts: [], approvedConsumerMappingDigest: EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST,
    fetch: transportFor(input.origin, []) };
  if (fresh) preparePublicStreamJournal(options);
  const receiver = new PublicV1Receiver(options);
  try { await receiver.start(); }
  catch (error) { controller.abort(); await receiver.stop(); await receiver.whenIdle(); db.close(); throw error; }
  return { db, receiver, async close() { controller.abort(); await receiver.stop(); await receiver.whenIdle(); db.close(); } };
}

/** Replay from zero after sending DMs: a receive rejection must fail the audit, not hide a public leak. */
async function auditPublicHistory(input: Input, root: string, peer: Peer, privateIds: readonly string[], expected: readonly { eventId: string; envelope: Uint8Array }[]) {
  const audit = await startScopeReceiver(input, root, peer, true, true);
  try {
    await until(() => audit.receiver.receiveStatus().caughtUp, 'fresh public replay rejected or failed to complete', () => audit.receiver.receiveStatus());
    const rows = audit.db.queryAll<{ event_id: string; envelope: Uint8Array }>('SELECT event_id,envelope FROM world_public_events_v1');
    for (const required of expected) {
      const original = rows.find(row => row.event_id === required.eventId);
      assert.ok(original, 'fresh zero-cursor public replay must contain each original check-in fact');
      assert.deepEqual(Buffer.from(original.envelope), Buffer.from(required.envelope), 'server must preserve exact public fact bytes across restart');
    }
    for (const row of rows) {
      assert.ok(!privateIds.includes(row.event_id), 'private message appeared in fresh full-public replay');
      assert.ok(!verifyPublicEnvelope(row.envelope, publicProducerPolicy(peer.view())).envelope.directMessage);
    }
    assertNoPublicDm(peer, privateIds);
  } finally { await audit.close(); }
}

async function main() {
  stage = 'input'; const input = parseInput(); validate(input);
  const afterRestart = input.phase === 'after-restart';
  const saved = afterRestart ? safeState(input.state!) : null;
  if (saved) { assert.equal(saved.origin, input.origin); assert.equal(saved.houseKey, input.houseKey); assert.equal(saved.referenceSha, input.referenceSha); }
  const root = saved?.root ?? realpathSync(mkdtempSync(join(tmpdir(), 'public-envelope-reference-'))); chmodSync(root, 0o700); diagnosticRoot = root;
  const senderSeed = saved ? Buffer.from(saved.senderSeed, 'hex') : randomBytes(32), recipientSeed = saved ? Buffer.from(saved.recipientSeed, 'hex') : randomBytes(32);
  rememberSecret(senderSeed); rememberSecret(recipientSeed);
  // Written before runtime construction so an early failure can still be diagnosed with the same two ephemeral identities.
  privateFile(join(root, 'fixture-identities.json'), JSON.stringify({ format: 'public-envelope-reference-diagnostic-v1', origin: input.origin, houseKey: input.houseKey, referenceSha: input.referenceSha, root,
    senderSeed: senderSeed.toString('hex'), recipientSeed: recipientSeed.toString('hex') }));
  stage = 'construct-sender'; const sender = new Peer(input, join(root, 'sender'), senderSeed, !saved);
  stage = 'construct-recipient'; const recipient = new Peer(input, join(root, 'recipient'), recipientSeed, !saved);
  assert.notEqual(sender.actorId, recipient.actorId);
  let scope: Awaited<ReturnType<typeof startScopeReceiver>> | undefined, preserve = !!saved;
  let cleanupFailed = false;
  const report: Record<string, unknown> = { referenceSha: input.referenceSha, origin: input.origin, phase: input.phase ?? 'before-restart' };
  try {
    await atStage('sender.start', () => sender.start()); await atStage('sender.login', () => sender.login());
    await atStage('recipient.start', () => recipient.start()); await atStage('recipient.login', () => recipient.login());
    if (!saved) { await atStage('sender.provision-public', () => sender.provisionPublic()); await atStage('recipient.provision-public', () => recipient.provisionPublic()); }
    else { await atStage('sender.restart-catchup', () => sender.caughtUp()); await atStage('recipient.restart-catchup', () => recipient.caughtUp()); }
    stage = 'verified-capability-profile';
    const view = sender.view(); assert.equal(recipient.view().verified.capabilityRevision, view.verified.capabilityRevision);
    assert.equal(view.publicStreamCapability!.publicStream.envelope_baseline, 'public-envelope-01');
    scope = await atStage('scope-only.start', () => startScopeReceiver(input, root, recipient, !saved));
    if (saved) {
      stage = 'after-restart.manifest-and-initial-cursor';
      assert.equal(view.verified.capabilityRevision, saved.capabilityRevision, 'server restart changed authenticated manifest');
      assert.equal(view.publicStreamCapability!.publicStream.log_incarnation, saved.logIncarnation, 'same server data root must preserve log incarnation');
      assert.equal(new URL(recipient.requests[0]!, input.origin).searchParams.get('public_after'), saved.publicCursor, 'first restarted-client request must use its persisted public cursor');
      for (const action of saved.actions) {
        assert.deepEqual(Buffer.from(fact(recipient, action.requestId)!.envelope), Buffer.from(action.factEnvelope, 'base64'));
        await atStage('after-restart.original-receipt-retry', () => replayReceipt(input, sender, action.requestId, Buffer.from(action.receipt, 'base64')));
        stage = 'after-restart.action-status';
        const status = await sender.houses.runCommand(() => sender.worlds.client(input.origin).status(action.requestId));
        assert.equal(status.status, 'succeeded'); assert.equal(status.receipt_durable, true);
      }
      await atStage('after-restart.business-projection', () => businessRead(input, sender, [saved.actions[0].requestId, saved.actions[1].requestId]));
      stage = 'after-restart.old-inbox-replay-and-dedup';
      await until(() => saved.privateEventIds.every(id => (recipient.wireDeliveries.get(id) ?? 0) >= 1), 'new client process did not replay existing inbox history');
      assertDurableDmDedup(recipient, saved.privateEventIds);
      const dm = await atStage('after-restart.send-dm', () => sendDm(input, sender, recipient, 'after-reference-restart'));
      await atStage('after-restart.deliver-dm', () => assertDelivered(recipient, dm));
      stage = 'after-restart.http-inbox-suffix';
      const resumed = await readInboxFrame(input, recipient, saved.inboxLastEventId);
      assert.equal(verifyInboundEnvelope(resumed.bytes, { recipientPopclawId: recipient.actorId }).eventId, dm.eventId);
      assert.ok(BigInt(resumed.id) > BigInt(saved.inboxLastEventId));
      assertDurableDmDedup(recipient, [...saved.privateEventIds, dm.eventId]);
      stage = 'after-restart.fresh-full-public-audit';
      await auditPublicHistory(input, root, recipient, [...saved.privateEventIds, dm.eventId], saved.actions.map(action => ({ eventId: action.factId, envelope: Buffer.from(action.factEnvelope, 'base64') })));
      await until(() => scope!.receiver.receiveStatus().caughtUp, 'scope-only receiver failed after reference restart');
      for (const action of saved.actions) assert.ok(scope.db.queryOne('SELECT 1 FROM world_public_events_v1 WHERE event_id=?', [action.factId]));
      preserve = false; report.status = 'complete'; report.referenceRestart = 'external-restart-continuation-verified-manifest-log-receipt-and-cursors';
      report.actions = saved.actions.map(action => ({ requestId: action.requestId, receiptSha256: hash(Buffer.from(action.receipt, 'base64')), publicFactId: action.factId }));
      report.businessProjection = 'actor-latest-1-history-2'; report.ordinaryEncryptedDm = 'full-replay-with-durable-inbox-and-single-business-effect';
      report.inboxLastEventId = 'server-http-suffix-read-only';
    } else {
      const actions: SavedAction[] = [];
      let previousTimestamp = 0;
      const invokeAndObserve = async (observer: Peer) => {
        // Owner actions intentionally have no wire nonce. Advance actual protocol time for a distinct second CID.
        await until(() => Math.floor(Date.now() / 1000) > previousTimestamp, 'next check-in timestamp did not advance');
        const prefix = `check-in-${actions.length + 1}`;
        const result = await atStage(prefix, () => checkIn(sender));
        const request = sender.partition.db.queryOne<{ request_bytes: Uint8Array }>('SELECT request_bytes FROM world_action_client_requests WHERE request_id=?', [result.requestId])!;
        previousTimestamp = Number(popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(request.request_bytes).payload).timestamp);
        await atStage(`${prefix}.original-receipt-retry`, () => replayReceipt(input, sender, result.requestId, result.receipt));
        stage = `${prefix}.public-fact`;
        await until(() => !!fact(observer, result.requestId), 'public-v1 receiver did not retain rangermap.checked_in');
        const checkedIn = fact(observer, result.requestId)!;
        await until(() => !!scope!.db.queryOne('SELECT 1 FROM world_public_events_v1 WHERE event_id=?', [checkedIn.event_id]), 'scope-only receiver did not observe check-in');
        actions.push({ requestId: result.requestId, receipt: Buffer.from(result.receipt).toString('base64'), factId: checkedIn.event_id, factEnvelope: Buffer.from(checkedIn.envelope).toString('base64') });
      };
      await invokeAndObserve(recipient);
      await atStage('inbox.wrong-recipient-token', () => assertWrongRecipientToken(input, sender, recipient));
      const first = await atStage('dm-1.send', () => sendDm(input, sender, recipient, 'before-client-restart'));
      await atStage('dm-1.deliver', () => assertDelivered(recipient, first));
      stage = 'inbox.http-initial-read';
      const inboxFirst = await readInboxFrame(input, recipient);
      assert.equal(verifyInboundEnvelope(inboxFirst.bytes, { recipientPopclawId: recipient.actorId }).eventId, first.eventId);
      const cursor = recipient.cursor(), requestStart = recipient.requests.length;
      const firstWireCount = recipient.wireDeliveries.get(first.eventId)!;
      await atStage('recipient.disconnect', () => recipient.stop());
      await invokeAndObserve(sender);
      assert.notEqual(actions[0]!.requestId, actions[1]!.requestId, 'second action needs its own CID');
      assert.equal(sender.partition.db.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM world_action_client_requests')!.count, 2);
      await atStage('actor-business-projection', () => businessRead(input, sender, [actions[0]!.requestId, actions[1]!.requestId]));
      const second = await atStage('dm-2.send-offline', () => sendDm(input, sender, recipient, 'while-client-disconnected'));
      await atStage('recipient.restart', () => recipient.start()); await atStage('recipient.relogin', () => recipient.login());
      await atStage('recipient.public-resume', () => recipient.caughtUp()); await atStage('dm-2.deliver-after-restart', () => assertDelivered(recipient, second));
      stage = 'recipient.verify-new-public-fact-and-inbox-dedup';
      await until(() => !!fact(recipient, actions[1]!.requestId), 'restarted runtime lost the new public event published while disconnected');
      assert.deepEqual(Buffer.from(fact(recipient, actions[1]!.requestId)!.envelope), Buffer.from(actions[1]!.factEnvelope, 'base64'));
      assert.ok(BigInt(recipient.cursor()) > BigInt(cursor), 'public resume must advance beyond the saved cursor');
      await until(() => (recipient.wireDeliveries.get(first.eventId) ?? 0) > firstWireCount, 'runtime restart must really replay the earlier DM');
      assertDurableDmDedup(recipient, [first.eventId, second.eventId]);
      assert.equal(new URL(recipient.requests[requestStart]!, input.origin).searchParams.get('public_after'), cursor, 'first client restart request must preserve public cursor');
      stage = 'inbox.http-last-event-id-suffix';
      const inboxSecond = await readInboxFrame(input, recipient, inboxFirst.id);
      assert.equal(verifyInboundEnvelope(inboxSecond.bytes, { recipientPopclawId: recipient.actorId }).eventId, second.eventId, 'Last-Event-ID must omit already read private envelope');
      assert.ok(BigInt(inboxSecond.id) > BigInt(inboxFirst.id));
      stage = 'fresh-full-public-audit';
      await auditPublicHistory(input, root, recipient, [first.eventId, second.eventId], actions.map(action => ({ eventId: action.factId, envelope: Buffer.from(action.factEnvelope, 'base64') })));
      const logout = await atStage('sender.leave', () => sender.houses.commands.logoutHouse(input.origin)); assert.equal(logout.localQuiesced, true);
      await until(async () => (await sender.houses.commands.getHouseStatus(input.origin)).remoteStatus === 'confirmed', 'real House leave was not acknowledged');
      for (const action of actions) await atStage('after-leave.original-receipt-retry', () => replayReceipt(input, sender, action.requestId, Buffer.from(action.receipt, 'base64')));
      await atStage('actor-business-projection', () => businessRead(input, sender, [actions[0]!.requestId, actions[1]!.requestId]));
      stage = 'write-restart-continuation';
      const state: SavedState = { format: 'public-envelope-reference-runtime-v1', origin: input.origin, houseKey: input.houseKey,
        referenceSha: input.referenceSha, root, senderSeed: Buffer.from(sender.seed).toString('hex'), recipientSeed: Buffer.from(recipient.seed).toString('hex'),
        capabilityRevision: view.verified.capabilityRevision, logIncarnation: view.publicStreamCapability!.publicStream.log_incarnation,
        actions: actions as [SavedAction, SavedAction], publicCursor: recipient.cursor(), inboxLastEventId: inboxSecond.id,
        privateEventIds: [first.eventId, second.eventId] };
      const statePath = join(root, 'continuation.json'); writeFileSync(statePath, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); preserve = true;
      report.status = 'awaiting-reference-restart'; report.state = statePath;
      report.actions = actions.map(action => ({ requestId: action.requestId, receiptSha256: hash(Buffer.from(action.receipt, 'base64')), publicFactId: action.factId }));
      report.businessProjection = 'actor-latest-1-history-2';
      report.checks = ['two-real-logins', 'verified-manifest-and-guide', 'two-real-owner-actions-and-durable-receipts', 'actor-latest-1-history-2', 'public-and-scope-only-journals',
        'encrypted-ordinary-inbox', 'runtime-full-inbox-replay-with-durable-dedup-and-single-business-effect', 'wrong-recipient-token-401', 'client-restart-first-public-cursor-and-new-offline-event', 'inbox-last-event-id', 'exact-request-retry-before-and-after-leave', 'no-private-public-journal-entry'];
      report.continuation = 'Restart the reference process on its same data directory, then rerun with --phase after-restart --state and the same trusted origin/key/SHA.';
    }
  } catch (error) {
    preserve = true;
    const failedStage = stage;
    const stopped = await Promise.allSettled([recipient.stop(), sender.stop()]);
    // Capture locally retained originals even when result authentication failed before the action ledger accepted a receipt.
    const evidence = [sender, recipient].map(peer => {
      try { const token = readParticipation(peer.db, input.origin)?.inbox_read_token; if (token) rememberSecret(token); }
      catch { /* A peer that never started has no session schema or token. */ }
      try { return { root: peer.root, evidence: preservePeerEvidence(peer) }; }
      catch (captureError) { return { root: peer.root, extractionError: safeStack(captureError) }; }
    });
    diagnosticFile = join(root, 'failure.json');
    privateFile(diagnosticFile, JSON.stringify({ status: 'failed', phase: input.phase ?? 'before-restart', stage: failedStage, stack: safeStack(error),
      referenceSha: input.referenceSha, origin: input.origin, evidence, stopFailed: stopped.some(result => result.status === 'rejected'),
      identities: 'fixture-identities.json', note: 'Diagnostic retention only. This is not a completed phase-one continuation.' }, null, 2));
    stage = failedStage; throw error;
  } finally {
    const cleanup = await Promise.allSettled([scope?.close(), recipient.close(), sender.close()]);
    cleanupFailed = cleanup.some(result => result.status === 'rejected');
    if (cleanupFailed) preserve = true;
    if (!preserve) rmSync(root, { recursive: true, force: true });
  }
  assert.equal(cleanupFailed, false, 'fixture runtime cleanup failed');
  process.stdout.write(JSON.stringify(report) + '\n');
}
main().catch(error => {
  process.stderr.write(JSON.stringify({ status: 'failed', stage, ...(diagnosticRoot ? { retainedRoot: diagnosticRoot } : {}), ...(diagnosticFile ? { diagnostic: diagnosticFile } : {}) }) + '\n');
  process.stderr.write(safeStack(error) + '\n'); process.exitCode = 1;
});
