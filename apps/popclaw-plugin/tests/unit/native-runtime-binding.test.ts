import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deriveNativeRuntimeManifest } from '../../scripts/native-runtime-manifest.mjs';

const require = createRequire(import.meta.url);
const upstream = dirname(dirname(require.resolve('better-sqlite3')));
const upstreamRequire = createRequire(join(upstream, 'package.json'));
const binding = join(upstream, 'build/Release/better_sqlite3.node');
const named = `better_sqlite3-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}.node`;
const legacy = `better_sqlite3-node${process.versions.node.split('.')[0]}.node`;
let scratch: string;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture(files: string[] = [named]) {
  const root = mkdtempSync(join(scratch, 'native-'));
  cpSync(upstream, root, {recursive: true, dereference: true, filter: source => {
    const rel = source.slice(upstream.length);
    return !/^[/\\](node_modules|build)([/\\]|$)/.test(rel);
  }});
  for (const name of ['bindings', 'file-uri-to-path']) {
    const entry = upstreamRequire.resolve(name);
    cpSync(dirname(entry), join(root, 'node_modules', name), {recursive: true, dereference: true});
  }
  mkdirSync(join(root, 'build/Release'), {recursive: true});
  for (const name of files) cpSync(binding, join(root, 'build/Release', name));
  return root;
}
function probe(root: string, explicit?: string, addonObject = false) {
  return spawnSync(process.execPath, ['-e', `
    const Database = require(process.argv[1]);
    try {
      const db = new Database(':memory:', process.argv[2] ? {nativeBinding: process.argv[3] === 'addon' ? require(process.argv[2]) : process.argv[2]} : undefined);
      try { db.exec('CREATE TABLE proof(value TEXT)'); db.prepare('INSERT INTO proof VALUES(?)').run('same-driver');
        const row = db.prepare('SELECT value FROM proof').get();
        if (row.value !== 'same-driver') throw new Error('incorrect result');
        console.log(JSON.stringify({ok:true,value:row.value}));
      } finally { db.close(); }
    } catch (error) { console.error(JSON.stringify({code:error.code,message:error.message})); process.exitCode=1; }
  `, root, ...(explicit ? [explicit, addonObject ? 'addon' : 'path'] : [])], {encoding: 'utf8', timeout: 10_000});
}
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'popclaw-native-loader-')); });
afterAll(() => { rmSync(scratch, {recursive: true, force: true}); });

