/**
 * A first release does not emit the old read token.
 *
 * The three-part `<popclaw_id>.<ts>.<sig>` token over `inbox-read:<id>:<ts>`
 * was the whole of read authentication until this release. It is gone, and
 * this is what keeps it gone — not because the shape is wrong, but because
 * accepting two shapes is the security boundary the contract draws: a house
 * that refuses the old one cannot be talked into the old one, and a client
 * that can still build it has a downgrade waiting for whoever adds the next
 * read path and reaches for the nearest helper.
 *
 * The failure mode this prevents is the quiet one. A legacy token sent to a
 * house that only verifies the new shape is refused, and a refused read of a
 * follower list is an empty list, which is indistinguishable from nobody
 * following you. So the guard is on the SOURCE, before a wire ever carries it.
 *
 * Modelled on `social-graph/relation-producer-no-legacy.test.ts`: the same
 * "this shape has no producer left" claim, made the same way.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC);

/** Confidence that the walk actually walked: an empty list passes everything. */
describe('the old inbox-read token has no producer left', () => {
  it('scans a plausible number of source files', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it.each([
    // The v1 signing domain. Present anywhere in src, something can still
    // build the old message.
    ['inbox-read:', 'the v1 signing domain'],
    // Its builders, by name, so a re-introduction under the old name is
    // caught even if the domain string were assembled differently.
    ['buildInboxToken', 'the v1 token builder'],
    ['inboxTokenMessage', 'the v1 message builder'],
  ])('no production source mentions %s (%s)', (needle) => {
    const offenders = FILES.filter((f) => readFileSync(f, 'utf8').includes(needle))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it('leaves exactly one place that names the header', () => {
    // The header NAME survives — the house reads exactly this key. What must
    // not survive is a second definition drifting from the first, which is
    // how the value and the format part company.
    const definitions = FILES.filter((f) =>
      /const INBOX_TOKEN_HEADER\s*=/.test(readFileSync(f, 'utf8')),
    ).map((f) => f.slice(SRC.length + 1));
    expect(definitions).toEqual(['identity/read-credential.ts']);
  });
});
