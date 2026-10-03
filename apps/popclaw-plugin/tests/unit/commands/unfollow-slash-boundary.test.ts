/**
 * The slash `/popclaw unfollow` hands the host the same reply object it did
 * before the command grew a typed `outcome`: `text`, plus an own `house` key
 * on the accepted branch (its value may be undefined), and nothing else.
 * `outcome` is for in-process callers (the tool); it must not cross the
 * host boundary. Driven through the real subcommand map and router.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSubcommands, type SubcommandWiring } from '../../../src/commands/wiring.js';
import { routeSubcommand } from '../../../src/commands/popclaw-router.js';
import { runPopclawUnfollowCommand } from '../../../src/commands/popclaw-unfollow.js';

vi.mock('../../../src/commands/popclaw-unfollow.js', () => ({
  runPopclawUnfollowCommand: vi.fn(),
}));

describe('slash unfollow — host boundary', () => {
  const runtime = vi.fn(async () => ({ boot: { popclawId: 'OWNER', loreHouseUrls: [] } }));
  const route = () =>
    routeSubcommand(
      buildSubcommands({ runtime } as unknown as SubcommandWiring),
      { args: { positional: ['unfollow', 'TARGET'] } },
    );

  beforeEach(() => {
    runtime.mockClear();
    vi.mocked(runPopclawUnfollowCommand).mockReset();
  });

  it.each([
    {
      name: 'accepted, house named',
      reply: { text: '✓ ok', house: 'North', outcome: { kind: 'accepted' as const } },
      expected: { text: '✓ ok', house: 'North' },
      keys: ['text', 'house'],
    },
    {
      name: 'accepted, no house (own key, undefined value)',
      reply: { text: '✓ ok', house: undefined, outcome: { kind: 'accepted' as const } },
      expected: { text: '✓ ok', house: undefined },
      keys: ['text', 'house'],
    },
    {
      name: 'queued',
      reply: { text: '… queued', outcome: { kind: 'queued' as const } },
      expected: { text: '… queued' },
      keys: ['text'],
    },
    {
      name: 'refused',
      reply: { text: '⚠️ not following', outcome: { kind: 'refused' as const, reason: 'notFollowing' as const } },
      expected: { text: '⚠️ not following' },
      keys: ['text'],
    },
  ])('$name: old keys and values, no outcome, no extra runtime or command call', async ({ reply, expected, keys }) => {
    vi.mocked(runPopclawUnfollowCommand).mockResolvedValueOnce(reply as never);
    const result = await route();
    expect(result).toEqual(expected);
    expect(Object.keys(result)).toEqual(keys);
    expect(result).not.toHaveProperty('outcome');
    // Two runtime() calls on this route, measured at base 7e63b1e3 with the
    // same harness; the handler adds none.
    expect(runtime).toHaveBeenCalledTimes(2);
    expect(runPopclawUnfollowCommand).toHaveBeenCalledTimes(1);
  });
});
