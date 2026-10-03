import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { pinConfiguredHouses } from '../../../src/social-graph/default-house-pinning.js';
import { pinnedBinding } from '../../../src/world/house-binding-pin.js';
import { houseReadAuthority } from '../../../src/identity/read-authority.js';
import type { Signer } from '../../../src/identity/signer.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const ORIGIN = 'https://pinning-mode.invalid';
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(publicV1Mode: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'pinning-mode-'));
  const db = new LocalHostDb(join(root, 'host.db')); runMigrations(db, MIGRATIONS);
  const release = registerStorageRuntime(db, new PopclawPaths(root));
  const house = mintHouse({ origin: ORIGIN, seed: 91 });
  const unusedCrypto = (): never => { throw new Error('unexpected DM crypto in pinning fixture'); };
  const signer: Signer = { sealDm: unusedCrypto, openDm: unusedCrypto, sealDmMedia: unusedCrypto, openDmMedia: unusedCrypto,
    popclawId: async () => 'owner', publicKey: async () => new Uint8Array(32),
    sign: async () => new Uint8Array(64) };
  let key = '';
  const rt = new HouseRuntime({ db, signer, origins: [ORIGIN], publicV1Mode,
    fetch: house.fetch as typeof fetch, configuredPinFor: () => key,
    readAuthorityFor: origin => houseReadAuthority({ db, signer }, origin) });
  cleanup.push(async () => { await rt.stop(); release(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, rt, house, setKey: (next: string) => { key = next; },
    pin: (fetchImpl: typeof fetch = house.fetch as typeof fetch, origin = ORIGIN) =>
      pinConfiguredHouses({ db, recipientPopclawId: 'owner', origins: [origin], fetch: fetchImpl,
        pinning: rt.configuredHousePinning, onParticipationChanged: () => rt.participationChanged() }) };
}
it('public-v1 commits verified pin/relation without seeding or advancing participation', async () => {
  const f = fixture(true);
  expect(f.rt.configuredHousePinning.mode).toBe('public-v1');
  expect(readParticipation(f.db, ORIGIN)).toBeNull();
  expect((await f.pin())[0]?.outcome).toBe('pinned');
  expect(pinnedBinding(f.db, ORIGIN)?.houseKey).toBe(f.house.houseKey);
  expect(f.db.queryOne('SELECT active,owner_generation FROM relation_participation WHERE house_key=?',
    [f.house.houseKey])).toEqual({ active: 1, owner_generation: 1 });
  expect(readParticipation(f.db, ORIGIN)).toBeNull();
  expect((await f.pin())[0]?.outcome).toBe('already-decided');
  expect(readParticipation(f.db, ORIGIN)).toBeNull();
});
it('public-v1 leaves an existing lifecycle tuple unchanged', async () => {
  const f = fixture(true);
  // An independently established control intent is not a static seed and
  // must not be overwritten or granted by the selected public proof policy.
  f.db.execute(`INSERT INTO house_participation(house_origin,installation_id,op_seq,desired,phase)
    VALUES (?, ?, 7, 'disabled', 'disconnected')`, [ORIGIN, f.rt.manager.installationId]);
  const before = readParticipation(f.db, ORIGIN);
  expect((await f.pin())[0]?.outcome).toBe('pinned');
  expect(readParticipation(f.db, ORIGIN)).toEqual(before);
});
it('static guard refusal never falls back to the public proof-only policy', async () => {
  const f = fixture(false); f.rt.manager.seedLegacyHouse(ORIGIN);
  f.db.execute('UPDATE house_participation SET op_seq=1 WHERE house_origin=?', [ORIGIN]);
  const fetchImpl = vi.fn(f.house.fetch) as unknown as typeof fetch;
  expect(f.rt.configuredHousePinning.mode).toBe('static');
  // Even a mistaken direct use cannot obtain the unselected public port.
  expect(f.rt.manager.configuredPublicPin.begin(f.db, ORIGIN)).toBeUndefined();
  expect((await f.pin(fetchImpl))[0]?.outcome).toBe('refused');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(pinnedBinding(f.db, ORIGIN)).toBeUndefined();
  expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(1);
});
it('public-v1 guards reject nonconfigured origins and a wrong DB before transport', async () => {
  const f = fixture(true);
  const fetchImpl = vi.fn(f.house.fetch) as unknown as typeof fetch;
  expect((await f.pin(fetchImpl, 'https://not-configured.invalid'))[0]?.outcome).toBe('refused');
  expect(fetchImpl).not.toHaveBeenCalled();
  const other = new LocalHostDb(':memory:'); runMigrations(other, MIGRATIONS);
  try {
    expect((await pinConfiguredHouses({ db: other, recipientPopclawId: 'owner', origins: [ORIGIN],
      fetch: fetchImpl, pinning: f.rt.configuredHousePinning }))[0]?.outcome).toBe('refused');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pinnedBinding(other, ORIGIN)).toBeUndefined();
  } finally { other.close(); }
  expect(readParticipation(f.db, ORIGIN)).toBeNull();
});
it('public-v1 proof commit refuses a configured-key change during the fetch', async () => {
  const f = fixture(true); const next = mintHouse({ origin: ORIGIN, seed: 92 });
  f.setKey(Buffer.from(bs58.decode(f.house.houseKey)).toString('hex'));
  const fetchImpl = (async (input: unknown) => {
    const response = await f.house.fetch(input);
    f.setKey(Buffer.from(bs58.decode(next.houseKey)).toString('hex'));
    return response;
  }) as typeof fetch;
  expect((await f.pin(fetchImpl))[0]?.outcome).toBe('refused');
  expect(pinnedBinding(f.db, ORIGIN)).toBeUndefined();
  expect(f.db.queryOne('SELECT house_key FROM relation_participation WHERE house_key=?', [f.house.houseKey])).toBeNull();
  expect(readParticipation(f.db, ORIGIN)).toBeNull();
});
