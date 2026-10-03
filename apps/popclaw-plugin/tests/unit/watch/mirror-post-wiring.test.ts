/**
 * ADR-0025 Task 4.2: Post+Origin envelope wiring test.
 *
 * Verifies that buildMirrorPost + signEnvelope produce a signed EventEnvelope
 * whose body is `post` (not `feed`), with an Origin carrying the correct
 * platform/postId/url/createdAt/replyToId fields from the scrape result.
 *
 * This mirrors exactly what ranger.ts pushFeedFromWatch does:
 *   1. Build Post+Origin via buildMirrorPost.
 *   2. Wrap in EventEnvelope with actor (platform lives on post.origin).
 *   3. Sign via signEnvelope.
 *   4. Push to egress as SignedPayload bytes.
 *
 * We decode the bytes here to assert the wire shape.
 */

import { describe, it, expect } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { buildMirrorPost } from '../../../src/watch/feed-builder.js';
import { signEnvelope } from '../../../src/identity/sign-envelope.js';
import { makeTestSigner } from '../../helpers/test-signer.js';

type Ns = {
  identity: {
    SignedPayload: {
      decode(b: Uint8Array): { payload: Uint8Array };
    };
  };
  event: {
    EventEnvelope: {
      decode(b: Uint8Array): {
        post?: {
          blocks?: Array<{ content?: string; blockType?: number }>;
          media?: Array<{ kind?: number; url?: string }>;
          origin?: {
            platform?: string;
            postId?: string;
            url?: string;
            createdAt?: number | { toNumber(): number };
            replyToId?: string;
          };
        };
        feed?: unknown;
        platform?: string;
        actor?: { popclawId?: string };
      };
    };
  };
};

// Long from protobufjs may be a Long object or number depending on the value.
function longToNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof (v as { toNumber: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v);
}

const ns = popclaw as unknown as Ns;

describe('mirror post wiring (Post+Origin envelope)', () => {
  it('encodes a Post+Origin envelope — body is post (not feed), origin fields correct', async () => {
    const signer = makeTestSigner('BlackFeather');
    const platformPostCreatedAt = 1_777_000_000;

    const { post } = buildMirrorPost({
      platform: 'x',
      platformPostId: '1234567890',
      platformPostCreatedAt,
      originalUrl: 'https://x.com/elonmusk/status/1234567890',
      text: 'Hello from X!',
      media: [],
    });

    const env: Record<string, unknown> = {
      actor: { popclawId: await signer.popclawId() },
      timestamp: Math.floor(Date.now() / 1000),
      post,
    };

    const { signedPayloadBytes } = await signEnvelope(signer, env);

    // Decode and inspect wire shape.
    const sp = ns.identity.SignedPayload.decode(signedPayloadBytes);
    const envelope = ns.event.EventEnvelope.decode(sp.payload);

    // body must be `post`, not `feed`
    expect(envelope.post).toBeDefined();
    expect(envelope.feed).toBeFalsy();

    // Origin fields
    const origin = envelope.post?.origin;
    expect(origin).toBeDefined();
    expect(origin?.platform).toBe('x');
    expect(origin?.postId).toBe('1234567890');
    expect(origin?.url).toBe('https://x.com/elonmusk/status/1234567890');
    expect(longToNumber(origin?.createdAt)).toBe(platformPostCreatedAt);
    // reply_to_id absent (not a reply) → proto3 default "" after decode
    expect(origin?.replyToId ?? '').toBe('');

    // Content block
    expect(envelope.post?.blocks).toHaveLength(1);
    expect(envelope.post?.blocks?.[0]?.content).toBe('Hello from X!');
    // TEXT = 0 is proto3 default → decoded as 0
    expect(envelope.post?.blocks?.[0]?.blockType ?? 0).toBe(0);
  });

  it('encodes origin.replyToId when the post is a reply', async () => {
    const signer = makeTestSigner('Scout');

    const { post } = buildMirrorPost({
      platform: 'x',
      platformPostId: '9999',
      platformPostCreatedAt: 1_777_000_001,
      originalUrl: 'https://x.com/user/status/9999',
      text: 'replying to you!',
      media: [],
      inReplyToId: '8888',
    });

    const env: Record<string, unknown> = {
      actor: { popclawId: await signer.popclawId() },
      timestamp: Math.floor(Date.now() / 1000),
      post,
    };

    const { signedPayloadBytes } = await signEnvelope(signer, env);
    const sp = ns.identity.SignedPayload.decode(signedPayloadBytes);
    const envelope = ns.event.EventEnvelope.decode(sp.payload);

    expect(envelope.post?.origin?.replyToId).toBe('8888');
  });

  it('ADR-0025 I-1: platform and postId are always non-empty and platform !== popclaw', async () => {
    // This test exercises the guarantee that buildMirrorPost produces an origin
    // whose platform/postId/url pass lore-house's write-side guard.
    const signer = makeTestSigner('BlackFeather');

    const platforms = ['x', 'instagram', 'tiktok', 'youtube'] as const;
    for (const platform of platforms) {
      const { post } = buildMirrorPost({
        platform,
        platformPostId: `post-${platform}-001`,
        platformPostCreatedAt: 1_777_000_000,
        originalUrl: `https://example.com/${platform}/post-001`,
        text: 'test',
        media: [],
      });

      const env: Record<string, unknown> = {
        actor: { popclawId: await signer.popclawId() },
        timestamp: Math.floor(Date.now() / 1000),
        post,
      };

      const { signedPayloadBytes } = await signEnvelope(signer, env);
      const sp = ns.identity.SignedPayload.decode(signedPayloadBytes);
      const envelope = ns.event.EventEnvelope.decode(sp.payload);

      const origin = envelope.post?.origin;
      expect(origin?.platform).toBeTruthy();
      expect(origin?.platform).not.toBe('popclaw');
      expect(origin?.postId).toBeTruthy();
      expect(origin?.url).toBeTruthy();
    }
  });
});
