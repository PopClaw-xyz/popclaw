import type { IssueData } from '../../../src/newspaper/issue.js';
import { DEFAULT_STYLE, type NewspaperStyle } from '../../../src/newspaper/newspaper-style.js';
import type { NewspaperEdit, RenderOptions } from '../../../src/newspaper/render-newspaper.js';
import { issue, item } from './_issue-fixture.js';

interface RenderCase {
  name: string;
  issue: IssueData;
  edit: NewspaperEdit;
  style: NewspaperStyle;
  options?: RenderOptions;
}

/** Representative whole papers, captured on the parent before extracting the plan. */
export function renderPlanCases(): RenderCase[] {
  const numbered = [
    item({ itemNumber: 20, tier: 'card' }),
    item({ itemNumber: 7, tier: 'card', author: 'renamed', sigil: 'other' }),
    item({ itemNumber: 31, author: '', sigil: '', authorPopclawId: '', avatarUrl: '', profileUrl: '' }),
    item({ itemNumber: 9, author: '', sigil: '', authorPopclawId: '', avatarUrl: '', profileUrl: '' }),
    item({ itemNumber: 40, authorPopclawId: 'empty' }),
    item({ itemNumber: 41, authorPopclawId: 'blank' }),
    item({ itemNumber: 42, authorPopclawId: 'missing' }),
    item({ itemNumber: 80, kind: 'world.Postcard', houseFields: {}, author: '' }),
  ];
  const busy = Array.from({ length: 28 }, (_, i) => item({
    itemNumber: 100 + i * 2,
    tier: 'card', houseSlug: i < 20 ? 'busy' : 'small',
    author: `Author ${i}`, authorPopclawId: `pid-${i}`, sigil: `s${i}`,
    replyCount: i === 15 ? 20 : 0, markCount: i === 19 ? 10 : 0,
    bondTier: i === 17 ? 'close' : undefined,
    media: i === 13 ? ['https://cdn.test/13.png'] : [],
    reasons: i === 11 ? ['A factual reason'] : undefined,
    pickedFor: i % 3 === 0 ? 'taste' : i % 3 === 1 ? 'bond' : 'lively',
  }));
  // The first lead's companion remains in its stack; a selected card claims its brief.
  busy[12]!.authorPopclawId = busy[0]!.authorPopclawId;
  busy[18]!.authorPopclawId = busy[17]!.authorPopclawId;
  busy[18]!.tier = 'brief';
  const busyCopy = Object.fromEntries(busy.map(p => [String(p.itemNumber), { h: `Head ${p.itemNumber} <&>`, s: 'First paragraph.\n\nSecond paragraph.' }]));
  const specials = ['a', 'b', 'c', 'fold', 'post', 'chron', 'misc', 'mantle', 'letter', 'home', 'quiet'];
  const specialPulse = specials.slice(0, 10).map((houseSlug, i) => item({
    houseSlug, author: `Person ${i}`, authorPopclawId: `special-${i}`, tier: 'card',
    ...(houseSlug === 'post' ? { kind: 'house:world.Postcard', houseFields: { place_name: 'Kyoto', scene: 'Rain & light', home_url: 'https://world.test/home' }, media: ['https://cdn.test/post.png'] } : {}),
    ...(houseSlug === 'chron' ? { kind: 'world.Trip', houseFields: { title: 'A trip', destination: 'Hill' } } : {}),
    ...(houseSlug === 'misc' ? { kind: 'foreign.Mystery', houseFields: { detail: 'A declared fact' } } : {}),
  }));
  specialPulse.push(item({ houseSlug: 'post', kind: 'house:Postcard', houseFields: { place_name: 'Second postcard' } }));
  return [
    { name: 'empty fallback', issue: issue({ pulse: [], byHouse: {} }), edit: {}, style: DEFAULT_STYLE },
    {
      name: 'stable numbers, copy gaps and lead diagnostics',
      issue: issue({ pulse: numbered }),
      edit: {
        masthead: 'Daily <&> Paper', edition: 'Evening', leads: [999, 80, 42, 40, 41, 20, 7, 31, 9],
        items: { '20': { h: 'Headline', s: 'Body' }, '7': { s: 'Same author' }, '31': { h: 'Unsigned one' }, '9': { s: 'Unsigned two' }, '40': {}, '41': { h: '  ', s: '\n\t' }, '999': { h: 'Stray' } },
        pulls: { '999': 'Stray pull' }, xrefs: { '999': 'Stray xref' }, topics: { '999': 'Stray topic' },
        deckNotes: { unknown: 'Stray deck' }, newbies: { ghost: 'Stray face' },
      },
      style: { ...DEFAULT_STYLE, leadMax: 4 },
      options: { fonts: 'system', avatars: 'off', doorbell: false, ownerNickname: 'Owner <&>' },
    },
    {
      name: 'weighted cards, also ownership and exhausted ornament budgets',
      issue: issue({ pulse: busy, byHouse: { small: 8, busy: 20, quiet: 0 } }),
      edit: {
        masthead: 'Busy paper', leads: [100, 102], items: busyCopy,
        pulls: Object.fromEntries(busy.map(p => [String(p.itemNumber), `Pull ${p.itemNumber}`])),
        xrefs: Object.fromEntries(busy.map(p => [String(p.itemNumber), `Xref ${p.itemNumber}`])),
        topics: { '124': 'Topic' }, deckNotes: { busy: 'Busy deck note' },
      },
      style: { ...DEFAULT_STYLE, cardMax: 12 },
    },
    {
      name: 'ordered ties, folding and protected house material',
      issue: issue({
        pulse: specialPulse, byHouse: Object.fromEntries(specials.map(s => [s, s === 'post' ? 2 : s === 'quiet' ? 0 : 1])),
        mantles: [{ houseSlug: 'mantle', level: 4, text: 'A mantle', url: 'https://world.test/mantle' }],
        houseLetters: [{ houseSlug: 'letter', fromShort: 'Keeper#one', dateLabel: 'Yesterday', body: 'A letter', links: ['https://world.test/letter'] }],
        homeSections: [{ houseSlug: 'home', asOf: 'Today', rankingBasis: 'Visitors', homes: [{ name: 'A home', visitUrl: 'https://world.test/home', owner: '' }] }],
      }),
      edit: { masthead: 'World paper', items: Object.fromEntries(specialPulse.map((_, i) => [String(i + 1), { h: `Special ${i + 1}`, s: 'Copy' }])) },
      style: { ...DEFAULT_STYLE, deckOrder: ['b', 'a', 'c'], houseAccents: { post: '#123456' } },
    },
  ];
}
