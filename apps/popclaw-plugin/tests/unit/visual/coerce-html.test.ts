import { describe, it, expect } from 'vitest';
import { coerceHtml } from '../../../src/visual/coerce-html';

describe('coerceHtml', () => {
  it('passes through a full <!doctype html> document', () => {
    const doc = '<!doctype html><html><body>hi</body></html>';
    expect(coerceHtml(doc)).toBe(doc);
  });

  it('passes through bare <html> or <body>', () => {
    expect(coerceHtml('<html><body>x</body></html>')).toContain('<html>');
    expect(coerceHtml('<body>x</body>')).toContain('<body>');
  });

  it('strips ```html fences before deciding', () => {
    const out = coerceHtml('```html\n<!doctype html><body>x</body>\n```');
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).not.toContain('```');
  });

  it('wraps plain text/markdown in a minimal responsive shell', () => {
    const out = coerceHtml('# 今日江湖\n没啥大事');
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('width=device-width');
    expect(out).toContain('今日江湖');
  });

  it('escapes angle brackets when wrapping plain text', () => {
    const out = coerceHtml('a < b & c > d');
    expect(out).toContain('a &lt; b &amp; c &gt; d');
  });
});