describe('shipped native loader without a duplicate default binary', () => {
  it.each([named, legacy, 'better_sqlite3.node'])('loads a real database through %s', file => {
    const root = fixture([file]);
    deriveNativeRuntimeManifest(root);
    const result = probe(root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ok: true, value: 'same-driver'});
    if (file !== 'better_sqlite3.node') expect(existsSync(join(root, 'build/Release/better_sqlite3.node'))).toBe(false);
  });

  it('preserves an explicit binding override instead of selecting the packaged default', () => {
    const root = fixture(['explicit.node']);
    writeFileSync(join(root, 'build/Release', named), 'invalid addon');
    deriveNativeRuntimeManifest(root);
    expect(probe(root, join(root, 'build/Release/explicit.node')).status).toBe(0);
    expect(probe(root, join(root, 'build/Release/explicit.node'), true).status).toBe(0);
    const invalid = probe(root);
    expect(invalid.status).not.toBe(0);
    expect(JSON.parse(invalid.stderr).code).not.toBe('POPCLAW_NATIVE_BINDING_MISSING');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each(['named', 'upstream-default'])('preserves a real access error in %s lookup', kind => {
    const root = fixture([]);
    const directory = join(root, 'build', kind === 'named' ? 'Release' : 'Debug');
    mkdirSync(directory, {recursive: true});
    const candidate = join(directory, kind === 'named' ? named : 'better_sqlite3.node');
    cpSync(binding, candidate);
    deriveNativeRuntimeManifest(root);
    chmodSync(directory, 0);
    try {
      expect(() => statSync(candidate)).toThrowError(expect.objectContaining({code: 'EACCES'}));
      const result = probe(root);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr).code).toBe('EACCES');
    } finally {chmodSync(directory, 0o755);}
  });

  it.skipIf(process.platform === 'win32')('keeps compiler diagnostics off the caller protocol stdout', () => {
    const root = fixture([]);
    deriveNativeRuntimeManifest(root);
    const bin = join(root, 'test-bin');
    mkdirSync(bin);
    const npx = join(bin, 'npx');
    writeFileSync(npx, `#!${process.execPath}
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.deepEqual(process.argv.slice(2), ['--yes', 'node-gyp', 'rebuild', '--release']);
      fs.copyFileSync(process.env.TEST_COMPILED_BINDING, 'build/Release/better_sqlite3.node');
      console.log('CXX(target) compiler-output-control');
      console.error('compiler-stderr-control');
    `);
    chmodSync(npx, 0o755);
    const source = fileURLToPath(new URL('../../src/host/local-host-db.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      import { pathToFileURL } from 'node:url';
      registerHooks({resolve(specifier, context, next) {
        return next(specifier === 'better-sqlite3' ? process.env.TEST_NATIVE_MAIN : specifier, context);
      }});
      const { LocalHostDb } = await import(pathToFileURL(process.env.TEST_LOCAL_DB_SOURCE));
      const db = new LocalHostDb(':memory:');
      try { console.log(JSON.stringify(db.queryOne('SELECT 42 AS value'))); }
      finally { db.close(); }
    `], {encoding: 'utf8', timeout: 10_000, env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_COMPILED_BINDING: binding,
      TEST_NATIVE_MAIN: join(root, 'lib/index.js'), TEST_LOCAL_DB_SOURCE: source,
    }});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"value":42}\n');
    expect(result.stderr).toContain('CXX(target) compiler-output-control');
    expect(result.stderr).toContain('compiler-stderr-control');
    expect(existsSync(join(root, 'build/Release', named))).toBe(true);
  });

  it('reports a missing binding with the scoped rebuild code', () => {
    const root = fixture([]);
    deriveNativeRuntimeManifest(root);
    const result = probe(root);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe('POPCLAW_NATIVE_BINDING_MISSING');
  });

  it('records and verifies the runtime loader derivation while leaving upstream source and license intact', () => {
    const root = fixture();
    const original = readFileSync(join(root, 'lib/database.js'));
    const sqlite = readFileSync(join(root, 'deps/sqlite3/sqlite3.c'));
    const license = readFileSync(join(root, 'LICENSE'));
    deriveNativeRuntimeManifest(root);
    const record = JSON.parse(readFileSync(join(root, 'POPCLAW-RUNTIME-MANIFEST.json'), 'utf8'));
    expect(record.runtimeLoader.upstreamSha256).toBe(sha(original));
    expect(record.runtimeLoader.derivedSha256).toBe(sha(readFileSync(join(root, 'lib/database.js'))));
    expect(record.runtimeLoader.helperSha256).toBe(sha(readFileSync(join(root, 'lib/popclaw-native-binding.cjs'))));
    expect(sha(readFileSync(join(root, 'deps/sqlite3/sqlite3.c')))).toBe(sha(sqlite));
    expect(readFileSync(join(root, 'LICENSE'))).toEqual(license);
    // Re-derivation must begin with the reviewed upstream source, not a relaxed pin.
    writeFileSync(join(root, 'package.json'), JSON.stringify(record.upstreamManifest));
    expect(() => deriveNativeRuntimeManifest(root)).toThrow(/Unreviewed native.*loader/);
    writeFileSync(join(root, 'lib/database.js'), original);
    deriveNativeRuntimeManifest(root);
    expect(probe(root).status).toBe(0);
  });

  it('refuses an unreviewed upstream loader before changing package files', () => {
    const root = fixture();
    const manifest = readFileSync(join(root, 'package.json'));
    writeFileSync(join(root, 'lib/database.js'), readFileSync(join(root, 'lib/database.js'), 'utf8') + '\n// changed upstream\n');
    expect(() => deriveNativeRuntimeManifest(root)).toThrow(/Unreviewed native.*loader/);
    expect(readFileSync(join(root, 'package.json'))).toEqual(manifest);
  });
});


// These fixtures use real SQLite bytes. Unselected platforms are never loaded.
function platformFixture() {
  const root = fixture([]);
  deriveNativeRuntimeManifest(root);
  const version = '0.1.4';
  const packages = [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64'], ['win32', 'x64']].map(([platform, arch]) => ({
    name: `popclaw-native-sqlite-${platform}-${arch}`, version, platform, arch,
    ...(platform === 'linux' ? {libc: 'glibc'} : {}),
    bindings: [24, 26].map(nodeMajor => ({nodeMajor, abi: nodeMajor === 24 ? '137' : '147',
      file: `better_sqlite3-${platform}-${arch}-node${nodeMajor}.node`, sha256: sha(readFileSync(binding)), size: statSync(binding).size})),
  }));
  const selected = packages.find(row => row.platform === process.platform && row.arch === process.arch)!;
  const dependencyRoot = join(root, 'node_modules', selected.name);
  mkdirSync(join(dependencyRoot, 'build/Release'), {recursive: true});
  writeFileSync(join(dependencyRoot, 'package.json'), JSON.stringify({name: selected.name, version,
    os: [selected.platform], cpu: [selected.arch], ...(selected.libc ? {libc: [selected.libc]} : {})}));
  for (const row of selected.bindings) cpSync(binding, join(dependencyRoot, 'build/Release', row.file));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.optionalDependencies = Object.fromEntries(packages.map(row => [row.name, row.version]));
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'POPCLAW-PLATFORM-DEPS.json'), JSON.stringify({format: 1,
    distribution: 'clawhub-platform-dependencies', version, packages}));
  return {root, dependencyRoot, selected};
}

describe('ClawHub platform dependencies', () => {
  it('loads a real database from the selected optional package with no local addon', () => {
    const {root} = platformFixture();
    const result = probe(root);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ok: true, value: 'same-driver'});
  });
  it('accepts a captured addon symlink only when its final regular-file bytes match the pin', () => {
    const {root, dependencyRoot, selected} = platformFixture();
    const row = selected.bindings.find(row => row.nodeMajor === Number(process.versions.node.split('.')[0]))!;
    const target = join(dependencyRoot, 'build/Release', row.file);
    rmSync(target); symlinkSync(binding, target);
    expect(probe(root).status).toBe(0);
    rmSync(target);
    const changed = join(root, 'changed.node'); writeFileSync(changed, 'wrong bytes'); symlinkSync(changed, target);
    const rejected = probe(root); expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stderr).code).toBe('POPCLAW_PLATFORM_DEPENDENCY_INVALID');
  });
  it.each(['missing', 'version', 'current-bytes', 'other-abi-bytes', 'metadata'])('rejects %s without falling through to the compiler path', kind => {
    const {root, dependencyRoot, selected} = platformFixture();
    if (kind === 'missing') rmSync(dependencyRoot, {recursive: true});
    if (kind === 'version' || kind === 'metadata') {
      const path = join(dependencyRoot, 'package.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (kind === 'version') manifest.version = '0.0.0'; else manifest.cpu = ['invalid'];
      writeFileSync(path, JSON.stringify(manifest));
    }
    if (kind.includes('bytes')) {
      const row = selected.bindings.find(row => (row.nodeMajor === Number(process.versions.node.split('.')[0])) === (kind === 'current-bytes'))!;
      writeFileSync(join(dependencyRoot, 'build/Release', row.file), 'corrupt');
    }
    const result = probe(root);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe(kind === 'missing' ? 'POPCLAW_PLATFORM_DEPENDENCY_MISSING' : 'POPCLAW_PLATFORM_DEPENDENCY_INVALID');
  });
  it('preflights LocalHostDb before opening a database, and supports a read-only reopen', () => {
    const {root} = platformFixture();
    const source = fileURLToPath(new URL('../../src/host/local-host-db.ts', import.meta.url));
    const bin = join(root, 'blocked-compiler'); mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho unexpected-compiler >&2\nexit 97\n'); chmodSync(join(bin, 'npx'), 0o755);
    const result = spawnSync(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      import { pathToFileURL } from 'node:url';
      registerHooks({resolve(specifier, context, next) { return next(specifier === 'better-sqlite3' ? process.env.TEST_NATIVE_MAIN : specifier, context); }});
      const { LocalHostDb } = await import(pathToFileURL(process.env.TEST_LOCAL_DB_SOURCE));
      const db = new LocalHostDb(process.env.TEST_DB);
      db.execute('CREATE TABLE proof(value TEXT)'); db.execute("INSERT INTO proof VALUES('platform')"); db.close();
      const read = new LocalHostDb(process.env.TEST_DB, {readOnly:true});
      console.log(JSON.stringify(read.queryOne('SELECT value FROM proof'))); read.close();
    `], {encoding:'utf8', timeout: 10_000, env: {...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_NATIVE_MAIN: join(root, 'lib/index.js'), TEST_LOCAL_DB_SOURCE: source, TEST_DB: join(root, 'proof.db')}});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"value":"platform"}\n');
  });
});


