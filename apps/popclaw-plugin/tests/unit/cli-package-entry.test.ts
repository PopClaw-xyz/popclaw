import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const mocks = vi.hoisted(() => ({
  workerSource: 'const embeddedWorkerFixture = true;',
  // metafile is not optional to the bundler any more: bundle.mjs walks
  // `metafile.inputs` to collect the licences of everything it pulled in from
  // node_modules. A mock without it made the build step die on `undefined` at
  // exactly the line that assembles the licence closure.
  build: vi.fn(async () => ({ outputFiles: [{ text: 'const embeddedWorkerFixture = true;' }], metafile: { inputs: {} } })),
  chmod: vi.fn(),
}));
vi.mock('esbuild', () => ({ build: mocks.build }));
vi.mock('node:child_process', () => ({ execSync: vi.fn(() => Buffer.from('test')) }));
vi.mock('node:fs', async (original) => ({
  // rmSync is inert so the licence step's reset cannot wipe a real build's
  // dist/bundled/licenses while only the entry definitions are under test.
  ...await original<typeof import('node:fs')>(), chmodSync: mocks.chmod, rmSync: vi.fn(),
}));

const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

describe('standalone popclaw CLI source packaging', () => {
  it('owns only the popclaw CLI name and ships the bundled directory', () => {
    expect(pkg.bin).toEqual({ popclaw: 'dist/bundled/cli.js' });
    expect(pkg.files).toContain('dist/bundled');
    // The MCP + hook entries ship from THIS package's bundled directory
    // (built by scripts/bundle.mjs — see the entry test below); the separate
    // popclaw-mcp wrapper package is not part of this export.
    expect(pkg.files).not.toContain('wallet-migrations');
  });

  it('exports the two MCP entries by exact subpath and opens nothing else', () => {
    // `popclaw-mcp`'s two bin files are one import each of these specifiers,
    // so they are a published surface, not an implementation detail. Exact
    // subpaths only: no "./*", which would expose the whole bundle directory
    // (licences, the schema worker, prepare-native-world) as public API.
    expect(pkg.exports).toEqual({
      '.': './dist/bundled/index.js',
      './mcp': './dist/bundled/mcp.js',
      './mcp-hook': './dist/bundled/mcp-hook.js',
    });
  });

  it('defines an executable main.ts bundle without running esbuild or packing', async () => {
    // The build and chmod ports are mocks: this runs only the entry definitions.
    await import('../../scripts/bundle.mjs');
    expect(mocks.build).toHaveBeenNthCalledWith(1, expect.objectContaining({
      entryPoints: [resolve(root, 'src/host/schema-validator-worker.ts')],
      format: 'cjs', write: false,
    }));
    for (const entry of ['index', 'mcp', 'mcp-hook', 'cli']) {
      expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
        outfile: resolve(root, `dist/bundled/${entry}.js`),
        define: expect.objectContaining({ __POPCLAW_SCHEMA_WORKER_SOURCE__: JSON.stringify(mocks.workerSource) }),
      }));
    }
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
      entryPoints: [resolve(root, 'src/main.ts')],
      outfile: resolve(root, 'dist/bundled/cli.js'),
      format: 'esm',
      banner: { js: expect.stringMatching(/^#!\/usr\/bin\/env node\n/) },
    }));
    expect(mocks.chmod).toHaveBeenCalledWith(resolve(root, 'dist/bundled/cli.js'), 0o755);
  });

  it('preserves bin when prepack strips development fields (in-memory simulation)', () => {
    const source = readFileSync(resolve(root, 'scripts/prepack.mjs'), 'utf8');
    const body = source.slice(source.indexOf('copyFileSync(pkgPath, backupPath);'));
    const write = vi.fn();
    runInNewContext(body, {
      pkgPath: 'package.json', backupPath: 'package.json.backup',
      copyFileSync: vi.fn(), readFileSync: () => JSON.stringify(pkg),
      writeFileSync: write, console: { log: vi.fn() },
    });
    expect(write).toHaveBeenCalledOnce();
    const stripped = JSON.parse(write.mock.calls[0]![1]);
    expect(stripped.bin).toEqual({ popclaw: 'dist/bundled/cli.js' });
    expect(stripped.repository).toEqual(pkg.repository);
    // `popclaw-mcp` resolves `popclaw/mcp` and `popclaw/mcp-hook` out of the
    // INSTALLED manifest — the one prepack writes, not the one in the repo.
    // Both subpaths must survive the strip or the shell's two bins cannot
    // resolve anything.
    expect(stripped.exports).toEqual(pkg.exports);
    expect(stripped.exports['./mcp']).toBe('./dist/bundled/mcp.js');
    expect(stripped.exports['./mcp-hook']).toBe('./dist/bundled/mcp-hook.js');
    expect(stripped.scripts).toBeUndefined();
    expect(stripped.dependencies).toBeUndefined();
  });
});
