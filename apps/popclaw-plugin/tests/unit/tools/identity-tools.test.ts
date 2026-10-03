/**
 * Identity-domain tool cases (src/tools/identity-tools.ts): popclaw_show_namecard,
 * as registered through registerPopclawTools.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import {
  buildFakeApi,
  findTool,
  makeMockRuntime,
  makeRealBondsStore,
} from '../../helpers/register-tools-fixture.js';

// Same pin as register-tools.test.ts: the moved cases were written against
// the zh-CN lane, so this file must not depend on another file having set it.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

// Moved out of register-tools.test.ts with their describe path intact; the
// draft-store reset mirrors the hook these cases ran under there.
describe('registerPopclawTools', () => {
  beforeEach(() => _draftsForTest.clear());
  // MCP 宿主（Claude Code / Codex）没有斜杠命令，只有工具。在此之前 agent 能看
  // 主人自己的名帖（popclaw_check_status），却没有任何办法看**别人的**——
  // 「这人是谁」问不出认证，更问不出凭证。
  it('popclaw_show_namecard：认人后按 id 取名帖，凭证一并摊开', async () => {
    const { api, tools } = buildFakeApi();
    const bondsStore = makeRealBondsStore();
    const targetId = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11)).publicKey);
    bondsStore.setNickname(targetId, 'Rayfeld');
    // The command reads the body with resp.text() — a 200 + EMPTY body is the
    // conformant "never seen this identity" answer and must not blow up.
    const houseBody = {
      popclaw_id: targetId,
      sigil: deriveSigil(targetId),
      profiles: [
        {
          platform: 'x',
          handle: 'rayfeld',
          verified_at: '2026-08-24T00:00:00Z',
          profile_url: 'https://x.com/rayfeld',
          proof_url: 'https://x.com/rayfeld/status/1234567890',
          follower_count: 20000,
        },
      ],
      card: null,
    };
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => houseBody,
      text: async () => JSON.stringify(houseBody),
    }));
    vi.stubGlobal('fetch', fetch);
    try {
      registerPopclawTools({
        api,
        runtime: makeMockRuntime({ bondsStore }),
        getWorldDeps: (async () => ({ resolveClient: { resolve: vi.fn(async () => []) } })) as unknown as Parameters<
          typeof registerPopclawTools
        >[0]['getWorldDeps'],
      });
      const out = await findTool(tools, 'popclaw_show_namecard').execute('cid', { person: 'Rayfeld' });
      expect(fetch).toHaveBeenCalledWith(`http://localhost:9000/v1/profile/${targetId}`, expect.anything());
      expect(out.text).toContain('@rayfeld');
      expect(out.text).toContain('https://x.com/rayfeld/status/1234567890');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('popclaw_show_namecard：认不出这个人就说认不出，绝不去空取一份名帖', async () => {
    const { api, tools } = buildFakeApi();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      registerPopclawTools({
        api,
        runtime: makeMockRuntime({ bondsStore: makeRealBondsStore() }),
        getWorldDeps: (async () => ({ resolveClient: { resolve: vi.fn(async () => []) } })) as unknown as Parameters<
          typeof registerPopclawTools
        >[0]['getWorldDeps'],
      });
      const out = await findTool(tools, 'popclaw_show_namecard').execute('cid', { person: '查无此人' });
      expect(fetch).not.toHaveBeenCalled();
      expect(out.text.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
