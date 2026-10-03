import { afterEach, describe, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import ed2curve from 'ed2curve';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { decryptDmBody, encryptDmBody } from '../../../src/messaging/dm-crypto.js';
import { PrivateWorldMessages, type PrivateWorldMessageOptions } from '../../../src/world/private-world-messages.js';
import * as schemas from '../../../src/world/schema-validator.js';

const official = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
const recipient = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
const stranger = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
const officialId = bs58.encode(official.publicKey);
const recipientId = bs58.encode(recipient.publicKey);
const house = { origin: 'https://house.invalid', houseKey: officialId, incarnation: 'inc_1' };
const revision = 'a'.repeat(64);
const resources: HostDb[] = [];
const directories: string[] = [];
const utf8 = new TextEncoder();

function masterSigner(pair: nacl.SignKeyPair): MasterKeySigner {
  return new MasterKeySigner({ ...pair, seed: pair.secretKey.slice(0, 32), popclawId: bs58.encode(pair.publicKey) });
}

function wrapper(extra: Record<string, unknown> = {}) {
  return { format: 'popclaw.world-message', version: 1, kind: 'mud.message', schema_version: 1,
    capability_revision: revision, message_id: 'message_1', conversation_ref: 'conversation_1',
    delivery_class: 'conversation', summary: 'Readable summary', body: { text: 'hello' }, ...extra };
}
function state(extra: Record<string, unknown> = {}) {
  return wrapper({ delivery_class: 'state', house: { origin: house.origin, house_key: house.houseKey, incarnation: house.incarnation },
    state_ref: 'state/card', state_revision: '9007199254740993', ...extra });
}
function descriptor(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, house: { origin: house.origin, house_key: house.houseKey, incarnation: house.incarnation }, actor_id: recipientId,
    participation_id: 'p_1', revision: '18446744073709551615',
    window: { id: 'window_1', opens_at: '2026-09-08T12:00:00Z', closes_at: '2026-09-08T13:00:00Z' },
    action_groups: [{ id: 'group_1', intent_kinds: ['mud.say'], control_reset: 'window', channels: ['intent', 'direct_message'] }],
    budgets: [{ id: 'budget_1', window_id: 'window_1', resource: 'agent_turn', suggested_limit: 3 }],
    opportunities: [{ id: 'opportunity_1', action_group_id: 'group_1', budget_group_id: 'budget_1', budget_window_id: 'window_1',
      not_before: '2026-09-08T12:00:00Z', expires_at: '2026-09-08T13:00:00Z', dedupe_key: 'reply_1', channels: ['intent', 'direct_message'] }],
    dm_response_slot_key: 'reply_1', ...extra };
}
function wire(text: string, options: { sender?: nacl.SignKeyPair; to?: string; plaintext?: boolean; mutate?: (value: popclaw.event.EventEnvelope) => void } = {}) {
  const sender = options.sender ?? official;
  const from = bs58.encode(sender.publicKey);
  const to = options.to ?? recipientId;
  const envelope = popclaw.event.EventEnvelope.fromObject({ actor: { popclawId: from }, target: { scope: 1, targetIds: [to] }, timestamp: '1000',
    directMessage: { fromPopclawId: from, toPopclawId: to, body: options.plaintext ? text : '[encrypted]', ts: '1000',
      ...(options.plaintext ? {} : encryptDmBody(text, to, sender.secretKey)) } });
  options.mutate?.(envelope);
  const canonical = canonicalizeEnvelope(envelope);
  envelope.eventId = cidFromCanonical(canonical);
  envelope.signature = nacl.sign.detached(canonical, sender.secretKey);
  return popclaw.event.EventEnvelope.encode(envelope).finish();
}
function fixture(overrides: Partial<PrivateWorldMessageOptions> = {}) {
  const db = new InMemoryHostDb(); resources.push(db);
  const abort = new AbortController();
  const signer = masterSigner(recipient);
  const openDm = vi.spyOn(signer, 'openDm');
  const options: PrivateWorldMessageOptions = { db, gate: { origin: house.origin, signal: abort.signal, isActive: () => !abort.signal.aborted },
    capabilities: { house, capabilityRevision: revision, guide: '', manifest: { world_interaction: { features: { structured_private_messages: 1 } }, official_ids: [officialId],
      event_kinds: [{ kind: 'mud.message', transport: 'house', schema_version: 1, signer: 'official',
        body_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } },
    recipientId, recipient: signer, isOfficialActor: () => true, ...overrides };
  return { db, abort, openDm, options, cache: new PrivateWorldMessages(options) };
}
afterEach(() => {
  vi.restoreAllMocks(); resources.splice(0).forEach(db => db.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('PrivateWorldMessages', () => {
  it.each([undefined, 0, false, true])('preserves real encrypted messages as plain without numeric feature opt-in (%s)', async flag => {
    const f = fixture();
    const caps = structuredClone(f.options.capabilities);
    caps.manifest.world_interaction = flag === undefined ? {} : { features: { structured_private_messages: flag } };
    const cache = new PrivateWorldMessages({ ...f.options, capabilities: caps });
    for (const text of ['', '\uFEFF' + JSON.stringify(wrapper()), JSON.stringify(state({ participation: descriptor() }))]) {
      expect(await cache.receive(wire(text))).toEqual({ kind: 'plain', originalText: text, reason: 'MESSAGE_FEATURE_UNAVAILABLE' });
    }
    expect(cache.pending()).toEqual([]);
  });
  it('rejects a mismatched database, house or recipient in cross-module composition', () => {
    const f = fixture(), other = fixture();
    expect(() => f.cache.assertBinding(f.db, house, recipientId)).not.toThrow();
    expect(() => f.cache.assertBinding(other.db, house, recipientId)).toThrow('MESSAGE_CACHE_BINDING_MISMATCH');
    expect(() => f.cache.assertBinding(f.db, { ...house, incarnation: 'other' }, recipientId)).toThrow('MESSAGE_CACHE_BINDING_MISMATCH');
    expect(() => f.cache.assertBinding(f.db, house, officialId)).toThrow('MESSAGE_CACHE_BINDING_MISMATCH');
  });
  it('decrypts signed official messages and persists original bytes and canonical identity', async () => {
    const f = fixture(); const text = JSON.stringify(wrapper()); const raw = wire(text);
    expect(await f.cache.receive(raw)).toMatchObject({ kind: 'structured', originalText: text, deliveryClass: 'conversation', messageStatus: 'new', stateStatus: 'none' });
    const stored = f.cache.readMessage('message_1')!;
    expect(f.cache.isPending('message_1')).toBe(true);
    expect(f.cache.isPending('absent')).toBe(false);
    expect([...stored.envelopeBytes]).toEqual([...raw]);
    expect(new TextDecoder().decode(stored.plaintextBytes)).toBe(text);
    expect(stored.wrapperDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(f.openDm).toHaveBeenCalledOnce();
  });

  it('durably deduplicates re-encryption and canonical JSON after constructing another receiver', async () => {
    const f = fixture(); const value = wrapper(); const first = wire(JSON.stringify(value));
    await f.cache.receive(first);
    const second = new PrivateWorldMessages(f.options);
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(await second.receive(wire(JSON.stringify(reordered, null, 2)))).toMatchObject({ kind: 'structured', messageStatus: 'duplicate' });
    expect([...second.readMessage('message_1')!.envelopeBytes]).toEqual([...first]);
    expect(await second.receive(wire(JSON.stringify(wrapper({ summary: 'changed' }))))).toMatchObject({ kind: 'conflict', reason: 'MESSAGE_ID_CONFLICT' });
    expect(new TextDecoder().decode(second.readMessage('message_1')!.plaintextBytes)).toBe(JSON.stringify(value));
  });

  it.each(['signature', 'cid', 'recipient', 'from', 'target', 'body', 'key', 'decrypt'])('drops %s faults before classification', async fault => {
    const f = fixture();
    const raw = wire(JSON.stringify(wrapper()), { mutate(value) {
      if (fault === 'recipient') value.directMessage!.toPopclawId = officialId;
      if (fault === 'from') value.directMessage!.fromPopclawId = recipientId;
      if (fault === 'target') value.target!.targetIds = [officialId];
      if (fault === 'body') value.houseEvent = { kind: 'mud.message' };
      if (fault === 'key') value.actor!.popclawId = 'z'.repeat(100000);
      if (fault === 'decrypt') value.directMessage!.ciphertext![0]! ^= 1;
    } });
    const envelope = popclaw.event.EventEnvelope.decode(raw);
    if (fault === 'signature') envelope.signature[0]! ^= 1;
    if (fault === 'cid') envelope.eventId = '0'.repeat(64);
    expect(await f.cache.receive(popclaw.event.EventEnvelope.encode(envelope).finish())).toMatchObject({ kind: 'dropped' });
    if (fault !== 'decrypt') expect(f.openDm).not.toHaveBeenCalled();
    expect(f.cache.readMessage('message_1')).toBeNull();
  });

  it.each(['stranger', 'other-house-official', 'policy', 'plaintext', 'house', 'version', 'revision', 'kind', 'schema'])('preserves original plaintext without privileges for %s', async fault => {
    const f = fixture(fault === 'policy' ? { isOfficialActor: () => false } : {});
    const value = wrapper();
    if (fault === 'house') Object.assign(value, { house: { origin: 'https://elsewhere.invalid', house_key: officialId, incarnation: 'inc_1' } });
    if (fault === 'version') value.version = 2;
    if (fault === 'revision') value.capability_revision = 'b'.repeat(64);
    if (fault === 'kind') value.kind = 'other.unknown';
    if (fault === 'schema') Object.assign(value, { body: { wrong: true } });
    const text = JSON.stringify(value);
    const sender = ['stranger', 'other-house-official'].includes(fault) ? stranger : official;
    expect(await f.cache.receive(wire(text, { sender, plaintext: fault === 'plaintext' }))).toMatchObject({ kind: 'plain', originalText: text });
    expect(f.cache.readMessage('message_1')).toBeNull();
  });

  it.each(['not JSON', '{"format":', '\ufeff{}', '{"a":1,"a":2}', JSON.stringify({ nested: [[[[[[[[1]]]]]]]] })])('isolates malformed text %s from its next neighbor', async text => {
    const f = fixture();
    expect(await f.cache.receive(wire(text))).toMatchObject({ kind: 'plain', originalText: text });
    expect(await f.cache.receive(wire(JSON.stringify(wrapper())))).toMatchObject({ kind: 'structured', messageStatus: 'new' });
  });

  it('retains each state identity, exact uint64 ordering, and all old authenticated messages', async () => {
    const f = fixture();
    const deliver = (extra: Record<string, unknown>) => f.cache.receive(wire(JSON.stringify(state(extra))));
    expect(await deliver({})).toMatchObject({ stateStatus: 'new' });
    expect(await deliver({ message_id: 'old', state_revision: '9007199254740992' })).toMatchObject({ stateStatus: 'old' });
    expect(await deliver({ message_id: 'newest', state_revision: '18446744073709551615' })).toMatchObject({ stateStatus: 'updated' });
    expect(await deliver({ message_id: 'equal', state_revision: '18446744073709551615' })).toMatchObject({ stateStatus: 'duplicate' });
    expect(await deliver({ message_id: 'conflict', state_revision: '18446744073709551615', body: { text: 'altered' } })).toMatchObject({ stateStatus: 'conflict' });
    expect(await deliver({ message_id: 'other', state_ref: 'state/other', state_revision: '0' })).toMatchObject({ stateStatus: 'new' });
    expect(f.cache.readState('state/card')).toEqual({ stateRef: 'state/card', revision: '18446744073709551615', messageId: 'newest' });
    expect(f.cache.readState('state/other')).toEqual({ stateRef: 'state/other', revision: '0', messageId: 'other' });
    expect(f.db.queryAll('SELECT * FROM world_private_messages_v2')).toHaveLength(6);
  });

  it.each(['18446744073709551616', '01', '-1', '1e2', 9007199254740992])('rejects noncanonical/out-of-range state revision %s', async value => {
    const f = fixture(); const text = JSON.stringify(state({ state_revision: value }));
    expect(await f.cache.receive(wire(text))).toMatchObject({ kind: 'plain', originalText: text });
    expect(f.cache.readState('state/card')).toBeNull();
  });

  it.each(['house', 'state_ref', 'state_revision'])('requires state %s outside the business body', async missing => {
    const f = fixture(); const value = state() as Record<string, unknown>;
    value.body = { [missing]: value[missing], text: 'hello' }; delete value[missing];
    expect(await f.cache.receive(wire(JSON.stringify(value)))).toMatchObject({ kind: 'plain' });
    expect(f.cache.readState('state/card')).toBeNull();
  });

  it('returns full same-house recipient-bound descriptor facts without installing policy, grants or jobs', async () => {
    const f = fixture(); const raw = wire(JSON.stringify(state({ participation: descriptor() })));
    const result = await f.cache.receive(raw);
    expect(result.kind).toBe('structured');
    if (result.kind !== 'structured') throw new Error('Expected structured message');
    expect(result.proposedParticipation?.participationId).toBe('p_1');
    expect(result.proposedParticipation?.actorId).toBe(recipientId);
    expect(result.proposedParticipation?.revision.toString()).toBe('18446744073709551615');
    expect(result.proposedParticipation?.windowOpensAt.toString()).toBe(String(Date.parse('2026-09-08T12:00:00Z') / 1000));
    const duplicate = await f.cache.receive(raw);
    expect(duplicate).toHaveProperty('proposedParticipation.participationId', 'p_1');
    expect(f.db.queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name).sort()).toEqual(['world_private_messages_v2', 'world_private_states_v2']);
  });

  it.each(['actor', 'house', 'revision', 'date', 'window', 'opportunity-time', 'group', 'budget', 'slot', 'duplicate'])('rejects descriptor %s binding or semantics', async fault => {
    const f = fixture(); const value = descriptor();
    if (fault === 'actor') value.actor_id = officialId;
    if (fault === 'house') value.house = { origin: 'https://other.invalid', house_key: officialId, incarnation: 'inc_1' };
    if (fault === 'revision') value.revision = '18446744073709551616';
    const window = value.window as Record<string, unknown>;
    const opportunities = value.opportunities as Record<string, unknown>[];
    if (fault === 'date') window.opens_at = '2026-02-30T12:00:00Z';
    if (fault === 'window') window.opens_at = window.closes_at;
    if (fault === 'opportunity-time') opportunities[0]!.expires_at = '2026-09-08T13:00:01Z';
    if (fault === 'group') opportunities[0]!.action_group_id = 'unknown';
    if (fault === 'budget') opportunities[0]!.budget_window_id = 'other_window';
    if (fault === 'slot') opportunities[0]!.dedupe_key = 'bypass';
    if (fault === 'duplicate') opportunities.push({ ...opportunities[0] });
    expect(await f.cache.receive(wire(JSON.stringify(state({ participation: value }))))).toMatchObject({ kind: 'plain' });
    expect(f.cache.readMessage('message_1')).toBeNull();
  });

  it('keeps receipt and state classification explicit without adding notification or success authority', async () => {
    const f = fixture();
    for (const deliveryClass of ['receipt', 'state']) {
      const value = deliveryClass === 'state' ? state({ message_id: 'state' }) : wrapper({ message_id: 'receipt', delivery_class: deliveryClass, summary: 'Action succeeded; notify immediately' });
      const result = await f.cache.receive(wire(JSON.stringify(value)));
      expect(result).toMatchObject({ kind: 'structured', deliveryClass });
      expect(result).not.toHaveProperty('actionSuccess'); expect(result).not.toHaveProperty('notify');
    }
  });

  it('drops logout during real schema-worker validation without persisting or returning privileges', async () => {
    const f = fixture(); const realValidate = schemas.validateWorldPayload;
    vi.spyOn(schemas, 'validateWorldPayload').mockImplementation((schema, bytes, options) => {
      const pending = realValidate(schema, bytes, options);
      f.abort.abort(); return pending;
    });
    expect(await f.cache.receive(wire(JSON.stringify(wrapper())))).toEqual({ kind: 'dropped', reason: 'HOUSE_GATE_CLOSED' });
    expect(f.cache.readMessage('message_1')).toBeNull();
  });

  it('checks isActive again even without AbortSignal cancellation', async () => {
    let active = true; const abort = new AbortController();
    const f = fixture({ gate: { origin: house.origin, signal: abort.signal, isActive: () => active } });
    const realValidate = schemas.validateWorldPayload;
    vi.spyOn(schemas, 'validateWorldPayload').mockImplementation(async (...args) => { await realValidate(...args); active = false; });
    expect(await f.cache.receive(wire(JSON.stringify(wrapper())))).toEqual({ kind: 'dropped', reason: 'HOUSE_GATE_CLOSED' });
    expect(f.cache.readMessage('message_1')).toBeNull();
  });

  it('captures manifest and envelope inputs across an awaited schema validation', async () => {
    const f = fixture(); const raw = wire(JSON.stringify(wrapper())); const original = new Uint8Array(raw);
    const realValidate = schemas.validateWorldPayload;
    vi.spyOn(schemas, 'validateWorldPayload').mockImplementation(async (...args) => {
      f.options.capabilities.manifest.official_ids = []; raw.fill(0); await realValidate(...args);
    });
    expect(await f.cache.receive(raw)).toMatchObject({ kind: 'structured' });
    expect([...f.cache.readMessage('message_1')!.envelopeBytes]).toEqual([...original]);
  });

  it('rechecks a changed local official policy after schema validation', async () => {
    let authorized = true; const f = fixture({ isOfficialActor: () => authorized });
    const realValidate = schemas.validateWorldPayload;
    vi.spyOn(schemas, 'validateWorldPayload').mockImplementation(async (...args) => { await realValidate(...args); authorized = false; });
    expect(await f.cache.receive(wire(JSON.stringify(wrapper())))).toMatchObject({ kind: 'plain', reason: 'MESSAGE_SOURCE_UNPRIVILEGED' });
    expect(f.cache.readMessage('message_1')).toBeNull();
  });

  it('deduplicates across a closed and reopened SQLite database', async () => {
    const f = fixture(); const directory = mkdtempSync(join(tmpdir(), 'private-world-messages-')); directories.push(directory);
    const path = join(directory, 'messages.sqlite');
    const first = new LocalHostDb(path); resources.push(first);
    const raw = wire(JSON.stringify(state()));
    await new PrivateWorldMessages({ ...f.options, db: first }).receive(raw); first.close();
    const reopened = new LocalHostDb(path); resources.push(reopened);
    const cache = new PrivateWorldMessages({ ...f.options, db: reopened });
    expect(await cache.receive(wire(JSON.stringify(state())))).toMatchObject({ kind: 'structured', messageStatus: 'duplicate' });
    expect([...cache.readMessage('message_1')!.envelopeBytes]).toEqual([...raw]);
    expect(cache.readState('state/card')?.revision).toBe('9007199254740993');
  });

  it('rejects envelope and plaintext size excess before classification and supports a legacy string-only signer', async () => {
    const f = fixture();
    expect(await f.cache.receive(new Uint8Array(1572865))).toMatchObject({ kind: 'dropped' });
    expect(f.openDm).not.toHaveBeenCalled();
    const text = JSON.stringify(wrapper({ summary: 'x'.repeat(66000) }));
    expect(await f.cache.receive(wire(text))).toMatchObject({ kind: 'plain', originalText: text });
    const legacy = new PrivateWorldMessages({ ...f.options, recipient: { openDm(sealed, from) {
      const result = decryptDmBody(sealed, from, recipient.secretKey);
      return result.ok ? { ok: true, plaintext: result.plaintext } : result;
    } } });
    expect(await legacy.receive(wire(JSON.stringify(wrapper())))).toMatchObject({ kind: 'plain', reason: 'MESSAGE_STRICT_BYTES_UNAVAILABLE' });
    expect(f.cache.readMessage('message_1')).toBeNull();
    expect(utf8.encode(text).length).toBeGreaterThan(65536);
  });

  it('does not repair an authenticated invalid UTF-8 wrapper into privileged JSON', async () => {
    const f = fixture();
    const bytes = utf8.encode(JSON.stringify(wrapper({ body: { text: 'x' } })));
    const textOffset = new TextDecoder().decode(bytes).lastIndexOf('x'); bytes[textOffset] = 0xff;
    const nonce = nacl.randomBytes(24);
    const ciphertext = nacl.box(bytes, nonce, ed2curve.convertPublicKey(recipient.publicKey)!, ed2curve.convertSecretKey(official.secretKey));
    const raw = wire('unused', { mutate(value) { value.directMessage!.ciphertext = ciphertext; value.directMessage!.nonce = nonce; } });
    expect(await f.cache.receive(raw)).toMatchObject({ kind: 'plain' });
    expect(f.cache.readMessage('message_1')).toBeNull();
  });

  it('a BOM in front of an otherwise valid wrapper remains ordinary content', async () => {
    const f = fixture(); const text = '\ufeff' + JSON.stringify(wrapper());
    expect(await f.cache.receive(wire(text))).toMatchObject({ kind: 'plain', originalText: text });
    expect(f.cache.readMessage('message_1')).toBeNull();
  });

  it('serializes concurrent re-encrypted duplicates at the durable commit', async () => {
    const f = fixture(); const text = JSON.stringify(wrapper());
    const results = await Promise.all([f.cache.receive(wire(text)), f.cache.receive(wire(text))]);
    expect(results.map(result => result.kind === 'structured' ? result.messageStatus : result.kind).sort()).toEqual(['duplicate', 'new']);
    expect(f.db.queryAll('SELECT * FROM world_private_messages_v2')).toHaveLength(1);
  });

  it('rolls back a gate interruption inside the durable transaction', async () => {
    let active = true; const abort = new AbortController();
    const f = fixture({ gate: { origin: house.origin, signal: abort.signal, isActive: () => active } });
    const execute = f.db.execute.bind(f.db);
    vi.spyOn(f.db, 'execute').mockImplementation((sql, params) => {
      const result = execute(sql, params);
      if (sql.startsWith('INSERT INTO world_private_states_v2')) active = false;
      return result;
    });
    expect(await f.cache.receive(wire(JSON.stringify(state())))).toEqual({ kind: 'dropped', reason: 'HOUSE_GATE_CLOSED' });
    expect(f.cache.readMessage('message_1')).toBeNull(); expect(f.cache.readState('state/card')).toBeNull();
  });

  it('uses the complete house binding in the durable message identity', async () => {
    const f = fixture(); const raw = wire(JSON.stringify(wrapper()));
    await f.cache.receive(raw);
    const caps = structuredClone(f.options.capabilities); caps.house.incarnation = 'inc_2';
    const nextHouse = new PrivateWorldMessages({ ...f.options, capabilities: caps });
    expect(await nextHouse.receive(raw)).toMatchObject({ kind: 'structured', messageStatus: 'new' });
    expect(f.db.queryAll('SELECT * FROM world_private_messages_v2')).toHaveLength(2);
  });

  it('isolates all private reads, state revisions and acknowledgements by local recipient in a shared database', async () => {
    const alice = fixture(); const bobId = bs58.encode(stranger.publicKey);
    const bob = new PrivateWorldMessages({ ...alice.options, recipientId: bobId, recipient: masterSigner(stranger) });
    const aliceRaw = wire(JSON.stringify(state({ body: { text: 'Alice private card' } })));
    await alice.cache.receive(aliceRaw);
    expect(bob.readMessage('message_1')).toBeNull(); expect(bob.readState('state/card')).toBeNull();
    expect(bob.pending()).toEqual([]); expect(bob.markHandled('message_1')).toBe(false);
    expect(await bob.receive(aliceRaw)).toMatchObject({ kind: 'dropped' });
    expect(await bob.receive(wire(JSON.stringify(state({ state_revision: '1', body: { text: 'Bob private card' } })), { to: bobId })))
      .toMatchObject({ kind: 'structured', messageStatus: 'new', stateStatus: 'new' });
    expect(bob.readState('state/card')?.revision).toBe('1');
    expect(alice.cache.readState('state/card')?.revision).toBe('9007199254740993');
    expect(new TextDecoder().decode(bob.readMessage('message_1')!.plaintextBytes)).toContain('Bob private card');
    expect(bob.markHandled('message_1')).toBe(true); expect(bob.pending()).toEqual([]);
    expect(alice.cache.pending()).toHaveLength(1);
  });

  it('reports authenticated SQLite failures as retryable storage failures, never ordinary text', async () => {
    const f = fixture(); await f.cache.receive(wire(JSON.stringify(state())));
    f.db.execute("CREATE TRIGGER fail_private BEFORE INSERT ON world_private_messages_v2 BEGIN SELECT RAISE(ABORT,'disk-fault'); END");
    const raw = wire(JSON.stringify(state({ message_id: 'disk_failure', state_revision: '9007199254740994' })));
    const result = await f.cache.receive(raw);
    expect(result).toEqual({ kind: 'storage_failed', reason: 'MESSAGE_STORAGE_FAILED', retryable: true, messageId: 'disk_failure', eventId: popclaw.event.EventEnvelope.decode(raw).eventId });
    expect(result).not.toHaveProperty('originalText'); expect(f.cache.readMessage('disk_failure')).toBeNull();
    expect(f.cache.readState('state/card')?.revision).toBe('9007199254740993');
    f.db.execute('DROP TRIGGER fail_private');
    expect(await f.cache.receive(raw)).toMatchObject({ kind: 'structured', messageStatus: 'new', stateStatus: 'updated' });
    expect(f.cache.pending().map(row => row.messageId)).toEqual(['disk_failure', 'message_1']);
  });

  it('durably recovers unhandled descriptors after close/reopen and never rearms acknowledged duplicates', async () => {
    const f = fixture(); const directory = mkdtempSync(join(tmpdir(), 'private-world-pending-')); directories.push(directory);
    const path = join(directory, 'messages.sqlite');
    const first = new LocalHostDb(path); resources.push(first);
    const raw = wire(JSON.stringify(state({ participation: descriptor() })));
    const initial = new PrivateWorldMessages({ ...f.options, db: first });
    expect(await initial.receive(raw)).toHaveProperty('proposedParticipation.participationId', 'p_1');
    expect(initial.pending()[0]?.messageId).toBe('message_1'); first.close();
    const reopened = new LocalHostDb(path); resources.push(reopened);
    const recovered = new PrivateWorldMessages({ ...f.options, db: reopened });
    const pending = recovered.pending(); expect(pending).toHaveLength(1);
    expect([...pending[0]!.envelopeBytes]).toEqual([...raw]);
    const replay = await recovered.receive(pending[0]!.envelopeBytes);
    expect(replay).toMatchObject({ kind: 'structured', messageStatus: 'duplicate', proposedParticipation: { participationId: 'p_1', actorId: recipientId } });
    expect(recovered.pending()).toHaveLength(1); // A failed downstream handler has not acknowledged anything.
    expect(recovered.markHandled('message_1')).toBe(true); expect(recovered.markHandled('message_1')).toBe(false);
    expect(recovered.pending()).toEqual([]);
    expect(await recovered.receive(wire(JSON.stringify(state({ participation: descriptor() }))))).toMatchObject({ kind: 'structured', messageStatus: 'duplicate' });
    expect(recovered.pending()).toEqual([]); reopened.close();
    const third = new LocalHostDb(path); resources.push(third);
    expect(new PrivateWorldMessages({ ...f.options, db: third }).pending()).toEqual([]);
  });

  it('revalidates pending original envelopes under the current capabilities and local official policy', async () => {
    const f = fixture(); await f.cache.receive(wire(JSON.stringify(state({ participation: descriptor() }))));
    const caps = { ...structuredClone(f.options.capabilities), capabilityRevision: 'b'.repeat(64) };
    const changed = new PrivateWorldMessages({ ...f.options, capabilities: caps });
    expect(await changed.receive(changed.pending()[0]!.envelopeBytes)).toMatchObject({ kind: 'plain', reason: 'MESSAGE_REVISION_UNSUPPORTED' });
    const untrusted = new PrivateWorldMessages({ ...f.options, isOfficialActor: () => false });
    expect(await untrusted.receive(untrusted.pending()[0]!.envelopeBytes)).toMatchObject({ kind: 'plain', reason: 'MESSAGE_SOURCE_UNPRIVILEGED' });
    expect(f.cache.pending()).toHaveLength(1);
  });

  it('bounds and pages pending originals without clearing earlier failures', async () => {
    const f = fixture();
    for (const id of ['c', 'a', 'b']) await f.cache.receive(wire(JSON.stringify(wrapper({ message_id: id }))));
    expect(f.cache.pending(2).map(row => row.messageId)).toEqual(['a', 'b']);
    expect(f.cache.pending(2, 'b').map(row => row.messageId)).toEqual(['c']);
    f.cache.markHandled('b');
    expect(f.cache.pending(2, 'b').map(row => row.messageId)).toEqual(['c']);
    expect(f.cache.pending().map(row => row.messageId)).toEqual(['a', 'c']);
    for (const limit of [0, -1, 257, Infinity, 1.5]) expect(() => f.cache.pending(limit)).toThrow('PENDING_LIMIT_INVALID');
  });

  it('does not let a logged-out consumer acknowledge a completed handler or retrieve pending messages', async () => {
    const f = fixture(); await f.cache.receive(wire(JSON.stringify(wrapper()))); f.abort.abort();
    expect(() => f.cache.markHandled('message_1')).toThrow('HOUSE_GATE_CLOSED');
    expect(() => f.cache.pending()).toThrow('HOUSE_GATE_CLOSED');
    const active = new AbortController();
    const next = new PrivateWorldMessages({ ...f.options, gate: { origin: house.origin, signal: active.signal, isActive: () => true } });
    expect(next.pending()).toHaveLength(1);
  });

  it('rolls back acknowledgement if the captured gate closes inside its transaction', async () => {
    let active = true; const abort = new AbortController();
    const f = fixture({ gate: { origin: house.origin, signal: abort.signal, isActive: () => active } });
    await f.cache.receive(wire(JSON.stringify(wrapper())));
    const execute = f.db.execute.bind(f.db);
    vi.spyOn(f.db, 'execute').mockImplementation((sql, params) => {
      const result = execute(sql, params);
      if (sql.startsWith('UPDATE world_private_messages_v2 SET consumer_pending')) active = false;
      return result;
    });
    expect(() => f.cache.markHandled('message_1')).toThrow('HOUSE_GATE_CLOSED');
    const next = new PrivateWorldMessages({ ...f.options, gate: { origin: house.origin, signal: abort.signal, isActive: () => true } });
    expect(next.pending()).toHaveLength(1);
  });

  it('never imports recipient-unbound rows from the unreleased unsafe tables', async () => {
    const f = fixture();
    f.db.execute('CREATE TABLE world_private_messages(house TEXT, message_id TEXT, plaintext_bytes BLOB)');
    f.db.execute('CREATE TABLE world_private_states(house TEXT, state_ref TEXT, revision TEXT)');
    const oldHouse = JSON.stringify([house.origin, house.houseKey, house.incarnation]);
    f.db.execute('INSERT INTO world_private_messages VALUES(?,?,?)', [oldHouse, 'message_1', utf8.encode('another recipient secret')]);
    f.db.execute('INSERT INTO world_private_states VALUES(?,?,?)', [oldHouse, 'state/card', '18446744073709551615']);
    expect(f.cache.readMessage('message_1')).toBeNull(); expect(f.cache.readState('state/card')).toBeNull();
    expect(f.cache.pending()).toEqual([]);
    expect(await f.cache.receive(wire(JSON.stringify(state())))).toMatchObject({ kind: 'structured', messageStatus: 'new', stateStatus: 'new' });
    expect(f.cache.readState('state/card')?.revision).toBe('9007199254740993');
  });

  it('does not turn database read failures into an empty pending queue', () => {
    const f = fixture(); f.db.close();
    expect(() => f.cache.pending()).toThrow(); expect(() => f.cache.readState('state/card')).toThrow();
  });
});
