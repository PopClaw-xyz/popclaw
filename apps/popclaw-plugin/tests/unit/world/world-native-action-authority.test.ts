import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { createOpenClawWorldExecution } from '../../../src/host/openclaw-world-execution.js';
import { WorldNativeActionAuthorityStore } from '../../../src/world/world-native-action-authority.js';
import { ACTION_SELECTION_PROFILE, type ActionSelectionEvidenceV1 } from '../../../src/world/action-client.js';
import { prepareActionReceiptJournal, ACTION_RECEIPT_SCHEMA_FINGERPRINT } from '../../../src/world/action-receipt-journal.js';
import { prepareNativeActionJournal, NATIVE_ACTION_SCHEMA_FINGERPRINT } from '../../../src/world/native-action-journal.js';
import { canonicalWorldCore, worldSigningInput } from '../../../src/world/action-wire.js';

const actor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(81));
const housePair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(82));
const actorId = bs58.encode(actor.publicKey), houseKey = bs58.encode(housePair.publicKey);
const house = { origin: 'https://native.invalid', houseKey, incarnation: 'native1' };
const utf8 = new TextEncoder(), cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-authority-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new LocalHostDb(join(root, 'execution.db')); cleanup.push(() => db.close());
  const partition = { origin: house.origin, actorId, storeId: 'native-test', layoutVersion: 1 as const };
  db.execute('CREATE TABLE execution_partition_identity_v1(singleton INTEGER PRIMARY KEY,actor_id TEXT,origin TEXT,store_id TEXT,layout_version INTEGER)');
  db.execute('INSERT INTO execution_partition_identity_v1 VALUES(1,?,?,?,1)', [actorId, house.origin, partition.storeId]);
  prepareActionReceiptJournal({ executionDb: db, expectedPartition: partition, expectedSchemaFingerprint: ACTION_RECEIPT_SCHEMA_FINGERPRINT });
  prepareNativeActionJournal({ executionDb: db, expectedPartition: partition, expectedSchemaFingerprint: NATIVE_ACTION_SCHEMA_FINGERPRINT });
  const guide = utf8.encode('A local agent can join under its configured policy.');
  const paramsSchema = { type: 'object', properties: { accept_gifts: { type: 'boolean' } }, additionalProperties: false };
  const resultSchema = { type: 'object' };
  const manifest = {
    house_session: { version: 1, endpoint: '/v1/house-session', ack_pubkey: Buffer.from(housePair.publicKey).toString('hex'), operations: ['enter', 'renew', 'leave'] },
    world_interaction: { version: 1, actions: { status_endpoint: '/v1/world-actions/status', result_authority_pubkey: houseKey, kinds: ['train.join'], attachments: [] },
      guide: { path: '/v1/guide.md', sha256: cidFromCanonical(guide), revision: 'guide1' } },
    intent_kinds: [{ kind: 'train.join', schema_version: 1, transport: 'house', signer: 'user', description: 'Join',
      result_attachments: { allowed: [], required_on_success: [] }, consistency: 'none', params_schema: paramsSchema, result_schema: resultSchema }],
  };
  const manifestBytes = utf8.encode(JSON.stringify(manifest)), capabilityRevision = cidFromCanonical(manifestBytes);
  const proofCore = { house, manifestDigest: capabilityRevision, signedAt: 900 };
  const evidence: ActionSelectionEvidenceV1 = { profile: ACTION_SELECTION_PROFILE, house, actorId, capabilityRevision, kind: 'train.join', schemaVersion: 1,
    resultAuthorityKey: houseKey, manifestBytes, proofBytes: canonicalWorldCore(popclaw.world.ManifestProof, { ...proofCore,
      authoritySignature: nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1', canonicalWorldCore(popclaw.world.ManifestProof, proofCore)), housePair.secretKey) }),
    guideBytes: guide, guideDigest: cidFromCanonical(guide), paramsSchema, resultSchema, allowed: [], requiredOnSuccess: [], consistency: 'none' };
  const now = 1000, hostConfig = { plugins: { entries: { popclaw: { config: { worldExecution: { policies: [{
    agentId: 'main', actorId, house: house.origin, houseKey, kinds: ['train.join'],
    authorizedAt: new Date(900_000).toISOString().replace('.000Z', 'Z'), expiresAt: new Date(2000_000).toISOString().replace('.000Z', 'Z'),
  }] } } } } } };
  const adapter = createOpenClawWorldExecution({ actorId, readActiveConfig: () => hostConfig, now: () => now });
  const store = new WorldNativeActionAuthorityStore({ db, house, actorId, expectedPartition: partition, now: () => now,
    captureSelectedActionContext: () => ({ evidence, assertCurrent() {} }), assertPermit: adapter.assertPermit });
  const bound = adapter.bindFactory({ agentId: 'main', getRuntimeConfig: () => hostConfig });
  const input = { house: house.origin, kind: 'train.join', params: {}, expected_capability_revision: capabilityRevision };
  return { db, store, adapter, bound, input };
}
describe('native policy reservation ledger', () => {
  it('records native provenance and exact input without creating manual history or reusable authority', async () => {
    const f = fixture(); let saved!: ReturnType<typeof f.store.reserve>;
    await f.bound.withInvocation('join', f.input, undefined, async permit => {
      saved = f.store.reserve(permit); const again = f.store.reserve(permit);
      expect(again.reservationId).toBe(saved.reservationId);
      expect(saved.executionReference).toEqual({ kind: 'native_policy', reservationId: saved.reservationId });
      saved.check({ kind: 'train.join', validUntil: 1300 });
      f.db.transaction(tx => saved.record(tx, 'a'.repeat(64)));
      expect(() => f.db.transaction(tx => saved.record(tx, 'b'.repeat(64)))).toThrow('ACTION_AUTHORITY_REQUEST_MISMATCH');
      expect(() => saved.assertInput({ ...f.input, params: { accept_gifts: true } })).toThrow('NATIVE_ACTION_INPUT_MISMATCH');
      const row = f.db.queryOne<{principal_json:string;policy_source_json:string;input_json:string}>('SELECT * FROM world_native_action_reservations')!;
      expect(JSON.parse(row.principal_json)).toMatchObject({ actorId, agentId: 'main' });
      expect(JSON.parse(row.policy_source_json).path).toBe('plugins.entries.popclaw.config.worldExecution');
      expect(JSON.parse(row.input_json)).toEqual(f.input);
    });
    expect(() => saved.check({ kind: 'train.join', validUntil: 1300 })).toThrow('NATIVE_AUTHORITY_INACTIVE');
    expect(f.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  });
  it('rejects changed durable provenance before request recording', async () => {
    const f = fixture();
    await f.bound.withInvocation('join', f.input, undefined, async permit => {
      const authority = f.store.reserve(permit);
      f.db.execute("UPDATE world_native_action_reservations SET policy_revision=?", ['f'.repeat(64)]);
      expect(() => f.db.transaction(tx => authority.record(tx, 'a'.repeat(64)))).toThrow('NATIVE_ACTION_PROVENANCE_CHANGED');
    });
  });
  it('does not accept a JSON copy as a live permit', async () => {
    const f = fixture();
    await f.bound.withInvocation('join', f.input, undefined, async permit => {
      expect(() => f.store.reserve({ ...permit })).toThrow('NATIVE_AUTHORITY_REQUIRED');
      f.store.reserve(permit);
    });
  });
  it('rejects a persisted future reservation timestamp after clock rollback', async () => {
    const f = fixture();
    await f.bound.withInvocation('first', f.input, undefined, async permit => { f.store.reserve(permit); });
    f.db.execute('UPDATE world_native_action_reservations SET reserved_at=1001');
    await expect(f.bound.withInvocation('second', f.input, undefined, async permit => f.store.reserve(permit))).rejects.toThrow('NATIVE_CLOCK_ROLLBACK');
  });
});
