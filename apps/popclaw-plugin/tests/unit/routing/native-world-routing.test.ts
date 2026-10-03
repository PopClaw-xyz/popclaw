import { describe, expect, it } from 'vitest';
import { nativeWorldRoute } from '../../../src/routing/native-world-routing.js';

describe('native world entry routing', () => {
  it.each([
    '进入 http://127.0.0.1:49200，阅读游戏说明，加入后查看状态',
    'Enter http://127.0.0.1:49200 and read the game guide',
  ])('routes a known House with game intent: %s', prompt => {
    const result = nativeWorldRoute(prompt, ['http://127.0.0.1:49200']);
    expect(result).toContain('popclaw_house_login');
    expect(result).toContain('popclaw_world_capabilities');
    expect(result).toContain('popclaw_world_invoke');
    expect(result).toContain('does not grant');
  });
  it('recognizes an explicit unfamiliar LoreHouse entry request', () => {
    expect(nativeWorldRoute('Join the LoreHouse at https://example.invalid', [])).toContain('popclaw_house_login');
  });
  it.each([
    'Open http://127.0.0.1:49200 in the browser',
    'Enter http://127.0.0.1:49200 in the browser to read the game guide',
    '阅读 https://ordinary.invalid 的游戏评测',
    '进入 http://127.0.0.1:492001 阅读游戏说明',
    '进入 http://127.0.0.1:49200.evil.invalid 阅读游戏说明',
    '进入 http://127.0.0.1:49200@evil.invalid 阅读游戏说明',
    'Explain the LoreHouse architecture',
  ])('does not capture unrelated URL or discussion: %s', prompt => {
    expect(nativeWorldRoute(prompt, ['http://127.0.0.1:49200'])).toBeUndefined();
  });
});
