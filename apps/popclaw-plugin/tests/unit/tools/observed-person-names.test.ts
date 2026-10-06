import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { WorldFeedCatalog } from '../../../src/ingress/world-feed-catalog.js';
import { makeNameChain } from '../../../src/identity/person-name.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { buildPersonSources, resolvePersonRef } from '../../../src/tools/person-sources.js';
import { resolvePerson } from '../../../src/identity/person-resolver.js';
import { registerNamecardTool } from '../../../src/tools/identity-tools.js';
import { runProfileCommand } from '../../../src/commands/profile.js';
import type { RegisterToolsDeps, ToolsCtx } from '../../../src/tools/tools-context.js';

const key = (seed: number) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
const idOf = (seed: number) => bs58.encode(key(seed).publicKey);
const LEE = idOf(23);
const OTHER = idOf(24);
const ME = idOf(25);
const resources: Array<{ db: LocalHostDb[]; path: string }> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const { db, path } of resources.splice(0)) {
    for (const handle of db) handle.close();
    rmSync(path, { recursive: true, force: true });
  }
});

function frame(seed: number, name: string, timestamp: number) {
  const keys = key(seed);
  const actor = { popclawId: idOf(seed), nickname: name };
  const env = { actor, timestamp, post: { blocks: [{ content: 'Synthetic public post' }] } };
  const canonical = canonicalizeEnvelope(env);
  const signed = { ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, keys.secretKey) };
  return {
    envelope: popclaw.event.EventEnvelope.encode(signed).finish(),
    platform: 'popclaw', platformPostId: signed.eventId,
    platformPostCreatedAt: timestamp, authorPopclawId: actor.popclawId,
    actorNickname: name, handle: name, textPreview: 'Synthetic public post',
  };
}

async function pair() {
  // Independent connections and catalog/name-chain instances over the same
  // real cache path. No shared in-memory getter substitutes for DB visibility.
  const path = mkdtempSync(join(tmpdir(), 'popclaw-observed-names-'));
  const file = join(path, 'house.db');
  const dbA = new LocalHostDb(file);
  const dbB = new LocalHostDb(file);
  resources.push({ path, db: [dbA, dbB] });
  const cacheA = new WorldFeedCache({ db: dbA });
  const cacheB = new WorldFeedCache({ db: dbB });
  await cacheA.start();
  await cacheB.start();
  const build = (cache: WorldFeedCache) => {
    const catalog = new WorldFeedCatalog([{
      slug: 'synthetic-house', baseUrl: 'https://house.example.invalid', dbPath: file, cache,
      snapshot: { fetchSnapshot: async () => [] },
    }]);
    const nameOf = makeNameChain({ handleFromFeed: id => catalog.byAuthor(id, 1)[0]?.handle });
    const house = vi.fn(async () => []);
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      popclaw_id: LEE, sigil: deriveSigil(LEE), profiles: [], card: null,
    })));
    const runtime = async () => ({
      boot: { popclawId: ME, nickname: 'Owner Exact', loreHouseUrl: 'https://house.example.invalid' },
      worldFeedCache: catalog, nameOf,
      houseRuntime: { houseReadFetch: () => fetch },
    });
    type Tool = { execute(id: string, params: unknown): Promise<{ text: string }> };
    let tool: Tool;
    const api = { registerTool: (value: unknown) => { tool = value as Tool; } };
    // Only the read-tool slots are injected. This is not a bootable runtime
    // or a claim about participation/publication of a real identity.
    const deps = { api, runtime, getWorldDeps: async () => ({ resolveClient: { resolve: house } }) } as unknown as RegisterToolsDeps;
    registerNamecardTool({ api, runtime, deps } as unknown as ToolsCtx);
    return { deps, house, fetch, nameOf, catalog, card: (ref: string) => tool.execute('read', { person: ref }) };
  };
  return { cacheA, cacheB, a: build(cacheA), b: build(cacheB) };
}

