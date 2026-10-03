import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical, stripDefaultKeys } from '@popclaw/algorithms';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { HouseResourceOptions } from '../../../src/runtime/house-lifecycle/resource-set.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { makeWorldManifestPreparer } from '../../../src/world/world-capabilities.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';
import { openUnprovisionedPartition } from '../../helpers/unprovisioned-partition.js';

const utf8 = new TextEncoder();
const origin = 'https://actions.invalid';
const houseKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(61));
const owner = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(62));
const ownerId = bs58.encode(owner.publicKey);
const ackKeyHex = Buffer.from(houseKey.publicKey).toString('hex');
const guideBytes = utf8.encode('# Action guide\n');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function seedCapability(db: LocalHostDb): Promise<void> {
  const document = {
    intent_kinds: [{ kind: 'booking.reserve', schema_version: 1, transport: 'house', signer: 'user', description: 'Reserve',
      params_schema: { type: 'object' }, result_schema: { type: 'object' }, result_attachments: { allowed: [], required_on_success: [] }, consistency: 'none' }],
    official_ids: [bs58.encode(houseKey.publicKey)],
    house_session: { version: 1, endpoint: '/v1/house-session', ack_pubkey: ackKeyHex, operations: ['enter', 'renew', 'leave', 'status'] },
    world_interaction: { version: 1,
      actions: { status_endpoint: '/v1/world-actions/status', result_authority_pubkey: bs58.encode(houseKey.publicKey), kinds: ['booking.reserve'], attachments: [] },
      guide: { path: '/v1/guide.md', sha256: cidFromCanonical(guideBytes), revision: '1' } },
  };
  const rawBytes = utf8.encode(JSON.stringify(document));
  const core = { house: { origin, houseKey: bs58.encode(houseKey.publicKey), incarnation: 'world_1' }, manifestDigest: cidFromCanonical(rawBytes), signedAt: 1780000000 };
  const coreBytes = popclaw.world.ManifestProof.encode(stripDefaultKeys(core)).finish();
  const prefix = utf8.encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
  const signing = new Uint8Array(prefix.length + coreBytes.length); signing.set(prefix); signing.set(coreBytes, prefix.length);
  const preparer = makeWorldManifestPreparer({ fetch: (async (url: string) => {
    if (!String(url).endsWith('/v1/guide.md')) throw new Error('UNEXPECTED_FETCH');
    return new Response(guideBytes, { status: 200, headers: { 'content-type': 'text/markdown' } });
  }) as typeof fetch });
  const prepared = await preparer({ origin, rawBytes, ackKeyHex, provenance: 'configured_pin', signal: new AbortController().signal,
    proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...core, authoritySignature: nacl.sign.detached(signing, houseKey.secretKey) }).finish()).toString('base64') });
  db.transaction(tx => prepared.commit(tx));
}

/** A root that has done nothing but boot: no script, no offline preparation. */
async function freshRoot(options: { provisioned?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-action-root-')), paths = new PopclawPaths(dir);
  const db = new LocalHostDb(paths.socialDb()), cacheDb = new LocalHostDb(join(dir, 'cache.db'));
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: ownerId });
  const partition = options.provisioned === false
    ? openUnprovisionedPartition({ catalog, db, paths, actorId: ownerId, origin })
    : catalog.open(origin);
  await seedCapability(db);
  ensureHouseLifecycleSchema(db);
  db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,ack_key_hex,session_id,house_revision,lease_expires_at) VALUES(?,'fixture','enabled','connected',1,?,'session_1',3,?)",
    [origin, ackKeyHex, Math.floor(Date.now() / 1000) + 600]);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('UNEXPECTED_NETWORK'); });
  const log = vi.fn<(message: string) => void>();
  const signer = new MasterKeySigner({ ...owner, seed: owner.secretKey.slice(0, 32), popclawId: ownerId });
  const houses = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer, origins: [origin],
    executionStores: catalog, fetch, configuredPinFor: () => ackKeyHex, log });
  const store = { baseUrl: origin, slug: 'actions-invalid', db: cacheDb, executionDb: partition.db,
    dbPath: join(dir, 'cache.db'), cache: new WorldFeedCache({ db: cacheDb }) };
  houses.configureResources({ stores: [store], openStore: vi.fn(async () => store), worldStreamMode: true,
    host: {} as HouseResourceOptions['host'], recipientPopclawId: ownerId, isOfficialActor: () => false });
  cleanup.push(async () => { await houses.stop(); catalog.close(); cacheDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, paths, partition, houses, fetch, log };
}

it('reaches action readiness on a root that ran no preparation script at all', async () => {
  const f = await freshRoot();
  expect(f.houses.actionExecutionAvailable(origin, ownerId)).toBe(true);
  expect(f.houses.nativeActionExecutionAvailable(origin, ownerId)).toBe(true);
  expect(f.houses.actionExecutionAvailability(origin, ownerId, 'native')).toEqual({ ready: true, reason: null });
  // Storage readiness alone: nothing was asked of the owner, nothing was sent,
  // and no reservation or grant exists to execute against.
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.log).not.toHaveBeenCalled();
  for (const table of ['world_action_client_requests', 'world_owner_action_reservations', 'world_native_action_reservations']) {
    expect(f.partition.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`)?.n).toBe(0);
  }
  expect(f.db.queryAll('SELECT kind FROM house_lifecycle_commands')).toEqual([]);
});

it('names and logs the reason instead of returning a bare false', async () => {
  const f = await freshRoot({ provisioned: false });
  expect(f.houses.actionExecutionAvailability(origin, ownerId, 'receipt'))
    .toEqual({ ready: false, reason: 'ACTION_RECEIPT_PROTECTION_INCOMPLETE' });
  expect(f.houses.actionExecutionAvailable(origin, ownerId)).toBe(false);
  expect(f.log.mock.calls.map(call => call[0]).join('\n')).toContain('ACTION_RECEIPT_PROTECTION_INCOMPLETE');
  expect(f.houses.actionExecutionAvailability('https://not-resident.invalid', ownerId, 'receipt'))
    .toEqual({ ready: false, reason: 'ACTION_EXECUTION_HOUSE_NOT_RESIDENT' });
});
