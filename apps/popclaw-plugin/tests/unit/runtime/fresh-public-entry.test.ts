import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { createOpenClawHostAdapter } from '../../../src/host/openclaw-host-adapter.js';
import { gatewayRuntimePorts } from '../../../src/host/openclaw-runtime-ports.js';
import { buildMcpRuntime } from '../../../src/host/mcp-runtime-ports.js';
import { registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { assembleRuntime } from '../../../src/runtime/assembly/index.js';
import { executionDbFor } from '../../../src/ingress/world-feed-store.js';
import { commitLocalLogout, readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { resolveInstallationId } from '../../../src/runtime/house-lifecycle/installation.js';
import * as worldCapabilities from '../../../src/world/world-capabilities.js';
import plugin from '../../../src/index.js';
import { clearPerProcess } from '../../../src/runtime/once.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

// The unrelated identity inbox retains its distinct server contract. This fake
// prevents its EventSource implementation from opening any real network socket.
vi.mock('eventsource', () => ({default:class {
  onmessage=null; onerror=null; onopen=null; close() {}
}}));
// Capture real receptions for rescue after failed-case assertions only.
// Successful cases use the production shutdown, including its drain join.
const receptions=vi.hoisted(()=>[] as Array<{stop():void;whenIdle():Promise<void>}>);
const drainProbe=vi.hoisted(()=>({
  hold:undefined as undefined|((db:import('../../../src/social-graph/relation-host.js').RelationHostDeps['db'],stillValid:()=>boolean)=>Promise<void>),
  releases:0,
}));
vi.mock('../../../src/host/storage-maintenance.js',async original=>{
  const real=await original<typeof import('../../../src/host/storage-maintenance.js')>();
  return {...real,registerStorageRuntime:(...args:Parameters<typeof real.registerStorageRuntime>)=>{
    const release=real.registerStorageRuntime(...args);return()=>{drainProbe.releases++;release();};
  }};
});
vi.mock('../../../src/social-graph/relation-reception.js',async original=>{
  const real=await original<typeof import('../../../src/social-graph/relation-reception.js')>();
  return {...real,openRelationReception:async(...args:Parameters<typeof real.openRelationReception>)=>{
    const deps=args[0];
    const result=await real.openRelationReception({...deps,
      ...(drainProbe.hold?{resendRelations:(valid:()=>boolean)=>drainProbe.hold!(deps.db,valid)}:{})});
    receptions.push(result);return result;
  }};
});
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{ for(const close of cleanup.splice(0).reverse()) await close();for(const reception of receptions.splice(0))reception.stop(); drainProbe.hold=undefined;drainProbe.releases=0;clearPerProcess('runtime');vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs(); });
const ME='https://house.popclaw.me', WORLD='https://house.popclaw.world';
const logger={info() {},warn() {},error() {}};
type Runtime=Awaited<ReturnType<typeof buildMcpRuntime>>|Awaited<ReturnType<typeof assembleRuntime>>;
async function fixture(kind:'Native'|'MCP', missingCapability=false) {
  const root=mkdtempSync(join(tmpdir(),'fresh-public-entry-')), paths=new PopclawPaths(root);
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'config'),{recursive:true});
  writeFileSync(join(root,'config/plugin.json'),JSON.stringify({lore_houses:[ME,WORLD],canvas_base_url:''}));
  vi.stubEnv('POPCLAW_DATA_ROOT',root); vi.stubEnv('POPCLAW_WORLD_STREAM',undefined);
  vi.stubEnv('LOG_LEVEL','silent');
  const actorPair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(66)), actor=bs58.encode(actorPair.publicKey);
  const manifest=mintHouse({origin:ME,seed:77,manifest:{relations:{ordered:1},
    read_auth:{schemes:['popclaw-identity-read-v2']},guide_url:'/guide.md',
    ...(!missingCapability?{world_interaction:{version:1,public_stream:{endpoint:'/v1/world-stream',mode:'public-v1',
      log_incarnation:'fresh_log_1',envelope_baseline:'public-envelope-01',initial_public_scopes:[]}}}: {})}});
  const worldManifest=mintHouse({origin:WORLD,seed:78,manifest:{world_interaction:{version:1,public_stream:{endpoint:'/v1/world-stream',mode:'public-v1',log_incarnation:'world_log_1',envelope_baseline:'public-envelope-01',initial_public_scopes:[]}}}});
  const requests:Array<{url:string;init?:RequestInit}>=[], controllers:ReadableStreamDefaultController<Uint8Array>[]=[];
  const fakeFetch=vi.fn<typeof fetch>(async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input)); requests.push({url:url.href,init});
    if(url.origin===WORLD && url.pathname==='/v1/manifest') return worldManifest.fetch(url.href);
    if(url.origin!==ME) throw new Error('UNEXPECTED_NETWORK:'+url.origin);
    if(url.pathname==='/v1/manifest') return manifest.fetch(url.href);
    if(url.pathname==='/guide.md') return new Response('# Synthetic House guide');
    if(url.pathname==='/v1/world-stream') {
      expect(url.searchParams.get('mode')).toBe('public-v1');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(new ReadableStream<Uint8Array>({start(c){controllers.push(c);
        init?.signal?.addEventListener('abort',()=>{try{c.close();}catch{/* already closed */}},{once:true});}}),
        {headers:{'content-type':'text/event-stream'}});
    }
    return new Response('',{status:404});
  });
  vi.stubGlobal('fetch',fakeFetch);
  const build=async():Promise<Runtime>=>{
    if(kind==='MCP') return buildMcpRuntime({dataRoot:root,logger:logger as never,closing:new AbortController().signal,
      initialEvidence:()=>({reference:'synthetic-install-receipt'}),serverBox:{},approvalWindowMs:undefined,consumerId:()=> 'synthetic:B'});
    const api={logger,config:{},runtime:{state:{resolveStateDir:()=>root},
      system:{enqueueSystemEvent() {},runHeartbeatOnce() {}}}} as never;
    let release!:()=>void;
    const host=createOpenClawHostAdapter(api,db=>(release=registerStorageRuntime(db,paths)));
    return assembleRuntime(host,gatewayRuntimePorts({api,host,build:'synthetic-B',storagePaths:paths,
      initialEvidence:()=>({reference:'synthetic-install-receipt'}),releaseStorage:()=>release(),llmComplete:async()=>'',
      favoritesFile:p=>join(p.data(),'favorites.jsonl'),root:{l2:{notifier() {},nameOf() {},pendingFollows() {},proposals() {},clear() {}},
        markStorageShuttingDown() {},snapshotStorageBackups:()=>[]}}),new AbortController().signal);
  };
  let rt=await build(); cleanup.push(()=>rt.shutdown());
  const send=(type:string,bytes:Uint8Array)=>controllers.at(-1)!.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${Buffer.from(bytes).toString('base64')}\n\n`));
  return {paths,requests,controllers,send,build, get rt(){return rt;},setRuntime(value:Runtime){rt=value;},actorPair,actor};
}

it.each(['Native','MCP'] as const)('%s fresh initial me receives verified public material with no manual switch or maintenance',async kind=>{
  const f=await fixture(kind);
  expect(await f.rt.houseRuntime.activateInitialMe()).toMatchObject({admission:'configured'});
  await vi.waitFor(()=>expect(f.controllers,JSON.stringify({status:f.rt.houseRuntime.publicReadStatus(ME),requests:f.requests.map(r=>r.url)})).toHaveLength(1),{timeout:4000});
  expect(readParticipation(f.rt.host.db,WORLD)).toBeNull();
  expect(readParticipation(f.rt.host.db,ME)?.session_id).toBe('');
  expect(f.requests.some(r=>new URL(r.url).pathname==='/v1/house-session')).toBe(false);
  const store=await f.rt.houseRuntime.storeForCommand(ME),db=executionDbFor(store);
  expect(db.queryOne('SELECT public_initialization FROM execution_partition_identity_v1')).toEqual({public_initialization:'prepared-public-v1'});
  const env=popclaw.event.EventEnvelope.fromObject({actor:{popclawId:f.actor,nickname:'Synthetic author'},timestamp:'1780000000',
    post:{blocks:[{blockType:0,content:'Verified fresh public material'}]}});
  const canonical=canonicalizeEnvelope(env);env.eventId=cidFromCanonical(canonical);env.signature=nacl.sign.detached(canonical,f.actorPair.secretKey);
  const bytes=popclaw.event.EventEnvelope.encode(env).finish();
  f.send('public_boundary',popclaw.world.PublicStreamBoundary.encode(popclaw.world.PublicStreamBoundary.fromObject({logIncarnation:'fresh_log_1',fullPublic:true,highWaterSeq:'1'})).finish());
  f.send('public_frame',popclaw.event.WorldStreamFrame.encode(popclaw.event.WorldStreamFrame.fromObject({seq:'1',envelope:bytes,kind:'post',scopes:[]})).finish());
  f.send('public_checkpoint',popclaw.world.PublicStreamCheckpoint.encode(popclaw.world.PublicStreamCheckpoint.fromObject({phase:'replay',publicThroughSeq:'1'})).finish());
  await vi.waitFor(()=>expect(db.queryOne('SELECT event_id FROM world_public_events_v1')).toEqual({event_id:env.eventId}));
  expect(Buffer.from(db.queryOne<{envelope:Uint8Array}>('SELECT envelope FROM world_public_events_v1')!.envelope)).toEqual(Buffer.from(bytes));
  f.rt.houseRuntime.capturePublicMaterial(store).assertCurrent();
  expect(f.rt.publicFeedDisplay!.read().items[0]?.body).toContain('Verified fresh public material');
  const identity=f.rt.boot.popclawId, keyBefore=readFileSync(join(f.paths.identityDir(),'master.key'));
  await f.rt.shutdown(); f.setRuntime(await f.build());
  await vi.waitFor(()=>expect(f.controllers).toHaveLength(2),{timeout:4000});
  expect(await f.rt.houseRuntime.activateInitialMe()).toBeUndefined();
  expect(f.rt.boot.popclawId).toBe(identity);expect(readFileSync(join(f.paths.identityDir(),'master.key'))).toEqual(keyBefore);
  const reopened=executionDbFor(await f.rt.houseRuntime.storeForCommand(ME));
  expect(reopened.queryOne('SELECT event_id FROM world_public_events_v1')).toEqual({event_id:env.eventId});
  expect(new URL(f.requests.filter(r=>new URL(r.url).pathname==='/v1/world-stream').at(-1)!.url).searchParams.get('public_after')).toBe('1');
  await f.rt.houseRuntime.commands.logoutHouse(ME);
  await f.rt.shutdown(); f.setRuntime(await f.build());
  await new Promise(resolve=>setTimeout(resolve,75));
  expect(await f.rt.houseRuntime.activateInitialMe()).toBeUndefined();expect(f.controllers).toHaveLength(2);
  expect(readParticipation(f.rt.host.db,ME)?.desired).toBe('disabled');
  expect(readParticipation(f.rt.host.db,WORLD)).toBeNull();
});

it.each(['Native','MCP'] as const)('%s refuses missing public capability without legacy transport fallback',async kind=>{
  const f=await fixture(kind,true);
  expect(await f.rt.houseRuntime.activateInitialMe()).toMatchObject({admission:'configured'});
  await vi.waitFor(()=>expect(f.rt.houseRuntime.publicReadStatus(ME).detail).toContain('PUBLIC_CAPABILITY_UNAVAILABLE'));
  expect(f.controllers).toHaveLength(0);
  expect(f.requests.filter(r=>new URL(r.url).pathname==='/v1/world-stream')).toEqual([]);
});

it('MCP rejects an invalid receive mode before creating mutable host storage',async()=>{
  const root=mkdtempSync(join(tmpdir(),'invalid-receive-mode-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  vi.stubEnv('POPCLAW_WORLD_STREAM','1');
  await expect(buildMcpRuntime({dataRoot:root,logger:logger as never,closing:new AbortController().signal,
    serverBox:{},approvalWindowMs:undefined,consumerId:()=> 'synthetic'})).rejects.toThrow('RECEIVE_MODE_INVALID');
  expect(existsSync(new PopclawPaths(root).socialDb())).toBe(false);
});

it.each(['Native','MCP'] as const)('%s refuses a changed trusted binding on restart and preserves history',async kind=>{
  const f=await fixture(kind);
  expect(await f.rt.houseRuntime.activateInitialMe()).toMatchObject({admission:'configured'});
  await vi.waitFor(()=>expect(f.controllers).toHaveLength(1));
  const identity=f.rt.boot.popclawId;
  await f.rt.shutdown();
  const writer=new LocalHostDb(f.paths.socialDb());
  writer.execute("UPDATE house_binding_pin SET house_key=?,revision=revision+1 WHERE origin=?",[bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(99)).publicKey),ME]);
  writer.close();
  f.setRuntime(await f.build());
  await vi.waitFor(()=>expect(f.rt.houseRuntime.publicReadStatus(ME).detail).toContain('PUBLIC_PIN_MISMATCH'));
  expect(f.controllers).toHaveLength(1);expect(f.rt.boot.popclawId).toBe(identity);
  expect(await f.rt.houseRuntime.activateInitialMe()).toBeUndefined();
  expect(executionDbFor(await f.rt.houseRuntime.storeForCommand(ME)).queryAll('SELECT * FROM world_public_bindings_v1')).toHaveLength(1);
});

it.each(['logout','owner'] as const)('MCP public preparation refuses concurrent %s before its controlled commit',async change=>{
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(r=>{release=r;}), started=new Promise<void>(r=>{entered=r;});
  const original=worldCapabilities.makeWorldManifestPreparer;
  vi.spyOn(worldCapabilities,'makeWorldManifestPreparer').mockImplementation(options=>{
    const prepare=original(options);
    return async input=>{const result=await prepare(input);entered();await held;return result;};
  });
  const f=await fixture('MCP'), store=await f.rt.houseRuntime.storeForCommand(ME), joining=f.rt.houseRuntime.activateInitialMe();
  try {
    await started;
    const writer=new LocalHostDb(f.paths.socialDb());
    try {
      if(change==='logout') commitLocalLogout(writer,ME,resolveInstallationId(writer),'synthetic-other-process',Math.floor(Date.now()/1000),'');
      else writer.execute("UPDATE house_lifecycle_owner SET generation=generation+1,holder='synthetic-other',renewed_at=? WHERE id=1",[Date.now()]);
    } finally {writer.close();}
  } finally {release();}
  if(change==='owner') await f.rt.houseRuntime.stop();
  expect(await joining).not.toMatchObject({admission:'configured'});
  expect(worldCapabilities.readHouseCapabilityView(f.rt.host.db,ME)).toBeNull();
  expect(f.controllers).toHaveLength(0);
  expect(executionDbFor(store).queryAll('SELECT * FROM world_public_bindings_v1')).toEqual([]);
});

it('Native registration remains cheap under an invalid switch; full activation rejects before mutable host construction',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cheap-native-invalid-mode-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  vi.stubEnv('POPCLAW_DATA_ROOT',root);vi.stubEnv('POPCLAW_WORLD_STREAM','1');
  const network=vi.fn(()=>{throw new Error('REAL_NETWORK_FORBIDDEN');});vi.stubGlobal('fetch',network);
  for(const mode of ['discovery','cli-metadata','full']) {
    const services:Array<{id:string;start():Promise<void>}>=[];
    const api={registrationMode:mode,pluginConfig:{},config:{},logger,
      runtime:{state:{resolveStateDir:()=>root},system:{enqueueSystemEvent() {},runHeartbeatOnce() {}}},
      registerTool() {},registerCommand() {},registerInteractiveHandler() {},on() {},
      registerService:(service:{id:string;start():Promise<void>})=>services.push(service)};
    expect(()=>plugin.register!(api as never)).not.toThrow();
    expect(network).not.toHaveBeenCalled();expect(existsSync(new PopclawPaths(root).socialDb())).toBe(false);
    if(mode==='full') await expect(services.find(s=>s.id==='popclaw-runtime')!.start()).rejects.toThrow('RECEIVE_MODE_INVALID');
    clearPerProcess('runtime');
  }
  expect(existsSync(new PopclawPaths(root).socialDb())).toBe(false);
  expect(existsSync(join(new PopclawPaths(root).identityDir(),'master.key'))).toBe(false);
  expect(network).not.toHaveBeenCalled();
});


it.each(['Native','MCP'] as const)('%s normal shutdown joins an actual held relation sweep before DB close and storage release',async kind=>{
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  const calls:Array<boolean>=[];
  drainProbe.hold=async(db,stillValid)=>{
    calls.push(stillValid());entered();await held;
    // The real relation host must keep this actual SQLite handle open until
    // the existing callback returns, and revoke the captured round at stop.
    expect(stillValid()).toBe(false);
    expect(db.queryOne('SELECT 1 AS open')).toEqual({open:1});
  };
  cleanup.push(()=>release());
  const f=await fixture(kind);await started;
  const close=vi.spyOn(f.rt.host.db,'close');
  let done=false;const task=f.rt.shutdown().then(()=>{done=true;});
  try {
    await new Promise(resolve=>setTimeout(resolve,50));
    expect(done).toBe(false);expect(close).not.toHaveBeenCalled();expect(drainProbe.releases).toBe(0);
    expect(f.rt.host.db.queryOne('SELECT 1 AS open')).toEqual({open:1});
    release();await task;
    expect(done).toBe(true);expect(close).toHaveBeenCalledOnce();expect(drainProbe.releases).toBe(1);
    // stop is final: neither a restart request nor another timer may schedule
    // a new sweep after the join and close have completed.
    receptions.at(-1)!.stop();await receptions.at(-1)!.whenIdle();
    expect(calls).toHaveLength(1);
  } finally {release();await task;}
});
