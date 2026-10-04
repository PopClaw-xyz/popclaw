import { afterEach, expect, it, vi } from 'vitest';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { buildSubcommands } from '../../../src/commands/wiring.js';
import { routeSubcommand } from '../../../src/commands/popclaw-router.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { makeNameChain } from '../../../src/identity/person-name.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import type { ActiveRelationHouses } from '../../../src/social-graph/relation-active-houses.js';

const ID = '13gLyDGH237UoVJKDxihmfKxDCUTjxrdrEKzzfRuhLei';
afterEach(() => setOwnerLang(undefined));
function fixture() {
  const declareFollowWithOutcome = vi.fn(async () => ({ mode: 'ordered', transport: 'accepted', houseSlug: 'world' }));
  const revokeFollowWithOutcome = vi.fn(async () => ({ mode: 'ordered', transport: 'accepted', houseSlug: 'world' }));
  const bondsStore = { list: () => [{ popclawId: ID, nickname: 'Person', remarkName: '' }], all: () => [{ popclawId: ID, nickname: 'Person', remarkName: '' }],
    get: () => ({ nickname: 'Person' }), setFollowed: vi.fn(), recordInteraction: vi.fn(), fillNickname: vi.fn() };
  const rt = { socialGraph: { activeFollowHouses: async (): Promise<ActiveRelationHouses> => ({ houses: ['synthetic-house'] }), declareFollowWithOutcome, revokeFollowWithOutcome, following: () => [{ popclawId: ID }] },
    bondsStore, nameOf: makeNameChain({ bond: () => ({ nickname: 'Person' }) as never }),
    knownFollowers: { allFollowerIds: () => [] }, worldFeedCache: { authorIds: () => [] },
    paths: { houseHandshakeFile: () => '/nonexistent/synthetic-follow-handshake.json' },
    boot: { popclawId: 'owner', loreHouseUrls: ['https://house.popclaw.me', 'https://house.popclaw.world'] } };
  return { rt, declareFollowWithOutcome, revokeFollowWithOutcome };
}
it.each(['follow', 'unfollow'])('registered %s tool forwards the exact explicit selector', async command => {
  setOwnerLang('en', 'config');
  const f = fixture();
  const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<{ text: string }> }> = [];
  registerPopclawTools({ api: { registerTool: (t: unknown) => tools.push(t as never), logger: { info: vi.fn() } } as never,
    runtime: async () => f.rt as never, getWorldDeps: async () => ({ resolveClient: { resolve: async () => [] } }) as never });
  const reply = await tools.find(t => t.name === `popclaw_${command}`)!.execute('call', { name: `Person#${deriveSigil(ID)}`, house: 'world' });
  const write = command === 'follow' ? f.declareFollowWithOutcome : f.revokeFollowWithOutcome;
  expect(write).toHaveBeenCalledWith(ID, { house: 'world' });
  if (command === 'unfollow') expect(reply.text).toContain('another house');
});
it.each(['follow', 'unfollow'])('slash %s forwards the same explicit selector', async command => {
  const f = fixture();
  const map = buildSubcommands({ runtime: async () => f.rt } as never);
  await routeSubcommand(map, { args: { positional: [command, ID], flags: { house: 'world' } } });
  const write = command === 'follow' ? f.declareFollowWithOutcome : f.revokeFollowWithOutcome;
  expect(write).toHaveBeenCalledWith(ID, { house: 'world' });
});

it('the registered unfollow tool retains an unknown aggregate warning after re-rendering', async () => {
  setOwnerLang('en', 'config');
  const f = fixture();
  f.rt.socialGraph.activeFollowHouses = async () => ({ houses: [], uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN' });
  const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<{ text: string }> }> = [];
  registerPopclawTools({ api: { registerTool: (t: unknown) => tools.push(t as never), logger: { info: vi.fn() } } as never,
    runtime: async () => f.rt as never, getWorldDeps: async () => ({ resolveClient: { resolve: async () => [] } }) as never });
  const reply = await tools.find(t => t.name === 'popclaw_unfollow')!.execute('call', { name: `Person#${deriveSigil(ID)}`, house: 'world' });
  expect(f.rt.bondsStore.setFollowed).not.toHaveBeenCalled();
  expect(reply.text).toContain('uncertain');
});
