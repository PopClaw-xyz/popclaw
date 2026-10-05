import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalHostDb} from '../../../src/host/local-host-db.js';
import {readNativeSetupEvidence,readMcpSetupEvidence,localParticipationPort} from '../../../src/host/local-participation.js';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function fixture(){const root=mkdtempSync(join(tmpdir(),'install-source-'));roots.push(root);const stateDir=join(root,'host'),rootDir=join(root,'package'),dataRoot=join(root,'data');for(const p of [stateDir,rootDir,dataRoot])mkdirSync(p);const source=join(rootDir,'index.js');writeFileSync(source,'');return {root,stateDir,serviceStateDir:stateDir,rootDir,source,dataRoot,enabled:true};}
it('native 9.8 ordinary persisted install receipt is read from host WAL only at full activation',()=>{
 const f=fixture();const db=new LocalHostDb(join(f.stateDir,'state/openclaw.sqlite'));db.execute('CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT,updated_at_ms INTEGER)');
 db.execute('INSERT INTO config_machine_state VALUES(?,?,?)',['plugins.installedIndex',JSON.stringify({index:{version:1,migrationVersion:1,hostContractVersion:'2026.9.8',installRecords:{popclaw:{installedAt:new Date().toISOString(),installPath:f.rootDir,acceptedSurface:{tools:['popclaw_show_inbox']},acceptedSurfaceHash:'fixture',acceptedSurfaceAt:new Date().toISOString()}},plugins:[{pluginId:'popclaw',installOwner:'popclaw',rootDir:f.rootDir,source:f.source,enabled:true}]}}),Date.now()]);
 try{expect(readNativeSetupEvidence(f)?.reference).toHaveLength(64);expect(readNativeSetupEvidence({...f,enabled:false})).toBeUndefined();expect(readNativeSetupEvidence({...f,serviceStateDir:'other'})).toBeUndefined();}finally{db.close();}
});
it('missing native install receipt refuses without creating a host database',()=>{const f=fixture();expect(readNativeSetupEvidence(f)).toBeUndefined();expect(existsSync(join(f.stateDir,'state'))).toBe(false);});
for(const defect of ['old-release','prerelease','invalid-release','schema','future-schema','migration','owner','ambiguous-owner','duplicate','disabled','surface','root','source'] as const) it(`native 9.8 ${defect} evidence cannot grant initial me`,()=>{
 const f=fixture();
 const index={version:1,migrationVersion:1,hostContractVersion:'2026.9.8',installRecords:{popclaw:{installedAt:new Date().toISOString(),installPath:f.rootDir,acceptedSurface:{tools:['popclaw_show_inbox']},acceptedSurfaceHash:'fixture',acceptedSurfaceAt:new Date().toISOString()}},plugins:[{pluginId:'popclaw',installOwner:'popclaw',rootDir:f.rootDir,source:f.source,enabled:true,installOwnerAmbiguous:false}]};
 if(defect==='old-release')index.hostContractVersion='2026.9.4';
 if(defect==='prerelease')index.hostContractVersion='2026.9.9-rc.1';
 if(defect==='invalid-release')index.hostContractVersion='2026.9.8+.';
 if(defect==='schema')index.version=2;
 if(defect==='future-schema'){index.version=2;index.hostContractVersion='2026.9.9';}
 if(defect==='migration')index.migrationVersion=2;
 if(defect==='owner')index.plugins[0]!.installOwner='other';
 if(defect==='ambiguous-owner')index.plugins[0]!.installOwnerAmbiguous=true;
 if(defect==='duplicate')index.plugins.push({...index.plugins[0]!});
 if(defect==='disabled')index.plugins[0]!.enabled=false;
 if(defect==='surface')index.installRecords.popclaw.acceptedSurfaceHash='';
 if(defect==='root')index.installRecords.popclaw.installPath=f.dataRoot;
 if(defect==='source')index.plugins[0]!.source=join(f.dataRoot,'index.js');
 const db=new LocalHostDb(join(f.stateDir,'state/openclaw.sqlite'));
 db.execute('CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT,updated_at_ms INTEGER)');
 db.execute('INSERT INTO config_machine_state VALUES(?,?,?)',['plugins.installedIndex',JSON.stringify({index}),Date.now()]);
 try{expect(readNativeSetupEvidence(f)).toBeUndefined();}finally{db.close();}
});
it('MCP consumes exact setup registration receipt; actor/root/package mismatch refuses',()=>{
 const f=fixture(),path=join(f.root,'setup.json');const record={format:1,root:f.dataRoot,package:f.rootDir,digest:'fixture-runtime-digest',popclawId:'actor',initialMe:{version:1,purpose:'initial_me_setup',origin:'https://house.popclaw.me',actorId:'actor',dataRoot:f.dataRoot,setupId:'normal-setup'}};writeFileSync(path,JSON.stringify(record));
 const evidence=readMcpSetupEvidence(path,f.dataRoot,f.rootDir);expect(evidence?.actorId).toBe('actor');
 const port=localParticipationPort(()=>evidence);expect(port.capture({reason:'initial_me_setup',origin:'https://house.popclaw.me',actorId:'other',installationId:'install'})).toBeUndefined();
 expect(readMcpSetupEvidence(path,f.dataRoot,f.dataRoot)).toBeUndefined();expect(readMcpSetupEvidence(undefined,f.dataRoot,f.rootDir)).toBeUndefined();
});
