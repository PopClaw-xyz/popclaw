import { describe, it, expect } from 'vitest';
import { buildScraperRegistryFor } from '../../../src/runtime/ranger';
import { HybridScraper } from '../../../src/scraper/hybrid-scraper';
import { ApifyActorScraper } from '../../../src/scraper/commercial/apify-actor-scraper';
import { ScrapTikScraper } from '../../../src/scraper/commercial/apify-tiktok';
import { DegradationDetector } from '../../../src/scraper/commercial/degradation-detector';

describe('buildScraperRegistryFor', () => {
  describe('x-platform (commercial-only: TwitterAPI.io + Apify)', () => {
    it('backendOverride=apify (X only) → x: ApifyActorScraper', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: 'apify', apifyToken: 'tok', twitterApiIoKey: undefined, youtubeApiKey: undefined });
      expect(r.get('x')).toBeInstanceOf(ApifyActorScraper);
    });

    it('backendOverride=apify but no apifyToken → throws', async () => {
      await expect(
        buildScraperRegistryFor({ backendOverride: 'apify', apifyToken: undefined, twitterApiIoKey: undefined, youtubeApiKey: undefined }),
      ).rejects.toThrow(/POPCLAW_APIFY_TOKEN/);
    });

    it('backendOverride=twitterapi_io → x: DegradationDetector(TwitterApiIoScraper)', async () => {
      // Plan 10.13.x: TwitterAPI.io is always wrapped with a DegradationDetector
      // so silent provider outages can trip even without an autoselected fallback;
      // an operator using --backend twitterapi_io still sees the failover warn line.
      const r = await buildScraperRegistryFor({ backendOverride: 'twitterapi_io', apifyToken: undefined, twitterApiIoKey: 'k', youtubeApiKey: undefined });
      expect(r.get('x')).toBeInstanceOf(DegradationDetector);
    });

    it('backendOverride=twitterapi_io but no key → throws', async () => {
      await expect(
        buildScraperRegistryFor({ backendOverride: 'twitterapi_io', apifyToken: undefined, twitterApiIoKey: undefined, youtubeApiKey: undefined }),
      ).rejects.toThrow(/POPCLAW_TWITTERAPI_IO_KEY/);
    });

    it('legacy/unsupported backendOverride (e.g. playwright) → throws clear error', async () => {
      await expect(
        buildScraperRegistryFor({ backendOverride: 'playwright', apifyToken: 'tok', twitterApiIoKey: 'k', youtubeApiKey: undefined }),
      ).rejects.toThrow(/unsupported X backend 'playwright' — only twitterapi_io\/apify remain/);
    });

    it('auto + twitterapi_io only → x: HybridScraper(TwitterApiIo, no fallback)', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: undefined, twitterApiIoKey: 'k', youtubeApiKey: undefined });
      expect(Array.from(r.keys())).toEqual(['x']);
      expect(r.get('x')).toBeInstanceOf(HybridScraper);
    });

    it('auto + apify only → x: HybridScraper(apifyTwitter)', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: 'tok', twitterApiIoKey: undefined, youtubeApiKey: undefined });
      expect(r.get('x')).toBeInstanceOf(HybridScraper);
    });

    it('auto + no creds → no x key (undefined, no Playwright last-resort)', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: undefined, twitterApiIoKey: undefined, youtubeApiKey: undefined });
      expect(Array.from(r.keys())).toEqual([]);
      expect(r.get('x')).toBeUndefined();
    });
  });

  describe('ADR-0034: proof path capability survives production wiring', () => {
    // Optional interface methods vanish silently through hand-written decorators —
    // exactly the gap that shipped the proof path dead the first time. These
    // assertions run against the REAL registry wiring, not hand-rolled stubs.
    it('backendOverride=twitterapi_io → registry x scraper exposes fetchPostById through DegradationDetector', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: 'twitterapi_io', apifyToken: undefined, twitterApiIoKey: 'k', youtubeApiKey: undefined });
      expect(typeof r.get('x')!.fetchPostById).toBe('function');
    });

    it('auto + twitterapi_io (hybrid wiring) → fetchPostById resolves to the twitterapi delegate, not the no-delegate throw', async () => {
      // Stub network BEFORE building: TwitterApiIoScraper captures globalThis.fetch
      // at construction. If delegate selection is broken, the call throws the
      // wiring error before any fetch; a real delegate reaches our stub instead.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ tweets: [] }))) as unknown as typeof globalThis.fetch;
      try {
        const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: 'tok', twitterApiIoKey: 'k', youtubeApiKey: undefined });
        const x = r.get('x')!;
        expect(typeof x.fetchPostById).toBe('function');
        const res = await x.fetchPostById!('123');
        expect(res.post).toBeNull(); // reached the twitterapi delegate + our stub
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('apify-only wiring: fetchPostById exists on hybrid but reports no delegate (documented v1 gap)', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: 'tok', twitterApiIoKey: undefined, youtubeApiKey: undefined });
      await expect(r.get('x')!.fetchPostById!('123')).rejects.toThrow('no delegate implements fetchPostById');
    });
  });

  describe('ADR-0040: author-profile snapshot survives production wiring', () => {
    // Same trap as the proof path above: an optional method silently dropped by a
    // hand-written decorator ships the snapshot dead. Assert on the REAL wiring.
    it('backendOverride=twitterapi_io → registry x scraper exposes fetchAuthorProfile through DegradationDetector', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: 'twitterapi_io', apifyToken: undefined, twitterApiIoKey: 'k', youtubeApiKey: undefined });
      expect(typeof r.get('x')!.fetchAuthorProfile).toBe('function');
    });

    it('auto + twitterapi_io (hybrid wiring) → fetchAuthorProfile reaches the twitterapi delegate', async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ status: 'success', data: { followers: 42, profilePicture: 'https://pic', description: 'bio' } }),
        )) as unknown as typeof globalThis.fetch;
      try {
        const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: 'tok', twitterApiIoKey: 'k', youtubeApiKey: undefined });
        const x = r.get('x')!;
        expect(typeof x.fetchAuthorProfile).toBe('function');
        expect(await x.fetchAuthorProfile!('blackfeather_ai')).toEqual({
          followerCount: 42,
          avatarUrl: 'https://pic',
          bio: 'bio',
        });
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('apify-only wiring: fetchAuthorProfile resolves null (documented v1 gap, never throws)', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: 'tok', twitterApiIoKey: undefined, youtubeApiKey: undefined });
      await expect(r.get('x')!.fetchAuthorProfile!('blackfeather_ai')).resolves.toBeNull();
    });
  });

  describe('multi-platform registry enablement', () => {
    it('apify token enables ig + tiktok keys (alongside x)', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: 'tok', twitterApiIoKey: undefined, youtubeApiKey: undefined });
      expect(Array.from(r.keys()).sort()).toEqual(['instagram', 'tiktok', 'x']);
      expect(r.get('instagram')).toBeInstanceOf(ApifyActorScraper);
      expect(r.get('tiktok')).toBeInstanceOf(ScrapTikScraper);
    });

    it('twitterapi_io key only → only x key', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: undefined, twitterApiIoKey: 'k', youtubeApiKey: undefined });
      expect(Array.from(r.keys())).toEqual(['x']);
    });

    it('apify + twitterapi_io → x via TwitterApiIo (fallback apifyTwitter), ig/tiktok via Apify', async () => {
      const r = await buildScraperRegistryFor({ backendOverride: undefined, apifyToken: 'a', twitterApiIoKey: 'k', youtubeApiKey: undefined });
      expect(Array.from(r.keys()).sort()).toEqual(['instagram', 'tiktok', 'x']);
      expect(r.get('x')).toBeInstanceOf(HybridScraper);   // twitterapi_io primary, apify fallback
      expect(r.get('instagram')).toBeInstanceOf(ApifyActorScraper);
      expect(r.get('tiktok')).toBeInstanceOf(ScrapTikScraper);
    });

    it('enabledPlatforms subset filters output (e.g. only x requested)', async () => {
      const r = await buildScraperRegistryFor({
        backendOverride: undefined,
        apifyToken: 'tok', twitterApiIoKey: undefined, youtubeApiKey: undefined,
        enabledPlatforms: ['x'],
      });
      expect(Array.from(r.keys())).toEqual(['x']);
    });

    it('youtube key enables youtube registry entry', async () => {
      const r = await buildScraperRegistryFor({
        backendOverride: undefined,
        apifyToken: undefined,
        twitterApiIoKey: 'k',
        youtubeApiKey: 'yk',
      });
      const keys = Array.from(r.keys()).sort();
      expect(keys).toContain('youtube');
      expect(keys).toContain('x');
      const { YoutubeDataApiScraper } = await import('../../../src/scraper/commercial/youtube-data-api-scraper');
      expect(r.get('youtube')).toBeInstanceOf(YoutubeDataApiScraper);
    });

    it('no youtube key → no youtube key in registry', async () => {
      const r = await buildScraperRegistryFor({
        backendOverride: undefined,
        apifyToken: 'tok',
        twitterApiIoKey: undefined,
        youtubeApiKey: undefined,
      });
      expect(Array.from(r.keys()).sort()).not.toContain('youtube');
    });
  });
});
