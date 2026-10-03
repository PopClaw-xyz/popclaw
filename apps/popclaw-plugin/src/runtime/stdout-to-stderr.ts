/**
 * ⚠️ MCP composition root only. Import this FIRST, before any other module.
 *
 * In an MCP stdio server fd 1 IS the protocol channel: one stray `console.log`
 * from anywhere in the boot path — ours or a dependency's — corrupts the JSON-RPC
 * stream and the client drops the session. Auditing every caller cannot stay true
 * as dependencies change, so we take the fd away instead: `process.stdout.write`
 * is rerouted to stderr and the only remaining handle to the real fd 1 is
 * `protocolStdout`, which is handed to the MCP transport and nothing else.
 *
 * NOT covered: writers that bypass `process.stdout.write` and hit the fd directly
 * (pino/sonic-boom uses `fs.writeSync(1, …)`). Those must be pointed at fd 2
 * explicitly — see `pinoHostLogger(level, pino.destination(2))` in mcp.ts.
 *
 * It lives in its own module because ESM evaluates imports before the importing
 * module's body: only a first-position import runs before everything else.
 */

import { Writable } from 'node:stream';

const realStdoutWrite = process.stdout.write.bind(process.stdout);

/** The only surviving handle to the real fd 1. For the MCP transport alone. */
export const protocolStdout = new Writable({
  write(chunk: unknown, encoding: unknown, cb: (err?: Error | null) => void): void {
    realStdoutWrite(chunk as Uint8Array, encoding as BufferEncoding, cb);
  },
});

process.stdout.write = ((
  chunk: Uint8Array | string,
  encoding?: unknown,
  cb?: unknown,
): boolean =>
  process.stderr.write(chunk, encoding as BufferEncoding, cb as never)) as typeof process.stdout.write;
