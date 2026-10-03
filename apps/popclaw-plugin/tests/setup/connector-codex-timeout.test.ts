/**
 * Codex's tool timeout could end the call while an approval dialog is open
 * (a pause seen in newer CLI source is an observation, not a guarantee), so setup writes `tool_timeout_sec` into the Codex binding —
 * derived from the LONGEST window the plugin can use, raised but never
 * lowered, and without disturbing a byte of anything else. Claude Code gets
 * nothing new.
 *
 * Runs under `node --import tsx --test`, like the rest of tests/setup.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup as connect } from '../../src/setup/connector.mjs';
import toml from '../../src/setup/vendor/smol-toml.cjs';
import { OWNER_APPROVAL_TIMEOUT_BOUNDS } from '../../src/host/mcp-owner-approval.js';
import { CODEX_TOOL_TIMEOUT_SECONDS } from '../../src/host/approval-window.mjs';

/** What setup must write: the environment variable's upper bound + 60 s. */
const DERIVED = OWNER_APPROVAL_TIMEOUT_BOUNDS.maxSeconds + 60;

function fixture() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'popclaw-codex-window-'));
  const home = join(base, 'home'); const project = join(base, 'project'); const pkg = join(base, 'package');
  for (const p of [home, project, join(project, '.codex'), join(pkg, 'dist/bundled'), join(pkg, 'dist/native-deps'), join(pkg, 'migrations')]) mkdirSync(p, { recursive: true });
  for (const f of ['dist/bundled/mcp.js', 'dist/bundled/mcp-hook.js', 'migrations/025-dm-delivery-lease.sql']) writeFileSync(join(pkg, f), '');
  const root = join(base, 'identity');
  /** A second, newer package: the one an installed root switches to. */
  const next = join(base, 'package-next');
  for (const p of [join(next, 'dist/bundled'), join(next, 'dist/native-deps'), join(next, 'migrations')]) mkdirSync(p, { recursive: true });
  for (const f of ['dist/bundled/mcp.js', 'dist/bundled/mcp-hook.js', 'migrations/025-dm-delivery-lease.sql']) writeFileSync(join(next, f), '');
  return {
    base, project, pkg, next,
    plan: async (host: 'codex' | 'claude' | 'both' = 'codex', extra: Record<string, unknown> = {}) => (await connect({
      home, project, package: pkg, root, host, env: { PATH: '', CODEX_HOME: join(home, '.codex') },
      planOnly: true, validateRoot: (p: string) => p === root, ...extra,
    })) as { plans: Array<{ path: string; before?: string; after: string }> },
  };
}
const configOf = (plans: Array<{ path: string; after: string }>) => plans.find(p => p.path.endsWith('.codex/config.toml'));
const USER = '# my own settings\nmodel = "unchanged"   # keep this comment\n\n[profiles.fast]\nmodel = "x"\n';

test('the derived value is the longest window plus 60 s — not the default window', () => {
  assert.equal(DERIVED, 660);
  // The hand-registration advice quotes the same number.
  const doc = readFileSync(new URL('../../../../docs/known-limitations.md', import.meta.url), 'utf8');
  assert.match(doc, new RegExp(`tool_timeout_sec = ${DERIVED}\\b`));
  assert.match(doc, new RegExp(`at least ${DERIVED}\\b`));
});

// The two places a person registering a host by hand actually reads. The
// number is taken from the shared source, never re-typed here.
test('the hand-registration docs quote the shared tool timeout', () => {
  assert.equal(CODEX_TOOL_TIMEOUT_SECONDS, DERIVED);
  for (const file of ['docs/hosts.md', 'docs/agent-onboarding/llms-install.md']) {
    const doc = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
    const quoted = [...doc.matchAll(/tool_timeout_sec = (\d+)|at least (\d+) s/g)].map(m => Number(m[1] ?? m[2]));
    assert.ok(quoted.length >= 2, `${file} must state the timeout`);
    for (const n of quoted) assert.equal(n, CODEX_TOOL_TIMEOUT_SECONDS, file);
  }
});

