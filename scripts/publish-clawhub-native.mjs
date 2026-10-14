/** Publish only the fixed native package allowlist, from verified retained bytes. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const isCredential = key => /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN|NPM_ID_TOKEN|NPM_BOOTSTRAP_TOKEN)$/i.test(key)
  || (/^npm_config_/i.test(key) && /(?:auth|token|password)/i.test(key));

function validateAuthentication(authMode, dryRun, environment) {
  requireValue(['oidc', 'bootstrap-token'].includes(authMode), 'invalid authentication mode');
  const credentials = Object.entries(environment).filter(([key, value]) => isCredential(key)
    && value !== undefined && value !== '');
  if (dryRun) requireValue(credentials.length === 0, 'dry runs must not receive npm credentials');
  if (authMode === 'oidc') requireValue(credentials.length === 0, 'OIDC forbids npm credentials');
  else {
    requireValue(credentials.every(([key]) => key === 'NPM_BOOTSTRAP_TOKEN'),
      'bootstrap-token accepts only NPM_BOOTSTRAP_TOKEN');
    if (!dryRun) requireValue(typeof environment.NPM_BOOTSTRAP_TOKEN === 'string'
      && environment.NPM_BOOTSTRAP_TOKEN.trim().length > 0, 'NPM_BOOTSTRAP_TOKEN is required for real bootstrap publication');
  }
}

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
export async function publishNative({ packages, dryRun, authMode = 'oidc', environment = {}, getPackage, verify, publish, dryPublish }) {
  requireValue(typeof dryRun === 'boolean', 'dryRun must be an explicit boolean');
  validateAuthentication(authMode, dryRun, environment);
  const ordered = validatePackages(packages);
  const state = [];
  // Finish the WHOLE name/version preflight before the first irreversible step.
  for (const pkg of ordered) {
    const document = await getPackage(pkg.name);
    requireValue(isObject(document), `invalid registry state for ${pkg.name}`);
    if (document.missing === true) state.push({ pkg, bootstrap: true, exists: false });
    else {
      requireValue(document.name === pkg.name && isObject(document.versions), `invalid registry state for ${pkg.name}`);
      const versions = Object.keys(document.versions);
      state.push({ pkg, bootstrap: false, exists: Object.hasOwn(document.versions, pkg.version), versions });
    }
  }
  const bootstrapRequired = state.filter(row => row.bootstrap).map(row => row.pkg.name);
  if (authMode === 'bootstrap-token') {
    const conflicts = state.filter(row => !row.bootstrap && (row.versions.length !== 1 || !row.exists));
    requireValue(conflicts.length === 0,
      `BOOTSTRAP_NAME_CONFLICT: ${conflicts.map(row => row.pkg.name).join(', ')}. Bootstrap permits only a new name or the sole matching target version from a partial first release. No packages were published.`);
  } else if (!dryRun && bootstrapRequired.length) {
    throw new Error(`BOOTSTRAP_REQUIRED: ${bootstrapRequired.join(', ')}. Use the explicit bootstrap-token mode for the verified real target archives, then configure each trusted publisher for release-clawhub-native.yml / npm-release. No packages were published.`);
  }
  // An existing version is only reusable if its registry bytes and attestation
  // already match. Check ALL existing versions before publishing ANY missing one.
  for (const row of state.filter(row => row.exists)) await verify(row.pkg);
  const result = { dryRun, authMode, bootstrapRequired, alreadyVerified: state.filter(row => row.exists).map(row => row.pkg.name), published: [] };
  if (dryRun) {
    // npm also rejects an existing version during --dry-run; verified versions
    // need no further publication request on a partial-release resume.
    for (const row of state.filter(row => !row.exists)) await dryPublish(row.pkg);
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
  const document = await response.json();
  requireValue(isObject(document) && document.name === name && isObject(document.versions)
    && !Object.hasOwn(document, 'missing'), `invalid registry state for ${name}`);
  return document;
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

/** Isolate npm configuration and expose the bootstrap token only to npm publish. */
export async function withRegistryCommands({ directory, authMode, environment, execute = execFileSync }, action) {
  const session = mkdtempSync(join(tmpdir(), 'popclaw-native-registry-'));
  try {
    const anonymousConfig = join(session, 'anonymous.npmrc');
    const publishConfig = join(session, 'publish.npmrc');
    const globalConfig = join(session, 'global.npmrc');
    writeFileSync(anonymousConfig, '', { mode: 0o600 });
    writeFileSync(globalConfig, '', { mode: 0o600 });
    // The file contains a variable reference, never the credential itself.
    writeFileSync(publishConfig, authMode === 'bootstrap-token'
      ? '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n' : '', { mode: 0o600 });
    const clean = Object.fromEntries(Object.entries(environment).filter(([key]) => !isCredential(key) && !/^npm_config_/i.test(key)));
    const anonymous = { ...clean, NPM_CONFIG_USERCONFIG: anonymousConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_REGISTRY: REGISTRY, NPM_CONFIG_CACHE: join(session, 'cache') };
    const npm = (pkg, real) => execute('npm', ['publish', verifiedArchive(directory, pkg), '--access', 'public',
      '--ignore-scripts', '--registry', REGISTRY, real ? '--provenance' : '--dry-run'], {
      cwd: session, stdio: 'inherit', env: real ? { ...anonymous, NPM_CONFIG_USERCONFIG: publishConfig,
        ...(authMode === 'bootstrap-token' ? { NODE_AUTH_TOKEN: environment.NPM_BOOTSTRAP_TOKEN } : {}) } : anonymous,
    });
    return await action({
      publish: pkg => npm(pkg, true), dryPublish: pkg => npm(pkg, false),
      verify: pkg => {
        const path = verifiedArchive(directory, pkg);
        try {
          execute('bash', [join(ROOT, 'scripts/verify-published-package.sh'), pkg.name, pkg.version, path], {
            cwd: session, stdio: 'inherit', env: anonymous,
          });
        } catch (error) {
          console.error('Native provenance workflow: release-clawhub-native.yml, environment npm-release. The shared verifier may mention the original release.yml workflow.');
          throw error;
        }
      },
    });
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
}

async function cli() {
  const args = process.argv.slice(2), options = { dryRun: true };
  while (args.length) {
    const key = args.shift();
    if (key === '--publish') { requireValue(!options.mode, 'duplicate mode'); options.mode = key; options.dryRun = false; }
    else if (key === '--dry-run') { requireValue(!options.mode, 'duplicate mode'); options.mode = key; }
    else if (['--directory', '--output', '--auth-mode'].includes(key) && args.length && !args[0].startsWith('--') && !options[key]) options[key] = args.shift();
    else throw new Error('usage: --directory <verified-retained-directory> --output <result.json> [--dry-run|--publish] [--auth-mode oidc|bootstrap-token]');
  }
  requireValue(options['--directory'] && options['--output'], '--directory and --output are required');
  const authMode = options['--auth-mode'] ?? 'oidc';
  validateAuthentication(authMode, options.dryRun, process.env);
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
  const result = await withRegistryCommands({ directory, authMode, environment: process.env }, commands =>
    publishNative({ packages, dryRun: options.dryRun, authMode, environment: process.env,
      getPackage: getRegistryPackage, ...commands }));
  writeFileSync(options['--output'], JSON.stringify(result, null, 2) + '\n');
  const summary = options.dryRun
    ? `Dry run only (${authMode}): no packages published; publication authentication and provenance remain untested.\nBootstrap required: ${result.bootstrapRequired.join(', ') || 'none detected'}.\n`
    : `Native packages verified: ${[...result.alreadyVerified, ...result.published].join(', ')}.\n`
      + (result.published.length ? `Published ${result.published.length} native packages with ${authMode}; each registry archive and attestation was verified.\n`
        : `Existing versions only: no publication attempted; ${authMode} authentication was not exercised.\n`);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
