import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { InboxStore, type NotificationState } from '../../../src/messaging/inbox-store.js';
import { encryptDmBody } from '../../../src/messaging/dm-crypto.js';
import { createWorldConversationInbox } from '../../../src/runtime/world-conversation-inbox.js';
import { assertHouseActionActive, currentActionSignal, withResourceAction } from '../../../src/runtime/house-lifecycle/action-context.js';
import { createPrivateWorldDelivery, type StructuredPrivateDeliveryMessage } from '../../../src/world/private-world-delivery.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { PrivateWorldMessages } from '../../../src/world/private-world-messages.js';
import { WorldReadiness } from '../../../src/world/world-readiness.js';
import { ScopedStreamJournal } from '../../../src/world/scoped-stream-journal.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';

const official = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
const actor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(72));
const actorId = bs58.encode(actor.publicKey), senderId = bs58.encode(official.publicKey);
const house = { origin: 'https://conversation.invalid', houseKey: senderId, incarnation: 'inc_1' };
const revision = 'a'.repeat(64), journal = 'world_conversation_inbox_v1';
const roots: string[] = [], dbs: LocalHostDb[] = [];
afterEach(() => { vi.restoreAllMocks(); dbs.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function message(overrides: Record<string, unknown> = {}): StructuredPrivateDeliveryMessage {
  const wrapper = { format: 'popclaw.world-message', version: 1, kind: 'reading.message', schema_version: 1,
    capability_revision: revision, message_id: 'message_1', conversation_ref: 'conversation_1', delivery_class: 'conversation',
    summary: 'A readable summary, not authority', body: { text: 'Private original business content' }, ...overrides };
  const originalText = JSON.stringify(wrapper);
  const envelope = popclaw.event.EventEnvelope.fromObject({ actor: { popclawId: senderId, nickname: 'Official' },
    lorehouse: house.origin, target: { scope: 1, targetIds: [actorId] }, timestamp: 1000,
    directMessage: { fromPopclawId: senderId, toPopclawId: actorId, ts: 1000, body: '[encrypted]', ...encryptDmBody(originalText, actorId, official.secretKey) } });
  const canonical = canonicalizeEnvelope(envelope);
  envelope.eventId = cidFromCanonical(canonical); envelope.signature = nacl.sign.detached(canonical, official.secretKey);
  const messageId = wrapper.message_id as string;
  return { house: { ...house }, actorId, senderId, eventId: envelope.eventId, messageId,
    idempotencyKey: JSON.stringify([house.origin, house.houseKey, house.incarnation, actorId, messageId]),
    originalText, wrapper, envelopeBytes: popclaw.event.EventEnvelope.encode(envelope).finish(),
    signal: new AbortController().signal, deliveryClass: wrapper.delivery_class as 'conversation', stateStatus: 'none' };
}
function fixture(authorizeCurrent = vi.fn((_house: popclaw.world.IHouseBinding) => {})) {
  const root = mkdtempSync(join(tmpdir(), 'world-conversation-inbox-')); roots.push(root);
  const path = join(root, 'host.db'), db = new LocalHostDb(path); dbs.push(db);
  runMigrations(db, resolve(__dirname, '../../../migrations'));
  const sink = createWorldConversationInbox({ hostDb: db, actorId, authorizeCurrent, now: () => 123456 });
  return { root, path, db, sink, authorizeCurrent, inbox: new InboxStore(db) };
}
const key = (m: StructuredPrivateDeliveryMessage) => ({ house: m.house, actorId: m.actorId, messageId: m.messageId });
function empty(db: LocalHostDb) {
  expect(db.queryAll('SELECT * FROM inbox')).toEqual([]);
  expect(db.queryAll(`SELECT * FROM ${journal}`)).toEqual([]);
  expect(db.queryAll('SELECT * FROM notification_queue')).toEqual([]);
}

describe('synchronous host-DB conversation sink', () => {
  it('stores original content atomically and renders only the summary in a silent inbox row', () => {
    const f = fixture(), m = message();
    expect(f.sink.onConversation(m)).toBeUndefined();
    const saved = f.sink.get(key(m))!;
    expect(saved).toMatchObject({ house, actorId, messageId: m.messageId, senderId, eventId: m.eventId,
      summary: m.wrapper.summary, originalText: m.originalText, receivedAtMs: 123456, wrapper: m.wrapper });
    expect([...saved.envelopeBytes]).toEqual([...m.envelopeBytes]);
    expect(f.inbox.get(saved.inboxId)).toMatchObject({ body: m.wrapper.summary, ts: 1000, fromPopclawId: senderId,
      toPopclawId: actorId, senderNickname: 'Official', notificationState: 'silent', eventId: m.eventId });
    expect(f.db.queryAll('SELECT * FROM notification_queue')).toEqual([]);
    expect(f.db.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_%'").map(row => row.name)).toEqual([journal]);
  });

  it('deduplicates retries across independent SQLite handles and preserves the first record', () => {
    const f = fixture(), m = message(); f.sink.onConversation(m);
    const other = new LocalHostDb(f.path); dbs.push(other);
    const again = createWorldConversationInbox({ hostDb: other, actorId, authorizeCurrent: () => {}, now: () => 999999 });
    again.onConversation({ ...m, stateStatus: 'duplicate', signal: new AbortController().signal });
    expect(again.get(key(m))).toEqual(f.sink.get(key(m)));
    expect(f.inbox.recent(10)).toHaveLength(1);
    expect(f.db.queryAll(`SELECT * FROM ${journal}`)).toHaveLength(1);
    expect(f.db.queryAll('SELECT * FROM notification_queue')).toEqual([]);
  });

  it('rejects conflicting same-tuple deliveries through independent handles without overwriting the winner', async () => {
    const f = fixture(), first = message(), changed = message({ body: { text: 'Changed content' } });
    const other = new LocalHostDb(f.path); dbs.push(other);
    const second = createWorldConversationInbox({ hostDb: other, actorId, authorizeCurrent: () => {} });
    const result = await Promise.allSettled([Promise.resolve().then(() => f.sink.onConversation(first)), Promise.resolve().then(() => second.onConversation(changed))]);
    expect(result[0]!.status).toBe('fulfilled'); expect(result[1]!.status).toBe('rejected');
    expect(f.sink.get(key(first))?.originalText).toBe(first.originalText);
    expect(f.inbox.recent(10)).toHaveLength(1);
  });

  it.each(['journal', 'inbox', 'settle'] as const)('rolls back both stores when %s storage fails', stage => {
    const f = fixture();
    const table = stage === 'journal' ? journal : 'inbox';
    const operation = stage === 'settle' ? 'UPDATE OF notification_state' : 'INSERT';
    f.db.execute(`CREATE TRIGGER fail_conversation BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'storage failed'); END`);
    expect(() => f.sink.onConversation(message())).toThrow('storage failed');
    empty(f.db);
  });

  it.each(['pending', 'queued', 'legacy', 'ticket', 'silent'] as const)('preserves existing %s inbox content and settled notice state', state => {
    const f = fixture(), m = message();
    const stored = f.inbox.recordReceived({ ts: 1000, fromPopclawId: senderId, toPopclawId: actorId,
      body: m.originalText, envelopeBytes: m.envelopeBytes, receivedAtMs: 42 }).item;
    if (state !== 'pending') f.inbox.settleNotification(stored.id, state as NotificationState);
    if (state === 'legacy') f.db.execute('UPDATE inbox SET event_id=NULL WHERE id=?', [stored.id]);
    if (state === 'queued') f.db.execute("INSERT INTO notification_queue(level,kind,payload_json,enqueued_at,source_message_id) VALUES('L1','existing','{}',1,?)", [stored.id]);
    const notices = f.db.queryAll('SELECT * FROM notification_queue');
    f.sink.onConversation(m);
    expect(f.sink.get(key(m))?.inboxId).toBe(stored.id);
    expect(f.inbox.recent(10)).toHaveLength(1);
    expect(f.inbox.get(stored.id)).toMatchObject({ body: m.originalText, notificationState: state === 'pending' ? 'silent' : state });
    expect(f.db.queryAll('SELECT * FROM notification_queue')).toEqual(notices);
  });

  it('checks the original resource scope inside the transaction and rejects durable logout despite a live message signal', () => {
    const f = fixture(vi.fn(binding => assertHouseActionActive(binding.origin!)));
    f.db.execute('CREATE TABLE fixture_authority (active INTEGER)'); f.db.execute('INSERT INTO fixture_authority VALUES(1)');
    const abort = new AbortController(), gate = { origin: house.origin, generation: 1, signal: abort.signal,
      isActive: () => f.db.queryOne<{ active: number }>('SELECT active FROM fixture_authority')!.active === 1 };
    const tx = f.db.transaction.bind(f.db); let depth = 0;
    vi.spyOn(f.db, 'transaction').mockImplementation(fn => tx(db => { depth++; try {return fn(db);} finally {depth--;} }));
    const depths: number[] = [];
    f.authorizeCurrent.mockImplementation(binding => { expect(currentActionSignal()).toBe(gate.signal); depths.push(depth); assertHouseActionActive(binding.origin!); });
    withResourceAction(gate, () => f.sink.onConversation(message()));
    expect(depths).toContain(0); expect(depths.filter(value => value > 0).length).toBeGreaterThanOrEqual(2);
    const before = f.db.queryAll(`SELECT * FROM ${journal}`);
    withResourceAction(gate, () => {
      f.db.execute('UPDATE fixture_authority SET active=0');
      expect(() => f.sink.onConversation(message({ message_id: 'closed' }))).toThrow('House action is no longer active');
    });
    expect(f.db.queryAll(`SELECT * FROM ${journal}`)).toEqual(before);
  });

  it('rolls back if authorization closes after inbox persistence and rejects an already-aborted signal', () => {
    const f = fixture(); let checks = 0;
    f.authorizeCurrent.mockImplementation(() => { if (++checks === 3) throw new Error('closed after write'); });
    expect(() => f.sink.onConversation(message())).toThrow('closed after write'); empty(f.db);
    const abort = new AbortController(); abort.abort(); f.authorizeCurrent.mockClear();
    expect(() => f.sink.onConversation({ ...message(), signal: abort.signal })).toThrow();
    expect(f.authorizeCurrent).not.toHaveBeenCalled(); empty(f.db);
  });

  it('captures all objects and bytes before authorization can mutate the caller and returns defensive copies', () => {
    const f = fixture(), m = message(), original = m.originalText, bytes = new Uint8Array(m.envelopeBytes), lookup = structuredClone(key(m));
    f.authorizeCurrent.mockImplementationOnce(() => { (m.wrapper as Record<string, unknown>).summary = 'mutated'; m.envelopeBytes.fill(0); m.house.origin = 'https://changed.invalid'; });
    f.sink.onConversation(m);
    const stored = f.sink.get(lookup)!;
    expect(stored.originalText).toBe(original); expect(stored.envelopeBytes).toEqual(bytes); expect(stored.summary).toBe('A readable summary, not authority');
    stored.envelopeBytes.fill(0); (stored.wrapper as Record<string, unknown>).summary = 'changed result';
    expect(f.sink.get(lookup)?.envelopeBytes).toEqual(bytes); expect(f.sink.get(lookup)?.summary).toBe('A readable summary, not authority');
  });

  it.each(['receipt', 'state'])('rejects %s outside the conversation sink', delivery_class => {
    const f = fixture(); expect(() => f.sink.onConversation(message({ delivery_class }))).toThrow(); empty(f.db);
  });

  it.each(['actor', 'sender', 'origin', 'message', 'idempotency', 'wrapper', 'cid'])('rejects mismatched %s metadata before storing', mismatch => {
    const f = fixture(), m = message();
    const bad = { ...m, house: { ...m.house } };
    if (mismatch === 'actor') bad.actorId = senderId;
    if (mismatch === 'sender') bad.senderId = actorId;
    if (mismatch === 'origin') bad.house.origin = 'https://wrong.invalid';
    if (mismatch === 'message') bad.messageId = 'different';
    if (mismatch === 'idempotency') bad.idempotencyKey = 'forged';
    if (mismatch === 'wrapper') bad.wrapper = { ...m.wrapper, summary: 'different' };
    if (mismatch === 'cid') { const envelope = popclaw.event.EventEnvelope.decode(m.envelopeBytes); envelope.eventId = 'b'.repeat(64); bad.eventId = envelope.eventId; bad.envelopeBytes = popclaw.event.EventEnvelope.encode(envelope).finish(); }
    expect(() => f.sink.onConversation(bad)).toThrow(); empty(f.db);
  });
  it('rejects asynchronous authorization and missing authority without accepting content', () => {
    const f = fixture();
    expect(() => createWorldConversationInbox({ hostDb: f.db, actorId, authorizeCurrent: undefined! })).toThrow('CONVERSATION_AUTHORITY_REQUIRED');
    const sink = createWorldConversationInbox({ hostDb: f.db, actorId, authorizeCurrent: async () => {} });
    expect(() => sink.onConversation(message())).toThrow('CONVERSATION_AUTHORIZATION_MUST_BE_SYNCHRONOUS');
    empty(f.db);
  });

  it('consumes a rejected asynchronous authority while refusing the write', async () => {
    const f = fixture();
    const sink = createWorldConversationInbox({ hostDb: f.db, actorId, authorizeCurrent: async () => { throw new Error('LATE_AUTHORITY_REJECTION'); } });
    expect(() => sink.onConversation(message())).toThrow('CONVERSATION_AUTHORIZATION_MUST_BE_SYNCHRONOUS');
    await new Promise(resolve => setImmediate(resolve));
    empty(f.db);
  });

  it('looks up only an exact full tuple and rejects unbounded keys', () => {
    const f = fixture(), m = message(); f.sink.onConversation(m);
    expect(f.sink.get({ ...key(m), house: { ...house, incarnation: 'inc_2' } })).toBeNull();
    expect(f.sink.get({ ...key(m), house: { ...house, houseKey: actorId } })).toBeNull();
    expect(f.sink.get({ ...key(m), house: { ...house, origin: 'https://other.invalid' } })).toBeNull();
    expect(() => f.sink.get({ ...key(m), messageId: 'x'.repeat(129) })).toThrow();
    expect(() => f.sink.get({ ...key(m), actorId: senderId })).toThrow();
  });

  it('retries a real verified and re-encrypted core delivery after Inbox commit without duplicating its original record', async () => {
    const f = fixture(vi.fn(binding => assertHouseActionActive(binding.origin!)));
    const houseDb = new LocalHostDb(join(f.root, 'house.db')); dbs.push(houseDb);
    const abort = new AbortController(), gate = { origin: house.origin, generation: 1, signal: abort.signal, isActive: () => !abort.signal.aborted };
    const caps: TrustedWorldCapabilities = { house, capabilityRevision: revision, guide: '', manifest: {
      world_interaction: { features: { structured_private_messages: 1 } }, official_ids: [senderId],
      event_kinds: [{ kind: 'reading.message', schema_version: 1, transport: 'house', signer: 'official',
        body_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } };
    const cache = new PrivateWorldMessages({ db: houseDb, gate, capabilities: caps, recipientId: actorId,
      recipient: new MasterKeySigner({ ...actor, seed: actor.secretKey.slice(0, 32), popclawId: actorId }), isOfficialActor: () => true });
    const stream = new ScopedStreamJournal(houseDb, house, () => { throw new Error('public stream not used'); });
    const readiness = new WorldReadiness(houseDb, house, actorId, stream);
    let callbacks = 0;
    const observed: Uint8Array[] = [];
    const delivery = createPrivateWorldDelivery({ cache, db: houseDb, gate, capabilities: caps, currentCapabilities: () => caps,
      actorId, readiness, participationIds: () => [], policyFor: () => { throw new Error('policy must not be created'); },
      onPlain: () => { throw new Error('ordinary DM must not be used'); }, retryMs: 60000,
      onConversation: m => {
        observed.push(new Uint8Array(m.envelopeBytes));
        f.sink.onConversation(m);
        if (++callbacks === 1) throw new Error('crash after committed local inbox, before core ACK');
      } });
    const first = message(), reencrypted = message();
    expect([...first.envelopeBytes]).not.toEqual([...reencrypted.envelopeBytes]);
    expect(first.originalText).toBe(reencrypted.originalText);
    try {
      expect(await withResourceAction(gate, () => delivery.receive(first.envelopeBytes))).toMatchObject({ kind: 'structured', delivery: 'pending' });
      expect(cache.pending()).toHaveLength(1); expect(f.inbox.recent(10)).toHaveLength(1);
      expect(await withResourceAction(gate, () => delivery.receive(reencrypted.envelopeBytes))).toMatchObject({ kind: 'structured', delivery: 'handled' });
      expect(callbacks).toBe(2); expect(cache.pending()).toEqual([]);
      expect(observed).toEqual([new Uint8Array(first.envelopeBytes), new Uint8Array(first.envelopeBytes)]);
      expect(f.sink.get(key(first))?.eventId).toBe(first.eventId);
      expect(f.sink.get(key(first))?.originalText).toBe(first.originalText);
      expect(f.inbox.recent(10)).toHaveLength(1);
      expect(f.db.queryAll('SELECT * FROM notification_queue')).toEqual([]);
      expect(f.db.queryAll(`SELECT * FROM ${journal}`)).toHaveLength(1);
      expect(houseDb.queryOne("SELECT name FROM sqlite_master WHERE name='inbox'")).toBeNull();
    } finally { delivery.stop(); await delivery.whenIdle(); }
  });

  it('rejects changed original ciphertext for an existing full tuple, while preserving committed content', () => {
    const f = fixture(), first = message(), second = message(); f.sink.onConversation(first);
    expect(second.originalText).toBe(first.originalText);
    expect(() => f.sink.onConversation(second)).toThrow('CONVERSATION_ID_CONFLICT');
    expect(f.sink.get(key(first))?.eventId).toBe(first.eventId); expect(f.inbox.recent(10)).toHaveLength(1);
  });

  it('rolls back when the message signal aborts during persistence', () => {
    const f = fixture(), abort = new AbortController();
    const sink = createWorldConversationInbox({ hostDb: f.db, actorId, authorizeCurrent: () => {}, now: () => { abort.abort(); return 123; } });
    expect(() => sink.onConversation({ ...message(), signal: abort.signal })).toThrow('CONVERSATION_INACTIVE'); empty(f.db);
  });

});
