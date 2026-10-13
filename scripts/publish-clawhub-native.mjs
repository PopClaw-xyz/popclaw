/** Publish only the fixed native package allowlist, from verified retained bytes. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NAMES = Object.freeze([
  'popclaw-native-sqlite-darwin-arm64', 'popclaw-native-sqlite-darwin-x64',
  'popclaw-native-sqlite-linux-arm64', 'popclaw-native-sqlite-linux-x64', 'popclaw-native-sqlite-win32-x64',
]);
const REGISTRY = 'https://registry.npmjs.org';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

function validatePackages(packages) {
  requireValue(Array.isArray(packages) && packages.length === NAMES.length
    && new Set(packages.map(pkg => pkg?.name)).size === NAMES.length
    && packages.every(pkg => NAMES.includes(pkg?.name)), 'receipt must contain exactly the five allowed native packages');
  const version = packages[0].version;
  requireValue(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), 'invalid native version');
  for (const pkg of packages) {
    requireValue(pkg.version === version && pkg.filename === `${pkg.name}-${version}.tgz`
      && /^[0-9a-f]{64}$/.test(pkg.sha256), 'invalid retained native package identity');
  }
  return NAMES.map(name => packages.find(pkg => pkg.name === name));
}

/** Dependency injection keeps registry-state and side-effect ordering testable. */
export async function publishNative({ packages, dryRun, getPackage, verify, publish, dryPublish }) {
  requireValue(typeof dryRun === 'boolean', 'dryRun must be an explicit boolean');
  const ordered = validatePackages(packages);
  const state = [];
  // Finish the WHOLE name/version preflight before the first irreversible step.
  for (const pkg of ordered) {
    const document = await getPackage(pkg.name);
    requireValue(isObject(document), `invalid registry state for ${pkg.name}`);
    if (document.missing === true) state.push({ pkg, bootstrap: true, exists: false });
    else {
      requireValue(document.name === pkg.name && isObject(document.versions), `invalid registry state for ${pkg.name}`);
      state.push({ pkg, bootstrap: false, exists: Object.hasOwn(document.versions, pkg.version) });
    }
  }
  const bootstrapRequired = state.filter(row => row.bootstrap).map(row => row.pkg.name);
  if (!dryRun && bootstrapRequired.length) {
    throw new Error(`BOOTSTRAP_REQUIRED: ${bootstrapRequired.join(', ')}. Create these package names with authorized npm credentials and configure each trusted publisher for release-clawhub-native.yml / npm-release before retrying. No packages were published.`);
  }
  // An existing version is only reusable if its registry bytes and attestation
  // already match. Check ALL existing versions before publishing ANY missing one.
  for (const row of state.filter(row => row.exists)) await verify(row.pkg);
  const result = { dryRun, bootstrapRequired, alreadyVerified: state.filter(row => row.exists).map(row => row.pkg.name), published: [] };
  if (dryRun) {
    for (const pkg of ordered) await dryPublish(pkg);
    return result;
  }
  for (const row of state.filter(row => !row.exists)) {
    await publish(row.pkg);
    await verify(row.pkg);
    result.published.push(row.pkg.name);
  }
  return result;
}

export async function getRegistryPackage(name, fetcher = fetch) {
  requireValue(NAMES.includes(name), 'package outside native allowlist');
  const response = await fetcher(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  // A failed request never means "missing version". Only the package's explicit
  // public-registry 404 can indicate that first-package bootstrap is required.
  if (response.status === 404) {
    const body = await response.json();
    requireValue(isObject(body) && body.error === 'Not found', `unrecognized registry 404 for ${name}`);
    return { missing: true };
  }
  requireValue(response.ok, `registry HTTP ${response.status} for ${name}`);
  return response.json();
}

function readJson(path) {
  requireValue(lstatSync(path).isFile(), `non-regular retained file: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function verifiedArchive(directory, pkg) {
  const path = join(directory, pkg.filename);
  requireValue(lstatSync(path).isFile(), 'retained archive is not a regular file');
  const data = readFileSync(path);
  requireValue(sha256(data) === pkg.sha256 && data.length === pkg.bytes
    && `sha512-${createHash('sha512').update(data).digest('base64')}` === pkg.integrity, `retained bytes changed: ${pkg.name}`);
  return path;
}

async function cli() {
  const args = process.argv.slice(2), options = { dryRun: true };
  while (args.length) {
    const key = args.shift();
    if (key === '--publish') { requireValue(!options.mode, 'duplicate mode'); options.mode = key; options.dryRun = false; }
    else if (key === '--dry-run') { requireValue(!options.mode, 'duplicate mode'); options.mode = key; }
    else if (['--directory', '--output'].includes(key) && args.length && !args[0].startsWith('--') && !options[key]) options[key] = args.shift();
    else throw new Error('usage: --directory <verified-retained-directory> --output <result.json> [--dry-run|--publish]');
  }
  requireValue(options['--directory'] && options['--output'], '--directory and --output are required');
  const directory = resolve(options['--directory']);
  const receiptPath = join(directory, 'receipt.json');
  const receipt = readJson(receiptPath);
  const validation = readJson(join(directory, 'validation.json'));
  requireValue(receipt.format === 1 && receipt.profile === 'clawhub' && Array.isArray(receipt.packages)
    && receipt.packages.length === 6 && receipt.packages.filter(pkg => pkg.name === 'popclaw-clawhub').length === 1,
  'expected verified six-package ClawHub receipt');
  requireValue(validation.format === 1 && validation.receiptSha256 === sha256(readFileSync(receiptPath))
    && validation.nativeMatrixCells === 10 && Array.isArray(validation.smoke) && validation.smoke.length > 0,
  'missing or stale independent archive/SQLite verification');
  const packages = validatePackages(receipt.packages.filter(pkg => pkg.name !== 'popclaw-clawhub'));
  for (const pkg of receipt.packages) verifiedArchive(directory, pkg);
  if (!options.dryRun) {
    requireValue(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      && /^.+\/.github\/workflows\/release-clawhub-native\.yml@/.test(process.env.GITHUB_WORKFLOW_REF || ''),
    'real publication is restricted to the manual release-clawhub-native.yml workflow');
  }
  const npm = (pkg, flags) => execFileSync('npm', ['publish', verifiedArchive(directory, pkg), '--access', 'public',
    '--ignore-scripts', '--registry', REGISTRY, ...flags], { stdio: 'inherit' });
  const result = await publishNative({ packages, dryRun: options.dryRun, getPackage: getRegistryPackage,
    verify: pkg => {
      const path = verifiedArchive(directory, pkg);
      try {
        execFileSync('bash', [join(ROOT, 'scripts/verify-published-package.sh'), pkg.name, pkg.version, path], {
          stdio: 'inherit', env: { ...process.env, npm_config_registry: REGISTRY },
        });
      } catch (error) {
        console.error('Native package trusted publisher: release-clawhub-native.yml, environment npm-release. The shared verifier may mention the original release.yml workflow.');
        throw error;
      }
    }, publish: pkg => npm(pkg, ['--provenance']), dryPublish: pkg => npm(pkg, ['--dry-run']),
  });
  writeFileSync(options['--output'], JSON.stringify(result, null, 2) + '\n');
  const summary = options.dryRun
    ? `Dry run only: no packages published; OIDC/provenance bindings remain untested.\nBootstrap required: ${result.bootstrapRequired.join(', ') || 'none detected'}.\n`
    : `Native packages verified: ${[...result.alreadyVerified, ...result.published].join(', ')}.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
