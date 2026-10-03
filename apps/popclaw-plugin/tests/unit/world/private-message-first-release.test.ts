/** First-release private message unit regressions (real SQLite, synthetic signers).
 *
 * Covers evidence selection, offline preparation/assertion, consumer receive
 * discriminants and lifecycle, adapter routing, bounded reader behavior and the
 * provisional-review adversarial cases: digest-only attestation rejection,
 * synchronous receive snapshots, unavailable-board fallback dispatch, adapter
 * join tracking, and route-before-ack drain semantics. */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  privateMessageBindingId, privateMessageWrapperDigest, selectFirstReleasePrivateEvidence,
} from '../../../src/world/private-message-evidence.js';
import {
  assertPrivateMessageJournalSchema, preparePrivateMessageJournal, pagePrivateMessageRows,
  PRIVATE_MESSAGE_SCHEMA_FINGERPRINT, readPrivateMessageRow, snapshotPrivateMessageOriginalContent,
  storeStructuredPrivateMessage,
} from '../../../src/world/private-message-storage.js';
import { adaptPrivateMessageConsumer, createPrivateMessageConsumer, type PrivateMessageConsumer } from '../../../src/world/private-message-consumer.js';
import { createPrivateMessageReader } from '../../../src/world/private-message-reader.js';

const utf8 = new TextEncoder();
const house = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
const official = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
const recipient = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const stranger = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(24));
const recipientB = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(25));
const houseId = bs58.encode(house.publicKey), officialId = bs58.encode(official.publicKey);
const recipientId = bs58.encode(recipient.publicKey);
const recipientBId = bs58.encode(recipientB.publicKey);
const origin = 'https://house.invalid', incarnation = 'inc_1';
const recipientSigner = new MasterKeySigner({ ...recipient, seed: recipient.secretKey.slice(0, 32), popclawId: recipientId });
const recipientBSigner = new MasterKeySigner({ ...recipientB, seed: recipientB.secretKey.slice(0, 32), popclawId: recipientBId });
const guideBytes = utf8.encode('Private message guide.');
const bodySchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const preparer = makeWorldManifestPreparer({ fetch: (async (url: string) => {
  if (!url.endsWith('/v1/guide.md')) throw new Error('UNEXPECTED_FETCH');
  return new Response(guideBytes, { status: 200, headers: { 'content-type': 'text/markdown' } });
}) as typeof fetch });

interface ViewOptions { participation?: boolean; kinds?: string[]; edit?: (document: any) => void; serialize?: (text: string) => string }
async function installView(db: HostDb, options: ViewOptions = {}): Promise<HouseCapabilityView> {
  const kinds = options.kinds ?? ['mud.message'];
  const document = {
    world_interaction: { version: 1, private_messages: { version: 1, kinds, participation: options.participation ?? false },
      guide: { path: '/v1/guide.md', sha256: cidFromCanonical(guideBytes), revision: 'guide_r1' } },
    official_ids: [officialId],
    event_kinds: [{ kind: 'mud.message', schema_version: 1, transport: 'house', signer: 'official',
      description: 'Private card', body_schema: bodySchema }],
  };
  options.edit?.(document);
  const rawBytes = utf8.encode((options.serialize ?? ((text: string) => text))(JSON.stringify(document)));
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
function participationDescriptor(): Record<string, unknown> {
  return { version: 1, house: { origin, house_key: houseId, incarnation }, actor_id: recipientId,
    participation_id: 'p_1', revision: '5', window: { id: 'w_1', opens_at: '2026-09-08T12:00:00Z', closes_at: '2026-09-08T13:00:00Z' },
    action_groups: [{ id: 'g_1', intent_kinds: ['mud.say'], control_reset: 'window' }], opportunities: [], budgets: [] };
}

const ownedDbs: HostDb[] = []; const ownedRoots: string[] = [];
function filesFixture() {
  const root = mkdtempSync(join(tmpdir(), 'g1-private-'));
  const hostDb = new LocalHostDb(join(root, 'host.db'));
  const execDb = new LocalHostDb(join(root, 'exec.db'));
  ownedDbs.push(hostDb, execDb); ownedRoots.push(root);
  const abort = new AbortController();
  const gate = { origin, signal: abort.signal, isActive: () => !abort.signal.aborted };
  return { root, hostDb, execDb, abort, gate };
}
function makeConsumer(f: ReturnType<typeof filesFixture>, options: {
  view(): HouseCapabilityView | null; isOfficialActor?: (id: string) => boolean; assertCurrent?: () => void;
  recipient?: MasterKeySigner; recipientId?: string;
}): PrivateMessageConsumer {
  preparePrivateMessageJournal({ executionDb: f.execDb });
  return createPrivateMessageConsumer({ executionDb: f.execDb, gate: f.gate,
    assertCurrent: options.assertCurrent ?? (() => {}), recipientId: options.recipientId ?? recipientId,
    view: options.view, recipient: options.recipient ?? recipientSigner,
    isOfficialActor: options.isOfficialActor ?? ((id: string) => id === officialId) });
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function bindingOf(view: HouseCapabilityView): string {
  const selection = selectFirstReleasePrivateEvidence(view, recipientId);
  if (!selection.available) throw new Error('SELECTION_UNAVAILABLE');
  return privateMessageBindingId(selection.evidence);
}
afterEach(() => {
  vi.restoreAllMocks();
  ownedDbs.splice(0).forEach(db => db.close());
  ownedRoots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('evidence selection', () => {
  it('selects board kinds, participation advertisement and official ids from a real committed view', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const selection = selectFirstReleasePrivateEvidence(view, recipientId);
    expect(selection.available).toBe(true);
    if (!selection.available) return;
    expect(selection.evidence.participationAdvertised).toBe(false);
    expect(selection.evidence.officialActorIds).toEqual([officialId]);
    expect([...selection.evidence.kinds.keys()]).toEqual(['mud.message']);
    expect(selection.evidence.kinds.get('mud.message')!.bodySchema).toEqual(bodySchema);
    expect(selectFirstReleasePrivateEvidence(view, recipientBId).available).toBe(true);
  });
  it('is unaffected by an unselected sibling carrying an oversized deep legacy schema', async () => {
    const f = filesFixture();
    // The sibling is exactly the shape the running world House ships: its
    // payload under the legacy member name, nested past the business bound,
    // and larger than a selected schema may be. The board selects neither it
    // nor its name, so it is outside the profile's jurisdiction entirely.
    const view = await installView(f.hostDb, {
      edit: document => document.event_kinds.push({ kind: 'world.embodiment', schema_version: 1, transport: 'house', signer: 'official',
        description: 'x'.repeat(40000), schema: { $defs: { figure: { properties: { figure_ref: { properties: { deep: { properties: { deeper: { type: 'string' } } } } } } } } } }),
    });
    const selection = selectFirstReleasePrivateEvidence(view, recipientId);
    expect(selection.available).toBe(true);
    if (!selection.available) return;
    expect([...selection.evidence.kinds.keys()]).toEqual(['mud.message']);
    expect(selection.evidence.kinds.get('mud.message')!.bodySchema).toEqual(bodySchema);
  });
  it('refuses a selected kind whose own original schema bytes exceed the bound', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb, { serialize: text => text.replace('"body_schema":{', '"body_schema":{' + ' '.repeat(32768)) });
    expect(view.privateMessages.kinds['mud.message']).toMatchObject({ validation: 'invalid', detail: 'SCHEMA_SIZE_LIMIT' });
    const selection = selectFirstReleasePrivateEvidence(view, recipientId);
    expect(selection.available).toBe(true);
    if (!selection.available) return;
    expect([...selection.evidence.kinds.keys()]).toEqual([]);
  });
  it('rejects a board advertising participation as unsupported in M1', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb, { participation: true });
    expect(selectFirstReleasePrivateEvidence(view, recipientId))
      .toMatchObject({ available: false, reason: 'PRIVATE_PARTICIPATION_UNSUPPORTED' });
  });
  it('is unavailable without a view or without a private board', async () => {
    const f = filesFixture();
    expect(selectFirstReleasePrivateEvidence(null, recipientId)).toMatchObject({ available: false, reason: 'PRIVATE_BOARD_UNAVAILABLE' });
    const document = { world_interaction: { version: 1, guide: { path: '/v1/guide.md', sha256: cidFromCanonical(guideBytes), revision: 'g' } }, official_ids: [officialId] };
    const rawBytes = utf8.encode(JSON.stringify(document));
    const proof = { house: { origin, houseKey: houseId, incarnation }, manifestDigest: cidFromCanonical(rawBytes), signedAt: 1000 };
    const core = popclaw.world.ManifestProof.encode(stripDefaultKeys(proof)).finish();
    const prefix = utf8.encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
    const signing = new Uint8Array(prefix.length + core.length); signing.set(prefix); signing.set(core, prefix.length);
    const prepared = await preparer({ origin, rawBytes, ackKeyHex: Buffer.from(house.publicKey).toString('hex'),
      proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...proof, authoritySignature: nacl.sign.detached(signing, house.secretKey) }).finish()).toString('base64'),
      provenance: 'loopback_fixture', signal: new AbortController().signal });
    f.hostDb.transaction(tx => prepared.commit(tx));
    expect(selectFirstReleasePrivateEvidence(readHouseCapabilityView(f.hostDb, origin), recipientId))
      .toMatchObject({ available: false, reason: 'PRIVATE_BOARD_UNAVAILABLE' });
  });
});

