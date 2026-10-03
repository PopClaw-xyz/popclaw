import { describe, it, expect } from 'vitest';
import { profileUrl, readableUrl } from '../../../src/lshow/sources/web-fallback.js';

/**
 * Issue #282 — the first real user feedback letter we ever received. A Chinese
 * nameplate reached the owner percent-encoded, as `popclaw.me/%E9%9D%92%E5%B1%B1.../n3tzfhnt`.
 * Percent-encoding is a wire concern; the owner was shown the plumbing.
 */
describe('readableUrl (#282)', () => {
  it('restores a CJK name segment, leaving the sigil anchor untouched', () => {
    const wire = profileUrl('青山小待诏', 'n3tzfhnt', 'https://popclaw.me');
    expect(wire).toContain('%E9%9D%92');
    expect(readableUrl(wire)).toBe('https://popclaw.me/青山小待诏/n3tzfhnt');
  });

  it('leaves a plain ASCII handle byte-identical', () => {
    const wire = profileUrl('blackfeather', 'ha1pcqsq', 'https://popclaw.me');
    expect(readableUrl(wire)).toBe(wire);
  });

  it('a malformed escape degrades to the input instead of throwing', () => {
    // A lone '%' is not a valid escape — decodeURIComponent throws URIError.
    // The status line must survive that, not crash.
    expect(readableUrl('https://popclaw.me/100%/x')).toBe('https://popclaw.me/100%/x');
  });
});
