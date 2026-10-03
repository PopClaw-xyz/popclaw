/**
 * The configured houses are trusted without the owner typing a command — and
 * the owner's own decisions still outrank that default.
 *
 * Four things have to hold at once, and each of them is a way the convenience
 * could quietly become a hole:
 *
 *   - the automatic path is the SAME act as the explicit one, so a house that
 *     cannot prove its manifest stays unpinned and every identity read there
 *     stays refused. Anything that writes a pin without the proof would make
 *     "trusted" mean "was listed in a config file";
 *   - a house the owner left keeps its pin row and its ended participation.
 *     Re-adding it on the next boot would undo the owner's decision every
 *     time the process restarts, which is worse than never honouring it;
 *   - two roots share one data root and boot together, so the second attempt
 *     has to be a no-op rather than an error;
 *   - and the explicit add is still the way back in after a leave.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import nacl from 'tweetnacl';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import {
  pinConfiguredHouses as pinConfiguredHousesImpl,
  startDefaultHousePinning as startDefaultHousePinningImpl,
  type DefaultHousePinningDeps,
} from '../../../src/social-graph/default-house-pinning.js';
import { pinnedBinding } from '../../../src/world/house-binding-pin.js';
import { runHouseAddCommand, runHouseLeaveCommand } from '../../../src/commands/house.js';
import { houseReadAuthority } from '../../../src/identity/read-authority.js';
import { READ_CREDENTIAL_SCHEME } from '../../../src/identity/read-credential.js';
/** What every house in this file serves, so a pin arrives with a usable declaration. */
const DECLARES = { read_auth: { schemes: [READ_CREDENTIAL_SCHEME] } };
import { mintHouse } from '../../helpers/signed-manifest.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import { HouseLifecycleCoordinator } from '../../../src/runtime/house-lifecycle/coordinator.js';
import { HouseCommandBus } from '../../../src/runtime/house-lifecycle/command-bus.js';
import { normalizeHouseOrigin } from '../../../src/runtime/house-lifecycle/control-client.js';
import type { Signer } from '../../../src/identity/signer.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ME = 'owner-popclaw-id';
const HOME = 'https://home.example';
const SECOND = 'https://second.example';

const firstPins = new WeakMap<LocalHostDb, HouseLifecycleManager['configuredFirstPin']>();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function freshDb(): LocalHostDb {
  const db = new LocalHostDb(':memory:');
  runMigrations(db, MIGRATIONS);
  const root = mkdtempSync(join(tmpdir(), 'default-house-pinning-'));
  const release = registerStorageRuntime(db, new PopclawPaths(root));
  const manager = new HouseLifecycleManager({ db, installationId: 'default-pinning-install', signer,
    legacyRecoveryConfigured: origin => [HOME, SECOND].includes(normalizeHouseOrigin(origin)),
    fetch: (async () => { throw new Error('unexpected lifecycle transport'); }) as typeof fetch });
  const coordinator = new HouseLifecycleCoordinator({ manager, streams: { open: () => ({ stop() {} }) } });
  // Production constructor supplies the exact retained command schema.
  const bus = new HouseCommandBus({ db, coordinator,
    authority: { captureEpoch: () => null, isEpochCurrent: () => false } });
  firstPins.set(db, manager.configuredFirstPin);
  cleanup.push(async () => { await coordinator.stopHost(); await bus.stop(); release(); db.close();
    rmSync(root, { recursive: true, force: true }); });
  return db;
}
function firstPinFor(db: LocalHostDb): HouseLifecycleManager['configuredFirstPin'] {
  const port = firstPins.get(db);
  if (!port) throw new Error('missing production first-pin fixture');
  return port;
}
function pinConfiguredHouses(deps: Omit<DefaultHousePinningDeps, 'pinning'> & { db: LocalHostDb }) {
  return pinConfiguredHousesImpl({ ...deps, pinning: { mode: 'static', firstPin: firstPinFor(deps.db) } });
}
function startDefaultHousePinning(deps: Omit<DefaultHousePinningDeps, 'pinning'> & { db: LocalHostDb; delaysMs?: readonly number[] }) {
  return startDefaultHousePinningImpl({ ...deps, pinning: { mode: 'static', firstPin: firstPinFor(deps.db) } });
}

