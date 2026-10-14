import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPlatformMetadata, packageClawHub } from '../clawhub-platform-package.mjs';
import { deriveNativeRuntimeManifest } from '../native-runtime-manifest.mjs';

const require = createRequire(import.meta.url);
const { MARKER, PLATFORMS, ABI, bindingName, packageName } = require('../native-binding-path.cjs');
const scripts = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = resolve(scripts, '../../..');
const temporary = mkdtempSync(join(tmpdir(), 'popclaw-clawhub-package-test-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const NATIVE = 'dist/native-deps/better-sqlite3';
const RELEASE = `${NATIVE}/build/Release`;
const VERSION = '1.2.3-fixture.7';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
function put(root, path, value, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) + '\n' : value);
  chmodSync(join(root, path), mode);
}
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}
function pack(root, archive, extras = []) {
  execFileSync('python3', ['-c', String.raw`
import io, json, sys, tarfile
root, archive, extras = sys.argv[1:]
with tarfile.open(archive, 'w:gz') as out:
    out.add(root, arcname='package')
    for row in json.loads(extras):
        member = tarfile.TarInfo(row['name'])
        member.mode = row.get('mode', 0o644)
        kind = row.get('kind', 'file')
        if kind in ('symlink', 'hardlink'):
            member.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
            member.linkname = row['target']
            out.addfile(member)
        else:
            data = row.get('data', 'test').encode()
            member.size = len(data)
            out.addfile(member, io.BytesIO(data))
`, root, archive, JSON.stringify(extras)]);
}
function unpack(archive, destination) {
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzpf', archive, '-C', destination]);
  return join(destination, 'package');
}
// Header fixtures exercise the archive guard, not executable SQLite or native
// loading. Real supported-host write/reopen coverage is a separate acceptance.
function headerFixture(platform, arch, major) {
  const bytes = Buffer.alloc(500_032);
  if (platform === 'darwin') {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4);
  } else if (platform === 'linux') {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18);
  } else {
    bytes.write('MZ', 0); bytes.writeUInt32LE(64, 0x3c);
    bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68);
  }
  bytes.write(`node_register_module_v${ABI[major]}\0`, 100);
  return bytes;
}
function fixture(name, alter = () => {}, extras = []) {
  const root = join(temporary, name, 'package');
  const main = { name: 'popclaw', version: VERSION, license: 'Apache-2.0',
    repository: { type: 'git', url: 'git+https://github.com/PopClaw-xyz/popclaw.git' },
    main: 'dist/bundled/index.js', engines: { node: '>=24.16.0 <25 || >=26.1.0' },
    openclaw: { extensions: ['./dist/bundled/index.js'] } };
  put(root, 'package.json', main);
  put(root, 'openclaw.plugin.json', { id: 'popclaw', version: VERSION });
  // Reuse the installed upstream source and the existing pinned derivation.
  // A fabricated self-hashed loader is not a valid complete-package fixture.
  const upstream = dirname(require.resolve('better-sqlite3/package.json'));
  put(root, `${NATIVE}/package.json`, readFileSync(join(upstream, 'package.json')));
  put(root, `${NATIVE}/lib/database.js`, readFileSync(join(upstream, 'lib/database.js')));
  deriveNativeRuntimeManifest(join(root, NATIVE));
  for (const path of ['LICENSE', 'NOTICE', `${NATIVE}/LICENSE`, `${NATIVE}/binding.gyp`, `${NATIVE}/src/better_sqlite3.cpp`,
    `${NATIVE}/deps/sqlite3/sqlite3.c`, `${NATIVE}/deps/sqlite3/sqlite3.h`, `${NATIVE}/deps/common.gypi`, `${NATIVE}/deps/sqlite3.gyp`,
    'migrations/001.sql', 'dist/bundled/index.js', 'dist/native-deps/bindings/LICENSE']) put(root, path, `fixture content for ${path}\n`);
  put(root, 'dist/bundled/cli.js', '#!/usr/bin/env node\n', 0o755);
  const clientFiles = ['index.js', 'mcp.js', 'mcp-hook.js', 'cli.js', 'prepare-native-world.js'].map(path => {
    const bytes = Buffer.from(path === 'cli.js' ? '#!/usr/bin/env node\n' : `export const profile = 'client'; // ${path}\n`);
    const mode = path === 'index.js' ? 0o644 : 0o755;
    put(root, `dist/client-bundled/${path}`, bytes, mode);
    return { path, size: bytes.length, sha256: hash(bytes), mode };
  });
  put(root, 'dist/client-bundled/POPCLAW-BUNDLE-PROFILE.json', {
    format: 1, profile: 'client', rangerExecution: false, ownerPersonaFile: false,
    entryPoints: ['index.js', 'mcp.js', 'mcp-hook.js', 'cli.js', 'prepare-native-world.js'],
    sourceInputs: ['src/runtime/ranger-client.ts'], files: clientFiles,
  });
  for (const [platform, arch] of PLATFORMS) for (const major of Object.keys(ABI)) put(root, `${RELEASE}/${bindingName(platform, arch, major)}`, headerFixture(platform, arch, major));
  alter(root);
  const archive = join(temporary, name, 'full-fixture.tgz');
  pack(root, archive, extras);
  return { root, archive };
}
function failure(archive, name, pattern, options = {}) {
  const destination = join(temporary, `rejected-${name}`);
  assert.throws(() => packageClawHub({ fullTarball: archive, dest: destination, ...options }), pattern);
  assert.deepEqual(readdirSync(destination), [], 'failed build must leave no staged or partial output');
}

