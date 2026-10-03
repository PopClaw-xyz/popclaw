import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBundle } from '../helpers/ensure-bundle.js';

/**
 * THE HOST PACKAGE IS NOT INSTALLED WHERE THE MCP ROOTS RUN — AND THE SUITE
 * USED TO BE UNABLE TO SEE THAT.
 *
 * `openclaw` is an OPTIONAL peer dependency (`package.json`
 * `peerDependenciesMeta.openclaw.optional`). On an OpenClaw gateway the host
 * provides it; on an MCP host — Claude Code, Codex — nobody does. A single
 * STATIC `import … from "openclaw/…"` reaching one of those roots is therefore
 * not a degraded feature, it is a process that never starts:
 *
 *     ERR_MODULE_NOT_FOUND: Cannot find package 'openclaw'
 *       imported from dist/bundled/mcp.js
 *
 * Module linking fails before any of our code runs, so `tools/list` is never
 * reached and the host shows the server as broken with no PopClaw message
 * anywhere. That shipped: `owner-approval-route.ts` brought in three static
 * imports and both MCP hosts stopped starting.
 *
 * WHY EVERY EXISTING TEST STAYED GREEN THROUGH IT, which is the part worth
 * remembering. `cli-mcp-bin.test.ts` does boot the real bundle — from inside
 * the package directory, where `apps/popclaw-plugin/node_modules/openclaw` sits
 * right there as a devDependency. Resolution always succeeded, so the suite was
 * measuring a machine that had the host installed while the break was exactly
 * "the host is not installed". The environment under test differed from the
 * environment that ships in precisely the way that mattered — which is the same
 * shape as every other defect this lane has had to find on real hardware: a
 * hook on the wrong table, a registry filled in one composition root, a guard
 * logging into a sink nobody reads. So this file aims at THAT DIFFERENCE, not
 * at the three import lines:
 *
 *   1. It reads the artifact and refuses static host-package import SYNTAX in
 *      general, so a fourth specifier is caught without being listed — with a
 *      positive control on `index.js` so a regex that stops matching goes red
 *      instead of passing everything.
 *   2. It boots the shipped file in a resolution environment where `openclaw`
 *      genuinely cannot be found, and gets to `tools/list`. That is the
 *      assertion closest to what broke: not "the text looks right" but "the
 *      process starts and serves".
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLED = join(PKG_ROOT, 'dist/bundled');
const MCP_PATH = join(BUNDLED, 'mcp.js');
/** Records every `openclaw` specifier the child asks the resolver for, without
 *  satisfying any of them — see the file's own header. */
const PRELOAD = join(PKG_ROOT, 'tests/helpers/openclaw-resolution-preload.mjs');

/**
 * STATIC ESM SYNTAX NAMING THE HOST PACKAGE — the three shapes a bundle can
 * carry, for ANY subpath:
 *
 *   `import … from "openclaw/x"`, `export … from "openclaw/x"`, and the bare
 *   side-effect `import "openclaw/x"`.
 *
 * A dynamic `import("openclaw/x")` is deliberately NOT matched: that is the
 * posture this module wants — resolution attempted at the moment of use, where
 * a failure is a refusal rather than a dead process.
 *
 * Deliberately not a list of known specifiers. The three that broke production
 * were found by diffing two bundles; a test that names them proves only that
 * those three are gone.
 */
