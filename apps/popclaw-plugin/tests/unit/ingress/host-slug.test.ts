import { describe, it, expect } from 'vitest';
import { hostDbSlug } from '../../../src/ingress/host-slug';

describe('hostDbSlug', () => {
  it.each([
    ['https://popclaw.me', 'popclaw-me'],
    ['https://dayou.art', 'dayou-art'],
    ['http://localhost:8080', 'localhost-8080'], // 端口入 slug → 本地多 server 不撞
    ['https://popclaw.me/', 'popclaw-me'], // 尾斜杠忽略
    ['https://POPCLAW.ME', 'popclaw-me'], // host 小写化
    ['http://127.0.0.1:9000/base', '127-0-0-1-9000'], // 路径忽略、点折横线
  ])('%s -> %s', (url, slug) => {
    expect(hostDbSlug(url)).toBe(slug);
  });

  it('throws on unparseable input', () => {
    expect(() => hostDbSlug('not a url')).toThrow();
  });
});
