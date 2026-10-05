#!/bin/sh
# Install through OpenClaw's native plugin chain, bound to one selected instance.
# Usage: sh install-popclaw.sh [options] /absolute/path/popclaw-plugin-<build>.tgz
# First installs retain the one-argument form. Existing data requires a verified
# external maintenance record; this script never creates a cold-backup claim.
# Native installation may apply to a running Gateway. This script does not
# launch a Gateway, invoke managers, scan processes, discover logs or run doctor.
# POSIX sh launcher; the already-required selected Node handles JSON, paths,
# bounded child execution and private receipts without another dependency.
set -eu
if [ -n "${NODE_OPTIONS:-}" ] || [ -n "${NODE_PATH:-}" ]; then
  printf '%s\n' 'ERROR: NODE_OPTIONS/NODE_PATH must be unset for a fixed native source closure.' >&2
  exit 1
fi
INSTALLER_NODE=$(command -v node 2>/dev/null || true)
previous=''
for argument do
  if [ "$previous" = '--node' ]; then INSTALLER_NODE=$argument; fi
  previous=$argument
done
[ -n "$INSTALLER_NODE" ] || { printf '%s\n' 'ERROR: Node is required; select --node /absolute/path/node.' >&2; exit 1; }
exec "$INSTALLER_NODE" - "$@" <<'JS'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const abort = message => { throw new Error(message); };
const usage = 'Usage: sh install-popclaw.sh [--mode first-install|maintenance] [--state-dir ABS] [--profile NAME] [--config-path ABS] [--data-root ABS] [--node ABS] [--openclaw-cli ABS] [--maintenance-record ABS] [--receipt ABS] [--capabilities auto|accept|legacy] [--timeout-seconds 1..600] TARBALL';
const options = new Set(['mode','state-dir','profile','config-path','data-root','node','openclaw-cli','maintenance-record','receipt','capabilities','timeout-seconds']);
function parse(args) {
  const out = {};
  for (let i=0; i<args.length; i++) {
    const arg=args[i];
    if (arg==='--help' && args.length===1) { console.log(usage); process.exit(0); }
    if (arg.startsWith('--')) {
      const key=arg.slice(2);
      if (!options.has(key) || own(out,key) || !args[i+1] || args[i+1].startsWith('--')) abort('Unknown, duplicate or incomplete option. '+usage);
      out[key]=args[++i];
    } else {
      if (out.tarball) abort('Exactly one tarball is required.');
      out.tarball=arg;
    }
  }
  if (!out.tarball) abort(usage);
  return out;
}
function absolute(p) {
  if (typeof p!=='string' || !path.isAbsolute(p) || p.includes('${') || /[\x00-\x1f\x7f]/.test(p) || path.normalize(p)!==p || p==='/') abort('Selections must be fixed, normalized absolute paths.');
  return p;
}
// Check each parent before traversing it; never follow a state/root/config link.
// A missing tail is allowed only during first install. No directory recursion.
function physical(p, allowMissing=false) {
  absolute(p);
  let current=''; let missing=false; let result;
  for (const part of p.slice(1).split('/')) {
    current+='/'+part;
    if (missing) continue;
    try { result=fs.lstatSync(current); }
    catch (e) { if (e.code==='ENOENT' && allowMissing) {missing=true; result=undefined; continue;} abort('A selected path is missing or inaccessible.'); }
    if (result.isSymbolicLink()) abort('A selected path or parent is a symbolic link.');
    if (current!==p && !result.isDirectory()) abort('A selected parent is not a directory.');
  }
  return missing ? undefined : result;
}
function read(p, limit, privateFile=false) {
  const st=physical(p);
  if (!st.isFile() || st.nlink!==1 || st.size>limit || (privateFile && (st.uid!==process.getuid() || (st.mode&0o077)!==0))) abort('A selected file is not standalone, bounded or private as required.');
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const held=fs.fstatSync(fd);
    if (held.dev!==st.dev || held.ino!==st.ino) abort('Selected file changed during validation.');
    const bytes=fs.readFileSync(fd);
    const after=fs.fstatSync(fd);
    if (bytes.length>limit || after.size!==st.size || after.mtimeMs!==st.mtimeMs) abort('Selected file changed during reading.');
    return bytes;
  } finally {fs.closeSync(fd);}
}
const contains=(a,b)=>b===a || b.startsWith(a+'/');
function selector(opt, envName, fallback) {
  if (own(process.env,envName) && !process.env[envName]) abort('Empty instance selector is ambiguous.');
  if (opt!==undefined && own(process.env,envName) && opt!==process.env[envName]) abort('Explicit selection conflicts with the environment.');
  return opt ?? process.env[envName] ?? fallback;
}
function cliFromPath() {
  for (const dir of (process.env.PATH||'').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const p=path.join(dir,'openclaw');
    try {fs.accessSync(p,fs.constants.X_OK); return p;} catch {}
  }
  abort('OpenClaw is unavailable; select --openclaw-cli /absolute/path/to/its/JS-entry.');
}
function executable(p, js=false) {
  absolute(p);
  let real;
  try {real=fs.realpathSync(p);} catch {abort('Selected executable is unavailable.');}
  const st=physical(real);
  if (!st.isFile()) abort('Selected executable must resolve to a regular file.');
  if (!js) fs.accessSync(real,fs.constants.X_OK);
  else {
    const fd=fs.openSync(real,'r'); const head=Buffer.alloc(256);
    try {fs.readSync(fd,head,0,head.length,0);} finally {fs.closeSync(fd);}
    if (!/\.(?:mjs|cjs|js)$/.test(real) && !/^#![^\n]*\bnode\b/.test(head.toString())) abort('OpenClaw must be a JS entry, not an unverified wrapper.');
  }
  return real;
}
function configBytes(config, optional) {
  if (!physical(config,optional)) return undefined;
  const bytes=read(config,4*1024*1024);
  let parsed;
  try {parsed=JSON.parse(bytes);} catch {abort('Selected config must be strict JSON; JSON5 requires a separately reviewed adapter.');}
  if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) abort('Selected config is not an object.');
  // Config env is published by native reads. Alternate home/legacy selectors
  // may otherwise appear only after the child starts, outside our fixed target.
  const selectors=new Set(['HOME','OPENCLAW_HOME','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_PROFILE','CLAWDBOT_STATE_DIR','CLAWDBOT_CONFIG_PATH','POPCLAW_DATA_ROOT']);
  for(const entries of [parsed.env,parsed.env?.vars]) if(entries && typeof entries==='object') {
    for(const key of Object.keys(entries)) if(selectors.has(key.trim().toUpperCase())) abort('Config environment must not supply instance selectors.');
  }
  function check(v, keys=[]) {
    // Native 9.8 resolves provider credentials and restores authored references
    // when writing config. Leave values to native resolution; never expand here.
    // Unknown fields, SecretRef selectors and all path/identity fields stay fixed.
    const credential=keys.length===4 && keys[0]==='models' && keys[1]==='providers' && keys[3]==='apiKey';
    if (typeof v==='string' && v.includes('${') && !credential) abort('Config environment substitution is outside reviewed credential fields.');
    if (v && typeof v==='object') for(const [k,value] of Object.entries(v)) {
      if (k==='$include') abort('Config includes are outside the fixed selection.');
      if (k.includes('${')) abort('Config keys must be fixed.');
      check(value,[...keys,k]);
    }
  }
  check(parsed);
  return bytes;
}
// Native install/config may update these fields only. Anything else leaves
// the reviewed configuration, so stop before issuing another native command.
function configTransition(beforeBytes, afterBytes, stage) {
  if (stage==='help') {
    if ((beforeBytes===undefined)!==(afterBytes===undefined) || (beforeBytes && !beforeBytes.equals(afterBytes))) abort('Config changed during the help probe; keep the fence.');
    return;
  }
  const before=beforeBytes?JSON.parse(beforeBytes):{};
  const after=afterBytes?JSON.parse(afterBytes):{};
  const popBefore=before.plugins?.entries?.popclaw;
  const popAfter=after.plugins?.entries?.popclaw;
  if (popBefore?.enabled===false && popAfter?.enabled!==false) abort('Native operation changed an explicitly disabled plugin.');
  const allowed=stage==='install'
    ? ['plugins.entries.popclaw.enabled','plugins.installs.popclaw','meta.lastTouchedAt','meta.lastTouchedVersion']
    : ['plugins.entries.popclaw.hooks.allowConversationAccess','meta.lastTouchedAt','meta.lastTouchedVersion'];
  // Official 2026.9.8 stamps these two completion markers on ordinary config
  // writes, even without Doctor/onboarding. Only a new literal true is allowed;
  // actual model/policy edits and every other metadata change remain protected.
  for(const key of ['modelPolicyAllowlist','utilityModelSeparation']) {
    const prior=before.meta?.migrations?.[key], next=after.meta?.migrations?.[key];
    if(prior===undefined && next===true) allowed.push('meta.migrations.'+key);
    else if(prior!==next) abort('Native operation changed an existing or invalid migration marker; keep the fence.');
  }
  if(stage==='install') {
    for(const key of ['allow','deny']) {
      const a=before.plugins?.[key], b=after.plugins?.[key];
      if ((a!==undefined&&!Array.isArray(a))||(b!==undefined&&!Array.isArray(b))) abort('Native plugin policy has an unknown shape.');
      if(JSON.stringify((a||[]).filter(x=>x!=='popclaw'))!==JSON.stringify((b||[]).filter(x=>x!=='popclaw'))) abort('Native operation changed another plugin policy.');
      if(key==='allow' && (a||[]).includes('popclaw') && !(b||[]).includes('popclaw')) abort('Native operation removed PopClaw consent.');
      if(key==='deny' && !(a||[]).includes('popclaw') && (b||[]).includes('popclaw')) abort('Native operation added a PopClaw denial.');
      allowed.push('plugins.'+key);
    }
  } else if(popAfter?.hooks?.allowConversationAccess!==true) abort('Native hook declaration was not persisted in the selected config.');
  function strip(object, dotted) {
    const keys=dotted.split('.'); const parents=[]; let current=object;
    for(const key of keys.slice(0,-1)) {if(!current||typeof current!=='object'||Array.isArray(current)||!own(current,key)) return;parents.push([current,key]);current=current[key];}
    if(current && typeof current==='object' && !Array.isArray(current)) delete current[keys.at(-1)];
    for(const [parent,key] of parents.reverse()) if(parent[key] && typeof parent[key]==='object' && !Array.isArray(parent[key]) && Object.keys(parent[key]).length===0) delete parent[key];
  }
  for(const field of allowed) {strip(before,field);strip(after,field);}
  function canonical(value) {
    if(Array.isArray(value)) return value.map(canonical);
    if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
    return value;
  }
  if(JSON.stringify(canonical(before))!==JSON.stringify(canonical(after))) abort('Native operation made an unreviewed config transition; keep the fence.');
}
const memberClasses=['data-root','legacy-data-if-applicable','plugin-code','config-launchers-receipts','host-state-auth'];
function maintenance(recordPath,target,hashes) {
  let r, bytes;
  try {bytes=read(recordPath,64*1024,true);r=JSON.parse(bytes);} catch (e) {abort('Maintenance record is missing, unsafe or invalid.');}
  if (r.schema!=='popclaw-install-maintenance/v1') abort('Unsupported maintenance record schema.');
  for(const [key,value] of Object.entries(target)) if(r.target?.[key]!==value) abort('Maintenance target does not match the fixed selection.');
  for(const [key,value] of Object.entries(hashes)) if(r.hashes?.[key]!==value) abort('Maintenance code/config/package hash does not match.');
  const now=Date.now(); const from=Date.parse(r.window?.validFrom); const until=Date.parse(r.window?.validUntil);
  if (!Number.isFinite(from) || !Number.isFinite(until) || from>now || until<=now || until-from>3600000 || r.window.callersStopped!==true || r.window.launchersFenced!==true) abort('Maintenance stop/fence window is invalid or expired.');
  if(r.backup?.complete!==true || r.backup?.verified!==true || typeof r.backup?.id!=='string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(r.backup.id) || !Array.isArray(r.backup.memberClasses) || memberClasses.some(c=>!r.backup.memberClasses.includes(c))) abort('Complete verified external cold-backup evidence is required.');
  const digests=[r.window.stopEvidenceSha256,r.backup.manifestSha256,r.backup.verificationReceiptSha256,r.native?.evidenceSha256];
  if(digests.some(d=>typeof d!=='string'||! /^[a-f0-9]{64}$/.test(d))) abort('Maintenance evidence digests are incomplete.');
  if(r.native?.noBootstrap!=='reviewed' || JSON.stringify(r.native.commands)!==JSON.stringify(['plugins install --help','plugins install','config set'])) abort('Native no-bootstrap behavior is unknown for the required commands.');
  return {validUntil:until,recordSha256:sha(bytes),backupId:r.backup.id,nativeEvidenceSha256:r.native.evidenceSha256};
}
async function native(node,cli,args,env,seconds) {
  const started=Date.now();
  return await new Promise(resolve=>{
    const child=spawn(node,[cli,...args],{env,cwd:env.OPENCLAW_STATE_DIR,stdio:['ignore','pipe','pipe']});
    const digest=crypto.createHash('sha256'); let size=0, help='', timedOut=false, outputLimited=false, done=false, grace;
    const install=args[0]==='plugins' && args[1]==='install' && !args.includes('--help');
    const stdout=[];
    const stop=()=>{ child.kill('SIGTERM'); grace=setTimeout(()=>finish(null,'unjoined'),2000); };
    const timer=setTimeout(()=>{timedOut=true; stop();},seconds*1000);
    function collect(bytes) {
      digest.update(bytes); size+=bytes.length;
      if (args.includes('--help') && size<=65536) help+=bytes.toString();
      if(size>1024*1024 && !outputLimited) {outputLimited=true; stop();}
    }
    child.stdout.on('data',bytes=>{collect(bytes); if(install && size<=1024*1024) stdout.push(bytes);}); child.stderr.on('data',collect);
    function finish(code,signal,spawnFailed=false) {
      if(done) return; done=true; clearTimeout(timer); clearTimeout(grace);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      // OpenClaw 2026.9.8 install has no JSON output option. Accept exactly one
      // official stdout marker; stderr, missing or ambiguous markers prove no application state.
      let installReported;
      if(install) {
        installReported={state:'unknown'};
        const markers=Buffer.concat(stdout).toString('utf8').split(/\r?\n/).filter(line=>line==='Saved for the next Gateway start.' || /^Applied in Gateway generation .*\.$/.test(line));
        if(code===0 && !signal && !spawnFailed && !timedOut && !outputLimited && markers.length===1) {
          if(markers[0]==='Saved for the next Gateway start.') installReported={state:'deferred'};
          else {
            const match=/^Applied in Gateway generation ([1-9]\d*)\.$/.exec(markers[0]);
            const generation=match ? Number(match[1]) : NaN;
            if(Number.isSafeInteger(generation)) installReported={state:'applied',generation};
          }
        }
      }
      resolve({childPid:child.pid??null,command:args.slice(0,2).join(' ')+(args.includes('--help')?' --help':''),exitCode:code,signal:signal||null,spawnFailed,timedOut,outputLimited,childJoined:signal!=='unjoined',elapsedMs:Date.now()-started,outputBytes:size,outputSha256:digest.digest('hex'),...(install ? {installReported} : {}),help});
    }
    child.on('error',()=>finish(null,null,true)); child.on('close',(code,signal)=>finish(code,signal));
  });
}
async function main() {
  const o=parse(process.argv.slice(2)); const mode=o.mode||'first-install';
  if(!['first-install','maintenance'].includes(mode)) abort('Unknown install mode.');
  const cap=o.capabilities||'auto'; if(!['auto','accept','legacy'].includes(cap)) abort('Unknown capability consent selection.');
  const seconds=Number(o['timeout-seconds']||60); if(!Number.isInteger(seconds)||seconds<1||seconds>600) abort('Timeout must be 1..600 seconds.');
  if(process.env.OPENCLAW_HOME || process.env.CLAWDBOT_STATE_DIR || process.env.CLAWDBOT_CONFIG_PATH) abort('Alternate home/legacy selectors must be unset.');
  const profile=selector(o.profile,'OPENCLAW_PROFILE','default');
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) abort('Profile must be a lowercase instance name.');
  const state=absolute(selector(o['state-dir'],'OPENCLAW_STATE_DIR',path.join(absolute(process.env.HOME),profile==='default'?'.openclaw':'.openclaw-'+profile)));
  const config=absolute(selector(o['config-path'],'OPENCLAW_CONFIG_PATH',path.join(state,'openclaw.json')));
  const root=absolute(selector(o['data-root'],'POPCLAW_DATA_ROOT',path.join(state,'popclaw')));
  // Refuse contradictions before reading any selected config or data-root entry.
  if(root===state || contains(root,state) || contains(root,config)) abort('Data root overlaps state/config selection.');
  const extension=path.join(state,'extensions','popclaw');
  if(contains(root,extension)||contains(extension,root)||contains(extension,config)) abort('Data/config overlaps the native extension destination.');
  if(mode==='maintenance' && ['state-dir','config-path','data-root','node','openclaw-cli','maintenance-record','receipt'].some(k=>!o[k])) abort('Maintenance requires explicit fixed paths, runtimes, evidence and receipt.');
  if(mode==='first-install' && o['maintenance-record']) abort('Maintenance evidence requires maintenance mode.');
  const forbiddenSiblings=[path.join(state,'popclaw'),path.join(state,'popclaw-data')].filter(p=>p!==root);
  for(const input of [config,o.receipt,o['maintenance-record'],o.tarball&&path.resolve(o.tarball)]) if(input && forbiddenSiblings.some(p=>contains(p,input))) abort('An input or receipt overlaps an unselected sibling data root.');
  const tarball=absolute(path.resolve(o.tarball)); const tgz=read(tarball,512*1024*1024);
  const st=physical(state,mode==='first-install'); if(st && !st.isDirectory()) abort('Selected state is not a directory.');
  const rt=physical(root,mode==='first-install'); if(rt && !rt.isDirectory()) abort('Selected root is not a directory.');
  const ext=physical(extension,true);
  if(mode==='first-install' && (rt || ext)) abort('Existing data/code requires maintenance mode and verified external cold-backup evidence.');
  const cfg=configBytes(config,mode==='first-install');
  let acceptedConfig=cfg;
  const node=executable(o.node||process.execPath); const cli=executable(o['openclaw-cli']||cliFromPath(),true);
  const target={stateDir:state,configPath:config,dataRoot:root,profile,node,openclawCli:cli,tarball};
  const hashes={tarball:sha(tgz),node:sha(fs.readFileSync(node)),openclawCli:sha(read(cli,32*1024*1024)),config:cfg?sha(cfg):null};
  const evidence=mode==='maintenance'?maintenance(absolute(o['maintenance-record']),target,hashes):null;
  const receipt=absolute(o.receipt||path.join(state,'install-receipts',crypto.randomUUID()+'.json'));
  if(contains(root,receipt)||contains(extension,receipt)||receipt===config||receipt===tarball||receipt===node||receipt===cli||receipt===o['maintenance-record']) abort('Receipt overlaps protected inputs or data/code.');
  physical(receipt,true);
  if(fs.existsSync(receipt)) abort('Receipt already exists; select a new private receipt path.');
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  fs.mkdirSync(path.dirname(receipt),{recursive:true,mode:0o700});
  const fd=fs.openSync(receipt,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  const report={schema:'popclaw-install-receipt/v2',mode,target,hashes,evidence,status:'pending',installReported:{state:'unknown'},runtimeVerified:false,startDeferred:null,effectsUnknown:false,commands:[],startedAt:new Date().toISOString()};
  function save() {const b=Buffer.from(JSON.stringify(report,null,2)+'\n');fs.ftruncateSync(fd,0);fs.writeSync(fd,b,0,b.length,0);fs.fsyncSync(fd);}
  save();
  const env={...process.env,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:config,POPCLAW_DATA_ROOT:root,OPENCLAW_PROFILE:profile,PATH:path.dirname(node)+path.delimiter+process.env.PATH};
  async function run(args) {
    if(evidence && Date.now()+seconds*1000+2000>=evidence.validUntil) abort('Maintenance window has insufficient remaining time; keep the fence and renew evidence.');
    // Detect drift of the exact inputs before each child. Native config writes
    // after install are allowed, but selectors/includes must remain fixed.
    physical(state); physical(root,mode==='first-install'); physical(extension,true);
    if(sha(read(tarball,512*1024*1024))!==hashes.tarball || sha(read(cli,32*1024*1024))!==hashes.openclawCli || sha(fs.readFileSync(node))!==hashes.node) abort('Package or selected executable changed; hold installation.');
    const currentConfig=configBytes(config,mode==='first-install');
    configTransition(acceptedConfig,currentConfig,'help');
    const result=await native(node,cli,args,env,seconds); const help=result.help; delete result.help;
    report.commands.push(result);
    if(result.installReported) {
      report.installReported=result.installReported;
      report.startDeferred=result.installReported.state==='unknown' ? null : result.installReported.state==='deferred';
    }
    if(result.timedOut || result.outputLimited || !result.childJoined || result.spawnFailed || result.signal || result.exitCode!==0) {
      report.status='failed'; report.effectsUnknown=true; save();
      const code=result.timedOut?124:result.outputLimited?125:result.exitCode||1;
      console.error('ERROR: Native operation failed; keep the selected caller fence. Receipt records the actual exit/timeout. Effects and runtime remain unverified.');
      process.exitCode=code; return null;
    }
    const nextConfig=configBytes(config,mode==='first-install');
    report.configAfterSha256=nextConfig?sha(nextConfig):null;
    configTransition(acceptedConfig,nextConfig,args.includes('--help')?'help':args[0]==='plugins'?'install':'config');
    acceptedConfig=nextConfig;
    save(); return help;
  }
  try {
    console.log('Selected instance fixed. Native installation may apply to a running Gateway; this script does not launch one.');
    const help=await run(['plugins','install','--help']); if(help===null) return;
    const supported=help.includes('--accept-capabilities');
    if((cap==='accept'&&!supported)||(cap==='legacy'&&supported)) abort('Capability consent choice conflicts with native support.');
    const args=['plugins','install','--force']; if(supported) args.push('--accept-capabilities'); args.push(tarball);
    if(await run(args)===null) return;
    if(await run(['config','set','plugins.entries.popclaw.hooks.allowConversationAccess','true'])===null) return;
    report.status=report.installReported.state==='deferred' ? 'installed-start-deferred' : report.installReported.state==='applied' ? 'installed-applied-runtime-unverified' : 'installed-application-unknown';
    report.completedAt=new Date().toISOString(); save();
    console.log('Native installation and conversation-hook declaration completed. Native application report: '+report.installReported.state+'.');
    console.log('Registration, loaded build/identity and first-start behavior remain unverified.');
    console.log('Use the receipt selectors for separate runtime verification; follow the native application report when selecting startup or reload.');
    console.log('Receipt: '+receipt);
  } catch(e) {report.status='failed';report.effectsUnknown=report.commands.length>0;save();throw e;}
  finally {fs.closeSync(fd);}
}
main().catch(e=>{console.error('ERROR: '+e.message);process.exitCode=1;});
JS
