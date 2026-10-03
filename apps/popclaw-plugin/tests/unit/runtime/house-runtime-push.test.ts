import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { HostAdapter } from '../../../src/host/host-adapter.js';
import { assertHouseActionActive, withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
import { item as feedItem } from '../../helpers/world-feed-cache.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';
import { popclaw } from '@popclaw/contracts';
import { INBOX_TOKEN_HEADER } from '../../../src/identity/read-credential.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { WorldFeedClient } from '../../../src/ingress/world-feed-client.js';
import { GuideClient } from '../../../src/world/guide-client.js';
import { WorldSummaryClient } from '../../../src/world/world-summary-client.js';
import { ResolveClient } from '../../../src/world/resolve-client.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { seedTrustedHouse } from '../../helpers/seed-trusted-house.js';
import { buildSubcommands, type SubcommandWiring } from '../../../src/commands/wiring.js';
import { runStatusSubcommandForTest } from '../../../src/main.js';
const opened=vi.hoisted(()=>vi.fn());
vi.mock('../../../src/runtime/house-lifecycle/resource-set.js',()=>({createHouseStreamFactory:()=>({open:()=>{opened();return {stop:async()=>{}};}})}));
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.reverse())await fn();cleanup.length=0;opened.mockClear();});
/** The house's own words, served over the same unauthenticated GET the
 * second host uses for popclaw_world_guide. */
const GUIDE='---\nworld: Fixture House\nvoice: a test voice\n---\nThe house speaks for itself.';
/** The owner's own profile as the house holds it: a published card and one follower. */
const PROFILE={house_follower_count:1,profiles:[],card:{nickname:'fixture-owner'}};
/** One real, envelope-carrying post — the thing a normal call must come back with. */
const POST='a post the second host must be able to read';
async function fixture(){
 const received:Uint8Array[]=[];
 /** Every unauthenticated GET the house actually saw — method, path, and
  * whether the caller carried anything that could identify it. */
 const reads:Array<{method:string;url:string;credential:boolean}>=[];
 /** `?hold=1` parks the response until the test releases it — the only way to
  * put a leave INSIDE the window of a single in-flight read. */
 const hold={arrived:deferred<void>(),release:deferred<void>()};
 cleanup.push(()=>hold.release.resolve());
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'||req.method==='HEAD'){
   reads.push({method:req.method,url:req.url??'',
    credential:!!(req.headers.authorization??req.headers.cookie??req.headers[INBOX_TOKEN_HEADER.toLowerCase()])});
   if((req.url??'').includes('hold=1')){hold.arrived.resolve();await hold.release.promise;}
   if((req.url??'').startsWith('/v1/guide.md')){res.writeHead(200,{'content-type':'text/markdown'});res.end(GUIDE);return;}
   if((req.url??'').startsWith('/v1/profile/')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(PROFILE));return;}
   res.writeHead(200,{'content-type':'application/x-protobuf'});
   res.end(Buffer.from(popclaw.event.WorldFeedSnapshot.encode({items:[feedItem({textPreview:POST})]}).finish()));return;
  }
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));received.push(Buffer.concat(chunks));res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({event_id:'actual-receipt',task_id:'actual-task'}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const address=server.address();if(!address||typeof address==='string')throw new Error('no address');const origin=`http://127.0.0.1:${address.port}`;
 const dir=mkdtempSync(join(tmpdir(),'runtime-push-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const dbs=[new LocalHostDb(join(dir,'host.db')),new LocalHostDb(join(dir,'host.db'))];cleanup.push(()=>dbs.forEach(d=>d.close()));
 const runtimes=dbs.map(db=>new HouseRuntime({readAuthorityFor: refusingReadAuthorityFor, db,origins:[origin],signer:{} as Signer,commandTimeoutMs:100,commandPollMs:2}));
 for(const rt of runtimes){rt.configureResources({stores:[],host:{} as HostAdapter,recipientPopclawId:'fixture',worldStreamMode:false,openStore:async()=>{throw new Error('unused');},isOfficialActor:()=>false});cleanup.push(()=>rt.stop());}
 return {origin,received,reads,hold,dbs,owner:runtimes[0]!,reader:runtimes[1]!};
}
it('a reader sends exact raw bytes through the resident owner and receives the HTTP receipt',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 expect(s.reader.captureGate(s.origin).isActive()).toBe(false);
 const result=await s.reader.egress.push(new Uint8Array([0,1,255]));
 expect(result).toMatchObject({status:201,eventId:'actual-receipt',taskId:'actual-task'});
 expect(s.received.map(b=>[...b])).toEqual([[0,1,255]]);expect(opened).toHaveBeenCalledTimes(1);
});
it('reader without an owner records a pending operation and never opens the HTTP connection',async()=>{
 const s=await fixture();s.owner.start();await s.owner.stop();s.reader.startReader();
 await expect(s.reader.egress.push(new Uint8Array([2]))).rejects.toMatchObject({result:{status:0,state:'pending'}});expect(s.received).toEqual([]);
});
it('an action captured before logout cannot enqueue after a replacement login',async()=>{
 const s=await fixture();s.owner.start();const captured=s.owner.captureGate(s.origin);
 s.dbs[0]!.execute("UPDATE house_participation SET op_seq=op_seq+2 WHERE house_origin=?",[s.origin]);
 await expect(Promise.resolve().then(()=>withAction(captured,()=>s.owner.egress.push(new Uint8Array([3]))))).rejects.toThrow('no longer active');
 expect(s.received).toEqual([]);expect(s.dbs[0]!.queryAll('SELECT * FROM house_lifecycle_commands')).toEqual([]);
});

const effect=()=>({version:1 as const,kind:'world_direct_dm' as const,requestId:'a'.repeat(64),participationId:'participation',reservationId:'reservation',jobId:'job'});
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}

