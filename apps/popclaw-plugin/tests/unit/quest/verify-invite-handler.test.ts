import { describe, expect, it } from 'vitest';
import {
  VerifyInviteHandler,
  createDefaultMock,
  type VerifyInviteMockHook,
} from '../../../src/quest/verify-invite-handler.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { EventEgress, PushResult } from '../../../src/egress/event-egress.js';
import type { InboundEnvelope } from '../../../src/ingress/event-ingress.js';
import type { PlatformScraper } from '../../../src/scraper/platform-scraper.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { noDmCrypto } from '../../helpers/test-signer.js';

function realSigner(): Signer {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  return {
    publicKey: async () => kp.publicKey,
    sign: async (b: Uint8Array) => nacl.sign.detached(b, kp.secretKey),
    popclawId: async () => bs58.encode(kp.publicKey),
    ...noDmCrypto,
  };
}

function dispatchEnvelope(taskId = 'tsk-1'): InboundEnvelope {
  return {
    eventId: taskId,
    envelope: {
      questDispatch: { taskId },
      target: { targetIds: [] },
    },
  };
}

function decodeQuestResult(bytes: Uint8Array): { outcome?: number; reason?: string; accountId?: string } {
  const ns = popclaw as unknown as {
    identity: { SignedPayload: { decode(b: Uint8Array): { payload: Uint8Array } } };
    event: {
      EventEnvelope: {
        decode(b: Uint8Array): { questResult?: { outcome?: number; reason?: string; accountId?: string } };
      };
    };
  };
  const wrap = ns.identity.SignedPayload.decode(bytes);
  const env = ns.event.EventEnvelope.decode(wrap.payload);
  return env.questResult ?? {};
}