test('a new Codex binding carries tool_timeout_sec, and the user text before it is untouched', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.project, '.codex/config.toml'), USER);
    const plan = configOf((await f.plan()).plans)!;
    assert.ok(plan.after.startsWith(USER), 'existing bytes must be a verbatim prefix');
    assert.match(plan.after, new RegExp(`\\[mcp_servers\\.popclaw\\]\\n(?:.*\\n)*?tool_timeout_sec = ${DERIVED}\\n`));
  } finally { rmSync(f.base, { recursive: true }); }
});

async function boundText(f: ReturnType<typeof fixture>): Promise<string> {
  writeFileSync(join(f.project, '.codex/config.toml'), USER);
  return configOf((await f.plan()).plans)!.after;
}

test('a user-set larger value is preserved: nothing is planned for config.toml', async () => {
  const f = fixture();
  try {
    const bound = (await boundText(f)).replace(`tool_timeout_sec = ${DERIVED}`, 'tool_timeout_sec = 1800   # mine');
    writeFileSync(join(f.project, '.codex/config.toml'), bound);
    assert.equal(configOf((await f.plan()).plans), undefined);
  } finally { rmSync(f.base, { recursive: true }); }
});

test('a smaller value is raised, and only that value changes', async () => {
  const f = fixture();
  try {
    const bound = (await boundText(f)).replace(`tool_timeout_sec = ${DERIVED}`, 'tool_timeout_sec = 120 # old');
    writeFileSync(join(f.project, '.codex/config.toml'), bound);
    const plan = configOf((await f.plan()).plans)!;
    assert.equal(plan.after, bound.replace('tool_timeout_sec = 120 # old', `tool_timeout_sec = ${DERIVED} # old`));
  } finally { rmSync(f.base, { recursive: true }); }
});

test('a missing value is inserted under the popclaw header, and nothing else changes', async () => {
  const f = fixture();
  try {
    const bound = (await boundText(f)).replace(`tool_timeout_sec = ${DERIVED}\n`, '');
    writeFileSync(join(f.project, '.codex/config.toml'), bound);
    const plan = configOf((await f.plan()).plans)!;
    assert.equal(plan.after, bound.replace('[mcp_servers.popclaw]\n', `[mcp_servers.popclaw]\ntool_timeout_sec = ${DERIVED}\n`));
  } finally { rmSync(f.base, { recursive: true }); }
});

test('nothing is written on the Claude Code side', async () => {
  const f = fixture();
  try {
    const plans = (await f.plan('claude')).plans;
    const claude = plans.find(p => p.path.endsWith('.mcp.json'))!;
    assert.ok(claude, 'Claude binding is planned');
    const server = JSON.parse(claude.after).mcpServers.popclaw;
    assert.deepEqual(Object.keys(server).sort(), ['args', 'command', 'env']);
  } finally { rmSync(f.base, { recursive: true }); }
});

// THE OVERWRITE GUARD. It compares the binding with `tool_timeout_sec` set
// aside, so the two cases that differ ONLY in that field (a managed binding
// that predates it, a user's larger value) reach the one-field merge above
// instead of being refused as a conflict. These two pin the other half: a
// re-run changes nothing, and any OTHER difference is still refused.
test('re-running setup on the same package is idempotent', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.project, '.codex/config.toml'), await boundText(f));
    assert.equal(configOf((await f.plan()).plans), undefined);
  } finally { rmSync(f.base, { recursive: true }); }
});

test('a binding that differs in anything but the timeout is still refused, and nothing is planned', async () => {
  const f = fixture();
  try {
    const bound = (await boundText(f)).replace(`tool_timeout_sec = ${DERIVED}\n`, '')
      .replace(/^command = ".*"$/m, 'command = "/somewhere/else/node"');
    writeFileSync(join(f.project, '.codex/config.toml'), bound);
    await assert.rejects(f.plan(), /Codex PopClaw is already configured differently; nothing was overwritten/);
  } finally { rmSync(f.base, { recursive: true }); }
});