describe('pure native path preflight', () => {
  it.each(['valid', 'missing'])('handles %s without opening SQLite or allowing a dependency error to trigger compilation', kind => {
    const {root, dependencyRoot} = platformFixture();
    if (kind === 'missing') rmSync(dependencyRoot, {recursive:true});
    const source = fileURLToPath(new URL('../../src/host/local-host-db.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', `
      import { registerHooks, createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const require = createRequire(import.meta.url);
      registerHooks({resolve(specifier, context, next) { return next(specifier === 'better-sqlite3' ? process.env.TEST_NATIVE_MAIN : specifier, context); }});
      try {
        await import(pathToFileURL(process.env.TEST_LOCAL_DB_SOURCE));
        if (Object.keys(require.cache).some(path => path.endsWith('.node'))) throw new Error('preflight loaded an addon');
        console.log('preflight-only');
      } catch (error) { console.error(JSON.stringify({code:error.code})); process.exitCode=1; }
    `], {encoding:'utf8', timeout:10_000, env:{...process.env, TEST_NATIVE_MAIN:join(root, 'lib/index.js'), TEST_LOCAL_DB_SOURCE:source}});
    expect(result.status, result.stderr).toBe(kind === 'valid' ? 0 : 1);
    if (kind === 'valid') expect(result.stdout).toBe('preflight-only\n');
    else expect(JSON.parse(result.stderr).code).toBe('POPCLAW_PLATFORM_DEPENDENCY_MISSING');
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves dependency access errors', () => {
    const {root, dependencyRoot} = platformFixture();
    chmodSync(join(dependencyRoot, 'build'), 0);
    try {const result = probe(root); expect(result.status).toBe(1); expect(JSON.parse(result.stderr).code).toBe('EACCES');}
    finally {chmodSync(join(dependencyRoot, 'build'), 0o755);}
  });
});
