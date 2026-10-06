import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordIntegrityResults, type IntegrityFinding } from './integrity-check.js';
import type { inspectIntegrityDatabase } from './integrity-probes.js';

declare const __POPCLAW_INTEGRITY_WORKER_SOURCE__: string;
const require = createRequire(import.meta.url);
interface ProbeReply {
 pid: number;
 results: Array<{label: string; result?: ReturnType<typeof inspectIntegrityDatabase>; error?: string; elapsedMs: number}>;
}
/** One bounded, read-only process per boot batch; no host SDK or network. */
export async function runIntegrityChecksInProcess(deps: {
 dbs: ReadonlyArray<{label: string; path: string}>; stateFile: string; build: string;
 signal?: AbortSignal; onError?: (label: string, error: unknown) => void;
 onMeasured?: (reply: ProbeReply) => void;
}): Promise<IntegrityFinding[]> {
 if (deps.signal?.aborted) return [];
 const nativeModule = require.resolve('better-sqlite3');
 const bindings = require.resolve('bindings', {paths: [dirname(nativeModule)]});
 const nativeModules = {'better-sqlite3': nativeModule, bindings,
  'file-uri-to-path': require.resolve('file-uri-to-path', {paths: [dirname(bindings)]})};
 const nativeDir = join(dirname(dirname(nativeModule)), 'build', 'Release');
 const major = process.versions.node.split('.')[0];
 const nativeBinding = [`better_sqlite3-${process.platform}-${process.arch}-node${major}.node`, `better_sqlite3-node${major}.node`]
  .map(name => join(nativeDir, name)).find(path => existsSync(path));
 const source = typeof __POPCLAW_INTEGRITY_WORKER_SOURCE__ === 'string' ? __POPCLAW_INTEGRITY_WORKER_SOURCE__ : undefined;
 const worker = new URL('./integrity-worker.js', import.meta.url);
 const args = source ? ['--input-type=commonjs', '-e', source]
  : existsSync(fileURLToPath(worker)) ? [fileURLToPath(worker)]
  : ['--import', 'tsx', fileURLToPath(new URL('./integrity-worker.ts', import.meta.url))];
 const reply = await new Promise<ProbeReply | undefined>((resolve, reject) => {
  const child = spawn(process.execPath, args, {stdio: ['pipe', 'pipe', 'pipe']});
  let stdout = ''; let stderr = ''; let failure: Error | undefined;
  const abort = () => { child.kill('SIGKILL'); };
  const timeout = setTimeout(() => { failure = new Error('INTEGRITY_PROCESS_TIMEOUT'); abort(); }, 120_000);
  deps.signal?.addEventListener('abort', abort, {once: true});
  child.stdout.on('data', bytes => { stdout += String(bytes); });
  child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-4000); });
  child.stdin.on('error', error => { failure = error; });
  child.once('error', error => { failure = error; });
  child.once('close', code => {
   clearTimeout(timeout); deps.signal?.removeEventListener('abort', abort);
   if (deps.signal?.aborted) { resolve(undefined); return; }
   if (failure) { reject(failure); return; }
   if (code !== 0) { reject(new Error(`INTEGRITY_PROCESS_FAILED: ${code}: ${stderr}`)); return; }
   try { resolve(JSON.parse(stdout) as ProbeReply); } catch (error) { reject(error); }
  });
  child.stdin.end(JSON.stringify({dbs: deps.dbs, nativeModule, nativeModules, nativeBinding}));
  if (deps.signal?.aborted) abort();
 });
 if (!reply || deps.signal?.aborted) return [];
 deps.onMeasured?.(reply);
 for (const row of reply.results) if (row.error) deps.onError?.(row.label, row.error);
 return recordIntegrityResults(deps, reply.results);
}
