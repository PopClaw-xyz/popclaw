import { describe, expect, it } from 'vitest';
import { createPersonItemRenderer } from '../../../src/newspaper/person-item-renderer.js';
import { item } from './_issue-fixture.js';

describe('person item renderer: issue-local ornaments through the public interface', () => {
  for (const lang of ['zh-CN', 'en'] as const) {
    it(`${lang}: queries and continuations preserve quotas, and factories are independent`, () => {
      const pulse = Array.from({ length: 12 }, (_, i) => item({ itemNumber: 20 + i * 3 }));
      const numberOf = new Map(pulse.map(p => [p, p.itemNumber!] as const));
      const copy = {
        items: Object.fromEntries(pulse.map(p => [String(p.itemNumber), { h: `Head ${p.itemNumber}`, s: `Summary ${p.itemNumber}` }])),
        pulls: Object.fromEntries(pulse.map(p => [String(p.itemNumber), `Pull ${p.itemNumber}`])),
        xrefs: Object.fromEntries(pulse.map(p => [String(p.itemNumber), `Xref ${p.itemNumber}`])),
      };
      const options = { numberOf, copy, lang, primaryHouseSlug: 'house-me', avatars: 'off' as const };
      const first = createPersonItemRenderer(options);
      const second = createPersonItemRenderer(options);
      // Query every ornament-bearing item on only one instance. These surfaces
      // must not pre-render cards or spend a quota before the caller places them.
      for (const p of pulse) {
        expect(first.newFace(p)).toContain(`Head ${p.itemNumber}`);
        expect(first.rosterEntry(p, 'Roster label')).toContain('Roster label');
        expect(first.brief(p, 'Other house')).toContain(`Summary ${p.itemNumber}`);
      }
      const heads = first.headsByNumber();
      expect([...heads.keys()]).toEqual([...numberOf.values()]);
      expect([...heads.values()]).toEqual(pulse.map(p => `Head ${p.itemNumber}`));
      // Each query returns a fresh Map; consumer changes cannot rewrite copy.
      heads.set(20, 'Changed by a consumer');
      expect(first.headsByNumber().get(20)).toBe('Head 20');

      const lead = first.card(pulse[0]!, { lead: true, drop: true, more: [pulse[11]!] });
      expect(lead).toBe(second.card(pulse[0]!, { lead: true, drop: true, more: [pulse[11]!] }));
      expect(lead).toContain('class="drop"');
      expect(lead).toContain('Pull 20');
      expect(lead).not.toContain('class="xref"');
      expect(lead).not.toContain('Pull 53');
      expect(lead).not.toContain('Xref 53');

      // A deliberate non-number order models the caller's placement order.
      const order = [7, 2, 9, 1, 8, 3, 6, 4, 5, 10];
      const cards: string[] = [];
      for (const [i, index] of order.entries()) {
        const p = pulse[index]!;
        const rendered = first.card(p);
        expect(rendered).toBe(second.card(p));
        expect(rendered.includes(`Pull ${p.itemNumber}`)).toBe(i < 3);
        expect(rendered.includes(`Xref ${p.itemNumber}`)).toBe(i < 8);
        cards.push(rendered);
        first.headsByNumber();
        first.newFace(p);
        first.rosterEntry(p, p.author);
      }
      const pageItems = lead + cards.join('');
      expect(pageItems.match(/class="pull"/g)).toHaveLength(4);
      expect(pageItems.match(/class="xref"/g)).toHaveLength(8);
      // The earlier continuation neither claimed nor spent its own ornaments.
      expect(first.card(pulse[11]!)).not.toMatch(/class="(?:pull|xref)"/);
      const fresh = createPersonItemRenderer(options).card(pulse[11]!);
      expect(fresh).toContain('Pull 53');
      expect(fresh).toContain('Xref 53');
    });
  }
});
