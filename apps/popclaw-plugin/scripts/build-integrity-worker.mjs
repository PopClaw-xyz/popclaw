import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
export async function buildIntegrityWorker() {
 const result = await build({entryPoints: [fileURLToPath(new URL('../src/host/integrity-worker.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false,
  minify: false, legalComments: 'eof', metafile: true});
 return {source: result.outputFiles[0].text, metafile: result.metafile};
}