it('requires owner authority reconstruction for a queued effect',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 await expect(s.reader.withPushEffect(s.origin,effect(),()=>s.reader.egress.push(new Uint8Array([4])))).rejects.toMatchObject({result:{state:'unknown'}});
 expect(s.received).toEqual([]);
});
it('reconstructs the original effect at the actual owner and preserves raw bytes',async()=>{
 const s=await fixture();const checked=vi.fn();const ref=effect();
 s.owner.configurePushEffectResolver(async input=>{
  expect(input.ref).toEqual({...effect(),reservationId:'reservation'});
  expect(input.origin).toBe(s.origin);expect(Object.isFrozen(input.ref)).toBe(true);
  input.bytes.fill(99);await Promise.resolve();return checked;
 });
 s.owner.start();s.reader.startReader();
 const work=s.reader.withPushEffect(s.origin,ref,()=>s.reader.egress.push(new Uint8Array([4,0,255])));
 ref.reservationId='changed';
 expect(await work).toMatchObject({status:201});expect(s.received.map(b=>[...b])).toEqual([[4,0,255]]);
 expect(checked.mock.calls.length).toBeGreaterThanOrEqual(3);
});
it.each(['revoke','logout','session'])('rejects %s while original effect authority is being prepared',async change=>{
 const s=await fixture();const entered=deferred<void>(),release=deferred<void>();cleanup.push(()=>release.resolve());
 s.dbs[0]!.execute('CREATE TABLE fixture_effect_authority(active INTEGER)');s.dbs[0]!.execute('INSERT INTO fixture_effect_authority VALUES(1)');
 s.owner.configurePushEffectResolver(async()=>{entered.resolve();await release.promise;return ()=>{
  if (s.dbs[0]!.queryOne<{active:number}>('SELECT active FROM fixture_effect_authority')?.active!==1)throw new Error('REVOKED');
 };});
 s.owner.start();s.reader.startReader();
 const work=s.reader.withPushEffect(s.origin,effect(),()=>s.reader.egress.push(new Uint8Array([5])));
 const rejected=expect(work).rejects.toMatchObject({result:{state:'unknown'}});
 await entered.promise;
 if(change==='revoke')s.dbs[1]!.execute('UPDATE fixture_effect_authority SET active=0');
 else if(change==='logout')s.dbs[1]!.execute("UPDATE house_participation SET desired='disabled',op_seq=op_seq+1 WHERE house_origin=?",[s.origin]);
 else s.dbs[1]!.execute('UPDATE house_participation SET op_seq=op_seq+2 WHERE house_origin=?',[s.origin]);
 release.resolve();await rejected;expect(s.received).toEqual([]);
});
it('stop joins the actual authority preparation and never sends its late result',async()=>{
 const s=await fixture();const entered=deferred<void>(),release=deferred<void>();cleanup.push(()=>release.resolve());
 s.owner.configurePushEffectResolver(async()=>{entered.resolve();await release.promise;s.dbs[0]!.queryOne('SELECT 1');return ()=>{};});
 s.owner.start();s.reader.startReader();
 const work=s.reader.withPushEffect(s.origin,effect(),()=>s.reader.egress.push(new Uint8Array([6])));
 const rejected=expect(work).rejects.toMatchObject({result:{state:'unknown'}});
 await entered.promise;let drained=false;const stop=s.owner.stop().then(()=>{drained=true;});
 await Promise.resolve();expect(drained).toBe(false);release.resolve();await stop;await rejected;
 expect(s.received).toEqual([]);
});
it.each(['async','nonfunction'])('refuses a %s final checker without HTTP',async kind=>{
 const s=await fixture();s.owner.configurePushEffectResolver(async()=>kind==='async' ? (async()=>{throw new Error('LATE_AUTHORITY_FAILURE');}) : undefined as never);
 s.owner.start();s.reader.startReader();
 await expect(s.reader.withPushEffect(s.origin,effect(),()=>s.reader.egress.push(new Uint8Array([7])))).rejects.toMatchObject({result:{state:'unknown'}});
 await new Promise(r=>setImmediate(r));expect(s.received).toEqual([]);
});
it('keeps enclosing effect constraints and rejects an unrelated target before enqueue',async()=>{
 const s=await fixture();s.owner.start();const ref=effect();
 expect(()=>s.reader.withPushEffect(s.origin,ref,()=>s.reader.withPushEffect(s.origin,{...ref,jobId:'other'},()=>{}))).toThrow('SCOPE_MISMATCH');
 await expect(s.reader.withPushEffect('https://other.invalid',ref,()=>s.reader.egress.push(new Uint8Array([8])))).rejects.toThrow('ORIGIN_MISMATCH');
 expect(s.dbs[0]!.queryAll('SELECT * FROM house_lifecycle_commands')).toEqual([]);expect(s.received).toEqual([]);
});
// ---------------------------------------------------------------------------
// The public READ lane. The lifecycle lease decides who owns streams, renewal
// and egress; it was also deciding who may perform an unauthenticated GET, so
// a second host on the same data root could not read the house at all while
// the gateway was up (docs/hosts.md promises the two coordinate).
// ---------------------------------------------------------------------------
function fakeApi(){
 const tools:Array<{name:string;execute:(callId:string,params:unknown)=>Promise<{text:string}>}>=[];
 const api={registerTool:(tool:unknown)=>{
  const resolved=typeof tool==='function'?(tool as (ctx:unknown)=>unknown)({agentId:'main-agent',config:{}}):tool;
  for(const t of Array.isArray(resolved)?resolved:[resolved]){
   if((t as{name?:string}|null)?.name&&typeof (t as{execute?:unknown}).execute==='function')tools.push(t as typeof tools[number]);
  }}} as Parameters<typeof registerPopclawTools>[0]['api'];
 return {api,tools};
}
async function toolText(tools:ReturnType<typeof fakeApi>['tools'],name:string,params:unknown={}):Promise<string>{
 const tool=tools.find(t=>t.name===name);if(!tool)throw new Error(`tool not found: ${name}`);
 return (await tool.execute('call',params)).text;
}
/** A person the bond book already knows, so resolution never needs the house. */
const PERSON_ID='2'.repeat(44),PERSON_NAME='Alice';
/** The tools a non-owning host reads with, wired exactly as its root wires them:
 * all five house-reading tools off the same read lane. */