const STATIC_HOST_IMPORT = /(?:\bfrom\s*|(?:^|[\s;})])import\s*)(["'])openclaw(?:\/[^"']*)?\1/g;

function staticHostImports(file: string): string[] {
  return readFileSync(file, 'utf8').match(STATIC_HOST_IMPORT)?.map((hit) => hit.trim()) ?? [];
}

describe('the artifacts that run where openclaw is not installed', () => {
  beforeAll(async () => {
    await ensureBundle(PKG_ROOT, MCP_PATH);
  }, 300_000);

  /**
   * THE MEASURING INSTRUMENT, CHECKED FIRST. `index.js` is the OpenClaw plugin
   * entry — the host loads it, so a static import there is correct and
   * expected. If the pattern above ever stops recognising the syntax it is
   * supposed to forbid, this control goes red and the host-free assertion below
   * cannot pass by finding nothing.
   */
  it('recognises the syntax it forbids, on the one root allowed to use it', () => {
    expect(staticHostImports(join(BUNDLED, 'index.js')).length).toBeGreaterThan(0);
  });

  /**
   * Every root that can run without a gateway. `mcp.js` is the reported break;
   * `cli.js` carries the same module graph and is what `npx -y popclaw mcp`
   * runs, so it has the same exposure and is not treated as a lesser case.
   */
  it.each(['mcp.js', 'mcp-hook.js', 'cli.js', 'prepare-native-world.js'])(
    'ships %s with no static openclaw import at all',
    (entry) => {
      expect(staticHostImports(join(BUNDLED, entry))).toEqual([]);
    },
  );
});

interface JsonRpcFrame {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: unknown;
}

/**
 * A directory where the bare specifier `openclaw` CANNOT resolve.
 *
 * Node walks `node_modules` upward from the importing file, so the only honest
 * way to remove the host package is to run the bundle from outside the
 * repository — `apps/popclaw-plugin/node_modules/openclaw` is what made every
 * previous run of the real bundle succeed. The layout mirrors what `npm`
 * installs: `<root>/bundled/<entry>` beside `<root>/native-deps`, which is the
 * pair the bundle's own banner resolves `better-sqlite3` through.
 *
 * `native-deps` is symlinked rather than copied — 12 MB of vendored native
 * module per test run is not worth it, and it is reached by CJS `require`,
 * which resolves through the link. The bundle itself is a real copy, because
 * its own location is what Node's ESM resolver walks up from.
 */
function isolatedRoot(entries: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-host-free-'));
  mkdirSync(join(root, 'bundled'));
  for (const entry of entries) copyFileSync(join(BUNDLED, entry), join(root, 'bundled', entry));
  symlinkSync(join(PKG_ROOT, 'dist/native-deps'), join(root, 'native-deps'));
  mkdirSync(join(root, 'data'));
  return root;
}

function frameReader(child: ChildProcessWithoutNullStreams) {
  const waiters = new Map<number | string, (frame: JsonRpcFrame) => void>();
  const failures = new Map<number | string, (error: Error) => void>();
  const lines: string[] = [];
  let buffer = '';
  // A process that died during module loading answers nothing, ever. Reporting
  // that as a 60-second timeout buries the actual message, which is the one
  // sentence a reader of this failure needs.
  child.once('exit', (code) => {
    for (const fail of failures.values()) fail(new Error(`the server exited (code ${String(code)}) before answering`));
    failures.clear();
    waiters.clear();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let cut = buffer.indexOf('\n');
    while (cut >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (line.trim()) {
        lines.push(line);
        let frame: JsonRpcFrame | undefined;
        try {
          frame = JSON.parse(line) as JsonRpcFrame;
        } catch {
          frame = undefined;
        }
        const id = frame?.id;
        if (frame && (typeof id === 'number' || typeof id === 'string')) {
          waiters.get(id)?.(frame);
          waiters.delete(id);
        }
      }
      cut = buffer.indexOf('\n');
    }
  });
  return {
    lines,
    wait(id: number, stderr: () => string, timeoutMs = 60_000): Promise<JsonRpcFrame> {
      return new Promise((resolvePromise, rejectPromise) => {
        const fail = (error: Error): void => rejectPromise(new Error(`${error.message}; stderr: ${stderr()}`));
        const timer = setTimeout(() => fail(new Error(`no JSON-RPC response for id ${id}`)), timeoutMs);
        const done = (): void => {
          clearTimeout(timer);
          failures.delete(id);
        };
        failures.set(id, (error) => { done(); fail(error); });
        waiters.set(id, (frame) => { done(); resolvePromise(frame); });
      });
    },
  };
}

describe('the shipped MCP roots, booted where openclaw cannot be resolved', () => {
  let root: string;
  const entries = ['mcp.js', 'cli.js'];

  beforeAll(async () => {
    await ensureBundle(PKG_ROOT, MCP_PATH);
    root = isolatedRoot(entries);
  }, 300_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['mcp.js', [] as string[]],
    ['cli.js', ['mcp']],
  ])('serves tools/list from %s with no openclaw on the resolution path', async (entry, args) => {
    const log = join(root, `${entry}.resolutions`);
    const child = spawn(process.execPath, ['--import', PRELOAD, join(root, 'bundled', entry), ...args], {
      cwd: root,
      env: {
        ...process.env,
        POPCLAW_DATA_ROOT: join(root, 'data'),
        POPCLAW_NOTIFICATION_CONSUMER: 'mcp-bundle-host-free-test',
        POPCLAW_RECEIVE_ON_START: '0',
        POPCLAW_RESOLUTION_LOG: log,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    const reader = frameReader(child);
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'mcp-bundle-host-free-test', version: '1' },
        },
      })}\n`);
      const initialize = await reader.wait(1, () => err);
      // Named explicitly: this is the failure this file exists for, and it
      // must not be reported as "no response for id 1".
      expect(err, 'the process died during module loading').not.toContain('ERR_MODULE_NOT_FOUND');
      expect(initialize.error).toBeUndefined();

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      const list = await reader.wait(2, () => err);
      expect(list.error).toBeUndefined();
      expect(((list.result as { tools?: unknown[] } | undefined)?.tools ?? []).length).toBeGreaterThan(0);

      // AND IT NEVER REACHED FOR THE HOST AT ALL — measured, not argued from
      // the call graph. The owner-approval route's dynamic import belongs to
      // the native `before_tool_call` hook, which only a gateway runs; on this
      // root nothing should ask the resolver for `openclaw` even once.
      expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 180_000);
});
