import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Anti-drift regression: INSTALL.md's "Mechanism 2: configure the toolsAllow
// allowlist" section hardcodes the allowlist as prose (OpenClaw's toolsAllow config wants a
// literal list, not a computed one). Every time the manifest's contracts.tools /
// toolMetadata changes, that hardcoded copy can silently drift — exactly what
// happened when onboarding R1 promoted popclaw_mute_notices/popclaw_update_cadence
// out of the optional set: the manifest grew from 41→43 declared tools but
// INSTALL.md kept saying "30 个" with the old 30-name list.
//
// This test recomputes the allowlist from openclaw.plugin.json (the single source
// of truth) and diffs it against whatever INSTALL.md's code block currently says,
// in both directions. It must never hardcode the full tool set itself — that would
// just move the drift into the test.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function computeExpectedAllowlist(): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(ROOT, 'openclaw.plugin.json'), 'utf-8'),
  ) as {
    contracts: { tools: string[] };
    toolMetadata?: Record<string, { optional?: boolean }>;
  };
  const optional = new Set(
    Object.entries(manifest.toolMetadata ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => name),
  );
  return manifest.contracts.tools.filter((t) => !optional.has(t));
}

/** Pulls the tool-name list out of the specific fenced block under the
 * toolsAllow heading — not just "the first code block in the file" (there are
 * several unrelated ones later, e.g. the `ps -eo command | grep openclaw` block). */
function readInstallMdAllowlist(): string[] {
  const text = readFileSync(resolve(ROOT, 'INSTALL.md'), 'utf-8');
  const headingIdx = text.indexOf('Mechanism 2: configure the toolsAllow allowlist');
  expect(headingIdx, 'INSTALL.md: toolsAllow section heading not found').toBeGreaterThan(-1);
  const afterHeading = text.slice(headingIdx);
  const fenced = afterHeading.match(/```\n([\s\S]*?)```/);
  expect(fenced, 'INSTALL.md: no fenced code block found under the toolsAllow heading').toBeTruthy();
  return fenced![1]!
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('popclaw_'));
}

describe('INSTALL.md toolsAllow allowlist', () => {
  it('matches the manifest-derived allowlist exactly (no missing, no stale entries)', () => {
    const expected = computeExpectedAllowlist();
    const documented = readInstallMdAllowlist();

    const expectedSet = new Set(expected);
    const documentedSet = new Set(documented);
    const missingFromDoc = expected.filter((t) => !documentedSet.has(t));
    const staleInDoc = documented.filter((t) => !expectedSet.has(t));

    expect(missingFromDoc, `INSTALL.md is missing tools that should be allowlisted: ${missingFromDoc.join(', ') || '(none)'}`).toEqual([]);
    expect(staleInDoc, `INSTALL.md lists tools that are no longer allowlisted (optional or removed): ${staleInDoc.join(', ') || '(none)'}`).toEqual([]);
  });

  it('the count named in the prose matches the list length', () => {
    const documented = readInstallMdAllowlist();
    const text = readFileSync(resolve(ROOT, 'INSTALL.md'), 'utf-8');
    const headingIdx = text.indexOf('Mechanism 2: configure the toolsAllow allowlist');
    const proseMatch = text.slice(headingIdx).match(/following\s*(\d+)\s*tool names/);
    expect(proseMatch, 'INSTALL.md: expected a "following N tool names" sentence near the toolsAllow heading').toBeTruthy();
    expect(Number(proseMatch![1])).toBe(documented.length);
  });
});
