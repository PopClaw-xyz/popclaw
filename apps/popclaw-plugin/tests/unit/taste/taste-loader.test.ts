import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TasteLoader } from '../../../src/taste/taste-loader';

function setupTasteDir(opts: {
  manifest: unknown;
  files?: Record<string, string>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'taste-'));
  const tasteDir = join(dir, 'taste');
  mkdirSync(tasteDir, { recursive: true });
  writeFileSync(join(tasteDir, 'manifest.json'), JSON.stringify(opts.manifest));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const full = join(tasteDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('TasteLoader', () => {
  it('returns empty list when no manifest is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'taste-'));
    const loader = new TasteLoader({ tasteDir: join(dir, 'taste') });
    const sources = await loader.enabledSources();
    expect(sources).toEqual([]);
  });

  it('loads enabled markdown sources with their weights', async () => {
    const dir = setupTasteDir({
      manifest: {
        schemaVersion: 1,
        sources: {
          'core/public.md':  { weight: 1.0, enabled: true },
          'core/private.md': { weight: 0.5, enabled: true },
        },
      },
      files: {
        'core/public.md':  '# Likes\n- AI safety',
        'core/private.md': '# Private\n- secret stuff',
      },
    });
    const loader = new TasteLoader({ tasteDir: join(dir, 'taste') });
    const sources = await loader.enabledSources();
    expect(sources).toHaveLength(2);
    expect(sources.find((s) => s.path === 'core/public.md')).toMatchObject({
      weight: 1.0, content: '# Likes\n- AI safety',
    });
    expect(sources.find((s) => s.path === 'core/private.md')).toMatchObject({
      weight: 0.5, content: '# Private\n- secret stuff',
    });
  });

  it('skips sources with enabled=false', async () => {
    const dir = setupTasteDir({
      manifest: {
        schemaVersion: 1,
        sources: {
          'core/public.md':  { weight: 1.0, enabled: true },
          'imported/x.md':   { weight: 0.5, enabled: false },
        },
      },
      files: {
        'core/public.md': 'a',
        'imported/x.md':  'b',
      },
    });
    const loader = new TasteLoader({ tasteDir: join(dir, 'taste') });
    expect((await loader.enabledSources()).map((s) => s.path)).toEqual(['core/public.md']);
  });

  it('skips sources whose file is missing (logs warn)', async () => {
    const warns: string[] = [];
    const dir = setupTasteDir({
      manifest: {
        schemaVersion: 1,
        sources: { 'core/public.md': { weight: 1.0, enabled: true } },
      },
      // file deliberately absent
    });
    const loader = new TasteLoader({ tasteDir: join(dir, 'taste'), logger: { warn: (m) => warns.push(m) } });
    expect(await loader.enabledSources()).toEqual([]);
    expect(warns.some((w) => w.includes('core/public.md'))).toBe(true);
  });

  it('honors empty source files (returns empty content, not skipped)', async () => {
    const dir = setupTasteDir({
      manifest: {
        schemaVersion: 1,
        sources: { 'core/public.md': { weight: 1.0, enabled: true } },
      },
      files: { 'core/public.md': '' },
    });
    const loader = new TasteLoader({ tasteDir: join(dir, 'taste') });
    const sources = await loader.enabledSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.content).toBe('');
  });
});
