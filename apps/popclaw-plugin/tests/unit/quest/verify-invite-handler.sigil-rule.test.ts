import { describe, expect, it, vi } from 'vitest';
import { VerifyInviteHandler } from '../../../src/quest/verify-invite-handler.js';
import type {
  PlatformScraper,
  VerificationTargets,
} from '../../../src/scraper/platform-scraper.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { EventEgress, PushResult } from '../../../src/egress/event-egress.js';
import type { InboundEnvelope } from '../../../src/ingress/event-ingress.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { noDmCrypto } from '../../helpers/test-signer.js';

function realSigner(): Signer {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
  return {
    publicKey: async () => kp.publicKey,
    sign: async (b: Uint8Array) => nacl.sign.detached(b, kp.secretKey),
    popclawId: async () => bs58.encode(kp.publicKey),
    ...noDmCrypto,
  };
}

function dispatchEnvelope(taskId = 'tsk-sig'): InboundEnvelope {
  return {
    eventId: taskId,
    envelope: {
      questDispatch: { taskId },
      target: { targetIds: [] },
    },
  };
}

function decodeQuestResult(bytes: Uint8Array): { outcome?: number; reason?: string } {
  const ns = popclaw as unknown as {
    identity: { SignedPayload: { decode(b: Uint8Array): { payload: Uint8Array } } };
    event: {
      EventEnvelope: {
        decode(b: Uint8Array): { questResult?: { outcome?: number; reason?: string } };
      };
    };
  };
  const wrap = ns.identity.SignedPayload.decode(bytes);
  const env = ns.event.EventEnvelope.decode(wrap.payload);
  return env.questResult ?? {};
}

function buildTargets(p: Partial<VerificationTargets>): VerificationTargets {
  return {
    firstPost: p.firstPost ?? null,
    selfReplies: p.selfReplies ?? [],
    rawBytes: p.rawBytes ?? new Uint8Array([7, 7, 7]),
  };
}

function makeHandler(targets: VerificationTargets | Error) {
  const scraper: PlatformScraper = {
    fetchVerificationTargets: vi.fn().mockImplementation(() => {
      if (targets instanceof Error) return Promise.reject(targets);
      return Promise.resolve(targets);
    }),
    scrapeTimeline: vi.fn().mockResolvedValue([]),
  };
  const pushes: Uint8Array[] = [];
  const egress: EventEgress = {
    push: async (b: Uint8Array): Promise<PushResult> => {
      pushes.push(b);
      return { status: 200, eventId: 'e' };
    },
  };
  return {
    handler: new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    }),
    pushes,
  };
}

const samplePayload = {
  platform: 'twitter',
  handle: 'blackfeather_ai',
  applicantPopclawId: new Uint8Array(32),
  expectedSigil: '4d83f9',
};

describe('VerifyInviteHandler — bound-token rule (handle#sigil in firstPost or selfReplies)', () => {
  it('APPROVE when handle#sigil appears in firstPost.text', async () => {
    const { handler, pushes } = makeHandler(
      buildTargets({
        firstPost: { id: '1', text: 'on popclaw → blackfeather_ai#4d83f9 join me', createdAt: new Date() },
      }),
    );
    await handler.handle(dispatchEnvelope(), samplePayload);
    expect(pushes).toHaveLength(1);
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1); // APPROVE
  });

  it('APPROVE when handle#sigil appears in one of the selfReplies', async () => {
    const { handler, pushes } = makeHandler(
      buildTargets({
        firstPost: { id: '1', text: 'no token here', createdAt: new Date() },
        selfReplies: [
          { id: '2', text: 'reply 1', createdAt: new Date(), parentPostId: '1' },
          { id: '3', text: 'check blackfeather_ai#4d83f9 now', createdAt: new Date(), parentPostId: '1' },
        ],
      }),
    );
    await handler.handle(dispatchEnvelope(), samplePayload);
    expect(pushes).toHaveLength(1);
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1); // APPROVE
  });

  it('APPROVE is case-insensitive on handle and sigil (X handles are)', async () => {
    const { handler, pushes } = makeHandler(
      buildTargets({
        firstPost: { id: '1', text: 'Hello @Blackfeather_AI#4D83F9 !', createdAt: new Date() },
      }),
    );
    await handler.handle(dispatchEnvelope(), samplePayload);
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1); // APPROVE
  });

  // SECURITY: the whole point of binding the handle. A bare sigil with no
  // handle binding must NOT verify — that's the quote-tweet/repost replay hole.
  it('REJECT a bare sigil with no handle binding (anti-replay)', async () => {
    const { handler, pushes } = makeHandler(
      buildTargets({
        firstPost: { id: '1', text: 'random tweet mentioning 4d83f9 somewhere', createdAt: new Date() },
      }),
    );
    await handler.handle(dispatchEnvelope(), samplePayload);
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(2); // REJECT
    expect(qr.reason).toContain('blackfeather_ai#4d83f9');
  });

  // SECURITY: quoting/reposting SOMEONE ELSE's invite carries the original
  // author's handle, not the claimed one → must REJECT.
  it('REJECT a quoted token bound to a different handle (anti-replay)', async () => {
    const { handler, pushes } = makeHandler(
      buildTargets({
        firstPost: { id: '1', text: 'RT someone: rival_acct#4d83f9 nice', createdAt: new Date() },
      }),
    );
    await handler.handle(dispatchEnvelope(), samplePayload);
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(2); // REJECT
  });

  it('ABSTAIN when fetchVerificationTargets throws', async () => {
    const { handler, pushes } = makeHandler(new Error('network down'));
    await handler.handle(dispatchEnvelope(), samplePayload);
    expect(pushes).toHaveLength(1);
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(3); // ABSTAIN
    expect(qr.reason).toContain('scrape failed');
  });

  it('APPROVE when firstPost is null and handle#sigil is in selfReplies only', async () => {
    const { handler, pushes } = makeHandler(
      buildTargets({
        firstPost: null,
        selfReplies: [
          { id: '2', text: 'blackfeather_ai#4d83f9 here', createdAt: new Date(), parentPostId: '1' },
        ],
      }),
    );
    await handler.handle(dispatchEnvelope(), samplePayload);
    expect(pushes).toHaveLength(1);
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1); // APPROVE
  });
});
