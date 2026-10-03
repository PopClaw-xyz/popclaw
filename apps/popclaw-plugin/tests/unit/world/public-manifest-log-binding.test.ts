import { afterEach, describe, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { makeWorldManifestPreparer, readHouseCapabilityView } from '../../../src/world/world-capabilities.js';

const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
const origin = 'https://manifest-log.example', houseKey = bs58.encode(key.publicKey);
const ackKeyHex = Buffer.from(key.publicKey).toString('hex');
const encode = (text: string) => new TextEncoder().encode(text);
const guide = encode('# Public log binding tests\n');
const stores: InMemoryHostDb[] = [];
const cleanup: Array<() => void> = [];
const logsTable = 'world_public_manifest_logs_v1', evidenceTable = 'world_public_manifest_log_evidence_v1';
afterEach(() => { stores.splice(0).forEach(store => store.close()); cleanup.splice(0).reverse().forEach(close => close()); });
function store() { const db = new InMemoryHostDb(); stores.push(db); return db; }
function document(log = 'log_A', baseline: unknown = 'public-envelope-01') {
  return { world_interaction: { version: 1, public_stream: {
    endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: log, initial_public_scopes: [],
    ...(baseline === undefined ? {} : { envelope_baseline: baseline }),
  } } };
}
function signed(doc: unknown) {
  const rawBytes = encode(JSON.stringify(doc)), revision = cidFromCanonical(rawBytes);
  const core = { house: { origin, houseKey, incarnation: 'server_1' }, manifestDigest: revision, signedAt: 1 };
  const coreBytes = popclaw.world.ManifestProof.encode(core).finish(), prefix = encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
  const signing = new Uint8Array([...prefix, ...coreBytes]);
  return { origin, rawBytes, proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...core,
    authoritySignature: nacl.sign.detached(signing, key.secretKey) }).finish()).toString('base64'), ackKeyHex,
  provenance: 'configured_pin' as const, signal: new AbortController().signal };
}
const prepare = makeWorldManifestPreparer({ fetch: async () => new Response(guide) });
async function observe(db: HostDb, doc: unknown) {
  const input = signed(doc); db.transaction((await prepare(input)).commit); return input;
}
function independentAndDependent(log = 'log_A', baseline: unknown = 'public-envelope-01') {
  const none = { kind: 'booking.reserve', schema_version: 1, transport: 'house', signer: 'user', description: 'Reserve',
    params_schema: { type: 'object' }, result_schema: { type: 'object' },
    result_attachments: { allowed: [] as string[], required_on_success: [] as string[] }, consistency: 'none' };
  return { ...document(log, baseline), house_session: { version: 1, endpoint: '/v1/house-session', operations: ['enter', 'leave', 'status'], ack_pubkey: ackKeyHex },
    official_ids: [houseKey], world_interaction: { ...document(log, baseline).world_interaction,
      actions: { status_endpoint: '/v1/world-actions/status', result_authority_pubkey: houseKey,
        kinds: ['booking.reserve', 'booking.watch', 'booking.join'], attachments: ['subscription', 'snapshot'] },
      private_messages: { version: 1, kinds: ['booking.notice'], participation: false },
      execution_closure: { status_endpoint: '/v1/world-actions/closure-status' },
      guide: { path: '/v1/guide.md', sha256: cidFromCanonical(guide), revision: '1' },
    }, intent_kinds: [none, { ...none, kind: 'booking.watch', consistency: 'stream',
      result_attachments: { allowed: ['subscription'], required_on_success: ['subscription'] } },
    { ...none, kind: 'booking.join', consistency: 'snapshot_barrier',
      result_attachments: { allowed: ['subscription', 'snapshot'], required_on_success: ['subscription', 'snapshot'] } }],
    event_kinds: [{ kind: 'booking.notice', schema_version: 1, transport: 'house', signer: 'official', description: 'Notice', body_schema: { type: 'object' } }],
  };
}

