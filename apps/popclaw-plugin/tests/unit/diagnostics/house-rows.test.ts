import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PopclawPaths } from '../../../src/host/popclaw-paths';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache';
import { bytesOf, item } from '../../helpers/world-feed-cache';
import { collectHouseFacts } from '../../../src/diagnostics/collect';
import { renderHouseSection, type HouseCacheFacts } from '../../../src/diagnostics/house-rows';
import { collectDoctorReport, type DoctorCollectInput } from '../../../src/diagnostics/bundle';

// #588: the doctor report knew nothing about lore-houses, so a house going
// down was indistinguishable from a quiet world. These rows are read from
// the on-disk cache ONLY — `house-handshake.ts` owns fetching, and doctor
// must stay usable with the network unplugged (ADR-0035 discipline).

const FRESH = 'https://popclaw.me';
const NEVER = 'https://house.popclaw.world';

let root: string;
let paths: PopclawPaths;
let realFetch: typeof globalThis.fetch;

/** A house with a handshake record, a guide and a cache that has seen frames. */
async function seedFreshHouse(): Promise<void> {
  mkdirSync(paths.lorehousesDir(), { recursive: true });
  writeFileSync(
    paths.houseHandshakeFile('popclaw-me'),
    JSON.stringify({
      manifest_etag: 'W/"m-1"',
      house_name: 'Popclaw Home',
      official_ids: ['OFFICIAL1'],
      guide_url: 'https://popclaw.me/v1/guide.md',
      guide_etag: 'W/"g-1"',
      fetched_at: 1_700_000_000,
    }),
    'utf8',
  );
  writeFileSync(
    paths.houseGuideFile('popclaw-me'),
    ['---', 'world: popclaw', 'feedback:', '  contact: the lamplighters', '  popclaw_id: CONTACT1', '---', 'body'].join('\n'),
    'utf8',
  );
  const db = new LocalHostDb(paths.lorehouseDb('popclaw-me'));
  const cache = new WorldFeedCache({ db });
  await cache.start();
  const it_ = item({ platformPostId: 'p1', platformPostCreatedAt: 1_699_000_000 });
  cache.record(it_, bytesOf(it_), 1_700_000_500);
  db.close();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'popclaw-doctor-houses-'));
  paths = new PopclawPaths(root);
  // Doctor must never call out. Any fetch from this code path is a bug.
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('doctor must not touch the network');
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

describe('collectHouseFacts — one row per mounted house, from cache only', () => {
  it('reads the fresh house handshake, guide, contact and last frame with the network unplugged', async () => {
    await seedFreshHouse();
    const facts = collectHouseFacts(paths, [FRESH, NEVER]);
    expect(facts).toHaveLength(2);
    const fresh = facts[0]!;
    expect(fresh.slug).toBe('popclaw-me');
    expect(fresh.houseName).toBe('Popclaw Home');
    expect(fresh.handshakeFetchedAt).toBe(1_700_000_000);
    expect(fresh.manifestEtag).toBe('W/"m-1"');
    expect(fresh.guideEtag).toBe('W/"g-1"');
    expect(fresh.guideMtime).toBeGreaterThan(0);
    expect(fresh.lastFrameAt).toBe(1_700_000_500);
    expect(fresh.officialContact).toContain('CONTACT1');
  });

  it('a house that was never handshaken reports nothing rather than fetching', async () => {
    await seedFreshHouse();
    const never = collectHouseFacts(paths, [FRESH, NEVER])[1]!;
    expect(never.slug).toBe('house-popclaw-world');
    expect(never.handshakeFetchedAt).toBeUndefined();
    expect(never.guideMtime).toBeUndefined();
    expect(never.lastFrameAt).toBeNull();
    expect(never.officialContact).toBeUndefined();
  });

  it('a corrupt handshake file reads as unreadable, never as "never handshaken"', async () => {
    await seedFreshHouse();
    writeFileSync(paths.houseHandshakeFile('popclaw-me'), '{ not json', 'utf8');
    const fresh = collectHouseFacts(paths, [FRESH])[0]!;
    expect(fresh.handshakeFetchedAt).toBe('unreadable');
  });

  it('an absent handshake file still reads as never handshaken', () => {
    expect(collectHouseFacts(paths, [NEVER])[0]!.handshakeFetchedAt).toBeUndefined();
  });

  it('does not create a cache database for a house that has none', () => {
    const facts = collectHouseFacts(paths, [NEVER]);
    expect(facts[0]!.lastFrameAt).toBeNull();
    // Probing must not leave a file behind — data/ is regenerable, not fabricated.
    expect(() => new LocalHostDb(paths.lorehouseDb('house-popclaw-world'), { readOnly: true })).toThrow();
  });

  it('an unparseable house URL is skipped, never crashes the report', () => {
    expect(collectHouseFacts(paths, ['not a url'])).toEqual([]);
  });
});

