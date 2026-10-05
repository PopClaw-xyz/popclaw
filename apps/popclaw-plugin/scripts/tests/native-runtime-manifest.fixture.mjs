import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deriveNativeRuntimeManifest } from '../native-runtime-manifest.mjs';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
let host = dirname(require.resolve('openclaw/plugin-sdk/plugin-entry'));
while (!existsSync(join(host, 'package.json')) || JSON.parse(readFileSync(join(host, 'package.json'))).name !== 'openclaw') host = dirname(host);
assert.equal(JSON.parse(readFileSync(join(host, 'package.json'))).version, '2026.9.8');
const module = readdirSync(join(host, 'dist')).find(name => /^plugin-generation-artifact-.*\.mjs$/.test(name));
const { t: capture } = await import(pathToFileURL(join(host, 'dist', module)).href);

test('official 9.8 capture refuses the upstream installer graph, then accepts and loads the runtime derivative', async () => {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-native-98-'));
  let artifact;
  try {
    cpSync(join(plugin, 'dist/native-deps'), join(root, 'native-deps'), {recursive: true});
    const native = join(root, 'native-deps/better-sqlite3');
    const provenance = JSON.parse(readFileSync(join(native, 'POPCLAW-RUNTIME-MANIFEST.json')));
    const license = readFileSync(join(native, 'LICENSE'));
    writeFileSync(join(native, 'package.json'), JSON.stringify(provenance.upstreamManifest, null, 2) + '\n');
    // The host materializes each selected native package and captures that
    // package's declared dependency graph before allowing its module load.
    assert.throws(() => capture(native, undefined, work => work()), /Plugin dependency prebuild-install is missing/);
    const original = readFileSync(join(native, 'package.json'));
    deriveNativeRuntimeManifest(native);
    const runtime = JSON.parse(readFileSync(join(native, 'package.json')));
    const derived = JSON.parse(readFileSync(join(native, 'POPCLAW-RUNTIME-MANIFEST.json')));
    assert.deepEqual(runtime.dependencies, {bindings: provenance.upstreamManifest.dependencies.bindings});
    assert.equal(runtime.scripts, undefined);
    assert.equal(runtime.name, provenance.upstreamManifest.name);
    assert.equal(runtime.version, provenance.upstreamManifest.version);
    assert.equal(derived.upstreamManifestSha256, createHash('sha256').update(original).digest('hex'));
    assert.deepEqual(readFileSync(join(native, 'LICENSE')), license);
    artifact = capture(native, undefined, work => work());
    artifact.assertSourceCurrent();
    // A real SQLite open/write/read through the same shipped runtime closure.
    const Database = require(join(native, 'lib/index.js'));
    const db = new Database(':memory:');
    try {db.exec('CREATE TABLE proof(value TEXT)'); db.prepare('INSERT INTO proof VALUES(?)').run('9.8'); assert.equal(db.prepare('SELECT value FROM proof').get().value, '9.8');}
    finally {db.close();}
    console.log(JSON.stringify({host: '2026.9.8', capture: 'accepted', sourceDigest: artifact.sourceDigest, sqlite: 'write-read-passed'}));
  } finally {await artifact?.disposeAsync(); rmSync(root, {recursive: true, force: true});}
});

test('a changed native dependency graph requires another explicit build review', () => {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-native-metadata-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'better-sqlite3', version: '12.11.1', dependencies: {bindings: '^1.5.0', newRuntimeDependency: '1'}}));
    assert.throws(() => deriveNativeRuntimeManifest(root), /Unreviewed native package metadata/);
  } finally {rmSync(root, {recursive: true, force: true});}
});
