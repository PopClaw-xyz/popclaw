/**
 * A module-resolution hook that records every request for the host package and
 * then gets out of the way.
 *
 * It does NOT satisfy the request: `next(specifier, context)` runs the normal
 * resolver, so in a directory with no `openclaw` installed the import still
 * fails exactly as it does on a real MCP host. The recording is the only
 * addition — one line per specifier, appended to `POPCLAW_RESOLUTION_LOG`.
 *
 * Both halves of the claim are therefore measured by the same run: a STATIC
 * import shows up here AND kills the process, while a lazy import that is never
 * reached leaves the file empty.
 */
import { appendFileSync } from 'node:fs';
import { env } from 'node:process';

const LOG = env['POPCLAW_RESOLUTION_LOG'];

export async function resolve(specifier, context, next) {
  if (LOG && (specifier === 'openclaw' || specifier.startsWith('openclaw/'))) {
    appendFileSync(LOG, `${specifier}\n`);
  }
  return next(specifier, context);
}
