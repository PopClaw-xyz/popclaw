import pino from 'pino';
import type { HostLogger } from '../host/host-adapter.js';

/**
 * Adapter: pino `Logger` → our `HostLogger` shape.
 *
 * `destination` defaults to pino's own (stdout). The MCP composition root MUST
 * pass `pino.destination(2)`: in a stdio MCP server stdout is the protocol
 * channel, and pino writes straight to the fd (bypassing `process.stdout.write`),
 * so nothing else can redirect it.
 */
export function pinoHostLogger(
  level: pino.Level = 'info',
  destination?: pino.DestinationStream,
): HostLogger {
  const p = destination ? pino({ level }, destination) : pino({ level });
  return {
    info: (obj, msg) => p.info(obj, msg ?? ''),
    warn: (obj, msg) => p.warn(obj, msg ?? ''),
    error: (obj, msg) => p.error(obj, msg ?? ''),
  };
}
