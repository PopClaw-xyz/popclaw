import { describe, it, expect } from 'vitest';
import { buildMirrorPost } from '../../../src/watch/feed-builder';

// ---------------------------------------------------------------------------
// ADR-0025 Task 4.2: buildMirrorPost — Post+Origin builder
// ---------------------------------------------------------------------------

describe('buildMirrorPost', () => {
  it('builds a Post with Origin for a plain x post (all fields populated)', () => {
    const { post } = buildMirrorPost({
      platform: 'x',
      platformPostId: '1234567890',
      platformPostCreatedAt: 1_777_000_000,
      originalUrl: 'https://x.com/elonmusk/status/1234567890',
      text: 'Hello from X!',
      media: [],
    });

    // Origin fields
    const origin = post.origin as Record<string, unknown>;
    expect(origin).toBeDefined();
    expect(origin.platform).toBe('x');
    expect(origin.postId).toBe('1234567890');
    expect(origin.url).toBe('https://x.com/elonmusk/status/1234567890');
    expect(origin.createdAt).toBe(1_777_000_000);
    // reply_to_id absent (not a reply)
    expect(Object.prototype.hasOwnProperty.call(origin, 'replyToId')).toBe(false);

    // Blocks
    expect(post.blocks).toEqual([{ content: 'Hello from X!' }]);
    // No media
    expect(Object.prototype.hasOwnProperty.call(post, 'media')).toBe(false);
  });

  it('includes origin.replyToId when the scraped post is a reply', () => {
    const { post } = buildMirrorPost({
      platform: 'x',
      platformPostId: '9999',
      platformPostCreatedAt: 1_777_000_001,
      originalUrl: 'https://x.com/user/status/9999',
      text: 'replying!',
      media: [],
      inReplyToId: '8888',
    });

    const origin = post.origin as Record<string, unknown>;
    expect(origin.replyToId).toBe('8888');
  });

  it('elides origin.createdAt when zero (Invariant #1)', () => {
    const { post } = buildMirrorPost({
      platform: 'instagram',
      platformPostId: 'C123abc',
      platformPostCreatedAt: 0,
      originalUrl: 'https://www.instagram.com/p/C123abc/',
      text: '',
      media: [],
    });

    const origin = post.origin as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(origin, 'createdAt')).toBe(false);
    // blocks elided (empty text)
    expect(Object.prototype.hasOwnProperty.call(post, 'blocks')).toBe(false);
  });

  it('elides origin.replyToId when inReplyToId is empty string (Invariant #1)', () => {
    const { post } = buildMirrorPost({
      platform: 'x',
      platformPostId: '1111',
      platformPostCreatedAt: 1_777_000_000,
      originalUrl: 'https://x.com/user/status/1111',
      text: 'hi',
      media: [],
      inReplyToId: '',
    });

    const origin = post.origin as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(origin, 'replyToId')).toBe(false);
  });

  it('maps media attachments correctly — IMAGE kind=0 elided, VIDEO kind=1 kept', () => {
    const { post } = buildMirrorPost({
      platform: 'x',
      platformPostId: '2222',
      platformPostCreatedAt: 1_777_000_000,
      originalUrl: 'https://x.com/user/status/2222',
      text: 'look at this',
      media: [
        { kind: 0, url: 'https://pbs.twimg.com/media/img.jpg' },
        { kind: 1, url: 'https://video.twimg.com/vid.mp4', width: 1280, height: 720 },
      ],
    });

    expect(post.media).toEqual([
      { url: 'https://pbs.twimg.com/media/img.jpg' },
      { url: 'https://video.twimg.com/vid.mp4', kind: 1, width: 1280, height: 720 },
    ]);
  });

  it('origin always contains platform, postId, url (ADR-0025 I-1 required fields)', () => {
    const { post } = buildMirrorPost({
      platform: 'tiktok',
      platformPostId: 'tt-abc-123',
      platformPostCreatedAt: 1_777_000_000,
      originalUrl: 'https://www.tiktok.com/@user/video/12345',
      text: 'dance video',
      media: [],
    });

    const origin = post.origin as Record<string, unknown>;
    // All three required-for-lore-house fields must be present and non-empty.
    expect(typeof origin.platform).toBe('string');
    expect((origin.platform as string).length).toBeGreaterThan(0);
    expect(origin.platform).not.toBe('popclaw');

    expect(typeof origin.postId).toBe('string');
    expect((origin.postId as string).length).toBeGreaterThan(0);

    expect(typeof origin.url).toBe('string');
    expect((origin.url as string).length).toBeGreaterThan(0);
  });

  it('handles youtube platform correctly', () => {
    const { post } = buildMirrorPost({
      platform: 'youtube',
      platformPostId: 'dQw4w9WgXcQ',
      platformPostCreatedAt: 1_777_000_000,
      originalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      text: 'Never gonna give you up',
      media: [],
    });

    const origin = post.origin as Record<string, unknown>;
    expect(origin.platform).toBe('youtube');
    expect(origin.postId).toBe('dQw4w9WgXcQ');
    expect(origin.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });
});
