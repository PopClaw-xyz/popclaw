import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/** Self-contained worker source, embedded in every shipped composition root.
 * Keeping compilation here makes native installs independent of node_modules.
 * The metafile names what the worker inlines, for the bundle's license closure. */
export async function buildSchemaWorker() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/host/schema-validator-worker.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    write: false, minify: false, legalComments: 'eof', metafile: true,
  });
  return { source: result.outputFiles[0].text, metafile: result.metafile };
}

export async function buildSchemaWorkerSource() {
  return (await buildSchemaWorker()).source;
}
