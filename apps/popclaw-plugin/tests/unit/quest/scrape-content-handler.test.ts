import { describe, expect, it } from 'vitest';
import { ScrapeContentHandler } from '../../../src/quest/scrape-content-handler.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { EventEgress, PushResult } from '../../../src/egress/event-egress.js';
import type { InboundEnvelope } from '../../../src/ingress/event-ingress.js';
import type { PlatformScraper, ScrapedPost } from '../../../src/scraper/platform-scraper.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { noDmCrypto } from '../../helpers/test-signer.js';

function realSigner(): Signer {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
  return {
    publicKey: async () => kp.publicKey,
    sign: async (b: Uint8Array) => nacl.sign.detached(b, kp.secretKey),
    popclawId: async () => bs58.encode(kp.publicKey),
    ...noDmCrypto,
  };
}

function dispatchEnvelope(taskId = 'tsk-sc'): InboundEnvelope {
  return {
    eventId: taskId,
    envelope: {
      questDispatch: { taskId },
      target: { targetIds: [] },
    },
  };
}

function decodeEnvelope(bytes: Uint8Array): {
  post?: {
    origin?: { url?: string; platform?: string };
    blocks?: Array<{ content?: string }>;
    media?: Array<{ kind?: number; url?: string; width?: number; height?: number }>;
  };
  questResult?: { outcome?: number; reason?: string };
} {
  const ns = popclaw as unknown as {
    identity: { SignedPayload: { decode(b: Uint8Array): { payload: Uint8Array } } };
    event: {
      EventEnvelope: {
        decode(b: Uint8Array): {
          post?: {
            origin?: { url?: string; platform?: string };
            blocks?: Array<{ content?: string }>;
            media?: Array<{ kind?: number; url?: string; width?: number; height?: number }>;
          };
          questResult?: { outcome?: number; reason?: string };
        };
      };
    };
  };
  const wrap = ns.identity.SignedPayload.decode(bytes);
  return ns.event.EventEnvelope.decode(wrap.payload);
}

function collectingEgress() {
  const pushes: Uint8Array[] = [];
  const egress: EventEgress = {
    push: async (b: Uint8Array): Promise<PushResult> => {
      pushes.push(b);
      return { status: 200, eventId: 'e' };
    },
  };
  return { pushes, egress };
}

const payload = {
  platform: 'twitter',
  handle: 'scrape-target',
  sinceTimestamp: 0,
  maxItems: 20,
};

