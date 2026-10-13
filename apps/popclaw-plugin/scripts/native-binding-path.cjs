// Shared by bundled TypeScript and the vendored better-sqlite3 loader.
// This module reads package metadata and addon bytes; it never loads an addon,
// opens a database, installs a dependency, or starts a compiler.
'use strict';
const { readFileSync, statSync, lstatSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');

const MARKER = 'POPCLAW-PLATFORM-DEPS.json';
const PLATFORMS = [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64'], ['win32', 'x64']];
const ABI = {24: '137', 26: '147'};
const bindingName = (platform, arch, major) => `better_sqlite3-${platform}-${arch}-node${major}.node`;
const packageName = (platform, arch) => `popclaw-native-sqlite-${platform}-${arch}`;
function bindingExists(candidate) {
  try { statSync(candidate); return true; }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}
function invalid(message, code = 'POPCLAW_PLATFORM_DEPENDENCY_INVALID') {
  const error = new Error(`PopClaw ClawHub native dependency: ${message}. Reinstall this exact version with optional dependencies enabled, or use the complete npm/GitHub package.`);
  error.code = code;
  return error;
}
function json(path) {
  const bytes = readFileSync(path, 'utf8');
  try { return JSON.parse(bytes); } catch { throw invalid(`invalid JSON at ${path}`); }
}
function regular(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw invalid(`unexpected file type at ${path}`);
  return stat;
}
/** Validate the complete manifest, then the actual files for this platform.
 * @param {string} root better-sqlite3 package root
 */
function platformBindings(root) {
  const markerPath = join(root, MARKER);
  if (!bindingExists(markerPath)) return null;
  regular(markerPath);
  const marker = json(markerPath);
  if (marker.format !== 1 || marker.distribution !== 'clawhub-platform-dependencies'
    || typeof marker.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(marker.version)
    || !Array.isArray(marker.packages) || marker.packages.length !== PLATFORMS.length) throw invalid('unrecognized platform manifest');
  const nativeManifest = json(join(root, 'package.json'));
  for (const [platform, arch] of PLATFORMS) {
    const rows = marker.packages.filter(row => row.platform === platform && row.arch === arch);
    const row = rows[0];
    if (rows.length !== 1 || row.name !== packageName(platform, arch) || row.version !== marker.version
      || (platform === 'linux' ? row.libc !== 'glibc' : row.libc !== undefined)
      || nativeManifest.optionalDependencies?.[row.name] !== row.version
      || !Array.isArray(row.bindings) || row.bindings.length !== 2) throw invalid('inconsistent platform dependency declaration');
    for (const major of [24, 26]) {
      const bindings = row.bindings.filter(binding => binding.nodeMajor === major);
      const binding = bindings[0];
      if (bindings.length !== 1 || binding.abi !== ABI[major] || binding.file !== bindingName(platform, arch, major)
        || !/^[0-9a-f]{64}$/.test(binding.sha256) || !Number.isSafeInteger(binding.size) || binding.size < 500000) throw invalid('inconsistent binding declaration');
    }
  }
  const entry = marker.packages.find(row => row.platform === process.platform && row.arch === process.arch);
  if (!entry || (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime)) {
    throw invalid(`unsupported platform ${process.platform}/${process.arch}`, 'POPCLAW_PLATFORM_UNSUPPORTED');
  }
  let manifestPath;
  try { manifestPath = createRequire(join(root, 'package.json')).resolve(`${entry.name}/package.json`); }
  catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    throw invalid(`missing ${entry.name}@${entry.version}`, 'POPCLAW_PLATFORM_DEPENDENCY_MISSING');
  }
  regular(manifestPath);
  const dependency = json(manifestPath);
  if (dependency.name !== entry.name || dependency.version !== entry.version
    || JSON.stringify(dependency.os) !== JSON.stringify([entry.platform])
    || JSON.stringify(dependency.cpu) !== JSON.stringify([entry.arch])
    || (entry.libc ? JSON.stringify(dependency.libc) !== JSON.stringify([entry.libc]) : dependency.libc !== undefined)) throw invalid(`incorrect package metadata for ${entry.name}`);
  const dependencyRoot = join(manifestPath, '..');
  try {
    regular(join(dependencyRoot, 'build'), true); regular(join(dependencyRoot, 'build/Release'), true);
    const bindings = entry.bindings.map(binding => {
      const path = join(dependencyRoot, 'build/Release', binding.file);
      const stat = regular(path);
      if (stat.size !== binding.size || createHash('sha256').update(readFileSync(path)).digest('hex') !== binding.sha256) throw invalid(`incorrect bytes for ${entry.name}/${binding.file}`);
      return {...binding, path};
    });
    return {marker, entry, bindings};
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw invalid(`incomplete files for ${entry.name}`);
    throw error;
  }
}
/** @param {string} root @returns {string | undefined} */
function resolveNativeBinding(root) {
  const platform = platformBindings(root);
  const major = Number(process.versions.node.split('.')[0]);
  if (platform) {
    const binding = platform.bindings.find(binding => binding.nodeMajor === major);
    // A future Node ABI may use the existing source rebuild path, but only
    // after the declared platform dependency has passed integrity checks.
    if (binding) return binding.path;
  }
  const release = join(root, 'build/Release');
  for (const name of [bindingName(process.platform, process.arch, major), `better_sqlite3-node${major}.node`]) {
    const candidate = join(release, name);
    if (bindingExists(candidate)) return candidate;
  }
  return undefined;
}
module.exports = {MARKER, PLATFORMS, ABI, bindingName, packageName, bindingExists, platformBindings, resolveNativeBinding};