describe('trusted manifest log history before receiver activation', () => {
  it('retires supported A after observing unsupported B, even without a receiver', async () => {
    const db = store(), first = await observe(db, document());
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('valid');
    await observe(db, document('log_B', 'wider-baseline'));
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('invalid');
    await observe(db, document());
    expect(readHouseCapabilityView(db, origin)?.publicStream).toMatchObject({ validation: 'invalid', detail: 'PUBLIC_LOG_RETIRED' });
    expect(readHouseCapabilityView(db, origin)?.publicStreamCapability).toBeUndefined();
    await observe(db, document());
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('invalid');
    expect(new Uint8Array(db.queryOne<{manifest_bytes: Uint8Array}>('SELECT manifest_bytes FROM world_capability_views_v1 WHERE capability_revision=?', [cidFromCanonical(first.rawBytes)])!.manifest_bytes)).toEqual(first.rawBytes);
    await observe(db, document('log_C'));
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('valid');
  });

  it('latches same-log baseline conflicts through both directions and exact-manifest replay', async () => {
    const db = store(); await observe(db, document()); await observe(db, document('log_A', 'wider-baseline'));
    await observe(db, document());
    expect(readHouseCapabilityView(db, origin)?.publicStream).toMatchObject({ validation: 'invalid', detail: 'PUBLIC_LOG_BASELINE_CONFLICT' });
    expect(db.queryAll('SELECT * FROM world_capability_views_v1')).toHaveLength(2);
    const profile = db.queryOne<{baseline_key: string; conflicted: number}>(`SELECT baseline_key,conflicted FROM ${logsTable}`)!;
    expect(profile).toEqual({ baseline_key: JSON.stringify(['value', 'public-envelope-01']), conflicted: 1 });
  });

  it('accepts updated metadata on the same unchanged baseline and log', async () => {
    const db = store(), first = await observe(db, document());
    await observe(db, { ...document(), description: 'New description, same actual log' });
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('valid');
    expect(db.queryAll(`SELECT first_revision,retired,conflicted FROM ${logsTable}`))
      .toEqual([{ first_revision: cidFromCanonical(first.rawBytes), retired: 0, conflicted: 0 }]);
    expect(db.queryAll(`SELECT * FROM ${evidenceTable}`)).toHaveLength(2);
  });

  it('retains retirement across a real SQLite close and reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'manifest-log-binding-')), path = join(directory, 'social.db');
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const first = new LocalHostDb(path); cleanup.push(() => first.close());
    await observe(first, document()); await observe(first, document('log_B', 'wider-baseline')); first.close();
    const reopened = new LocalHostDb(path); cleanup.push(() => reopened.close());
    await observe(reopened, document());
    expect(readHouseCapabilityView(reopened, origin)?.publicStream).toMatchObject({ validation: 'invalid', detail: 'PUBLIC_LOG_RETIRED' });
    expect(reopened.queryAll('SELECT * FROM world_capability_views_v1')).toHaveLength(2);
  });

  it('treats missing baseline as observed metadata, not an unclaimed log', async () => {
    const db = store(), missing = document(); delete missing.world_interaction.public_stream.envelope_baseline;
    await observe(db, missing); await observe(db, document());
    expect(readHouseCapabilityView(db, origin)?.publicStream).toMatchObject({ validation: 'invalid', detail: 'PUBLIC_LOG_BASELINE_CONFLICT' });
    await observe(db, document('log_B'));
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('valid');
  });

  it.each(['block', 'board'] as const)('records a legal log inside an otherwise invalid %s', async level => {
    const db = store(); await observe(db, document());
    const bad = document('log_B', 'wider-baseline');
    if (level === 'block') bad.world_interaction.public_stream.endpoint = '//unusable.example';
    else bad.world_interaction.version = 2;
    await observe(db, bad); await observe(db, document());
    expect(readHouseCapabilityView(db, origin)?.publicStream).toMatchObject({ validation: 'invalid', detail: 'PUBLIC_LOG_RETIRED' });
  });

  it('disables public-dependent actions and closure while preserving none actions and private interpretation', async () => {
    const db = store(); await observe(db, independentAndDependent());
    expect(readHouseCapabilityView(db, origin)?.executionClosure.validation).toBe('valid');
    await observe(db, independentAndDependent('log_B', 'wider-baseline'));
    await observe(db, independentAndDependent());
    expect(readHouseCapabilityView(db, origin)).toMatchObject({ publicStream: { validation: 'invalid' },
      actions: { validation: 'valid', kinds: { 'booking.reserve': { validation: 'valid' },
        'booking.watch': { validation: 'invalid', detail: 'PUBLIC_STREAM_REQUIRED' },
        'booking.join': { validation: 'invalid', detail: 'PUBLIC_STREAM_REQUIRED' } } },
      privateMessages: { validation: 'valid', kinds: { 'booking.notice': { validation: 'valid' } } },
      executionClosure: { validation: 'invalid', detail: 'ACTIONS_REQUIRED' } });
  });

  it('does not invent logs for a public block without a legal log or an independent-only board', async () => {
    const db = store(); await observe(db, document());
    const independent = independentAndDependent();
    const board = Object.fromEntries(Object.entries(independent.world_interaction).filter(([name]) => name !== 'public_stream'));
    await observe(db, { ...independent, world_interaction: board });
    await observe(db, document('not/a/log'));
    expect(db.queryAll(`SELECT log_incarnation FROM ${logsTable}`)).toEqual([{ log_incarnation: 'log_A' }]);
    await observe(db, document());
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('valid');
  });

  it('refuses cached valid observations after binding metadata loss and requires a fresh selection', async () => {
    const db = store(); await observe(db, independentAndDependent());
    db.execute(`DROP TABLE ${evidenceTable}`); db.execute(`DROP TABLE ${logsTable}`);
    expect(readHouseCapabilityView(db, origin)).toMatchObject({ publicStream: { validation: 'invalid' },
      actions: { kinds: { 'booking.reserve': { validation: 'valid' }, 'booking.watch': { validation: 'invalid' } } },
      privateMessages: { validation: 'valid' }, executionClosure: { validation: 'invalid' } });
    await observe(db, independentAndDependent());
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('invalid');
    await observe(db, independentAndDependent('log_B'));
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('valid');
  });

  it('detects uncovered retained unsupported history before trusting a cached valid current view', async () => {
    const db = store(); await observe(db, document());
    const old = signed(document('log_B', 'wider-baseline'));
    db.execute('INSERT INTO world_capability_views_v1(origin,capability_revision,house_key,incarnation,manifest_bytes,proof_bytes,pin_provenance) VALUES(?,?,?,?,?,?,?)',
      [origin, cidFromCanonical(old.rawBytes), houseKey, 'server_1', old.rawBytes, Buffer.from(old.proofHeader, 'base64'), 'configured_pin']);
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('invalid');
    await observe(db, document('log_C'));
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('valid');
    await observe(db, document('log_B'));
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('invalid');
  });

  it('retains the previous public binding if current-selection persistence rolls back', async () => {
    const db = store(); await observe(db, document()); const next = await prepare(signed(document('log_B')));
    const execute = db.execute.bind(db), failure = vi.spyOn(db, 'execute').mockImplementation((sql, ...args) => {
      if (sql.startsWith('INSERT INTO world_capability_current_v1')) throw new Error('DISK_FAILURE'); return execute(sql, ...args);
    });
    try { expect(() => db.transaction(next.commit)).toThrow('DISK_FAILURE'); } finally { failure.mockRestore(); }
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('valid');
    expect(db.queryAll(`SELECT log_incarnation,retired FROM ${logsTable}`)).toEqual([{ log_incarnation: 'log_A', retired: 0 }]);
  });

  it('does not retire a trusted log on a manifest that fails the existing proof check', async () => {
    const db = store(); await observe(db, document()); const input = signed(document('log_B'));
    input.rawBytes = encode(JSON.stringify(document('log_C')));
    await expect(prepare(input)).rejects.toThrow('MANIFEST_PROOF_BINDING_MISMATCH');
    expect(readHouseCapabilityView(db, origin)?.publicStream.validation).toBe('valid');
    expect(db.queryAll(`SELECT log_incarnation,retired FROM ${logsTable}`)).toEqual([{ log_incarnation: 'log_A', retired: 0 }]);
  });
});
