/** Derive a separate ClawHub distribution from one verified complete archive.
 * Never builds source, loads an addon, installs dependencies, or publishes. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveNativeRuntimeManifest } from './native-runtime-manifest.mjs';
import { CLIENT_BUNDLE, FULL_BUNDLE, inspectClientBundle } from './bundle-profiles.mjs';

const require = createRequire(import.meta.url);
const { MARKER, PLATFORMS, ABI, bindingName, packageName } = require('./native-binding-path.cjs');
const scripts = dirname(fileURLToPath(import.meta.url));
const NATIVE = 'dist/native-deps/better-sqlite3';
const RELEASE = `${NATIVE}/build/Release`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const fail = message => { throw new Error(`ClawHub packaging: ${message}`); };

// Python's standard tar reader handles PAX/long names without a second custom
// tar parser. Audit ALL members before writing any member. No extractall, links,
// sparse files, special devices or ambiguous paths are accepted. Packing uses
// fixed metadata and gzip mtime, so equal input files produce equal archives.
const ARCHIVE_IO = String.raw`
import gzip, json, os, pathlib, shutil, stat, sys, tarfile
action, archive, root = sys.argv[1:]
def abort(message): raise ValueError('unsafe package archive: ' + message)
if action == 'unpack':
    with tarfile.open(archive, 'r:gz') as source:
        members, names, total = [], {}, 0
        for item in source:
            name = item.name.rstrip('/') if item.isdir() else item.name
            parts = name.split('/')
            if (not name or parts[0] != 'package' or (len(parts) == 1 and not item.isdir())
                or any(p in ('', '.', '..') for p in parts)
                or any(ord(c) < 32 or c in '\\:' for c in name)):
                abort('invalid path ' + repr(item.name))
            if not (item.isfile() or item.isdir()) or item.linkname or item.sparse is not None:
                abort('unsupported member type for ' + name)
            if item.mode & 0o7000: abort('special permission bits for ' + name)
            if name in names: abort('duplicate member ' + name)
            if item.size < 0: abort('negative size for ' + name)
            total += item.size
            if total > 256 * 1024 * 1024 or len(members) >= 20000: abort('size/member limit exceeded')
            names[name] = item
            members.append(item)
        for name in names:
            parent = pathlib.PurePosixPath(name).parent
            while str(parent) != '.':
                if str(parent) in names and not names[str(parent)].isdir(): abort('file used as parent ' + str(parent))
                parent = parent.parent
        os.mkdir(root, 0o700)
        for item in sorted(members, key=lambda m: (not m.isdir(), len(m.name.split('/')), m.name)):
            target = os.path.join(root, *item.name.rstrip('/').split('/'))
            if item.isdir():
                os.makedirs(target, mode=0o755, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
                with source.extractfile(item) as incoming, open(target, 'xb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
                if os.path.getsize(target) != item.size: abort('short data for ' + item.name)
                os.chmod(target, item.mode & 0o777)
        print(json.dumps({'files': sum(m.isfile() for m in members), 'unpackedBytes': total}))
elif action == 'pack':
    paths = [root]
    for directory, dirs, files in os.walk(root, followlinks=False):
        paths.extend(os.path.join(directory, name) for name in dirs + files)
    with open(archive, 'xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as output:
            for path in sorted(paths):
                mode = os.lstat(path).st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)): abort('non-regular staged path')
                name = 'package' + (('/' + os.path.relpath(path, root)) if path != root else '')
                info = output.gettarinfo(path, arcname=name)
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                info.mode = 0o755 if info.isdir() else info.mode & 0o777
                info.pax_headers = {}
                if info.isfile():
                    with open(path, 'rb') as incoming: output.addfile(info, incoming)
                else: output.addfile(info)
else: abort('unknown operation')
`;

function archiveIo(action, archive, root) {
  return execFileSync('python3', ['-c', ARCHIVE_IO, action, archive, root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
}
function fileInventory(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        files.push({ path: relative(root, path).split('\\').join('/'), size: bytes.length, sha256: sha256(bytes), mode: lstatSync(path).mode & 0o777 });
      } else fail('non-regular staged file');
    }
  }
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function readJson(root, path) {
  try { return JSON.parse(readFileSync(join(root, path), 'utf8')); }
  catch { fail(`missing or invalid JSON: ${path}`); }
}
function write(root, path, bytes, mode = 0o644) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  chmodSync(destination, mode);
}
function nonemptyDependencies(manifest, field) { return Object.keys(manifest[field] ?? {}).length > 0; }

function verifyReviewedDatabase(root, provenance) {
  const derived = readFileSync(join(root, NATIVE, 'lib/database.js'));
  const text = derived.toString('utf8');
  const replacement = "require('./popclaw-native-binding.cjs')()";
  if (text.split(replacement).length !== 2) fail('Unreviewed native database loader: expected the unique reviewed replacement');
  // Reconstruct the upstream source, then let the existing derivation enforce
  // its single pinned source hash and replacement. The archive cannot vouch
  // for its own altered loader by merely updating a provenance hash.
  const check = mkdtempSync(join(dirname(root), '.review-loader-'));
  try {
    write(check, 'package.json', jsonBytes(provenance.upstreamManifest));
    write(check, 'lib/database.js', Buffer.from(text.replace(replacement, "require('bindings')('better_sqlite3.node')")));
    deriveNativeRuntimeManifest(check);
    if (!readFileSync(join(check, 'lib/database.js')).equals(derived)) fail('Unreviewed native database loader: derivation differs');
  } finally { rmSync(check, { recursive: true, force: true }); }
}

/** Both optional dependency declarations and the runtime marker come from this
 * same physical inventory. The inputs are never mutated. */