function readerTools(s:Awaited<ReturnType<typeof fixture>>){
 const {api,tools}=fakeApi();
 cleanup.push(()=>{setOwnerLang('en','config');});
 const read=()=>s.reader.houseReadFetch(s.origin);
 const rt={boot:{loreHouseUrl:s.origin},houseRuntime:s.reader,
  worldFeedClient:new WorldFeedClient({baseUrl:s.origin,fetch:read()}),
  bondsStore:{list:()=>[{popclawId:PERSON_ID,nickname:PERSON_NAME,remarkName:''}]}};
 const wd={guideClient:new GuideClient({baseUrl:s.origin,fetch:read()}),
  summaryClient:new WorldSummaryClient({baseUrl:s.origin,fetch:read()}),
  snapshotClient:new WorldFeedClient({baseUrl:s.origin,fetch:read()}),
  resolveClient:new ResolveClient({baseUrl:s.origin,fetch:read()}),
  webBaseUrl:'https://popclaw.invalid'};
 registerPopclawTools({api,runtime:(async()=>rt) as never,getWorldDeps:(async()=>wd) as never});
 return tools;
}
it('a second host reads the house beside the resident owner, then leaves it reading',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 // Which gate refused, precisely: the participation gate every command
 // captures PASSES on the reader (it is joined — same durable rows), and the
 // ownership-epoch gate is the one that is permanently shut. Nothing here is
 // cancelled or torn down: this is the normal shape of a second-host call.
 await expect(s.reader.runCommand(async()=>{assertHouseActionActive(s.origin);return 'joined';})).resolves.toBe('joined');
 expect(s.reader.captureGate(s.origin).isActive()).toBe(false);
 const res=await s.reader.runCommand(()=>s.reader.houseReadFetch(s.origin)(`${s.origin}/world-feed?limit=2`,{headers:{accept:'application/x-protobuf'}}));
 expect(res.status).toBe(200);
 expect(s.reads).toEqual([{method:'GET',url:'/world-feed?limit=2',credential:false}]);
 expect(s.received).toEqual([]);expect(opened).toHaveBeenCalledTimes(1);
 // The short-lived host goes away; the resident owner is untouched by its visit.
 await s.reader.stop();
 expect(s.owner.captureGate(s.origin).isActive()).toBe(true);
 expect((await s.owner.runCommand(()=>s.owner.houseFetch(s.origin)(`${s.origin}/world-feed`))).status).toBe(200);
 expect(opened).toHaveBeenCalledTimes(1);
});
it('the public read stops the moment another process leaves the house',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 // Two callers, because they are refused by two different things: inside a
 // command the enclosing captured participation refuses, and BARE — the shape
 // every long-lived read client actually has, constructed once at boot — the
 // read gate itself is the only thing left to refuse. Both are control-grouped
 // against the same call succeeding a line earlier.
 const inCommand=()=>s.reader.runCommand(()=>s.reader.houseReadFetch(s.origin)(`${s.origin}/world-feed`));
 const bare=s.reader.houseReadFetch(s.origin);
 expect((await inCommand()).status).toBe(200);
 expect((await bare(`${s.origin}/world-feed`)).status).toBe(200);
 s.dbs[0]!.execute("UPDATE house_participation SET desired='disabled',op_seq=op_seq+1 WHERE house_origin=?",[s.origin]);
 await expect(inCommand()).rejects.toThrow('no longer active');
 await expect(bare(`${s.origin}/world-feed`)).rejects.toThrow('no longer active');
 expect(s.reads).toHaveLength(2);
});
it('an in-flight public read is refused when the leave lands mid-request',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 // The bare client re-captures the row per request, so only a leave INSIDE
 // the flight can exercise the gate's cross-process re-read. The response is
 // parked at the server; the leave is written by the other process; the read
 // must die on the way back, not hand back a body from a house this machine
 // no longer belongs to.
 const inFlight=s.reader.houseReadFetch(s.origin)(`${s.origin}/world-feed?hold=1`);
 await s.hold.arrived.promise;
 s.dbs[0]!.execute("UPDATE house_participation SET desired='disabled',op_seq=op_seq+1 WHERE house_origin=?",[s.origin]);
 s.hold.release.resolve();
 await expect(inFlight).rejects.toThrow('no longer active');
 expect(s.reads).toEqual([{method:'GET',url:'/world-feed?hold=1',credential:false}]);
});
it('the same in-flight read completes when nothing leaves the house',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 const inFlight=s.reader.houseReadFetch(s.origin)(`${s.origin}/world-feed?hold=1`);
 await s.hold.arrived.promise;s.hold.release.resolve();
 expect((await inFlight).status).toBe(200);
});
const BOUND_KEY='aa'.repeat(32),OTHER_KEY='bb'.repeat(32);
it('the public read keeps the pin-conflict wall: a pinned house whose binding disagrees stays unreadable',async()=>{
 const s=await fixture();s.owner.start();
 // Make the seeded row session-carrying, which is what puts it in pin scope
 // (a legacy row carries no trusted key and manager.gateFor exempts it).
 s.dbs[0]!.execute('UPDATE house_participation SET session_id=?,lease_expires_at=?,ack_key_hex=? WHERE house_origin=?',
  ['s1',Math.floor(Date.now()/1000)+3600,BOUND_KEY,s.origin]);
 const reader=(pin:string)=>{
  const rt=new HouseRuntime({readAuthorityFor:refusingReadAuthorityFor,db:s.dbs[1]!,origins:[s.origin],signer:{} as Signer,
   commandTimeoutMs:100,commandPollMs:2,configuredPinFor:()=>pin});
  rt.configureResources({stores:[],host:{} as HostAdapter,recipientPopclawId:'fixture',worldStreamMode:false,
   openStore:async()=>{throw new Error('unused');},isOfficialActor:()=>false});
  cleanup.push(()=>rt.stop());rt.startReader();return rt;
 };
 // Control group: the same second host, same row, pinned to what the binding
 // actually says — it reads.
 expect((await reader(BOUND_KEY).houseReadFetch(s.origin)(`${s.origin}/world-feed`)).status).toBe(200);
 await expect(reader(OTHER_KEY).houseReadFetch(s.origin)(`${s.origin}/world-feed`)).rejects.toThrow('no longer active');
 // Hex CASE of the BINDING counts, because it counts on the owner lane:
 // manager.gateFor normalises only the configured pin and compares the row
 // raw. Normalising both sides here (as a first cut did) left this read open
 // on a binding that closes every owner gate — the read lane must never be
 // the more permissive of the two, so it borrows that comparison.
 s.dbs[0]!.execute('UPDATE house_participation SET ack_key_hex=? WHERE house_origin=?',[BOUND_KEY.toUpperCase(),s.origin]);
 await expect(reader(BOUND_KEY).houseReadFetch(s.origin)(`${s.origin}/world-feed`)).rejects.toThrow('no longer active');
 expect(s.reads).toHaveLength(1);
});
it('the public read lane refuses a write, a credential and another audience',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 const read=s.reader.houseReadFetch(s.origin);
 await expect(read(`${s.origin}/world-feed`,{method:'POST',body:new Uint8Array([1])})).rejects.toThrow('HOUSE_READ_METHOD_NOT_ALLOWED');
 await expect(read(`${s.origin}/v1/inbox`,{headers:{[INBOX_TOKEN_HEADER]:'token'}})).rejects.toThrow('HOUSE_READ_CREDENTIAL_REFUSED');
 await expect(read(`${s.origin}/world-feed`,{headers:{authorization:'Bearer token'}})).rejects.toThrow('HOUSE_READ_CREDENTIAL_REFUSED');
 await expect(read(`${s.origin}/world-feed`,{headers:{cookie:'a=b'}})).rejects.toThrow('HOUSE_READ_CREDENTIAL_REFUSED');
 // A credential on a Request object, with a non-nullish init.headers beside
 // it: the platform silently drops it, which is not the same as refusing it.
 // The caller asked to send one, and is told it cannot.
 await expect(read(new Request(`${s.origin}/world-feed`,{headers:{authorization:'Bearer token'}}),
  {headers:{accept:'application/x-protobuf'}})).rejects.toThrow('HOUSE_READ_CREDENTIAL_REFUSED');
 await expect(read('https://elsewhere.invalid/world-feed')).rejects.toThrow('HOUSE_AUDIENCE_MISMATCH');
 expect(s.reads).toEqual([]);expect(s.received).toEqual([]);
});
it('show_feed and world_guide answer on a non-owning host without naming an exception class',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 const tools=readerTools(s);
 for(const lang of ['en','zh-CN'] as const){
  setOwnerLang(lang,'config');
  const feed=await toolText(tools,'popclaw_show_feed');
  expect(feed).not.toContain('ActionInactiveError');
  expect(feed).toContain(POST);
  expect(await toolText(tools,'popclaw_world_guide')).toContain('Fixture House');
 }
 expect(s.reads.map(r=>r.credential)).toEqual([false,false,false,false]);
 expect(s.received).toEqual([]);
});
it('a house this machine has left is explained in the owner language, naming no class and no slash command',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 const tools=readerTools(s);
 s.dbs[0]!.execute("UPDATE house_participation SET desired='disabled',op_seq=op_seq+1 WHERE house_origin=?",[s.origin]);
 for(const lang of ['en','zh-CN'] as const){
  setOwnerLang(lang,'config');
  const text=await toolText(tools,'popclaw_show_feed');
  expect(text).toBe(renderCopy(lang,'house.read.disabled',{origin:s.origin}));
  expect(text).not.toContain('ActionInactiveError');expect(text).not.toContain('/popclaw');
  // The namecard said the lore-house was unreachable and handed the owner the
  // exception class with it, from a catch outside the lexicon that the repo's
  // ledger-#010 ratchet cannot see. Same fact, same sentence, same locales.
  const card=await toolText(tools,'popclaw_show_namecard',{person:PERSON_NAME});
  expect(card).toBe(renderCopy(lang,'world.read.notJoined'));
 }
 expect(s.reads).toEqual([]);
});
it('none of the five re-routed tools lets the exception class reach the owner on a left house',async()=>{
 const s=await fixture();s.owner.start();s.reader.startReader();
 const tools=readerTools(s);
 s.dbs[0]!.execute("UPDATE house_participation SET desired='disabled',op_seq=op_seq+1 WHERE house_origin=?",[s.origin]);
 const calls:Array<[string,unknown]>=[['popclaw_show_feed',{}],['popclaw_world_guide',{}],
  ['popclaw_world_summary',{}],['popclaw_author_latest',{name:PERSON_NAME}],['popclaw_show_namecard',{person:PERSON_NAME}]];
 for(const lang of ['en','zh-CN'] as const){
  setOwnerLang(lang,'config');
  for(const [name,params] of calls){
   const text=await toolText(tools,name,params);
   // Not vacuous: each tool DOES answer, and what it answers says nothing
   // about the machinery underneath.
   expect(text.length).toBeGreaterThan(0);
   expect(text,name).not.toContain('ActionInactiveError');
   expect(text,name).not.toContain('House action is no longer active');
  }
 }
 expect(s.reads).toEqual([]);expect(s.received).toEqual([]);
});
it('an effect scope snapshots before asynchronous work and permits only the exact nested reference',async()=>{
 const s=await fixture();s.owner.configurePushEffectResolver(input=>{expect(input.ref).toEqual(effect());return ()=>{};});s.owner.start();
 const ref=effect();const entered=deferred<void>(),release=deferred<void>();cleanup.push(()=>release.resolve());
 const work=s.reader.withPushEffect(s.origin,ref,async()=>{entered.resolve();await release.promise;return s.reader.withPushEffect(s.origin,effect(),()=>s.reader.egress.push(new Uint8Array([9])));});
 await entered.promise;ref.jobId='changed';release.resolve();expect(await work).toMatchObject({status:201});expect(s.received).toHaveLength(1);
});
// ---------------------------------------------------------------------------
// Status on a second host (R17-D1). The profile read behind the identity block
// is the same unauthenticated GET as the namecard; routed through the OWNER
// lane it died with ActionInactiveError before leaving the process, and the
// status page filed that as "the lore-house is down" next to a ✅ house row.
// ---------------------------------------------------------------------------
/** A second host beside the resident owner, trusting the live fixture house
 * (so the ✅ house row is on the same screen), with a runtime shaped the way
 * every status entry point reads it. */
