/**
 * The setup probe must ask for tools the shipped MCP server actually lists.
 *
 * `probeMcp` refuses to write any host configuration unless `tools/list`
 * contains every name in `MCP_REQUIRED_TOOLS`. The connector tests drive a
 * fixture server that echoes whatever list they are told to, so a tool
 * removed from the real surface (as `popclaw_resolve_message` was in the
 * tool-surface 0.1 work) left the fixtures green while every fresh setup on
 * Claude Code and Codex failed. These tests look at the real surface instead:
 * the built bundle over stdio, and the static manifest agents see.
 *
 * Runs under `node --import tsx --test`, like the rest of tests/setup.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_REQUIRED_TOOLS, probeMcp } from '../../src/setup/connector.mjs';
import { MCP_ONLY_TOOLS } from '../../src/tools/tool-annotations.js';
import { ensureBundle } from '../helpers/ensure-bundle.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MCP_PATH = join(PKG_ROOT, 'dist/bundled/mcp.js');

/** Environment for a server that must not touch anything outside `base`. */
function isolatedEnv(base: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: join(base, 'home'), TMPDIR: base };
}

/** `initialize` + `tools/list` against the shipped bundle, exactly as a host does. */
function listTools(root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((resolveList, reject) => {
    const child = spawn(process.execPath, [MCP_PATH], {
      cwd: PKG_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, POPCLAW_DATA_ROOT: root, POPCLAW_NOTIFICATION_CONSUMER: 'setup-probe-test', POPCLAW_RECEIVE_ON_START: '0', POPCLAW_MCP_ENABLE_RANGER: '0' },
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('tools/list timed out')); }, 30_000);
    const send = (q: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...q }) + '\n');
    let buffer = '';
    child.stderr.resume();
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`MCP exited (${code}) before tools/list`)); });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 1) { send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/list', params: {} }); }
        if (message.id === 2) {
          clearTimeout(timer); child.removeAllListeners('exit'); child.kill('SIGKILL');
          resolveList((message.result?.tools ?? []).map((t: { name: string }) => t.name));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'setup-probe-test', version: '1' } } });
  });
}

describe('setup probe against the real tool surface', () => {
  let base: string;
  before(async () => {
    await ensureBundle(PKG_ROOT, MCP_PATH);
    base = mkdtempSync(join(realpathSync(tmpdir()), 'popclaw-probe-surface-'));
  });
  after(() => { if (base) rmSync(base, { recursive: true, force: true }); });

  test('the shipped MCP server lists every tool the probe requires', async () => {
    const listed = new Set(await listTools(join(base, 'list-root'), isolatedEnv(base)));
    assert.ok(listed.size > 0, 'tools/list returned no tools');
    const missing = MCP_REQUIRED_TOOLS.filter(n => !listed.has(n));
    assert.deepEqual(missing, [], `probe requires tools the bundle does not list: ${missing.join(', ')}`);
  });

  test('probeMcp passes against the shipped bundle', async () => {
    await probeMcp(PKG_ROOT, join(base, 'probe-root'), process.execPath, isolatedEnv(base), 30_000);
  });
});

test('every probe-required tool is declared: static manifest, or MCP-only by design', () => {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'openclaw.plugin.json'), 'utf8'));
  const declared = new Set<string>([...manifest.contracts.tools, ...MCP_ONLY_TOOLS]);
  const undeclared = MCP_REQUIRED_TOOLS.filter(n => !declared.has(n));
  assert.deepEqual(undeclared, [], `probe requires undeclared tools: ${undeclared.join(', ')}`);
});

/**
 * A fake package whose `dist/bundled/mcp.js` answers `initialize` and then
 * lists exactly `tools` — the fixture-server pattern from setup.test.ts,
 * self-contained.
 */
function fakePackage(base: string, tools: string[]): string {
  const pkg = join(base, 'package');
  mkdirSync(join(pkg, 'dist/bundled'), { recursive: true });
  writeFileSync(join(pkg, 'dist/bundled/mcp.js'), `import readline from 'node:readline'; for await (const line of readline.createInterface({input:process.stdin})) {const q=JSON.parse(line); if(q.id) console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.id===1?{serverInfo:{name:'fixture'},capabilities:{tools:{}}}:{tools:${JSON.stringify(tools)}.map(name=>({name}))}}));}`);
  return pkg;
}

describe('setup probe refuses a server missing required tools, naming them', () => {
  const cases: Array<[string, string[]]> = [
    ['one missing tool', ['popclaw_show_inbox']],
    ['two missing tools', ['popclaw_notifications', 'popclaw_acknowledge_notifications']],
  ];
  for (const [label, omitted] of cases) {
    test(label, async () => {
      const base = mkdtempSync(join(realpathSync(tmpdir()), 'popclaw-probe-missing-'));
      try {
        const listed = [...MCP_REQUIRED_TOOLS.filter(n => !omitted.includes(n)), 'popclaw_check_status'];
        const pkg = fakePackage(base, listed);
        await assert.rejects(
          probeMcp(pkg, join(base, 'root'), process.execPath, isolatedEnv(base), 10_000),
          (error: Error) => {
            assert.equal(error.message, `MCP package is missing collaboration tools: ${omitted.join(', ')}; upgrade PopClaw first`);
            return true;
          },
        );
      } finally { rmSync(base, { recursive: true, force: true }); }
    });
  }

  test('a server listing every required tool passes', async () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'popclaw-probe-complete-'));
    try {
      await probeMcp(fakePackage(base, [...MCP_REQUIRED_TOOLS]), join(base, 'root'), process.execPath, isolatedEnv(base), 10_000);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

test('the probe requires exactly the tools the installed hooks name', () => {
  // An empty list would make every probe pass vacuously.
  assert.ok(MCP_REQUIRED_TOOLS.length > 0, 'MCP_REQUIRED_TOOLS is empty');
  assert.deepEqual([...MCP_REQUIRED_TOOLS], ['popclaw_notifications', 'popclaw_show_inbox', 'popclaw_acknowledge_notifications']);
});
