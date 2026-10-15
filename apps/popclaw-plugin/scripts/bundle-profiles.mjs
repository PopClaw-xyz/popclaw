/** Build-time client capability selection and the byte inventory used by derivation. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const BUNDLE_PROFILE = 'POPCLAW-BUNDLE-PROFILE.json';
export const CLIENT_BUNDLE = 'dist/client-bundled';
export const FULL_BUNDLE = 'dist/bundled';
export const ENTRY_POINTS = ['index.js', 'mcp.js', 'mcp-hook.js', 'cli.js', 'prepare-native-world.js'];
export const clientForbiddenInput = /^src\/(?:runtime\/ranger\.ts|scraper\/(?!platform-scraper\.ts$)|onboarding\/owner-persona-file\.ts)/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Exact module substitutions; unrelated modules with the same basename are untouched. */
export function clientCapabilityPlugin(root) {
  const replacements = new Map([
    [resolve(root, 'src/runtime/ranger.js'), resolve(root, 'src/runtime/ranger-client.ts')],
    [resolve(root, 'src/onboarding/owner-persona-file.js'), resolve(root, 'src/onboarding/owner-persona-client.ts')],
  ]);
  return {
    name: 'popclaw-client-capabilities',
    setup(build) {
      build.onResolve({ filter: /(?:^|\/)(?:ranger|owner-persona-file)\.js$/ }, args => {
        const replacement = replacements.get(resolve(args.resolveDir, args.path));
        return replacement ? { path: replacement } : undefined;
      });
    },
  };
}

export function bundleInventory(directory) {
  const files = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        files.push({ path: relative(directory, path).split('\\').join('/'), size: bytes.length,
          sha256: hash(bytes), mode: lstatSync(path).mode & 0o777 });
      } else throw new Error('Non-regular bundle member: ' + path);
    }
  }
  visit(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function writeBundleProfile({ root, directory, profile, metafile }) {
  if (profile !== 'full' && profile !== 'client') throw new Error('Unknown bundle profile');
  const sourceInputs = Object.keys(metafile.inputs)
    .map(path => relative(root, resolve(root, path)).split('\\').join('/'))
    .filter(path => path.startsWith('src/')).sort();
  if (profile === 'client') {
    if (!sourceInputs.includes('src/runtime/ranger-client.ts')) throw new Error('Client Ranger adapter is absent');
    const forbidden = sourceInputs.filter(path => clientForbiddenInput.test(path));
    if (forbidden.length) throw new Error('Operator capability leaked into the client bundle: ' + forbidden.join(', '));
  }
  const files = bundleInventory(directory).filter(file => file.path !== BUNDLE_PROFILE);
  for (const entry of ENTRY_POINTS) if (!files.some(file => file.path === entry)) throw new Error('Missing bundled entry: ' + entry);
  const manifest = { format: 1, profile, rangerExecution: profile === 'full', ownerPersonaFile: profile === 'full',
    entryPoints: ENTRY_POINTS, sourceInputs, files };
  writeFileSync(join(directory, BUNDLE_PROFILE), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** The fixed complete archive is the source authority. The profile cannot omit
 * a staged file or substitute a different file at promotion time. */
export function inspectClientBundle(root) {
  const directory = join(root, CLIENT_BUNDLE);
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(directory, BUNDLE_PROFILE), 'utf8')); }
  catch { throw new Error('ClawHub packaging: full archive has no valid prebuilt client profile; rebuild the complete archive'); }
  if (manifest.format !== 1 || manifest.profile !== 'client' || manifest.rangerExecution !== false || manifest.ownerPersonaFile !== false
    || JSON.stringify(manifest.entryPoints) !== JSON.stringify(ENTRY_POINTS)
    || !Array.isArray(manifest.sourceInputs) || !manifest.sourceInputs.includes('src/runtime/ranger-client.ts')
    || manifest.sourceInputs.some(path => typeof path !== 'string' || !path.startsWith('src/') || clientForbiddenInput.test(path))) {
    throw new Error('ClawHub packaging: invalid client capability profile');
  }
  const files = bundleInventory(directory);
  const actual = files.filter(file => file.path !== BUNDLE_PROFILE);
  if (!Array.isArray(manifest.files) || manifest.files.length !== actual.length
    || new Set(manifest.files.map(file => file.path)).size !== actual.length
    || actual.some(file => !manifest.files.some(record => record.path === file.path && record.size === file.size
      && record.sha256 === file.sha256 && record.mode === file.mode))
    || ENTRY_POINTS.some(entry => !actual.some(file => file.path === entry))) {
    throw new Error('ClawHub packaging: prebuilt client inventory differs from its bytes');
  }
  return files.map(file => ({ ...file, sourcePath: `${CLIENT_BUNDLE}/${file.path}`, path: `${FULL_BUNDLE}/${file.path}` }));
}
