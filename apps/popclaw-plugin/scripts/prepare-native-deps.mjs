/**
 * Vendor native deps into `dist/native-deps/` so the tarball is self-contained.
 *
 * OpenClaw 2026.7.1 installs npm plugins into a per-plugin isolated root with
 * `npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund`,
 * and gateway startup never installs dependencies at all
 * (docs.openclaw.ai/plugins/dependency-resolution, re-verified 2026-08-11).
 * `--ignore-scripts` means node-gyp/prebuild-install can never run, so a
 * declared `better-sqlite3` would arrive without a loadable binary. On top of
 * that, `pnpm pack` strips `node_modules/` from the archive even if
 * listed in `files`. So native modules (better-sqlite3 + its `bindings`
 * runtime helper + `file-uri-to-path`) must be shipped under a non-
 * `node_modules` path. Runtime require resolution is patched in
 * `bundle.mjs`'s banner to map these three module names to `./native-deps/`.
 * The banner hook only covers first-level requires from the bundle, so the
 * transitive helpers are ALSO nested into
 * `native-deps/better-sqlite3/node_modules/` for Node's standard resolution
 * (better-sqlite3 internally requires `bindings`).
 *
 * Only better-sqlite3's `build/Release/*.node` is shipped (the prebuild
 * binary). The runtime manifest declares the shipped dependency closure;
 * `prebuild-install` and scripts are build-only and excluded. Its original
 * manifest and exact derivation are retained in POPCLAW-RUNTIME-MANIFEST.json.
 *
 * `POPCLAW_NATIVE_DEPS_MINIMAL=1` vendors only, skipping the 10-combo prebuild
 * matrix (node-gyp cross-builds + GitHub release downloads). The matrix is PACK
 * work and requires a darwin packer; development smoke checks can use a bundle
 * that loads under the runner's own Node (register-real-host-load.test.ts). Never set
 * it when producing a tarball — `just pack-plugin` must ship the full matrix.
 */
