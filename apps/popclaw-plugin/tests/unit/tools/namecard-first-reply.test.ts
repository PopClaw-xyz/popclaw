import { describe, it, expect, vi } from 'vitest';
import { registerNamecardTool } from '../../../src/tools/identity-tools.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

const ID = 'Fo1Potk3v4qL45UmEDmnkRj2K5QEMctPKVAPjN9j1VS2';

describe('first namecard reply', () => {
  it.each(['zh-CN', 'en'] as const)('%s keeps verification followers with the account on the first lookup', async lang => {
    setOwnerLang(lang, 'config');
    for (const [snapshot, value] of [
      [{follower_count: 8500}, lang === 'zh-CN' ? '约8.5k' : 'about 8.5k'],
      [{follower_count: 0, follower_count_observed: true}, '0'],
      [{}, lang === 'zh-CN' ? '未确认' : 'unconfirmed'],
      [{follower_count: 0}, lang === 'zh-CN' ? '未确认' : 'unconfirmed'],
    ] as const) {
      const fetch = vi.fn(async () => new Response(JSON.stringify({
        popclaw_id: ID, sigil: 'sqc7q7n6', house_follower_count: 1,
        card: {nickname: 'Lee'}, profiles: [{platform: 'x', handle: 'leeqinfeng',
          verified_at: '2026-10-09T10:43:36Z', ...snapshot}],
      })));
      let tool!: {execute: (callId: string, params: unknown) => Promise<{text: string; details: {profiles: Array<{follower_count: number | null}>}}>};
      const rt = {boot: {loreHouseUrl: 'https://house.example', popclawId: ''},
        bondsStore: {list: () => [{popclawId: ID, nickname: 'Lee', remarkName: ''}]},
        houseRuntime: {houseReadFetch: () => fetch}};
      const runtime = async () => rt;
      registerNamecardTool({api: {registerTool: (t: unknown) => {tool = t as typeof tool;}}, runtime,
        deps: {runtime}} as unknown as Parameters<typeof registerNamecardTool>[0]);
      const out = await tool.execute('first-lookup', {person: 'Lee'});
      const headline = out.text.split('\n').find((line: string) => line.includes('X @leeqinfeng'));
      expect(headline).toContain(lang === 'zh-CN' ? `认证时的 X 粉丝数：${value}` : `X followers at verification: ${value}`);
      const normalCard = out.text.split(lang === 'zh-CN' ? '详细资料' : 'Details')[0];
      expect(normalCard).toContain('verified 2026-10-09');
      expect(normalCard).toContain(lang === 'zh-CN' ? '本灯坊 1 人关注' : 'followed by 1 in this lore-house');
      expect(out.text).toContain(lang === 'zh-CN' ? '首次回复' : 'first reply');
      expect(out.details.profiles[0]?.follower_count).toBe('follower_count' in snapshot ? snapshot.follower_count : null);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(`https://house.example/v1/profile/${ID}`, expect.anything());
    }
  });
});