async function statusOnSecondHost(){
 const s=await fixture();s.owner.start();s.reader.startReader();
 const dir=mkdtempSync(join(tmpdir(),'status-reader-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 seedTrustedHouse(dir,s.origin);
 const hostDb=new LocalHostDb(new PopclawPaths(dir).socialDb());cleanup.push(()=>hostDb.close());
 cleanup.push(()=>{setOwnerLang('en','config');});
 setOwnerLang('en','config');
 const boot={signer:{popclawId:async()=>PERSON_ID},loreHouseUrl:s.origin,loreHouseUrls:[s.origin],nickname:'',webBaseUrl:'https://popclaw.invalid'};
 const host={db:hostDb,config:{loadJson:async()=>null}};
 const rt={boot,houseRuntime:s.reader,host,paths:new PopclawPaths(dir),
  socialGraph:{following:()=>[]},bondsStore:{get:()=>undefined,list:()=>[]},
  inboxStore:{distinctSenderCount:()=>0},ownerNotifyTargetStore:{get:async()=>null},
  onboardingState:{get:()=>null},tasteLoader:{enabledSources:async()=>[]},
  pendingInvites:{listPending:()=>[]},inviteWatch:{}};
 return {s,rt,boot,host};
}
/** The page is built from what the live house said, over the public read lane. */
function expectLiveHouseStatus(s:Awaited<ReturnType<typeof fixture>>,text:string){
 expect(text).not.toContain(renderCopy('en','status.lanternDown.identity'));
 expect(text).not.toContain(renderCopy('en','status.lanternDown.identityNotAsked'));
 expect(text).not.toContain('is down');
 expect(text).toContain('✅');
 // Not vacuous: the house was actually asked, and what it said is on the page.
 expect(s.reads.map(r=>r.url)).toContain(`/v1/profile/${PERSON_ID}`);
 expect(s.reads.every(r=>!r.credential)).toBe(true);
 expect(text).toContain('fixture-owner');
 expect(s.received).toEqual([]);
}
it('status on a second host reads the owner profile from a live house and never calls it down',async()=>{
 const {s,rt}=await statusOnSecondHost();
 const {api,tools}=fakeApi();
 registerPopclawTools({api,runtime:(async()=>rt) as never,getWorldDeps:(async()=>({})) as never});
 expectLiveHouseStatus(s,await toolText(tools,'popclaw_check_status'));
});
it('the /popclaw status slash command on a second host reads the live house too',async()=>{
 const {s,rt}=await statusOnSecondHost();
 const boom=():never=>{throw new Error('unused');};
 const map=buildSubcommands({runtime:async()=>rt,paths:boom,picksFile:boom,warn:boom,llmComplete:boom,
  toolsRegisteredCount:boom,buildStamp:'test-build'} as unknown as SubcommandWiring);
 const out=await map.status({} as never);
 expectLiveHouseStatus(s,(out as {text:string}).text);
});
it('the popclaw status CLI subcommand on a second host reads the live house too',async()=>{
 const {s,boot,host}=await statusOnSecondHost();
 const printed:string[]=[];
 const log=vi.spyOn(console,'log').mockImplementation((...args:unknown[])=>{printed.push(args.map(String).join(' '));});
 cleanup.push(()=>log.mockRestore());
 const quiet={info:()=>{},warn:()=>{},error:()=>{}};
 const code=await runStatusSubcommandForTest({...boot,host,logger:quiet} as never,s.reader);
 expect(code).toBe(0);
 expectLiveHouseStatus(s,printed.join('\n'));
});
