/**
 * Pre-pack hook: produce a stripped-down package.json for the tarball.
 *
 * The bundle at `dist/bundled/index.js` inlines every runtime dep
 * (workspace + npm), so the shipped package.json needs zero
 * `dependencies`. Pruning them prevents OpenClaw's post-extract
 * `npm install` from trying to fetch non-existent registry versions
 * (e.g. `@popclaw/algorithms@0.0.0`, which lives only in this
 * monorepo).
 *
 * Why this is still the right shape on 2026.7.1 (re-verified 2026-08-11
 * against docs.openclaw.ai/plugins/dependency-resolution): the host installs
 * npm plugins into a PER-PLUGIN isolated root with
 * `npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund`,
 * and gateway startup NEVER installs dependencies. So anything we declare
 * either resolves from the public registry at install time or fails there —
 * a stripped `dependencies` list plus a self-contained bundle is the only
 * path that cannot break on a user's machine.
 *
 * `openclaw.extensions` stays a single dist-only array (decision A, final doc
 * 2026-08-11). 7.1's hard failure mode is a DECLARED runtime artifact that is
 * missing; declaring nothing extra means there is nothing to miss. The
 * source/runtime pairing (`extensions: [src] + runtimeExtensions: [dist]`)
 * would additionally require `src/index.ts` inside the tarball, and the
 * `files` allowlist deliberately ships no `src/`. Revisit ONLY if a real host
 * rejects a dist-only entry — then add the pairing AND `src/` to `files`.
 *
 * Dev-only fields (devDependencies, scripts, files, lint setup) are
 * also dropped — the tarball is meant for OpenClaw to load, not for
 * editing/testing.
 *
 * This script MUTATES package.json in place. `postpack.mjs` restores
 * it from the .backup file after pack completes, so dev commits stay
 * clean.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(root, 'package.json');
const backupPath = resolve(root, 'package.json.backup');

copyFileSync(pkgPath, backupPath);

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

const stripped = {
  name: pkg.name,
  version: pkg.version,
  private: pkg.private,
  // License travels with the artifact: npm metadata consumers (and humans
  // reading the extracted package) must see Apache-2.0 without the repo.
  license: pkg.license,
  // npm provenance rejects a package whose `repository.url` does not name
  // the publishing repository; this must survive into the tarball.
  repository: pkg.repository,
  description: pkg.description,
  type: pkg.type,
  main: pkg.main,
  bin: pkg.bin,
  exports: pkg.exports,
  // Keep `files` so pnpm pack restricts tarball contents to the bundled
  // output. Without this, pnpm ships the entire package directory.
  files: pkg.files,
  engines: pkg.engines,
  peerDependencies: pkg.peerDependencies,
  peerDependenciesMeta: pkg.peerDependenciesMeta,
  openclaw: pkg.openclaw,
  // NO dependencies — everything is bundled.
  // NO devDependencies — tarball isn't for editing.
  // NO scripts — OpenClaw loads `main` directly.
};

writeFileSync(pkgPath, JSON.stringify(stripped, null, 2) + '\n');
console.log('prepack: wrote stripped package.json (backup at package.json.backup)');