export function createPlatformMetadata(main, native, bindings) {
  if (main?.name !== 'popclaw' || !versionPattern.test(main.version)) fail('expected a complete popclaw package with a supported exact version');
  if (native?.name !== 'better-sqlite3') fail('missing better-sqlite3 runtime metadata');
  if (nonemptyDependencies(main, 'dependencies') || nonemptyDependencies(main, 'optionalDependencies')
    || nonemptyDependencies(native, 'optionalDependencies')) fail('input must be the complete distribution without platform dependency declarations');
  const expected = PLATFORMS.flatMap(([platform, arch]) => Object.keys(ABI).map(major => bindingName(platform, arch, major)));
  if (!Array.isArray(bindings) || bindings.length !== expected.length || new Set(bindings.map(binding => binding.file)).size !== expected.length
    || bindings.some(binding => !expected.includes(binding.file) || !hashPattern.test(binding.sha256) || !Number.isSafeInteger(binding.size) || binding.size < 500_000)) fail('binding inventory is incomplete or invalid');
  const packages = PLATFORMS.map(([platform, arch]) => ({
    name: packageName(platform, arch), version: main.version, platform, arch,
    ...(platform === 'linux' ? { libc: 'glibc' } : {}),
    bindings: Object.entries(ABI).map(([major, abi]) => {
      const binding = bindings.find(entry => entry.file === bindingName(platform, arch, major));
      return { nodeMajor: Number(major), abi, file: binding.file, sha256: binding.sha256, size: binding.size };
    }),
  }));
  const dependencies = Object.fromEntries(packages.map(pkg => [pkg.name, pkg.version]));
  return {
    main: { ...main, name: 'popclaw-clawhub', optionalDependencies: dependencies,
      openclaw: { ...main.openclaw, install: { ...main.openclaw?.install, requiredPlatformPackages: packages.map(pkg => pkg.name) } } },
    native: { ...native, optionalDependencies: { ...dependencies } },
    packages,
    marker: { format: 1, distribution: 'clawhub-platform-dependencies', version: main.version, packages },
  };
}

