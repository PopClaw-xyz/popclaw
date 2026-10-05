import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = process.env.INSTALLER_UNDER_TEST || fileURLToPath(new URL('../install-popclaw.sh', import.meta.url));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(fn) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'popclaw-installer-fixture-')));
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  const state = path.join(home, '.openclaw'); fs.mkdirSync(state);
  const config = path.join(state, 'openclaw.json'); fs.writeFileSync(config, '{}');
  const tgz = path.join(base, 'popclaw-plugin-0.1.0+20261003-abcdef01.tgz');
  fs.writeFileSync(tgz, 'synthetic archive; the native stub does not unpack');
  const cli = path.join(bin, 'openclaw');
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const a=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({argv:a,node:process.execPath,state:process.env.OPENCLAW_STATE_DIR,config:process.env.OPENCLAW_CONFIG_PATH,profile:process.env.OPENCLAW_PROFILE,root:process.env.POPCLAW_DATA_ROOT})+'\\n');
const stage=a.includes('--help')?'help':a[0]==='plugins'?'install':'config'; if(process.env.FIXTURE_MUTATION===stage) fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({agents:{defaults:{workspace:'/unreviewed'}},plugins:{entries:{unreviewed:{enabled:true}}}}));
if(a.includes('--help')) { console.log(process.env.FIXTURE_CAP === '0' ? 'old help' : '--accept-capabilities'); process.exit(Number(process.env.FIXTURE_HELP_RC || 0)); }
console.log('SECRET_TOKEN unrelated message'); console.error('SECRET_STDERR private chat');
if(a[0]==='plugins' && a[1]==='install') {
  const marker=process.env.FIXTURE_APPLICATION ?? 'Saved for the next Gateway start.';
  (process.env.FIXTURE_APPLICATION_STDERR ? console.error : console.log)(marker);
  if(process.env.FIXTURE_SLEEP) setTimeout(()=>process.exit(0), 10000); else process.exit(Number(process.env.FIXTURE_INSTALL_RC || 0));
} else if(a[0]==='config' && a[1]==='set') { if(!process.env.FIXTURE_MUTATION && !process.env.FIXTURE_CONFIG_RC) { const c=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH)); c.plugins ??= {}; c.plugins.entries ??= {}; c.plugins.entries.popclaw ??= {}; c.plugins.entries.popclaw.hooks ??= {}; c.plugins.entries.popclaw.hooks.allowConversationAccess=true; fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(c)); } process.exit(Number(process.env.FIXTURE_CONFIG_RC || 0)); } else process.exit(91);
`);
  fs.chmodSync(cli, 0o700);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  // These stubs are never real managers/loggers/process scanners. Any call is a failure.
  for (const name of ['ps','cp','launchctl','systemctl','docker','ssh','tail','tee']) {
    const p=path.join(bin,name); fs.writeFileSync(p,'#!/bin/sh\nprintf "FORBIDDEN %s\\n" "$0" >> "$FIXTURE_CALLS"\nexit 91\n'); fs.chmodSync(p,0o700);
  }
  const calls=path.join(base,'calls');
  const receipt=path.join(base,'receipt.json');
  const env={ PATH:`${bin}:/usr/bin:/bin`, HOME:home, TMPDIR:base, FIXTURE_CALLS:calls };
  const f={base,home,bin,state,config,tgz,cli,calls,receipt,env};
  f.run=(args=[], extra={})=>spawnSync('/bin/sh',[installer,...args,tgz],{env:{...env,...extra},encoding:'utf8',timeout:15000});
  f.readCalls=()=>fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  f.maintenance=(options={})=>{
    f.state=options.state||f.state;
    f.config=path.join(f.state,'openclaw.json');
    fs.mkdirSync(f.state,{recursive:true}); fs.writeFileSync(f.config,'{}');
    f.root=options.root||path.join(f.state,'popclaw'); fs.mkdirSync(f.root,{recursive:true});
    fs.writeFileSync(path.join(f.root,'preserved'),'existing data');
    const now=Date.now();
    f.record={ schema:'popclaw-install-maintenance/v1', target:{stateDir:f.state,configPath:f.config,dataRoot:f.root,profile:options.profile||'default',node:fs.realpathSync(process.execPath),openclawCli:f.cli,tarball:f.tgz}, hashes:{tarball:hash(fs.readFileSync(f.tgz)),node:hash(fs.readFileSync(process.execPath)),openclawCli:hash(fs.readFileSync(f.cli)),config:hash(fs.readFileSync(f.config))}, window:{validFrom:new Date(now-1000).toISOString(),validUntil:new Date(now+300000).toISOString(),callersStopped:true,launchersFenced:true,stopEvidenceSha256:'1'.repeat(64)}, backup:{complete:true,verified:true,id:'synthetic-cold-backup',manifestSha256:'2'.repeat(64),verificationReceiptSha256:'3'.repeat(64),memberClasses:['data-root','legacy-data-if-applicable','plugin-code','config-launchers-receipts','host-state-auth']}, native:{noBootstrap:'reviewed',evidenceSha256:'4'.repeat(64),commands:['plugins install --help','plugins install','config set']} };
    f.recordPath=path.join(base,'maintenance.json');
    f.saveRecord=()=>{fs.writeFileSync(f.recordPath,JSON.stringify(f.record),{mode:0o600});}; f.saveRecord();
    f.args=['--mode','maintenance','--state-dir',f.state,'--config-path',f.config,'--data-root',f.root,'--profile',f.record.target.profile,'--node',process.execPath,'--openclaw-cli',f.cli,'--maintenance-record',f.recordPath,'--receipt',receipt];
  };
  try { fn(f); } finally { fs.rmSync(base,{recursive:true,force:true}); }
}
function success(f,r) {
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(r.stdout.includes('SECRET'),false); assert.equal(r.stderr.includes('SECRET'),false);
  const calls=f.readCalls(); assert.equal(calls.length,3); assert.deepEqual(calls.map(x=>x.argv.slice(0,2)),[['plugins','install'],['plugins','install'],['config','set']]);
  for(const c of calls) {assert.equal(c.state,f.state); assert.equal(c.config,f.config); assert.equal(c.root,f.root||path.join(f.state,'popclaw'));}
  const receipt=JSON.parse(fs.readFileSync(f.receipt,'utf8'));
  assert.equal(receipt.status,'installed-start-deferred'); assert.equal(receipt.runtimeVerified,false);
  assert.equal(receipt.schema,'popclaw-install-receipt/v2'); assert.equal(receipt.startDeferred,true);
  assert.deepEqual(receipt.installReported,{state:'deferred'});
  assert.equal(receipt.commands[1].exitCode,0); assert.equal(fs.statSync(f.receipt).mode&0o777,0o600);
  assert.equal(fs.readFileSync(f.receipt,'utf8').includes('SECRET'),false);
}
function refused(f,r) { assert.notEqual(r.status,0,r.stdout); assert.equal(f.readCalls().length,0); assert.equal(fs.existsSync(f.receipt),false); }

test('one-argument fresh install uses only the default selected state',()=>fixture(f=>{
  const r=f.run(); assert.equal(r.status,0,r.stdout+r.stderr); const calls=f.readCalls(); assert.equal(calls.length,3); assert.equal(calls[1].state,f.state); assert.equal(calls[1].root,path.join(f.state,'popclaw')); assert.equal(r.stdout.includes('SECRET'),false);
}));
test('fresh install with explicit receipt retains consent and hook declaration',()=>fixture(f=>success(f,f.run(['--receipt',f.receipt]))));
test('records native live application without adding a reload or claiming runtime verification',()=>fixture(f=>{
  const r=f.run(['--receipt',f.receipt],{FIXTURE_APPLICATION:'Applied in Gateway generation 17.'});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const receipt=JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(receipt.schema,'popclaw-install-receipt/v2');
  assert.deepEqual(receipt.installReported,{state:'applied',generation:17});
  assert.equal(receipt.startDeferred,false); assert.equal(receipt.runtimeVerified,false);
  assert.equal(receipt.status,'installed-applied-runtime-unverified'); assert.equal(f.readCalls().length,3);
}));
for(const [name,extra] of [
  ['missing',{FIXTURE_APPLICATION:''}],
  ['ambiguous',{FIXTURE_APPLICATION:'Applied in Gateway generation 17.\nSaved for the next Gateway start.'}],
  ['stderr-only',{FIXTURE_APPLICATION:'Applied in Gateway generation 17.',FIXTURE_APPLICATION_STDERR:'1'}],
  ['unsafe-generation',{FIXTURE_APPLICATION:'Applied in Gateway generation 9007199254740993.'}],
  ['duplicate',{FIXTURE_APPLICATION:'Applied in Gateway generation 17.\nApplied in Gateway generation 17.'}],
]) test(`native ${name} application output remains unknown`,()=>fixture(f=>{
  const r=f.run(['--receipt',f.receipt],extra); assert.equal(r.status,0,r.stdout+r.stderr);
  const receipt=JSON.parse(fs.readFileSync(f.receipt));
  assert.deepEqual(receipt.installReported,{state:'unknown'});
  assert.equal(receipt.startDeferred,null); assert.equal(receipt.runtimeVerified,false);
  assert.equal(receipt.status,'installed-application-unknown'); assert.equal(f.readCalls().length,3);
}));
for (const target of ['default','accept','ken']) test(`maintenance ${target} preserves siblings and defers all startup`,()=>fixture(f=>{
  const protectedDir=path.join(f.state,'popclaw'); fs.mkdirSync(protectedDir); fs.writeFileSync(path.join(protectedDir,'secret'),'protected-root');
  const options=target==='accept'?{state:path.join(f.home,'.openclaw-accept'),profile:'accept'}:target==='ken'?{root:path.join(f.state,'popclaw-ken-fresh-20261002')}:{root:path.join(f.base,'selected-default-root')};
  f.maintenance(options); const before=fs.readFileSync(path.join(protectedDir,'secret'));
  success(f,f.run(f.args)); assert.deepEqual(fs.readFileSync(path.join(protectedDir,'secret')),before); assert.equal(fs.readFileSync(path.join(f.root,'preserved'),'utf8'),'existing data');
}));
test('profile-only fresh selection leaves default sibling alone',()=>fixture(f=>{
  f.state=path.join(f.home,'.openclaw-accept'); fs.mkdirSync(f.state); f.config=path.join(f.state,'openclaw.json'); fs.writeFileSync(f.config,'{}'); success(f,f.run(['--profile','accept','--receipt',f.receipt]));
}));
for(const selector of ['OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','POPCLAW_DATA_ROOT','OPENCLAW_PROFILE']) test(`reject contradictory ${selector} before native execution`,()=>fixture(f=>{ f.maintenance(); refused(f,f.run(f.args,{[selector]:'conflict'})); }));
test('reject empty data-root selector',()=>fixture(f=>refused(f,f.run(['--receipt',f.receipt],{POPCLAW_DATA_ROOT:''}))));
test('existing root cannot use the old one-argument upgrade',()=>fixture(f=>{fs.mkdirSync(path.join(f.state,'popclaw')); refused(f,f.run());}));
for(const defect of ['expired','backup','native','hash','target','missing','hardlink','symlink']) test(`maintenance refuses ${defect} evidence`,()=>fixture(f=>{
  f.maintenance();
  if(defect==='expired') f.record.window.validUntil='2000-01-01T00:00:00Z';
  if(defect==='backup') f.record.backup.complete=false;
  if(defect==='native') f.record.native.noBootstrap='unknown';
  if(defect==='hash') f.record.hashes.config='0'.repeat(64);
  if(defect==='target') f.record.target.dataRoot=path.join(f.base,'other');
  f.saveRecord();
  if(defect==='missing') fs.unlinkSync(f.recordPath);
  if(defect==='hardlink') fs.linkSync(f.recordPath,path.join(f.base,'record-link'));
  if(defect==='symlink') { fs.renameSync(f.recordPath,f.recordPath+'.source'); fs.symlinkSync(f.recordPath+'.source',f.recordPath); }
  refused(f,f.run(f.args));
}));
for(const defect of ['root-link','parent-link','config-link','config-hardlink','overlap','json5','include','env-reference','extension-link','missing-root']) test(`reject ${defect} before CLI and writes`,()=>fixture(f=>{
  f.maintenance();
  if(defect==='root-link') {fs.renameSync(f.root,f.root+'.source'); fs.symlinkSync(f.root+'.source',f.root);}
  if(defect==='parent-link') {const old=f.state; fs.renameSync(old,old+'.source'); fs.symlinkSync(old+'.source',old);}
  if(defect==='config-link') {fs.renameSync(f.config,f.config+'.source'); fs.symlinkSync(f.config+'.source',f.config);}
  if(defect==='config-hardlink') fs.linkSync(f.config,path.join(f.base,'config-link'));
  if(defect==='overlap') { const i=f.args.indexOf('--data-root'); f.args[i+1]=f.state; }
  if(defect==='json5') fs.writeFileSync(f.config,'{ // JSON5\n}');
  if(defect==='include') fs.writeFileSync(f.config,'{"$include":"/forbidden"}');
  if(defect==='env-reference') fs.writeFileSync(f.config,'{"token":"${OTHER_SECRET}"}');
  if(defect==='extension-link') {fs.mkdirSync(path.join(f.state,'extensions')); fs.symlinkSync(f.root,path.join(f.state,'extensions','popclaw'));}
  if(defect==='missing-root') fs.rmSync(f.root,{recursive:true});
  refused(f,f.run(f.args));
}));
test('capability accept fails closed on old native help',()=>fixture(f=>{const r=f.run(['--capabilities','accept','--receipt',f.receipt],{FIXTURE_CAP:'0'}); assert.notEqual(r.status,0); assert.equal(f.readCalls().length,1);}));
test('auto supports native releases without the consent flag',()=>fixture(f=>{success(f,f.run(['--receipt',f.receipt],{FIXTURE_CAP:'0'})); assert.equal(f.readCalls()[1].argv.includes('--accept-capabilities'),false);}));
test('legacy selection refuses omitting supported capability consent',()=>fixture(f=>{const r=f.run(['--capabilities','legacy','--receipt',f.receipt]); assert.notEqual(r.status,0); assert.equal(f.readCalls().length,1);}));
for(const [kind,code] of [['help',19],['install',37],['config',23]]) test(`actual ${kind} failure code is retained without raw secrets`,()=>fixture(f=>{
  const r=f.run(['--receipt',f.receipt],{[`FIXTURE_${kind.toUpperCase()}_RC`]:String(code)}); assert.equal(r.status,code,r.stdout+r.stderr); assert.equal((r.stdout+r.stderr).includes('SECRET'),false); const receipt=JSON.parse(fs.readFileSync(f.receipt)); assert.equal(receipt.commands.at(-1).exitCode,code); assert.equal(receipt.status,'failed');
}));
test('native install timeout is recorded as unknown effects and never restarts',()=>fixture(f=>{
  const r=f.run(['--timeout-seconds','1','--receipt',f.receipt],{FIXTURE_SLEEP:'1'}); assert.equal(r.status,124,r.stdout+r.stderr); const receipt=JSON.parse(fs.readFileSync(f.receipt)); assert.equal(receipt.commands[1].timedOut,true); assert.equal(receipt.effectsUnknown,true); assert.equal(f.readCalls().length,2);
}));
test('existing receipt is never overwritten',()=>fixture(f=>{fs.writeFileSync(f.receipt,'preserved'); const r=f.run(['--receipt',f.receipt]); assert.notEqual(r.status,0); assert.equal(f.readCalls().length,0); assert.equal(fs.readFileSync(f.receipt,'utf8'),'preserved');}));
test('duplicate and unknown flags fail closed',()=>fixture(f=>{refused(f,f.run(['--profile','accept','--profile','default'])); refused(f,f.run(['--skip-backup']));}));

for(const stage of ['help','install','config']) test(`reject unreviewed config transition after ${stage}`,()=>fixture(f=>{
  f.maintenance(); const r=f.run(f.args,{FIXTURE_MUTATION:stage}); assert.notEqual(r.status,0,r.stdout+r.stderr);
  const expected={help:1,install:2,config:3}[stage]; assert.equal(f.readCalls().length,expected);
  const receipt=JSON.parse(fs.readFileSync(f.receipt)); assert.equal(receipt.status,'failed'); assert.equal(receipt.effectsUnknown,true); assert.equal(receipt.configAfterSha256,hash(fs.readFileSync(f.config)));
}));
test('Ken custom root cannot place a receipt in the protected default sibling',()=>fixture(f=>{
  f.maintenance({root:path.join(f.state,'popclaw-ken-fresh')});
  const protectedRoot=path.join(f.state,'popclaw'); fs.mkdirSync(protectedRoot); fs.writeFileSync(path.join(protectedRoot,'secret'),'protected');
  f.receipt=path.join(protectedRoot,'receipt.json'); f.args[f.args.indexOf('--receipt')+1]=f.receipt;
  refused(f,f.run(f.args)); assert.deepEqual(fs.readdirSync(protectedRoot),['secret']);
}));