test('derives the ClawHub name and both exact dependency declarations from one binding matrix', () => {
  const main = { name: 'popclaw', version: '1.2.3-fixture.7', license: 'Apache-2.0', openclaw: { extensions: ['./dist/bundled/index.js'] } };
  const native = { name: 'better-sqlite3', version: '12.11.1', license: 'MIT', dependencies: { bindings: '^1.5.0' } };
  const bindings = PLATFORMS.flatMap(([platform, arch]) => Object.keys(ABI).map(major => ({
    file: bindingName(platform, arch, major), size: 600_000, sha256: String(Number(major) / 2).repeat(32),
  })));
  const result = createPlatformMetadata(main, native, bindings);
  assert.equal(result.main.name, 'popclaw-clawhub');
  const dependencies = Object.fromEntries(PLATFORMS.map(([platform, arch]) => [packageName(platform, arch), main.version]));
  assert.deepEqual(result.main.optionalDependencies, dependencies);
  assert.deepEqual(result.native.optionalDependencies, dependencies);
  assert.deepEqual(result.main.openclaw.install.requiredPlatformPackages, Object.keys(dependencies));
  assert.equal(result.packages.length, 5);
  assert.equal(result.marker.format, 1);
  assert.equal(result.marker.version, main.version);
  assert.equal(result.marker.distribution, 'clawhub-platform-dependencies');
  assert.deepEqual(result.marker.packages, result.packages);
  assert.equal(main.name, 'popclaw');
  assert.equal(main.optionalDependencies, undefined);
  assert.equal(native.optionalDependencies, undefined);
});

