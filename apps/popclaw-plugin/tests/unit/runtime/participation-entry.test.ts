import {afterEach,expect,it,vi} from 'vitest';
import {popclaw} from '@popclaw/contracts';
import {makeRelationProducer} from '../../../src/social-graph/relation-assembly.js';
import {hostDbSlug} from '../../../src/ingress/host-slug.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalHostAdapter} from '../../../src/host/local-host-adapter.js';
import {PopclawPaths} from '../../../src/host/popclaw-paths.js';
import {registerStorageRuntime} from '../../../src/host/storage-maintenance.js';
import {bootstrapPlugin} from '../../../src/runtime/plugin-bootstrap.js';
import {HouseRuntime} from '../../../src/runtime/house-lifecycle/house-runtime.js';
import {houseReadAuthority} from '../../../src/identity/read-authority.js';
import {readParticipation} from '../../../src/runtime/house-lifecycle/participation-store.js';
import {localParticipationPort} from '../../../src/host/local-participation.js';
import type {HouseParticipationAdmissionPort,HouseParticipationPlan} from '../../../src/runtime/house-lifecycle/participation-admission.js';
import {mintHouse} from '../../helpers/signed-manifest.js';
import type {HouseStore} from '../../../src/ingress/world-feed-store.js';
import {pinConfiguredHouses} from '../../../src/social-graph/default-house-pinning.js';
import {runHouseLoginCommand} from '../../../src/commands/popclaw-house.js';
const ME='https://house.popclaw.me',WORLD='https://house.popclaw.world';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();vi.unstubAllGlobals();});
async function fixture(override?: (port:HouseParticipationAdmissionPort)=>HouseParticipationAdmissionPort) {
  vi.stubGlobal('fetch',()=>{throw new Error('REAL_NETWORK_FORBIDDEN');});
  const root=mkdtempSync(join(tmpdir(),'participation-entry-')),paths=new PopclawPaths(root);
  let release!:()=>void;
  const host=new LocalHostAdapter({dataRoot:root,logger:{info(){},warn(){},error(){}},beforeDbInitialize:db=>release=registerStorageRuntime(db,paths)});
  const boot=await bootstrapPlugin(host),db=host.db;
  const houses=new Map([ME,WORLD].map((origin,i)=>[origin,mintHouse({origin,seed:90+i,manifest:{relations:{ordered:1},read_auth:{schemes:['popclaw-identity-read-v2']},guide_url:'/guide.md'}})]));
  let guideFails=false;
  const transport=vi.fn(async(input:RequestInfo|URL)=>{
    const url=input instanceof Request?input.url:String(input);
    if(new URL(url).pathname==='/guide.md')return new Response(guideFails?'':`${new URL(url).origin} existing business`,{status:guideFails?503:200});
    return houses.get(new URL(url).origin)!.fetch(url);
  });
  let evidence=true;
  const port=localParticipationPort(()=>evidence?{reference:'normal-install-receipt',actorId:boot.popclawId}:undefined);
  const rt=new HouseRuntime({db,signer:boot.signer,actorId:boot.popclawId,origins:boot.loreHouseUrls,participation:override?.(port)??port,
    onJoined:async origin=>{if(!boot.loreHouseUrls.includes(origin))(boot.loreHouseUrls as string[]).push(origin);},
    fetch:transport,readAuthorityFor:origin=>houseReadAuthority({db,signer:boot.signer},origin),commandPollMs:1,commandTimeoutMs:1000,intentPollMs:60_000});
  const stores=[ME,WORLD].map(baseUrl=>({baseUrl,db,cacheReadOnly:true,dbPath:paths.socialDb(),slug:new URL(baseUrl).hostname.replaceAll('.','-'),cache:{}}as unknown as HouseStore));
  rt.configureResources({host:{db}as never,recipientPopclawId:boot.popclawId,worldStreamMode:true,stores,openStore:async origin=>stores.find(s=>s.baseUrl===origin)!,isOfficialActor:()=>false});
  rt.start();
  closes.push(async()=>{await rt.stop();release();db.close();rmSync(root,{recursive:true,force:true});});
  return {db,rt,boot,transport,houses,guideFails:()=>guideFails=true,noEvidence:()=>evidence=false};
}
it('normal installation joins only me with a receipt; guide availability and delivery are separate',async()=>{
  const f=await fixture();expect(f.boot.config.lore_houses).toEqual([ME]);expect(readParticipation(f.db,ME)).toBeNull();
  expect(await f.rt.activateInitialMe()).toMatchObject({admission:'configured'});
  expect(readParticipation(f.db,ME)).toMatchObject({desired:'enabled',phase:'connected',session_id:'',ack_key_hex:'',pending_enter_request_id:null});
  expect(readParticipation(f.db,WORLD)).toBeNull();
  const guide=await f.rt.readHouseGuide(ME);expect(guide.status).toBe('available');
  if(guide.status==='available'){expect(guide.delivered).toBe(false);expect(guide.guide).toContain('existing business');expect(f.rt.markHouseGuideDelivered(guide)).toBe(true);}
  expect((await f.rt.readHouseGuide(ME))).toMatchObject({delivered:true});expect(await f.rt.activateInitialMe()).toBeUndefined();
  expect(f.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM house_participation_attempts')?.n).toBe(1);
});
it('without install source reads and initialization mint no participation or setup authority',async()=>{
  const f=await fixture();f.noEvidence();await f.rt.commands.getHouseStatus(ME);await f.rt.readHouseGuide(ME);expect(await f.rt.activateInitialMe()).toBeUndefined();
  expect(readParticipation(f.db,ME)).toBeNull();expect(f.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM house_initial_setup')?.n).toBe(0);
});
it('world owner choice uses normal join and returns that House business guide',async()=>{
  const f=await fixture();await f.rt.activateInitialMe();expect(readParticipation(f.db,WORLD)).toBeNull();
  const text=await runHouseLoginCommand({coordinator:()=>f.rt.commands,readHouseGuide:origin=>f.rt.readHouseGuide(origin)},WORLD);
  expect(text).toContain(WORLD);expect(text).toContain('existing business');expect(readParticipation(f.db,WORLD)?.phase).toBe('connected');
});
it('me leave survives initialization replay; explicit rejoin remains possible',async()=>{
  const f=await fixture();await f.rt.activateInitialMe();await f.rt.commands.logoutHouse(ME);
  expect(await f.rt.activateInitialMe()).toBeUndefined();expect(readParticipation(f.db,ME)?.desired).toBe('disabled');
  expect((await f.rt.commands.loginHouse(ME)).admission).toBe('configured');
});
it('guide failure leaves truthful joined state and no new participation attempt',async()=>{
  const f=await fixture();await f.rt.activateInitialMe();f.guideFails();expect(await f.rt.readHouseGuide(ME)).toMatchObject({status:'unavailable'});
  expect(readParticipation(f.db,ME)?.phase).toBe('connected');expect(f.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM house_participation_attempts')?.n).toBe(1);
});
it('admission receives a durable key and original exact receipt can be read',async()=>{
  let plan:HouseParticipationPlan|undefined;
  const f=await fixture(port=>({...port,admit:async(p,l)=>{plan=p;expect(f.db.queryOne('SELECT * FROM house_participation_attempts WHERE attempt_ref=?',[p.attemptRef])).not.toBeNull();return port.admit(p,l);}}));
  await f.rt.activateInitialMe();expect(plan).toBeDefined();expect(f.rt.findParticipationReceipt(plan!)).toMatchObject({status:'found',receipt:{afterOpSeq:1}});
  expect(f.rt.findParticipationReceipt({...plan!,planDigest:'other'})).toEqual({status:'absent'});
});
it('lost admission response stays unresolved without a new usable permit',async()=>{
  let first:HouseParticipationPlan|undefined,admissions=0;
  const f=await fixture(port=>({...port,admit:async p=>{admissions++;first??=p;expect(p.attemptRef).toBe(first.attemptRef);return {status:'unresolved',attemptRef:p.attemptRef};}}));
  expect((await f.rt.activateInitialMe())?.errorCode).toBe('HOUSE_ADMISSION_UNRESOLVED');expect(readParticipation(f.db,ME)).toBeNull();
  await f.rt.activateInitialMe();expect(admissions).toBe(1);expect(readParticipation(f.db,ME)).toBeNull();
});
it('leave during admission await defeats the late permit',async()=>{
  let release!:()=>void,entered!:()=>void;const signal=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  const f=await fixture(port=>({...port,admit:async(p,l)=>{entered();await wait;return port.admit(p,l);}}));
  const join=f.rt.activateInitialMe();await signal;await f.rt.commands.logoutHouse(ME);release();await join;
  expect(readParticipation(f.db,ME)?.desired).toBe('disabled');expect(await f.rt.activateInitialMe()).toBeUndefined();
});

it('only exact full guide emission marks delivered; leave/rejoin invalidates the old context',async()=>{
  const f=await fixture();await f.rt.activateInitialMe();const guide=await f.rt.readHouseGuide(ME);expect(guide.status).toBe('available');
  if(guide.status!=='available')return;
  f.rt.markGuidesInAgentInput(JSON.stringify({...guide,guide:guide.guide.slice(0,2)}));expect((await f.rt.readHouseGuide(ME))).toMatchObject({delivered:false});
  f.rt.markGuidesInAgentInput(JSON.stringify({house_guide_contexts:[guide]}));expect((await f.rt.readHouseGuide(ME))).toMatchObject({delivered:true});
  await f.rt.commands.logoutHouse(ME);await f.rt.commands.loginHouse(ME);expect(f.rt.markHouseGuideDelivered(guide)).toBe(false);
});

it('the producer built at me-only boot follows world after normal join in the same runtime',async()=>{
  const f=await fixture(),pushed:Array<{slug:string;key:string}>=[];
  vi.stubGlobal('fetch',f.transport);
  const producer=makeRelationProducer({db:f.db,signer:f.boot.signer,
    get houses(){return f.boot.loreHouseUrls.map(origin=>({origin,slug:hostDbSlug(origin)}));},
    pushTo:async(slug,bytes)=>{
      const env=popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(bytes).payload);
      pushed.push({slug,key:env.followDeclared!.order!.houseKey!});
      return {status:200,eventId:env.eventId!};
    }});
  expect(f.boot.loreHouseUrls).toEqual([ME]);
  await f.rt.activateInitialMe();
  const target='6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM';
  expect(await producer.declare(target)).toMatchObject({mode:'ordered',houseSlug:hostDbSlug(ME),transport:'accepted'});
  await f.rt.commands.loginHouse(WORLD);
  expect(await producer.declare(target,{house:WORLD})).toMatchObject({mode:'ordered',houseSlug:hostDbSlug(WORLD),transport:'accepted'});
  expect(await producer.declare(target)).toMatchObject({mode:'ordered',houseSlug:hostDbSlug(ME)});
  expect(pushed.map(p=>p.slug)).toEqual([hostDbSlug(ME),hostDbSlug(WORLD)]);
  expect(new Set(pushed.map(p=>p.key)).size).toBe(2);
});

it('read-only status before initial me or normal world join does not become control history',async()=>{
  const f=await fixture();
  await f.rt.commands.getHouseStatus(ME);await f.rt.commands.getHouseStatus(WORLD);
  expect(readParticipation(f.db,ME)).toBeNull();expect(readParticipation(f.db,WORLD)).toBeNull();
  expect(f.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM house_participation_attempts')?.n).toBe(0);
  expect(await f.rt.activateInitialMe()).toMatchObject({admission:'configured'});
  expect(await f.rt.commands.loginHouse(WORLD)).toMatchObject({admission:'configured'});
});
it('actual MCP text wrapping marks only the full current guide context delivered',async()=>{
  const f=await fixture();await f.rt.activateInitialMe();const guide=await f.rt.readHouseGuide(ME);
  expect(guide.status).toBe('available');if(guide.status!=='available')return;
  const emitted=(g:unknown)=>JSON.stringify({content:[{type:'text',text:'joined\n'+JSON.stringify({house_guide:g})}]});
  f.rt.markGuidesInAgentInput(emitted({...guide,guide:guide.guide.slice(0,2)}));
  expect(await f.rt.readHouseGuide(ME)).toMatchObject({delivered:false});
  f.rt.markGuidesInAgentInput(emitted(guide));expect(await f.rt.readHouseGuide(ME)).toMatchObject({delivered:true});
  await f.rt.commands.logoutHouse(ME);await f.rt.commands.loginHouse(ME);await f.rt.readHouseGuide(ME);
  f.rt.markGuidesInAgentInput(emitted(guide));expect(await f.rt.readHouseGuide(ME)).toMatchObject({delivered:false});
});

it('configured first-pin cannot preseed a port-authorized install before initial activation',async()=>{
  const f=await fixture();
  const unavailable=vi.fn(async()=>new Response('synthetic unavailable service',{status:503}));
  expect(await pinConfiguredHouses({db:f.db,recipientPopclawId:f.boot.popclawId,
    origins:f.boot.loreHouseUrls,pinning:f.rt.configuredHousePinning,fetch:unavailable}))
    .toEqual([{origin:ME,outcome:'refused',refusal:'HOUSE_FIRST_PIN_NOT_AUTHORIZED'}]);
  expect(unavailable).not.toHaveBeenCalled();
  expect(readParticipation(f.db,ME)).toBeNull();
  expect(f.rt.captureGate(ME).isActive()).toBe(false);
  expect(f.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM house_initial_setup')?.n).toBe(0);
  expect(f.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM house_participation_attempts')?.n).toBe(0);
  expect(await f.rt.activateInitialMe()).toMatchObject({admission:'configured'});
  expect(f.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM house_participation_attempts')?.n).toBe(1);
});


function deferred() {
  let release!: () => void;
  return { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function guidePointer(db: LocalHostAdapter['db']) {
  return db.queryOne<{origin: string; binding_digest: string; op_seq: number; guide_url: string; manifest_digest: string; guide_body: string | null}>('SELECT * FROM house_guide_context WHERE origin=?', [ME]);
}

it('historical joined pointer backfill preserves participation and creates no admission', async () => {
  const f = await fixture(); await f.rt.activateInitialMe();
  const participation = readParticipation(f.db, ME);
  f.db.execute('DELETE FROM house_guide_context WHERE origin=?', [ME]);
  f.transport.mockClear();
  expect(await f.rt.readHouseGuide(ME)).toMatchObject({status: 'available', delivered: false});
  expect(readParticipation(f.db, ME)).toEqual(participation);
  expect(f.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM house_participation_attempts')?.n).toBe(1);
  expect(f.transport.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/manifest', '/guide.md']);
});

it('historical backfill without its original binding does not fetch or create trust', async () => {
  const f = await fixture(); await f.rt.activateInitialMe();
  f.db.execute('DELETE FROM house_guide_context WHERE origin=?', [ME]);
  f.db.execute('DELETE FROM house_binding_pin WHERE origin=?', [ME]);
  f.transport.mockClear();
  expect(await f.rt.readHouseGuide(ME)).toMatchObject({status: 'unavailable'});
  expect(f.transport).not.toHaveBeenCalled(); expect(guidePointer(f.db)).toBeNull();
  expect(readParticipation(f.db, ME)?.phase).toBe('connected');
});

it('delayed manifest backfill succeeds with unchanged participation', async () => {
  const f = await fixture(); await f.rt.activateInitialMe();
  f.db.execute('DELETE FROM house_guide_context WHERE origin=?', [ME]);
  const started = deferred(), held = deferred();
  f.transport.mockImplementationOnce(async input => { started.release(); await held.wait; return f.houses.get(ME)!.fetch(input); });
  const read = f.rt.readHouseGuide(ME); await started.wait;
  expect(guidePointer(f.db)).toBeNull(); held.release();
  expect(await read).toMatchObject({status: 'available', delivered: false});
});

it('leave and rejoin during manifest backfill rejects the captured old read', async () => {
  const f = await fixture(); await f.rt.activateInitialMe();
  f.db.execute('DELETE FROM house_guide_context WHERE origin=?', [ME]);
  const started = deferred(), held = deferred();
  f.transport.mockImplementationOnce(async input => { started.release(); await held.wait; return f.houses.get(ME)!.fetch(input); });
  const read = f.rt.readHouseGuide(ME); await started.wait;
  await f.rt.commands.logoutHouse(ME); await f.rt.commands.loginHouse(ME);
  const currentPointer = guidePointer(f.db); held.release();
  expect(await read).toMatchObject({status: 'unavailable'});
  expect(guidePointer(f.db)).toEqual(currentPointer);
  expect(await f.rt.readHouseGuide(ME)).toMatchObject({status: 'available', delivered: false});
});

it('delayed guide body succeeds with unchanged participation', async () => {
  const f = await fixture(); await f.rt.activateInitialMe();
  const started = deferred(), held = deferred();
  f.transport.mockImplementationOnce(async () => {
    const response = new Response('delayed complete guide');
    response.text = async () => { started.release(); await held.wait; return 'delayed complete guide'; };
    return response;
  });
  const read = f.rt.readHouseGuide(ME); await started.wait;
  expect(guidePointer(f.db)?.guide_body).toBeNull(); held.release();
  expect(await read).toMatchObject({status: 'available', guide: 'delayed complete guide', delivered: false});
});

it('leave and rejoin during guide body fetch neither caches nor delivers the old body', async () => {
  const f = await fixture(); await f.rt.activateInitialMe();
  const started = deferred(), held = deferred();
  f.transport.mockImplementationOnce(async () => {
    const response = new Response('old delayed guide');
    response.text = async () => { started.release(); await held.wait; return 'old delayed guide'; };
    return response;
  });
  const read = f.rt.readHouseGuide(ME); await started.wait;
  await f.rt.commands.logoutHouse(ME); await f.rt.commands.loginHouse(ME);
  held.release(); expect(await read).toMatchObject({status: 'unavailable'});
  expect(guidePointer(f.db)).toMatchObject({guide_body: null, guide_digest: null, delivered_digest: null});
  expect(await f.rt.readHouseGuide(ME)).toMatchObject({status: 'available', delivered: false});
});

it('invalid joined guide URL rolls back binding, participation, pointer and receipt together', async () => {
  const f = await fixture();
  f.houses.set(ME, mintHouse({origin: ME, seed: 90, manifest: {relations: {ordered: 1}, guide_url: 'http://['}}));
  expect(await f.rt.activateInitialMe()).toMatchObject({status: 'connecting'});
  expect(readParticipation(f.db, ME)).toBeNull(); expect(guidePointer(f.db)).toBeNull();
  expect(f.db.queryOne('SELECT origin FROM house_binding_pin WHERE origin=?', [ME])).toBeNull();
  expect(f.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM house_participation_attempts WHERE receipt_json IS NOT NULL')?.n).toBe(0);
});

it('invalid historical guide URL is caught without changing joined participation', async () => {
  const f = await fixture(); await f.rt.activateInitialMe();
  const participation = readParticipation(f.db, ME);
  f.db.execute('DELETE FROM house_guide_context WHERE origin=?', [ME]);
  f.houses.set(ME, mintHouse({origin: ME, seed: 90, manifest: {relations: {ordered: 1}, guide_url: 'http://['}}));
  expect(await f.rt.readHouseGuide(ME)).toMatchObject({status: 'unavailable'});
  expect(readParticipation(f.db, ME)).toEqual(participation); expect(guidePointer(f.db)).toBeNull();
  expect(f.db.queryOne('SELECT origin FROM house_binding_pin WHERE origin=?', [ME])).not.toBeNull();
});

it('pending guide reads remain sequential in durable row order', async () => {
  const f = await fixture(); await f.rt.activateInitialMe(); await f.rt.commands.loginHouse(WORLD);
  const calls: string[] = [], started = deferred(), held = deferred();
  f.transport.mockImplementation(async input => {
    const url = new URL(String(input)); calls.push(url.origin);
    if (url.origin === ME) { started.release(); await held.wait; }
    return new Response(url.origin + ' guide');
  });
  const pending = f.rt.pendingHouseGuides(); await started.wait;
  expect(calls).toEqual([ME]); held.release();
  expect((await pending).map(context => context.origin)).toEqual([ME, WORLD]);
  expect(calls).toEqual([ME, WORLD]);
});


it('cached guide completion preserves promise-adoption ordering', async () => {
  const f = await fixture(); await f.rt.activateInitialMe(); await f.rt.readHouseGuide(ME);
  const trace: string[] = [];
  const read = f.rt.readHouseGuide(ME).then(() => { trace.push('guide'); });
  for (let i = 1; i <= 4; i++) { await Promise.resolve(); trace.push('tick' + i); }
  await read;
  expect(trace).toEqual(['tick1', 'tick2', 'guide', 'tick3', 'tick4']);
});

it('invalid guide origin rejects through a promise without a synchronous facade throw', async () => {
  const f = await fixture();
  let result: ReturnType<HouseRuntime['readHouseGuide']> | undefined;
  expect(() => { result = f.rt.readHouseGuide(''); }).not.toThrow();
  await expect(result).rejects.toThrow('invalid house address');
});

it('historical backfill preserves a pointer and complete body installed during the manifest await', async () => {
  const f = await fixture(); await f.rt.activateInitialMe();
  const before = guidePointer(f.db)!;
  f.db.execute('DELETE FROM house_guide_context WHERE origin=?', [ME]);
  const started = deferred(), held = deferred();
  f.transport.mockImplementationOnce(async input => { started.release(); await held.wait; return f.houses.get(ME)!.fetch(input); });
  const read = f.rt.readHouseGuide(ME); await started.wait;
  f.db.execute(`INSERT INTO house_guide_context
    (origin,binding_digest,op_seq,guide_url,manifest_digest,guide_digest,guide_body,delivered_digest)
    VALUES (?,?,?,?,?,'concurrent-digest','complete concurrent guide','concurrent-digest')`,
    [ME, before.binding_digest, before.op_seq, before.guide_url, before.manifest_digest]);
  const concurrent = guidePointer(f.db); held.release();
  expect(await read).toMatchObject({status: 'available', guide: 'complete concurrent guide', delivered: true});
  expect(guidePointer(f.db)).toEqual(concurrent);
});
