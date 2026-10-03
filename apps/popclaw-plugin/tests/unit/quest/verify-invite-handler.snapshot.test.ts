/**
 * ADR-0040 — 认证瞬间快照（QuestResult 7/8/9）。
 *
 * 三条铁律：APPROVE 才取；取失败照样 APPROVE（零值上报）；非 APPROVE 一分不花。
 */
import { describe, expect, it, vi } from 'vitest';
import { VerifyInviteHandler } from '../../../src/quest/verify-invite-handler.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { EventEgress, PushResult } from '../../../src/egress/event-egress.js';
import type { InboundEnvelope } from '../../../src/ingress/event-ingress.js';
import type { PlatformScraper } from '../../../src/scraper/platform-scraper.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { noDmCrypto } from '../../helpers/test-signer.js';

function realSigner(): Signer {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
  return {
    publicKey: async () => kp.publicKey,
    sign: async (b: Uint8Array) => nacl.sign.detached(b, kp.secretKey),
    popclawId: async () => bs58.encode(kp.publicKey),
    ...noDmCrypto,
  };
}

function dispatchEnvelope(taskId = 'tsk-snap'): InboundEnvelope {
  return { eventId: taskId, envelope: { questDispatch: { taskId }, target: { targetIds: [] } } };
}

function decodeQuestResult(bytes: Uint8Array): {
  outcome?: number;
  followerCount?: unknown;
  avatarUrl?: string;
  bio?: string;
} {
  const ns = popclaw as unknown as {
    identity: { SignedPayload: { decode(b: Uint8Array): { payload: Uint8Array } } };
    event: { EventEnvelope: { decode(b: Uint8Array): { questResult?: Record<string, unknown> } } };
  };
  const wrap = ns.identity.SignedPayload.decode(bytes);
  return (ns.event.EventEnvelope.decode(wrap.payload).questResult ?? {}) as never;
}

function collector(): { pushes: Uint8Array[]; egress: EventEgress } {
  const pushes: Uint8Array[] = [];
  return {
    pushes,
    egress: {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    },
  };
}

const PAYLOAD = { platform: 'x', handle: 'ranger', expectedSigil: 'abcdef' };

function scraperWith(
  firstPostText: string,
  fetchAuthorProfile?: PlatformScraper['fetchAuthorProfile'],
): PlatformScraper {
  return {
    fetchVerificationTargets: async () => ({
      firstPost: { id: '1', text: firstPostText, createdAt: new Date('2026-07-27T00:00:00Z') },
      selfReplies: [],
      rawBytes: new TextEncoder().encode(firstPostText),
    }),
    scrapeTimeline: async () => [],
    ...(fetchAuthorProfile ? { fetchAuthorProfile } : {}),
  };
}

describe('VerifyInviteHandler snapshot (ADR-0040)', () => {
  it('APPROVE carries followerCount / avatarUrl / bio from the snapshot', async () => {
    const { pushes, egress } = collector();
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([
        ['x', scraperWith('my ranger#abcdef post', async () => ({
          followerCount: 30281,
          avatarUrl: 'https://pbs.twimg.com/a.jpg',
          bio: '江湖游侠',
        }))],
      ]),
    });
    await h.handle(dispatchEnvelope(), PAYLOAD);
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(1);
    expect(Number(qr.followerCount)).toBe(30281);
    expect(qr.avatarUrl).toBe('https://pbs.twimg.com/a.jpg');
    expect(qr.bio).toBe('江湖游侠');
  });

  it('snapshot throwing does NOT block the APPROVE (zero values, fields elided)', async () => {
    const { pushes, egress } = collector();
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([
        ['x', scraperWith('my ranger#abcdef post', async () => {
          throw new Error('ECONNRESET');
        })],
      ]),
    });
    await h.handle(dispatchEnvelope(), PAYLOAD);
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(1); // APPROVE stands
    expect(Number(qr.followerCount ?? 0)).toBe(0);
    expect(qr.avatarUrl ?? '').toBe('');
    expect(qr.bio ?? '').toBe('');
  });

  it('REJECT never calls user/info (no snapshot spend on a failed verification)', async () => {
    const { pushes, egress } = collector();
    const profile = vi.fn(async () => ({ followerCount: 1, avatarUrl: 'a', bio: 'b' }));
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraperWith('unrelated post', profile)]]),
    });
    await h.handle(dispatchEnvelope(), PAYLOAD);
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(2); // REJECT
    expect(profile).not.toHaveBeenCalled();
  });

  it('a scraper without fetchAuthorProfile still APPROVEs (optional capability)', async () => {
    const { pushes, egress } = collector();
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraperWith('my ranger#abcdef post')]]),
    });
    await h.handle(dispatchEnvelope(), PAYLOAD);
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1);
  });
});