/** Enough of a signer to mint a read credential; identity is not what is judged here. */
const signer = {
  popclawId: async () => ME,
  sign: async () => new Uint8Array(64),
} as unknown as Signer;

function participation(db: LocalHostDb, houseKey: string) {
  return db.queryOne<{ owner_generation: number; active: number }>(
    'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
    [houseKey],
  );
}

/** One fetch over several minted houses; everything else 404s. */
function serve(...houses: readonly { origin: string; fetch: (input: unknown) => Promise<Response> }[]) {
  return vi.fn(async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string }).url ?? input);
    for (const house of houses) {
      if (url.startsWith(house.origin)) return house.fetch(input);
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

describe('default houses are pinned automatically', () => {
  it('pins every configured house on a fresh install, with no owner command', async () => {
    const db = freshDb();
    const home = mintHouse({ origin: HOME, seed: 1, manifest: DECLARES });
    const second = mintHouse({ origin: SECOND, seed: 2, manifest: DECLARES });
    const results = await pinConfiguredHouses({
      db,
      recipientPopclawId: ME,
      origins: [HOME, SECOND],
      fetch: serve(home, second),
      now: () => 1_700_000_000,
    });

    expect(results.map((r) => r.outcome)).toEqual(['pinned', 'pinned']);
    expect(pinnedBinding(db, HOME)?.houseKey).toBe(home.houseKey);
    expect(pinnedBinding(db, SECOND)?.houseKey).toBe(second.houseKey);
    // The point of pinning: an identity-bearing read is no longer refused.
    // Nothing is injected: the declaration the automatic pin committed, out of
    // the manifest it verified, is the only thing standing between a fresh
    // install and a refused inbox. A boot that pinned but projected nothing
    // would refuse here with READ_AUTH_NOT_DECLARED.
    const authority = houseReadAuthority({ db, signer }, HOME);
    expect((await authority('relation-list')).ok).toBe(true);
  });

  it('leaves a house whose manifest proof does not verify unpinned and refused', async () => {
    const db = freshDb();
    // Signed with a key other than the one the proof names: the shape is
    // right and the signature is not that key's word.
    const impostor = mintHouse({
      origin: HOME,
      seed: 1,
      manifest: DECLARES,
      signWith: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).secretKey,
    });
    const warn = vi.fn();
    const results = await pinConfiguredHouses({
      db,
      recipientPopclawId: ME,
      origins: [HOME],
      fetch: serve(impostor),
      now: () => 1_700_000_000,
      warn,
    });

    expect(results[0]?.outcome).toBe('refused');
    expect(pinnedBinding(db, HOME)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const authority = houseReadAuthority({ db, signer }, HOME);
    const outcome = await authority('relation-list');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.refusal).toBe('READ_AUTH_HOUSE_NOT_TRUSTED');
  });

  it('never re-pins a house the owner left, and never reaches it again', async () => {
    const db = freshDb();
    const home = mintHouse({ origin: HOME, seed: 1, manifest: DECLARES });
    const fetch = serve(home);
    await pinConfiguredHouses({ db, recipientPopclawId: ME, origins: [HOME], fetch, now: () => 1_700_000_000 });
    const left = await runHouseLeaveCommand(HOME, { db, recipientPopclawId: ME, fetch, now: () => 1_700_000_100 });
    expect(left.ok).toBe(true);
    const afterLeave = participation(db, home.houseKey);
    expect(afterLeave?.active).toBe(0);
    const callsBefore = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    const results = await pinConfiguredHouses({
      db,
      recipientPopclawId: ME,
      origins: [HOME],
      fetch,
      now: () => 1_700_000_200,
    });

    expect(results[0]?.outcome).toBe('already-decided');
    expect(participation(db, home.houseKey)).toEqual(afterLeave);
    // Not even a request: the owner's decision is read locally, and asking
    // the house first is how "skip it" becomes "log in again, quietly".
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('the explicit add is still the way back into a house that was left', async () => {
    const db = freshDb();
    const home = mintHouse({ origin: HOME, seed: 1, manifest: DECLARES });
    const fetch = serve(home);
    await pinConfiguredHouses({ db, recipientPopclawId: ME, origins: [HOME], fetch, now: () => 1_700_000_000 });
    await runHouseLeaveCommand(HOME, { db, recipientPopclawId: ME, fetch, now: () => 1_700_000_100 });
    expect(participation(db, home.houseKey)?.active).toBe(0);

    const added = await runHouseAddCommand(HOME, { db, recipientPopclawId: ME, fetch, now: () => 1_700_000_200 });

    expect(added.ok).toBe(true);
    expect(participation(db, home.houseKey)?.active).toBe(1);
  });

  it('two roots booting together produce one pin, and neither reports an error', async () => {
    const db = freshDb();
    const home = mintHouse({ origin: HOME, seed: 1, manifest: DECLARES });
    const fetch = serve(home);
    const boot = () =>
      pinConfiguredHouses({ db, recipientPopclawId: ME, origins: [HOME], fetch, now: () => 1_700_000_000 });

    const [a, b] = await Promise.all([boot(), boot()]);

    const outcomes = [a[0]?.outcome, b[0]?.outcome].sort();
    expect(outcomes).toEqual(['already-decided', 'pinned']);
    expect(
      db.queryAll<{ n: number }>('SELECT COUNT(*) AS n FROM house_binding_pin')[0]?.n,
    ).toBe(1);
  });

  it('retries a house that was unreachable at boot, and stops after the last delay', async () => {
    const db = freshDb();
    const home = mintHouse({ origin: HOME, seed: 1, manifest: DECLARES });
    let reachable = false;
    const fetch = (async (input: unknown) => {
      if (!reachable) throw new Error('ECONNREFUSED');
      return home.fetch(input);
    }) as unknown as typeof globalThis.fetch;
    const warn = vi.fn();

    const loop = startDefaultHousePinning({
      db,
      recipientPopclawId: ME,
      origins: [HOME],
      fetch,
      now: () => 1_700_000_000,
      warn,
      delaysMs: [0, 0],
    });
    reachable = true;
    await loop.done;

    expect(pinnedBinding(db, HOME)?.houseKey).toBe(home.houseKey);
  });

  it('recognises a house already pinned under the canonical origin, however it was configured', async () => {
    const db = freshDb();
    const home = mintHouse({ origin: HOME, seed: 1, manifest: DECLARES });
    // The pin is filed under the canonical origin; `lore_houses` holds
    // whatever the owner typed. Comparing those two strings raw makes an
    // already-trusted house look untouched, and the boot logs back in to a
    // house it never left — including one the owner DID leave, which is the
    // decision this pass exists not to overwrite.
    expect((await pinConfiguredHouses({
      db, recipientPopclawId: ME, origins: [HOME], fetch: serve(home), now: () => 1_700_000_000,
    })).map((r) => r.outcome)).toEqual(['pinned']);

    const fetch = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof globalThis.fetch;
    const results = await pinConfiguredHouses({
      db,
      recipientPopclawId: ME,
      origins: [`${HOME}/`, 'https://Home.Example'],
      fetch,
      now: () => 1_700_000_000,
    });

    expect(results.map((r) => r.outcome)).toEqual(['already-decided', 'already-decided']);
    // Nothing was re-attempted: a second `addHouseAndLogin` would have to
    // reach the house, and reaching it is exactly what must not happen here.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives up after the bounded retries instead of polling forever', async () => {
    const db = freshDb();
    const fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const warn = vi.fn();

    const loop = startDefaultHousePinning({
      db,
      recipientPopclawId: ME,
      origins: [HOME],
      fetch,
      now: () => 1_700_000_000,
      warn,
      delaysMs: [0, 0],
    });
    await loop.done;

    // One boot attempt plus the two delays it was given, and no more.
    expect(warn).toHaveBeenCalledTimes(3);
    expect(pinnedBinding(db, HOME)).toBeUndefined();
  });
});
