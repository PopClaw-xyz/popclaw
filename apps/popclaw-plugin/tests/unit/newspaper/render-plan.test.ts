import { describe, expect, it } from 'vitest';
import { numberedPulse } from '../../../src/newspaper/issue.js';
import { DEFAULT_STYLE } from '../../../src/newspaper/newspaper-style.js';
import { planNewspaper } from '../../../src/newspaper/render-plan.js';
import { hasCopy } from '../../../src/newspaper/editorial-copy.js';
import { issue, item } from './_issue-fixture.js';
import { renderPlanCases } from './_render-plan-fixture.js';

const numbersOf = (pulse: Parameters<typeof numberedPulse>[0]) =>
  new Map(numberedPulse(pulse).map(({ p, n }) => [p, n] as const));

function freezeFacts<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeFacts);
    Object.freeze(value);
  }
  return value;
}

describe('newspaper placement plan', () => {
  it('keeps sparse numbering, lead diagnostic order and the first postcard identity', () => {
    const c = renderPlanCases()[1]!;
    const numbers = numbersOf(c.issue.pulse);
    const p = planNewspaper(c.issue, c.edit, c.style, numbers);
    expect(p.leads.map(q => numbers.get(q))).toEqual([20, 31, 9]);
    expect(p.leads[0]).toBe(c.issue.pulse[0]);
    expect(p.postcard).toBe(c.issue.pulse[7]);
    expect([...p.onFront]).toEqual([...p.leads, p.postcard]);
    for (const q of p.onFront) expect(numbers.has(q)).toBe(true);
    expect(p.notes).toEqual([
      'edit.leads: no item [999] in this issue (ignored)',
      'edit.leads: item [80] is a lore-house event and is laid out in its own column (ignored)',
      'edit.leads: item [42] has no copy and cannot be a headline (ignored)',
      'edit.leads: item [40] has no copy and cannot be a headline (ignored)',
      'edit.leads: item [41] has no copy and cannot be a headline (ignored)',
      'edit.leads: item [7] is by someone already on the front page (moved into their card)',
      'edit.leads: 9 given, style.leadMax is 4 — the rest were dropped',
    ]);
    expect(p.decks[0]!.unwritten).toBe(3);
    expect(p.decks[0]!.onFront).toBe(4);
    expect(p.decks[0]!.postcards[0]).toBe(p.postcard);
    const capped = planNewspaper(c.issue, c.edit, { ...c.style, leadMax: 1 }, numbers);
    expect(capped.leads).toEqual([c.issue.pulse[0]]);
    expect(capped.postcard).toBeUndefined();
    // Diagnostics still scan every requested lead after the cap is reached.
    expect(capped.notes.slice(0, -1)).toEqual(p.notes.slice(0, -1));
  });

  it('allocates cards proportionally, ranks weight ties stably, then returns page order', () => {
    const c = renderPlanCases()[2]!;
    const numbers = numbersOf(c.issue.pulse);
    const p = planNewspaper(c.issue, c.edit, c.style, numbers);
    expect(p.decks.map(d => d.slug)).toEqual(['busy', 'small', 'quiet']);
    const [busy, small, quiet] = p.decks;
    expect(busy!.cards.map(q => numbers.get(q))).toEqual([104, 106, 108, 110, 122, 126, 130, 134, 138]);
    expect(small!.cards.map(q => numbers.get(q))).toEqual([140, 142, 144]);
    expect(quiet!.total).toBe(0);
    const card = c.issue.pulse[17]!;
    const companion = c.issue.pulse[18]!;
    expect(busy!.also.get(card)).toEqual([companion]);
    expect(busy!.also.get(card)![0]).toBe(companion);
    expect(busy!.briefs).not.toContain(companion);
    // A lead's companion stays below, rather than being absorbed into the lead.
    expect(busy!.briefs).toContain(c.issue.pulse[12]);
    for (const d of p.decks) for (const q of [...d.cards, ...d.briefs]) {
      expect(numbers.has(q)).toBe(true);
      expect(p.onFront.has(q)).toBe(false);
    }
    const capped = planNewspaper(c.issue, c.edit, { ...c.style, cardMax: 1 }, numbers);
    expect(capped.decks[0]!.cards).toEqual([card]);
    expect(capped.decks[1]!.cards).toEqual([c.issue.pulse[20]]);
  });

  it('keeps unspecified deck ties stable and partitions the same deck objects without folding special material', () => {
    const c = renderPlanCases()[3]!;
    const numbers = numbersOf(c.issue.pulse);
    const p = planNewspaper(c.issue, c.edit, c.style, numbers);
    expect(p.decks.map(d => d.slug)).toEqual(['b', 'a', 'c', 'fold', 'post', 'chron', 'misc', 'mantle', 'letter', 'home', 'quiet']);
    expect(p.rest.map(d => d.slug)).toEqual(['fold', 'quiet']);
    expect(p.full.map(d => d.slug)).toEqual(['b', 'a', 'c', 'post', 'chron', 'misc', 'mantle', 'letter', 'home']);
    for (const d of p.decks) {
      const partition = p.rest.includes(d) ? p.rest : p.full;
      expect(partition.find(q => q.slug === d.slug)).toBe(d);
    }
    const post = p.decks.find(d => d.slug === 'post')!;
    expect(p.postcard).toBe(c.issue.pulse[4]);
    expect(post.postcards[0]).toBe(p.postcard);
    expect(post.postcards[1]).toBe(c.issue.pulse[10]);
    expect(post.onFront).toBe(1);
    expect(post.accent).toBe('#123456');
    expect(p.decks.find(d => d.slug === 'chron')!.chron[0]).toBe(c.issue.pulse[5]);
    expect(p.decks.find(d => d.slug === 'misc')!.misc[0]).toBe(c.issue.pulse[6]);
    const counted = planNewspaper(c.issue, c.edit, { ...c.style, deckOrder: [] }, numbers);
    expect(counted.decks.map(d => d.slug)).toEqual(['post', 'a', 'b', 'c', 'fold', 'chron', 'misc', 'mantle', 'letter', 'home', 'quiet']);
    const four = planNewspaper({ pulse: [], byHouse: { a: 0, b: 0, c: 0, d: 0 } }, {}, DEFAULT_STYLE, new Map());
    expect(four.full).toHaveLength(4);
    expect(four.rest).toEqual([]);
  });

  it('uses the existing directional author comparison and does not merge unattributed leads', () => {
    const noId = item({ authorPopclawId: '', author: 'A', sigil: 'one' });
    const withId = item({ authorPopclawId: 'id-A', author: 'A', sigil: 'one' });
    const otherSigil = item({ authorPopclawId: '', author: 'A', sigil: 'two' });
    const unsigned = [item({ authorPopclawId: '', author: '', sigil: '' }), item({ authorPopclawId: '', author: '', sigil: '' })];
    const i = issue({ pulse: [noId, withId, otherSigil, ...unsigned] });
    const items = Object.fromEntries(i.pulse.map((_, n) => [String(n + 1), { h: 'Copy' }]));
    const p = planNewspaper(i, { leads: [1, 2, 3, 4, 5], items }, { ...DEFAULT_STYLE, leadMax: 5 }, numbersOf(i.pulse));
    expect(p.leads).toEqual([noId, otherSigil, ...unsigned]);
    const reverse = planNewspaper(i, { leads: [2, 1], items }, DEFAULT_STYLE, numbersOf(i.pulse));
    expect(reverse.leads).toEqual([withId, noId]);
  });

  it('retains also ownership for multiple selected cards by the same author', () => {
    const pulse = [item({ tier: 'card' }), item({ tier: 'card' }), item({ tier: 'brief' })];
    const i = issue({ pulse });
    const p = planNewspaper(i, { items: { '1': { h: 'One' }, '2': { h: 'Two' }, '3': { h: 'More' } } }, DEFAULT_STYLE, numbersOf(pulse));
    const d = p.decks[0]!;
    expect(d.cards).toEqual(pulse.slice(0, 2));
    for (const card of d.cards) expect(d.also.get(card)![0]).toBe(pulse[2]);
    expect(d.briefs).toEqual([]);
  });

  it('keeps the empty-house fallback and shares one nonblank-copy predicate with the renderer', () => {
    const pulse = [item({ houseSlug: '', tier: 'card' }), item({ houseSlug: '', authorPopclawId: 'blank' }), item({ houseSlug: 'unlisted', authorPopclawId: 'elsewhere' })];
    const i = issue({ pulse, byHouse: {} });
    const edit = { items: { '1': { s: ' Written ' }, '2': { h: ' \n', s: '\t' }, '3': {} } };
    const p = planNewspaper(i, edit, DEFAULT_STYLE, numbersOf(pulse));
    expect(p.decks).toHaveLength(1);
    expect(p.decks[0]!.slug).toBe('');
    expect(p.decks[0]!.cards[0]).toBe(pulse[0]);
    expect(p.decks[0]!.total).toBe(2);
    expect(p.decks[0]!.unwritten).toBe(1);
    expect(hasCopy(edit, 1)).toBe(true);
    for (const n of [2, 3, 4, undefined]) expect(hasCopy(edit, n)).toBe(false);
  });

  it('does not mutate the issue, copy, style or numbering map', () => {
    for (const c of renderPlanCases()) {
      freezeFacts(c);
      const numbers = numbersOf(c.issue.pulse);
      const entries = [...numbers];
      // Freezing Map itself cannot protect its entries. Fail on actual writes.
      numbers.set = () => { throw new Error('numbering mutation'); };
      numbers.delete = () => { throw new Error('numbering mutation'); };
      numbers.clear = () => { throw new Error('numbering mutation'); };
      planNewspaper(c.issue, c.edit, c.style, numbers);
      expect([...numbers]).toEqual(entries);
    }
  });
});