import { cpSync, rmSync, existsSync, readdirSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { deriveNativeRuntimeManifest } from './native-runtime-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const repoRoot = resolve(pluginRoot, '../..');
const pnpmStore = join(repoRoot, 'node_modules', '.pnpm');
const outDir = join(pluginRoot, 'dist', 'native-deps');

const PACKAGES = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

function findPnpmPackage(name) {
  const entries = readdirSync(pnpmStore).filter((d) => d.startsWith(`${name}@`));
  if (entries.length === 0) {
    throw new Error(`Cannot find ${name}@* in ${pnpmStore}`);
  }
  // Pick highest version (lexicographic is OK for semver patches here).
  entries.sort();
  const chosen = entries[entries.length - 1];
  const pkgPath = join(pnpmStore, chosen, 'node_modules', name);
  if (!statSync(pkgPath).isDirectory()) {
    throw new Error(`Resolved path is not a directory: ${pkgPath}`);
  }
  return pkgPath;
}

function vendorOne(name) {
  const src = findPnpmPackage(name);
  const dst = join(outDir, name);
  rmSync(dst, { recursive: true, force: true });
  // Dereference symlinks; skip nested node_modules (transitive deps
  // get their own top-level vendor slot to keep the resolver hook simple).
  cpSync(src, dst, {
    recursive: true,
    dereference: true,
    filter: (s) => {
      const rel = s.slice(src.length);
      if (rel.includes(`${join('/', 'node_modules', '/')}`) || rel.endsWith('/node_modules')) {
        return false;
      }
      return true;
    },
  });
  console.log(`vendored ${name} ← ${src}`);
}

function nestTransitiveDepsForStandardResolution() {
  // S4.1-T5: verified on OpenClaw 2026.6: the bundle.mjs banner require hook
  // only covers the bundle's first-level requires. better-sqlite3's internal
  // require('bindings') / require('file-uri-to-path') use standard Node resolution
  // and must resolve under native-deps/better-sqlite3/node_modules/. Keep the
  // top-level vendor slots for the banner hook and add nested copies as a fallback.
  const nmDir = join(outDir, 'better-sqlite3', 'node_modules');
  mkdirSync(nmDir, { recursive: true });
  for (const dep of ['bindings', 'file-uri-to-path']) {
    const src = join(outDir, dep);
    const dst = join(nmDir, dep);
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
    console.log(`nested ${dep} → native-deps/better-sqlite3/node_modules/${dep}`);
  }
  // The top-level bindings slot is also a complete standard-resolution package,
  // including when the host captures that slot independently of better-sqlite3.
  cpSync(join(outDir, 'file-uri-to-path'), join(outDir, 'bindings', 'node_modules', 'file-uri-to-path'), { recursive: true });
}

// Node majors we ship prebuilt better-sqlite3 binaries for. The host loads the
// one matching its running Node (local-host-db.ts keys on `process.versions.node`
// major), so NO host-side `node-gyp rebuild` is ever needed on these versions.
// OpenClaw 6.6 requires Node >=22.19; homebrew's `node` is currently 25.x.
// When homebrew bumps to a new major, add it here and re-pack (build-machine
// work, not the user's). `target` only needs valid headers on nodejs.org/dist;
// the ABI is fixed per-major so any patch works on all of that major's releases.
const NODE_ABI_TARGETS = [
  { major: 24, target: '24.16.0' }, // ABI 137 — LTS, and the floor OpenClaw 9.4 requires
  { major: 26, target: '26.1.0' },  // ABI 147 — current; homebrew's default is already on this line
];

// Arches we build locally with node-gyp. The packer is darwin; clang cross-links
// x86_64 from Apple Silicon out of the box, so darwin-x64 (Intel Macs) is covered
// without a second build machine. Non-darwin arches need real cross toolchains —
// those come from the official release downloads below instead.
const LOCAL_BUILD_ARCHES = ['arm64', 'x64'];

/**
 * File name `local-host-db.ts` resolveNativeBinding() loads FIRST, and the only
 * matrix name first-install setup accepts: the explicit
 * `better_sqlite3-<platform>-<arch>-node<major>.node`. Every supported matrix
 * entry ships under this name — including the packer's own platform+arch (the
 * historical unprefixed name caused the packer's own platform to install a
 * binding setup would refuse to load). The unsuffixed build/Release default is
 * still written below, but only as the better-sqlite3 `bindings` fallback for
 * host auto-rebuilds and tests loading straight from node_modules.
 */
function bindingName(platform, arch, major) {
  return `better_sqlite3-${platform}-${arch}-node${major}.node`;
}

function loadsUnderPackerNode(bindingPath) {
  return (
    spawnSync(process.execPath, ['-e', `require(${JSON.stringify(bindingPath)})`], {
      encoding: 'utf-8',
    }).status === 0
  );
}

function buildAbiPrebuilds() {
  const vendorBs3 = join(outDir, 'better-sqlite3');
  const relDir = join(vendorBs3, 'build', 'Release');
  const defaultBin = join(relDir, 'better_sqlite3.node');
  if (!existsSync(join(vendorBs3, 'binding.gyp'))) {
    throw new Error(
      `better-sqlite3 sources missing (no binding.gyp) at ${vendorBs3}; cannot build ABI prebuilds.`,
    );
  }
  // `node-gyp rebuild` cleans build/ on every run, which would wipe a binary
  // copied into build/Release on a previous iteration. So stage each build's
  // output OUTSIDE build/, then move them all back after the final build.
  const stage = join(outDir, '.bs3-abi-stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const built = [];
  console.log(
    `building better-sqlite3 prebuilds for ${process.platform}-{${LOCAL_BUILD_ARCHES.join(',')}} ` +
      `(Node majors ${NODE_ABI_TARGETS.map((t) => t.major).join('/')})…`,
  );

  for (const arch of LOCAL_BUILD_ARCHES) {
    for (const t of NODE_ABI_TARGETS) {
      console.log(`  → node-gyp rebuild --arch=${arch} --target=${t.target} (Node ${t.major})…`);
      execSync(`npx -y node-gyp@latest rebuild --release --target=${t.target} --arch=${arch}`, {
        cwd: vendorBs3,
        stdio: 'inherit',
      });
      const name = bindingName(process.platform, arch, t.major);
      cpSync(defaultBin, join(stage, name)); // defaultBin is the just-built output
      built.push(name);
      console.log(`    staged ${name} (${statSync(join(stage, name)).size} bytes)`);
    }
  }

  // The last rebuild left build/Release present; move every staged binary back in.
  for (const name of built) cpSync(join(stage, name), join(relDir, name));
  rmSync(stage, { recursive: true, force: true });

  // Restore the unsuffixed default to the packer's Node major. better-sqlite3's
  // `bindings` loader uses it as the fallback when the host runs an UNcovered
  // major (local-host-db.ts then surfaces a clear rebuild hint). Also what
  // tests-from-node_modules / in-memory-host-db load.
  const packerMajor = Number(process.versions.node.split('.')[0]);
  const packerNamed = join(relDir, bindingName(process.platform, process.arch, packerMajor));
  if (existsSync(packerNamed)) cpSync(packerNamed, defaultBin);
  if (!loadsUnderPackerNode(defaultBin)) {
    throw new Error(
      `default better_sqlite3.node failed to load under packer Node ${process.version} (major ${packerMajor}).`,
    );
  }

  // Build junk (.a static lib, test_extension, .o/.deps intermediates) is
  // swept by pruneBuildTree() at the very end, once for both build paths —
  // see there for the full list (it also catches build/Makefile,
  // config.gypi, etc. left by node-gyp at the package-root build/ level).

  console.log(
    `  → local prebuilds ready: ${built.join(', ')} (default = packer Node ${packerMajor})`,
  );
}

// better-sqlite3 publishes per-{platform}-{arch}-{node-ABI} prebuilt binaries on
// its GitHub releases. The pack machine is darwin, but hosts also run Linux and
// Windows — so we DOWNLOAD the official prebuilts (no cross toolchain needed) and
// name them `better_sqlite3-<platform>-<arch>-node<major>.node`, which the host
// loader (local-host-db.ts resolveNativeBinding) prefers. THIS is what makes a
// clean linux/arm64 install load instantly with ZERO host-side node-gyp — the
// darwin builds above are useless on a Linux host (bug report host-c, dispatch chain 1).
// Node major → NODE_MODULE_VERSION *that the pinned better-sqlite3 actually
// publishes release assets for* (verified against the v12.11.1 asset list:
// node-v127/137/141/147 for every platform we ship, so 147 covers exactly the
// same platforms 137 does). v11.x only had node-v108/115/127/131, which is why
// linux/win32 used to fall back to a host node-gyp rebuild; bs3 v12 closes
// those cells and the matrix is 10/10 — 2 local arches + 3 host targets, times
// the two supported majors. Node 20/23 were dropped from bs3 prebuilds in
// v12.10.0 — do NOT re-add a major here without checking the release assets
// first.
const BS3_RELEASE_ABI = { 24: 137, 26: 147 };
const HOST_DOWNLOAD_TARGETS = [
  { platform: 'linux', arch: 'arm64' }, // gateway hosts (Apple-Silicon Parallels / ARM servers)
  { platform: 'linux', arch: 'x64' }, // x86-64 Linux servers
  { platform: 'win32', arch: 'x64' }, // Windows hosts
];

/** Every (platform, arch, major) we claim zero-rebuild coverage for. */
function coverageMatrix() {
  const rows = [];
  for (const arch of LOCAL_BUILD_ARCHES) {
    for (const t of NODE_ABI_TARGETS) {
      rows.push({ platform: 'darwin', arch, major: t.major, abi: BS3_RELEASE_ABI[t.major], via: 'node-gyp' });
    }
  }
  for (const { platform, arch } of HOST_DOWNLOAD_TARGETS) {
    for (const t of NODE_ABI_TARGETS) {
      const abi = BS3_RELEASE_ABI[t.major];
      rows.push({ platform, arch, major: t.major, abi, via: abi ? 'release' : 'fallback' });
    }
  }
  return rows.map((r) => ({ ...r, file: bindingName(r.platform, r.arch, r.major) }));
}

/** Check the actual binary header and Node's ABI initializer, not its name alone. */
function assertNativeBinary(bytes, row) {
  const { platform, arch, abi, file } = row;
  if (bytes.length < 500_000) throw new Error(`${file} is absent or truncated (${bytes.length} bytes)`);
  let target;
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    if (cpu === 0x100000c) target = 'darwin-arm64';
    if (cpu === 0x1000007) target = 'darwin-x64';
  } else if (bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]))) {
    const machine = bytes.readUInt16LE(18);
    if (machine === 183) target = 'linux-arm64';
    if (machine === 62) target = 'linux-x64';
  } else if (bytes.toString('ascii', 0, 2) === 'MZ') {
    const pe = bytes.readUInt32LE(0x3c);
    if (pe + 6 <= bytes.length && bytes.toString('ascii', pe, pe + 4) === 'PE\0\0' &&
        bytes.readUInt16LE(pe + 4) === 0x8664) target = 'win32-x64';
  }
  if (target !== `${platform}-${arch}`) {
    throw new Error(`${file}: expected ${platform}-${arch}, binary header is ${target || 'unsupported'}`);
  }
  if (!abi || !bytes.includes(Buffer.from(`node_register_module_v${abi}\0`))) {
    throw new Error(`${file}: missing Node ABI ${abi} initializer`);
  }
}

