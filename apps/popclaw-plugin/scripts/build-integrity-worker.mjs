import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { bundleMinification } from './bundle-minification.mjs';
export async function buildIntegrityWorker() {
 const result = await build({entryPoints: [fileURLToPath(new URL('../src/host/integrity-worker.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false,
  metafile: true, ...bundleMinification});
 return {source: result.outputFiles[0].text, metafile: result.metafile};
}
