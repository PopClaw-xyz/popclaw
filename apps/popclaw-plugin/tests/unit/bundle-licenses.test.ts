import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const realDist = join(root, 'dist') + '/';

// esbuild is mocked: each entry "inlines" whatever this map names for it.
const mocks = vi.hoisted(() => ({
  inputsByEntry: new Map<string, string[]>(),
  distWrites: [] as Array<[string, ...unknown[]]>,
}));
vi.mock('esbuild', () => ({
  build: vi.fn(async (options: { entryPoints: string[] }) => ({
    outputFiles: [{ text: '' }],
    metafile: { inputs: Object.fromEntries((mocks.inputsByEntry.get(options.entryPoints[0]!) ?? []).map((i) => [i, {}])) },
  })),
}));
vi.mock('node:child_process', () => ({ execSync: vi.fn(() => Buffer.from('test')) }));
// Writes aimed at this package's real dist/ are recorded, never performed;
// everything else (the temp fixtures below) hits the real filesystem.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const guard = <A extends unknown[]>(name: string, real: (...a: A) => unknown) => (...args: A) =>
    args.some((a) => typeof a === 'string' && a.startsWith(realDist))
      ? void mocks.distWrites.push([name, ...args])
      : real(...args);
  return {
    ...fs,
    chmodSync: vi.fn(),
    rmSync: guard('rmSync', fs.rmSync),
    mkdirSync: guard('mkdirSync', fs.mkdirSync),
    copyFileSync: guard('copyFileSync', fs.copyFileSync),
  };
});

const dirsToClean: string[] = [];
const fixturesToKeep: string[] = [];
afterEach(() => {
  while (dirsToClean.length) rmSync(dirsToClean.pop()!, { recursive: true, force: true });
});

/** An isolated node_modules with one package, optionally without a license. */
function fixturePackage(name: string, withLicense: boolean): { base: string; input: string; license: string } {
  const base = mkdtempSync(join(tmpdir(), 'popclaw-bundle-licenses-'));
  dirsToClean.push(base);
  const dir = join(base, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(join(dir, 'index.js'), 'export const x = 1;');
  if (withLicense) writeFileSync(join(dir, 'LICENSE'), `Copyright (c) ${name} authors\n`);
  return { base, input: join(dir, 'index.js'), license: join(dir, 'LICENSE') };
}

describe('third-party license collection for the distributed bundles', () => {
  // Every metafile source of a distributed file: the five bundle entries and
  // the schema worker embedded into all of them. Each inlines one fixture
  // package no other source does, so dropping any source from the closure
  // loses exactly that package's license.
  const sources = [
    'src/index.ts', 'src/mcp.ts', 'src/mcp-hook.ts', 'src/main.ts',
    'scripts/prepare-native-world.ts', 'src/host/schema-validator-worker.ts',
  ];
  const onlyDeps = new Map<string, ReturnType<typeof fixturePackage>>();
  beforeAll(async () => {
    for (const source of sources) {
      const dep = fixturePackage(`only-${source.replace(/\W+/g, '-')}`, true);
      onlyDeps.set(source, dep);
      mocks.inputsByEntry.set(resolve(root, source), [dep.input]);
    }
    fixturesToKeep.push(...dirsToClean.splice(0));
    await import('../../scripts/bundle.mjs');
  });
  afterAll(() => {
    while (fixturesToKeep.length) rmSync(fixturesToKeep.pop()!, { recursive: true, force: true });
  });

  it.each(sources)('collects a dependency that only %s inlines', (source) => {
    const dep = onlyDeps.get(source)!;
    const name = `only-${source.replace(/\W+/g, '-')}`;
    expect(mocks.distWrites).toContainEqual([
      'copyFileSync', dep.license, join(root, `dist/bundled/licenses/${name}@1.0.0/LICENSE`),
    ]);
  });

  it('fails when an inlined dependency has no license, even with a stale copy in the output', async () => {
    const dep = fixturePackage('no-license-dep', false);
    const licensesDir = join(dep.base, 'out/licenses');
    const stale = join(licensesDir, 'no-license-dep@1.0.0/LICENSE');
    mkdirSync(join(licensesDir, 'no-license-dep@1.0.0'), { recursive: true });
    writeFileSync(stale, 'left over from an earlier build\n');
    const { collectBundleLicenses } = await import('../../scripts/bundle-licenses.mjs');

    expect(() => collectBundleLicenses({
      metafiles: [{ inputs: { [dep.input]: {} } }], baseDir: dep.base, licensesDir,
    })).toThrow(/no-license-dep@1\.0\.0 is inlined but ships no license file/);
    expect(existsSync(stale)).toBe(false);
  });
});
