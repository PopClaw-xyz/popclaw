import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureBundle } from '../../helpers/ensure-bundle.js';

/**
 * `ensureBundle` decides whether to rebuild by comparing mtimes, not content.
 * `execSync` is mocked so these tests drive the real decision logic in
 * `ensureBundle` — including the mutation check below — without ever running
 * esbuild; the mock stands in for `pnpm run build:bundle` by writing a fresh
 * `dist/bundled/cli.js` at the given cwd, exactly like the real build would.
 */
vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

vi.mocked(execSync).mockImplementation((_cmd, opts) => {
  const cwd = String((opts as { cwd?: string } | undefined)?.cwd ?? process.cwd());
  mkdirSync(join(cwd, 'dist/bundled'), { recursive: true });
  writeFileSync(join(cwd, 'dist/bundled/cli.js'), 'freshly built');
  return Buffer.from('');
});

const dirsToClean: string[] = [];
afterEach(() => {
  vi.mocked(execSync).mockClear();
  while (dirsToClean.length) {
    rmSync(dirsToClean.pop()!, { recursive: true, force: true });
  }
});

/** A minimal fake package covering every path `bundleInputPaths` enumerates
 * for `src/**`, `scripts/bundle.mjs`, `scripts/build-schema-worker.mjs`, and
 * `package.json`. The protocol/contracts paths resolve outside the temp dir
 * and simply don't exist, which `newestInputMtimeMs` treats as absent. */
function makeFakePackage(): string {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-ensure-bundle-'));
  dirsToClean.push(root);
  const pkgRoot = join(root, 'pkg');
  mkdirSync(join(pkgRoot, 'src'), { recursive: true });
  writeFileSync(join(pkgRoot, 'src/index.ts'), 'export {};');
  mkdirSync(join(pkgRoot, 'scripts'), { recursive: true });
  writeFileSync(join(pkgRoot, 'scripts/bundle.mjs'), '// bundle');
  writeFileSync(join(pkgRoot, 'scripts/build-schema-worker.mjs'), '// worker');
  writeFileSync(join(pkgRoot, 'package.json'), '{"name":"fake"}');
  return pkgRoot;
}

function touch(path: string, when: Date): void {
  utimesSync(path, when, when);
}

function touchAllInputs(pkgRoot: string, when: Date): void {
  touch(join(pkgRoot, 'src/index.ts'), when);
  touch(join(pkgRoot, 'scripts/bundle.mjs'), when);
  touch(join(pkgRoot, 'scripts/build-schema-worker.mjs'), when);
  touch(join(pkgRoot, 'package.json'), when);
}

function makeArtefact(pkgRoot: string): string {
  const artefact = join(pkgRoot, 'dist/bundled/cli.js');
  mkdirSync(dirname(artefact), { recursive: true });
  writeFileSync(artefact, 'built');
  return artefact;
}

describe('ensureBundle staleness decision', () => {
  it('(1) missing artefact triggers a rebuild', async () => {
    const pkgRoot = makeFakePackage();
    const artefact = join(pkgRoot, 'dist/bundled/cli.js');

    await ensureBundle(pkgRoot, artefact);

    expect(execSync).toHaveBeenCalledTimes(1);
    expect(existsSync(artefact)).toBe(true);
  });

  it('(2) artefact older than one input triggers a rebuild', async () => {
    const pkgRoot = makeFakePackage();
    const artefact = makeArtefact(pkgRoot);
    const base = new Date('2026-01-01T00:00:00Z');
    touchAllInputs(pkgRoot, base);
    touch(artefact, base);
    // One input moves after the artefact was "built".
    touch(join(pkgRoot, 'src/index.ts'), new Date(base.getTime() + 60_000));

    await ensureBundle(pkgRoot, artefact);

    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('(3) artefact newer than all inputs does not rebuild (positive control)', async () => {
    const pkgRoot = makeFakePackage();
    const artefact = makeArtefact(pkgRoot);
    const base = new Date('2026-01-01T00:00:00Z');
    touchAllInputs(pkgRoot, base);
    touch(artefact, new Date(base.getTime() + 60_000));

    await ensureBundle(pkgRoot, artefact);

    expect(execSync).not.toHaveBeenCalled();
  });

  it('(4) a newly added input file newer than the artefact triggers a rebuild', async () => {
    const pkgRoot = makeFakePackage();
    const artefact = makeArtefact(pkgRoot);
    const base = new Date('2026-01-01T00:00:00Z');
    touchAllInputs(pkgRoot, base);
    touch(artefact, new Date(base.getTime() + 60_000));

    // Fresh to start with.
    await ensureBundle(pkgRoot, artefact);
    expect(execSync).not.toHaveBeenCalled();

    // A new file appears under src/ after the artefact was built.
    const newFile = join(pkgRoot, 'src/newly-added.ts');
    writeFileSync(newFile, 'export const x = 1;');
    touch(newFile, new Date(base.getTime() + 120_000));

    await ensureBundle(pkgRoot, artefact);

    expect(execSync).toHaveBeenCalledTimes(1);
  });
});

describe('ensureBundle waiter logic', () => {
  it(
    '(5) does not treat an artefact that predates the build start as done',
    async () => {
      const pkgRoot = makeFakePackage();
      const artefact = makeArtefact(pkgRoot);
      // Stale relative to the inputs (created "now"), so ensureBundle would
      // try to rebuild rather than return immediately — except another
      // worker already holds the lock (below), so this call becomes a waiter.
      touch(artefact, new Date(Date.now() - 100_000));

      const dist = join(pkgRoot, 'dist');
      const lock = join(dist, '.bundle-build-lock');
      mkdirSync(lock);
      const buildStartedAtMs = Date.now();
      writeFileSync(join(lock, 'started-at'), String(buildStartedAtMs));

      const promise = ensureBundle(pkgRoot, artefact);
      let settled = false;
      promise.then(() => {
        settled = true;
      });

      // The artefact on disk still predates buildStartedAtMs — the waiter
      // must still be waiting, not have returned because the (stale) file
      // merely exists.
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      expect(execSync).not.toHaveBeenCalled(); // waiters never build themselves

      // "Finish" the other worker's build: fresh mtime, then release the lock.
      touch(artefact, new Date(buildStartedAtMs + 10_000));
      rmSync(lock, { recursive: true, force: true });

      await promise;
      expect(settled).toBe(true);
    },
    15_000,
  );
});
