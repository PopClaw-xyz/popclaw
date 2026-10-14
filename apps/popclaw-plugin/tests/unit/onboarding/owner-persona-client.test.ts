import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOwnerPersonaFromEnv as readClient } from '../../../src/onboarding/owner-persona-client.js';
import { readOwnerPersonaFromEnv as readFull, PERSONA_ENV } from '../../../src/onboarding/owner-persona-file.js';

describe('client naming material', () => {
  it('excludes the configured file while the full/operator source retains it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'popclaw-client-persona-'));
    try {
      const file = join(directory, 'synthetic.md');
      await writeFile(file, 'Synthetic private naming material');
      const env = { [PERSONA_ENV]: file };
      expect(await readFull(env)).toBe('Synthetic private naming material');
      expect(await readClient(env)).toBeUndefined();
    } finally { await rm(directory, {recursive: true, force: true}); }
  });
  it('does not inspect any supplied environment value', async () => {
    let reads = 0;
    const env = new Proxy({}, { get: () => { reads++; return undefined; } });
    expect(await readClient(env)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
