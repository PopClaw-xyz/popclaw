import { parentPort, workerData } from 'node:worker_threads';
import Ajv2020 from 'ajv/dist/2020.js';

if (!parentPort) throw new Error('SCHEMA_WORKER_REQUIRED');
try {
  const ajv = new Ajv2020({ strict: false, validateSchema: false, allErrors: false, unicodeRegExp: true });
  parentPort.postMessage({ valid: Boolean(ajv.compile(workerData.schema)(workerData.payload)) });
} catch { parentPort.postMessage({ failed: true }); }
