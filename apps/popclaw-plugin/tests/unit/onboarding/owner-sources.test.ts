import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readOwnerPersonaFromEnv,
  fetchVerifiedHandles,
  PERSONA_ENV,
} from '../../../src/onboarding/owner-sources.js';

describe('readOwnerPersonaFromEnv (授权门)', () => {
  it('returns undefined when env var is absent — never touches the fs', async () => {
    expect(await readOwnerPersonaFromEnv({})).toBeUndefined();
  });

  it('returns undefined when env var is empty/whitespace', async () => {
    expect(await readOwnerPersonaFromEnv({ [PERSONA_ENV]: '  ' })).toBeUndefined();
  });

  it('reads the file the owner explicitly pointed at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'popclaw-persona-'));
    const path = join(dir, 'me.md');
    await writeFile(path, '我是一个爱看 AI 论文的摄影师。', 'utf-8');
    expect(await readOwnerPersonaFromEnv({ [PERSONA_ENV]: path })).toBe(
      '我是一个爱看 AI 论文的摄影师。',
    );
  });

  it('truncates content beyond 8KB', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'popclaw-persona-'));
    const path = join(dir, 'big.md');
    await writeFile(path, 'x'.repeat(10_000), 'utf-8');
    const got = await readOwnerPersonaFromEnv({ [PERSONA_ENV]: path });
    expect(got).toHaveLength(8 * 1024);
  });

  it('returns undefined when the file does not exist (no throw)', async () => {
    expect(
      await readOwnerPersonaFromEnv({ [PERSONA_ENV]: '/definitely/not/here.md' }),
    ).toBeUndefined();
  });
});

describe('fetchVerifiedHandles', () => {
  const POPCLAW_ID = '11111111111111111111111111111111';

  function fakeFetch(status: number, body?: unknown): typeof globalThis.fetch {
    return (async () =>
      new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
      })) as unknown as typeof globalThis.fetch;
  }

  it('extracts handles from /v1/profile profiles[]', async () => {
    const handles = await fetchVerifiedHandles({
      loreHouseUrl: 'http://localhost:8080/',
      popclawId: POPCLAW_ID,
      fetchImpl: fakeFetch(200, {
        profiles: [
          { platform: 'x', handle: 'blackfeather_ai' },
          { platform: 'github', handle: 'blackfeather' },
        ],
      }),
    });
    expect(handles).toEqual(['blackfeather_ai', 'blackfeather']);
  });

  it('returns [] on 404', async () => {
    const handles = await fetchVerifiedHandles({
      loreHouseUrl: 'http://localhost:8080',
      popclawId: POPCLAW_ID,
      fetchImpl: fakeFetch(404),
    });
    expect(handles).toEqual([]);
  });

  it('returns [] on network failure', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const handles = await fetchVerifiedHandles({
      loreHouseUrl: 'http://localhost:8080',
      popclawId: POPCLAW_ID,
      fetchImpl: boom,
    });
    expect(handles).toEqual([]);
  });

  it('skips empty handles and tolerates missing profiles field', async () => {
    const handles = await fetchVerifiedHandles({
      loreHouseUrl: 'http://localhost:8080',
      popclawId: POPCLAW_ID,
      fetchImpl: fakeFetch(200, { profiles: [{ platform: 'x', handle: '' }, {}] }),
    });
    expect(handles).toEqual([]);
    const none = await fetchVerifiedHandles({
      loreHouseUrl: 'http://localhost:8080',
      popclawId: POPCLAW_ID,
      fetchImpl: fakeFetch(200, {}),
    });
    expect(none).toEqual([]);
  });
});
