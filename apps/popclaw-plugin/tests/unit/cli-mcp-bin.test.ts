import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBundle } from '../helpers/ensure-bundle.js';

/**
 * `popclaw mcp` against the file that actually ships.
 *
 * The dispatch unit test next door proves the routing; this one proves the
 * destination — that the bin published as `popclaw` really speaks MCP on
 * stdio, that nothing on the way in writes prose to fd 1 (in a stdio MCP
 * server fd 1 IS the protocol channel: one stray log line and the client drops
 * the session), and that EOF on stdin ends the process instead of hanging a
 * host's shutdown.
 *
 * Public install instructions have taught `npx -y popclaw@0.1.0 mcp` while the
 * bin answered `unknown subcommand "mcp"` and exited 2. Only a run of the
 * built bundle can tell the two apart.
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = join(PKG_ROOT, 'dist/bundled/cli.js');

let dataRoot: string;

beforeAll(async () => {
  await ensureBundle(PKG_ROOT, CLI_PATH);
  dataRoot = mkdtempSync(join(tmpdir(), 'popclaw-cli-mcp-'));
}, 300_000);

afterAll(() => {
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

interface JsonRpcFrame {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: unknown;
  method?: string;
}

function runCli(args: string[], env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Collect stdout as newline-delimited frames; `wait(id)` resolves on that id. */
function frameReader(child: ChildProcessWithoutNullStreams) {
  const lines: string[] = [];
  const waiters = new Map<number | string, (frame: JsonRpcFrame) => void>();
  let buffer = '';
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
    tail: () => buffer,
    wait(id: number, timeoutMs = 30_000): Promise<JsonRpcFrame> {
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(
          () => rejectPromise(new Error(`no JSON-RPC response for id ${id}; stdout so far: ${JSON.stringify(lines)}`)),
          timeoutMs,
        );
        waiters.set(id, (frame) => {
          clearTimeout(timer);
          resolvePromise(frame);
        });
      });
    },
  };
}

function send(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function exited(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('process did not exit')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

describe('the built popclaw bin', () => {
  it(
    'serves MCP on stdio for `popclaw mcp`, with nothing but JSON-RPC on stdout',
    async () => {
      const child = runCli(['mcp'], {
        POPCLAW_DATA_ROOT: dataRoot,
        POPCLAW_NOTIFICATION_CONSUMER: 'cli-mcp-bin-test',
        POPCLAW_RECEIVE_ON_START: '0',
      });
      const reader = frameReader(child);
      try {
        send(child, {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'cli-mcp-bin-test', version: '1' },
          },
        });
        const initialize = await reader.wait(1);
        expect(initialize.jsonrpc).toBe('2.0');
        expect(initialize.error).toBeUndefined();
        expect(initialize.result).toBeTruthy();

        send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
        send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const list = await reader.wait(2);
        expect(list.error).toBeUndefined();
        const tools = (list.result as { tools?: Array<{ name: string; annotations?: Record<string, unknown> }> } | undefined)?.tools ?? [];
        expect(tools.length).toBeGreaterThan(0);
        // The shipped bundle declares a host's permission hints on every tool,
        // and the send door never claims to be read-only.
        for (const tool of tools) {
          expect(Object.keys(tool.annotations ?? {}).sort(), tool.name)
            .toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']);
        }
        const byName = new Map(tools.map((t) => [t.name, t.annotations]));
        expect(byName.get('popclaw_send_draft')).toMatchObject({ readOnlyHint: false, openWorldHint: true });
        expect(byName.get('popclaw_notifications')).toMatchObject({ readOnlyHint: false });

        // fd 1 carries the protocol and nothing else: every line so far must
        // parse, and no partial line may be left behind by a prose write.
        for (const line of reader.lines) {
          const frame = JSON.parse(line) as JsonRpcFrame;
          expect(frame.jsonrpc, `stray stdout line: ${line}`).toBe('2.0');
        }
        expect(reader.tail()).toBe('');

        // EOF on stdin is a host closing the session; it must end the process.
        child.stdin.end();
        expect(await exited(child)).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
    120_000,
  );

  it(
    'still prints usage on stdout for `--help` (the stdout guard is MCP-only)',
    async () => {
      const child = runCli(['--help']);
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
      expect(await exited(child)).toBe(0);
      expect(out).toContain('popclaw mcp');
    },
    60_000,
  );

  it(
    'refuses an unknown head with exit 2 and speaks no JSON-RPC',
    async () => {
      const child = runCli(['bogus']);
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
      expect(await exited(child)).toBe(2);
      expect(out).not.toContain('"jsonrpc"');
    },
    60_000,
  );

  it(
    'keeps the safe refusal when POPCLAW_DATA_ROOT is missing or relative',
    async () => {
      for (const root of [undefined, 'relative/root']) {
        const env = { ...process.env } as Record<string, string | undefined>;
        delete env['POPCLAW_DATA_ROOT'];
        if (root !== undefined) env['POPCLAW_DATA_ROOT'] = root;
        const child = spawn(process.execPath, [CLI_PATH, 'mcp'], {
          cwd: tmpdir(),
          env: env as Record<string, string>,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          out += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          err += chunk;
        });
        const code = await exited(child);
        expect(code, `root ${String(root)} must not start a server`).not.toBe(0);
        expect(err).toContain('POPCLAW_DATA_ROOT');
        expect(out).toBe('');
      }
    },
    60_000,
  );
});