function inspectFull(root) {
  const main = readJson(root, 'package.json');
  const plugin = readJson(root, 'openclaw.plugin.json');
  const native = readJson(root, `${NATIVE}/package.json`);
  const provenance = readJson(root, `${NATIVE}/POPCLAW-RUNTIME-MANIFEST.json`);
  if (plugin.id !== 'popclaw' || plugin.version !== main.version) fail('plugin id/version differs from the complete package');
  if (existsSync(join(root, NATIVE, MARKER))) fail('input already contains a platform dependency marker');
  for (const field of ['scripts', 'devDependencies']) {
    if (nonemptyDependencies(main, field) || nonemptyDependencies(native, field)) fail(`unexpected ${field} in packed runtime metadata`);
  }
  const required = ['LICENSE', 'NOTICE', `${NATIVE}/LICENSE`, `${NATIVE}/binding.gyp`, `${NATIVE}/src/better_sqlite3.cpp`,
    `${NATIVE}/deps/sqlite3/sqlite3.c`, `${NATIVE}/deps/sqlite3/sqlite3.h`, `${NATIVE}/deps/common.gypi`, `${NATIVE}/deps/sqlite3.gyp`];
  for (const path of required) if (!existsSync(join(root, path)) || !lstatSync(join(root, path)).isFile()) fail(`required license or source fallback file is missing: ${path}`);
  if (provenance.format !== 1 || provenance.upstreamManifest?.name !== native.name || provenance.upstreamManifest?.version !== native.version
    || !hashPattern.test(provenance.upstreamManifestSha256)
    || JSON.stringify(provenance.runtimeDependencies) !== JSON.stringify(native.dependencies)) fail('native runtime provenance does not match its manifest');
  for (const [pathField, hashField, expectedPath, reviewedScript] of [
    ['path', 'derivedSha256', 'lib/database.js'],
    ['helperPath', 'helperSha256', 'lib/popclaw-native-binding.cjs', 'native-binding-loader.cjs'],
    ['resolverPath', 'resolverSha256', 'lib/popclaw-native-path.cjs', 'native-binding-path.cjs'],
  ]) {
    const loader = provenance.runtimeLoader;
    if (loader?.[pathField] !== expectedPath || !hashPattern.test(loader?.[hashField] ?? '')) fail(`missing reviewed native loader provenance: ${pathField}`);
    const bytes = readFileSync(join(root, NATIVE, expectedPath));
    if (sha256(bytes) !== loader[hashField]) fail(`native loader hash mismatch: ${expectedPath}`);
    if (reviewedScript && sha256(bytes) !== sha256(readFileSync(join(scripts, reviewedScript)))) fail(`full archive needs the reviewed platform resolver: ${expectedPath}`);
  }
  verifyReviewedDatabase(root, provenance);
  const inventory = fileInventory(root);
  const nativeFiles = inventory.filter(file => file.path.endsWith('.node'));
  const bindings = nativeFiles.map(file => ({ file: basename(file.path), size: file.size, sha256: file.sha256 }));
  const plan = createPlatformMetadata(main, native, bindings);
  if (nativeFiles.some(file => file.path !== `${RELEASE}/${basename(file.path)}`)) fail('native binding outside the declared matrix directory');
  const promoted = inspectClientBundle(root);
  return { main, native, provenance, inventory, plan, promoted };
}

function nativePackage(root, sourceRoot, row, source, full) {
  const license = full.main.license === full.native.license ? full.main.license : `(${full.main.license} AND ${full.native.license})`;
  if (typeof full.main.license !== 'string' || typeof full.native.license !== 'string') fail('source package license metadata is missing');
  const manifest = {
    name: row.name, version: row.version,
    description: `PopClaw SQLite bindings for ${row.platform}/${row.arch}${row.libc ? ` (${row.libc})` : ''}, Node ${row.bindings.map(binding => binding.nodeMajor).join(' and ')}.`,
    license, repository: full.main.repository, os: [row.platform], cpu: [row.arch],
    ...(row.libc ? { libc: [row.libc] } : {}), engines: full.main.engines,
    files: ['build/Release', 'LICENSE', 'NOTICE', 'licenses', 'POPCLAW-NATIVE-PROVENANCE.json', 'README.md'],
  };
  write(root, 'package.json', jsonBytes(manifest));
  const licenses = full.inventory.filter(file => file.path.startsWith(NATIVE + '/') && /^(?:license|notice|copying)(?:[.-]|$)/i.test(basename(file.path)));
  for (const path of ['LICENSE', 'NOTICE']) write(root, path, readFileSync(join(sourceRoot, path)));
  for (const file of licenses) write(root, `licenses/better-sqlite3/${file.path.slice(NATIVE.length + 1)}`, readFileSync(join(sourceRoot, file.path)));
  for (const binding of row.bindings) {
    const original = full.inventory.find(file => file.path === `${RELEASE}/${binding.file}`);
    write(root, `build/Release/${binding.file}`, readFileSync(join(sourceRoot, original.path)), original.mode);
  }
  const sourceFiles = full.inventory.filter(file => file.path.startsWith(NATIVE + '/') && /\.(?:c|h|cpp|hpp|gyp|gypi)$/.test(file.path));
  write(root, 'POPCLAW-NATIVE-PROVENANCE.json', jsonBytes({
    format: 1, distribution: 'PopClaw native SQLite platform package',
    package: { name: row.name, version: row.version, platform: row.platform, arch: row.arch, ...(row.libc ? { libc: row.libc } : {}) },
    source, upstream: { name: full.native.name, version: full.native.version,
      manifestSha256: full.provenance.upstreamManifestSha256,
      runtimeProvenanceSha256: sha256(readFileSync(join(sourceRoot, NATIVE, 'POPCLAW-RUNTIME-MANIFEST.json'))) },
    bindings: row.bindings, sourceFiles: sourceFiles.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    licenses: [...full.inventory.filter(file => ['LICENSE', 'NOTICE'].includes(file.path)), ...licenses].map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  }));
  write(root, 'README.md', Buffer.from(`# ${row.name}\n\nThis package contains unmodified better-sqlite3 bindings selected by the PopClaw ClawHub distribution for ${row.platform}/${row.arch}${row.libc ? ` (${row.libc})` : ''}.\n\nIt contains Node ${row.bindings.map(binding => binding.nodeMajor).join(' and ')} bindings and has no install scripts, JavaScript entry point, or runtime dependencies. Keep optional dependencies enabled when installing the parent distribution.\n\nThe parent distribution retains the C/C++ source fallback. Exact source archive and binding hashes are recorded in POPCLAW-NATIVE-PROVENANCE.json. PopClaw LICENSE/NOTICE and the upstream better-sqlite3 license are included without changes.\n`));
}