describe('offline preparation and runtime assertion', () => {
  it('prepares both tables atomically, idempotently, preserving original bytes', () => {
    const f = filesFixture();
    const first = preparePrivateMessageJournal({ executionDb: f.execDb });
    expect(first.createdTables).toEqual(['world_private_messages_v2', 'world_private_states_v2']);
    expect(first.schemaFingerprint).toBe(PRIVATE_MESSAGE_SCHEMA_FINGERPRINT);
    expect(first.originalContent['world_private_messages_v2']!.before).toBeNull();
    assertPrivateMessageJournalSchema(f.execDb);
    const binding = JSON.stringify([origin, houseId, incarnation, recipientId]);
    storeStructuredPrivateMessage(f.execDb, { binding, messageId: 'm_x', eventId: 'a'.repeat(64),
      envelopeBytes: new Uint8Array([1]), plaintextBytes: new Uint8Array([2]),
      wrapperDigest: 'b'.repeat(64), deliveryClass: 'conversation', wrapper: wrapper('r') });
    const second = preparePrivateMessageJournal({ executionDb: f.execDb });
    expect(second.createdTables).toEqual([]);
    expect(second.preservedRowCounts['world_private_messages_v2']).toBe('1');
    expect(second.originalContent['world_private_messages_v2']!.before!.contentDigest)
      .toBe(second.originalContent['world_private_messages_v2']!.after.contentDigest);
  });
  it('rolls back completely when a later table has an incompatible shape', () => {
    const f = filesFixture();
    f.execDb.execute('CREATE TABLE world_private_states_v2 (binding TEXT)');
    expect(() => preparePrivateMessageJournal({ executionDb: f.execDb })).toThrow(/PRIVATE_MESSAGE_SCHEMA_INVALID/);
    expect(f.execDb.queryOne("SELECT 1 FROM sqlite_master WHERE name='world_private_messages_v2'")).toBeNull();
  });
  it.each([
    'CREATE TABLE world_private_messages_v2 (binding TEXT NOT NULL, message_id TEXT NOT NULL, event_id TEXT NOT NULL, envelope_bytes BLOB NOT NULL, plaintext_bytes BLOB NOT NULL, envelope_digest TEXT NOT NULL, plaintext_digest TEXT NOT NULL, wrapper_digest TEXT NOT NULL, consumer_pending INTEGER NOT NULL, PRIMARY KEY(binding,message_id))',
    'CREATE TABLE world_private_messages_v2 (binding TEXT NOT NULL, message_id TEXT NOT NULL, event_id TEXT NOT NULL, envelope_bytes BLOB NOT NULL, plaintext_bytes BLOB NOT NULL, envelope_digest TEXT NOT NULL, plaintext_digest TEXT NOT NULL, wrapper_digest TEXT NOT NULL, extra TEXT, consumer_pending INTEGER NOT NULL CHECK(consumer_pending IN (0,1)), PRIMARY KEY(binding,message_id))',
  ])('rejects a tampered shape %s instead of repairing it', sql => {
    const f = filesFixture();
    preparePrivateMessageJournal({ executionDb: f.execDb });
    f.execDb.execute('DROP TABLE world_private_messages_v2');
    f.execDb.execute(sql);
    expect(() => assertPrivateMessageJournalSchema(f.execDb)).toThrow('PRIVATE_MESSAGE_SCHEMA_INVALID:world_private_messages_v2');
    expect(() => preparePrivateMessageJournal({ executionDb: f.execDb })).toThrow('PRIVATE_MESSAGE_SCHEMA_INVALID:world_private_messages_v2');
  });
  it('rejects triggers and temp-table shadows', () => {
    const f = filesFixture();
    preparePrivateMessageJournal({ executionDb: f.execDb });
    f.execDb.execute('CREATE TRIGGER private_shadow BEFORE UPDATE ON world_private_messages_v2 BEGIN SELECT 1; END');
    expect(() => assertPrivateMessageJournalSchema(f.execDb)).toThrow('PRIVATE_MESSAGE_TRIGGER_INVALID:world_private_messages_v2');
    f.execDb.execute('DROP TRIGGER private_shadow');
    f.execDb.execute('CREATE TEMP TABLE world_private_states_v2 (shadow INTEGER)');
    expect(() => assertPrivateMessageJournalSchema(f.execDb)).toThrow('PRIVATE_MESSAGE_TEMP_SHADOW:world_private_states_v2');
    f.execDb.execute('DROP TABLE temp.world_private_states_v2');
    expect(() => assertPrivateMessageJournalSchema(f.execDb)).not.toThrow();
  });
});