describe('observed names through real local cache connections', () => {
  it('resolves an unpublished name locally and carries it to an empty public namecard', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real network forbidden'); }));
    const fx = await pair();
    fx.cacheA.record(frame(23, 'Lee', 100));
    for (const client of [fx.a, fx.b]) {
      expect(await resolvePersonRef('Lee', client.deps)).toMatchObject({ kind: 'resolved', popclawId: LEE, nickname: 'Lee' });
      for (const ref of ['Lee', deriveSigil(LEE), LEE]) {
        const result = await client.card(ref);
        expect(result.text).toContain(`popclaw  @Lee#${deriveSigil(LEE)}`);
        expect(result.text).toContain(`popclaw_id  ${LEE}`);
        expect(result.text).not.toContain('Verified');
      }
      expect(client.house).not.toHaveBeenCalled();
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('sees a rename on both already-open connections after cached SELECTs', async () => {
    const fx = await pair();
    fx.cacheA.record(frame(23, 'Lee', 100));
    // Prime both readers and their actual SQL statement caches before write.
    for (const client of [fx.a, fx.b]) {
      expect(client.nameOf(LEE)).toBe('Lee');
      await client.card(deriveSigil(LEE));
    }
    fx.cacheA.record(frame(23, 'Renamed Lee', 200));
    for (const client of [fx.a, fx.b]) {
      expect(client.nameOf(LEE)).toBe('Renamed Lee');
      expect(await resolvePersonRef('Renamed Lee', client.deps)).toMatchObject({ kind: 'resolved', popclawId: LEE, nickname: 'Renamed Lee' });
      expect((await client.card(deriveSigil(LEE))).text).toContain(`@Renamed Lee#${deriveSigil(LEE)}`);
      // Substring matching still accepts Lee within the current name.
      expect(await resolvePersonRef('Lee', client.deps)).toMatchObject({ kind: 'resolved', popclawId: LEE, nickname: 'Renamed Lee' });
      expect(client.house).not.toHaveBeenCalled();
    }
  });

  it('retires a replaced name rather than using historical rows as current names', async () => {
    const fx = await pair();
    fx.cacheA.record(frame(23, 'Lee', 100));
    await fx.b.card(deriveSigil(LEE));
    fx.cacheA.record(frame(23, 'Raven', 200));
    for (const client of [fx.a, fx.b]) {
      expect(await resolvePersonRef('Lee', client.deps)).toMatchObject({ kind: 'notFound' });
      expect(await resolvePersonRef('Raven', client.deps)).toMatchObject({ kind: 'resolved', popclawId: LEE, nickname: 'Raven' });
    }
  });

  it('keeps duplicate observed names ambiguous and an explicit sigil authoritative', async () => {
    const fx = await pair();
    fx.cacheA.record(frame(23, 'Lee', 100));
    fx.cacheA.record(frame(24, 'Lee', 101));
    for (const client of [fx.a, fx.b]) {
      const result = await resolvePersonRef('Lee', client.deps);
      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') expect(result.candidates.map(c => c.popclawId).sort()).toEqual([LEE, OTHER].sort());
      expect(await resolvePersonRef(`Lee#${deriveSigil(LEE)}`, client.deps)).toMatchObject({ kind: 'resolved', popclawId: LEE });
      expect(client.house).not.toHaveBeenCalled();
    }
  });

  it('does not derive name candidates from display aliases or a public-key handle', async () => {
    const fx = await pair();
    fx.cacheA.record(frame(23, LEE, 100));
    expect(await resolvePersonRef(deriveSigil(LEE), fx.b.deps)).toMatchObject({ kind: 'resolved', popclawId: LEE, nickname: '' });
    const sources = await buildPersonSources(fx.b.deps);
    sources.nameOf = () => 'Display Only';
    expect(await resolvePerson('Display Only', sources)).toMatchObject({ kind: 'notFound' });
    expect(await resolvePersonRef('Owner', fx.b.deps)).toMatchObject({ kind: 'notFound' });
    expect(await resolvePersonRef('Owner Exact', fx.b.deps)).toMatchObject({ kind: 'resolved', popclawId: ME });
  });

  it('keeps self exact even after seeing the owner in the feed, and matches folded Latin observed names', async () => {
    const fx = await pair();
    fx.cacheA.record(frame(25, 'Owner Exact', 100));
    fx.cacheA.record(frame(23, 'Blackfeather', 101));
    expect(await resolvePersonRef('Owner', fx.b.deps)).toMatchObject({ kind: 'notFound' });
    expect(await resolvePersonRef('Owner Exact', fx.b.deps)).toMatchObject({ kind: 'resolved', popclawId: ME });
    expect(await resolvePersonRef('Blackfeather', fx.b.deps)).toMatchObject({ kind: 'resolved', popclawId: LEE });
  });

  it.each(['hash', 'name-hash', 'full-id'])('never lets an observed name replace an explicit identity key (%s)', async kind => {
    const fx = await pair();
    fx.cacheA.record(frame(23, deriveSigil(OTHER), 100));
    const ref = kind === 'hash' ? `#${deriveSigil(OTHER)}`
      : kind === 'name-hash' ? `Other#${deriveSigil(OTHER)}` : OTHER;
    fx.b.house.mockResolvedValue([{
      popclawId: OTHER, nickname: 'Other', sigil: deriveSigil(OTHER), profiles: [],
    }] as never);
    expect(await resolvePersonRef(ref, fx.b.deps)).toMatchObject({ kind: 'resolved', popclawId: OTHER, sigil: deriveSigil(OTHER) });
    expect(fx.b.house).toHaveBeenCalled();
  });
});

describe('namecard display keeps public identity and publication evidence', () => {
  const response = (id: string, native: string, card: string | null) => vi.fn(async () => new Response(JSON.stringify({
    popclaw_id: id, sigil: deriveSigil(id), profiles: [{ platform: 'popclaw', handle: native }],
    card: card === null ? null : { nickname: card, one_line_intro: 'Published intro' },
  })));

  it('uses a published card name when the native handle is a public key', async () => {
    const result = await runProfileCommand({ target: LEE }, { loreHouseUrl: 'https://house.example.invalid', fetch: response(LEE, LEE, 'Lee') });
    expect(result.text).toContain(`popclaw  @Lee#${deriveSigil(LEE)}`);
    expect(result.text).toContain('Published intro');
  });

  it('uses the current local self name when the public card is absent', async () => {
    const result = await runProfileCommand({ target: ME }, {
      loreHouseUrl: 'https://house.example.invalid', fetch: response(ME, ME, null),
      self: { popclawId: ME, nickname: 'Owner Renamed' },
    });
    expect(result.text).toContain(`@Owner Renamed#${deriveSigil(ME)}`);
  });

  it('falls back to a bare sigil for an unknown empty card, keeping the full ID line', async () => {
    const result = await runProfileCommand({ target: LEE }, { loreHouseUrl: 'https://house.example.invalid', fetch: response(LEE, LEE, null) });
    expect(result.text).not.toContain(`@${LEE}#`);
    expect(result.text).toContain(`popclaw  #${deriveSigil(LEE)}`);
    expect(result.text).toContain(`popclaw.me/${LEE}/${deriveSigil(LEE)}`);
    expect(result.text).toContain(`popclaw_id  ${LEE}`);
    expect(result.text).toContain(`#${deriveSigil(LEE)}`);
  });

  it('uses local clues only for the matching ID, without inventing a published card or proof', async () => {
    const fetch = response(LEE, LEE, null);
    const deps = { loreHouseUrl: 'https://house.example.invalid', fetch, knownPerson: { popclawId: LEE, nickname: 'Observed Lee' } };
    const shown = await runProfileCommand({ target: LEE }, deps);
    expect(shown.text).toContain(`@Observed Lee#${deriveSigil(LEE)}`);
    expect(shown.text).not.toContain('Published intro');
    expect(shown.text).not.toContain('Verified');
    const foreign = await runProfileCommand({ target: LEE }, { ...deps, knownPerson: { popclawId: OTHER, nickname: 'Foreign Label' } });
    expect(foreign.text).not.toContain('Foreign Label');
    const missing = await runProfileCommand({ target: LEE }, { ...deps, fetch: async () => new Response('', { status: 404 }) });
    expect(missing.text).not.toContain('━━━━━━━━');
    expect(missing.text).not.toContain('Observed Lee');
  });

  it('prefers published public names over a local display clue', async () => {
    const result = await runProfileCommand({ target: LEE }, {
      loreHouseUrl: 'https://house.example.invalid', fetch: response(LEE, LEE, 'Published Lee'),
      knownPerson: { popclawId: LEE, nickname: 'Private Alias' },
    });
    expect(result.text).toContain(`@Published Lee#${deriveSigil(LEE)}`);
    expect(result.text).not.toContain('Private Alias');
  });
});