function verifyMainPreservation(full, mainRoot) {
  const current = fileInventory(mainRoot);
  if (current.some(file => file.path.endsWith('.node'))) fail('ClawHub main package still contains a native binding');
  const rewritten = ['package.json', `${NATIVE}/package.json`];
  const removed = full.inventory.filter(file => file.path.endsWith('.node') || file.path.startsWith(FULL_BUNDLE + '/')
    || file.path.startsWith(CLIENT_BUNDLE + '/')).map(file => file.path);
  const preserved = full.inventory.filter(file => !rewritten.includes(file.path) && !removed.includes(file.path));
  for (const file of preserved) {
    const candidate = current.find(entry => entry.path === file.path);
    if (!candidate || candidate.sha256 !== file.sha256 || candidate.mode !== file.mode) fail(`main package did not preserve source file: ${file.path}`);
  }
  for (const file of full.promoted) {
    const candidate = current.find(entry => entry.path === file.path);
    if (!candidate || candidate.sha256 !== file.sha256 || candidate.size !== file.size || candidate.mode !== file.mode) {
      fail(`client promotion changed source bytes or mode: ${file.sourcePath}`);
    }
  }
  const expected = [...preserved.map(file => file.path), ...full.promoted.map(file => file.path), ...rewritten, `${NATIVE}/${MARKER}`].sort();
  if (JSON.stringify(current.map(file => file.path).sort()) !== JSON.stringify(expected)) fail('unexpected ClawHub main package file set');
  return { preservedFileCount: preserved.length, preservedFilesSha256: sha256(jsonBytes(preserved)), rewritten, removed, promoted: full.promoted, added: [`${NATIVE}/${MARKER}`] };
}

