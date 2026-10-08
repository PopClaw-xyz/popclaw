import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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
import { LocalHostAdapter } from '../../../src/host/local-host-adapter.js';
import { Keystore } from '../../../src/identity/keystore.js';
import { completeStorageInitialization } from '../../../src/host/storage-compatibility.js';
import { resolveInstallationId } from '../../../src/runtime/house-lifecycle/installation.js';
import * as worldCapabilities from '../../../src/world/world-capabilities.js';
import plugin from '../../../src/index.js';
import { clearPerProcess } from '../../../src/runtime/once.js';
import { mintHouse } from '../../helpers/signed-manifest.js';
import { registerFeedTools } from '../../../src/tools/feed-tools.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import { publicMaterialSource, retainPublicMaterialBasis } from '../../../src/newspaper/public-material-source.js';
import { collectNewspaperMaterials } from '../../../src/newspaper/collect-materials.js';
import { registerWorldTools } from '../../../src/tools/world-tools.js';
import { _observedPostIdsForTest, resolvePostRefWithSource } from '../../../src/world/post-ref.js';
import { publishStorageJson } from '../../../src/host/storage-maintenance.js';
import { confirmHouseTrust } from '../../../src/world/house-trust.js';

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
async function fixture(kind:'Native'|'MCP', missingCapability=false, rootMode:'new'|'current'='current') {
  const root=mkdtempSync(join(tmpdir(),'fresh-public-entry-')), paths=new PopclawPaths(root);
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  if(rootMode==='current') {
    // A fresh public execution root still has a legal identity/data profile.
    // Initialize it before config; do not create participation or house history.
    const initialization=new LocalHostAdapter({dataRoot:root,logger});
    try {
      const key=await new Keystore(initialization).loadOrGenerate();
      completeStorageInitialization(initialization,key.popclawId);
    } finally {
      initialization.db.close();
    }
    mkdirSync(join(root,'config'),{recursive:true});
    writeFileSync(join(root,'config/plugin.json'),JSON.stringify({lore_houses:[ME,WORLD],canvas_base_url:''}));
  } else {
    // Zero-config first install uses the real me default; canvas stays offline.
    vi.stubEnv('POPCLAW_CANVAS_BASE_URL','');
  }
  vi.stubEnv('POPCLAW_DATA_ROOT',root); vi.stubEnv('POPCLAW_WORLD_STREAM',undefined);
  vi.stubEnv('LOG_LEVEL','silent');
  const actorPair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(66)), actor=bs58.encode(actorPair.publicKey);
  const manifest=mintHouse({origin:ME,seed:77,manifest:{relations:{ordered:1},
    read_auth:{schemes:['popclaw-identity-read-v2']},guide_url:'/guide.md',
    ...(!missingCapability?{world_interaction:{version:1,public_stream:{endpoint:'/v1/world-stream',mode:'public-v1',
      log_incarnation:'fresh_log_1',envelope_baseline:'public-envelope-01',initial_public_scopes:[]}}}: {})}});
  let servedManifest=manifest;
  let snapshotTransform:(items:popclaw.event.IWorldFeedItem[],url:URL)=>Promise<popclaw.event.IWorldFeedItem[]>=async items=>items;
  let worldManifest=mintHouse({origin:WORLD,seed:78,manifest:{relations:{ordered:1},read_auth:{schemes:['popclaw-identity-read-v2']},world_interaction:{version:1,public_stream:{endpoint:'/v1/world-stream',mode:'public-v1',log_incarnation:'world_log_1',envelope_baseline:'public-envelope-01',initial_public_scopes:[]}}}});
  const requests:Array<{url:string;init?:RequestInit}>=[], controllers:ReadableStreamDefaultController<Uint8Array>[]=[];
  const fakeFetch=vi.fn<typeof fetch>(async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input)); requests.push({url:url.href,init});
    if(url.origin===WORLD && url.pathname==='/v1/manifest') return worldManifest.fetch(url.href);
    if(url.origin!==ME && !(url.origin===WORLD&&url.pathname==='/world-feed')) throw new Error('UNEXPECTED_NETWORK:'+url.origin);
    if(url.pathname==='/v1/manifest') return servedManifest.fetch(url.href);
    if(url.pathname==='/guide.md') return new Response('# Synthetic House guide');
    if(url.pathname==='/world-feed') {
      const items = [undefined, {platform:'x',postId:'signed-external',url:'https://x.invalid/signed-external',createdAt:1780000001}].map((origin, i) => {
        const env = popclaw.event.EventEnvelope.fromObject({actor:{popclawId:actor,nickname:'Signed author'},timestamp:1780000000+i,
          post:{blocks:[{blockType:0,content:i ? 'Complete signed mirror body' : 'Complete signed native body'}], ...(origin ? {origin} : {})}});
        const canonical=canonicalizeEnvelope(env);env.eventId=cidFromCanonical(canonical);env.signature=nacl.sign.detached(canonical,actorPair.secretKey);
        return {eventId:env.eventId,platform:origin?.platform??'popclaw',platformPostId:origin?.postId??env.eventId,
          textPreview:'Untrusted relay preview',authorPopclawId:'Unsigned relay author',envelope:popclaw.event.EventEnvelope.encode(env).finish()};
      });
      const filtered=items.filter(item=>(!url.searchParams.has('platform')||item.platform===url.searchParams.get('platform'))
        &&(!url.searchParams.has('author')||popclaw.event.EventEnvelope.decode(item.envelope).actor?.popclawId===url.searchParams.get('author')));
      const transformed=await snapshotTransform(filtered,url);
      return new Response(new Uint8Array(popclaw.event.WorldFeedSnapshot.encode({items:transformed}).finish()).buffer, {headers:{'content-type':'application/x-protobuf'}});
    }
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
  if(rootMode==='new') {
    // The first tested entry, not fixture setup, must create every runtime file.
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(paths.socialDb())).toBe(false);
    expect(existsSync(paths.dataProfileFile())).toBe(false);
    expect(existsSync(paths.executionDir())).toBe(false);
    expect(existsSync(paths.lorehousesDir())).toBe(false);
    expect(existsSync(join(paths.identityDir(),'master.key'))).toBe(false);
  }
  let rt=await build(); cleanup.push(()=>rt.shutdown());
  if(rootMode==='new') {
    expect(rt.boot.identityGenerated).toBe(true);
    expect(JSON.parse(readFileSync(paths.dataProfileFile(),'utf8'))).toMatchObject({generation:1,actorId:rt.boot.popclawId});
  }
  const send=(type:string,bytes:Uint8Array)=>controllers.at(-1)!.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${Buffer.from(bytes).toString('base64')}\n\n`));
  return {paths,requests,controllers,send,build, get rt(){return rt;},setRuntime(value:Runtime){rt=value;},actorPair,actor,
    setSnapshot:(transform:typeof snapshotTransform)=>{snapshotTransform=transform;},setManifest:(next:typeof manifest)=>{servedManifest=next;},setWorldManifest:(next:typeof manifest)=>{worldManifest=next;}};
}

it.each(['Native','MCP'] as const)('%s normal unset first install reads ordinary me signed native and mirror feed without a World board', async kind => {
  const f=await fixture(kind,true,'new');
  expect(await f.rt.houseRuntime.activateInitialMe()).toMatchObject({admission:'configured'});
  const observed=(await f.rt.houseFeedReader!.prepare()).read();
  expect(observed.sources,JSON.stringify(observed.sources)).toMatchObject([{unavailable:false}]);
  const tools = new Map<string, {execute(id:string,params:unknown):Promise<{text:string}>}>();
  registerFeedTools({runtime:async()=>f.rt,deps:{api:{registerTool:(tool: {name:string;execute(id:string,params:unknown):Promise<{text:string}>})=>tools.set(tool.name,tool)},
    runCommand:<T>(work:()=>Promise<T>)=>f.rt.houseRuntime.runCommand(work)}} as unknown as ToolsCtx);
  const result=await tools.get('popclaw_show_feed')!.execute('ordinary-first-feed',{limit:20});
  expect(result.text).toContain('Complete signed native body');
  expect(result.text).toContain('Complete signed mirror body');
  expect(result.text).not.toContain('Untrusted relay preview');
  expect(result.text).not.toContain('Unsigned relay author');
  const byName=await tools.get('popclaw_show_feed')!.execute('ordinary-author',{filter_by_author:'Signed author'});
  expect(byName.text).toContain('Complete signed native body');
  expect(byName.text).not.toContain('Complete signed mirror body');
  const notObserved=await tools.get('popclaw_show_feed')!.execute('ordinary-unknown-author',{filter_by_author:'Unobserved author'});
  expect(notObserved.text).toMatch(/profile|资料/);expect(notObserved.text).not.toContain('Use the full author ID');
  const search=await tools.get('popclaw_search_feed')!.execute('ordinary-search',{query:'signed mirror'});
  expect(search.text).toContain('Complete signed mirror body');
  expect(search.text).toContain('https://x.invalid/signed-external');
  expect(search.text).not.toContain('Complete signed native body');
  expect(f.requests.some(r=>new URL(r.url).pathname==='/world-feed')).toBe(true);
  expect(f.requests.some(r=>new URL(r.url).pathname==='/v1/house-session')).toBe(false);
  expect(readParticipation(f.rt.host.db,WORLD)).toBeNull();
  const db=executionDbFor(await f.rt.houseRuntime.storeForCommand(ME));
  expect(db.queryAll('SELECT * FROM world_public_frames_v1')).toEqual([]);
  expect(db.queryAll('SELECT * FROM world_public_bindings_v1')).toEqual([]);
});

it('ordinary author history and body reference share the signed reader and exact House source',async()=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();_observedPostIdsForTest.clear();
  cleanup.push(()=>_observedPostIdsForTest.clear());
  const tools=new Map<string,{execute(id:string,params:unknown):Promise<{text:string}>}>();
  const api={registerTool:(tool:{name:string;execute(id:string,params:unknown):Promise<{text:string}>})=>tools.set(tool.name,tool)};
  registerWorldTools({api,runtime:async()=>f.rt,deps:{api,
    runCommand:<T>(work:()=>Promise<T>)=>f.rt.houseRuntime.runCommand(work),getWorldDeps:async()=>({snapshotClient:f.rt.worldFeedClient,
      summaryClient:{fetchSummary:async()=>null},resolveClient:{resolve:async()=>[]},guideClient:{fetchGuideText:async()=>null},webBaseUrl:f.rt.boot.webBaseUrl})}} as unknown as ToolsCtx);
  const history=await tools.get('popclaw_author_latest')!.execute('ordinary-history',{name:'Signed author',count:10});
  expect(history.text).toContain('Complete signed native body');expect(history.text).not.toContain('Untrusted relay preview');
  const [item]=await f.rt.worldFeedClient.fetchSnapshot({author:f.actor,limit:1});
  const ref=await resolvePostRefWithSource(item!.eventId!.slice(0,10),{webBaseUrl:f.rt.boot.webBaseUrl,cache:f.rt.worldFeedCache});
  expect(ref).toMatchObject({ok:true,source:{authorPopclawId:f.actor,textPreview:'Complete signed native body',houseSlug:'house-popclaw-me'}});
});

it('ordinary same-name signed authors ask for a person or link without demanding an internal ID',async()=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  f.setSnapshot(async items=>{
    const pair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(90));
    const env=popclaw.event.EventEnvelope.decode(items[0]!.envelope!);env.actor!.popclawId=bs58.encode(pair.publicKey);
    const canonical=canonicalizeEnvelope(env);env.eventId=cidFromCanonical(canonical);env.signature=nacl.sign.detached(canonical,pair.secretKey);
    return [...items,{envelope:popclaw.event.EventEnvelope.encode(env).finish()}];
  });
  const tools=new Map<string,{execute(id:string,params:unknown):Promise<{text:string}>}>();
  registerFeedTools({runtime:async()=>f.rt,deps:{api:{registerTool:(tool:{name:string;execute(id:string,params:unknown):Promise<{text:string}>})=>tools.set(tool.name,tool)}}} as unknown as ToolsCtx);
  const response=await tools.get('popclaw_show_feed')!.execute('same-name',{filter_by_author:'Signed author'});
  expect(response.text).toMatch(/profile|资料/);expect(response.text).not.toContain('Use the full author ID');
  expect(response.text).not.toContain('Complete signed native body');
});

it('ordinary newspaper collection keeps signed originals beyond the display 100-item cap',async()=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  f.setSnapshot(async items=>Array.from({length:120},(_,i)=>{
    const env=popclaw.event.EventEnvelope.decode(items[0]!.envelope!);env.timestamp=1780000000+i;
    env.post!.blocks![0]!.content=`Full signed material ${i}`;
    const canonical=canonicalizeEnvelope(env);env.eventId=cidFromCanonical(canonical);env.signature=nacl.sign.detached(canonical,f.actorPair.secretKey);
    return {envelope:popclaw.event.EventEnvelope.encode(env).finish()};
  }));
  expect((await f.rt.houseFeedReader!.prepare()).read({limit:100}).items).toHaveLength(100);
  const batch=await publicMaterialSource(f.rt)!.prepareCollect();expect(batch.items).toHaveLength(120);expect(batch.references).toHaveLength(120);
  expect(batch.items.some(item=>item.body==='Full signed material 0')).toBe(true);
  expect(batch.coverage).toMatchObject([{incomplete:true,unavailable:false}]);
});

it('ordinary write refusal rolls back source persistence and never publishes ephemeral success',async()=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  const store=await f.rt.houseRuntime.storeForCommand(ME),actual=store.db.execute.bind(store.db);
  vi.spyOn(store.db,'execute').mockImplementation((sql,params)=>{if(sql.startsWith('INSERT OR REPLACE INTO world_feed'))throw new Error('STORAGE_WRITE_REFUSED');return actual(sql,params);});
  const result=(await f.rt.houseFeedReader!.prepare()).read();expect(result).toMatchObject({items:[],sources:[{unavailable:true}]});
  expect(store.db.queryAll('SELECT * FROM world_feed')).toEqual([]);
});

it('ordinary consumer storage hold during await refuses content and persistence',async()=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  f.setSnapshot(async items=>{publishStorageJson(f.paths.storageControlFile(),{version:1,epoch:'ordinary-held',mode:'recovery',reason:'test hold',held:['consumers'],releases:{}});return items;});
  expect((await f.rt.houseFeedReader!.prepare()).read()).toMatchObject({items:[],sources:[{unavailable:true}]});
  expect((await f.rt.houseRuntime.storeForCommand(ME)).db.queryAll('SELECT * FROM world_feed')).toEqual([]);
});

it.each(['origin','key','incarnation','malformed-board'] as const)('ordinary selection refuses a signed %s conflict before any snapshot request',async fault=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  f.setManifest(mintHouse({origin:fault==='origin'?WORLD:ME,seed:fault==='key'?99:77,incarnation:fault==='incarnation'?'new-incarnation':'1',
    manifest:{relations:{ordered:1},read_auth:{schemes:['popclaw-identity-read-v2']},...(fault==='malformed-board'?{world_interaction:{version:1,public_stream:'invalid'}}:{})}}));
  const before=f.requests.filter(r=>new URL(r.url).pathname==='/world-feed').length;
  expect((await f.rt.houseFeedReader!.prepare()).read()).toMatchObject({items:[],sources:[{unavailable:true}]});
  expect(f.requests.filter(r=>new URL(r.url).pathname==='/world-feed')).toHaveLength(before);
});

it('ordinary readonly cache permits bounded reading but refuses durable newspaper materials',async()=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  const store=await f.rt.houseRuntime.storeForCommand(ME);Object.defineProperty(store,'cacheReadOnly',{value:true});
  expect((await f.rt.houseFeedReader!.prepare()).read().items).toHaveLength(2);
  expect(store.db.queryAll('SELECT * FROM world_feed')).toEqual([]);
  const batch=await publicMaterialSource(f.rt)!.prepareCollect();expect(batch.items).toEqual([]);
  expect(batch.coverage).toMatchObject([{unavailable:true,code:'ORDINARY_NEWSPAPER_CACHE_READ_ONLY'}]);
});

it('multiple ordinary Houses preserve actual origins, dedupe signed CIDs and never rename an external mirror to a native author',async()=>{
  const f=await fixture('MCP',true,'current');await f.rt.houseRuntime.activateInitialMe();
  f.setWorldManifest(mintHouse({origin:WORLD,seed:78,manifest:{relations:{ordered:1},read_auth:{schemes:['popclaw-identity-read-v2']}}}));
  expect(await f.rt.houseRuntime.commands.loginHouse(WORLD)).toMatchObject({admission:'configured'});
  const result=(await f.rt.houseFeedReader!.prepare()).read();
  expect(result.sources).toMatchObject([{origin:ME,unavailable:false},{origin:WORLD,unavailable:false}]);
  expect(result.items).toHaveLength(2);expect(result.items.every(hit=>hit.alsoInHouses?.includes('house-popclaw-world'))).toBe(true);
  const mirror=result.items.find(hit=>hit.mirrorSigner)!;
  expect(mirror.item).toMatchObject({authorPopclawId:'',platform:'x',originalUrl:'https://x.invalid/signed-external'});
  expect(result.items.every(hit=>hit.source.origin===ME)).toBe(true);
});

it('ordinary prepared displays remain call-bound while concurrent native and mirror requests finish in reverse order',async()=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),held=new Promise<void>(r=>release=r);
  f.setSnapshot(async(items,url)=>{if(url.searchParams.get('platform')==='popclaw'){started();await held;}return items;});
  const slow=f.rt.houseFeedReader!.prepare({platform:'popclaw'});await entered;
  const fast=await f.rt.houseFeedReader!.prepare({platform:'x'});release();const native=await slow;
  expect(native.read().items.map(i=>i.body)).toEqual(['Complete signed native body']);
  expect(fast.read().items.map(i=>i.body)).toEqual(['Complete signed mirror body']);
  expect(native.search('mirror').items).toEqual([]);expect(fast.search('native').items).toEqual([]);
});

it.each(['missing','bad-signature','private'] as const)('ordinary %s envelope refuses content before cache effects',async fault=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  f.setSnapshot(async items=>items.map(item=>{
    if(fault==='missing')return {...item,envelope:undefined};
    const env=popclaw.event.EventEnvelope.decode(item.envelope!);
    if(fault==='bad-signature')env.signature![0]=env.signature![0]!^255;
    else {env.post=undefined;env.directMessage={fromPopclawId:f.actor,toPopclawId:f.actor,encryptedBody:new Uint8Array([1])} as never;
      const canonical=canonicalizeEnvelope(env);env.eventId=cidFromCanonical(canonical);env.signature=nacl.sign.detached(canonical,f.actorPair.secretKey);}
    return {...item,envelope:popclaw.event.EventEnvelope.encode(env).finish()};
  }));
  const prepared=await f.rt.houseFeedReader!.prepare();expect(prepared.read()).toMatchObject({items:[],sources:[{unavailable:true}]});
  const store=await f.rt.houseRuntime.storeForCommand(ME);expect(store.db.queryAll('SELECT * FROM world_feed')).toEqual([]);
});

it.each(['leave','pin'] as const)('ordinary %s change during snapshot await publishes no content and writes no cache rows',async change=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  f.setSnapshot(async items=>{entered();await held;return items;});
  const reading=f.rt.houseFeedReader!.prepare();await started;
  if(change==='leave')await f.rt.houseRuntime.commands.logoutHouse(ME);
  else f.rt.host.db.execute("UPDATE house_binding_pin SET blocked_reason='HOUSE_KEY_CHANGED',revision=revision+1 WHERE origin=?",[ME]);
  release();const prepared=await reading;
  expect(prepared.read()).toMatchObject({items:[],sources:[{unavailable:true}]});
  const store=await f.rt.houseRuntime.storeForCommand(ME);expect(store.db.queryAll('SELECT * FROM world_feed')).toEqual([]);
});

it('a positively declared public-v1 journal refusal never requests an ordinary snapshot',async()=>{
  const f=await fixture('MCP',false,'new');await f.rt.houseRuntime.activateInitialMe();
  const store=await f.rt.houseRuntime.storeForCommand(ME);
  const before=f.requests.filter(r=>new URL(r.url).pathname==='/world-feed').length;
  executionDbFor(store).execute('DROP TABLE world_public_frames_v1');
  const prepared=await f.rt.houseFeedReader!.prepare();expect(prepared.read()).toMatchObject({items:[],sources:[{unavailable:true}]});
  expect(f.requests.filter(r=>new URL(r.url).pathname==='/world-feed')).toHaveLength(before);
});

it.each(['core','board'] as const)('a newer signed same-key %s manifest fences a held ordinary snapshot before display and cache effects',async change=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  f.setSnapshot(async items=>{entered();await held;return items;});
  const slow=f.rt.houseFeedReader!.prepare();await started;
  f.setManifest(mintHouse({origin:ME,seed:77,manifest:{relations:{ordered:1},read_auth:{schemes:['popclaw-identity-read-v2']},guide_url:'/guide.md',
    ...(change==='core'?{core_primitives:{follow:false,profile:true,directed_delivery:true}}:{world_interaction:{version:1}})}}));
  const newer=(await f.rt.houseFeedReader!.prepare()).read();expect(newer.sources).toMatchObject([{unavailable:true}]);
  release();const older=(await slow).read();expect(older).toMatchObject({items:[],sources:[{unavailable:true}]});
  expect((await f.rt.houseRuntime.storeForCommand(ME)).db.queryAll('SELECT * FROM world_feed')).toEqual([]);
});

it.each(['core','board'] as const)('ordinary durable newspaper evidence refuses a newer full %s manifest across restart',async change=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();const {issue,source}=await ordinaryIssue(f);
  f.setManifest(mintHouse({origin:ME,seed:77,manifest:{relations:{ordered:1},read_auth:{schemes:['popclaw-identity-read-v2']},guide_url:'/guide.md',
    ...(change==='core'?{core_primitives:{follow:false,profile:true,directed_delivery:true}}:{world_interaction:{version:1}})}}));
  expect((await f.rt.houseFeedReader!.prepare()).read().sources).toMatchObject([{unavailable:true}]);
  expect(()=>source.validate(issue)).toThrow();
  await f.rt.shutdown();f.setRuntime(await f.build());expect(()=>publicMaterialSource(f.rt)!.validate(issue)).toThrow();
});

it('prepared public-v1 search preserves the existing journal kind and multi-term search semantics',async()=>{
  const f=await fixture('MCP',false,'new');await f.rt.houseRuntime.activateInitialMe();
  await vi.waitFor(()=>expect(f.controllers).toHaveLength(1));
  const store=await f.rt.houseRuntime.storeForCommand(ME),db=executionDbFor(store);
  const env=popclaw.event.EventEnvelope.fromObject({actor:{popclawId:f.actor,nickname:'Synthetic author'},timestamp:1780000000,post:{blocks:[{blockType:0,content:'Verified fresh material'}]}});
  const canonical=canonicalizeEnvelope(env);env.eventId=cidFromCanonical(canonical);env.signature=nacl.sign.detached(canonical,f.actorPair.secretKey);
  f.send('public_boundary',popclaw.world.PublicStreamBoundary.encode({logIncarnation:'fresh_log_1',fullPublic:true,highWaterSeq:1}).finish());
  f.send('public_frame',popclaw.event.WorldStreamFrame.encode({seq:1,envelope:popclaw.event.EventEnvelope.encode(env).finish(),kind:'post',scopes:[]}).finish());
  f.send('public_checkpoint',popclaw.world.PublicStreamCheckpoint.encode({phase:'replay',publicThroughSeq:1}).finish());
  await vi.waitFor(()=>expect(db.queryOne('SELECT event_id FROM world_public_events_v1')).toEqual({event_id:env.eventId}));
  expect(f.rt.publicFeedDisplay!.search('post').items).toHaveLength(1);
  const prepared=await f.rt.publicFeedDisplay!.prepare();
  expect(prepared.search('post').items).toHaveLength(1);expect(prepared.search('post material').items).toHaveLength(1);
});

it('a normal trust refresh, without a feed call, invalidates retained ordinary material on a malformed board observation',async()=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();const {issue,source}=await ordinaryIssue(f);
  f.setManifest(mintHouse({origin:ME,seed:77,manifest:{relations:{ordered:1},read_auth:{schemes:['popclaw-identity-read-v2']},
    guide_url:'/guide.md',world_interaction:null}}));
  const before=f.requests.filter(r=>new URL(r.url).pathname==='/world-feed').length;
  expect(await confirmHouseTrust(f.rt.host.db,ME,{fetch:f.rt.houseRuntime.houseReadFetch(ME)})).toMatchObject({ok:true});
  expect(f.requests.filter(r=>new URL(r.url).pathname==='/world-feed')).toHaveLength(before);
  expect(worldCapabilities.readHouseCapabilityView(f.rt.host.db,ME)).toBeNull();
  expect(f.rt.host.db.queryOne('SELECT active FROM world_capability_current_v1 WHERE origin=?',[ME])).toEqual({active:0});
  expect(()=>source.validate(issue)).toThrow();
});

it.each(['bad-proof','leave','hold'] as const)('ordinary %s during manifest refresh does not retain a new observation',async fault=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();
  const previous=f.rt.host.db.queryAll('SELECT capability_revision FROM world_capability_views_v1');
  const current=f.rt.host.db.queryOne('SELECT capability_revision FROM world_capability_current_v1 WHERE origin=?',[ME]);
  f.setManifest(mintHouse({origin:ME,seed:77,
    ...(fault==='bad-proof'?{signWith:nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(99)).secretKey}:{}),
    manifest:{relations:{ordered:1},read_auth:{schemes:['popclaw-identity-read-v2']},core_primitives:{profile:true,follow:false,directed_delivery:true}}}));
  const fetch=globalThis.fetch;
  vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const result=await fetch(input,init);
    if(String(input).endsWith('/v1/manifest')) {
      if(fault==='leave')await f.rt.houseRuntime.commands.logoutHouse(ME);
      if(fault==='hold')publishStorageJson(f.paths.storageControlFile(),{version:1,epoch:'manifest-held',mode:'recovery',reason:'test hold',held:['consumers'],releases:{}});
    }
    return result;
  });
  expect((await f.rt.houseFeedReader!.prepare()).read()).toMatchObject({items:[],sources:[{unavailable:true}]});
  expect(f.rt.host.db.queryAll('SELECT capability_revision FROM world_capability_views_v1')).toEqual(previous);
  expect(f.rt.host.db.queryOne('SELECT capability_revision FROM world_capability_current_v1 WHERE origin=?',[ME])).toEqual(current);
});

async function ordinaryIssue(f:Awaited<ReturnType<typeof fixture>>){
  const source=publicMaterialSource(f.rt)!,batch=await source.prepareCollect();
  const collected=collectNewspaperMaterials({publicBatch:batch,cache:f.rt.worldFeedCache,inbox:f.rt.inboxStore,ownerNickname:'Owner',
    webBaseUrl:f.rt.boot.webBaseUrl,now:()=>1780000100,mintToken:()=> 'ordinary-issue',isFollowing:()=>false},{hours:24});
  expect(collected.kind).toBe('collected');if(collected.kind!=='collected')throw new Error('NO_SIGNED_MATERIAL');
  const issue=retainPublicMaterialBasis({...collected.draft,language:'en',publicCoverage:batch.coverage},batch.references);
  expect(issue.pulse.map(p=>p.text)).toContain('Complete signed native body');
  expect(issue.pulse.map(p=>p.text)).toContain('Complete signed mirror body');
  expect(batch.coverage).toMatchObject([{incomplete:true,unavailable:false}]);
  source.validate(issue);return {source,issue,batch};
}
it('ordinary newspaper evidence survives a real runtime restart and rejects edited body, replaced original and changed House',async()=>{
  const f=await fixture('MCP',true,'new');await f.rt.houseRuntime.activateInitialMe();const {issue}=await ordinaryIssue(f);
  await f.rt.shutdown();f.setRuntime(await f.build());
  const source=publicMaterialSource(f.rt)!;expect(()=>source.validate(JSON.parse(JSON.stringify(issue)))).not.toThrow();
  const altered=structuredClone(issue);altered.pulse[0]!.text='Unsigned editorial replacement';
  expect(()=>source.validate(altered)).toThrow();
  const wrongHouse=structuredClone(issue);wrongHouse.publicMaterials!.references[0]!.origin=WORLD;
  expect(()=>source.validate(wrongHouse)).toThrow();
  const store=await f.rt.houseRuntime.storeForCommand(ME),row=store.db.queryOne<{raw:Uint8Array}>('SELECT raw FROM world_feed WHERE event_id=?',[issue.pulse[0]!.eventId])!;
  const item=popclaw.event.WorldFeedItem.decode(row.raw),env=popclaw.event.EventEnvelope.decode(item.envelope!);env.signature![0]=env.signature![0]!^255;
  item.envelope=popclaw.event.EventEnvelope.encode(env).finish();store.db.execute('UPDATE world_feed SET raw=? WHERE event_id=?',[popclaw.event.WorldFeedItem.encode(item).finish(),issue.pulse[0]!.eventId]);
  expect(()=>source.validate(issue)).toThrow();
});

it.each([
  {kind:'Native',rootMode:'new'}, {kind:'MCP',rootMode:'new'},
  {kind:'Native',rootMode:'current'}, {kind:'MCP',rootMode:'current'},
] as const)('$kind fresh initial me receives verified public material with no manual switch or maintenance (root=$rootMode)',async({kind,rootMode})=>{
  const f=await fixture(kind,false,rootMode);
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

it.each([['Native','key'],['MCP','key'],['Native','incarnation'],['MCP','incarnation']] as const)('%s refuses a changed trusted binding %s on restart and preserves history',async(kind,change)=>{
  const f=await fixture(kind);
  expect(await f.rt.houseRuntime.activateInitialMe()).toMatchObject({admission:'configured'});
  await vi.waitFor(()=>expect(f.controllers).toHaveLength(1));
  const identity=f.rt.boot.popclawId;
  await f.rt.shutdown();
  const writer=new LocalHostDb(f.paths.socialDb());
  if(change==='key') writer.execute("UPDATE house_binding_pin SET house_key=?,revision=revision+1 WHERE origin=?",[bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(99)).publicKey),ME]);
  else writer.execute("UPDATE house_binding_pin SET incarnation='synthetic-new-house',revision=revision+1 WHERE origin=?",[ME]);
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


it.each(['Native','MCP'] as const)('%s stops old public authority after a running HouseBinding incarnation change',async kind=>{
  const f=await fixture(kind);await f.rt.houseRuntime.activateInitialMe();
  await vi.waitFor(()=>expect(f.controllers).toHaveLength(1));
  const store=await f.rt.houseRuntime.storeForCommand(ME),db=executionDbFor(store);
  const material=f.rt.houseRuntime.capturePublicMaterial(store);
  const identity=f.rt.boot.popclawId;
  const before=db.queryAll('SELECT * FROM world_public_bindings_v1');
  const writer=new LocalHostDb(f.paths.socialDb());
  try {writer.execute("UPDATE house_binding_pin SET incarnation='synthetic-new-house',revision=revision+1 WHERE origin=?",[ME]);}
  finally {writer.close();}
  // The existing MATERIAL gate already rejects this change; keep that evidence.
  expect(()=>material.assertCurrent()).toThrow();
  expect(f.rt.houseRuntime.publicReadStatus(ME).transport).toBe('inactive');
  // A buffered frame on the old HTTP response must not create journal evidence.
  f.send('public_boundary',popclaw.world.PublicStreamBoundary.encode(popclaw.world.PublicStreamBoundary.fromObject({logIncarnation:'fresh_log_1',fullPublic:true,highWaterSeq:'0'})).finish());
  await vi.waitFor(()=>expect(f.requests.find(r=>new URL(r.url).pathname==='/v1/world-stream')!.init?.signal?.aborted).toBe(true),{timeout:4000});
  expect(f.controllers).toHaveLength(1);expect(f.rt.boot.popclawId).toBe(identity);
  expect(db.queryAll('SELECT * FROM world_public_bindings_v1')).toEqual(before);
  expect(db.queryAll('SELECT * FROM world_public_frames_v1')).toEqual([]);
});

it.each(['Native','MCP'] as const)('%s refuses an already captured display after HouseBinding incarnation changes',async kind=>{
  const f=await fixture(kind);await f.rt.houseRuntime.activateInitialMe();
  await vi.waitFor(()=>expect(f.controllers).toHaveLength(1));
  const store=await f.rt.houseRuntime.storeForCommand(ME),display=f.rt.houseRuntime.capturePublicDisplay(store);
  display.assertCurrent();
  const writer=new LocalHostDb(f.paths.socialDb());
  try {writer.execute("UPDATE house_binding_pin SET incarnation='synthetic-new-house',revision=revision+1 WHERE origin=?",[ME]);}
  finally {writer.close();}
  expect(()=>display.assertCurrent()).toThrow();
});
