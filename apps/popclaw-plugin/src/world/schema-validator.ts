import { validateSchemaInWorker } from '../host/schema-validator.js';
import { parseWorldJson } from './json-profile.js';
import { validateWorldSchema } from './world-capabilities.js';

export interface WorldPayloadValidationOptions {
  /** Bound selected by the protocol message type: params, result or event. */
  maxBytes: number;
  signal?: AbortSignal;
  /** Includes startup, schema compilation and validation; defaults to 1s. */
  timeoutMs?: number;
}

/** Validate a payload against a trusted capability's pinned profile. This must
 * be awaited before signing or consuming the payload. Resource exhaustion is
 * a validation failure, never permission to bypass the schema. */
export async function validateWorldPayload(schema: Record<string, unknown>, bytes: Uint8Array, options: WorldPayloadValidationOptions): Promise<void> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 262144) throw new Error('JSON_SIZE_LIMIT');
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('SCHEMA_TIMEOUT_INVALID');
  if (options.signal?.aborted) throw new Error('CAPABILITY_ABORTED');
  validateWorldSchema(schema);
  const payload = parseWorldJson(bytes, options.maxBytes);
  await validateSchemaInWorker(schema, payload, { signal: options.signal, timeoutMs });
}