describe('consumer receive discriminants', () => {
  it('consumes an official encrypted structured message and durably deduplicates re-encryption', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    const firstWire = wire(JSON.stringify(wrapper(revision)));
    const first = await consumer.receiveMessage(firstWire);
    expect(first).toMatchObject({ outcome: 'consumed', messageId: 'message_1', deliveryClass: 'conversation', duplicate: false, stateStatus: 'none' });
    const binding = bindingOf(view);
    expect(readPrivateMessageRow(f.execDb, binding, 'message_1')!.consumer_pending).toBe(1);
    expect(await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision))))).toMatchObject({ outcome: 'consumed', duplicate: true });
    expect([...readPrivateMessageRow(f.execDb, binding, 'message_1')!.envelope_bytes]).toEqual([...firstWire]);
    await consumer.drain();
    expect(readPrivateMessageRow(f.execDb, binding, 'message_1')!.consumer_pending).toBe(0);
  });
  it('treats a same-id different-content wrapper as a permanent conflict', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision))));
    const conflict = await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision, { summary: 'changed' }))));
    expect(conflict).toMatchObject({ outcome: 'permanent_invalid', reason: 'MESSAGE_ID_CONFLICT' });
    const binding = bindingOf(view);
    expect(readPrivateMessageRow(f.execDb, binding, 'message_1')!.wrapper_digest).toBe(privateMessageWrapperDigest(wrapper(revision)));
  });
  it.each([
    ['unselected-kind', (revision: string) => wrapper(revision, { kind: 'mud.other' }), 'MESSAGE_KIND_UNSUPPORTED'],
    ['schema-version', (revision: string) => wrapper(revision, { schema_version: 2 }), 'MESSAGE_SCHEMA_VERSION_UNSUPPORTED'],
    ['stale-revision', () => wrapper('b'.repeat(64)), 'MESSAGE_REVISION_UNSUPPORTED'],
    ['bad-body', (revision: string) => wrapper(revision, { body: { wrong: true } }), 'MESSAGE_PARSE_PRESERVED'],
    ['participation-proposal', (revision: string) => wrapper(revision, { participation: participationDescriptor() }), 'MESSAGE_PARTICIPATION_UNSUPPORTED'],
    ['unofficial-sender', (revision: string) => wrapper(revision), 'MESSAGE_SOURCE_UNPRIVILEGED'],
    ['plaintext-dm', (revision: string) => wrapper(revision), 'MESSAGE_UNENCRYPTED'],
  ])('routes %s to the ordinary fallback with the original text and no storage', async (name, build, reason) => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    const value = build(revision);
    const raw = name === 'unofficial-sender' ? wire(JSON.stringify(value), { sender: stranger })
      : name === 'plaintext-dm' ? wire('just saying hi', { plaintext: true })
        : wire(JSON.stringify(value));
    const outcome = await consumer.receiveMessage(raw);
    expect(outcome).toMatchObject({ outcome: 'ordinary_fallback', reason });
    if (outcome.outcome === 'ordinary_fallback' && name !== 'plaintext-dm') expect(outcome.originalText).toBe(JSON.stringify(value));
    const binding = bindingOf(view);
    expect(pagePrivateMessageRows(f.execDb, binding, '', 10)).toHaveLength(0);
  });
  it.each(['signature', 'recipient', 'from', 'target', 'decrypt'])('drops %s faults permanently without rows or reconnect loops', async fault => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    const raw = wire(JSON.stringify(wrapper(revision)), { mutate(value) {
      if (fault === 'recipient') value.directMessage!.toPopclawId = recipientBId;
      if (fault === 'from') value.directMessage!.fromPopclawId = recipientId;
      if (fault === 'target') value.target!.targetIds = [recipientBId];
      if (fault === 'decrypt') value.directMessage!.ciphertext![0]! ^= 1;
    } });
    const envelope = popclaw.event.EventEnvelope.decode(raw);
    if (fault === 'signature') envelope.signature[0]! ^= 1;
    const outcome = await consumer.receiveMessage(popclaw.event.EventEnvelope.encode(envelope).finish());
    expect(outcome.outcome).toBe('permanent_invalid');
    if (outcome.outcome === 'permanent_invalid' && fault !== 'recipient') {
      const binding = bindingOf(view);
      expect(pagePrivateMessageRows(f.execDb, binding, '', 10)).toHaveLength(0);
    }
  });
  it('denies another recipient without exposing content', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumerB = makeConsumer(f, { view: () => view, recipient: recipientBSigner, recipientId: recipientBId });
    const outcome = await consumerB.receiveMessage(wire(JSON.stringify(wrapper(revision))));
    expect(outcome).toMatchObject({ outcome: 'permanent_invalid', reason: 'MESSAGE_RECIPIENT_MISMATCH' });
    expect(pagePrivateMessageRows(f.execDb, JSON.stringify([origin, houseId, incarnation, recipientBId]), '', 10)).toHaveLength(0);
  });
  it('applies monotonic state anchors and reports conflicts without losing messages', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    const state = (ref: string, rev: string, extra: Record<string, unknown> = {}) => stateWrapper(revision, { state_ref: ref, state_revision: rev, ...extra });
    expect(await consumer.receiveMessage(wire(JSON.stringify(state('state/card', '10', { message_id: 's1' })))))
      .toMatchObject({ outcome: 'consumed', stateStatus: 'new' });
    expect(await consumer.receiveMessage(wire(JSON.stringify(state('state/card', '12', { message_id: 's2', body: { text: 'second' } })))))
      .toMatchObject({ outcome: 'consumed', stateStatus: 'updated' });
    expect(await consumer.receiveMessage(wire(JSON.stringify(state('state/card', '11', { message_id: 's3', body: { text: 'third' } })))))
      .toMatchObject({ outcome: 'consumed', stateStatus: 'old' });
    expect(await consumer.receiveMessage(wire(JSON.stringify(state('state/card', '12', { message_id: 's4', body: { text: 'second' } })))))
      .toMatchObject({ outcome: 'consumed', stateStatus: 'duplicate' });
    expect(await consumer.receiveMessage(wire(JSON.stringify(state('state/card', '12', { message_id: 's5', body: { text: 'different' } })))))
      .toMatchObject({ outcome: 'consumed', stateStatus: 'conflict' });
  });
});

describe('unavailable evidence dispatch (no retryable escalation)', () => {
  it('returns ordinary fallback and permanent-invalid without structured evidence', async () => {
    const f = filesFixture();
    preparePrivateMessageJournal({ executionDb: f.execDb });
    const consumer = createPrivateMessageConsumer({ executionDb: f.execDb, gate: f.gate, assertCurrent: () => {},
      recipientId, view: () => null, recipient: recipientSigner, isOfficialActor: () => true });
    const fallback = await consumer.receiveMessage(wire('ordinary encrypted note'));
    expect(fallback).toMatchObject({ outcome: 'ordinary_fallback', reason: 'PRIVATE_BOARD_UNAVAILABLE', originalText: 'ordinary encrypted note' });
    const envelope = popclaw.event.EventEnvelope.decode(wire('broken'));
    envelope.signature[0]! ^= 1;
    expect(await consumer.receiveMessage(popclaw.event.EventEnvelope.encode(envelope).finish()))
      .toMatchObject({ outcome: 'permanent_invalid', reason: 'MESSAGE_ENVELOPE_SIGNATURE_INVALID' });
    expect(f.execDb.queryAll<{ binding: string }>('SELECT binding FROM world_private_messages_v2')).toHaveLength(0);
  });
});

