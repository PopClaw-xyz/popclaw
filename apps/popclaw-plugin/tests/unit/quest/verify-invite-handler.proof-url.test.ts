/**
 * ADR-0034 — proof-URL direct-fetch verification path.
 *
 * The URL is an untrusted pointer: only the `/status/<digits>` id is read from
 * it, everything else (author, text) comes back from the provider's by-id
 * response. Any failure of the proof path silently falls back to the legacy
 * search path — only when BOTH fail does the ranger emit REJECT/ABSTAIN.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  VerifyInviteHandler,
  extractPostId,
} from '../../../src/quest/verify-invite-handler.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { EventEgress, PushResult } from '../../../src/egress/event-egress.js';
import type { InboundEnvelope } from '../../../src/ingress/event-ingress.js';
import type { PlatformScraper, FetchedPost } from '../../../src/scraper/platform-scraper.js';
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

function dispatchEnvelope(taskId = 'tsk-proof'): InboundEnvelope {
  return {
    eventId: taskId,
    envelope: { questDispatch: { taskId }, target: { targetIds: [] } },
  };
}

function decodeQuestResult(bytes: Uint8Array): {
  outcome?: number;
  reason?: string;
  accountId?: string;
  evidenceHash?: Uint8Array;
} {
  const ns = popclaw as unknown as {
    identity: { SignedPayload: { decode(b: Uint8Array): { payload: Uint8Array } } };
    event: {
      EventEnvelope: {
        decode(b: Uint8Array): {
          questResult?: {
            outcome?: number;
            reason?: string;
            accountId?: string;
            evidenceHash?: Uint8Array;
          };
        };
      };
    };
  };
  const wrap = ns.identity.SignedPayload.decode(bytes);
  return ns.event.EventEnvelope.decode(wrap.payload).questResult ?? {};
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

const PROOF_BYTES = new TextEncoder().encode('{"tweets":[{"id":"999","text":"ranger#abcdef"}]}');

function proofScraper(over: Partial<FetchedPost> = {}, searchText = 'nothing here'): PlatformScraper {
  return {
    fetchPostById: async () => ({
      post: { id: '999', text: 'hello ranger#abcdef come play', createdAt: new Date('2026-07-26T00:00:00Z') },
      rawBytes: PROOF_BYTES,
      accountId: '44196397',
      authorHandle: 'Ranger',
      ...over,
    }),
    fetchVerificationTargets: async () => ({
      firstPost: { id: '1', text: searchText, createdAt: new Date('2026-07-01T00:00:00Z') },
      selfReplies: [],
      rawBytes: new TextEncoder().encode(searchText),
    }),
    scrapeTimeline: async () => [],
  };
}

const PAYLOAD = {
  platform: 'twitter',
  handle: 'ranger',
  applicantPopclawId: new Uint8Array(32),
  expectedSigil: 'abcdef',
};

describe('extractPostId (ADR-0034)', () => {
  it('accepts canonical x.com / twitter.com status URLs', () => {
    expect(extractPostId('https://x.com/ranger/status/1948123456789012345')).toBe('1948123456789012345');
    expect(extractPostId('https://twitter.com/ranger/status/123')).toBe('123');
  });

  it('tolerates query strings, fragments, trailing slash and sub-paths', () => {
    expect(extractPostId('https://x.com/ranger/status/123?s=20&t=abc')).toBe('123');
    expect(extractPostId('https://x.com/ranger/status/123/')).toBe('123');
    expect(extractPostId('https://x.com/ranger/status/123/photo/1')).toBe('123');
    expect(extractPostId('https://x.com/ranger/status/123#anchor')).toBe('123');
  });

  it('rejects URLs without a numeric /status/ segment', () => {
    expect(extractPostId('https://x.com/ranger')).toBeNull();
    expect(extractPostId('https://x.com/ranger/status/abc')).toBeNull();
    expect(extractPostId('https://x.com/ranger/statuses/123')).toBeNull();
    expect(extractPostId('not a url at all')).toBeNull();
    expect(extractPostId('')).toBeNull();
  });

  it('ignores /status/ smuggled into the query string (path only)', () => {
    expect(extractPostId('https://evil.example/?u=https://x.com/a/status/123')).toBeNull();
  });

  it('rejects non-http(s) schemes', () => {
    expect(extractPostId('javascript:/status/123')).toBeNull();
    expect(extractPostId('file:///status/123')).toBeNull();
  });
});

describe('VerifyInviteHandler proof-URL path (ADR-0034)', () => {
  it('APPROVES on author match + bound token, with evidence hashed from the by-id bytes', async () => {
    const { pushes, egress } = collector();
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', proofScraper()]]),
    });
    await h.handle(dispatchEnvelope(), {
      ...PAYLOAD,
      proofUrl: 'https://x.com/Ranger/status/999',
    });
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(1); // APPROVE
    expect(qr.accountId).toBe('44196397');
    expect(Buffer.from(qr.evidenceHash!)).toEqual(createHash('sha256').update(PROOF_BYTES).digest());
  });

  it('does not consult the search path when the proof holds', async () => {
    const { pushes, egress } = collector();
    const scraper = proofScraper();
    const spy = vi.fn(scraper.fetchVerificationTargets);
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', { ...scraper, fetchVerificationTargets: spy }]]),
    });
    await h.handle(dispatchEnvelope(), { ...PAYLOAD, proofUrl: 'https://x.com/Ranger/status/999' });
    expect(spy).not.toHaveBeenCalled();
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1);
  });

  it('falls back to the search path when the by-id author is somebody else', async () => {
    const { pushes, egress } = collector();
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      // search path DOES carry the token → APPROVE via fallback
      scraperRegistry: new Map([['x', proofScraper({ authorHandle: 'impostor' }, 'my ranger#abcdef post')]]),
    });
    await h.handle(dispatchEnvelope(), { ...PAYLOAD, proofUrl: 'https://x.com/ranger/status/999' });
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1); // APPROVE (search path)
  });

  it('REJECTS when the proof author is wrong AND the search path has no token', async () => {
    const { pushes, egress } = collector();
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', proofScraper({ authorHandle: 'impostor' }, 'unrelated')]]),
    });
    await h.handle(dispatchEnvelope(), { ...PAYLOAD, proofUrl: 'https://x.com/ranger/status/999' });
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(2); // REJECT
    expect(qr.reason).toContain('ranger#abcdef not in firstPost/selfReplies');
    // P6: the proof-miss cause must reach the server-side audit trail.
    expect(qr.reason).toContain("proof: author 'impostor' != 'ranger'");
  });

  it('falls back when the proof post lacks the bound token', async () => {
    const { pushes, egress } = collector();
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([
        ['x', proofScraper({ post: { id: '999', text: 'no token', createdAt: new Date() } }, 'unrelated')],
      ]),
    });
    await h.handle(dispatchEnvelope(), { ...PAYLOAD, proofUrl: 'https://x.com/ranger/status/999' });
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(2); // REJECT
  });

  it('falls back when the by-id fetch returns no post', async () => {
    const { pushes, egress } = collector();
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', proofScraper({ post: null }, 'my ranger#abcdef post')]]),
    });
    await h.handle(dispatchEnvelope(), { ...PAYLOAD, proofUrl: 'https://x.com/ranger/status/999' });
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1); // APPROVE via search
  });

  it('falls back when the by-id fetch throws (search still ABSTAINs on its own failure)', async () => {
    const { pushes, egress } = collector();
    const scraper: PlatformScraper = {
      fetchPostById: async () => {
        throw new Error('ECONNRESET');
      },
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
    await h.handle(dispatchEnvelope(), { ...PAYLOAD, proofUrl: 'https://x.com/ranger/status/999' });
    const qr = decodeQuestResult(pushes[0]!);
    expect(qr.outcome).toBe(3); // ABSTAIN
    expect(qr.reason).toContain('scrape failed');
  });

  it('falls back when the scraper has no fetchPostById at all', async () => {
    const { pushes, egress } = collector();
    const scraper: PlatformScraper = {
      fetchVerificationTargets: async () => ({
        firstPost: { id: '1', text: 'ranger#abcdef', createdAt: new Date() },
        selfReplies: [],
        rawBytes: new TextEncoder().encode('ranger#abcdef'),
      }),
      scrapeTimeline: async () => [],
    };
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', scraper]]),
    });
    await h.handle(dispatchEnvelope(), { ...PAYLOAD, proofUrl: 'https://x.com/ranger/status/999' });
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1);
  });

  it('an unparsable proof URL is simply ignored (search path decides)', async () => {
    const { pushes, egress } = collector();
    const byId = vi.fn();
    const scraper = proofScraper({}, 'unrelated');
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', { ...scraper, fetchPostById: byId }]]),
    });
    await h.handle(dispatchEnvelope(), { ...PAYLOAD, proofUrl: 'https://x.com/ranger' });
    expect(byId).not.toHaveBeenCalled();
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(2); // REJECT via search
  });

  it('empty proofUrl leaves the legacy search behaviour untouched', async () => {
    const { pushes, egress } = collector();
    const byId = vi.fn();
    const scraper = proofScraper({}, 'my ranger#abcdef post');
    const h = new VerifyInviteHandler({
      signer: realSigner(),
      egress,
      scraperRegistry: new Map([['x', { ...scraper, fetchPostById: byId }]]),
    });
    await h.handle(dispatchEnvelope(), { ...PAYLOAD, proofUrl: '' });
    expect(byId).not.toHaveBeenCalled();
    expect(decodeQuestResult(pushes[0]!).outcome).toBe(1);
  });
});
