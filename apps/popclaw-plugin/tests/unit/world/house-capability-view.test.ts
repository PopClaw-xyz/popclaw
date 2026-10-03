import { afterEach, describe, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical, stripDefaultKeys } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { makeWorldManifestPreparer, readHouseCapabilityView } from '../../../src/world/world-capabilities.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const origin = 'https://world.example';
const encode = (text: string) => new TextEncoder().encode(text);
const guide = encode('# Guide\n');
const stores: InMemoryHostDb[] = [];
const db = () => { const store = new InMemoryHostDb(); stores.push(store); return store; };
afterEach(() => stores.splice(0).forEach(store => store.close()));
function candidate(edit: (doc: any) => void = () => {}, signedAt = '1', serialize: (doc: any) => string = JSON.stringify) {
  const doc: any = { world_interaction: { version: 1, public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: 'log_1', initial_public_scopes: [], envelope_baseline: 'public-envelope-01' } } };
  edit(doc);
  const rawBytes = encode(serialize(doc));
  const core = { house: { origin, houseKey: bs58.encode(key.publicKey), incarnation: 'house_1' }, manifestDigest: cidFromCanonical(rawBytes), ...(signedAt === '0' ? {} : { signedAt }) };
  const bytes = popclaw.world.ManifestProof.encode(stripDefaultKeys(core)).finish();
  const prefix = encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
  const signing = new Uint8Array(prefix.length + bytes.length); signing.set(prefix); signing.set(bytes, prefix.length);
  const authoritySignature = nacl.sign.detached(signing, key.secretKey);
  return { origin, rawBytes, proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...core, authoritySignature } as any).finish()).toString('base64'), ackKeyHex: Buffer.from(key.publicKey).toString('hex'), provenance: 'configured_pin' as const, signal: new AbortController().signal };
}
function actions(doc: any) {
  doc.house_session = { version: 1, endpoint: '/v1/house-session', operations: ['enter', 'leave', 'status'], ack_pubkey: Buffer.from(key.publicKey).toString('hex') };
  doc.world_interaction.guide = { path: '/v1/guide.md', sha256: cidFromCanonical(guide), revision: '1' };
  doc.world_interaction.actions = { status_endpoint: '/v1/world-actions/status', result_authority_pubkey: bs58.encode(key.publicKey), kinds: ['booking.reserve'], attachments: [] };
  doc.intent_kinds = [{ kind: 'booking.reserve', schema_version: 1, transport: 'house', signer: 'user', description: 'Reserve a time', params_schema: { type: 'object' }, result_schema: { type: 'object' }, result_attachments: { allowed: [], required_on_success: [] }, consistency: 'none' }];
}
const prepare = makeWorldManifestPreparer({ fetch: vi.fn(async () => new Response(guide)) });
describe('first-release independent capability observations', () => {
  it('verifies public-only without a session or guide and does not claim local readiness', async () => {
    const store = db(); const fetch = vi.fn(); const input = candidate();
    store.transaction((await makeWorldManifestPreparer({ fetch })(input)).commit);
    expect(fetch).not.toHaveBeenCalled();
    const view = readHouseCapabilityView(store, origin)!;
    expect(view.publicStream).toMatchObject({ validation: 'valid', support: 'unsupported', ready: false });
    expect(view.actions.validation).toBe('absent');
    expect(view.verified.manifestBytes).toEqual(input.rawBytes);
  });
  it('keeps public facts valid when an optional action block is malformed', async () => {
    const store = db(); store.transaction((await prepare(candidate(d => { d.world_interaction.actions = {}; }))).commit);
    expect(readHouseCapabilityView(store, origin)).toMatchObject({ publicStream: { validation: 'valid' }, actions: { validation: 'invalid' } });
  });
  it('accepts a non-game action with no attachments while remaining locally unsupported', async () => {
    const store = db(); store.transaction((await prepare(candidate(actions))).commit);
    expect(readHouseCapabilityView(store, origin)?.actions.kinds['booking.reserve']).toMatchObject({ validation: 'valid', support: 'unsupported', ready: false });
  });
  it('preserves the first proof and enriches only digest-verified guide bytes on retry', async () => {
    const store = db(); const input = candidate(actions);
    store.transaction((await makeWorldManifestPreparer({ fetch: vi.fn(async () => new Response('wrong')) })(input)).commit);
    expect(readHouseCapabilityView(store, origin)?.guide.validation).toBe('invalid');
    store.transaction((await prepare(candidate(actions, '2'))).commit);
    const view = readHouseCapabilityView(store, origin)!;
    expect(view.guide.validation).toBe('valid');
    expect(view.verified.proofBytes).toEqual(new Uint8Array(Buffer.from(input.proofHeader, 'base64')));
    expect(store.queryAll('SELECT * FROM world_capability_views_v1')).toHaveLength(1);
  });
  it('still refuses the whole manifest for a raw format fault, and only for one', async () => {
    const nest = (count: number) => { let deep: unknown = 1; for (let i = 0; i < count; i++) deep = [deep]; return deep; };
    // The proof is computed over these exact bytes, so the refusal is the raw
    // parse's and not the proof's. 63 puts the scalar at raw depth 65.
    await expect(prepare(candidate(d => { d.carried = nest(63); }))).rejects.toThrow('JSON_DEPTH_LIMIT');
    await expect(prepare(candidate(actions, '1', d => JSON.stringify(d).replace('{"world_interaction"', '{"x":1,"x":2,"world_interaction"'))))
      .rejects.toThrow('JSON_DUPLICATE_OR_DANGEROUS_KEY');
    // Control: one level shallower is inside the raw bound and commits, so the
    // two above measure the bound and not merely "a deep array anywhere".
    const store = db(); store.transaction((await prepare(candidate(d => { d.carried = nest(62); }))).commit);
    expect(readHouseCapabilityView(store, origin)).toMatchObject({ publicStream: { validation: 'valid' } });
  });
  it('does not treat an invalid base proof as an optional block failure', async () => {
    const input = candidate(); input.rawBytes = encode(new TextDecoder().decode(input.rawBytes) + ' ');
    await expect(prepare(input)).rejects.toThrow('BINDING_MISMATCH');
  });
});

