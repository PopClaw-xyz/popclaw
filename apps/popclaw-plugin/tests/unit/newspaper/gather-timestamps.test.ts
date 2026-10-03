import { afterEach, expect, it } from 'vitest';
import { gatherNewspaperMaterials } from '../../../src/newspaper/gather-materials.js';
import { getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { mastheadDateLabel } from '../../../src/newspaper/issue.js';
import { setOwnerTz } from '../../../src/time/time-context.js';

afterEach(() => { _resetIssuesForTest(); setOwnerTz(undefined); });

it('formats feed house timestamps before reading the inbox or minting a candidate', () => {
  setOwnerTz('Asia/Shanghai');
  const calls: string[] = [];
  const iso = '2026-07-31T07:04:00.117Z';
  const result = gatherNewspaperMaterials({
    cache: { recentForReading: () => [{
      platform: 'popclaw', platformPostId: 'w1', eventId: 'w1', platformPostCreatedAt: 99000,
      authorPopclawId: 'A', actorNickname: '', actorVerified: [], handle: 'a', originalUrl: '', textPreview: '', body: '', media: [],
      replyToAuthorHandle: '', replyCount: 0, markCount: 0, houseSlug: 'world', kind: 'house:world.trip',
      houseFields: { occurred_at: iso, 'trip.occurred_at': iso, updated_at: iso, invalid_at: 'unchanged', phase: 'returned' },
    }] },
    inbox: { recent: () => { calls.push('inbox'); return []; } }, readContentRules: () => '',
    ownerNickname: 'Yu', webBaseUrl: 'https://popclaw.me', language: 'en-US', now: () => 100000,
    mintToken: () => { calls.push('mint'); return 'tdz'; }, isFollowing: () => false,
  }, { hours: 24 });
  expect(result.kind).toBe('candidates');
  const stamp = `${mastheadDateLabel(Date.parse(iso) / 1000, { language: 'en-US', timeZone: 'Asia/Shanghai' })} 15:04`;
  expect(getIssue('ctdz')!.pulse[0]!.houseFields).toStrictEqual({
    occurred_at: stamp, 'trip.occurred_at': stamp, updated_at: stamp, invalid_at: 'unchanged', phase: 'returned',
  });
  expect(calls).toStrictEqual(['inbox', 'mint']);
});
