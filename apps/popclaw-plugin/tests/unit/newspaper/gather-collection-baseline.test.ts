import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatherNewspaperMaterials, type GatherDeps } from '../../../src/newspaper/gather-materials.js';
import { getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { _resetBudgetForTest, noteContextTokenBudget } from '../../../src/newspaper/host-budget.js';
import { setOwnerTz } from '../../../src/time/time-context.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import * as sigils from '../../../src/invite/sigil.js';
import type { ReadableFeedItem } from '../../../src/ingress/world-feed-cache.js';
import type { InboxItem } from '../../../src/messaging/inbox-store.js';
import type { WorldDigest } from '../../../src/world/digest-client.js';

const NOW = Date.parse('2026-10-01T05:00:00Z') / 1000;
type Trace = unknown[][];
function feed(id: string, author: string, house = 'trip', over: Partial<ReadableFeedItem> = {}): ReadableFeedItem {
  return { platform: 'popclaw', platformPostId: id, eventId: id, platformPostCreatedAt: NOW - 60,
    authorPopclawId: author, handle: author, actorNickname: author, actorVerified: [], originalUrl: '',
    textPreview: '', body: `SOURCE_${id} ${'text '.repeat(100)}`, media: [], replyToAuthorHandle: '',
    replyCount: 0, markCount: 0, houseSlug: house, kind: 'post', ...over };
}
function letter(author: string, ts: number, body: string): InboxItem {
  return { fromPopclawId: author, toPopclawId: 'self', receivedAtMs: ts * 1000, ts, body };
}
function fixture(fail?: string) {
  const trace: Trace = [];
  const call = <T>(name: string, args: unknown[], value: T): T => {
    trace.push([name, ...args]);
    if (fail === name) throw new Error(`stop:${name}`);
    return value;
  };
  let clock = 0;
  const counts = new Map<string, number>();
  const rows = [
    feed('a-empty', 'A', 'trip', { handle: '', actorNickname: '', replyToAuthorPopclawId: 'B' }),
    feed('a-named', 'A', 'trip', { actorNickname: 'Alice', replyCount: 6 }),
    feed('trip', 'B', 'trip', { kind: 'house:trip.trip', houseFields: {
      phase: 'returned', figure_name: 'Little One', place_name: 'Suzhou', home_url: 'https://door.test/trip',
      owner_popclaw_id: 'blocked', occurred_at: '2026-10-01T04:00:00Z', invalid_at: 'verbatim',
    } }),
    feed('digest', 'self', 'digest', { media: [{ url: 'https://img.test/a.jpg', kind: 'image' }] as ReadableFeedItem['media'] }),
    feed('edge', 'C', 'letters', { platformPostCreatedAt: NOW - 24 * 3600 }),
    feed('old', 'old', 'trip', { platformPostCreatedAt: NOW - 24 * 3600 - 1 }),
    feed('blocked', 'blocked'), feed('reject', 'reject'),
  ];
  const inbox = [
    letter('duplicate', NOW - 5, '[homeletter/v1] kind=postcard\nOfficial https://page.test/letter https://img.test/letter.png'),
    letter('letter-official', NOW - 24 * 3600 - 20, 'Outside window https://door.test/letters'),
    letter('A', NOW - 5, `Personal ${'p'.repeat(90)} https://page.test/ping`),
    letter('C', NOW - 24 * 3600, 'At boundary'), letter('blocked', NOW, 'Blocked letter'),
    letter('reject', NOW, 'Rejected letter'), letter('old', NOW - 24 * 3600 - 1, 'Old personal'),
  ];
  const homeDigest: WorldDigest = { as_of: '2026-10-01T04:23:00Z', ranking_basis: 'original',
    ranking_basis_i18n: { 'en': 'house English' }, figures: [], homes: [
      { name: 'Known', visit_url: 'https://door.test/known', owner: { sigil: sigils.deriveSigil('known'), nickname: 'Baked' }, visits_today: 0, voice: 'v'.repeat(100), built_at: '2026-09-30T03:00:00Z' },
      { name: 'Blocked owner', visit_url: 'https://door.test/blocked', owner: { popclaw_id: 'blocked', sigil: sigils.deriveSigil('blocked') }, visits_today: 2, cover_img: 'https://img.test/home.jpg' },
      { name: 'Mismatch', visit_url: 'https://door.test/mismatch', owner: { popclaw_id: 'wrong', sigil: sigils.deriveSigil('known') } },
      { name: 'Unknown', visit_url: 'https://door.test/unknown', owner: { display: 'Guest' }, built_at: 'not-ISO' },
    ] };
  const deps: GatherDeps = {
    cache: { recentForReading: n => call('feed', [n], rows),
      authorFirstSeen: () => call('firstSeen', [], new Map([['A', NOW], ['known', NOW - 2 * 86400], ['C', NOW - 30 * 86400]])) },
    inbox: { recent: n => call('inbox', [n], inbox) },
    now: () => call('now', [], NOW + clock++ * 86400),
    nameOf: (id, baked) => call('name', [id, baked], id === 'known' ? 'Known alias' : baked || `Alias ${id}`),
    isFollowing: (id, slug) => call('follow', [id, slug], id === 'A'),
    bondOf: id => call('bond', [id], id === 'A' ? { tier: 'close', remarkName: 'Al', dynamic: 'd'.repeat(75) } :
      id === 'blocked' ? { tier: 'blocked', remarkName: '' } : id === 'reject' ? { tier: 'reject', remarkName: '' } : null),
    configuredHouseSlugs: ['digest', 'trip', 'letters', 'entry', 'silent'],
    houseOfficialIds: slug => call('official', [slug], slug === 'trip' ? ['duplicate', ''] : slug === 'letters' ? ['duplicate', 'letter-official'] : []),
    digestOf: slug => {
      const round = (counts.get(slug) ?? 0) + 1; counts.set(slug, round);
      return call('digest', [slug, round], slug !== 'digest' ? undefined : round === 1 ? {
        as_of: '2026-10-01T03:21:00Z', figures: [{ figure: 'Traveller', state: 'away', city: 'Paris', day: 2,
          postcards_sent: 0, postcards_total: 3, return_at: '2026-10-01T04:00:00Z', visit_url: 'https://door.test/figure' }], homes: [],
      } satisfies WorldDigest : homeDigest);
    },
    houseEntryOf: slug => call('entry', [slug], slug === 'entry' ? { headline: 'Door card', firstMove: 'Come in', home: 'https://door.test/entry' } : undefined),
    houseVoiceOf: slug => call('voice', [slug], slug === 'silent' ? '' : 'notice '.repeat(10)),
    knownPopclawIds: ['known'], tasteTags: ['SOURCE', 'text', 'ignored'], tasteText: 'Owner taste', bondLines: ['Alice is close'],
    ownerNickname: 'Owner', ownerPopclawId: 'self', webBaseUrl: 'https://web.test', primaryHouseSlug: 'trip', language: 'en-US',
    mintToken: () => call('mint', [], 'baseline'), sessionKey: 'collection',
    readContentRules: () => { throw new Error('unexpected content read'); }, readStyle: () => { throw new Error('unexpected style read'); },
    log: text => { call('log', [text, getIssue('cbaseline') === undefined], undefined); },
  };
  return { deps, trace, rows, homeDigest };
}
function observed(deps: GatherDeps, trace: Trace, opts: { hours?: number } = { hours: 24 }) {
  try {
    const result = gatherNewspaperMaterials(deps, opts);
    const issue = getIssue('cbaseline');
    return { result, issue, issueJSON: JSON.stringify(issue), issueKeys: issue ? Object.keys(issue) : [],
      pulseKeys: issue?.pulse.map(p => Object.keys(p)), houseKeys: issue ? Object.keys(issue.byHouse) : [], trace };
  } catch (error) {
    return { error: (error as Error).message, issue: getIssue('cbaseline'), trace };
  }
}

beforeEach(() => { _resetIssuesForTest(); _resetBudgetForTest(); setOwnerTz('Asia/Shanghai'); setOwnerLang('en-US'); });
afterEach(() => { vi.restoreAllMocks(); _resetIssuesForTest(); _resetBudgetForTest(); setOwnerTz(undefined); setOwnerLang(undefined); });

describe('raw gather fixed bugfix baseline', () => {
  it('pins the complete candidate, issue shape/serialization and local read trace', () => {
    const { deps, trace } = fixture();
    const actual = observed(deps, trace);
    expect(actual).toMatchSnapshot();
    const issue = getIssue('cbaseline')!;
    expect(issue.totalCount).toBe(5);
    expect(issue.mantles?.map(m => [m.houseSlug, m.level])).toStrictEqual([['trip', 2], ['digest', 1], ['letters', 3], ['entry', 4]]);
    expect(issue.houseLetters?.[0]?.houseSlug).toBe('letters');
    expect(issue.homeSections?.[0]?.homes[1]?.owner).toContain('Alias blocked');
    expect(issue.homeSections?.[0]?.homes[0]).not.toHaveProperty('visitsToday');
    expect(issue.pulse.find(p => p.eventId === 'a-empty')?.newcomerDays).toBe(2);
    expect(trace.filter(c => c[0] === 'digest').map(c => c.slice(1))).toStrictEqual([
      ['trip', 1], ['digest', 1], ['letters', 1], ['entry', 1], ['silent', 1],
      ['trip', 2], ['digest', 2], ['letters', 2], ['entry', 2], ['silent', 2],
    ]);
  });
  it.each(['name', 'digest', 'mint', 'voice', 'log'])('pins the %s failure stop and whether a token was minted/stored', fail => {
    const { deps, trace } = fixture(fail);
    expect(observed(deps, trace)).toMatchSnapshot();
    expect(getIssue('cbaseline')).toBeUndefined();
    expect(trace.at(-1)?.[0]).toBe(fail);
    expect(trace.some(c => c[0] === 'mint')).toBe(['mint', 'voice', 'log'].includes(fail));
  });
  it.each([{}, { hours: 24 }])('pins the early empty return without inbox/digest/voice/mint (%j)', opts => {
    const { deps, trace } = fixture();
    deps.cache.recentForReading = n => { trace.push(['feed', n]); return []; };
    expect(observed(deps, trace, opts)).toMatchSnapshot();
    expect(trace.map(c => c[0])).toStrictEqual(['now', 'feed']);
  });
  it('pins unsplit degradation and absent optional fields', () => {
    const { deps, trace } = fixture();
    deps.cache = { recentForReading: n => { trace.push(['feed', n]); return [feed('unsplit', '', '')]; } };
    deps.inbox = { recent: n => { trace.push(['inbox', n]); return []; } };
    delete deps.configuredHouseSlugs; delete deps.nameOf; delete deps.bondOf; delete deps.language;
    expect(observed(deps, trace)).toMatchSnapshot();
    expect(getIssue('cbaseline')).not.toHaveProperty('mantles');
    expect(getIssue('cbaseline')?.pulse[0]).not.toHaveProperty('houseFields');
  });
  it('reads issue language at each page build and at persistence after logging', () => {
    const { deps, trace } = fixture();
    delete deps.language;
    deps.log = text => { trace.push(['log', text]); setOwnerLang('zh-CN'); };
    const actual = observed(deps, trace);
    expect(actual).toMatchSnapshot();
    expect(getIssue('cbaseline')!.language).toBe('zh-CN');
    if (actual.result?.kind === 'candidates') expect(actual.result.payload).toContain('Owner taste');
  });
  it('builds sigil lookup lazily in firstSeen, authors, knownIds order with later collisions winning', () => {
    const derivations: string[] = [];
    const real = sigils.deriveSigil;
    vi.spyOn(sigils, 'deriveSigil').mockImplementation(id => {
      derivations.push(id); return ['known', 'A', 'last'].includes(id) ? 'collision' : real(id);
    });
    const { deps, trace, homeDigest } = fixture();
    // The module should not scan this source until a home's sigil needs a reverse lookup.
    deps.knownPopclawIds = ['last', 'known'];
    deps.digestOf = slug => {
      trace.push(['digest', slug]);
      return slug === 'digest' ? { ...homeDigest, figures: [], homes: [
        { name: 'Collision', visit_url: 'https://door.test/collision', owner: { sigil: 'collision' } },
      ] } : undefined;
    };
    derivations.length = 0;
    expect(observed(deps, trace)).toMatchSnapshot();
    expect(derivations.slice(-7, -1)).toStrictEqual(['A', 'known', 'C', 'B', 'self', 'last']);
    expect(getIssue('cbaseline')!.homeSections?.[0]?.homes[0]?.owner).toBe('Alias last#collision');
  });
  it('keeps candidate numbers aligned when trimming moves a three-post author into the pooled group', () => {
    const { deps, trace } = fixture();
    const rows = Array.from({ length: 240 }, (_, i) => feed(`trim-${i}`, `group-${Math.floor(i / 3)}`, 'trip', {
      body: `EVENT_trim-${i} ${'中'.repeat(90)}`, actorNickname: `Author-${Math.floor(i / 3)}`,
    }));
    deps.cache = { recentForReading: n => { trace.push(['feed', n]); return rows; } };
    deps.nameOf = (id, baked) => baked || id;
    deps.bondOf = () => null;
    deps.isFollowing = () => false;
    noteContextTokenBudget('collection', 100000);
    const actual = observed(deps, trace);
    const issue = getIssue('cbaseline')!;
    expect(issue.pulse.length).toBeLessThan(rows.length);
    const counts = new Map<string, number>();
    for (const p of issue.pulse) counts.set(p.authorPopclawId, (counts.get(p.authorPopclawId) ?? 0) + 1);
    expect([...counts.values()].some(n => n <= 2)).toBe(true);
    if (actual.result?.kind !== 'candidates') throw new Error('want candidates');
    const lines = [...actual.result.payload.matchAll(/^\[(\d+)\].*EVENT_(trim-\d+)/gm)];
    expect(lines.map(m => Number(m[1]))).toStrictEqual(issue.pulse.map((_, i) => i + 1));
    for (const m of lines) expect(issue.pulse[Number(m[1]) - 1]!.eventId).toBe(m[2]);
    const numbers = [2, 5, issue.pulse.length];
    const picked = buildIssueFromPicks('cbaseline', numbers, {
      mintToken: () => 'picked', contentRules: '', leadMax: 3, perAuthorMax: 6, floor: 1, topUpTo: 1,
    });
    expect(picked.kind).toBe('ready');
    expect(getIssue('picked')!.pulse.map(p => [p.itemNumber, p.eventId])).toStrictEqual(
      numbers.map(n => [n, issue.pulse[n - 1]!.eventId]));
    expect({ ...actual, picked, pickedIssue: getIssue('picked') }).toMatchSnapshot();
  });
});
