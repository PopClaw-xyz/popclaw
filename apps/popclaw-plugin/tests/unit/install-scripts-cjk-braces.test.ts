import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for the macOS install-script crash (2026-07-31, host-a report):
 *
 *   sh -c 'set -u; V=hello; echo "值 $V，结束"'
 *   sh: V?: unbound variable
 *
 * macOS `/bin/sh` (bash 3.2) and plain macOS `bash` both misparse a bare
 * `$VAR` expansion inside a double-quoted string when a non-ASCII byte
 * (CJK punctuation/characters) immediately follows it with no ASCII
 * delimiter — the multibyte UTF-8 continuation bytes get swallowed into the
 * variable name. `${VAR}` is immune. Linux `dash`/`bash` do not reproduce
 * this, which is why earlier Linux-only smoke tests missed it.
 *
 * This test scans every `scripts/*.sh` for unbraced `$VAR` / `$1` / `$@` etc.
 * directly followed by a non-ASCII byte and fails with the offending line
 * numbers so the next CJK-adjacent expansion gets caught before a real
 * machine does.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// $VAR, $1, $@, ${VAR} — captures which form matched via group 1.
const EXPANSION = /\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/g;

function findUnbracedCjkAdjacent(source: string): string[] {
  const offenders: string[] = [];
  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    for (const match of line.matchAll(EXPANSION)) {
      const form = match[1] ?? '';
      if (form.startsWith('{')) continue; // already braced, safe
      const end = match.index! + match[0].length;
      const nextChar = line[end];
      if (nextChar !== undefined && nextChar.charCodeAt(0) > 127) {
        offenders.push(`${idx + 1}: ${line.trim()}`);
      }
    }
  });
  return offenders;
}

describe('scripts/*.sh: no unbraced $VAR immediately before non-ASCII text', () => {
  const scriptsDir = join(REPO_ROOT, 'scripts');
  const files = readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.sh'))
    .map((name) => join(scriptsDir, name));
  expect(files.length).toBeGreaterThan(0);

  it.each(files)('%s', (file) => {
    const source = readFileSync(file, 'utf8');
    const offenders = findUnbracedCjkAdjacent(source);
    expect(offenders, `unbraced $VAR next to non-ASCII text (wrap in \${VAR}):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('self-check: detects a deliberately reintroduced offender', () => {
    const bad = 'say "值 $V，结束"';
    expect(findUnbracedCjkAdjacent(bad)).toEqual(['1: say "值 $V，结束"']);
  });

  it('self-check: braced form and ASCII-delimited form do not false-positive', () => {
    const good = 'say "值 ${V}，结束"\nsay "value $V ok"\nsay "$V!"';
    expect(findUnbracedCjkAdjacent(good)).toEqual([]);
  });
});
