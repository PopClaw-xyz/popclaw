import { describe, it, expect } from 'vitest';
import { parseArgsForTest } from '../../src/main';

// parseArgsForTest is exposed via a named export so main-dispatch
// shape is verifiable without running the whole daemon.

describe('parseArgs', () => {
  it('fails closed for unknown arg: never silently daemon (ADR-0051 S3)', () => {
    const parsed = parseArgsForTest(['--unknown']);
    expect(parsed.subcommand).toBe('unknown');
    expect((parsed as { unknownHead?: string }).unknownHead).toBe('--unknown');
  });

  // ── S6 T3: the new wallet + redpacket subcommands ────────────────────────




  it('parses `redpacket create` WITHOUT --confirm (flag simply absent)', () => {
    const parsed = parseArgsForTest([
      'redpacket',
      'create',
      '--total=5',
      '--slots=1',
      '--to=alice',
      '--expires=24h',
    ]);
    expect(parsed.flags['confirm']).toBeUndefined();
  });
});
