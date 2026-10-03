import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * True when `artefactMtimeMs` does not reflect `referenceMtimeMs` — i.e. the
 * artefact is missing (caller passes `-Infinity`) or was last written before
 * the reference moment. Pure so it can be unit-tested without touching esbuild
 * or the filesystem. Used two ways below: once against the newest mtime among
 * the bundle's inputs (does this artefact need a rebuild at all), and once
 * against a build-start marker a builder writes (has a waiter's artefact
 * caught up with the rebuild it is waiting on).
 */
export function isBundleStale({
  artefactMtimeMs,
  newestInputMtimeMs,
}: {
  artefactMtimeMs: number;
  newestInputMtimeMs: number;
}): boolean {
  return artefactMtimeMs < newestInputMtimeMs;
}

/** Recursively find the newest mtime among a set of files/directories.
 * A path that doesn't exist is skipped — an optional input that isn't there
 * isn't itself a reason to call the artefact stale. */
export function newestInputMtimeMs(paths: string[]): number {
  let newest = -Infinity;
  const visit = (path: string): void => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  };
  for (const path of paths) visit(path);
  return newest;
}

/**
 * Every path `scripts/bundle.mjs` reads when it produces `dist/bundled/*`.
 * Kept in sync with that script by hand:
 *   - `src/**` — the four composition roots it builds (index/mcp/mcp-hook/
 *     main), the schema-validator worker `build-schema-worker.mjs` compiles
 *     in, and the vendored smol-toml LICENSE it copies into the license
 *     closure all live under here.
 *   - `scripts/bundle.mjs` itself and the local modules it imports,
 *     `scripts/build-schema-worker.mjs` and `scripts/bundle-licenses.mjs`.
 *   - this package's `package.json` — its `version` field is embedded in the
 *     build stamp.
 *   - the `@popclaw/contracts` / `@popclaw/algorithms` sources bundle.mjs
 *     aliases in: the whole `ts/contracts/src` and `ts/algorithms/src` trees
 *     (esbuild follows every import from the aliased `index.ts` entry
 *     points, so the directories, not just those two files, matter) plus the
 *     retained/public-envelope-01 schema JSON files it maps directly.
 * Deliberately NOT included: the raw `.proto` sources under `protocol/proto`
 * — `build:bundle` always runs `build:protocol` ahead of esbuild regardless
 * of what this scanner finds, so a proto edit is picked up on the very next
 * build either way; this scanner only decides whether a build runs at all.
 */
export function bundleInputPaths(pkgRoot: string): string[] {
  const contractsRoot = resolve(pkgRoot, '../../protocol/packages/contracts');
  return [
    join(pkgRoot, 'src'),
    join(pkgRoot, 'scripts/bundle.mjs'),
    join(pkgRoot, 'scripts/build-schema-worker.mjs'),
    join(pkgRoot, 'scripts/bundle-licenses.mjs'),
    join(pkgRoot, 'package.json'),
    join(contractsRoot, 'ts/contracts/src'),
    join(contractsRoot, 'ts/algorithms/src'),
    join(contractsRoot, 'protocol/retained/private-message.schema.json'),
    join(contractsRoot, 'protocol/retained/schema-profile.schema.json'),
    join(contractsRoot, 'protocol/retained/participation.schema.json'),
    join(contractsRoot, 'protocol/public-envelope-01/board.schema.json'),
    join(contractsRoot, 'protocol/public-envelope-01/action-kind.schema.json'),
    join(contractsRoot, 'protocol/public-envelope-01/interpreted-event-kind.schema.json'),
  ];
}

/**
 * Build `dist/bundled/*` on demand — once, even when several test files need
 * it, and again whenever the source has moved on since the last build.
 *
 * Reuses the artefact a previous `pnpm run build:bundle` (or an earlier run of
 * the suite) already produced, as long as it's still fresh; CI checkouts
 * start clean, so there it always builds — which is the point, these tests
 * are about the files that actually ship. A worktree that was built once,
 * days ago, must NOT keep testing that stale bundle forever — that's the
 * failure mode this staleness check exists to close.
 *
 * The lock is not decoration. Vitest runs test FILES in separate worker
 * processes, so two files that both build lazily can run esbuild over the
 * same output paths at the same moment and leave one of them half-written.
 * The first worker to create the lock directory builds; the rest wait.
 *
 * Waiters cannot tell "done" from "artefact merely exists" — the artefact we
 * are here to replace already exists (that's WHY it's stale), so
 * `existsSync(artefact)` is true the entire time the builder is running. The
 * builder therefore writes its build-start timestamp into a marker file
 * inside the lock directory right after acquiring it; a waiter reads that
 * marker and waits until the artefact's mtime is at or after it — which can
 * only be true once the rebuild has actually landed. The marker lives inside
 * the lock directory, so `rmSync(lock, { recursive: true })` in the builder's
 * `finally` cleans it up for free.
 *
 * `POPCLAW_NATIVE_DEPS_MINIMAL=1` skips the 15-combo prebuild matrix: that
 * matrix is pack work, and every caller here only needs a bundle that loads
 * under the runner's own Node.
 */
export async function ensureBundle(pkgRoot: string, artefact: string): Promise<void> {
  const artefactMtimeMs = existsSync(artefact) ? statSync(artefact).mtimeMs : -Infinity;
  const inputsMtimeMs = newestInputMtimeMs(bundleInputPaths(pkgRoot));
  if (!isBundleStale({ artefactMtimeMs, newestInputMtimeMs: inputsMtimeMs })) return;

  const dist = join(pkgRoot, 'dist');
  mkdirSync(dist, { recursive: true });
  const lock = join(dist, '.bundle-build-lock');
  try {
    mkdirSync(lock);
  } catch {
    // Another worker holds the lock and is (re)building. Wait for its
    // build-start marker, then for the artefact to catch up with it — see
    // the doc comment above for why we can't just wait for the artefact to
    // exist.
    const deadline = Date.now() + 300_000;
    const markerPath = join(lock, 'started-at');
    let buildStartedAtMs: number | undefined;
    while (buildStartedAtMs === undefined && Date.now() < deadline) {
      try {
        if (existsSync(markerPath)) {
          const parsed = Number(readFileSync(markerPath, 'utf-8'));
          if (Number.isFinite(parsed)) buildStartedAtMs = parsed;
        }
      } catch {
        // Marker was mid-write or the lock was mid-cleanup; retry.
      }
      if (buildStartedAtMs === undefined) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (buildStartedAtMs === undefined) {
      throw new Error(`ensureBundle: timed out waiting for the other worker's build to start (${artefact})`);
    }
    while (Date.now() < deadline) {
      if (existsSync(artefact)) {
        const currentMtimeMs = statSync(artefact).mtimeMs;
        if (!isBundleStale({ artefactMtimeMs: currentMtimeMs, newestInputMtimeMs: buildStartedAtMs })) return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`ensureBundle: timed out waiting for ${artefact}`);
  }
  try {
    writeFileSync(join(lock, 'started-at'), String(Date.now()));
    execSync('pnpm run build:bundle', {
      cwd: pkgRoot,
      stdio: 'inherit',
      env: { ...process.env, POPCLAW_NATIVE_DEPS_MINIMAL: '1' },
    });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  if (!existsSync(artefact)) throw new Error(`ensureBundle: build:bundle finished but ${artefact} is still missing`);
}
