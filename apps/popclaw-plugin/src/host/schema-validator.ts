import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const schemaRequire = createRequire(import.meta.url);
declare const __POPCLAW_SCHEMA_WORKER_SOURCE__: string | undefined;
const bundledSource = typeof __POPCLAW_SCHEMA_WORKER_SOURCE__ === 'string' ? __POPCLAW_SCHEMA_WORKER_SOURCE__ : undefined;
const MAX_WORKERS = 2;
let activeWorkers = 0;

// Constant code only; schema and data enter as structured workerData. A worker
// is disposable so both pathological compilation and RegExp backtracking have
// a hard resource boundary without blocking the host's lifecycle event loop.
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const Ajv = require(workerData.ajvPath).default;
  const ajv = new Ajv({strict:false, validateSchema:false, allErrors:false, unicodeRegExp:true});
  parentPort.postMessage({ valid: Boolean(ajv.compile(workerData.schema)(workerData.payload)) });
} catch { parentPort.postMessage({ failed: true }); }
`;

export interface SchemaWorkerOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

/** Host infrastructure for disposable, resource-bounded schema execution.
 * The caller owns protocol profile validation and payload size/parsing policy. */
export async function validateSchemaInWorker(schema: Record<string, unknown>, payload: unknown, options: SchemaWorkerOptions): Promise<void> {
  if (activeWorkers >= MAX_WORKERS) throw new Error('SCHEMA_VALIDATION_BUSY');
  activeWorkers++;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const worker = new Worker(bundledSource ?? SOURCE, { eval: true,
        // Bundled distribution contains its own Ajv. Only source development
        // resolves installed dependencies; installed plugins need none.
        workerData: { schema, payload, ...(bundledSource ? {} : { ajvPath: schemaRequire.resolve('ajv/dist/2020.js') }) },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', aborted);
        // Keep the concurrency slot until the OS thread has actually stopped.
        void worker.terminate().then(() => error ? reject(error) : resolve(), () => reject(error ?? new Error('SCHEMA_VALIDATION_FAILED')));
      };
      const aborted = () => finish(new Error('CAPABILITY_ABORTED'));
      const timer = setTimeout(() => finish(new Error('SCHEMA_VALIDATION_RESOURCE_LIMIT')), options.timeoutMs);
      options.signal?.addEventListener('abort', aborted, { once: true });
      if (options.signal?.aborted) aborted();
      worker.once('message', (result: { valid?: boolean; failed?: boolean }) => {
        finish(result.failed ? new Error('SCHEMA_VALIDATION_FAILED') : result.valid === true ? undefined : new Error('SCHEMA_VIOLATION'));
      });
      worker.once('error', error => finish(new Error(error.message.includes('memory') ? 'SCHEMA_VALIDATION_RESOURCE_LIMIT' : 'SCHEMA_VALIDATION_FAILED')));
      worker.once('exit', () => { if (!settled) finish(new Error('SCHEMA_VALIDATION_FAILED')); });
    });
  } finally { activeWorkers--; }
}
