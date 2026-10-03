import { describe, expect, it, vi } from 'vitest';
import { routeSubcommand, type SubcommandHandler } from '../../../src/commands/popclaw-router';

describe('routeSubcommand', () => {
  const fakeHandler = (name: string): SubcommandHandler =>
    vi.fn().mockResolvedValue({ text: `mock ${name} ok` });

  it('routes to the named subcommand with positional args stripped', async () => {
    const status = fakeHandler('status');
    const router = { status };
    const reply = await routeSubcommand(router, {
      args: { positional: ['status', 'extra1', 'extra2'] },
    });
    expect(reply.text).toBe('mock status ok');
    expect(status).toHaveBeenCalledWith({
      args: { positional: ['extra1', 'extra2'] },
    });
  });

  it('returns help when no subcommand given', async () => {
    const help = fakeHandler('help');
    const router = { help };
    const reply = await routeSubcommand(router, { args: { positional: [] } });
    expect(reply.text).toBe('mock help ok');
    expect(help).toHaveBeenCalledOnce();
  });

  it('returns "unknown" reply when subcommand not in map', async () => {
    const router = { status: fakeHandler('status') };
    const reply = await routeSubcommand(router, {
      args: { positional: ['nonsuch'] },
    });
    expect(reply.text).toContain('unknown popclaw subcommand');
    expect(reply.text).toContain('nonsuch');
  });

  it('subcommand name is case-insensitive', async () => {
    const status = fakeHandler('status');
    const router = { status };
    const reply = await routeSubcommand(router, {
      args: { positional: ['STATUS'] },
    });
    expect(status).toHaveBeenCalledOnce();
    expect(reply.text).toBe('mock status ok');
  });
});
