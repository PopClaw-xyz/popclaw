import { readdirSync, lstatSync, statSync, readFileSync, mkdirSync, writeFileSync, existsSync, renameSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { MARKER, platformBindings, resolveNativeBinding } from '../../scripts/native-binding-path.cjs';
import { safeAbsolute } from './identity.js';

function unstableComponents(path: string, target: boolean): boolean {
  const parts = path.split('/');
  return parts.some((part, index) => part === '_npx' || part === '_cacache'
    || (target && part === 'node_modules')
    || (part === '_tmp' && ['.npm', 'npm-cache'].includes(parts[index - 1] ?? '')));
}
/** A runtime target may not yet exist; canonicalize its existing ancestor. */
export function stableRuntimeRoot(path: string): string {
  safeAbsolute(path);
  let ancestor = path; const remaining: string[] = [];
  while (!existsSync(ancestor)) { remaining.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const canonical = join(realpathSync(ancestor), ...remaining);
  if (unstableComponents(canonical, true)) throw new Error('Stable runtime target cannot be inside npm temporary/cache directories or node_modules');
  return canonical;
}
/** Resolve symlinked Node launchers before checking known temporary npm paths. */
export function stableNode(path: string): string {
  const canonical = realpathSync(path);
  if (unstableComponents(canonical, false)) throw new Error('Node executable is inside an npm temporary/cache directory; use a stable Node installation');
  return canonical;
}

function inventory(root: string, ignoredRootEntries: ReadonlySet<string> = new Set()): Record<string, string> {
  safeAbsolute(root); const files: Record<string, string> = {};
  function walk(path: string) {
    for (const name of readdirSync(path).sort()) {
      if (path === root && ignoredRootEntries.has(name)) continue;
      const child = join(path, name); const stat = lstatSync(child);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Runtime links and special files are refused');
      if (stat.isDirectory()) walk(child); else files[relative(root, child)] = createHash('sha256').update(readFileSync(child)).digest('hex');
    }
  }
  walk(root); return files;
}
type RuntimeInput = { source?: string; generated?: string; mode: number };
const nativeRelative = 'dist/native-deps/better-sqlite3';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Plan a self-contained copy without traversing the host's dependency tree. */
function runtimeInputs(source: string) {
  safeAbsolute(source);
  if (existsSync(join(source, '.git'))) throw new Error('Use a complete extracted runtime package, not a development checkout');
  const platform = platformBindings(join(source, nativeRelative));
  if (!platform && existsSync(join(source, 'node_modules'))) throw new Error('Use a complete extracted runtime package, not a development checkout');
  const files = inventory(source, platform ? new Set(['node_modules', 'package-lock.json']) : undefined);
  const inputs: Record<string, RuntimeInput> = Object.fromEntries(Object.keys(files).map(file => [file, {source: join(source, file), mode: lstatSync(join(source, file)).mode & 0o777}]));
  const generate = (file: string, value: unknown) => {
    const generated = JSON.stringify(value, null, 2) + '\n';
    inputs[file] = {generated, mode: 0o644}; files[file] = hash(generated);
  };
  if (platform) {
    const main = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    if (main.name !== 'popclaw-clawhub' || main.version !== platform.marker.version) throw new Error('ClawHub runtime manifest does not match its platform dependencies');
    const expected = platform.marker.packages.map((row: {name: string}) => row.name).sort();
    for (const file of ['package.json', `${nativeRelative}/package.json`]) {
      const manifest = JSON.parse(readFileSync(join(source, file), 'utf8'));
      if (JSON.stringify(Object.keys(manifest.optionalDependencies ?? {}).sort()) !== JSON.stringify(expected)
        || expected.some((name: string) => manifest.optionalDependencies[name] !== platform.marker.version)) throw new Error('ClawHub runtime dependency declarations differ');
      delete manifest.optionalDependencies;
      if (manifest.openclaw?.install?.requiredPlatformPackages) {
        delete manifest.openclaw.install.requiredPlatformPackages;
        if (!Object.keys(manifest.openclaw.install).length) delete manifest.openclaw.install;
      }
      generate(file, manifest);
    }
    const markerFile = `${nativeRelative}/${MARKER}`;
    delete files[markerFile]; delete inputs[markerFile];
    for (const binding of platform.bindings) {
      const file = `${nativeRelative}/build/Release/${binding.file}`;
      files[file] = binding.sha256;
      inputs[file] = {source: binding.path, mode: statSync(binding.path).mode & 0o777};
    }
    generate(`${nativeRelative}/POPCLAW-PLATFORM-MATERIALIZATION.json`, {
      format: 1, distribution: 'self-contained-platform-runtime',
      sourceManifestSha256: hash(readFileSync(join(source, markerFile))),
      package: platform.entry,
    });
  }
  // Match inventory's depth-first, sorted directory entries. Sorting whole
  // paths would put sqlite3.gyp before the sqlite3/ directory and change the
  // digest when setup is run again from the materialized, marker-free copy.
  const compare = (a: string, b: string) => {
    const left = a.split('/'), right = b.split('/');
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
    }
    return left.length - right.length;
  };
  return {files: platform ? Object.fromEntries(Object.entries(files).sort(([a], [b]) => compare(a, b))) : files, inputs};
}
// Generated platform files have a deterministic order; compare by content.
function sameFiles(a: Record<string, string>, b: Record<string, string>) {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([file, digest]) => b[file] === digest);
}
export function runtimePlan(source: string, appRoot: string) {
  appRoot = stableRuntimeRoot(appRoot);
  const {files, inputs} = runtimeInputs(source);
  for (const required of ['package.json', 'LICENSE', 'dist/bundled/mcp.js', 'dist/bundled/mcp-hook.js']) if (!files[required]) throw new Error(`Missing runtime file: ${required}`);
  if (!Object.keys(files).some(f => f.startsWith('migrations/')) || !Object.keys(files).some(f => f.startsWith('dist/native-deps/'))) throw new Error('Runtime native files or migrations missing');
  const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,100}$/.test(version)) throw new Error('Unsafe runtime version');
  const digest = hash(JSON.stringify(files));
  const target = join(appRoot, 'versions', `${version}-${digest}`);
  if (existsSync(target) && !sameFiles(inventory(target), files)) throw new Error('Stable runtime was modified; refusing to overwrite');
  return { source, target, version, digest, files, inputs };
}
export function copyRuntime(plan: ReturnType<typeof runtimePlan>) {
  if (!sameFiles(runtimeInputs(plan.source).files, plan.files)) throw new Error('Source runtime changed after planning');
  if (existsSync(plan.target)) { if (!sameFiles(inventory(plan.target), plan.files)) throw new Error('Stable runtime was modified'); return plan.target; }
  safeAbsolute(plan.target); mkdirSync(dirname(plan.target), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(plan.target), '.setup-'));
  try {
    for (const file of Object.keys(plan.files)) {
      const input = plan.inputs[file]!;
      const dest = join(staging, file); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, input.generated ?? readFileSync(input.source!), {flag: 'wx', mode: input.mode});
    }
    if (!sameFiles(inventory(staging), plan.files)) throw new Error('Runtime copy verification failed');
    if (existsSync(plan.target)) throw new Error('Runtime destination appeared concurrently');
    renameSync(staging, plan.target);
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true }); }
  return plan.target;
}
/** Native ABI + SQLite persistence only; never imports the business runtime or runs migrations. */
export function probeNative(pkg: string, scratchParent: string) {
  safeAbsolute(pkg); safeAbsolute(scratchParent);
  const native = join(pkg, 'dist/native-deps/better-sqlite3');
  const binding = resolveNativeBinding(native);
  const expected = `better_sqlite3-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}.node`;
  if (!binding || basename(binding) !== expected) throw new Error('No explicit native binary for this OS/architecture/Node; setup will not rebuild or download');
  const require = createRequire(join(pkg, 'package.json'));
  const Database = require(join(native, 'lib/index.js'));
  const scratch = mkdtempSync(join(scratchParent, '.popclaw-native-'));
  let db;
  try {
    const path = join(scratch, 'probe.db');
    db = new Database(path, { nativeBinding: binding }); db.exec('CREATE TABLE setup_probe(value TEXT NOT NULL)'); db.prepare('INSERT INTO setup_probe VALUES (?)').run('persisted'); db.close(); db = undefined;
    db = new Database(path, { nativeBinding: binding });
    if (db.prepare('SELECT value FROM setup_probe').get()?.value !== 'persisted') throw new Error('Native database reopen failed');
  } finally { db?.close(); rmSync(scratch, { recursive: true }); }
}