describe('provisional-review adversarial cases', () => {
  it('rejects injected rows whose body receive would reject, despite recomputed digests', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    const bad = wrapper(revision, { message_id: 'injected_1', body: { wrong: true } });
    const raw = wire(JSON.stringify(bad));
    expect(await consumer.receiveMessage(raw)).toMatchObject({ outcome: 'ordinary_fallback' });
    const plaintextBytes = utf8.encode(JSON.stringify(bad));
    f.execDb.execute(`INSERT INTO world_private_messages_v2
      (binding,message_id,event_id,envelope_bytes,plaintext_bytes,envelope_digest,plaintext_digest,wrapper_digest,consumer_pending) VALUES(?,?,?,?,?,?,?,?,0)`,
      [bindingOf(view), 'injected_1', popclaw.event.EventEnvelope.decode(raw).eventId,
        Buffer.from(raw), Buffer.from(plaintextBytes), cidFromCanonical(raw), cidFromCanonical(plaintextBytes), privateMessageWrapperDigest(bad)]);
    const reader = createPrivateMessageReader({ executionDb: f.execDb, gate: f.gate, assertCurrent: () => {},
      recipientId, view: () => view, recipient: recipientSigner, isOfficialActor: () => true });
    expect(await reader.readMessage('injected_1')).toMatchObject({ status: 'invalid' });
    f.execDb.execute("UPDATE world_private_messages_v2 SET plaintext_bytes=? WHERE message_id='injected_1'",
      [Buffer.from(utf8.encode(JSON.stringify(wrapper(revision, { message_id: 'injected_1' }))))]);
    expect(await reader.readMessage('injected_1')).toMatchObject({ status: 'invalid' });
  });
  it('snapshots the caller buffer synchronously before queued serialization work', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision))));
    // A later revision unselects the kind, so the pending row drains through
    // the ordinary-fallback router — the one await that can hold the queue.
    const view2 = await installView(f.hostDb, { kinds: ['mud.other'] });
    const consumer2 = makeConsumer(f, { view: () => view2 });
    const gate = deferred();
    consumer2.setDrainRouter(() => gate.promise);
    const draining = consumer2.drain();
    const buffer = wire('SNAPSHOT-PROOF', { plaintext: true });
    const receiving = consumer2.receiveMessage(buffer);
    buffer[buffer.length - 2]! ^= 0xff;
    gate.resolve();
    await draining;
    // Mutated bytes would fail the envelope signature; the original text proves
    // the synchronous snapshot was used.
    await expect(receiving).resolves.toMatchObject({ outcome: 'ordinary_fallback', originalText: 'SNAPSHOT-PROOF' });
    await expect(consumer2.whenIdle()).resolves.toBeUndefined();
  });
  it('keeps already-durable structured material single across repeated adapter fallback failures', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    const adapter = adaptPrivateMessageConsumer(consumer, { route: () => { throw new Error('G0_INBOX_DOWN'); } });
    await adapter.receive({}, wire(JSON.stringify(wrapper(revision))), 'Official');
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(adapter.receive({}, wire('plain ordinary note'), 'Official')).rejects.toThrow('G0_INBOX_DOWN');
    }
    expect(f.execDb.queryAll<{ message_id: string }>('SELECT message_id FROM world_private_messages_v2')).toEqual([{ message_id: 'message_1' }]);
  });
  it('tracks adapter routing in whenIdle and fences new callbacks after stop', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const consumer = makeConsumer(f, { view: () => view });
    const gate = deferred();
    const routed: string[] = [];
    const adapter = adaptPrivateMessageConsumer(consumer, { route: async () => { routed.push('pending'); await gate.promise; routed.push('done'); } });
    const receiving = adapter.receive({}, wire('plain note'), 'Official');
    let idle = false;
    const quiescent = adapter.whenIdle().then(() => { idle = true; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(idle).toBe(false);
    gate.resolve();
    await receiving; await quiescent;
    expect(idle).toBe(true);
    adapter.stop();
    await expect(adapter.receive({}, wire('plain note'), 'Official')).rejects.toThrow('PRIVATE_ADAPTER_STOPPED');
  });
  it('routes drain fallbacks before completing rows and leaves failures durably pending', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision))));
    const binding = bindingOf(view);
    const view2 = await installView(f.hostDb, { kinds: ['mud.other'] });
    const consumer2 = makeConsumer(f, { view: () => view2 });
    const unrouted = await consumer2.drain();
    expect(unrouted.failures).toEqual([{ messageId: 'message_1', reason: 'PRIVATE_DRAIN_FALLBACK_UNROUTED' }]);
    expect(readPrivateMessageRow(f.execDb, binding, 'message_1')!.consumer_pending).toBe(1);
    let routeFailures = 0;
    const failing = await consumer2.drain(async () => { routeFailures++; throw new Error('ROUTE_FAILED'); });
    expect(routeFailures).toBe(1);
    expect(failing.failures).toEqual([{ messageId: 'message_1', reason: 'ROUTE_FAILED' }]);
    expect(readPrivateMessageRow(f.execDb, binding, 'message_1')!.consumer_pending).toBe(1);
    const routed: string[] = [];
    const ok = await consumer2.drain(async fallback => { routed.push(fallback.messageId); });
    expect(ok).toMatchObject({ attempted: 1, handled: 1, pending: false, fallbacks: [{ messageId: 'message_1' }] });
    expect(readPrivateMessageRow(f.execDb, binding, 'message_1')!.consumer_pending).toBe(0);
    expect(routed).toEqual(['message_1']);
  });
});

