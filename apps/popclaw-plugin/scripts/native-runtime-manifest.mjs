/** Derive an auditable runtime manifest for the shipped precompiled addon.
 * The upstream installer downloads/builds an addon; PopClaw supplies that addon
 * itself. Its runtime JS requires bindings, never prebuild-install or scripts.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function deriveNativeRuntimeManifest(root) {
  const path = join(root, 'package.json'), original = readFileSync(path);
  const upstream = JSON.parse(original);
  if (upstream.name !== 'better-sqlite3' || upstream.version !== '12.11.1'
    || Object.keys(upstream.dependencies ?? {}).sort().join(',') !== 'bindings,prebuild-install'
    || upstream.scripts?.install !== 'prebuild-install || node-gyp rebuild --release') {
    throw new Error('Unreviewed native package metadata; review its runtime dependency closure before vendoring.');
  }
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
    license: 'Upstream LICENSE remains unchanged beside this record.',
  }, null, 2) + '\n');
  writeFileSync(path, JSON.stringify(runtime, null, 2) + '\n');
}
