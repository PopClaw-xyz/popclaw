/**
 * ADR-0051 S3 — the CLI's fail-closed subcommand parsing: an unknown
 * subcommand must NEVER fall through to the daemon (work order: the old
 * `unknown → daemon` default had to be fixed first), and login/logout parse
 * as first-class one-shot subcommands.
 *
 * parseCliArgs lives in src/cli-args.ts (extracted from main.ts so the
 * fail-closed contract is testable without spawning the CLI).
 */

import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../../src/cli-args.js';

describe('CLI parseArgs (fail closed)', () => {
  it('no arguments → daemon (the only legal daemon entry)', () => {
    const args = parseCliArgs([]);
    expect(args.subcommand).toBe('daemon');
  });

  it('explicit daemon still works', () => {
    expect(parseCliArgs(['daemon']).subcommand).toBe('daemon');
  });

  it('known subcommands parse with positionals', () => {
    const args = parseCliArgs(['login', 'demo.loreshow.invalid', '--flag=x']);
    expect(args.subcommand).toBe('login');
    expect(args.positional).toEqual(['demo.loreshow.invalid']);
    expect(args.flags).toEqual({ flag: 'x' });
    const out = parseCliArgs(['logout', 'other.invalid']);
    expect(out.subcommand).toBe('logout');
    expect(out.positional).toEqual(['other.invalid']);
  });

  it('top-level -h / help map to the help exit path, never a host target', () => {
    for (const form of ['-h', '--help', 'help']) {
      const args = parseCliArgs([form]);
      expect(args.subcommand).toBe('unknown');
      expect(args.unknownHead).toBe('--help');
    }
  });

  it('subcommand help maps to the help exit path BEFORE bootstrap', () => {
    // Real CLI review: `login -h` used to treat -h as the host and bootstrap.
    const args = parseCliArgs(['login', '-h']);
    expect(args.subcommand).toBe('unknown');
    expect(args.unknownHead).toBe('--help');
    expect(args.positional).toEqual([]);
    const long = parseCliArgs(['login', 'host.invalid', '--help']);
    expect(long.subcommand).toBe('unknown');
    expect(long.unknownHead).toBe('--help');
  });

  it('an unknown subcommand is flagged, never daemon', () => {
    const args = parseCliArgs(['loginn', 'x']);
    // The whole point: a typo must not silently start the daemon.
    expect(args.subcommand).toBe('unknown');
    expect((args as { unknownHead?: string }).unknownHead).toBe('loginn');
    expect(args.positional).toEqual([]);
  });

  it('existing subcommands keep their shapes', () => {
    expect(parseCliArgs(['invite', '--a=1']).subcommand).toBe('invite');
    expect(parseCliArgs(['status']).subcommand).toBe('status');
  });
});