export function packageClawHub({ fullTarball, dest, fullSha256 } = {}) {
  if (typeof fullTarball !== 'string' || !fullTarball || typeof dest !== 'string' || !dest) fail('--full-tarball and --dest are required');
  if (fullSha256 !== undefined && !hashPattern.test(fullSha256)) fail('--full-sha256 must be a lowercase SHA-256 digest');
  const sourcePath = resolve(fullTarball);
  if (!lstatSync(sourcePath).isFile()) fail('full archive must be a regular file');
  const bytes = readFileSync(sourcePath);
  const fullArchiveSha256 = sha256(bytes);
  if (fullSha256 !== undefined && fullArchiveSha256 !== fullSha256) fail('full archive SHA-256 differs from the requested fixed input');
  const destination = resolve(dest);
  mkdirSync(destination, { recursive: true });
  const stage = mkdtempSync(join(destination, '.clawhub-platform-stage-'));
  try {
    const snapshot = join(stage, 'full-input.tgz');
    writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o400 });
    archiveIo('unpack', snapshot, join(stage, 'full'));
    // Reuse the existing independent full-matrix guard exactly as full packing
    // does. The immutable snapshot is also the archive audited above.
    const verification = execFileSync(process.execPath, [join(scripts, 'prepare-native-deps.mjs'), '--verify-tarball', snapshot], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
    const sourceRoot = join(stage, 'full/package');
    const full = inspectFull(sourceRoot);
    const source = { fullArchiveFilename: basename(sourcePath), fullArchiveSha256, fullArchiveBytes: bytes.length, package: { name: full.main.name, version: full.main.version } };
    const artifactDirectory = `popclaw-clawhub-${full.main.version}-${fullArchiveSha256.slice(0, 12)}`;
    const output = join(destination, artifactDirectory);
    if (existsSync(output)) fail('derived artifact directory already exists; refusing to overwrite it');
    const artifacts = join(stage, 'artifacts');
    mkdirSync(artifacts);
    const mainRoot = join(stage, 'main/package');
    cpSync(sourceRoot, mainRoot, { recursive: true, preserveTimestamps: true });
    // cpSync applies the caller's umask. Restore every recorded file mode
    // explicitly; the archive writer uses a fixed 0755 for all directories.
    for (const file of full.inventory) chmodSync(join(mainRoot, file.path), file.mode);
    for (const row of full.plan.packages) for (const binding of row.bindings) rmSync(join(mainRoot, RELEASE, binding.file));
    rmSync(join(mainRoot, FULL_BUNDLE), { recursive: true });
    renameSync(join(mainRoot, CLIENT_BUNDLE), join(mainRoot, FULL_BUNDLE));
    write(mainRoot, 'package.json', jsonBytes(full.plan.main));
    write(mainRoot, `${NATIVE}/package.json`, jsonBytes(full.plan.native));
    write(mainRoot, `${NATIVE}/${MARKER}`, jsonBytes(full.plan.marker));
    const preservation = verifyMainPreservation(full, mainRoot);
    const roots = [{ name: full.plan.main.name, root: mainRoot }];
    for (const row of full.plan.packages) {
      const root = join(stage, row.name, 'package');
      nativePackage(root, sourceRoot, row, source, full);
      roots.push({ name: row.name, root });
    }
    const packages = roots.map(({ name, root }) => {
      const filename = `${name}-${full.main.version}.tgz`;
      const archive = join(artifacts, filename);
      const inventory = fileInventory(root);
      archiveIo('pack', archive, root);
      const inspection = join(stage, `inspect-${name}`);
      archiveIo('unpack', archive, inspection);
      if (JSON.stringify(fileInventory(join(inspection, 'package'))) !== JSON.stringify(inventory)) fail(`packed files differ from staging: ${name}`);
      const packed = readFileSync(archive);
      return { name, version: full.main.version, filename, bytes: packed.length, sha256: sha256(packed),
        integrity: `sha512-${createHash('sha512').update(packed).digest('base64')}`, fileCount: inventory.length,
        unpackedBytes: inventory.reduce((total, file) => total + file.size, 0), filesSha256: sha256(jsonBytes(inventory)) };
    });
    if (sha256(readFileSync(sourcePath)) !== fullArchiveSha256) fail('source full archive changed during derivation');
    const receipt = { format: 1, profile: 'clawhub', source, artifactDirectory, artifactDirectorySuffix: 'First 12 characters of fullArchiveSha256; not a Git commit.',
      fullMatrixVerification: { command: 'node scripts/prepare-native-deps.mjs --verify-tarball <fixed-full-archive>', cells: 10, passed: true },
      marker: full.plan.marker, preservation, packages };
    writeFileSync(join(artifacts, 'receipt.json'), jsonBytes(receipt), { flag: 'wx' });
    if (existsSync(output)) fail('derived artifact directory appeared during derivation; refusing to overwrite it');
    renameSync(artifacts, output);
    process.stdout.write(verification.replaceAll(snapshot, basename(sourcePath)));
    return { directory: output, receipt: join(output, 'receipt.json'), ...receipt };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

function cli() {
  const args = process.argv.slice(2), options = {};
  const names = { '--full-tarball': 'fullTarball', '--dest': 'dest', '--full-sha256': 'fullSha256' };
  while (args.length) {
    const key = args.shift();
    if (!names[key] || options[names[key]] !== undefined || !args.length || args[0].startsWith('--')) fail('usage: --full-tarball <complete.tgz> --dest <directory> [--full-sha256 <digest>]');
    options[names[key]] = args.shift();
  }
  const result = packageClawHub(options);
  process.stdout.write(`ClawHub packages ready: ${result.directory}\nReceipt: ${result.receipt}\n`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