describe('ScrapeContentHandler', () => {
  it('stub mode: no scraperRegistry → no feeds, single APPROVE QuestResult', async () => {
    const { pushes, egress } = collectingEgress();
    const h = new ScrapeContentHandler({ signer: realSigner(), egress });
    await h.handle(dispatchEnvelope(), payload);
    expect(pushes).toHaveLength(1);
    const env = decodeEnvelope(pushes[0]!);
    expect(env.questResult?.outcome).toBe(1); // APPROVE
    expect(env.post ?? null).toBeNull(); // pbjs returns null for unset oneof branches
  });

  it('scraperRegistry mode: emits one mirror Post per post + terminal APPROVE', async () => {
    const { pushes, egress } = collectingEgress();
    const posts: ScrapedPost[] = [
      { id: '100', text: 'first', createdAt: new Date('2026-04-20T10:00:00Z'), originalUrl: 'https://x.com/u/status/100' },
      { id: '101', text: 'second', createdAt: new Date('2026-04-21T10:00:00Z'), originalUrl: 'https://x.com/u/status/101' },
      { id: '102', text: 'third', createdAt: new Date('2026-04-22T10:00:00Z'), originalUrl: 'https://x.com/u/status/102' },
    ];
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: null,
        selfReplies: [],
        rawBytes: new Uint8Array(),
      }),
      scrapeTimeline: async () => posts,
    };
    const h = new ScrapeContentHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), payload);
    // 3 FeedPayload + 1 QuestResult
    // 3 mirror Posts + 1 QuestResult
    expect(pushes).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      const e = decodeEnvelope(pushes[i]!);
      expect(e.post?.origin?.url).toMatch(/https:\/\/x\.com\/u\/status\/10[012]/);
      expect(e.post?.blocks?.[0]?.content).toMatch(/^(first|second|third)$/);
    }
    const terminal = decodeEnvelope(pushes[3]!);
    expect(terminal.questResult?.outcome).toBe(1);
  });

  it('scraperRegistry mode: empty timeline → 0 feeds, terminal APPROVE with empty evidence', async () => {
    const { pushes, egress } = collectingEgress();
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: null,
        selfReplies: [],
        rawBytes: new Uint8Array(),
      }),
      scrapeTimeline: async () => [],
    };
    const h = new ScrapeContentHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), payload);
    expect(pushes).toHaveLength(1);
    expect(decodeEnvelope(pushes[0]!).questResult?.outcome).toBe(1);
  });

  it('scraperRegistry mode: throw → 0 feeds, terminal ABSTAIN with reason', async () => {
    const { pushes, egress } = collectingEgress();
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: null,
        selfReplies: [],
        rawBytes: new Uint8Array(),
      }),
      scrapeTimeline: async () => {
        throw new Error('ETIMEDOUT');
      },
    };
    const h = new ScrapeContentHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), payload);
    expect(pushes).toHaveLength(1);
    const qr = decodeEnvelope(pushes[0]!).questResult;
    expect(qr?.outcome).toBe(3); // ABSTAIN
    expect(qr?.reason).toContain('scrape failed');
  });

  it('scraped media flows into the mirror Post envelope (kind string → MediaAttachment enum)', async () => {
    const { pushes, egress } = collectingEgress();
    const posts: ScrapedPost[] = [
      {
        id: 'img1',
        text: '',
        createdAt: new Date('2026-04-20T10:00:00Z'),
        originalUrl: 'https://x.com/u/status/img1',
        media: [
          { kind: 'image', url: 'https://pbs.twimg.com/media/a.jpg', width: 2048, height: 1152 },
          { kind: 'video', url: 'https://pbs.twimg.com/media/v_thumb.jpg' },
          { kind: 'gif', url: 'https://pbs.twimg.com/media/g_thumb.jpg' },
        ],
      },
    ];
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: null,
        selfReplies: [],
        rawBytes: new Uint8Array(),
      }),
      scrapeTimeline: async () => posts,
    };
    const h = new ScrapeContentHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), payload);
    const env = decodeEnvelope(pushes[0]!);
    expect(env.post?.media).toHaveLength(3);
    expect(env.post?.media?.[0]?.url).toBe('https://pbs.twimg.com/media/a.jpg');
    // kind=IMAGE(0) elided on wire (Invariant #1); VIDEO=1 / GIF=2 present.
    expect(env.post?.media?.[0]?.kind ?? 0).toBe(0);
    expect(env.post?.media?.[0]?.width).toBe(2048);
    expect(env.post?.media?.[1]?.kind).toBe(1);
    expect(env.post?.media?.[2]?.kind).toBe(2);
  });

  it('house non-2xx receipt on a mirror post is logged as a permanent rejection, run continues', async () => {
    const logMessages: string[] = [];
    const pushes: Uint8Array[] = [];
    let call = 0;
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        call += 1;
        // First call = the mirror post push → 403 (validator rejection, permanent).
        // Second call = the terminal QuestResult push → accepted.
        return call === 1
          ? { status: 403, detail: 'Post must carry at least one ContentBlock or MediaAttachment' }
          : { status: 200, eventId: 'e' };
      },
    };
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: null,
        selfReplies: [],
        rawBytes: new Uint8Array(),
      }),
      scrapeTimeline: async () => [
        { id: 'p1', text: 'x', createdAt: new Date('2026-04-20T10:00:00Z'), originalUrl: 'https://x.com/u/status/p1' },
      ],
    };
    const h = new ScrapeContentHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
      loggerInfo: (msg) => logMessages.push(msg),
    });
    await h.handle(dispatchEnvelope(), payload);
    expect(pushes).toHaveLength(2); // rejected post + terminal QuestResult still pushed
    expect(logMessages.some((m) => m.includes('p1') && m.includes('permanently rejected') && m.includes('403'))).toBe(true);
    expect(decodeEnvelope(pushes[1]!).questResult?.outcome).toBe(1);
  });

  it('scraperRegistry: missing platform → 0 feeds, single APPROVE QuestResult (empty graceful miss)', async () => {
    const logMessages: string[] = [];
    const { pushes, egress } = collectingEgress();
    // Empty registry — no scraper for 'twitter'
    const h = new ScrapeContentHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map(),
      loggerInfo: (msg) => logMessages.push(msg),
    });
    await h.handle(dispatchEnvelope(), payload); // payload.platform = 'twitter'
    expect(pushes).toHaveLength(1);
    const env = decodeEnvelope(pushes[0]!);
    expect(env.questResult?.outcome).toBe(1); // APPROVE (empty graceful)
    // loggerInfo must mention the platform and handle
    expect(logMessages.some((m) => m.includes('twitter') && m.includes('scrape-target'))).toBe(true);
  });
});
