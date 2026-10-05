/**
 * R5-A1: the popclaw_unfollow tool decides "re-render the receipt with the
 * resolved name#sigil" from the command's typed outcome, not from how the
 * command happened to word its reply.
 *
 * The command is replaced with a controllable stub so the tool's adapter
 * boundary is measured on its own: the stubbed replies below are NOT the
 * command's production receipts (those are pinned in popclaw-unfollow.test.ts);
 * they only prove which input the tool branches on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import type { ResolveCandidate } from '../../../src/identity/follow-resolution.js';

vi.mock('../../../src/commands/popclaw-unfollow.js', () => ({
  runPopclawUnfollowCommand: vi.fn(),
}));
import { runPopclawUnfollowCommand } from '../../../src/commands/popclaw-unfollow.js';

const command = vi.mocked(runPopclawUnfollowCommand);

const OWNER = 'owner-id';
const ELON: ResolveCandidate = { popclawId: 'id_elon', nickname: 'Elon Musk', sigil: '4f68bd', profiles: [] };

type Tool = { name: string; execute: (c: string, p: unknown) => Promise<{ type: string; text: string }> };

function setup(candidates: ResolveCandidate[] = [ELON]) {
  const tools: Tool[] = [];
  const api = {
    registerTool: (tool: { name?: string; execute?: unknown }) => {
      if (tool?.name && typeof tool.execute === 'function') tools.push(tool as Tool);
    },
    logger: { info: vi.fn() },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  const pendingHouseGuides = vi.fn(async () => []);
  const runtime = vi.fn(async () => ({
    boot: { popclawId: OWNER, loreHouseUrls: [] as string[] },
    socialGraph: { following: () => [{ popclawId: 'id_elon' }] },
    bondsStore: {},
    paths: { houseHandshakeFile: () => '/nonexistent/handshake.json' },
    houseRuntime: { pendingHouseGuides },
  }));
  const resolve = vi.fn(async () => candidates);
  registerPopclawTools({
    api,
    runtime: runtime as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    getWorldDeps: async () =>
      ({
        guideClient: { fetchGuideText: async () => '' },
        summaryClient: { fetchSummary: async () => null },
        snapshotClient: { fetchSnapshot: async () => [] },
        resolveClient: { resolve },
        webBaseUrl: 'http://localhost:3000',
      }) as never,
  });
  const tool = tools.find((t) => t.name === 'popclaw_unfollow')!;
  return { unfollow: (name: string) => tool.execute('cid', { name }), runtime, resolve, pendingHouseGuides };
}

const rerendered = (house?: string) =>
  renderCopy('en', house ? 'relation.unfollowReceived' : 'relation.unfollowReceivedNoHouse',
    house ? { who: 'Elon Musk#4f68bd', house } : { who: 'Elon Musk#4f68bd' });

describe('popclaw_unfollow adapter: branches on the command outcome (R5-A1)', () => {
  beforeEach(() => {
    setOwnerLang('en', 'config');
    command.mockReset();
  });
  afterEach(() => setOwnerLang(undefined));

  // Shapes the production command really returns — kept from the base behaviour.
  it('accepted with a house: re-rendered with name#sigil and the carried house', async () => {
    command.mockResolvedValue({ text: '✓ Unfollow of id_elon sent — N has it.', house: 'North House', outcome: { kind: 'accepted' } });
    const r = await setup().unfollow('#4f68bd');
    expect(r.text).toBe(rerendered('North House'));
  });

  it('accepted without a house: re-rendered with the no-house wording', async () => {
    command.mockResolvedValue({ text: '✓ Unfollow of id_elon sent.', house: undefined, outcome: { kind: 'accepted' } });
    const r = await setup().unfollow('#4f68bd');
    expect(r.text).toBe(rerendered());
  });

  it('a non-accepted reply that reads as one is passed through verbatim', async () => {
    command.mockResolvedValue({ text: '⚠️ Not currently following id_elon.', outcome: { kind: 'refused', reason: 'notFollowing' } });
    const r = await setup().unfollow('#4f68bd');
    expect(r.text).toBe('⚠️ Not currently following id_elon.');
  });

  // Counter-evidence: the display text alone must not steer the branch.
  it('accepted whose text lacks ✓ is still re-rendered', async () => {
    command.mockResolvedValue({ text: 'plain receipt with no mark', house: 'North House', outcome: { kind: 'accepted' } });
    const r = await setup().unfollow('#4f68bd');
    expect(r.text).toBe(rerendered('North House'));
  });

  it.each([
    { kind: 'queued' },
    { kind: 'refused', reason: 'house' },
    { kind: 'refused', reason: 'writeUnavailable' },
    { kind: 'failed', transport: 'accepted' },
    { kind: 'failed', transport: 'unknown' },
  ] as const)('non-accepted ($kind) whose text starts with ✓ is passed through verbatim', async (outcome) => {
    command.mockResolvedValue({ text: '✓ looks like success', house: 'North House', outcome } as never);
    const r = await setup().unfollow('#4f68bd');
    expect(r.text).toBe('✓ looks like success');
  });

  it('call shape unchanged: one resolve, one command call with the owner id, and pending guides checked', async () => {
    command.mockResolvedValue({ text: '✓ x', house: undefined, outcome: { kind: 'accepted' } });
    const { unfollow, pendingHouseGuides, resolve } = setup();
    await unfollow('#4f68bd');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]![0]).toBe('id_elon');
    expect(command.mock.calls[0]![1]).toMatchObject({ ownPopclawId: OWNER });
    expect(pendingHouseGuides).toHaveBeenCalledOnce();
  });

  it('owner resolved: refused before the runtime is acquired for the command', async () => {
    const { unfollow } = setup([{ popclawId: OWNER, nickname: 'Me', sigil: 'aaaaaa', profiles: [] }]);
    const r = await unfollow('#aaaaaa');
    expect(command).not.toHaveBeenCalled();
    expect(r.text).toBe(renderCopy('en', 'person.thatIsYou'));
  });
});
