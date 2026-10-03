import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostToolsConfig } from '../../../src/diagnostics/collect.js';
import { verdictToolVisibility } from '../../../src/diagnostics/bundle.js';

/**
 * `readHostToolsConfig` reads `<stateDir>/openclaw.json` where `stateDir =
 * dirname(popclawRoot)` — same layout `buildDoctorReport` feeds it
 * (`rt.paths.rootDir()`). Each test gets its own temp dir so writes never
 * collide.
 */
const tempStateDirs: string[] = [];
afterAll(() => {
  // mkdtempSync leaves a directory per test behind otherwise — harmless once,
  // a slow leak across every run of the suite.
  for (const dir of tempStateDirs) rmSync(dir, { recursive: true, force: true });
});

function writeHostConfig(tools: Record<string, unknown>): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'popclaw-collect-test-'));
  tempStateDirs.push(stateDir);
  const popclawRoot = join(stateDir, 'popclaw');
  mkdirSync(popclawRoot, { recursive: true });
  writeFileSync(join(stateDir, 'openclaw.json'), JSON.stringify({ tools }), 'utf-8');
  return popclawRoot;
}

describe('readHostToolsConfig', () => {
  it('alsoAllow: ["group:plugins"] sets alsoAllowHasPlugins (regression)', () => {
    const root = writeHostConfig({ profile: 'coding', alsoAllow: ['group:plugins'] });
    expect(readHostToolsConfig(root)?.alsoAllowHasPlugins).toBe(true);
  });

  // #584 code-review round 1: INSTALL.md's "configure the toolsAllow
  // allowlist" section already warns that the bare plugin id does the exact
  // same thing as group:plugins — the boolean must go true for either, or
  // the doctor verdict silently reports this host as fine.
  it('alsoAllow: ["popclaw"] (the bare plugin id) ALSO sets alsoAllowHasPlugins', () => {
    const root = writeHostConfig({ profile: 'coding', alsoAllow: ['popclaw'] });
    expect(readHostToolsConfig(root)?.alsoAllowHasPlugins).toBe(true);
  });

  it('an alsoAllow list naming neither leaves alsoAllowHasPlugins false', () => {
    const root = writeHostConfig({ profile: 'coding', alsoAllow: ['some-other-plugin'] });
    expect(readHostToolsConfig(root)?.alsoAllowHasPlugins).toBe(false);
  });

  it('returns null when openclaw.json cannot be read', () => {
    expect(readHostToolsConfig(join(tmpdir(), 'popclaw-collect-test-missing', 'popclaw'))).toBeNull();
  });
});

describe('readHostToolsConfig -> verdictToolVisibility (bare plugin id, end to end)', () => {
  // Without a restrictive profile: previously fell through to the dishonest
  // "unrestricted" ok — now the bare id must be caught the same as
  // group:plugins and warn that everything, including the optional tools, is visible.
  it('alsoAllow: ["popclaw"], no restrictive profile -> warn, not a silent ok', () => {
    const root = writeHostConfig({ alsoAllow: ['popclaw'] });
    const cfg = readHostToolsConfig(root);
    const v = verdictToolVisibility(cfg, 'zh-CN');
    expect(v.status).toBe('warn');
    expect(v.fixLine).toContain('toolsAllow');
  });

  // With a restrictive profile: previously failed with "profile blocks
  // plugin tools" even though alsoAllow: ["popclaw"] had already unblocked
  // it — now must warn (nothing is broken), not fail.
  it('alsoAllow: ["popclaw"], profile: "coding" -> warn, not fail', () => {
    const root = writeHostConfig({ profile: 'coding', alsoAllow: ['popclaw'] });
    const cfg = readHostToolsConfig(root);
    const v = verdictToolVisibility(cfg, 'zh-CN');
    expect(v.status).toBe('warn');
    expect(v.fixLine).toContain('toolsAllow');
  });
});
