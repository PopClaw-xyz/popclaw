import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectNewspaperMaterials, type MaterialSources } from '../../../src/newspaper/collect-materials.js';
import { gatherNewspaperMaterials } from '../../../src/newspaper/gather-materials.js';
import { getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { noteContextTokenBudget, _resetBudgetForTest } from '../../../src/newspaper/host-budget.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { setOwnerTz } from '../../../src/time/time-context.js';
import type { ReadableFeedItem } from '../../../src/ingress/world-feed-cache.js';

const NOW = 1_790_830_800;
function feed(n: number, over: Partial<ReadableFeedItem> = {}): ReadableFeedItem {
  return { eventId: `event-${n}`, platformPostId: `event-${n}`, authorPopclawId: `person-${n}`,
    actorNickname: `Person ${n}`, actorVerified: [], handle: `person-${n}`, platform: 'popclaw',
    platformPostCreatedAt: NOW - n, body: `Source ${n} ${'long text '.repeat(100)}`, textPreview: '',
    originalUrl: '', media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0, houseSlug: 'trip', kind: 'post', ...over };
}
function sources(rows: ReadableFeedItem[]): MaterialSources {
  return { cache: { recentForReading: () => rows }, inbox: { recent: () => [] }, now: () => NOW,
    mintToken: () => 'module', ownerNickname: 'Owner', webBaseUrl: 'https://web.test',
    language: 'en-US', isFollowing: () => false };
}
beforeEach(() => { _resetIssuesForTest(); _resetBudgetForTest(); setOwnerTz('UTC'); });
afterEach(() => { _resetIssuesForTest(); _resetBudgetForTest(); setOwnerTz(undefined); });

it('collects the complete unnumbered draft, preserving house context sourced from a candidate later trimmed out', () => {
  const rows = Array.from({ length: 180 }, (_, n) => feed(n));
  rows[179] = feed(179, { kind: 'house:trip.trip', houseFields: {
    figure_name: 'Traveller', place_name: 'Suzhou', phase: 'returned', home_url: 'https://door.test/trip',
  } });
  const deps = sources(rows);
  deps.configuredHouseSlugs = ['trip', 'empty'];
  const collected = collectNewspaperMaterials(deps, { hours: 24 });
  if (collected.kind !== 'collected') throw new Error('want collected');
  expect(collected.candidateToken).toBe('cmodule');
  expect(collected.lang).toBe('en');
  expect(collected.draft).not.toHaveProperty('language');
  expect(collected.draft.pulse).toHaveLength(180);
  expect(collected.draft.pulse.every(p => !Object.hasOwn(p, 'itemNumber'))).toBe(true);
  expect(collected.draft.byHouse).toStrictEqual({ trip: 180, empty: 0 });
  expect(getIssue('cmodule')).toBeUndefined();
  noteContextTokenBudget('small', 5000);
  gatherNewspaperMaterials({ ...deps, sessionKey: 'small', readContentRules: () => '' }, { hours: 24 });
  const stored = getIssue('cmodule')!;
  expect(stored.pulse.length).toBe(180);
  expect(stored.pulse.some(p => p.eventId === 'event-179')).toBe(true);
  expect(stored.mantles).toStrictEqual(collected.draft.mantles);
  expect(stored.byHouse).toStrictEqual({ trip: stored.pulse.length, empty: 0 });
});

it('owns density/body budgets, blocked filtering, nameless backfill, reasons and firstSeen through one interface', () => {
  const rows = [feed(1, { authorPopclawId: 'A', actorNickname: '', handle: '' }),
    feed(2, { authorPopclawId: 'A', actorNickname: 'Alice', replyCount: 5 }),
    feed(3, { authorPopclawId: 'B', replyToAuthorPopclawId: 'A' }),
    feed(4, { authorPopclawId: 'blocked' })];
  const deps = sources(rows);
  deps.bondOf = id => id === 'blocked' ? { tier: 'blocked', remarkName: '' } : null;
  deps.isFollowing = id => id === 'B';
  deps.cache.authorFirstSeen = () => new Map([['A', NOW]]);
  deps.tasteTags = ['Source', 'long', 'text'];
  const result = collectNewspaperMaterials(deps, { hours: 24 });
  if (result.kind !== 'collected') throw new Error('want collected');
  const { pulse } = result.draft;
  expect(result.draft.totalCount).toBe(3);
  expect(pulse.map(p => p.author)).toStrictEqual(['Alice', 'Alice', 'Person 3']);
  expect(pulse.map(p => p.tier)).toStrictEqual(['brief', 'card', 'brief']);
  expect(pulse[0]!.text).toBe(rows[0]!.body);
  expect(pulse[1]!.text).toBe(rows[1]!.body);
  expect(pulse[0]!.reasons).toHaveLength(3);
  expect(pulse[0]!.newcomerDays).toBe(1);
});

it('does not consult the known-ID source without a home requiring sigil lookup', () => {
  const deps = sources([feed(1)]);
  const known = vi.fn(() => { throw new Error('unexpected reverse lookup'); });
  Object.defineProperty(deps, 'knownPopclawIds', { get: known });
  deps.digestOf = () => ({ as_of: 'invalid stamp', figures: [], homes: [
    { name: 'Explicit owner', visit_url: 'https://door.test/home', owner: { popclaw_id: 'known', sigil: deriveSigil('known') } },
  ] });
  expect(collectNewspaperMaterials(deps, { hours: 24 }).kind).toBe('collected');
  expect(known).not.toHaveBeenCalled();
});

it('cuts the calendar window at local midnight, keeping exact-boundary items', () => {
  const now = Date.parse('2026-10-01T00:00:00Z') / 1000;
  const start = Date.parse('2026-09-30T16:00:00Z') / 1000;
  setOwnerTz('Asia/Shanghai');
  const deps = sources([feed(1, { platformPostCreatedAt: start }), feed(2, { platformPostCreatedAt: start - 1 })]);
  deps.now = () => now;
  const result = collectNewspaperMaterials(deps);
  if (result.kind !== 'collected') throw new Error('want collected');
  expect(result.draft.windowLabel).toBe('today');
  expect(result.draft.pulse.map(p => p.eventId)).toStrictEqual(['event-1']);
});