describe('a house that declares nothing for the world at all', () => {
  afterEach(() => setOwnerLang(undefined));
  it('names the house notice board as the cause, in more than one language, and leaves the machine code alone', async () => {
    const noWorld = candidate(d => { delete d.world_interaction; });
    setOwnerLang('en-US', 'config');
    const en = await prepare(noWorld);
    expect(en.reason).toBe(`${origin}'s own notice board declares nothing for the world here, so it does not work at this house; your account and credentials are fine, and this will not change until that house's notice board does.`);
    setOwnerLang('zh-CN', 'config');
    const zh = await prepare(candidate(d => { delete d.world_interaction; }));
    expect(zh.reason).toBe(`${origin} 自己的告示牌没有声明任何江湖内容，因此这座坊在江湖里用不了；你的账号和密钥都没有问题，这不会改变，除非那座坊的告示牌变了。`);
    expect(zh.reason).not.toBe(en.reason);
    // `revokeHouseCapabilityView` only touches a row that already exists, so
    // establish one first with an ordinary valid manifest, then disable it.
    const store = db();
    store.transaction((await prepare(candidate(actions))).commit);
    store.transaction(en.commit);
    // The stored, matchable code is the original machine detail, unaffected
    // by adding a human-readable reason next to it.
    expect(store.queryOne<{ detail: string; active: number }>('SELECT detail,active FROM world_capability_current_v1 WHERE origin=?', [origin]))
      .toEqual({ detail: 'WORLD_UNSUPPORTED', active: 0 });
  });
  it('carries no reason for an ordinary supported manifest', async () => {
    const outcome = await prepare(candidate(actions));
    expect(outcome.reason).toBeUndefined();
  });
});

it('does not validate action session support from a key-only session object', async () => {
  const store = db(); store.transaction((await prepare(candidate(d => { actions(d); d.house_session = { ack_pubkey: Buffer.from(key.publicKey).toString('hex') }; }))).commit);
  expect(readHouseCapabilityView(store, origin)?.actions).toMatchObject({ validation: 'invalid', detail: 'ACTION_AUTHORITY_INVALID' });
  expect(readHouseCapabilityView(store, origin)?.publicStream.validation).toBe('valid');
});
it('rejects a guide transport response whose final URL contradicts the same-origin request', async () => {
  const response = new Response(guide); Object.defineProperty(response, 'url', { value: 'https://foreign.invalid/v1/guide.md' });
  const store = db(); store.transaction((await makeWorldManifestPreparer({ fetch: vi.fn(async () => response) })(candidate(actions))).commit);
  expect(readHouseCapabilityView(store, origin)?.guide).toMatchObject({ validation: 'invalid', detail: 'GUIDE_REDIRECT' });
});

