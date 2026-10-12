import { describe, it, expect } from 'vitest';
import { hostDbSlug } from '../../../src/ingress/host-slug';

describe('hostDbSlug', () => {
  it.each([
    ['https://popclaw.me', 'popclaw-me'],
    ['https://dayou.art', 'dayou-art'],
    ['http://localhost:8080', 'localhost-8080'], // Include the port in the slug to distinguish local servers.
    ['https://popclaw.me/', 'popclaw-me'], // Ignore the trailing slash.
    ['https://POPCLAW.ME', 'popclaw-me'], // Lowercase the host.
    ['http://127.0.0.1:9000/base', '127-0-0-1-9000'], // Ignore paths and replace dots with hyphens.
  ])('%s -> %s', (url, slug) => {
    expect(hostDbSlug(url)).toBe(slug);
  });

  it('throws on unparseable input', () => {
    expect(() => hostDbSlug('not a url')).toThrow();
  });
});
