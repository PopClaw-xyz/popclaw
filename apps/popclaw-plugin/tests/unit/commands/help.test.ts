import { describe, expect, it } from 'vitest';
import { runHelpCommand, type HelpEntry } from '../../../src/commands/help';

const FIXTURE_ENTRIES: HelpEntry[] = [
  { name: 'status', summary: 'Show identity etc.' },
  { name: 'feed', summary: 'Show world feed' },
  { name: 'help', summary: 'Show this help' },
];

describe('runHelpCommand', () => {
  it('lists all subcommands when no arg', async () => {
    const reply = await runHelpCommand({ args: { positional: [] } }, FIXTURE_ENTRIES);
    expect(reply.text).toContain('PopClaw');
    expect(reply.text).toContain('status');
    expect(reply.text).toContain('Show identity etc.');
    expect(reply.text).toContain('feed');
    expect(reply.text).toContain('Show world feed');
  });

  it('shows usage for a single subcommand', async () => {
    const detailed: HelpEntry[] = [
      {
        name: 'reply',
        summary: 'Post a reply',
        usage: '/popclaw reply x:<postId> <body>',
        examples: ['/popclaw reply x:1234 "great point"'],
      },
    ];
    const reply = await runHelpCommand({ args: { positional: ['reply'] } }, detailed);
    expect(reply.text).toContain('/popclaw reply');
    expect(reply.text).toContain('great point');
  });

  it('reports unknown subcommand', async () => {
    const reply = await runHelpCommand({ args: { positional: ['nosuch'] } }, FIXTURE_ENTRIES);
    expect(reply.text).toContain('unknown subcommand');
    expect(reply.text).toContain('nosuch');
  });
});