describe('VerifyInviteHandler', () => {
  it('ABSTAINS when neither mock nor scraperRegistry is injected', async () => {
    const pushes: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    };
    const h = new VerifyInviteHandler({ signer: realSigner(), egress });
    await h.handle(dispatchEnvelope('tsk-a'), {
      platform: 'twitter',
      handle: 'u',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abcdef',
    });
    expect(pushes).toHaveLength(1);
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(3); // ABSTAIN
    expect(qr.reason).toContain('no scraper configured');
  });

  it('uses mock hook when injected', async () => {
    const pushes: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    };
    const mock: VerifyInviteMockHook = { decide: () => 'REJECT' };
    const h = new VerifyInviteHandler({ signer: realSigner(), egress, mock });
    await h.handle(dispatchEnvelope(), {
      platform: 'twitter',
      handle: 'u',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abcdef',
    });
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(2); // REJECT
  });

  it('scraperRegistry path: APPROVE when sigil is in firstPost.text', async () => {
    const pushes: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    };
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: {
          id: '100',
          text: 'popclaw → ranger#abcdef',
          createdAt: new Date('2026-04-20T00:00:00Z'),
        },
        selfReplies: [],
        rawBytes: new TextEncoder().encode('{"text":"popclaw ranger #abcdef"}'),
      }),
      scrapeTimeline: async () => [],
    };
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), {
      platform: 'twitter',
      handle: 'ranger',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abcdef',
    });
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1); // APPROVE
  });

  it('scraperRegistry path: REJECT when sigil is absent from firstPost + selfReplies', async () => {
    const pushes: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    };
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: {
          id: '100',
          text: 'totally unrelated post',
          createdAt: new Date('2026-04-20T00:00:00Z'),
        },
        selfReplies: [
          {
            id: '101',
            text: 'no sigil here either',
            createdAt: new Date('2026-04-20T00:01:00Z'),
            parentPostId: '100',
          },
        ],
        rawBytes: new TextEncoder().encode('{"text":"totally unrelated post"}'),
      }),
      scrapeTimeline: async () => [],
    };
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), {
      platform: 'twitter',
      handle: 'ranger',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abcdef',
    });
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(2); // REJECT
    expect(qr.reason).toContain('ranger#abcdef not in firstPost/selfReplies');
  });

  it('scraperRegistry path: ABSTAIN when fetch throws (network error)', async () => {
    const pushes: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    };
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => {
        throw new Error('ECONNREFUSED');
      },
      scrapeTimeline: async () => [],
    };
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), {
      platform: 'twitter',
      handle: 'ranger',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abcdef',
    });
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(3); // ABSTAIN
    expect(qr.reason).toContain('scrape failed');
  });

  it('mock precedence: mock wins even when scraperRegistry is also injected', async () => {
    const pushes: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    };
    const mock: VerifyInviteMockHook = { decide: () => 'APPROVE' };
    const scraperCallCount = { count: 0 };
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => {
        scraperCallCount.count++;
        throw new Error('scraper should not be called');
      },
      scrapeTimeline: async () => [],
    };
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      mock,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), {
      platform: 'twitter',
      handle: 'ranger',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abcdef',
    });
    expect(scraperCallCount.count).toBe(0);
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1); // APPROVE
  });

  it('scraperRegistry: ABSTAIN when no scraper registered for the payload platform', async () => {
    const logMessages: string[] = [];
    const pushes: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    };
    // Empty registry — no scraper for 'x'
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map(),
      loggerInfo: (msg) => logMessages.push(msg),
    });
    await h.handle(dispatchEnvelope('tsk-missing'), {
      platform: 'x',
      handle: 'ranger123',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abcdef',
    });
    expect(pushes).toHaveLength(1);
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(3); // ABSTAIN
    // loggerInfo must mention the platform and handle
    expect(logMessages.some((m) => m.includes('x') && m.includes('ranger123'))).toBe(true);
  });

  it('createDefaultMock() returns a hook when env var is set', () => {
    const prev = process.env.POPCLAW_VERIFY_STUB_OUTCOME;
    try {
      process.env.POPCLAW_VERIFY_STUB_OUTCOME = 'abstain';
      const hook = createDefaultMock();
      expect(hook).toBeDefined();
      expect(hook!.decide({})).toBe('ABSTAIN');
    } finally {
      if (prev === undefined) delete process.env.POPCLAW_VERIFY_STUB_OUTCOME;
      else process.env.POPCLAW_VERIFY_STUB_OUTCOME = prev;
    }
  });

  it('createDefaultMock() returns undefined when env var is unset or invalid', () => {
    const prev = process.env.POPCLAW_VERIFY_STUB_OUTCOME;
    try {
      delete process.env.POPCLAW_VERIFY_STUB_OUTCOME;
      expect(createDefaultMock()).toBeUndefined();
      process.env.POPCLAW_VERIFY_STUB_OUTCOME = 'NOT_AN_OUTCOME';
      expect(createDefaultMock()).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.POPCLAW_VERIFY_STUB_OUTCOME;
      else process.env.POPCLAW_VERIFY_STUB_OUTCOME = prev;
    }
  });

  // ADR-0025 task 4.3: verify flow captures platform account_id
  it('scraperRegistry path: questResult carries accountId from VerificationTargets', async () => {
    const pushes: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    };
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: {
          id: '100',
          text: 'popclaw → elonmusk#abcdef',
          createdAt: new Date('2026-04-20T00:00:00Z'),
        },
        selfReplies: [],
        rawBytes: new TextEncoder().encode('{"text":"popclaw → elonmusk#abcdef"}'),
        accountId: '44196397', // X rest_id
      }),
      scrapeTimeline: async () => [],
    };
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), {
      platform: 'twitter',
      handle: 'elonmusk',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abcdef',
    });
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(1); // APPROVE
    expect(qr.accountId).toBe('44196397');
  });

  it('scraperRegistry path: questResult omits accountId when scraper does not provide it', async () => {
    const pushes: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (b: Uint8Array): Promise<PushResult> => {
        pushes.push(b);
        return { status: 200, eventId: 'e' };
      },
    };
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: {
          id: '100',
          text: 'popclaw → ranger#abcdef',
          createdAt: new Date('2026-04-20T00:00:00Z'),
        },
        selfReplies: [],
        rawBytes: new TextEncoder().encode('raw'),
        // no accountId field — older scraper
      }),
      scrapeTimeline: async () => [],
    };
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), {
      platform: 'twitter',
      handle: 'ranger',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abcdef',
    });
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(1); // APPROVE
    // proto3 default: empty string decodes as undefined/missing
    expect(!qr.accountId || qr.accountId === '').toBe(true);
  });
});