describe('currentness, storage failure and lifecycle joins', () => {
  it('prevents storage when currentness is revoked during the schema await', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    let calls = 0;
    const consumer = makeConsumer(f, { view: () => view,
      assertCurrent: () => { calls++; if (calls > 1) throw new Error('HOUSE_SESSION_CHANGED'); } });
    const outcome = await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision))));
    expect(outcome).toMatchObject({ outcome: 'retryable_storage', reason: 'HOUSE_SESSION_CHANGED' });
    expect(f.execDb.queryAll('SELECT 1 FROM world_private_messages_v2')).toHaveLength(0);
  });
  it('downgrades to fallback when official status is revoked across the await', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    let calls = 0;
    const consumer = makeConsumer(f, { view: () => view, isOfficialActor: () => ++calls <= 1 });
    const outcome = await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision))));
    expect(outcome).toMatchObject({ outcome: 'ordinary_fallback', reason: 'MESSAGE_SOURCE_UNPRIVILEGED' });
    expect(f.execDb.queryAll('SELECT 1 FROM world_private_messages_v2')).toHaveLength(0);
  });
  it('reports storage failure as retryable and recovers after restart', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision))));
    f.execDb.close();
    const failure = await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision, { message_id: 'message_2' }))));
    expect(failure).toMatchObject({ outcome: 'retryable_storage', reason: 'PRIVATE_STORAGE_FAILED' });
    const reopened = new LocalHostDb(join(f.root, 'exec.db'));
    ownedDbs.push(reopened);
    assertPrivateMessageJournalSchema(reopened);
    const consumer2 = createPrivateMessageConsumer({ executionDb: reopened, gate: f.gate, assertCurrent: () => {},
      recipientId, view: () => view, recipient: recipientSigner, isOfficialActor: () => true });
    expect(await consumer2.drain()).toMatchObject({ attempted: 1, handled: 1, pending: false });
  });
  it('stop fences queued receives and whenIdle joins them', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    const first = consumer.receiveMessage(wire(JSON.stringify(wrapper(revision, { message_id: 'stop_1' }))));
    const second = consumer.receiveMessage(wire(JSON.stringify(wrapper(revision, { message_id: 'stop_2' }))));
    consumer.stop();
    const outcomes = await Promise.all([first, second]);
    await expect(consumer.whenIdle()).resolves.toBeUndefined();
    for (const outcome of outcomes) expect(['consumed', 'retryable_storage']).toContain(outcome.outcome);
    for (const row of f.execDb.queryAll<{ message_id: string }>('SELECT message_id FROM world_private_messages_v2')) {
      expect(row.message_id).toMatch(/^stop_/);
    }
  });
  it('poll drains durable pending rows on the G0 cadence', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    await consumer.receiveMessage(wire(JSON.stringify(wrapper(revision))));
    const binding = bindingOf(view);
    expect(readPrivateMessageRow(f.execDb, binding, 'message_1')!.consumer_pending).toBe(1);
    consumer.poll();
    await vi.waitFor(() => expect(readPrivateMessageRow(f.execDb, binding, 'message_1')!.consumer_pending).toBe(0));
    await expect(consumer.whenIdle()).resolves.toBeUndefined();
  });
});