function privateMessages(doc: any) {
  actions(doc); delete doc.world_interaction.actions; delete doc.house_session;
  doc.official_ids = [bs58.encode(key.publicKey)];
  doc.world_interaction.private_messages = { version: 1, kinds: ['booking.notice'], participation: false };
  doc.event_kinds = [{ kind: 'booking.notice', schema_version: 1, transport: 'house', signer: 'official', description: 'Notice', body_schema: { type: 'object' } }];
}
it('validates private-only interpretation without action authority, session or model', async () => {
  const store = db(); store.transaction((await prepare(candidate(d => { privateMessages(d); delete d.world_interaction.public_stream; d.event_kinds.push({ kind: 'legacy.typed', transport: 'typed' }); }))).commit);
  expect(readHouseCapabilityView(store, origin)).toMatchObject({ publicStream: { validation: 'absent' }, actions: { validation: 'absent' }, privateMessages: { validation: 'valid', support: 'unsupported', kinds: { 'booking.notice': { validation: 'valid' } } } });
});
it.each([
  ['selected schema', (d: any) => { d.intent_kinds[1].params_schema.format = 'email'; }, 'SCHEMA_PROFILE_INVALID'],
  ['required outside allowed', (d: any) => { d.intent_kinds[1].result_attachments.required_on_success = ['snapshot']; }, 'ATTACHMENT_SET_INVALID'],
  ['undeclared attachment', (d: any) => { d.intent_kinds[1].result_attachments.allowed = ['snapshot']; }, 'ATTACHMENT_SET_INVALID'],
  ['none with subscription', (d: any) => { d.world_interaction.actions.attachments = ['subscription']; d.intent_kinds[1].result_attachments.allowed = ['subscription']; }, 'CONSISTENCY_INVALID'],
  ['stream without required subscription', (d: any) => { d.intent_kinds[1].consistency = 'stream'; }, 'PUBLIC_STREAM_REQUIRED'],
  ['barrier without snapshot', (d: any) => { d.world_interaction.actions.attachments = ['subscription']; d.intent_kinds[1].result_attachments = { allowed: ['subscription'], required_on_success: ['subscription'] }; d.intent_kinds[1].consistency = 'snapshot_barrier'; }, 'SNAPSHOT_REQUIRED'],
] as const)('isolates %s to its selected kind', async (_label, edit, detail) => {
  const store = db(); store.transaction((await prepare(candidate(d => {
    actions(d); d.intent_kinds.push({ ...structuredClone(d.intent_kinds[0]), kind: 'booking.cancel' });
    d.world_interaction.actions.kinds.push('booking.cancel'); edit(d);
  }))).commit);
  expect(readHouseCapabilityView(store, origin)?.actions.kinds).toMatchObject({ 'booking.reserve': { validation: 'valid' }, 'booking.cancel': { validation: 'invalid', detail } });
});
it('records an unverifiable attachment union without invalidating unrelated empty-attachment actions', async () => {
  const store = db(); store.transaction((await prepare(candidate(d => {
    actions(d); d.world_interaction.actions.kinds.push('booking.cancel'); d.world_interaction.actions.attachments = ['snapshot'];
    d.intent_kinds.push({ kind: 'booking.cancel' });
  }))).commit);
  expect(readHouseCapabilityView(store, origin)?.actions).toMatchObject({ validation: 'valid', attachmentUnion: 'unverifiable', unsupportedAttachments: [], kinds: { 'booking.reserve': { validation: 'valid' }, 'booking.cancel': { validation: 'invalid' } } });
});
it('reports unused attachment declarations without disabling base empty-attachment actions', async () => {
  const store = db(); store.transaction((await prepare(candidate(d => { actions(d); d.world_interaction.actions.attachments = ['snapshot']; }))).commit);
  expect(readHouseCapabilityView(store, origin)?.actions).toMatchObject({ attachmentUnion: 'mismatch', unsupportedAttachments: ['snapshot'], kinds: { 'booking.reserve': { validation: 'valid' } } });
});
it('requires a valid public block only for selected stream promises', async () => {
  const store = db(); store.transaction((await prepare(candidate(d => {
    actions(d); d.world_interaction.public_stream.endpoint = '//foreign.invalid';
    d.world_interaction.actions.attachments = ['subscription']; d.world_interaction.actions.kinds.push('booking.watch');
    d.intent_kinds.push({ ...structuredClone(d.intent_kinds[0]), kind: 'booking.watch', consistency: 'stream', result_attachments: { allowed: ['subscription'], required_on_success: ['subscription'] } });
  }))).commit);
  expect(readHouseCapabilityView(store, origin)).toMatchObject({ publicStream: { validation: 'invalid' }, actions: { kinds: { 'booking.reserve': { validation: 'valid' }, 'booking.watch': { validation: 'invalid' } } } });
});
it('ignores schemas of unrelated legacy intents and retains exact opaque facts in the manifest', async () => {
  const store = db(); const input = candidate(d => { actions(d); d.intent_kinds.push({ kind: 'ordinary.typed', params_schema: { foreign: 'schema' } }); d.opaque_fact = { retained: true }; });
  store.transaction((await prepare(input)).commit);
  expect(readHouseCapabilityView(store, origin)?.actions.kinds['booking.reserve']?.validation).toBe('valid');
  expect(readHouseCapabilityView(store, origin)?.verified.manifestBytes).toEqual(input.rawBytes);
});
it.each(['version', 'unknown', 'empty'])('retains a verified invalid %s envelope but disables its current optional board', async mode => {
  const store = db(); store.transaction((await prepare(candidate())).commit);
  const input = candidate(d => { if (mode === 'version') d.world_interaction.version = 2; else if (mode === 'unknown') d.world_interaction.old_features = {}; else d.world_interaction = { version: 1 }; });
  store.transaction((await prepare(input)).commit);
  expect(readHouseCapabilityView(store, origin)).toBeNull();
  expect(store.queryOne<any>('SELECT manifest_bytes FROM world_capability_views_v1 WHERE capability_revision=?', [cidFromCanonical(input.rawBytes)])?.manifest_bytes).toEqual(Buffer.from(input.rawBytes));
  expect(store.queryAll('SELECT * FROM world_capability_views_v1')).toHaveLength(2);
});
it('preserves historical records and deactivates their old live selection during cutover', async () => {
  const store = db();
  store.execute('CREATE TABLE world_capabilities(origin TEXT PRIMARY KEY,house_key TEXT,incarnation TEXT,manifest_bytes BLOB,proof_bytes BLOB,guide_bytes BLOB,active INTEGER,detail TEXT)');
  store.execute('INSERT INTO world_capabilities VALUES(?,?,?,?,?,?,1,?)', [origin, bs58.encode(key.publicKey), 'house_1', new Uint8Array([1,2]), new Uint8Array([3,4]), new Uint8Array([5,6]), 'old']);
  store.transaction((await prepare(candidate())).commit);
  expect(store.queryOne<any>('SELECT * FROM world_capabilities')).toMatchObject({ active: 0, manifest_bytes: Buffer.from([1,2]), proof_bytes: Buffer.from([3,4]), guide_bytes: Buffer.from([5,6]) });
});
it('rejects rollback or same-version schema changes per kind without lowering the high-water mark', async () => {
  const store = db(); store.transaction((await prepare(candidate(d => { actions(d); d.intent_kinds[0].schema_version = 2; }))).commit);
  for (const version of [1,2]) {
    store.transaction((await prepare(candidate(d => { actions(d); d.intent_kinds[0].schema_version = version; d.intent_kinds[0].params_schema.maxProperties = 1; }))).commit);
    expect(readHouseCapabilityView(store, origin)?.actions.kinds['booking.reserve']).toMatchObject({ validation: 'invalid', detail: 'SCHEMA_REVISION_CONFLICT' });
    expect(store.queryOne<any>('SELECT version FROM world_kind_revisions WHERE kind=?', ['booking.reserve'])?.version).toBe(2);
  }
});
it('preflights all selected revisions before writing any high-water mark', async () => {
  const store = db(); store.transaction((await prepare(candidate(actions))).commit);
  const prepared = await prepare(candidate(d => { actions(d); d.intent_kinds.push({ ...structuredClone(d.intent_kinds[0]), kind: 'booking.cancel' }); d.world_interaction.actions.kinds.push('booking.cancel'); }));
  const calls: string[] = [], query = store.queryOne.bind(store), execute = store.execute.bind(store);
  const qs = vi.spyOn(store, 'queryOne').mockImplementation((sql, ...args) => { if (sql.includes('SELECT version,schema_digest')) calls.push('read'); return query(sql, ...args); });
  const es = vi.spyOn(store, 'execute').mockImplementation((sql, ...args) => { if (sql.startsWith('INSERT INTO world_kind_revisions')) calls.push('write'); return execute(sql, ...args); });
  try { store.transaction(prepared.commit); } finally { qs.mockRestore(); es.mockRestore(); }
  expect(calls).toEqual(['read','read','write','write']);
});
it('rolls back observation and revision writes when current selection persistence fails', async () => {
  const store = db(); const original = candidate(actions); store.transaction((await prepare(original)).commit);
  const prepared = await prepare(candidate(d => { actions(d); d.intent_kinds[0].schema_version = 2; }));
  const execute = store.execute.bind(store);
  const fail = vi.spyOn(store, 'execute').mockImplementation((sql, ...args) => { if (sql.startsWith('INSERT INTO world_capability_current_v1')) throw new Error('DISK_FAILURE'); return execute(sql, ...args); });
  try { expect(() => store.transaction(prepared.commit)).toThrow('DISK_FAILURE'); } finally { fail.mockRestore(); }
  expect(readHouseCapabilityView(store, origin)?.verified.capabilityRevision).toBe(cidFromCanonical(original.rawBytes));
  expect(store.queryAll('SELECT * FROM world_capability_views_v1')).toHaveLength(1);
  expect(store.queryOne<any>('SELECT version FROM world_kind_revisions')?.version).toBe(1);
});
it('does not persist support or readiness and prevents mutation of retained verified bytes', async () => {
  const store = db(); const input = candidate(); store.transaction((await prepare(input)).commit);
  const view = readHouseCapabilityView(store, origin)!; view.verified.manifestBytes.fill(0); view.verified.proofBytes.fill(0);
  expect(view.verified.manifestBytes).toEqual(input.rawBytes);
  expect(readHouseCapabilityView(store, origin)?.verified.manifestBytes).toEqual(input.rawBytes);
  const json = store.queryOne<any>('SELECT validation_json FROM world_capability_current_v1').validation_json;
  expect(json).not.toContain('"support":'); expect(json).not.toContain('"ready":');
  expect(Object.isFrozen(view.publicStreamCapability?.publicStream.initial_public_scopes)).toBe(true);
});
it('cannot commit or revoke another selection after its flight is cancelled', async () => {
  const store = db(), abort = new AbortController(); const old = await prepare({ ...candidate(), signal: abort.signal });
  const current = candidate(d => { d.world_interaction.public_stream.log_incarnation = 'log_2'; });
  store.transaction((await prepare(current)).commit); abort.abort();
  expect(() => store.transaction(old.commit)).toThrow('CAPABILITY_ABORTED');
  expect(readHouseCapabilityView(store, origin)?.verified.capabilityRevision).toBe(cidFromCanonical(current.rawBytes));
});
it.each([new Response('wrong'), new Response(new Uint8Array(524289)), new Response('', { status: 503 }), new Response(new Uint8Array([255]))])('isolates unavailable or invalid guide bytes from public facts', async response => {
  const store = db(), fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response);
  store.transaction((await makeWorldManifestPreparer({ fetch })(candidate(actions))).commit);
  expect(readHouseCapabilityView(store, origin)).toMatchObject({ publicStream: { validation: 'valid' }, guide: { validation: 'invalid' }, actions: { validation: 'invalid' } });
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
});