test('derives six deterministic archives, preserving the source, licenses and source fallback', () => {
  const full = fixture('valid');
  const original = readFileSync(full.archive);
  chmodSync(full.archive, 0o444);
  const destination = join(temporary, 'valid-output');
  // The supported profile is the actual entry point for this successful build.
  const result = run('just', ['pack-plugin', 'clawhub', full.archive, destination], { cwd: repo });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const outputName = `popclaw-clawhub-${VERSION}-${hash(original).slice(0, 12)}`;
  const output = join(destination, outputName);
  const receipt = readJson(join(output, 'receipt.json'));
  assert.equal(receipt.profile, 'clawhub');
  assert.equal(receipt.source.fullArchiveSha256, hash(original));
  assert.equal(receipt.source.package.version, VERSION);
  assert.equal(receipt.fullMatrixVerification.cells, 10);
  assert.equal(receipt.preservation.removed.filter(path => path.endsWith('.node')).length, 10);
  assert.equal(receipt.preservation.promoted.length, 6);
  assert.equal(receipt.packages.length, 6);
  assert.equal(readdirSync(output).length, 7);
  const mainPackage = receipt.packages.find(pkg => pkg.name === 'popclaw-clawhub');
  const mainRoot = unpack(join(output, mainPackage.filename), join(temporary, 'main-inspection'));
  const manifest = readJson(join(mainRoot, 'package.json'));
  const vendor = readJson(join(mainRoot, NATIVE, 'package.json'));
  const marker = readJson(join(mainRoot, NATIVE, MARKER));
  assert.equal(manifest.name, 'popclaw-clawhub');
  assert.equal(readJson(join(mainRoot, 'openclaw.plugin.json')).id, 'popclaw');
  assert.deepEqual(vendor.optionalDependencies, manifest.optionalDependencies);
  assert.deepEqual(marker, receipt.marker);
  const list = execFileSync('tar', ['-tzf', join(output, mainPackage.filename)], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(list.filter(path => path.endsWith('.node')).length, 0);
  for (const path of ['LICENSE', 'NOTICE', `${NATIVE}/LICENSE`, `${NATIVE}/src/better_sqlite3.cpp`, `${NATIVE}/deps/sqlite3/sqlite3.c`,
    `${NATIVE}/binding.gyp`, `${NATIVE}/lib/popclaw-native-binding.cjs`, `${NATIVE}/lib/popclaw-native-path.cjs`,
    `${NATIVE}/POPCLAW-RUNTIME-MANIFEST.json`, 'migrations/001.sql', 'dist/bundled/cli.js']) {
    assert.deepEqual(readFileSync(join(mainRoot, path)), readFileSync(join(full.root, path)), path);
  }
  for (const row of marker.packages) {
    assert.equal(manifest.optionalDependencies[row.name], VERSION);
    const artifact = receipt.packages.find(pkg => pkg.name === row.name);
    const archive = join(output, artifact.filename);
    assert.equal(hash(readFileSync(archive)), artifact.sha256);
    const root = unpack(archive, join(temporary, `inspection-${row.name}`));
    const metadata = readJson(join(root, 'package.json'));
    assert.equal(metadata.version, VERSION);
    assert.equal(metadata.license, '(Apache-2.0 AND MIT)');
    assert.deepEqual(metadata.os, [row.platform]);
    assert.deepEqual(metadata.cpu, [row.arch]);
    assert.deepEqual(metadata.libc, row.libc ? [row.libc] : undefined);
    for (const key of ['scripts', 'dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies', 'main', 'bin', 'exports', 'openclaw']) assert.equal(metadata[key], undefined, key);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(entries.filter(path => path.endsWith('.node')).length, 2);
    assert.equal(entries.some(path => path.endsWith('openclaw.plugin.json')), false);
    assert.equal(entries.some(path => /\.(?:c|cpp|gyp|js|cjs)$/.test(path)), false);
    for (const binding of row.bindings) {
      const bytes = readFileSync(join(root, 'build/Release', binding.file));
      assert.equal(hash(bytes), binding.sha256);
      assert.equal(bytes.length, binding.size);
      assert.equal(binding.abi, ABI[binding.nodeMajor]);
      assert.deepEqual(bytes, readFileSync(join(full.root, RELEASE, binding.file)));
    }
    for (const path of ['LICENSE', 'NOTICE']) assert.deepEqual(readFileSync(join(root, path)), readFileSync(join(full.root, path)));
    assert.deepEqual(readFileSync(join(root, 'licenses/better-sqlite3/LICENSE')), readFileSync(join(full.root, NATIVE, 'LICENSE')));
    const provenance = readJson(join(root, 'POPCLAW-NATIVE-PROVENANCE.json'));
    assert.equal(provenance.source.fullArchiveSha256, hash(original));
    assert.deepEqual(provenance.bindings, row.bindings);
  }
  assert.deepEqual(readFileSync(full.archive), original);
  assert.equal(readJson(join(full.root, 'package.json')).name, 'popclaw');
  assert.equal(readJson(join(full.root, NATIVE, 'package.json')).optionalDependencies, undefined);
  const repeated = packageClawHub({ fullTarball: full.archive, dest: join(temporary, 'repeated-output'), fullSha256: hash(original) });
  assert.deepEqual(repeated.packages, receipt.packages);
  assert.throws(() => packageClawHub({ fullTarball: full.archive, dest: destination }), /already exists/);
  assert.deepEqual(readdirSync(destination), [outputName]);
  assert.equal(run(process.execPath, [join(scripts, 'prepare-native-deps.mjs'), '--verify-tarball', join(output, mainPackage.filename)]).status, 1,
    'a ClawHub main package must not pass the complete distribution guard');
});

test('rejects incomplete matrices, incorrect headers and ABI initializers, duplicate defaults and foreign addons', () => {
  const missing = fixture('missing-binding', root => rmSync(join(root, RELEASE, bindingName('linux', 'arm64', 26))));
  failure(missing.archive, 'missing-binding', /expected exactly one archive entry/);
  const header = fixture('wrong-header', root => put(root, `${RELEASE}/${bindingName('linux', 'x64', 24)}`, headerFixture('darwin', 'arm64', 24)));
  failure(header.archive, 'wrong-header', /expected linux-x64, binary header is darwin-arm64/);
  const abi = fixture('wrong-abi', root => put(root, `${RELEASE}/${bindingName('darwin', 'arm64', 24)}`, headerFixture('darwin', 'arm64', 26)));
  failure(abi.archive, 'wrong-abi', /missing Node ABI 137 initializer/);
  const duplicate = fixture('duplicate-default', root => put(root, `${RELEASE}/better_sqlite3.node`, headerFixture('darwin', 'arm64', 24)));
  failure(duplicate.archive, 'duplicate-default', /duplicate default/);
  const foreign = fixture('foreign-addon', root => put(root, 'dist/foreign.node', headerFixture('darwin', 'arm64', 24)));
  failure(foreign.archive, 'foreign-addon', /binding inventory is incomplete or invalid/);
});

test('rejects changed provenance, unsupported versions, missing source fallback and hash mismatches', () => {
  const loader = fixture('changed-loader', root => put(root, `${NATIVE}/lib/database.js`, 'different bytes'));
  failure(loader.archive, 'changed-loader', /native loader hash mismatch/);
  const resolver = fixture('old-resolver', root => {
    put(root, `${NATIVE}/lib/popclaw-native-path.cjs`, 'old resolver');
    const provenance = readJson(join(root, NATIVE, 'POPCLAW-RUNTIME-MANIFEST.json'));
    provenance.runtimeLoader.resolverSha256 = hash(Buffer.from('old resolver'));
    put(root, `${NATIVE}/POPCLAW-RUNTIME-MANIFEST.json`, provenance);
  });
  failure(resolver.archive, 'old-resolver', /needs the reviewed platform resolver/);
  const version = fixture('bad-version', root => {
    const manifest = readJson(join(root, 'package.json')); manifest.version = '../escape';
    put(root, 'package.json', manifest); put(root, 'openclaw.plugin.json', { id: 'popclaw', version: manifest.version });
  });
  failure(version.archive, 'bad-version', /supported exact version/);
  const source = fixture('missing-source', root => rmSync(join(root, NATIVE, 'deps/sqlite3/sqlite3.c')));
  failure(source.archive, 'missing-source', /required license or source fallback file is missing/);
  assert.throws(() => packageClawHub({ fullTarball: source.archive, dest: temporary, fullSha256: '0'.repeat(64) }), /SHA-256 differs/);
});

test('rejects a changed database loader even when its provenance hash is updated to match', () => {
  const input = fixture('self-hashed-loader', root => {
    const path = `${NATIVE}/lib/database.js`;
    const changed = readFileSync(join(root, path), 'utf8') + '\nthrow new Error("broken loader");\n';
    put(root, path, changed);
    const provenance = readJson(join(root, NATIVE, 'POPCLAW-RUNTIME-MANIFEST.json'));
    provenance.runtimeLoader.derivedSha256 = hash(Buffer.from(changed));
    put(root, `${NATIVE}/POPCLAW-RUNTIME-MANIFEST.json`, provenance);
  });
  failure(input.archive, 'self-hashed-loader', /Unreviewed native database loader/);
});

test('derives byte-identical archives under umask 022 and 077, preserving executable modes', () => {
  const input = fixture('umask-input');
  const originalUmask = process.umask();
  try {
    process.umask(0o022);
    const permissive = packageClawHub({ fullTarball: input.archive, dest: join(temporary, 'umask022') });
    process.umask(0o077);
    const restrictive = packageClawHub({ fullTarball: input.archive, dest: join(temporary, 'umask077') });
    assert.deepEqual(restrictive.packages, permissive.packages);
  } finally { process.umask(originalUmask); }
});

test('audits every tar member before extraction and leaves no output on unsafe input', () => {
  for (const [name, extra, expected] of [
    ['traversal', { name: 'package/../outside' }, /invalid path/],
    ['absolute', { name: '/tmp/popclaw-escape' }, /invalid path/],
    ['symlink', { name: 'package/link', kind: 'symlink', target: '../../outside' }, /unsupported member type/],
    ['hardlink', { name: 'package/link', kind: 'hardlink', target: 'package/package.json' }, /unsupported member type/],
    ['duplicate', { name: 'package/package.json' }, /duplicate member/],
    ['windows-path', { name: 'package/C:\\escape' }, /invalid path/],
    ['privileged', { name: 'package/privileged', mode: 0o4755 }, /special permission bits/],
    ['file-parent', { name: 'package/package.json/nested' }, /file used as parent/],
  ]) {
    const input = fixture(`unsafe-${name}`, undefined, [extra]);
    failure(input.archive, `unsafe-${name}`, expected);
  }
});

test('validates profile arguments and keeps the full profile matrix guard', () => {
  assert.throws(() => packageClawHub(), /required/);
  assert.throws(() => packageClawHub({ fullTarball: 'x', dest: 'y', fullSha256: 'invalid' }), /lowercase SHA-256/);
  const cli = run(process.execPath, [join(scripts, 'clawhub-platform-package.mjs'), '--unknown', 'value']);
  assert.equal(cli.status, 1); assert.match(cli.stderr, /usage:/);
  for (const [args, expected] of [[['unknown'], /PROFILE must be full or clawhub/], [['full', 'input.tgz'], /only valid with the clawhub profile/], [['clawhub'], /required/]]) {
    const result = run('just', ['pack-plugin', ...args], { cwd: repo });
    assert.equal(result.status, 1); assert.match(result.stderr, expected);
  }
  const input = fixture('full-guard', root => rmSync(join(root, RELEASE, bindingName('linux', 'x64', 26))));
  const stubDirectory = join(temporary, 'stub-bin');
  put(stubDirectory, 'pnpm', '#!/usr/bin/env bash\nset -euo pipefail\nversion=$(node -p "require(\'./package.json\').version")\ncp "$TEST_FULL_ARCHIVE" "$3/popclaw-${version}.tgz"\n', 0o755);
  const destination = join(temporary, 'full-rejected-output');
  const result = run('just', ['pack-plugin', 'full', '', destination], { cwd: repo,
    env: { ...process.env, PATH: `${stubDirectory}:${process.env.PATH}`, TEST_FULL_ARCHIVE: input.archive } });
  assert.equal(result.status, 1); assert.match(result.stderr, /does not contain the full native prebuild matrix/);
  assert.deepEqual(readdirSync(destination), [], 'full profile removes rejected archive');
  const dryRun = run('just', ['--dry-run', 'pack-plugin'], { cwd: repo });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const recipe = execFileSync('just', ['--show', 'pack-plugin'], { cwd: repo, encoding: 'utf8' });
  assert.match(recipe, /\$PROFILE="full"/);
  assert.match(recipe, /--verify-tarball "\$dst"/);
});


test('promotes the prebuilt client graph and removes every full graph file', () => {
  const full = fixture('client-profile', root => {
    put(root, 'dist/bundled/shared-full.js', "export const provider = 'full-only';\n");
  });
  const result = packageClawHub({ fullTarball: full.archive, dest: join(temporary, 'client-profile-output') });
  const main = result.packages.find(pkg => pkg.name === 'popclaw-clawhub');
  const root = unpack(join(result.directory, main.filename), join(temporary, 'client-profile-inspection'));
  assert.deepEqual(readFileSync(join(root, 'dist/bundled/index.js')), readFileSync(join(full.root, 'dist/client-bundled/index.js')),
    'ClawHub must execute the exact prebuilt client graph instead of the full Ranger graph');
  const paths = execFileSync('tar', ['-tzf', join(result.directory, main.filename)], { encoding: 'utf8' }).split('\n');
  assert.equal(paths.some(path => path.includes('/dist/client-bundled/')), false);
  assert.equal(paths.some(path => path.endsWith('/shared-full.js')), false);
  const promoted = result.preservation.promoted.find(file => file.path === 'dist/bundled/index.js');
  assert.equal(promoted.sourcePath, 'dist/client-bundled/index.js');
  assert.equal(promoted.sha256, hash(readFileSync(join(full.root, promoted.sourcePath))));
});


test('rejects missing or modified client graphs instead of falling back to full operator code', () => {
  const missing = fixture('missing-client', root => rmSync(join(root, 'dist/client-bundled'), { recursive: true }));
  failure(missing.archive, 'missing-client', /no valid prebuilt client profile/);
  const changed = fixture('changed-client', root => put(root, 'dist/client-bundled/index.js', 'changed client'));
  failure(changed.archive, 'changed-client', /prebuilt client inventory differs/);
  const extra = fixture('extra-client', root => put(root, 'dist/client-bundled/unrecorded.js', 'unexpected'));
  failure(extra.archive, 'extra-client', /prebuilt client inventory differs/);
  const provider = fixture('provider-client', root => {
    const path = 'dist/client-bundled/POPCLAW-BUNDLE-PROFILE.json';
    const profile = readJson(join(root, path));
    profile.sourceInputs.push('src/scraper/commercial/twitterapi-io-scraper.ts');
    put(root, path, profile);
  });
  failure(provider.archive, 'provider-client', /invalid client capability profile/);
});
