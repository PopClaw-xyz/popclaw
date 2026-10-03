import { afterEach, describe, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import {
  decodeEnvelopeBody, envelopeKind, normalizeFeedItem, numberOrZero,
  projectCachedRow, projectReadableRow, type FeedCacheRow,
} from '../../../src/ingress/feed-item-projection';
import * as publicEnvelope from '../../../src/protocol/public-envelope';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { setOwnerLang } from '../../../src/lexicon/owner-language';
import { bytesOf, item } from '../../helpers/world-feed-cache';

const envelope = (value: popclaw.event.IEventEnvelope) => popclaw.event.EventEnvelope.encode(value).finish();
const post = envelope({ post: {
  blocks: [{ content: ' first ' }, { blockType: 1, content: 'ignored' }, { content: 'second ' }],
  media: [{ kind: 1, url: 'video' }, { kind: 2, url: 'gif' }, { kind: 77 as popclaw.event.MediaAttachment.Kind, url: 'fallback-image' }, { url: '' }],
} });
const unknown = new Uint8Array([0xc2, 2, 0]); // unknown body member 40
const carrier = (env: Uint8Array | undefined = post) => item({
  platformPostId: 'raw-id', eventId: 'raw-event', envelope: env,
  replyCount: 9, markCount: 3, actorNickname: 'raw nick', replyToAuthorHandle: 'raw target',
  actorVerified: [{ platform: 'x', handle: 'verified', profileUrl: 'profile', followerCount: 300 }],
  replyToPlatform: 'x', replyToPostId: 'raw-parent', replyToAuthorPopclawId: 'raw-author',
});
const rowOf = (raw: Uint8Array): FeedCacheRow => ({
  raw, platform: 'db-platform', platform_post_id: 'db-id', event_id: 'db-event',
  platform_post_created_at: 42, author_popclaw_id: 'db-author', handle: 'db-handle',
  original_url: 'db-url', text_preview: 'db-preview', reply_to_platform: null,
  reply_to_post_id: 'db-parent', reply_to_author_popclaw_id: null,
});
const cached = {
  platform: 'db-platform', platformPostId: 'db-id', eventId: 'db-event', platformPostCreatedAt: 42,
  authorPopclawId: 'db-author', handle: 'db-handle', originalUrl: 'db-url', textPreview: 'db-preview',
  replyToPlatform: '', replyToPostId: 'db-parent', replyToAuthorPopclawId: '',
};
const reading = {
  ...cached, kind: 'post', body: 'first \nsecond',
  media: [{ kind: 'video', url: 'video' }, { kind: 'gif', url: 'gif' }, { kind: 'image', url: 'fallback-image' }],
  replyToAuthorHandle: 'raw target', replyCount: 9, markCount: 3, actorNickname: 'raw nick',
  actorVerified: [{ platform: 'x', handle: 'verified', profileUrl: 'profile', followerCount: 300 }],
};

afterEach(() => { setOwnerLang(undefined); vi.restoreAllMocks(); });

describe('feed single-row projection', () => {
  it('keeps every database column authoritative and derives reading fields from retained bytes', () => {
    const raw = bytesOf(carrier());
    const before = Array.from(raw);
    const row = rowOf(raw);
    expect(projectCachedRow(row)).toEqual(cached);
    expect(projectReadableRow(row)).toEqual(reading);
    expect(row.raw).toBe(raw);
    expect(Array.from(raw)).toEqual(before);
    expect(projectCachedRow({ ...row, reply_to_post_id: '' })).toEqual({
      platform: 'db-platform', platformPostId: 'db-id', eventId: 'db-event', platformPostCreatedAt: 42,
      authorPopclawId: 'db-author', handle: 'db-handle', originalUrl: 'db-url', textPreview: 'db-preview',
    });
  });

  it.each([
    ['empty post', envelope({ post: {} }), 'post', 'db-preview'],
    ['reply', envelope({ reply: { body: ' full reply ' } }), 'reply', ' full reply '],
    ['non-reading body', envelope({ profile: { nickname: 'profile' } }), 'profile', 'db-preview'],
  ])('%s preserves the complete result and empty-body preview fallback', (_label, env, kind, body) => {
    expect(projectReadableRow(rowOf(bytesOf(carrier(env as Uint8Array))))).toEqual({
      ...reading, kind, body, media: [],
    });
  });

  it('reads the owner language when projecting an unknown house vocabulary', () => {
    const env = envelope({ houseEvent: { kind: 'third-party.new_vocabulary', body: Buffer.from(JSON.stringify({
      place: 'Kyoto', scene: { zh: '桥头', en: 'bridge' }, present: [{ name: 'one' }], untranslated: { ja: '庭' },
    })) } });
    const row = rowOf(bytesOf(carrier(env)));
    for (const [lang, scene, untranslated] of [
      ['en-US', 'bridge', '庭 (ja)'], ['zh-CN', '桥头', '庭（ja）'], ['ja-JP', '桥头 (zh)', '庭'],
    ]) {
      setOwnerLang(lang);
      expect(projectReadableRow(row)).toEqual({
        ...reading, kind: 'house:third-party.new_vocabulary', body: 'db-preview', media: [],
        houseFields: { place: 'Kyoto', scene, 'present.1.name': 'one', untranslated },
      });
    }
  });

  it.each([
    ['missing original', bytesOf({ ...carrier(), envelope: undefined }), 'PUBLIC_ENVELOPE_EVIDENCE_REQUIRED'],
    ['corrupt original', bytesOf(carrier(new Uint8Array([255]))), 'WIRE_VARINT'],
    ['unknown wire member', bytesOf(carrier(unknown)), 'UNSUPPORTED_FIELD'],
    ['corrupt carrier', new Uint8Array([255]), 'PUBLIC_WIRE_INVALID'],
  ])('%s still throws at both single-row boundaries', (_label, raw, code) => {
    expect(() => projectCachedRow(rowOf(raw as Uint8Array))).toThrow(code);
    expect(() => projectReadableRow(rowOf(raw as Uint8Array))).toThrow(code);
  });

  it('keeps kind probing tolerant while body projection uses the public structure gate', () => {
    const decode = vi.spyOn(publicEnvelope, 'decodeEnvelope');
    expect(envelopeKind(unknown)).toBe('unknown:40');
    expect(() => decodeEnvelopeBody(unknown)).toThrow();
    expect(decode).not.toHaveBeenCalled();
    expect(decodeEnvelopeBody(new Uint8Array())).toBeNull();
    decode.mockImplementation(() => { throw new Error('codec failure'); });
    expect(decodeEnvelopeBody(post)).toBeNull();
    expect(projectReadableRow(rowOf(bytesOf(carrier())))).toEqual({
      ...reading, body: 'db-preview', media: [],
    });
  });
});

describe('retained carrier normalization and cache wiring', () => {
  it('normalizes retained primitives without replacing the source URL or reply rules', () => {
    expect(normalizeFeedItem(popclaw.event.WorldFeedItem.decode(bytesOf(item({
      platformPostCreatedAt: 42, originalUrl: '', origin: { url: 'origin-url' },
    }))))).toEqual({
      platform: 'x', platformPostId: 'pid-default', eventId: '', platformPostCreatedAt: 42,
      authorPopclawId: 'authorA', handle: 'h', originalUrl: 'origin-url', textPreview: 'hello world',
    });
    expect(normalizeFeedItem(null)).toBeNull();
    expect(normalizeFeedItem({ platform: 'x' })).toBeNull();
    expect(numberOrZero('12tail')).toBe(12);
    expect(numberOrZero('bad')).toBe(0);
    expect(numberOrZero({ low: -1, high: 1 })).toBe(8589934591);
    expect(numberOrZero(undefined)).toBe(0);
    expect(numberOrZero(Number.NaN)).toBeNaN();
  });

  it('preserves raw-byte priority, input-envelope debug kind, and actual SQLite projections', async () => {
    const db = new LocalHostDb(':memory:');
    const logs: string[] = [];
    const cache = new WorldFeedCache({ db, now: () => 1700000000, debug: s => logs.push(s) });
    await cache.start();
    const raw = bytesOf(carrier());
    cache.record(item({ platformPostId: 'input-id', envelope: unknown }), raw, 19);
    expect(logs).toEqual(['world-feed: unknown kind unknown:40 — x/raw-id cached anyway']);
    const stored = db.queryOne<FeedCacheRow & { received_at: number }>('SELECT * FROM world_feed')!;
    expect(stored.received_at).toBe(19);
    expect(Array.from(stored.raw)).toEqual(Array.from(raw));
    expect(cache.lookup('x', 'input-id')).toBeNull();
    db.execute(`UPDATE world_feed SET platform='db-platform', platform_post_id='db-id', event_id='db-event',
      platform_post_created_at=42, author_popclaw_id='db-author', handle='db-handle', original_url='db-url',
      text_preview='db-preview', reply_to_platform=NULL, reply_to_post_id='db-parent', reply_to_author_popclaw_id=NULL`);
    expect(cache.recent(1)).toEqual([cached]);
    expect(cache.recentForReading(1)).toEqual([reading]);
    db.close();
  });
});