describe('bounded reader', () => {
  async function seededWorld(count: number, options: { sharedInvalidPrefix?: number } = {}) {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    preparePrivateMessageJournal({ executionDb: f.execDb });
    const binding = bindingOf(view);
    // sharedInvalidPrefix lets a caller mark the leading `sharedInvalidPrefix`
    // rows as ones it is about to invalidate by a means unrelated to per-row
    // signed content (e.g. overwriting plaintext_bytes after insert). Those rows
    // still run a full, real per-row signature verification and decryption at
    // read time — only the redundant setup-time signing of hundreds of doomed
    // rows collapses to one. Default 0 leaves every existing caller's row
    // content and signing count byte-for-byte unchanged.
    const sharedPrefix = options.sharedInvalidPrefix ?? 0;
    let shared: { raw: Uint8Array; eventId: string; plaintext: Uint8Array; digest: string; wrapper: Record<string, unknown> } | undefined;
    for (let index = 1; index <= count; index++) {
      const messageId = `m_${String(index).padStart(4, '0')}`;
      if (index <= sharedPrefix) {
        if (!shared) {
          const value = wrapper(revision, { message_id: 'shared_prefix_template', body: { text: 'shared prefix template' } });
          const raw = wire(JSON.stringify(value));
          shared = { raw, eventId: popclaw.event.EventEnvelope.decode(raw).eventId, plaintext: utf8.encode(JSON.stringify(value)),
            digest: privateMessageWrapperDigest(value), wrapper: value };
        }
        storeStructuredPrivateMessage(f.execDb, { binding, messageId, eventId: shared.eventId, envelopeBytes: shared.raw,
          plaintextBytes: shared.plaintext, wrapperDigest: shared.digest, deliveryClass: 'conversation', wrapper: shared.wrapper });
        continue;
      }
      const value = wrapper(revision, { message_id: messageId, body: { text: `hello ${index}` } });
      const raw = wire(JSON.stringify(value));
      storeStructuredPrivateMessage(f.execDb, { binding, messageId: value.message_id as string,
        eventId: popclaw.event.EventEnvelope.decode(raw).eventId, envelopeBytes: raw, plaintextBytes: utf8.encode(JSON.stringify(value)),
        wrapperDigest: privateMessageWrapperDigest(value), deliveryClass: 'conversation', wrapper: value });
    }
    const reader = createPrivateMessageReader({ executionDb: f.execDb, gate: f.gate, assertCurrent: () => {},
      recipientId, view: () => view, recipient: recipientSigner, isOfficialActor: () => true });
    return { f, view, revision, binding, reader };
  }
  it('pages a full listing with a scoped cursor and performs zero writes', async () => {
    // Row count and page `limit` are test-chosen knobs, not the production
    // LIST_LIMIT_MAX=100 constant: each returned row costs one disposable
    // schema-validation worker spawn in the reader (see
    // src/host/schema-validator.ts), so this deliberately requests a small
    // page size to span 3 pages (10 + 10 + 5, partial last page) off only 25
    // rows instead of the 150-row / limit-100 (2-page) shape this replaces,
    // while still proving the same things: >1 page, a scoped cursor carried
    // across pages, a partial final page, completeness/no-duplicates, and
    // zero writes.
    const { f, reader } = await seededWorld(25);
    const before = snapshotPrivateMessageOriginalContent(f.execDb);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await reader.list({ limit: 10, cursor });
      expect(page.status).toBe('ok');
      if (page.status !== 'ok') break;
      for (const item of page.items) seen.push(item.messageId);
      if (page.items.length) expect(page.items.reduce((sum, item) => sum + item.serializedBytes, 0)).toBeLessThanOrEqual(64 * 1024);
      cursor = page.nextCursor ?? undefined;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    await reader.readMessage('m_0001');
    await reader.readState('state/card');
    expect(snapshotPrivateMessageOriginalContent(f.execDb)).toEqual(before);
  });
  it('refuses cursors from another revision, actor, house or malformed input', async () => {
    const { reader } = await seededWorld(3);
    const page = await reader.list({ limit: 1 });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok' || page.nextCursor === null) throw new Error('UNREACHABLE');
    expect((await reader.list({ cursor: page.nextCursor })).status).toBe('ok');
    const facts = JSON.parse(page.nextCursor) as Record<string, unknown>;
    for (const mutate of [
      (value: Record<string, unknown>) => { value.capabilityRevision = 'c'.repeat(64); },
      (value: Record<string, unknown>) => { value.actorId = recipientBId; },
      (value: Record<string, unknown>) => { value.house = { origin: 'https://elsewhere.invalid', houseKey: houseId, incarnation }; },
      (value: Record<string, unknown>) => { value.profile = 'other'; },
    ]) {
      const copy = structuredClone(facts); mutate(copy);
      expect(await reader.list({ cursor: JSON.stringify(copy) })).toMatchObject({ status: 'cursor_rejected' });
    }
    expect(await reader.list({ cursor: 'not json' })).toMatchObject({ status: 'cursor_rejected', reason: 'PRIVATE_CURSOR_INVALID' });
    expect(await reader.list({ limit: 0 })).toMatchObject({ status: 'cursor_rejected', reason: 'PRIVATE_LIST_LIMIT_INVALID' });
    expect(await reader.list({ maxPageBytes: 0 })).toMatchObject({ status: 'cursor_rejected', reason: 'PRIVATE_PAGE_BUDGET_INVALID' });
  });
  it('returns an explicit item-over-budget outcome without advancing past the item', async () => {
    const { reader } = await seededWorld(1);
    const small = await reader.list({ maxPageBytes: 1 });
    if (small.status !== 'item_over_budget') throw new Error(`expected size limit, got ${small.status}`);
    expect(small.cursor).toBeNull();
    expect(small.itemBytes).toBeGreaterThan(small.budgetBytes);
    const full = await reader.list({ maxPageBytes: 64 * 1024 });
    expect(full).toMatchObject({ status: 'ok' });
    if (full.status === 'ok') expect(full.items).toHaveLength(1);
  });
  it('bounds scans to 256 rows with forward progress across invalid-only stretches', async () => {
    // Rows 1..256 get their plaintext_bytes overwritten below, so each fails
    // revalidation at the plaintext-equality check — before wrapper.message_id
    // is ever read — regardless of what content their signed envelope actually
    // held. A single shared signed template reused for those 256 ids is exactly
    // as meaningful as 256 individually signed rows for what this case proves.
    // Only ONE valid row (m_0257) follows the invalid stretch: the plan query
    // in the reader is LIMIT-256 per call, so the first list() never even looks
    // past m_0256 regardless of how many valid rows exist beyond it, and the
    // second list()'s assertions only require items.length > 0 with item[0]
    // === m_0257 — the historical 44-row valid tail exercised the reader's
    // (unasserted) ability to keep paging past one resumption, which is already
    // covered by 'pages a full listing with a scoped cursor' above.
    const { f, reader, revision } = await seededWorld(257, { sharedInvalidPrefix: 256 });
    f.execDb.execute('UPDATE world_private_messages_v2 SET plaintext_bytes=? WHERE message_id <= ?',
      [Buffer.from(utf8.encode(JSON.stringify(wrapper(revision, { body: { text: 'tampered' } })))), 'm_0256']);
    const first = await reader.list({ limit: 100 });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.scannedRows).toBeLessThanOrEqual(256);
    expect(first.truncatedByScan).toBe(true);
    expect(first.items).toHaveLength(0);
    expect(first.invalid.length).toBeGreaterThan(0);
    expect(first.nextCursor).not.toBeNull();
    const second = await reader.list({ limit: 100, cursor: first.nextCursor! });
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items[0]!.messageId).toBe('m_0257');
  });
  it('never fetches a BLOB that alone exceeds the scan-byte cap', async () => {
    const { f, binding, reader } = await seededWorld(2);
    f.execDb.execute(`INSERT INTO world_private_messages_v2
      (binding,message_id,event_id,envelope_bytes,plaintext_bytes,envelope_digest,plaintext_digest,wrapper_digest,consumer_pending)
      VALUES(?,?,?,?,?,?,?,?,1)`,
      [binding, 'm_huge', 'f'.repeat(64), Buffer.alloc(9 * 1024 * 1024, 7), Buffer.from('x'), 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
    const page = await reader.list({ limit: 10 });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') return;
    expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(page.items.map(item => item.messageId)).toEqual(['m_0001', 'm_0002']);
    expect(page.invalid).toContainEqual({ messageId: 'm_huge', reason: 'PRIVATE_ROW_OVER_SCAN_BUDGET' });
  });
  it('returns immutable copies and validates state anchors against their wrapper', async () => {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    const consumer = makeConsumer(f, { view: () => view });
    await consumer.receiveMessage(wire(JSON.stringify(stateWrapper(revision, { message_id: 'state_1' }))));
    const reader = createPrivateMessageReader({ executionDb: f.execDb, gate: f.gate, assertCurrent: () => {},
      recipientId, view: () => view, recipient: recipientSigner, isOfficialActor: () => true });
    const read = await reader.readMessage('state_1');
    if (read.status !== 'ok') throw new Error('UNREACHABLE');
    const original = [...read.message.envelopeBytes];
    read.message.envelopeBytes[0]! ^= 0xff;
    const again = await reader.readMessage('state_1');
    if (again.status !== 'ok') throw new Error('UNREACHABLE');
    expect([...again.message.envelopeBytes]).toEqual(original);
    expect(await reader.readState('state/card')).toMatchObject({ status: 'ok', state: { revision: '10', messageId: 'state_1', messageValid: true } });
    f.execDb.execute("UPDATE world_private_states_v2 SET revision='99' WHERE state_ref='state/card'");
    expect(await reader.readState('state/card')).toMatchObject({ status: 'ok', state: { revision: '99', messageValid: false, reason: 'PRIVATE_STATE_ANCHOR_MISMATCH' } });
    expect(await reader.readState('state/absent')).toMatchObject({ status: 'not_found' });
  });
  it('fences reads at currentness checks and joins through whenIdle', async () => {
    const { f, reader } = await seededWorld(4);
    let armed = false;
    const fencedGate = { origin, signal: new AbortController().signal, isActive: () => !armed };
    const fenced = createPrivateMessageReader({ executionDb: f.execDb, gate: fencedGate,
      assertCurrent: () => { if (armed) throw new Error('HOUSE_SESSION_CHANGED'); },
      recipientId, view: () => null, recipient: recipientSigner, isOfficialActor: () => true });
    expect((await fenced.list()).status).toBe('unavailable');
    armed = true;
    for (const result of [await fenced.list(), await fenced.readMessage('m_0001'), await fenced.readState('state/card')]) {
      expect(result).toMatchObject({ status: 'unavailable', reason: 'PRIVATE_READER_STOPPED' });
    }
    const page = await reader.list({ limit: 2 });
    expect(page.status).toBe('ok');
    reader.stop();
    await expect(reader.whenIdle()).resolves.toBeUndefined();
  });
});

