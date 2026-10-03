/**
 * `--import` preload for the spawned MCP root in
 * tests/unit/runtime/root-assembly-mcp.test.ts.
 *
 * It runs before src/mcp.ts in the same process and patches the PROTOTYPES of
 * the classes the MCP root instantiates (same module instances under tsx), so
 * component calls made by the real `buildRuntime` / shutdown can be observed
 * without touching src. Each event is appended synchronously to
 * `C0_PROBE_FILE`, so it survives the root's own `process.exit`.
 *
 * Only class members (prototype or static) are observable this way; factory
 * closures (owner authorization, relation reception, DM policy, the inline
 * loop starters) are not, and the test says so where it matters.
 *
 * `build.returning` marks that a build reached its return value:
 * `ScoreCache.load` is called exactly once, inside the runtime bag's object
 * literal — after the synchronous statements that call houses.start, submit
 * DM recovery, call the four inline loop starters and define `shutdown`. It
 * is not a sign that the build promise resolved, nor that DM recovery or any
 * loop's asynchronous work has run.
 *
 * `C0_MODE` injects one fault, each AFTER the real call has done its work:
 *   houses-stop-throws  HouseRuntime.stop rejects (shutdown first-throw)
 *   boot-fails          configureResources throws (failed boot after houses,
 *                       worlds and house stores are built)
 *   hold-boot           SocialGraph.start waits for stdin to end, so the
 *                       test can fire the root's closing signal mid-boot
 */
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { HouseRuntime } from '../../src/runtime/house-lifecycle/house-runtime.js';
import { WorldRuntime } from '../../src/runtime/world-runtime.js';
import { ExecutionStoreCatalog } from '../../src/host/execution-store.js';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { SocialGraph } from '../../src/social-graph/social-graph.js';
import { ScoreCache } from '../../src/recommend/score-cache.js';

const file = process.env['C0_PROBE_FILE'];
const mode = process.env['C0_MODE'] ?? '';
if (!file) throw new Error('C0_PROBE_FILE is required');
const emit = (event: string) => appendFileSync(file, `${event}\n`);

type Method = (...args: unknown[]) => unknown;
function patch(proto: object, name: string, wrap: (original: Method) => Method): void {
  const bag = proto as Record<string, Method>;
  bag[name] = wrap(bag[name]!);
}
const recordCall = (label: (self: unknown, args: unknown[]) => string) => (original: Method) =>
  function (this: unknown, ...args: unknown[]) {
    const event = label(this, args);
    if (event) emit(event);
    return original.apply(this, args);
  };

patch(HouseRuntime.prototype, 'start', recordCall(() => 'houses.start'));
patch(HouseRuntime.prototype, 'runCommand', recordCall(() => 'houses.runCommand'));
patch(HouseRuntime.prototype, 'stop', original => function (this: unknown, ...args: unknown[]) {
  emit('houses.stop');
  const result = original.apply(this, args);
  return mode === 'houses-stop-throws'
    ? Promise.resolve(result).then(() => { throw new Error('C0_HOUSES_STOP_FAILED'); })
    : result;
});
patch(HouseRuntime.prototype, 'configureResources', original => function (this: unknown, ...args: unknown[]) {
  const config = args[0] as { refreshMs?: number };
  emit(`houses.configure refreshMs=${'refreshMs' in config ? String(config.refreshMs) : '(absent)'}`);
  const result = original.apply(this, args);
  if (mode === 'boot-fails') { emit('boot.fail'); throw new Error('C0_FORCED_BOOT_FAILURE'); }
  return result;
});
patch(ScoreCache as unknown as object, 'load', recordCall(() => 'build.returning'));
patch(WorldRuntime.prototype, 'stop', recordCall(() => 'worlds.stop'));
patch(WorldRuntime.prototype, 'whenIdle', recordCall(() => 'worlds.whenIdle'));
patch(ExecutionStoreCatalog.prototype, 'close', recordCall(() => 'executionStores.close'));
patch(LocalHostDb.prototype, 'close', recordCall(self => {
  const name = (self as { handle?: { name?: string } }).handle?.name;
  const file = name ? basename(name) : '?';
  // Execution-store databases are named by a content hash; one label for all.
  return `db.close:${/^[0-9a-f]{32}\.db$/.test(file) ? '(execution store)' : file}`;
}));
// `releaseStorage` is the one statement that deletes this root's participant row.
patch(LocalHostDb.prototype, 'execute', recordCall((_self, args) =>
  String(args[0]).startsWith('DELETE FROM storage_runtime_participants_v1') ? 'release' : ''));
patch(SocialGraph.prototype, 'start', original => async function (this: unknown, ...args: unknown[]) {
  emit('socialGraph.start');
  if (mode === 'hold-boot') await new Promise<void>(resolve => process.stdin.once('end', () => resolve()));
  return original.apply(this, args);
});
