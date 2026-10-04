/**
 * ADR-0041 lets a house declare its guide on ANOTHER origin (a declared guide
 * is a public document, relative or absolute http(s)). The world house does
 * exactly that: `https://house.popclaw.world` declares
 * `guide_url: https://popclaw.world/guide.md`.
 *
 * The unit tests beside this one inject a plain fetch, so they never met the
 * layer the roots actually wire: the house-bound fetcher refuses every URL
 * whose origin is not the house (`HOUSE_AUDIENCE_MISMATCH`), the guide fetch
 * failed, no guide was written, and the agent never saw the world's rules.
 *
 * These tests drive a real HouseRuntime. The manifest stays on the
 * house-bound lane; only the declared guide goes through `documentFetch`,
 * which keeps every protection except origin equality.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMigrations } from '../../../src/host/migrations.js';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import {makeTestSigner} from '../../helpers/test-signer.js';
import {mintHouse} from '../../helpers/signed-manifest.js';
import {localParticipationPort} from '../../../src/host/local-participation.js';
import type { HostAdapter } from '../../../src/host/host-adapter.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';
import { INBOX_TOKEN_HEADER } from '../../../src/identity/read-credential.js';
import { withHouseActions } from '../../../src/runtime/house-lifecycle/action-context.js';
import { refreshHouseHandshake, readHouseGuide, readHouseHandshake } from '../../../src/world/house-handshake.js';

vi.mock('../../../src/runtime/house-lifecycle/resource-set.js', () => ({
  createHouseStreamFactory: () => ({ open: () => ({ stop: async () => {} }) }),
}));

const HOUSE = 'https://house.popclaw.world';
const SLUG = 'house-popclaw-world';
const GUIDE_URL = 'https://popclaw.world/guide.md';
const GUIDE = '---\nworld: popclaw.world\n---\nThe rules of the world, served from its own origin.';
const MANIFEST = JSON.stringify({
  house: { name: 'popclaw.world', slug: 'world' },
  official_ids: ['WORLD_OFFICIAL_1'],
  guide_url: GUIDE_URL,
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(routes: Record<string, () => Response> = {
  [`${HOUSE}/v1/manifest`]: () => new Response(MANIFEST, { status: 200, headers: { etag: '"m1"' } }),
  [GUIDE_URL]: () => new Response(GUIDE, { status: 200, headers: { etag: '"g1"' } }),
}, house = HOUSE) {
  const signed=mintHouse({origin:house,manifest:{house:{name:'popclaw.world',slug:'world'},guide_url:GUIDE_URL}});
  let joining=true;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const u = url instanceof Request ? url.url : String(url);
    if(joining)return signed.fetch(u);
    calls.push({ url: u, init });
    const route = routes[u];
    return route ? route() : new Response(null, { status: 404 });
  });
  const dir = mkdtempSync(join(tmpdir(), 'guide-origin-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const paths = new PopclawPaths(dir);
  const db = new LocalHostDb(join(dir, 'host.db'));
  runMigrations(db, fileURLToPath(new URL('../../../migrations', import.meta.url)));
  cleanup.push(() => db.close());
  const signer=makeTestSigner('BlackFeather');
  const houses = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, origins: [house], signer,actorId:await signer.popclawId(),participation:localParticipationPort(()=>undefined),
    commandTimeoutMs: 100, commandPollMs: 2, fetch });
  houses.configureResources({ stores: [], host: {} as HostAdapter, recipientPopclawId: 'fixture', worldStreamMode: false,
    openStore: async () => { throw new Error('unused'); }, isOfficialActor: () => false });
  cleanup.push(() => houses.stop());
  houses.start();
  expect(await houses.commands.loginHouse(house)).toMatchObject({admission:'configured'});
  joining=false;fetch.mockClear();
  return { houses, paths, calls, fetch, db };
}

describe('a declared guide on another origin', () => {
  it('is fetched through the document lane and written to disk', async () => {
    const { houses, paths, calls } = await fixture();
    const gate = houses.captureGate(HOUSE);
    expect(gate.isActive()).toBe(true);
    const logs: string[] = [];
    // The guide lane refuses the manifest: the manifest must stay on the
    // house-bound lane, never ride the one that may leave the origin.
    const documentLane = houses.documentFetch(HOUSE, gate);
    const guideFetch: typeof globalThis.fetch = (url, init) => {
      if (String(url).endsWith('/v1/manifest')) throw new Error('manifest fetched through the document lane');
      return documentLane(url, init);
    };
    await refreshHouseHandshake(HOUSE, { paths, logger: { info: m => logs.push(m), warn: m => logs.push(m) },
      fetch: houses.houseFetch(HOUSE, gate), guideFetch });

    expect(logs.filter(l => l.includes('could not fetch'))).toEqual([]);
    expect(readHouseGuide(paths, SLUG)).toBe(GUIDE);
    expect(readHouseHandshake(paths, SLUG)).toMatchObject({ guide_url: GUIDE_URL, guide_etag: '"g1"', official_ids: ['WORLD_OFFICIAL_1'] });
    expect(calls.map(c => c.url)).toEqual([`${HOUSE}/v1/manifest`, GUIDE_URL]);
    // A plain GET: nothing derived from the house rides along, and no redirect is followed.
    const guideInit = calls[1]!.init!;
    expect(guideInit.redirect).toBe('error');
    expect(guideInit.credentials).toBe('omit');
    const headers = new Headers(guideInit.headers);
    expect([...headers.keys()]).toEqual([]);
  });

  it('keeps the manifest on the house-bound lane: a cross-origin manifest URL is still refused', async () => {
    const { houses, fetch } = await fixture();
    const gate = houses.captureGate(HOUSE);
    await expect(houses.houseFetch(HOUSE, gate)('https://popclaw.world/v1/manifest')).rejects.toThrow('HOUSE_AUDIENCE_MISMATCH');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('documentFetch keeps every protection except origin equality', () => {
  it('never follows a redirect', async () => {
    const { houses, calls } = await fixture({ [GUIDE_URL]: () => new Response('ok') });
    const doc = houses.documentFetch(HOUSE, houses.captureGate(HOUSE));
    await doc(GUIDE_URL, { redirect: 'follow' });
    expect(calls[0]!.init?.redirect).toBe('error');
  });

  it.each(['ftp://popclaw.world/guide.md', 'file:///etc/passwd', 'https://user:pw@popclaw.world/guide.md', 'https://user@popclaw.world/guide.md'])(
    'refuses %s without calling fetch', async url => {
      const { houses, fetch } = await fixture();
      await expect(houses.documentFetch(HOUSE, houses.captureGate(HOUSE))(url)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

  it('refuses a request carrying a credential header', async () => {
    const { houses, fetch } = await fixture();
    const doc = houses.documentFetch(HOUSE, houses.captureGate(HOUSE));
    for (const name of ['authorization', 'cookie', INBOX_TOKEN_HEADER]) {
      await expect(doc(GUIDE_URL, { headers: { [name]: 'x' } })).rejects.toThrow();
      await expect(doc(new Request(GUIDE_URL, { headers: { [name]: 'x' } }))).rejects.toThrow();
    }
    await expect(doc(GUIDE_URL, { method: 'POST' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches nothing when the captured gate is inactive', async () => {
    const stopped = await fixture();
    const gate = stopped.houses.captureGate(HOUSE);
    await stopped.houses.stop();
    expect(gate.isActive()).toBe(false);
    await expect(stopped.houses.documentFetch(HOUSE, gate)(GUIDE_URL)).rejects.toThrow('no longer active');
    expect(stopped.fetch).not.toHaveBeenCalled();

    const other = await fixture();
    const inactive = { origin: HOUSE, generation: 1, signal: new AbortController().signal, isActive: () => false };
    await expect(other.houses.documentFetch(HOUSE, inactive)(GUIDE_URL)).rejects.toThrow('no longer active');
    expect(other.fetch).not.toHaveBeenCalled();
  });

  it('fetches nothing once the house is left, even with a gate captured before', async () => {
    const { houses, fetch, db } = await fixture();
    const gate = houses.captureGate(HOUSE);
    expect(gate.isActive()).toBe(true);
    db.execute("UPDATE house_participation SET desired='disabled',op_seq=op_seq+1 WHERE house_origin=?", [HOUSE]);
    await expect(houses.documentFetch(HOUSE, gate)(GUIDE_URL)).rejects.toThrow('no longer active');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('honours the enclosing command: a house outside its scope, or inactive in it, fetches nothing', async () => {
    const { houses, fetch } = await fixture();
    const gate = houses.captureGate(HOUSE);
    const doc = houses.documentFetch(HOUSE, gate);
    // The enclosing command does not hold this house (unmounted from its point of view).
    await expect(withHouseActions(new Map(), () => doc(GUIDE_URL))).rejects.toThrow('no longer active');
    // The enclosing command holds it, but that hold has lapsed.
    const lapsed = new Map([[HOUSE, { signal: new AbortController().signal, isActive: () => false }]]);
    await expect(withHouseActions(lapsed, () => doc(GUIDE_URL))).rejects.toThrow('no longer active');
    expect(fetch).not.toHaveBeenCalled();
    // Control: held and active, the same call goes through.
    await withHouseActions(new Map([[HOUSE, gate]]), () => doc(GUIDE_URL));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('an unreachable guide still leaves the house handshake intact', async () => {
    const { houses, paths } = await fixture({
      [`${HOUSE}/v1/manifest`]: () => new Response(MANIFEST, { status: 200 }),
    });
    const gate = houses.captureGate(HOUSE);
    await refreshHouseHandshake(HOUSE, { paths, fetch: houses.houseFetch(HOUSE, gate), guideFetch: houses.documentFetch(HOUSE, gate) });
    expect(readHouseHandshake(paths, SLUG)?.house_name).toBe('popclaw.world');
    expect(existsSync(paths.houseGuideFile(SLUG))).toBe(false);
  });
});

describe('documentFetch refuses private addresses for a public house', () => {
  it.each([
    'http://127.0.0.1:18789/guide.md',
    'http://[::1]/guide.md',
    'http://localhost:5432/guide.md',
    'http://api.localhost/guide.md',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://10.0.0.1/guide.md',
    'http://172.16.0.1/guide.md',
    'http://192.168.1.1/guide.md',
    'http://100.64.0.1/guide.md',
    'http://0.0.0.0:8080/guide.md',
    'http://2130706433/guide.md',
    'http://[::ffff:127.0.0.1]/guide.md',
    'http://[::ffff:10.0.0.1]/guide.md',
    'http://[::]/guide.md',
    'http://[fe80::1]/guide.md',
    'http://[fd00::1]/guide.md',
  ])('refuses %s without calling fetch', async url => {
    const { houses, fetch } = await fixture();
    await expect(houses.documentFetch(HOUSE, houses.captureGate(HOUSE))(url)).rejects.toThrow('HOUSE_DOCUMENT_ADDRESS_REFUSED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['https://popclaw.world/guide.md', 'https://172.32.0.1/guide.md', 'https://[2606:4700::1]/guide.md'])('still allows %s', async url => {
    const { houses, fetch } = await fixture({ [url]: () => new Response('ok') });
    expect((await houses.documentFetch(HOUSE, houses.captureGate(HOUSE))(url)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('exempts a house that is itself on a private address (dev and test houses)', async () => {
    const devHouse = 'http://127.0.0.1:8112';
    const url = 'http://127.0.0.1:18789/guide.md';
    const { houses, fetch } = await fixture({ [url]: () => new Response('ok') }, devHouse);
    expect((await houses.documentFetch(devHouse, houses.captureGate(devHouse))(url)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

const source = (file: string) => readFileSync(resolve(__dirname, '../../..', file), 'utf8');
const refreshCalls = (file: string) => source(file).split('refreshHouseHandshake(house.baseUrl,').slice(1).map(rest => rest.slice(0, rest.indexOf('})') + 2));

describe('every root wires the document lane into the handshake', () => {
  // The roots are too heavy to boot here; the wiring is one expression each,
  // and a root that drops it silently returns to HOUSE_AUDIENCE_MISMATCH.
  // Both tool-registering roots' refresh now lives in the shared runtime
  // assembly (runtime/assembly/feeds.ts: MCP since C2, the gateway since C3);
  // main.ts still types its own.
  it.each(['src/main.ts', 'src/runtime/assembly/feeds.ts'])('%s', file => {
    const calls = refreshCalls(file);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain('fetch: houses.houseFetch(house.baseUrl, gate)');
      expect(call).toContain('guideFetch: houses.documentFetch(house.baseUrl, gate)');
    }
  });

  it('src/mcp.ts and src/index.ts reach that refresh through the assembly, and carry none of their own', () => {
    // A scan over either root itself would now find nothing — so neither may
    // be the file the check above reads for it.
    expect(refreshCalls('src/mcp.ts')).toEqual([]);
    expect(refreshCalls('src/index.ts')).toEqual([]);
    expect(refreshCalls('src/host/openclaw-runtime-ports.ts')).toEqual([]);
    // That both roots build through the assembly is runtime-contract.test.ts's
    // build-path pin (one copy, C4), and the real roots reach its one
    // configureResources call (root-assembly-{mcp,gateway}.test.ts).
    expect(source('src/runtime/assembly/index.ts')).toMatch(/configureHouseResources\(\{/);
    expect(source('src/runtime/assembly/feeds.ts')).toMatch(/houses\.configureResources\(\{[\s\S]*refresh: async \(house, gate\) => \{/);
  });
});
