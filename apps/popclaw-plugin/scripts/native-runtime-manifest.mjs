/** Derive an auditable runtime manifest for the shipped precompiled addon.
 * The upstream installer downloads/builds an addon; PopClaw supplies that addon
 * itself. Its runtime JS requires bindings, never prebuild-install or scripts.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UPSTREAM_LOADER_SHA256 = '02ea23bdd23d7ac5de0675a2f32fc686e76d5c6a32bd3e3891f360e72e07f61f';
const UPSTREAM_DEFAULT_LOAD = "require('bindings')('better_sqlite3.node')";
const RUNTIME_DEFAULT_LOAD = "require('./popclaw-native-binding.cjs')()";
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function deriveNativeRuntimeManifest(root) {
  const path = join(root, 'package.json'), original = readFileSync(path);
  const upstream = JSON.parse(original);
  if (upstream.name !== 'better-sqlite3' || upstream.version !== '12.11.1'
    || Object.keys(upstream.dependencies ?? {}).sort().join(',') !== 'bindings,prebuild-install'
    || upstream.scripts?.install !== 'prebuild-install || node-gyp rebuild --release') {
    throw new Error('Unreviewed native package metadata; review its runtime dependency closure before vendoring.');
  }
  const loaderPath = join(root, 'lib/database.js');
  const loader = readFileSync(loaderPath);
  const loaderText = loader.toString('utf8');
  if (sha256(loader) !== UPSTREAM_LOADER_SHA256 || loaderText.split(UPSTREAM_DEFAULT_LOAD).length !== 2) {
    throw new Error('Unreviewed native database loader; review its exact source before deriving the runtime.');
  }
  const derivedLoader = loaderText.replace(UPSTREAM_DEFAULT_LOAD, RUNTIME_DEFAULT_LOAD);
  const helper = readFileSync(new URL('./native-binding-loader.cjs', import.meta.url));
  const runtime = { ...upstream, dependencies: { bindings: upstream.dependencies.bindings } };
  delete runtime.scripts;
  delete runtime.devDependencies;
  delete runtime.overrides;
  writeFileSync(join(root, 'POPCLAW-RUNTIME-MANIFEST.json'), JSON.stringify({
    format: 1, distribution: 'PopClaw precompiled runtime derivative',
    upstreamManifestSha256: createHash('sha256').update(original).digest('hex'),
    upstreamManifest: upstream,
    omittedBuildOnlyDependencies: ['prebuild-install'],
    omittedFields: ['scripts', 'devDependencies', 'overrides'],
    runtimeDependencies: runtime.dependencies,
    runtimeLoader: {
      path: 'lib/database.js', upstreamSha256: UPSTREAM_LOADER_SHA256,
      derivedSha256: sha256(derivedLoader),
      helperPath: 'lib/popclaw-native-binding.cjs', helperSha256: sha256(helper),
      change: 'Only the default addon lookup selects a named platform/architecture/Node binding before upstream source-rebuild paths; explicit nativeBinding options are unchanged.',
    },
    license: 'Upstream LICENSE remains unchanged beside this record.',
  }, null, 2) + '\n');
  writeFileSync(loaderPath, derivedLoader);
  writeFileSync(join(root, 'lib/popclaw-native-binding.cjs'), helper);
  writeFileSync(path, JSON.stringify(runtime, null, 2) + '\n');
}
