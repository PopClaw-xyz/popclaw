import { describe, expect, it } from 'vitest';
import { renderCopy } from '../../../src/lexicon/index.js';
import { createHouseMaterialRenderer, type HouseMaterialOptions } from '../../../src/newspaper/house-material-renderer.js';
import type { PulseItem } from '../../../src/newspaper/issue.js';
import { item } from './_issue-fixture.js';

const deck = (slug = 'a', postcards: readonly PulseItem[] = [], chron: readonly PulseItem[] = [], misc: readonly PulseItem[] = []) =>
  ({ slug, postcards, chron, misc });

for (const lang of ['zh-CN', 'en'] as const) {
  describe(`house material presentation (${lang})`, () => {
    const L = (key: string, vars: Record<string, string> = {}): string =>
      renderCopy(lang, key.startsWith('page.') ? `newspaper.${key}` : `newspaper.material.${key}`, vars);
    const presenter = (over: Partial<HouseMaterialOptions> = {}) =>
      createHouseMaterialRenderer({ lang, onFront: new Set(), ...over });

    it('keeps suffix precedence, first-match truthiness, repeated-field order and media[0]', () => {
      const p = item({
        kind: 'house:Postcard', media: ['https://img.test/first.png'],
        houseFields: {
          place: 'Fallback place', 'one.place_name': '', place_name: 'Skipped later match',
          title: 'Lower priority', one_scene: 'Scene <&>',
          figure_name: 'First', 'one.figure_name': 'Second', two_figure_name: 'Third',
          'empty.figure_name': '', 'two.owner_popclaw_id': 'Keeper two', owner_popclaw_id: 'Keeper one',
          view_url: 'https://house.test/lower', view: 'https://house.test/back', home_url: 'https://house.test/home',
          media_url: 'https://img.test/lower.png',
        },
      });
      const r = presenter();
      const html = r.postcard(p);
      expect(html).toContain('<h3>Fallback place</h3>');
      expect(html).not.toContain('Skipped later match');
      expect(html).toContain('<p class="body">Scene &lt;&amp;&gt;</p>');
      expect(html).not.toContain('Lower priority');
      expect(html).toContain('First · Second · Third · Keeper two · Keeper one');
      expect(html).toMatch(/^<article class="card"><a href="https:\/\/house.test\/back"[^>]*><img/);
      expect(html).toContain('src="https://img.test/first.png" referrerpolicy="no-referrer" loading="lazy"');
      expect(html).not.toContain('lower.png');
      expect(html).not.toContain('class="who"');
      expect(html).not.toContain('data-followee');
      // An empty first media value suppresses the field fallback; it is not ||.
      expect(r.postcard({ ...p, media: [''] })).not.toContain('<img');
      expect(r.postcard({ ...p, media: [] })).toContain('src="https://img.test/lower.png"');
      expect(r.forDeck(deck('a', [p])).column('postcards')[1]).toBe(`<div class="grid">${html}</div>`);
    });

    it('prints unknown kinds and ordered raw field keys, using body only when fields are absent', () => {
      const unknown = item({ kind: 'foreign.NewKind<&>', text: 'Must not replace fields', houseFields: {
        'z.scene': 'First<&>', 'raw_key': 'Second', 'empty.field': '',
      } });
      const html = presenter().forDeck(deck('a', [], [], [unknown, item({ kind: 'foreign.Raw', text: 'Body<&>' }), item({ kind: 'foreign.Empty', text: 'Must stay absent', houseFields: {} })])).column('misc').join('\n');
      expect(html).toContain('foreign.NewKind&lt;&amp;&gt;');
      expect(html).toContain('z.scene=First&lt;&amp;&gt; · raw_key=Second · empty.field=');
      expect(html).toContain('Body&lt;&amp;&gt;');
      expect(html).not.toContain('Must not replace fields');
      expect(html).not.toContain('Must stay absent');
      expect(html).toContain(L('page.items', { count: '3' }));
    });

    it('preserves official letter text, original hrefs, decoded labels and the first-link image destination', () => {
      const first = 'https://house.test/%E4%BF%A1?x=1&y=2';
      const html = presenter({ houseLetters: [{
        houseSlug: 'a', fromShort: 'Keeper<&>', dateLabel: 'Yesterday<&>', body: 'Body<&>',
        header: 'Already removed machine header', links: [first, 'https://house.test/%ZZ'], imageLinks: ['https://img.test/letter.png'],
      }] }).forDeck(deck()).column('letters').join('\n');
      expect(html).toContain('<b>Keeper&lt;&amp;&gt;</b> · Yesterday&lt;&amp;&gt;<br>Body&lt;&amp;&gt;');
      expect(html).toContain('href="https://house.test/%E4%BF%A1?x=1&amp;y=2"');
      expect(html).toContain('>https://house.test/信?x=1&amp;y=2</a>');
      expect(html).toContain('>https://house.test/%ZZ</a>');
      expect(html).toMatch(/href="https:\/\/house.test\/%E4%BF%A1\?x=1&amp;y=2"[^>]*><img class="fig"/);
      expect(html).not.toContain('Already removed machine header');
    });

    it('translates exact source keys and keeps home names, ranking order, provenance and missing-key fallback', () => {
      const r = presenter({ translations: {
        'Rank<&>': 'Translated<&>', ' Voice<&> ': 'Voice translation', 'Fallback<&>': '',
        'Near match': 'Wrong', 'Home one': 'Renamed',
      }, homeSections: [{ houseSlug: 'a', asOf: '14:00<&>', rankingBasis: 'Rank<&>', homes: [
        { name: 'Home one', owner: 'Owner', visitUrl: 'https://house.test/one', voice: ' Voice<&> ', visitsToday: 2, builtAt: 'Yesterday' },
        { name: 'Home two', owner: '', visitUrl: 'https://house.test/two', voice: 'Near match ' },
        { name: 'Home three', owner: '', visitUrl: 'https://house.test/three', voice: 'Fallback<&>' },
      ] }] });
      const parts = r.forDeck(deck()).column('homes');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toContain('14:00&lt;&amp;&gt;');
      expect(parts[1]).toContain('<span title="Rank&lt;&amp;&gt;">Translated&lt;&amp;&gt;</span>');
      expect(parts[1]).toContain(L('page.translated'));
      const grid = parts[2]!;
      expect(grid).toContain('<span title=" Voice&lt;&amp;&gt; ">Voice translation</span>');
      expect(grid).toContain('<p>Near match </p>');
      expect(grid).toContain('<p>Fallback&lt;&amp;&gt;</p>');
      expect(grid).toContain(L('page.visitsToday', { count: '2' }));
      expect(grid).toContain(L('page.builtAt', { date: 'Yesterday' }));
      expect(grid.indexOf('Home one')).toBeLessThan(grid.indexOf('Home two'));
      expect(grid.indexOf('Home two')).toBeLessThan(grid.indexOf('Home three'));
      expect(grid).toContain('href="https://house.test/three"');
      expect(grid).not.toContain('Wrong');
      expect(grid).not.toContain('Renamed');
    });

    it('counts all promoted postcards and retains the note and empty grid, filtering by object identity', () => {
      const first = item({ houseFields: { place_name: 'First' } });
      const second = item({ houseFields: { place_name: 'Second' } });
      const r = presenter({ onFront: new Set([first, second]) });
      const all = r.forDeck(deck('a', [first, second])).column('postcards');
      expect(all).toHaveLength(3);
      expect(all[0]).toContain(L('page.items', { count: '2' }));
      expect(all[1]).toBe(`<p class="note">${L('page.onFront', { count: '2' })}</p>`);
      expect(all[2]).toBe('<div class="grid"></div>');
      const clone = { ...first };
      const partial = r.forDeck(deck('a', [first, clone])).column('postcards');
      expect(partial[1]).toBe(`<p class="note">${L('page.onFront', { count: '1' })}</p>`);
      expect(partial[2]).toBe(`<div class="grid">${r.postcard(clone)}</div>`);
      expect(r.postcard(first)).toContain('<h3>First</h3>');
    });

    it('selects matching split materials and all unsplit letters but only the first mantle and home section', () => {
      const sources: Partial<HouseMaterialOptions> = {
        mantles: Object.freeze([
          Object.freeze({ houseSlug: 'a', level: 1 as const, text: 'First mantle' }),
          Object.freeze({ houseSlug: 'b', level: 4 as const, text: 'Second mantle' }),
        ]),
        houseLetters: Object.freeze([
          Object.freeze({ houseSlug: 'a', fromShort: 'A', dateLabel: 'Today', body: 'First letter' }),
          Object.freeze({ houseSlug: 'b', fromShort: 'B', dateLabel: 'Today', body: 'Second letter' }),
        ]),
        homeSections: Object.freeze([
          Object.freeze({ houseSlug: 'a', asOf: 'Now', homes: Object.freeze([]) }),
          Object.freeze({ houseSlug: 'b', asOf: 'Now', homes: Object.freeze([{ name: 'Second home', owner: '', visitUrl: 'https://house.test/b' }]) }),
        ]),
      };
      const r = presenter(sources);
      const unsplit = r.forDeck(deck(''));
      expect(unsplit.column('mantle').join('')).toContain('First mantle');
      expect(unsplit.column('mantle').join('')).not.toContain('Second mantle');
      expect(unsplit.column('letters').join('')).toContain('First letter');
      expect(unsplit.column('letters').join('')).toContain('Second letter');
      expect(unsplit.column('homes')).toEqual([]);
      expect(unsplit.hasMantleOrHomes).toBe(true);
      const split = r.forDeck(deck('b'));
      expect(split.column('mantle').join('')).toContain('Second mantle');
      expect(split.column('letters').join('')).not.toContain('First letter');
      expect(split.column('homes').join('')).toContain('Second home');
      expect(split.hasMantleOrHomes).toBe(true);
      const homesOnly = presenter({ ...sources, mantles: undefined });
      expect(homesOnly.forDeck(deck('')).hasMantleOrHomes).toBe(false);
      expect(homesOnly.forDeck(deck('a')).hasMantleOrHomes).toBe(false);
      expect(homesOnly.forDeck(deck('b')).hasMantleOrHomes).toBe(true);
      expect(r.forDeck(deck('missing')).column('letters')).toEqual([]);
      expect(r.forDeck(deck('missing')).hasMantleOrHomes).toBe(false);
    });

    it('keeps chronology order and translates only the fixed event and phase whitelist', () => {
      const chron = [
        item({ kind: 'world.Trip', houseFields: { occurred_at: 'First time', place: 'Hill', phase: 'HOME', figure_name: 'Figure', owner_popclaw_id: 'Keeper', home_url: 'https://house.test/home' } }),
        item({ kind: 'house:souvenir', houseFields: { occurred_at: 'Second time', phase: 'AWAY', scene: 'A gift' } }),
        item({ kind: 'world.Encounter', houseFields: { occurred_at: 'Third time', phase: 'Unknown<&>' } }),
      ];
      const parts = presenter().forDeck(deck('a', [], chron)).column('chron');
      expect(parts[0]).toContain(L('page.items', { count: '3' }));
      const html = parts[1]!;
      expect(html).toContain(`First time · ${L('kind.trip')} · Hill · Figure · ${L('phase.returned')}`);
      expect(html).toContain(`Second time · ${L('kind.souvenirtransfer')} · A gift · ${L('phase.left')}`);
      expect(html).toContain(`Third time · ${L('kind.encounter')} · Unknown&lt;&amp;&gt;`);
      expect(html.indexOf('First time')).toBeLessThan(html.indexOf('Second time'));
      expect(html.indexOf('Second time')).toBeLessThan(html.indexOf('Third time'));
      expect(html).toContain('<span class="meta">Keeper</span>');
      expect(html).toContain('href="https://house.test/home"');
    });

    it('keeps mantle source/as-of/date attribution and the distinct level-four doorplate', () => {
      const r = presenter({ mantles: [
        { houseSlug: 'a', level: 3, text: 'Letter<&>', asOf: '14:00', dateLabel: 'Yesterday<&>', url: 'https://house.test/home' },
        { houseSlug: 'b', level: 4, text: 'Door<&>', asOf: 'Ignored source', dateLabel: 'Ignored date', url: 'https://house.test/door' },
      ] });
      const mantle = r.forDeck(deck()).column('mantle');
      expect(mantle).toHaveLength(1);
      expect(mantle[0]).toContain('<div class="mantle"><span>Letter&lt;&amp;&gt;</span>');
      expect(mantle[0]).toContain(`${L('page.asOf', { time: '14:00' })} · Yesterday&lt;&amp;&gt;`);
      const door = r.forDeck(deck('b')).column('mantle').join('');
      expect(door).toMatch(/^<div class="doorplate"><b>Door&lt;&amp;&gt;<\/b><div><a class="btn"/);
      expect(door).toContain(L('button.world'));
      expect(door).not.toContain('Ignored');
    });

    it('emits no heading or grid for any absent material column', () => {
      const empty = presenter().forDeck(deck());
      for (const column of ['mantle', 'letters', 'postcards', 'chron', 'homes', 'misc'] as const) {
        expect(empty.column(column)).toEqual([]);
      }
      expect(empty.hasMantleOrHomes).toBe(false);
    });
  });
}
