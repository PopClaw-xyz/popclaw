import { readdirSync, lstatSync, readFileSync, mkdirSync, writeFileSync, existsSync, renameSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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

function inventory(root: string): Record<string, string> {
  safeAbsolute(root); const files: Record<string, string> = {};
  function walk(path: string) {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name); const stat = lstatSync(child);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Runtime links and special files are refused');
      if (stat.isDirectory()) walk(child); else files[relative(root, child)] = createHash('sha256').update(readFileSync(child)).digest('hex');
    }
  }
  walk(root); return files;
}
export function runtimePlan(source: string, appRoot: string) {
  appRoot = stableRuntimeRoot(appRoot);
  if (existsSync(join(source, 'node_modules')) || existsSync(join(source, '.git'))) throw new Error('Use a complete extracted runtime package, not a development checkout');
  const files = inventory(source);
  for (const required of ['package.json', 'LICENSE', 'dist/bundled/mcp.js', 'dist/bundled/mcp-hook.js']) if (!files[required]) throw new Error(`Missing runtime file: ${required}`);
  if (!Object.keys(files).some(f => f.startsWith('migrations/')) || !Object.keys(files).some(f => f.startsWith('dist/native-deps/'))) throw new Error('Runtime native files or migrations missing');
  const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,100}$/.test(version)) throw new Error('Unsafe runtime version');
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const target = join(appRoot, 'versions', `${version}-${digest}`);
  if (existsSync(target) && JSON.stringify(inventory(target)) !== JSON.stringify(files)) throw new Error('Stable runtime was modified; refusing to overwrite');
  return { source, target, version, digest, files };
}
export function copyRuntime(plan: ReturnType<typeof runtimePlan>) {
  if (JSON.stringify(inventory(plan.source)) !== JSON.stringify(plan.files)) throw new Error('Source runtime changed after planning');
  if (existsSync(plan.target)) { if (JSON.stringify(inventory(plan.target)) !== JSON.stringify(plan.files)) throw new Error('Stable runtime was modified'); return plan.target; }
  safeAbsolute(plan.target); mkdirSync(dirname(plan.target), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(plan.target), '.setup-'));
  try {
    for (const file of Object.keys(plan.files)) { const dest = join(staging, file); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); writeFileSync(dest, readFileSync(join(plan.source, file)), { flag: 'wx', mode: lstatSync(join(plan.source, file)).mode & 0o777 }); }
    if (JSON.stringify(inventory(staging)) !== JSON.stringify(plan.files)) throw new Error('Runtime copy verification failed');
    if (existsSync(plan.target)) throw new Error('Runtime destination appeared concurrently');
    renameSync(staging, plan.target);
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true }); }
  return plan.target;
}
/** Native ABI + SQLite persistence only; never imports the business runtime or runs migrations. */
export function probeNative(pkg: string, scratchParent: string) {
  safeAbsolute(pkg); safeAbsolute(scratchParent);
  const native = join(pkg, 'dist/native-deps/better-sqlite3');
  const binding = join(native, 'build/Release', `better_sqlite3-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}.node`);
  if (!existsSync(binding)) throw new Error('No explicit native binary for this OS/architecture/Node; setup will not rebuild or download');
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
