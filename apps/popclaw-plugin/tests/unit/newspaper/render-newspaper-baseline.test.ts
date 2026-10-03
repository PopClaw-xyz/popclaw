import { describe, expect, it } from 'vitest';
import { renderNewspaper } from '../../../src/newspaper/render-newspaper.js';
import { renderPlanCases } from './_render-plan-fixture.js';

describe('render plan extraction: complete parent renderer results', () => {
  for (const lang of ['zh-CN', 'en'] as const) {
    for (const c of renderPlanCases()) {
      it(`${lang}: ${c.name}`, () => {
        const result = renderNewspaper(c.issue, c.edit, c.style, lang, c.options);
        expect({ ...result, headsByNumber: [...result.headsByNumber] }).toMatchSnapshot();
        if (c.name.startsWith('weighted')) {
          expect(result.html.match(/class="pull"/g)).toHaveLength(4);
          expect(result.html.match(/class="xref"/g)).toHaveLength(8);
        }
        if (c.name.startsWith('stable')) {
          // Empty and whitespace-only copy objects are omitted from the page, but
          // only an absent key enters the renderer's final missing-copy receipt.
          expect(result.unwrittenNumbers).toEqual([42]);
          expect(result.unwritten).toBe(1);
        }
      });
    }
  }
});
