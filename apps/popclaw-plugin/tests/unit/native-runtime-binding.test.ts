import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