describe('renderHouseSection — the report lines', () => {
  const fresh: HouseCacheFacts = {
    slug: 'popclaw-me',
    houseName: 'Popclaw Home',
    handshakeFetchedAt: 1_700_000_000,
    manifestEtag: 'W/"m-1"',
    guideEtag: 'W/"g-1"',
    guideMtime: 1_700_000_200,
    lastFrameAt: 1_700_000_500,
    officialContact: 'the lamplighters (CONTACT1)',
  };
  const never: HouseCacheFacts = { slug: 'house-popclaw-world', lastFrameAt: null };
  const opts = { tz: 'UTC', lang: 'en' as const };

  it('gives each mounted house a row with slug, handshake, guide, last frame and contact', () => {
    const out = renderHouseSection([fresh, never], opts).join('\n');
    expect(out).toContain('popclaw-me');
    expect(out).toContain('Popclaw Home');
    expect(out).toContain('W/"m-1"');
    expect(out).toContain('W/"g-1"');
    expect(out).toContain('2023-11-14');
    expect(out).toContain('CONTACT1');
    expect(out).toContain('house-popclaw-world');
  });

  // Controller ruling 2026-09-13: this report is attached to feedback DMs, and
  // a self-hosted / localhost house address is a topology disclosure. The slug
  // identifies the house; the configured URL never leaves the machine.
  it('never prints the configured lore_houses URL', () => {
    const out = renderHouseSection([fresh, never], opts).join('\n');
    expect(out).not.toContain(FRESH);
    expect(out).not.toContain(NEVER);
    expect(out).not.toContain('http');
  });

  it('a never-handshaken house says so instead of showing a blank', () => {
    const out = renderHouseSection([never], opts).join('\n');
    expect(out).toContain('never handshaken');
    expect(out.toLowerCase()).toContain('never');
    expect(out).not.toContain('undefined');
    // No manifest yet = no name yet; do not print the slug twice as if it were one.
    expect(out).toContain('- house-popclaw-world\n');
    expect(out).not.toContain('house-popclaw-world · house-popclaw-world');
  });

  it('a handshake file that will not parse reads as unreadable, not as never handshaken', () => {
    const out = renderHouseSection([{ ...never, handshakeFetchedAt: 'unreadable' }], opts).join('\n');
    expect(out).toMatch(/handshake: cache file present but unreadable/);
    expect(out).not.toContain('never handshaken');
  });

  it('an unreadable cache reads as unreadable, not as a house that never spoke', () => {
    const out = renderHouseSection([{ ...fresh, lastFrameAt: 'unreadable' }], opts).join('\n');
    expect(out).toContain('cache unreadable');
    expect(out).not.toContain('last frame: never');
  });

  // The house NAME is text the house wrote too — it arrives verbatim off the
  // manifest and lands in a report that gets DM'd, and `renderCopy` escapes
  // nothing. One forged name otherwise writes whole fake rows.
  it('folds a multi-line house name onto one line and caps it', () => {
    const forged = [
      'Popclaw Home',
      '  last frame: never',
      '  official contact: attacker',
      `- Another House · other-slug`,
      'z'.repeat(400),
    ].join('\n');
    const out = renderHouseSection([{ ...fresh, houseName: forged }], opts);
    const nameLines = out.filter((l) => l.startsWith('- '));
    expect(nameLines).toHaveLength(1);
    expect(out.some((l) => l.startsWith('  last frame: never'))).toBe(false);
    expect(out.some((l) => l.startsWith('  official contact: attacker'))).toBe(false);
    expect(nameLines[0]!.length).toBeLessThan(200);
  });

  it('folds and caps house-supplied ETags too', () => {
    const out = renderHouseSection(
      [{ ...fresh, manifestEtag: `W/"m"\n  last frame: never`, guideEtag: 'g'.repeat(400) }],
      opts,
    );
    expect(out.some((l) => l.startsWith('  last frame: never'))).toBe(false);
    expect(out.find((l) => l.includes('handshake:'))!.length).toBeLessThan(400);
  });

  // The contact is text the HOUSE wrote, landing in a report that gets DM'd.
  it('folds a multi-line house contact onto one line and caps it', () => {
    const out = renderHouseSection(
      [{ ...fresh, officialContact: `someone\n  last frame: never\n${'x'.repeat(400)}` }],
      opts,
    ).join('\n');
    const lines = out.split('\n');
    const contactLines = lines.filter((l) => l.includes('official contact'));
    expect(contactLines).toHaveLength(1);
    // The forgery that matters is a LINE of its own; folded inline it is
    // plainly part of the contact value and cannot be mistaken for a finding.
    expect(lines.some((l) => l.startsWith('  last frame: never'))).toBe(false);
    expect(contactLines[0]!.length).toBeLessThan(200);
  });

  it('says the house list is unreadable rather than claiming zero houses', () => {
    expect(renderHouseSection(undefined, opts).join('\n')).toMatch(/could not read/i);
  });

  it('renders in zh-CN with no leaked copy keys', () => {
    const out = renderHouseSection([fresh, never], { ...opts, lang: 'zh-CN' }).join('\n');
    expect(out).not.toContain('doctor.file.f');
    expect(out).toContain('popclaw-me');
  });
});

