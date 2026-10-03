/**
 * Stop a test run that would damage the tree it is running in.
 *
 * `local-host-db.ts` repairs a mismatched native binding by rebuilding it IN
 * PLACE (`rebuildNativeBinding`, via `npx node-gyp rebuild` with the resolved
 * package directory as cwd). For an end user that is exactly right: an
 * unattended plugin that heals itself beats one that dies. In a development
 * worktree it means something else — running the suite under a Node whose ABI
 * does not match the installed binary silently re-binds better-sqlite3 to THAT
 * Node, and every other Node then fails against the same tree.
 *
 * That is not hypothetical. On 2026-09-18 one run under the wrong Node left
 * this worktree's binding rebound; the next full run reported 1807 failures,
 * and the conclusion very nearly drawn from it was "the change under review
 * broke 1737 tests". The change was fine. The measurement was measuring the
 * damage from the previous run.
 *
 * So: load the native module once, before any test does, and refuse to go on
 * if it will not load. A suite that cannot open a database is not a suite
 * whose result means anything, and the hundreds of downstream errors it would
 * otherwise produce all describe the symptom rather than the cause.
 *
 * Deliberately NOT a check of `process.version` against `engines`. That is a
 * policy question and belongs with the CI pin that declares the same policy;
 * this file asks a narrower one — do the two things on disk agree — which is
 * true or false regardless of which Node lines the project supports, and is
 * answered by the binary rather than by a version string.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

try {
  // Opening a database, not merely requiring the package. `require()` returns
  // the JS wrapper and touches no native code — with the compiled binary
  // deleted outright it still resolves happily, and a guard written that way
  // passes through exactly the state it exists to catch (measured: require OK,
  // `new Database` throws "Could not locate the bindings file"). `:memory:`
  // touches no disk and costs microseconds.
  const Database = require('better-sqlite3') as new (path: string) => { close(): void };
  new Database(':memory:').close();
} catch (err) {
  const cause = err instanceof Error ? err.message.split('\n')[0] : String(err);
  throw new Error(
    [
      `better-sqlite3 will not load under Node ${process.version}.`,
      ``,
      `  ${cause}`,
      ``,
      `The run is stopped here on purpose. Continuing would let the plugin's own`,
      `self-heal (src/host/local-host-db.ts, rebuildNativeBinding) rebuild the`,
      `binding in place for this Node — repairing this run and breaking the tree`,
      `for every other Node, including the one the live checkouts use.`,
      ``,
      `Check which Node you are on first; this package declares its supported`,
      `range in package.json "engines" and in src/runtime/node-support.ts.`,
      ``,
      `To restore a tree whose binding was already rebound, move the stale build`,
      `aside and let the prebuilt binary come back:`,
      `  mv node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build /tmp/stale-build`,
      `  pnpm rebuild -r better-sqlite3`,
    ].join('\n'),
  );
}
