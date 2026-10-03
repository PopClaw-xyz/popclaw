import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildSchemaWorkerSource } from './build-schema-worker.mjs';

const directory = await mkdtemp(join(tmpdir(), 'world-schema-consumer-'));
const runtime = join(directory, 'runtime.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../src/world/schema-validator.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: runtime,
  define: { __POPCLAW_SCHEMA_WORKER_SOURCE__: JSON.stringify(await buildSchemaWorkerSource()) },
  banner: { js: "import { createRequire as bundleRequire } from 'node:module'; const require = bundleRequire(import.meta.url);" },
  legalComments: 'eof',
});
const consumer = join(directory, 'consumer.mjs');
await writeFile(consumer, `
import assert from 'node:assert/strict';
import { validateWorldPayload } from ${JSON.stringify(pathToFileURL(runtime).href)};
const bytes = value => new TextEncoder().encode(JSON.stringify(value));
await validateWorldPayload({type:'string', pattern:'^.$'}, bytes('😀'), {maxBytes:128});
let responsive = false;
const timer = setTimeout(() => { responsive = true; }, 10);
await assert.rejects(validateWorldPayload({type:'string',pattern:'^(a+)+$'},bytes('a'.repeat(30)+'!'),{maxBytes:16384,timeoutMs:400}),/SCHEMA_VALIDATION_RESOURCE_LIMIT/);
clearTimeout(timer); assert.equal(responsive,true);
await validateWorldPayload({type:'boolean'},bytes(true),{maxBytes:128});
console.log(JSON.stringify({cleanBundle:true, hostResponsive:responsive, slotReleased:true}));
`);
const environment = { ...process.env }; delete environment.NODE_PATH;
const result = spawnSync(process.execPath, [consumer], { cwd: directory, env: environment, encoding: 'utf8', timeout: 15000 });
if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'clean schema worker consumer failed');
process.stdout.write(result.stdout);
console.log(JSON.stringify({ evidenceDirectory: directory }));