// THE UPGRADE PATH: an installed root switching to a newer package passes the
// old one as `previousPackage`. The binding is then re-serialised whole
// (`toml.stringify`, which predates this branch): values survive, comments do
// not. These cases pin what is true today; the comment loss is noted, not fixed.
describe('the previousPackage upgrade path', () => {
  const oldBinding = async (f: ReturnType<typeof fixture>) => {
    writeFileSync(join(f.project, '.codex/config.toml'), USER);
    return configOf((await f.plan()).plans)!.after; // written by the OLD package
  };
  const upgrade = (f: ReturnType<typeof fixture>) => f.plan('codex', { package: f.next, previousPackage: f.pkg });

  test('upgrade: the package path moves and a missing timeout is raised to the derived value', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.project, '.codex/config.toml'), (await oldBinding(f)).replace(`tool_timeout_sec = ${DERIVED}\n`, ''));
      const after = configOf((await upgrade(f)).plans)!.after;
      const server = (toml.parse(after) as { mcp_servers: { popclaw: { args: string[]; tool_timeout_sec: number } } }).mcp_servers.popclaw;
      assert.equal(server.args[0], join(f.next, 'dist/bundled/mcp.js'));
      assert.equal(server.tool_timeout_sec, DERIVED);
    } finally { rmSync(f.base, { recursive: true }); }
  });

  test('upgrade: a smaller timeout is raised to the derived value', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.project, '.codex/config.toml'), (await oldBinding(f)).replace(`tool_timeout_sec = ${DERIVED}`, 'tool_timeout_sec = 120'));
      const after = configOf((await upgrade(f)).plans)!.after;
      assert.equal((toml.parse(after) as { mcp_servers: { popclaw: { tool_timeout_sec: number } } }).mcp_servers.popclaw.tool_timeout_sec, DERIVED);
    } finally { rmSync(f.base, { recursive: true }); }
  });

  test('upgrade: a larger user timeout is kept', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.project, '.codex/config.toml'), (await oldBinding(f)).replace(`tool_timeout_sec = ${DERIVED}`, 'tool_timeout_sec = 1800'));
      const after = configOf((await upgrade(f)).plans)!.after;
      const server = (toml.parse(after) as { mcp_servers: { popclaw: { args: string[]; tool_timeout_sec: number } } }).mcp_servers.popclaw;
      assert.equal(server.tool_timeout_sec, 1800);
      assert.equal(server.args[0], join(f.next, 'dist/bundled/mcp.js'));
    } finally { rmSync(f.base, { recursive: true }); }
  });

  test('upgrade: re-running on the new package plans nothing', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.project, '.codex/config.toml'), (await oldBinding(f)).replace(`tool_timeout_sec = ${DERIVED}\n`, ''));
      writeFileSync(join(f.project, '.codex/config.toml'), configOf((await upgrade(f)).plans)!.after);
      assert.equal(configOf((await upgrade(f)).plans), undefined);
    } finally { rmSync(f.base, { recursive: true }); }
  });

  test('upgrade: unrelated values survive the re-serialisation; comments do not (pre-existing, noted)', async () => {
    const f = fixture();
    try {
      const before = (await oldBinding(f)).replace(`tool_timeout_sec = ${DERIVED}\n`, '');
      writeFileSync(join(f.project, '.codex/config.toml'), before);
      const after = configOf((await upgrade(f)).plans)!.after;
      const was = toml.parse(before) as Record<string, unknown> & { mcp_servers: Record<string, unknown> };
      const now = toml.parse(after) as Record<string, unknown> & { mcp_servers: Record<string, unknown> };
      // Everything but the popclaw binding is the same data.
      assert.deepEqual({ ...now, mcp_servers: {} }, { ...was, mcp_servers: {} });
      assert.equal(now['model'], 'unchanged');
      assert.deepEqual(now['profiles'], { fast: { model: 'x' } });
      // TRUE TODAY, NOT FIXED HERE: toml.stringify drops the user's comments on
      // this path. Pinned so a change in either direction is noticed.
      assert.ok(before.includes('# keep this comment'));
      assert.ok(!after.includes('# keep this comment'));
    } finally { rmSync(f.base, { recursive: true }); }
  });
});
