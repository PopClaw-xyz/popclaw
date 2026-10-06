/** Independent process: closing a read handle here cannot drop the resident
 * process's POSIX SQLite locks. Never read live database bytes with plain fs. */
import { createRequire } from 'node:module';
import type { Database as SqliteDatabase, Options } from 'better-sqlite3';
import { inspectIntegrityDatabase } from './integrity-probes.js';
import type { HostDb } from './host-db.js';
const require = createRequire(process.cwd() + '/integrity-probe.cjs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', bytes => { input += bytes; });
process.stdin.on('end', () => {
  const deps = JSON.parse(input) as {nativeModule: string; nativeModules: Record<string, string>; nativeBinding?: string; dbs: Array<{label: string; path: string}>};
  // Vendored installs have no node_modules tree. Resolve all three native
  // package names to the exact absolute entries selected by the parent banner.
  const Module = require('node:module') as {_resolveFilename: (request: string, parent: unknown, ...rest: unknown[]) => string};
  const original = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, ...rest) {
    return original.call(this, deps.nativeModules[request] ?? request, parent, ...rest);
  };
  const Database = require(deps.nativeModule) as new (path: string, options: Options) => SqliteDatabase;
  const results = deps.dbs.map(({label, path}) => {
    let db: SqliteDatabase | undefined;
    const started = performance.now();
    try {
      db = new Database(path, {readonly: true, fileMustExist: true, nativeBinding: deps.nativeBinding});
      const handle = db;
      const adapter = {queryAll: (sql: string) => handle.prepare(sql).all()} as HostDb;
      const result = handle.transaction(() => inspectIntegrityDatabase(adapter))();
      return {label, result, elapsedMs: performance.now() - started};
    } catch (error) { return {label, error: String(error), elapsedMs: performance.now() - started}; }
    finally { db?.close(); }
  });
  process.stdout.write(JSON.stringify({pid: process.pid, results}));
});