describe('fixed-review 3d778fd corrections', () => {
  async function correctionWorld(count: number) {
    const f = filesFixture();
    const view = await installView(f.hostDb);
    const revision = view.verified.capabilityRevision;
    preparePrivateMessageJournal({ executionDb: f.execDb });
    const binding = bindingOf(view);
    for (let index = 1; index <= count; index++) {
      const value = wrapper(revision, { message_id: `m_${String(index).padStart(4, '0')}`, body: { text: `hello ${index}` } });
      const raw = wire(JSON.stringify(value));
      storeStructuredPrivateMessage(f.execDb, { binding, messageId: value.message_id as string,
        eventId: popclaw.event.EventEnvelope.decode(raw).eventId, envelopeBytes: raw, plaintextBytes: utf8.encode(JSON.stringify(value)),
        wrapperDigest: privateMessageWrapperDigest(value), deliveryClass: 'conversation', wrapper: value });
    }
    const reader = createPrivateMessageReader({ executionDb: f.execDb, gate: f.gate, assertCurrent: () => {},
      recipientId, view: () => view, recipient: recipientSigner, isOfficialActor: () => true });
    return { f, view, revision, binding, reader };
  }
  function forgedRow(f: ReturnType<typeof filesFixture>, binding: string, id: string, envelopeSize: number, plaintextSize: number) {
    f.execDb.execute(`INSERT INTO world_private_messages_v2
      (binding,message_id,event_id,envelope_bytes,plaintext_bytes,envelope_digest,plaintext_digest,wrapper_digest,consumer_pending)
      VALUES(?,?,?,?,?,?,?,?,1)`,
      [binding, id, 'f'.repeat(64), Buffer.alloc(envelopeSize, 7), Buffer.alloc(plaintextSize, 8), 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
  }
  /** Flags any full-row query that actually returns one of the forged ids. */
  function spyFullRowFetch(f: ReturnType<typeof filesFixture>, watched: string[]) {
    let materialized = false;
    const queryAll = f.execDb.queryAll.bind(f.execDb) as unknown as (sql: string, ...args: unknown[]) => unknown;
    vi.spyOn(f.execDb, 'queryAll').mockImplementation(((sql: string, ...rest: unknown[]) => {
      const rows = queryAll(sql, ...rest) as { message_id?: string }[];
      if (String(sql).includes('SELECT * FROM world_private_messages_v2') && rows.some(row => watched.includes(row.message_id!))) materialized = true;
      return rows;
    }) as unknown as typeof f.execDb.queryAll);
    const queryOne = f.execDb.queryOne.bind(f.execDb) as unknown as (sql: string, ...args: unknown[]) => unknown;
    vi.spyOn(f.execDb, 'queryOne').mockImplementation(((sql: string, ...rest: unknown[]) => {
      const row = queryOne(sql, ...rest) as { message_id?: string } | null;
      if (String(sql).includes('SELECT * FROM world_private_messages_v2') && row && watched.includes(row.message_id!)) materialized = true;
      return row;
    }) as unknown as typeof f.execDb.queryOne);
    return { get materialized() { return materialized; } };
  }

  it('keeps the COMPLETE serialized page within the requested budget', async () => {
    const { reader } = await correctionWorld(2);
    const probe = await reader.list({ limit: 1 });
    if (probe.status !== 'ok') throw new Error('UNREACHABLE');
    const skeleton = Buffer.byteLength(JSON.stringify({ status: 'ok', items: [], invalid: [], nextCursor: '', scannedRows: 0, scannedBytes: 0, truncatedByScan: false }));
    const budget = skeleton + probe.items[0]!.serializedBytes;
    const page = await reader.list({ limit: 1, maxPageBytes: budget });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(budget);
    expect(page.status).toBe('item_over_budget');
  });
  it('accounts cursor escaping, counters and notes exactly on fitting pages', async () => {
    const { reader } = await correctionWorld(5);
    const page = await reader.list({ limit: 2 });
    if (page.status !== 'ok' || page.nextCursor === null) throw new Error('UNREACHABLE');
    const exact = Buffer.byteLength(JSON.stringify(page));
    expect(exact).toBeLessThanOrEqual(64 * 1024);
    // The exact serialized size is a valid budget: the returned page fits
    // inside it (incremental decisions reserve conservatively, so it may
    // legitimately carry fewer items, never more bytes).
    const same = await reader.list({ limit: 2, maxPageBytes: exact });
    expect(same).toMatchObject({ status: 'ok' });
    if (same.status === 'ok') {
      expect(same.items.length).toBeGreaterThanOrEqual(1);
      expect(same.items[0]!.messageId).toBe('m_0001');
      expect(Buffer.byteLength(JSON.stringify(same))).toBeLessThanOrEqual(exact);
    }
  });
  it('includes invalid notes in the exact budget without losing rows', async () => {
    const { f, reader, revision } = await correctionWorld(4);
    f.execDb.execute('UPDATE world_private_messages_v2 SET plaintext_bytes=? WHERE message_id=?',
      [Buffer.from(utf8.encode(JSON.stringify(wrapper(revision, { body: { text: 'tampered' } })))), 'm_0002']);
    const page = await reader.list({ limit: 10 });
    expect(page).toMatchObject({ status: 'ok' });
    if (page.status !== 'ok') return;
    expect(page.items.map(item => item.messageId)).toEqual(['m_0001', 'm_0003', 'm_0004']);
    expect(page.invalid).toEqual([{ messageId: 'm_0002', reason: 'PRIVATE_STORED_PLAINTEXT_MISMATCH' }]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
  });
  it.each([
    ['big-first', ['a_huge']],
    ['big-middle', ['m_0001z']],
    ['multiple-big', ['a_huge', 'm_0001z', 'z_huge']],
    ['oversized-plaintext', ['a_plain']],
  ])('never materializes or hides valid rows for %s', async (name, ids) => {
    const { f, binding, reader } = await correctionWorld(2);
    for (const id of ids) {
      const envelopeSize = id === 'a_plain' ? 300 : 9 * 1024 * 1024;
      const plaintextSize = id === 'a_plain' ? 100 * 1024 : 1;
      forgedRow(f, binding, id, envelopeSize, plaintextSize);
    }
    const spy = spyFullRowFetch(f, ids);
    const page = await reader.list({ limit: 10 });
    expect(page).toMatchObject({ status: 'ok', items: [{ messageId: 'm_0001' }, { messageId: 'm_0002' }], nextCursor: null });
    if (page.status !== 'ok') return;
    expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    const reason = name === 'oversized-plaintext' ? 'PRIVATE_ROW_PLAINTEXT_OVER_SIZE' : 'PRIVATE_ROW_OVER_SCAN_BUDGET';
    expect(page.invalid).toEqual(ids.map(id => ({ messageId: id, reason })));
    expect(spy.materialized).toBe(false);
  });
  it('guards single reads against oversized envelope and plaintext BLOBs', async () => {
    const { f, binding, reader } = await correctionWorld(2);
    forgedRow(f, binding, 'a_huge', 9 * 1024 * 1024, 1);
    forgedRow(f, binding, 'a_plain', 300, 100 * 1024);
    const spy = spyFullRowFetch(f, ['a_huge', 'a_plain']);
    expect(await reader.readMessage('a_huge')).toMatchObject({ status: 'invalid', reason: 'PRIVATE_ROW_OVER_SCAN_BUDGET' });
    expect(await reader.readMessage('a_plain')).toMatchObject({ status: 'invalid', reason: 'PRIVATE_ROW_PLAINTEXT_OVER_SIZE' });
    f.execDb.execute("INSERT INTO world_private_states_v2(binding,state_ref,revision,state_digest,message_id) VALUES(?,?,?,?,?)",
      [binding, 'state/huge', '3', 'd'.repeat(64), 'a_huge']);
    expect(await reader.readState('state/huge')).toMatchObject({ status: 'ok', state: { messageValid: false, reason: 'PRIVATE_ROW_OVER_SCAN_BUDGET' } });
    expect(spy.materialized).toBe(false);
    expect(await reader.readMessage('m_0001')).toMatchObject({ status: 'ok' });
  });
  it('rechecks durable currentness after classification before routing fallback material', async () => {
    const { f, view, binding } = await correctionWorld(1);
    let revoked = false;
    const consumer = makeConsumer(f, { view: () => view,
      assertCurrent: () => { if (revoked) throw new Error('HOUSE_SESSION_CHANGED'); },
      isOfficialActor: () => { queueMicrotask(() => { revoked = true; }); return false; } });
    const route = vi.fn();
    const result = await consumer.drain(route);
    expect(route).not.toHaveBeenCalled();
    expect(result.failures).toEqual([{ messageId: 'm_0001', reason: 'HOUSE_SESSION_CHANGED' }]);
    expect(result.pending).toBe(true);
    expect(readPrivateMessageRow(f.execDb, binding, 'm_0001')!.consumer_pending).toBe(1);
  });
  it('rechecks durable currentness before returning receive fallback material', async () => {
    const { f, view } = await correctionWorld(1);
    let revoked = false;
    const consumer = makeConsumer(f, { view: () => view,
      assertCurrent: () => { if (revoked) throw new Error('HOUSE_SESSION_CHANGED'); },
      isOfficialActor: () => { queueMicrotask(() => { revoked = true; }); return false; } });
    const outcome = await consumer.receiveMessage(wire('ordinary encrypted note'));
    expect(outcome).toMatchObject({ outcome: 'retryable_storage', reason: 'HOUSE_SESSION_CHANGED' });
    expect(f.execDb.queryAll('SELECT 1 FROM world_private_messages_v2 WHERE message_id=?', ['m_0001']).length).toBe(1);
    expect(f.execDb.queryAll<{ message_id: string }>('SELECT message_id FROM world_private_messages_v2')).toEqual([{ message_id: 'm_0001' }]);
  });
  it('counts rejected metadata rows and continues beyond an oversized-only 256-row window', async () => {
    const { f, binding, reader } = await correctionWorld(1);
    f.execDb.transaction(() => {
      for (let index = 0; index < 257; index++) {
        f.execDb.execute(`INSERT INTO world_private_messages_v2
          (binding,message_id,event_id,envelope_bytes,plaintext_bytes,envelope_digest,plaintext_digest,wrapper_digest,consumer_pending)
          VALUES(?,?,?,zeroblob(1),zeroblob(65537),?,?,?,1)`,
        [binding, `a_${String(index).padStart(4, '0')}`, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)]);
      }
    });
    const spy = spyFullRowFetch(f, ['a_0000', 'a_0255', 'a_0256']);
    const first = await reader.list();
    expect(first).toMatchObject({ status: 'ok', items: [], scannedRows: 256, scannedBytes: 0, truncatedByScan: true });
    if (first.status !== 'ok' || first.nextCursor === null) throw new Error('CONTINUATION_REQUIRED');
    expect(JSON.parse(first.nextCursor).afterMessageId).toBe('a_0255');
    const second = await reader.list({ cursor: first.nextCursor });
    expect(second).toMatchObject({ status: 'ok', items: [{ messageId: 'm_0001' }], scannedRows: 2, nextCursor: null });
    expect(spy.materialized).toBe(false);
  });

  it.each(['envelope', 'plaintext'])('guards actual SQL selection when %s grows during an earlier schema await', async column => {
    const { f, view, reader } = await correctionWorld(2);
    reader.stop();
    let changed = false;
    const spy = spyFullRowFetch(f, ['m_0002']);
    const growingReader = createPrivateMessageReader({ executionDb: f.execDb, gate: f.gate, assertCurrent: () => {},
      recipientId, view: () => view, recipient: recipientSigner,
      isOfficialActor: () => {
        if (!changed) {
          changed = true;
          queueMicrotask(() => f.execDb.execute(column === 'envelope'
            ? "UPDATE world_private_messages_v2 SET envelope_bytes=zeroblob(9437184) WHERE message_id='m_0002'"
            : "UPDATE world_private_messages_v2 SET plaintext_bytes=zeroblob(65537) WHERE message_id='m_0002'"));
        }
        return true;
      } });
    const page = await growingReader.list();
    expect(page).toMatchObject({ status: 'ok', items: [{ messageId: 'm_0001' }],
      invalid: [{ messageId: 'm_0002', reason: 'PRIVATE_ROW_CHANGED_OR_MISSING' }], nextCursor: null });
    expect(spy.materialized).toBe(false);
    growingReader.stop(); await growingReader.whenIdle();
  });

  it('guards single-read SQL when a row changes after its length check', async () => {
    const { f, reader } = await correctionWorld(1);
    const queryOne = f.execDb.queryOne.bind(f.execDb) as unknown as (sql: string, ...args: unknown[]) => unknown;
    let materialized = false, changed = false;
    vi.spyOn(f.execDb, 'queryOne').mockImplementation(((sql: string, ...args: unknown[]) => {
      const row = queryOne(sql, ...args);
      if (!changed && sql.startsWith('SELECT length(envelope_bytes)')) {
        changed = true;
        f.execDb.execute("UPDATE world_private_messages_v2 SET envelope_bytes=zeroblob(9437184) WHERE message_id='m_0001'");
      }
      if (sql.includes('SELECT * FROM world_private_messages_v2') && row) materialized = true;
      return row;
    }) as unknown as typeof f.execDb.queryOne);
    expect(await reader.readMessage('m_0001')).toEqual({ status: 'not_found' });
    expect(changed).toBe(true);
    expect(materialized).toBe(false);
  });

  it.each([1, 2])('accepts an exact first-item page budget with %i stored messages', async count => {
    const { reader } = await correctionWorld(count);
    const probe = await reader.list({ limit: 1 });
    if (probe.status !== 'ok') throw new Error('UNREACHABLE');
    const exact = Buffer.byteLength(JSON.stringify(probe));
    const page = await reader.list({ limit: 1, maxPageBytes: exact });
    expect(page).toEqual(probe);
    expect(Buffer.byteLength(JSON.stringify(page))).toBe(exact);
    const tooSmall = await reader.list({ limit: 1, maxPageBytes: exact - 1 });
    expect(tooSmall).toMatchObject({ status: 'item_over_budget', budgetBytes: exact - 1, itemBytes: exact, cursor: null });
  });

  it('counts rejected fetched bytes and resumes before the row beyond the aggregate cap', async () => {
    const { f, binding, reader } = await correctionWorld(1);
    for (let index = 0; index < 9; index++) forgedRow(f, binding, `a_${index}`, 1024 * 1024, 1);
    const page = await reader.list();
    expect(page).toMatchObject({ status: 'ok', items: [], scannedRows: 8, scannedBytes: 8 * 1024 * 1024, truncatedByScan: true });
    if (page.status !== 'ok' || page.nextCursor === null) throw new Error('CONTINUATION_REQUIRED');
    expect(JSON.parse(page.nextCursor).afterMessageId).toBe('a_7');
    expect(await reader.list({ cursor: page.nextCursor })).toMatchObject({ status: 'ok', items: [{ messageId: 'm_0001' }], nextCursor: null });
  });

});