describe('the house section is actually in the report, not merely renderable', () => {
  const input: DoctorCollectInput = {
    buildStamp: 'abc123',
    sigil: 'n3tzfhnt',
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v22.22.3',
    nowSec: 1_700_086_400,
    tz: 'UTC',
    lang: 'en',
    homeDir: '/Users/example',
    configReport: {
      cadencePath: '/Users/example/.openclaw/popclaw/config/cadence/cadence.json',
      cadenceFound: true,
      langTag: 'en',
      langSource: 'config',
      tz: 'UTC',
      tzConfigured: true,
    },
    withText: false,
    routing: {
      mode: 'wired',
      fireCount: 3,
      l2HitCount: 0,
      inboundCount: 0,
      envelopeSeen: 0,
      envelopeStripped: 0,
      lastFiredAt: 0,
      brokenLogged: false,
    },
    lastBuild: { build: 'abc123', recordedAt: 't' },
    integrityState: { social: { fingerprint: 'aa11bb22', build: 'abc123' } },
    toolsRegisteredCount: 39,
    hostToolsConfig: { profileSet: false, alsoAllowHasPlugins: false, toolsAllowCount: 0 },
    skillFilePresent: true,
    rawGatewayLogLines: [],
    logSources: [],
  };

  it('renders one row per mounted house', () => {
    const { markdown } = collectDoctorReport({
      ...input,
      houses: [
        { slug: 'popclaw-me', houseName: 'Popclaw Home', lastFrameAt: 1_700_000_000 },
        { slug: 'house-popclaw-world', lastFrameAt: null },
      ],
    });
    expect(markdown).toContain('## F');
    expect(markdown).toContain('Popclaw Home');
    expect(markdown).toContain('house-popclaw-world');
    expect(markdown).toContain('never handshaken');
    // The house section must not reintroduce a house address into a report
    // that gets DM'd (controller ruling 2026-09-13).
    expect(markdown).not.toContain(FRESH);
    expect(markdown).not.toContain(NEVER);
  });

  it('says the list is unreadable when the root supplied none', () => {
    expect(collectDoctorReport(input).markdown).toMatch(/could not read the mounted house list/i);
  });
});
