import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { copyRuntime, probeNative, runtimePlan } from '../../src/setup/runtime.js';
import { deriveNativeRuntimeManifest } from '../../scripts/native-runtime-manifest.mjs';

const require = createRequire(import.meta.url);
const upstream = dirname(dirname(require.resolve('better-sqlite3')));
const upstreamRequire = createRequire(join(upstream, 'package.json'));
const addon = join(upstream, 'build/Release/better_sqlite3.node');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const cleanups: string[] = [];
afterEach(() => {for (const path of cleanups.splice(0)) rmSync(path, {recursive:true, force:true});});
function fixture() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'popclaw-platform-copy-')); cleanups.push(base);
  const source = join(base, 'package'); const native = join(source, 'dist/native-deps/better-sqlite3');
  mkdirSync(join(source, 'dist/bundled'), {recursive:true}); mkdirSync(join(source, 'migrations'));
  writeFileSync(join(source, 'LICENSE'), 'fixture'); writeFileSync(join(source, 'dist/bundled/mcp.js'), '');
  writeFileSync(join(source, 'dist/bundled/mcp-hook.js'), ''); writeFileSync(join(source, 'migrations/proof.sql'), '-- fixture');
  cpSync(upstream, native, {recursive:true, dereference:true, filter: path => !/^[/\\](node_modules|build)([/\\]|$)/.test(path.slice(upstream.length))});
  for (const name of ['bindings', 'file-uri-to-path']) cpSync(dirname(upstreamRequire.resolve(name)), join(native, 'node_modules', name), {recursive:true, dereference:true});
  deriveNativeRuntimeManifest(native);
  const version = '0.1.4';
  const packages = [['darwin','arm64'],['darwin','x64'],['linux','arm64'],['linux','x64'],['win32','x64']].map(([platform,arch]) => ({
    name:`popclaw-native-sqlite-${platform}-${arch}`,version,platform,arch,...(platform==='linux'?{libc:'glibc'}:{}),
    bindings:[24,26].map(nodeMajor=>({nodeMajor,abi:nodeMajor===24?'137':'147',file:`better_sqlite3-${platform}-${arch}-node${nodeMajor}.node`,sha256:sha(readFileSync(addon)),size:statSync(addon).size})),
  }));
  const optionalDependencies=Object.fromEntries(packages.map(row=>[row.name,row.version]));
  const marker = {format:1,distribution:'clawhub-platform-dependencies',version,packages};
  writeFileSync(join(native,'POPCLAW-PLATFORM-DEPS.json'),JSON.stringify(marker));
  writeFileSync(join(native,'package.json'),JSON.stringify({...JSON.parse(readFileSync(join(native,'package.json'),'utf8')),optionalDependencies}));
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'popclaw-clawhub',version,type:'module',optionalDependencies,openclaw:{install:{requiredPlatformPackages:Object.keys(optionalDependencies)}}}));
  const selected=packages.find(row=>row.platform===process.platform&&row.arch===process.arch)!;
  const dependency=join(source,'node_modules',selected.name);
  mkdirSync(join(dependency,'build/Release'),{recursive:true});
  writeFileSync(join(dependency,'package.json'),JSON.stringify({name:selected.name,version,os:[selected.platform],cpu:[selected.arch],...(selected.libc?{libc:[selected.libc]}:{})}));
  for(const row of selected.bindings)cpSync(addon,join(dependency,'build/Release',row.file));
  // The host can add an SDK peer symlink. It must never enter the stable copy.
  symlinkSync(upstream,join(source,'node_modules','openclaw'));
  writeFileSync(join(source,'package-lock.json'),'{"hostGenerated":true}');
  return {base,source,native,dependency,selected,marker};
}

describe('ClawHub portable setup runtime',()=>{
  it('materializes both verified ABI files and runs after the source installation is removed',()=>{
    const f=fixture();
    probeNative(f.source,f.base);
    const plan=runtimePlan(f.source,join(f.base,'stable'));
    const dest=copyRuntime(plan);
    expect(copyRuntime(plan)).toBe(dest);
    const repeated = runtimePlan(dest, join(f.base, 'stable'));
    expect(repeated.digest).toBe(plan.digest);
    expect(repeated.target).toBe(dest);
    expect(existsSync(join(dest,'node_modules'))).toBe(false);
    expect(existsSync(join(dest,'package-lock.json'))).toBe(false);
    const native=join(dest,'dist/native-deps/better-sqlite3');
    expect(existsSync(join(native,'POPCLAW-PLATFORM-DEPS.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dest,'package.json'),'utf8')).optionalDependencies).toBeUndefined();
    expect(JSON.parse(readFileSync(join(native,'package.json'),'utf8')).optionalDependencies).toBeUndefined();
    for(const row of f.selected.bindings){
      const relative=`dist/native-deps/better-sqlite3/build/Release/${row.file}`;
      expect(plan.files[relative]).toBe(row.sha256);
      expect(sha(readFileSync(join(dest,relative)))).toBe(row.sha256);
    }
    rmSync(f.source,{recursive:true});
    probeNative(dest,f.base);
  });
  it('refuses source changes after planning and hashes both materialized ABI bytes',()=>{
    const f=fixture();
    const first=runtimePlan(f.source,join(f.base,'stable'));
    const row=f.selected.bindings.find(row=>row.nodeMajor!==Number(process.versions.node.split('.')[0]))!;
    const file=join(f.dependency,'build/Release',row.file);
    const bytes=Buffer.concat([readFileSync(file),Buffer.from('changed bytes')]);
    writeFileSync(file,bytes); row.sha256=sha(bytes); row.size=bytes.length;
    writeFileSync(join(f.native,'POPCLAW-PLATFORM-DEPS.json'),JSON.stringify(f.marker));
    expect(()=>copyRuntime(first)).toThrow(/changed after planning/);
    const next=runtimePlan(f.source,join(f.base,'stable'));
    expect(next.digest).not.toBe(first.digest);
    expect(next.files[`dist/native-deps/better-sqlite3/build/Release/${row.file}`]).toBe(sha(bytes));
  });
  it('refuses missing or altered dependencies before creating a stable target',()=>{
    const f=fixture();
    const file=join(f.dependency,'build/Release',f.selected.bindings[0]!.file);
    writeFileSync(file,'bad');
    expect(()=>runtimePlan(f.source,join(f.base,'stable'))).toThrow(/incorrect bytes/);
    expect(existsSync(join(f.base,'stable'))).toBe(false);
  });
  it('continues to reject arbitrary source symlinks and full-package node_modules',()=>{
    const f=fixture();
    symlinkSync(join(f.source,'LICENSE'),join(f.source,'unrelated-link'));
    expect(()=>runtimePlan(f.source,join(f.base,'stable'))).toThrow(/links/);
    rmSync(join(f.source,'unrelated-link'));
    rmSync(join(f.native,'POPCLAW-PLATFORM-DEPS.json'));
    expect(()=>runtimePlan(f.source,join(f.base,'stable'))).toThrow(/complete extracted/);
  });
});