it('whole-global backup and restore preserve both new tables while all three holds remain closed', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { LocalHostDb } = await import('../../../src/host/local-host-db.js');
  const { PopclawPaths } = await import('../../../src/host/popclaw-paths.js');
  const { createStorageBackup, restoreStorageBackup, tableFingerprint } = await import('../../../src/host/storage-backup.js');
  const { storagePathAllowed } = await import('../../../src/host/storage-maintenance.js');
  const root = mkdtempSync(join(tmpdir(), 'first-release-backup-')), source = new PopclawPaths(join(root, 'source')), destination = new PopclawPaths(join(root, 'restored'));
  const global = new LocalHostDb(source.socialDb());
  try {
    global.transaction((await prepare(candidate(actions))).commit);
    const names = ['world_capability_views_v1', 'world_capability_current_v1'];
    const fingerprints = names.map(name => tableFingerprint(global, name));
    const backup = await createStorageBackup({ paths: source, actorId: 'synthetic', installationId: 'synthetic-installation', codeVersion: 'unit-a' });
    expect(backup.manifest.files.find(file => file.path === 'vault/social/my-social-assets.db')?.tables).toMatchObject({ world_capability_views_v1: 1, world_capability_current_v1: 1 });
    await restoreStorageBackup({ backupDirectory: backup.directory, destination, operation: 'restore', expectedActorId: 'synthetic' });
    const restored = new LocalHostDb(destination.socialDb(), { readOnly: true });
    try {
      expect(names.map(name => tableFingerprint(restored, name))).toEqual(fingerprints);
      expect(readHouseCapabilityView(restored, origin)).toMatchObject({ publicStream: { validation: 'valid', ready: false, support: 'unsupported' } });
      for (const path of ['execution', 'consumers', 'notifications'] as const) expect(storagePathAllowed(destination, path)).toBe(false);
    } finally { restored.close(); }
  } finally { global.close(); rmSync(root, { recursive: true, force: true }); }
});
it('counts exact original selected schema bytes including whitespace without disabling public facts', async () => {
  const store = db();
  const input = candidate(actions, '1', doc => JSON.stringify(doc).replace('"params_schema":{', '"params_schema":{' + ' '.repeat(32768)));
  store.transaction((await prepare(input)).commit);
  expect(readHouseCapabilityView(store, origin)).toMatchObject({ publicStream: { validation: 'valid' }, actions: { kinds: { 'booking.reserve': { validation: 'invalid', detail: 'SCHEMA_SIZE_LIMIT' } } } });
  expect(readHouseCapabilityView(store, origin)?.verified.manifestBytes).toEqual(input.rawBytes);
});
it('bounds total selected schema count without interpreting unrelated rows', async () => {
  const store = db(); store.transaction((await prepare(candidate(d => {
    actions(d);
    d.intent_kinds = Array.from({ length: 32 }, (_, n) => ({ ...structuredClone(d.intent_kinds[0]), kind: `booking.action${n}` }));
    d.world_interaction.actions.kinds = d.intent_kinds.map((row: any) => row.kind);
    d.world_interaction.private_messages = { version: 1, kinds: ['booking.notice'], participation: false };
    d.official_ids = [bs58.encode(key.publicKey)];
    d.event_kinds = [{ kind: 'booking.notice', schema_version: 1, transport: 'house', signer: 'official', description: 'Notice', body_schema: { type: 'object' } }];
  }))).commit);
  const view = readHouseCapabilityView(store, origin)!;
  expect(view.publicStream.validation).toBe('valid');
  expect(Object.values(view.actions.kinds)).toHaveLength(32);
  expect(Object.values(view.actions.kinds).every(kind => kind.detail === 'SCHEMA_COUNT_LIMIT')).toBe(true);
  expect(view.privateMessages.kinds['booking.notice']?.detail).toBe('SCHEMA_COUNT_LIMIT');
});
it.each(['0', '1780000000'])('verifies original proof timestamp %s and rejects forged signature or pin', async signedAt => {
  await expect(prepare(candidate(() => {}, signedAt))).resolves.toBeDefined();
  const input = candidate(() => {}, signedAt), proof = popclaw.world.ManifestProof.decode(Buffer.from(input.proofHeader, 'base64'));
  proof.authoritySignature[0] = proof.authoritySignature[0]! ^ 1;
  await expect(prepare({ ...input, proofHeader: Buffer.from(popclaw.world.ManifestProof.encode(proof).finish()).toString('base64') })).rejects.toThrow('SIGNATURE_INVALID');
  await expect(prepare({ ...input, ackKeyHex: '00'.repeat(32) })).rejects.toThrow('BINDING_MISMATCH');
});
it('does not downgrade a broken local guide transport implementation into optional absence', async () => {
  await expect(makeWorldManifestPreparer({ fetch: vi.fn(async () => undefined as any) })(candidate(actions))).rejects.toThrow('GUIDE_TRANSPORT_RESPONSE_INVALID');
});

it.each([undefined, 'old-profile'])('does not select an absent or unsupported baseline (%s)', async baseline => {
  const store = db(); const input = candidate(d => { actions(d); d.world_interaction.public_stream.envelope_baseline = baseline; });
  store.transaction((await prepare(input)).commit);
  const view = readHouseCapabilityView(store, origin)!;
  expect(view.publicStream.validation).toBe('invalid');
  expect(view.publicStreamCapability).toBeUndefined();
  expect(view.actions.kinds['booking.reserve']!.validation).toBe('valid');
  // An old binary's cached validation cannot grant support to raw old evidence.
  const row = store.queryOne<any>('SELECT validation_json FROM world_capability_current_v1')!;
  const cached = JSON.parse(row.validation_json); cached.publicStream.validation = 'valid';
  store.execute('UPDATE world_capability_current_v1 SET validation_json=?', [JSON.stringify(cached)]);
  expect(readHouseCapabilityView(store, origin)!.publicStreamCapability).toBeUndefined();
});
