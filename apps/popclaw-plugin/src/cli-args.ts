/**
 * ADR-0051 S3 — the CLI's subcommand parsing, extracted for testing.
 *
 * Fail closed: an unrecognized subcommand is 'unknown' — the caller prints
 * usage and exits WITHOUT bootstrapping (the daemon is never started on a
 * typo). login/logout are first-class one-shot subcommands.
 */

export interface CliArgs {
  readonly subcommand:
    | 'daemon'
    | 'invite'
    | 'follow'
    | 'status'
    | 'login'
    | 'logout'
    | 'unknown';
  readonly positional: string[];
  readonly flags: Record<string, string>;
  readonly unknownHead?: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  if (argv.length === 0) {
    return { subcommand: 'daemon', positional: [], flags: {} };
  }
  const head = argv[0]!;
  if (head === '-h' || head === '--help' || head === 'help') {
    return { subcommand: 'unknown', positional: [], flags: {}, unknownHead: '--help' };
  }
  const known = new Set([
    'invite',
    'follow',
    'status',
    'daemon',
    'login',
    'logout',
  ]);
  if (!known.has(head)) {
    return { subcommand: 'unknown', positional: [], flags: {}, unknownHead: head };
  }
  // A FIRST-POSITION -h/--help/help is top-level help regardless of what
  // follows (real CLI review: `login -h` treated -h as the host target and
  // bootstrapped). It maps to 'unknown' with the help head so main() prints
  // usage and exits 0 BEFORE any bootstrap.
  const sub = head as CliArgs['subcommand'];
  const rest = argv.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of rest) {
    if (arg === '-h' || arg === '--help' || arg === 'help') {
      // SUBCOMMAND help (anywhere in the args): map to the help exit path —
      // never treat a help flag as a host target.
      return { subcommand: 'unknown', positional: [], flags: {}, unknownHead: '--help' };
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { subcommand: sub, positional, flags };
}