/** Verify the final archive independently of the files present before pnpm pack. */
function verifyPackedMatrix(tgz) {
  const prefix = 'package/dist/native-deps/better-sqlite3/build/Release/';
  const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).trim().split('\n');
  const rows = coverageMatrix();
  const binaries = new Map();
  const read = (file) => {
    const entry = prefix + file;
    if (entries.filter(name => name === entry).length !== 1) {
      throw new Error(`${file}: expected exactly one archive entry`);
    }
    return execFileSync('tar', ['-xzOf', tgz, entry], { maxBuffer: 32 * 1024 * 1024 });
  };
  for (const row of rows) {
    const bytes = read(row.file);
    assertNativeBinary(bytes, row);
    binaries.set(row.file, bytes);
    console.log(`  ✓ ${row.platform}-${row.arch} node${row.major} ABI ${row.abi} (${bytes.length} bytes)`);
  }
  const fallback = read('better_sqlite3.node');
  if (!rows.some(row => row.platform === 'darwin' && fallback.equals(binaries.get(row.file)))) {
    throw new Error('better_sqlite3.node: fallback must equal one of the declared Darwin bindings');
  }
  console.log(`verified ${rows.length} native matrix cells and the packer fallback in ${tgz}`);
}

function downloadHostPrebuilds() {
  const vendorBs3 = join(outDir, 'better-sqlite3');
  const relDir = join(vendorBs3, 'build', 'Release');
  const version = JSON.parse(readFileSync(join(vendorBs3, 'package.json'), 'utf-8')).version;
  const tmp = join(outDir, '.bs3-dl');
  console.log(`downloading official prebuilts for better-sqlite3 v${version}…`);
  for (const row of coverageMatrix()) {
    const { platform, arch, major, abi, via, file } = row;
    if (via !== 'release') continue;
    const asset = `better-sqlite3-v${version}-node-v${abi}-${platform}-${arch}.tar.gz`;
    const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${asset}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const tgz = join(tmp, asset);
    // GitHub drops connections intermittently on this network — curl's own retry
    // (3 attempts, 2s→4s→8s backoff, retrying transfer errors too) is enough.
    execSync(
      `curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --retry-connrefused ` +
        `-o ${JSON.stringify(tgz)} ${JSON.stringify(url)}`,
      { stdio: 'pipe' },
    );
    execSync(`tar xzf ${JSON.stringify(tgz)} -C ${JSON.stringify(tmp)}`, { stdio: 'pipe' });
    cpSync(join(tmp, 'build', 'Release', 'better_sqlite3.node'), join(relDir, file));
    console.log(`  ↓ ${file} (ABI ${abi}) ← ${asset}`);
  }
  rmSync(tmp, { recursive: true, force: true });
}

