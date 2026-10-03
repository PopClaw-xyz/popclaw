import { describe, expect, it } from 'vitest';
import { validateWorldPayload } from '../../../src/world/schema-validator.js';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
describe('isolated world schema validation', () => {
  it('enforces payload schemas and Unicode scalar length semantics', async () => {
    const schema = { type: 'string', pattern: '^.$', maxLength: 1 };
    await expect(validateWorldPayload(schema, bytes('😀'), { maxBytes: 16384 })).resolves.toBeUndefined();
    await expect(validateWorldPayload(schema, bytes('ab'), { maxBytes: 16384 })).rejects.toThrow('SCHEMA_VIOLATION');
  });
  it('bounds catastrophic regex execution while the host remains responsive', async () => {
    let responsive = false;
    const timer = setTimeout(() => { responsive = true; }, 10);
    await expect(validateWorldPayload({ type: 'string', pattern: '^(a+)+$' }, bytes('a'.repeat(30) + '!'), { maxBytes: 16384, timeoutMs: 400 })).rejects.toThrow('SCHEMA_VALIDATION_RESOURCE_LIMIT');
    clearTimeout(timer);
    expect(responsive).toBe(true);
    await expect(validateWorldPayload({ type: 'boolean' }, bytes(true), { maxBytes: 128 })).resolves.toBeUndefined();
  });
  it('terminates in-flight work on cancellation and releases the worker slot', async () => {
    const controller = new AbortController();
    const work = validateWorldPayload({ type: 'string', pattern: '^(a+)+$' }, bytes('a'.repeat(30) + '!'), { maxBytes: 16384, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(work).rejects.toThrow('CAPABILITY_ABORTED');
    await expect(validateWorldPayload({ type: 'boolean' }, bytes(true), { maxBytes: 128 })).resolves.toBeUndefined();
  });
  it('rejects unsafe payloads and unsupported schema keywords before dispatch', async () => {
    await expect(validateWorldPayload({ type: 'integer' }, new TextEncoder().encode('9007199254740993'), { maxBytes: 128 })).rejects.toThrow('JSON_INTEGER_REQUIRED');
    await expect(validateWorldPayload({ format: 'email' }, bytes('a'), { maxBytes: 128 })).rejects.toThrow('SCHEMA_PROFILE_INVALID');
  });
});