/**
 * Ponytail check: the tarball is only as good as its matrix. Every advertised
 * combo must be a real, full-size binary — since bs3 v12 there are no fallback
 * rows left, so a `fallback` row is itself a pack failure (someone added a Node
 * major to NODE_ABI_TARGETS without an entry in BS3_RELEASE_ABI).
 */
function assertMatrixComplete() {
  const relDir = join(outDir, 'better-sqlite3', 'build', 'Release');
  const rows = coverageMatrix();
  const missing = [];
  console.log(`native prebuild matrix (${rows.length} combos, all must be ✓):`);
  for (const { platform, arch, major, via, file } of rows) {
    const label = `${platform}-${arch} node${major}`;
    if (via === 'fallback') {
      missing.push(`${label} → no BS3_RELEASE_ABI entry for Node ${major}`);
      continue;
    }
    const path = join(relDir, file);
    const size = existsSync(path) ? statSync(path).size : 0;
    if (size < 500_000) missing.push(`${label} → ${file}${size ? ` (only ${size} bytes)` : ' (absent)'}`);
    else {
      assertNativeBinary(readFileSync(path), { platform, arch, abi: BS3_RELEASE_ABI[major], file });
      console.log(`  ✓ ${label} → ${file} (${size} bytes, ${via})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`native prebuild matrix incomplete:\n  - ${missing.join('\n  - ')}`);
  }
}

/**
 * Enforce the module docstring's promise ("Only better-sqlite3's
 * `build/Release/*.node` is shipped") for real. `vendorOne()` copies the
 * package as pnpm installed it, which at that point only has a single
 * `build/Release/better_sqlite3.node` (npm's own postinstall build). But
 * `buildAbiPrebuilds()` then runs `node-gyp rebuild` *inside* the vendored
 * copy for every arch/ABI target, and node-gyp regenerates a whole
 * build-machine tree: `build/Makefile`, `build/config.gypi`,
 * `build/*.target.mk`, `build/deps/`, `build/gyp-mac-tool`, plus
 * `build/Release/{obj,obj.target,.deps,sqlite3.a,test_extension.node}`.
 * `config.gypi`/`Makefile`/the `.d` dep files bake in absolute build-machine
 * paths (packer username, this repo's path); `obj/gen/sqlite3/sqlite3.c` is
 * the ~9.3 MB amalgamated source, dead weight once compiled. Nothing at
 * runtime reads any of it — `local-host-db.ts` resolveNativeBinding() and
 * better-sqlite3's own `bindings` fallback both only ever open
 * `build/Release/*.node`. So: keep the package's own files, keep only the
 * compiled addons out of build/, delete the rest of build/.
 */
function pruneBuildTree() {
  const buildDir = join(outDir, 'better-sqlite3', 'build');
  if (!existsSync(buildDir)) return;
  for (const entry of readdirSync(buildDir)) {
    if (entry !== 'Release') rmSync(join(buildDir, entry), { recursive: true, force: true });
  }
  const relDir = join(buildDir, 'Release');
  if (!existsSync(relDir)) return;
  for (const entry of readdirSync(relDir)) {
    // Keep only the better_sqlite3 addon binaries (unsuffixed + per-platform/
    // arch/ABI names from bindingName()) — not test_extension.node (test-only,
    // see binding.gyp) or anything else node-gyp left behind.
    if (!entry.startsWith('better_sqlite3') || !entry.endsWith('.node')) {
      rmSync(join(relDir, entry), { recursive: true, force: true });
    }
  }
}

if (process.argv[2] === '--verify-tarball') {
  if (process.argv.length !== 4) throw new Error('usage: prepare-native-deps.mjs --verify-tarball <tgz>');
  verifyPackedMatrix(process.argv[3]);
  process.exit(0);
}

// Fail before touching dist: a Linux packer cannot build the promised Mac cells.
if (process.env.POPCLAW_NATIVE_DEPS_MINIMAL !== '1' && process.platform !== 'darwin') {
  throw new Error('full native packing requires a Darwin packer; use the GitHub-hosted macos-15 release runner');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const name of PACKAGES) {
  vendorOne(name);
}
deriveNativeRuntimeManifest(join(outDir, 'better-sqlite3'));
nestTransitiveDepsForStandardResolution();

if (process.env.POPCLAW_NATIVE_DEPS_MINIMAL === '1') {
  const defaultBin = join(outDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!loadsUnderPackerNode(defaultBin)) {
    throw new Error(`vendored better_sqlite3.node does not load under Node ${process.version}`);
  }
  pruneBuildTree();
  console.log(`native deps ready at ${outDir} (MINIMAL — vendored only, no prebuild matrix)`);
  process.exit(0);
}

buildAbiPrebuilds();
downloadHostPrebuilds();
assertMatrixComplete();
pruneBuildTree();

console.log(`native deps ready at ${outDir}`);
console.log(
  `note: every advertised combo is prebuilt — no host node-gyp on install. To cover ` +
    `a new Node major, add it to NODE_ABI_TARGETS *and* BS3_RELEASE_ABI (check the bs3 ` +
    `GitHub release actually publishes that node-v<abi> asset) and re-pack. Exotic ` +
    `combos outside the matrix (linux-musl, win32-arm64) still hit the runtime rebuild.`,
);
