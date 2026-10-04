import {afterEach, expect, it, vi} from 'vitest';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {popclaw} from '@popclaw/contracts';
import {ackSigningInput, cidFromCanonical} from '@popclaw/algorithms';
import {canonicalWorldCore, worldSigningInput} from '../../../src/world/action-wire.js';
import {runMigrations} from '../../../src/host/migrations.js';
import {LocalHostDb} from '../../../src/host/local-host-db.js';
import {PopclawPaths} from '../../../src/host/popclaw-paths.js';
import {MasterKeySigner} from '../../../src/identity/master-key-signer.js';
import {ExecutionStoreCatalog} from '../../../src/host/execution-store.js';
import {MaintenanceSession} from '../../../src/host/storage-maintenance.js';
import {initializeActionReceiptJournal, initializeNativeActionJournal, initializePrivateMessageJournal} from '../../../src/host/execution-store-migration.js';
import {createOpenClawWorldExecution} from '../../../src/host/openclaw-world-execution.js';
import {HouseCommandBus} from '../../../src/runtime/house-lifecycle/command-bus.js';
import {scriptOwnerApproval} from '../../helpers/owner-approval-script.js';
import {HouseRuntime} from '../../../src/runtime/house-lifecycle/house-runtime.js';
import {WorldRuntime} from '../../../src/runtime/world-runtime.js';
import {WorldFeedCache} from '../../../src/ingress/world-feed-cache.js';
import {hostDbSlug} from '../../../src/ingress/host-slug.js';
import {readParticipation} from '../../../src/runtime/house-lifecycle/participation-store.js';
import {pinnedBinding} from '../../../src/world/house-binding-pin.js';
import {readHouseCapabilityView} from '../../../src/world/world-capabilities.js';
import {houseRecoveryHeld} from '../../../src/world/house-recovery-fence.js';
import {makeToolCollector} from '../../../src/tools/mcp-adapter.js';
import {registerHouseTools} from '../../../src/tools/house-tools.js';
import {createMcpOwnerApproval} from '../../../src/host/mcp-owner-approval.js';
import {resetOwnerApprovals} from '../../../src/host/owner-approval.js';
import {runWorldInvokeCommand} from '../../../src/commands/popclaw-world.js';
import {runHouseRecoveryCommand} from '../../../src/commands/popclaw-house.js';
import {refusingReadAuthorityFor} from '../../helpers/read-authority.js';
import {HouseRecovery} from '../../../src/world/house-recovery.js';
import {PrivateWorldMessages} from '../../../src/world/private-world-messages.js';
import {encryptDmBody} from '../../../src/messaging/dm-crypto.js';
import {canonicalizeEnvelope} from '../../../src/protocol/public-envelope.js';
import {runStatusCommand} from '../../../src/commands/status.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); resetOwnerApprovals(); });
const seed = new Uint8Array(32).fill(83), actor = nacl.sign.keyPair.fromSeed(seed), actorId = bs58.encode(actor.publicKey);
const housePair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(84));
const key = bs58.encode(housePair.publicKey), hex = Buffer.from(housePair.publicKey).toString('hex');
const guide = new TextEncoder().encode('Record a synthetic note.');

async function fixture(native=false) {
  resetOwnerApprovals();
  const root = mkdtempSync(join(tmpdir(),'pc-recovery-synthetic-')), paths = new PopclawPaths(root);
  cleanup.push(() => rmSync(root,{recursive:true,force:true}));
  const db = new LocalHostDb(paths.socialDb()), cacheDb = new LocalHostDb(join(root,'cache.db'));
  cleanup.push(() => {cacheDb.close();db.close();});
  runMigrations(db,new URL('../../../migrations/',import.meta.url).pathname);
  let incarnation = 'server_old', log = 'log_old', version = 'g1', proofOrigin: string | undefined;
  let signingPair = housePair, sessionSerial = 0;
  const calls: Array<{path:string; body?:Uint8Array}> = [];
  let manifestHold: Promise<void> | undefined;
  let guideHold: Promise<void> | undefined, refuseLeave=false;
  const server = createServer(async (req,res) => {
    const path = new URL(req.url!,'http://localhost').pathname, chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new Uint8Array(Buffer.concat(chunks)); calls.push({path,...(body.length ? {body}: {})});
    if (path === '/v1/manifest') {
      await manifestHold;
      const m = manifest(); res.setHeader('X-Popclaw-Manifest-Proof',m.proof); res.end(m.raw); return;
    }
    if (path === '/v1/guide.md') {await guideHold;res.end(guide);return;}
    if (path === '/v1/house-session') {
      const request = popclaw.housesession.HouseSessionRequest.decode(body);
      if (request.core?.operation === 3 && refuseLeave) {res.statusCode=500;res.end();return;}
      if (request.core?.operation === 1) sessionSerial++;
      const core = {...request.core,outcome:1,houseRevision:sessionSerial,sessionId:`${incarnation}_session_${sessionSerial}`,sessionActive:true,
        leaseExpiresAt:Math.floor(Date.now()/1000)+3600,inboxReadToken:'synthetic_token',serverCommittedAt:Math.floor(Date.now()/1000)};
      const signature=nacl.sign.detached(ackSigningInput(core),housePair.secretKey);
      res.end(popclaw.housesession.HouseSessionAck.encode({core,signature,signerPubkey:housePair.publicKey}).finish()); return;
    }
    if (path === '/v1/push') {res.statusCode=202;res.end('{}');return;}
    res.statusCode=404;res.end();
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  function manifest() {
    const document={house_session:{version:1,endpoint:'/v1/house-session',ack_pubkey:hex,operations:['enter','renew','leave','status'],lease_seconds:90,renew_interval_seconds:30},
      world_interaction:{version:1,public_stream:{endpoint:'/v1/world-stream',mode:'public-v1',envelope_baseline:'public-envelope-01',log_incarnation:log,initial_public_scopes:[]},
        actions:{status_endpoint:'/v1/world-actions/status',result_authority_pubkey:key,kinds:['test.note'],attachments:[]},
        guide:{path:'/v1/guide.md',sha256:cidFromCanonical(guide),revision:version}},
      intent_kinds:[{kind:'test.note',schema_version:1,transport:'house',signer:'user',description:'Synthetic note',
        params_schema:{type:'object',properties:{text:{type:'string'}}},result_schema:{type:'object'},result_attachments:{allowed:[],required_on_success:[]},consistency:'none'}]};
    const raw=new TextEncoder().encode(JSON.stringify(document)), core={house:{origin:proofOrigin??origin,houseKey:bs58.encode(signingPair.publicKey),incarnation},manifestDigest:cidFromCanonical(raw),signedAt:Math.floor(Date.now()/1000)};
    const proofBytes=canonicalWorldCore(popclaw.world.ManifestProof,{...core,authoritySignature:nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1',canonicalWorldCore(popclaw.world.ManifestProof,core)),signingPair.secretKey)});
    return {raw,proof:Buffer.from(proofBytes).toString('base64'),digest:core.manifestDigest};
  }
  const signer = new MasterKeySigner({seed,...actor,popclawId:actorId});
  const catalog = new ExecutionStoreCatalog({db,paths,actorId}), partition=catalog.open(origin);
  const maintenance=MaintenanceSession.begin(db,paths,'synthetic action receipt setup');
  initializeActionReceiptJournal({catalog,origin,maintenance}); initializePrivateMessageJournal({catalog,origin,maintenance}); if(native) initializeNativeActionJournal({catalog,origin,maintenance}); maintenance.finish({recovery:false,reason:'synthetic setup finished'});
  cleanup.push(()=>catalog.close());
  const rt=new HouseRuntime({db,signer,origins:[origin],executionStores:catalog,publicV1Mode:true,readAuthorityFor:refusingReadAuthorityFor,
    configuredPinFor:()=>hex,commandPollMs:1,commandTimeoutMs:3000,intentPollMs:60_000});
  rt.resident.configureOrigins([]);rt.resident.start();await rt.manager.resumeAfterOwnership();rt.startReader();
  cleanup.push(()=>rt.stop());
  const cache=new WorldFeedCache({db:cacheDb});await cache.start();
  const store={baseUrl:origin,slug:hostDbSlug(origin),db:cacheDb,executionDb:partition.db,dbPath:join(root,'cache.db'),cache};
  const resources={stores:[store],openStore:async(o:string)=>{
    if(o===origin)return store;
    const extraDb=new LocalHostDb(join(root,`${hostDbSlug(o)}.db`)),extraCache=new WorldFeedCache({db:extraDb});await extraCache.start();
    cleanup.push(()=>extraDb.close());
    return {baseUrl:o,slug:hostDbSlug(o),db:extraDb,executionDb:catalog.open(o).db,dbPath:join(root,`${hostDbSlug(o)}.db`),cache:extraCache};
  },host:{db} as never,recipientPopclawId:actorId,worldStreamMode:false,isOfficialActor:()=>false,
    createInboxConsumer:()=>undefined};
  rt.configureResources(resources);
  const hostConfig={plugins:{entries:{popclaw:{enabled:true,config:{worldExecution:{policies:[{
    agentId:'main',actorId,house:origin,houseKey:key,kinds:['test.note'],authorizedAt:new Date(Date.now()-5000).toISOString().replace(/\.\d{3}Z$/,'Z'),expiresAt:new Date(Date.now()+600_000).toISOString().replace(/\.\d{3}Z$/,'Z')} ]}}}}}};
  const nativeAdapter=native ? createOpenClawWorldExecution({actorId,readActiveConfig:()=>hostConfig}) : undefined;
  const worlds=new WorldRuntime({...(nativeAdapter ? {nativeAuthorization:nativeAdapter}:{}),mode:'commands',houses:rt,signer,actorId,readCapabilities:o=>readHouseCapabilityView(db,o),
    fixtureOwnerAuthorization:{authorize:async()=>({jobId:`synthetic_${newRequest++}`,expiresAt:Math.floor(Date.now()/1000)+200,assertCurrent(){}})}});
  cleanup.push(async()=>{worlds.stop();await worlds.whenIdle();});
  let newRequest=1;
  const c=makeToolCollector();
  registerHouseTools({api:c.api,deps:{getHouseCommandContext:async()=>({coordinator:()=>rt.commands,recovery:rt.recovery})}} as never);
  let accept=true;const prompts: string[]=[];
  const approvals=createMcpOwnerApproval({server:{current:{getClientCapabilities:()=>({elicitation:{form:{}}}),elicitInput:async (input:{message:string})=>{
    prompts.push(input.message);return {action:accept?'accept':'decline',content:{confirm:accept}};}}} as never});
  cleanup.push(()=>approvals.stop());
  let call=0;
  async function invoke(name:string,params:unknown,ask=true) {
    const tool=c.tools.find(t=>t.name===name)!, ref=`mcp_recovery_${++call}`;
    const result=ask ? await approvals.aroundDispatch(name,params,ref,undefined,()=>tool.execute(ref,params)) : await tool.execute(ref,params);
    return JSON.parse((result as {text:string}).text);
  }
  return {root,db,cacheDb,catalog,rt,worlds,store,resources,partition,origin,signer,c,calls,prompts,invoke,manifest,nativeAdapter,hostConfig,
    approve:(value:boolean)=>{accept=value;},
    restore:(sameBody=false)=>{incarnation='server_new';if(!sameBody) log='log_new';},
    setIncarnation:(value:string)=>{incarnation=value;},
    setManifestVersion:()=>{version='g2';},setKey:()=>{signingPair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(85));},
    setOrigin:()=>{proofOrigin='https://wrong.invalid';},holdManifest:(p:Promise<void>|undefined)=>{manifestHold=p;},
    holdGuide:(p:Promise<void>|undefined)=>{guideHold=p;},refuseLeave:()=>{refuseLeave=true;}};
}
async function oldLogin(s:Awaited<ReturnType<typeof fixture>>) {
  const result=await s.rt.commands.loginHouse(s.origin);expect(result.status).toBe('connected');
  return readParticipation(s.db,s.origin)!;
}
async function decision(s:Awaited<ReturnType<typeof fixture>>) {return s.invoke('popclaw_house_recovery_prepare',{host:s.origin});}

it('same-key restore → registered MCP owner approval → ordinary new participation, preserving uncertain work and identity',async()=>{
  const s=await fixture(), old=await oldLogin(s), actorBefore=await s.signer.popclawId();
  const capabilities=readHouseCapabilityView(s.db,s.origin)!;
  const input={house:s.origin,kind:'test.note',params:{text:'old pending'},expected_capability_revision:capabilities.verified.capabilityRevision};
  const context={readCapabilities:s.worlds.readCapabilities,client:s.worlds.client,actionAuthority:s.worlds.actionAuthority};
  await runWorldInvokeCommand(context,input);
  const oldRequests=s.partition.db.queryAll('SELECT * FROM world_action_client_requests'); expect(oldRequests).toHaveLength(1);
  const oldReservations=s.partition.db.queryAll('SELECT * FROM world_owner_action_reservations');
  const oldPushes=s.calls.filter(c=>c.path==='/v1/push').length;expect(oldPushes).toBe(1);
  s.store.cache.recordInsertCursor('41');
  s.restore();const refused=await s.rt.commands.loginHouse(s.origin);expect(refused.errorCode).toBe('AUTH_INVALID');
  expect(pinnedBinding(s.db,s.origin)?.incarnation).toBe('server_old');
  const d=await decision(s);expect(d.new_incarnation).toBe('server_new');expect(s.prompts).toEqual([]);
  const result=await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});
  expect(result).toEqual({status:'reconfirmed',origin:s.origin,next:'login'});
  expect(s.prompts).toHaveLength(1);expect(s.prompts[0]).toContain(key);expect(s.prompts[0]).toContain('server_old');expect(s.prompts[0]).toContain('server_new');
  expect(readParticipation(s.db,s.origin)?.desired).toBe('disabled');expect(s.rt.captureGate(s.origin).isActive()).toBe(false);
  expect(await s.signer.popclawId()).toBe(actorBefore);expect(s.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toEqual(oldRequests);
  expect(s.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toEqual(oldReservations);
  expect(s.store.cache.insertCursor()).toBe(0);
  expect(s.db.queryOne<{evidence_json:string}>('SELECT evidence_json FROM house_recovery_cursor_evidence_v1')?.evidence_json).toContain('41');
  const joined=await s.rt.commands.loginHouse(s.origin);expect(joined.status).toBe('connected');
  expect(readParticipation(s.db,s.origin)?.session_id).not.toBe(old.session_id);
  expect(s.calls.filter(c=>c.path==='/v1/push')).toHaveLength(oldPushes);
  const newCaps=readHouseCapabilityView(s.db,s.origin)!;expect(newCaps.verified.house.incarnation).toBe('server_new');
  await runWorldInvokeCommand(context,{...input,params:{text:'fresh approved'},expected_capability_revision:newCaps.verified.capabilityRevision});
  expect(s.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(2);
  expect(s.calls.filter(c=>c.path==='/v1/push')).toHaveLength(oldPushes+1);
  if(process.env.POPCLAW_RECOVERY_EVIDENCE_DIR) writeFileSync(join(process.env.POPCLAW_RECOVERY_EVIDENCE_DIR,'restore-reconfirm-receipt.json'),JSON.stringify({actorId:actorBefore,origin:s.origin,decision:d,result,oldSession:old.session_id,newSession:joined.sessionId,pushesBefore:oldPushes,pushesAfter:s.calls.filter(c=>c.path==='/v1/push').length,prompt:s.prompts[0],historyPreserved:true},null,2));
});
it('proof-only incarnation change keeps old proof and selects new proof despite identical manifest digest',async()=>{
  const s=await fixture();await oldLogin(s);const before=readHouseCapabilityView(s.db,s.origin)!.verified;
  s.restore(true);const d=await decision(s);expect(d.manifest_digest).toBe(before.capabilityRevision);
  expect(await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id})).toMatchObject({status:'reconfirmed'});
  const after=readHouseCapabilityView(s.db,s.origin)!.verified;expect(after.house.incarnation).toBe('server_new');
  expect(after.proofBytes).not.toEqual(before.proofBytes);
  expect(new Uint8Array(s.db.queryOne<{proof_bytes:Uint8Array}>('SELECT proof_bytes FROM world_capability_views_v1')!.proof_bytes)).toEqual(before.proofBytes);
  expect((await s.rt.commands.loginHouse(s.origin)).status).toBe('connected');
});
it('missing owner approval and explicit deny make no cutover',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s),before=pinnedBinding(s.db,s.origin);
  await expect(s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id},false)).rejects.toThrow(/ORIGIN_NOT_OWNER_DIRECT|APPROVAL_SURFACE_ABSENT/);
  s.approve(false);await expect(s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id})).rejects.toThrow('HOUSE_RECOVERY_DENIED');
  expect(pinnedBinding(s.db,s.origin)).toEqual(before);expect(houseRecoveryHeld(s.db,s.origin)).toBe(false);
});
it.each(['key','origin'] as const)('different %s is refused before owner approval',async(kind)=>{
  const s=await fixture();await oldLogin(s);s.restore();if(kind==='key')s.setKey();else s.setOrigin();
  await expect(decision(s)).rejects.toThrow('MANIFEST_PROOF_BINDING_MISMATCH');expect(s.prompts).toEqual([]);
});
it('changed signed manifest after approval stays durably held, with old pin and capability evidence preserved',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s);s.setManifestVersion();
  await expect(s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id})).rejects.toThrow('HOUSE_RECOVERY_MANIFEST_CHANGED');
  expect(houseRecoveryHeld(s.db,s.origin)).toBe(true);expect(pinnedBinding(s.db,s.origin)?.incarnation).toBe('server_old');
  expect((await s.rt.commands.loginHouse(s.origin)).errorCode).toBe('AUTH_INVALID');
  const statusLines: string[]=[];
  await runStatusCommand({signer:s.signer,host:{db:s.db,config:{loadJson:async()=>null}},loreHouseUrl:s.origin,
    fetch:async()=>({ok:true,status:200,text:async()=>'{}'}),logger:{info:(line:string)=>statusLines.push(line)},
    configuredHouses:[],lang:'en'} as never);
  expect(statusLines.join('\n')).toContain(`Recovery held for ${s.origin}`);
  expect(statusLines.join('\n')).toContain('HOUSE_RECOVERY_MANIFEST_CHANGED');
  expect(statusLines.join('\n')).toContain(d.decision_id);
  const retry=await decision(s);expect(await s.invoke('popclaw_house_reconfirm',{decision_id:retry.decision_id})).toMatchObject({status:'reconfirmed'});
});
it('stale pin revision rejects the decision before cutover',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s);
  // Fault injection models a competing pin revision while approval is pending.
  const pin=pinnedBinding(s.db,s.origin)!;
  s.db.execute('UPDATE house_binding_pin SET revision=revision+1 WHERE origin=?',[s.origin]);
  await expect(s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id})).rejects.toThrow('SUBJECT_REFUSED');
  expect(pinnedBinding(s.db,s.origin)?.revision).toBe(pin.revision+1);expect(houseRecoveryHeld(s.db,s.origin)).toBe(false);
});
it('ordinary login and unchanged incarnation do not need or permit recovery',async()=>{
  const s=await fixture(),old=await oldLogin(s);
  expect((await s.rt.commands.loginHouse(s.origin)).sessionId).toBe(old.session_id);
  await expect(decision(s)).rejects.toThrow('HOUSE_RECOVERY_NOT_CHANGED');
});
it('the slash/CLI shared preparation entry returns a decision and the real approval tool',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();
  const result=JSON.parse(await runHouseRecoveryCommand({coordinator:()=>s.rt.commands,recovery:s.rt.recovery},s.origin));
  expect(result.next_tool).toBe('popclaw_house_reconfirm');expect(result.decision.house_key).toBe(key);
});
it('expired decisions never reach the owner dialog or change trust',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s), before=pinnedBinding(s.db,s.origin);
  const clock=vi.spyOn(Date,'now').mockReturnValue(d.expires_at+1);
  try {await expect(s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id})).rejects.toThrow('SUBJECT_REFUSED');}
  finally {clock.mockRestore();}
  expect(s.prompts).toEqual([]);expect(pinnedBinding(s.db,s.origin)).toEqual(before);expect(houseRecoveryHeld(s.db,s.origin)).toBe(false);
});
it('two concurrent decisions can produce only one cutover and no reuse of approval',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const first=await decision(s),second=await decision(s);
  const results=await Promise.allSettled([s.invoke('popclaw_house_reconfirm',{decision_id:first.decision_id}),s.invoke('popclaw_house_reconfirm',{decision_id:second.decision_id})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(s.db.queryAll("SELECT * FROM house_recovery_decisions_v1 WHERE state='complete'")).toHaveLength(1);
  expect(s.db.queryAll("SELECT * FROM house_recovery_decisions_v1 WHERE state='prepared'")).toHaveLength(1);
  await expect(s.invoke('popclaw_house_reconfirm',{decision_id:first.decision_id},false)).rejects.toThrow();
});
it('interruption during manifest revalidation remains held on normal restart and never resumes old approval',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s);
  let release!:()=>void;s.holdManifest(new Promise<void>(resolve=>{release=resolve;}));
  const confirmation=s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id}).catch(error=>error as Error);
  await vi.waitFor(()=>expect(s.db.queryOne<{state:string}>('SELECT state FROM house_recovery_decisions_v1 WHERE decision_id=?',[d.decision_id])?.state).toBe('applying'));
  const stop=s.rt.stop();release();await stop;await confirmation;s.holdManifest(undefined);
  expect(houseRecoveryHeld(s.db,s.origin)).toBe(true);expect(pinnedBinding(s.db,s.origin)?.incarnation).toBe('server_old');
  const newService=new HouseRecovery({db:s.db,enqueue:async()=>undefined,quiesce:async()=>undefined,isOwnerCurrent:()=>true});
  await expect(newService.apply(d.decision_id)).rejects.toThrow('HOUSE_RECOVERY_DECISION_SPENT');
  const restarted=new HouseRuntime({db:s.db,signer:s.signer,origins:[s.origin],readAuthorityFor:refusingReadAuthorityFor,configuredPinFor:()=>hex,
    commandPollMs:1,commandTimeoutMs:3000,publicV1Mode:true});
  cleanup.push(()=>restarted.stop());restarted.resident.configureOrigins([]);restarted.resident.start();await restarted.manager.resumeAfterOwnership();restarted.startReader();
  expect((await restarted.commands.loginHouse(s.origin)).errorCode).toBe('AUTH_INVALID');
  expect(houseRecoveryHeld(s.db,s.origin)).toBe(true);
});
it('an old in-flight owner action cannot continue under the restored instance',async()=>{
  const s=await fixture();await oldLogin(s);const caps=readHouseCapabilityView(s.db,s.origin)!;
  const input={house:s.origin,kind:'test.note',params:{text:'old suspended'},expected_capability_revision:caps.verified.capabilityRevision};
  const authority=await s.worlds.actionAuthority(input), old=s.rt.captureSessionCommandContext(s.origin);
  s.restore();const d=await decision(s);await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});await s.rt.commands.loginHouse(s.origin);
  expect(old.gate.isActive()).toBe(false);
  await expect(s.worlds.client(s.origin).invoke(input,authority)).rejects.toThrow('OWNER_ACTION_BINDING_MISMATCH');
  expect(s.calls.filter(c=>c.path==='/v1/push')).toEqual([]);
});
it('an unrelated House in the same root keeps its exact pin, capability selection and participation',async()=>{
  const s=await fixture();await oldLogin(s);
  const other=await fixture();await other.rt.stop();
  expect((await s.rt.commands.loginHouse(other.origin)).status).toBe('connected');
  // Each root registers one subject; restore the tested root after creating
  // the second fixture's independently controlled HTTP endpoint.
  const c=makeToolCollector();registerHouseTools({api:c.api,deps:{getHouseCommandContext:async()=>({coordinator:()=>s.rt.commands,recovery:s.rt.recovery})}} as never);
  const pin=pinnedBinding(s.db,other.origin),participation=readParticipation(s.db,other.origin),view=readHouseCapabilityView(s.db,other.origin);
  s.restore();const d=await decision(s);await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});
  expect(pinnedBinding(s.db,other.origin)).toEqual(pin);expect(readParticipation(s.db,other.origin)).toEqual(participation);
  expect(readHouseCapabilityView(s.db,other.origin)?.verified.house).toEqual(view?.verified.house);
  expect(s.rt.captureGate(other.origin).isActive()).toBe(true);
});
it('old native policy cannot grant fresh execution authority after recovery',async()=>{
  const s=await fixture(true);await oldLogin(s);const old=readHouseCapabilityView(s.db,s.origin)!;
  const input={house:s.origin,kind:'test.note',params:{text:'native'},expected_capability_revision:old.verified.capabilityRevision};
  const factory=s.nativeAdapter!.bindFactory({agentId:'main',getRuntimeConfig:()=>s.hostConfig});
  s.restore(true);const d=await decision(s);await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});await s.rt.commands.loginHouse(s.origin);
  const recoveryDecisionId=s.rt.nativeRecoveryDecisionId(s.origin);expect(recoveryDecisionId).toBe(d.decision_id);
  expect(s.nativeAdapter!.actionReadiness({house:s.origin,kind:'test.note',recoveryDecisionId})).toEqual({ready:false,reason:'NATIVE_POLICY_RECONFIRMATION_REQUIRED'});
  await expect(factory.withInvocation('synthetic_new_native',input,undefined,async permit=>s.worlds.nativeCommandContext(permit))).rejects.toThrow('NATIVE_POLICY_RECONFIRMATION_REQUIRED');
  expect(s.calls.filter(c=>c.path==='/v1/push')).toEqual([]);
});


it('committed and pending encrypted message history survives recovery without replay in the new binding',async()=>{
  const s=await fixture();await oldLogin(s);const original=readHouseCapabilityView(s.db,s.origin)!.verified;
  // Exercise the retained message receiver, as a historical capability
  // namespace. The current first-release signed board is not modified.
  const capabilities={house:original.house,capabilityRevision:original.capabilityRevision,guide:'',manifest:{
    world_interaction:{features:{structured_private_messages:1}},official_ids:[key],event_kinds:[{
      kind:'test.message',transport:'house',schema_version:1,signer:'official',body_schema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}};
  const options={db:s.partition.db,gate:s.rt.captureGate(s.origin),capabilities,recipientId:actorId,recipient:s.signer,isOfficialActor:()=>true};
  const receiver=new PrivateWorldMessages(options);
  for(const messageId of ['committed_history','pending_history']) {
    const text=JSON.stringify({format:'popclaw.world-message',version:1,kind:'test.message',schema_version:1,
      capability_revision:original.capabilityRevision,message_id:messageId,conversation_ref:'synthetic_conversation',
      delivery_class:'conversation',summary:'Synthetic history',body:{text:messageId}});
    const env=popclaw.event.EventEnvelope.fromObject({actor:{popclawId:key},target:{scope:1,targetIds:[actorId]},timestamp:'1000',
      directMessage:{fromPopclawId:key,toPopclawId:actorId,body:'[encrypted]',ts:'1000',...encryptDmBody(text,actorId,housePair.secretKey)}});
    const canonical=canonicalizeEnvelope(env);env.eventId=cidFromCanonical(canonical);env.signature=nacl.sign.detached(canonical,housePair.secretKey);
    expect(await receiver.receive(popclaw.event.EventEnvelope.encode(env).finish())).toMatchObject({kind:'structured',messageStatus:'new'});
  }
  expect(receiver.markHandled('committed_history')).toBe(true);
  const history=s.partition.db.queryAll('SELECT * FROM world_private_messages_v2 ORDER BY message_id');expect(history).toHaveLength(2);
  s.restore();const d=await decision(s);await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});await s.rt.commands.loginHouse(s.origin);
  expect(s.partition.db.queryAll('SELECT * FROM world_private_messages_v2 ORDER BY message_id')).toEqual(history);
  const newReceiver=new PrivateWorldMessages({...options,gate:s.rt.captureGate(s.origin),capabilities:{...capabilities,house:readHouseCapabilityView(s.db,s.origin)!.verified.house}});
  expect(newReceiver.pending()).toEqual([]);expect(s.calls.filter(c=>c.path==='/v1/push')).toEqual([]);
});
it('a failed final capability write rolls back pin and selection and leaves the durable hold',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s),pin=pinnedBinding(s.db,s.origin);
  const execute=s.db.execute.bind(s.db);
  const fault=vi.spyOn(s.db,'execute').mockImplementation((sql,params)=>{
    if(sql.includes('INSERT INTO world_capability_recovery_views_v1')) throw new Error('SYNTHETIC_CAPABILITY_WRITE_FAILED');
    return execute(sql,params);
  });
  try {await expect(s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id})).rejects.toThrow('SYNTHETIC_CAPABILITY_WRITE_FAILED');}
  finally {fault.mockRestore();}
  expect(pinnedBinding(s.db,s.origin)).toEqual(pin);expect(readHouseCapabilityView(s.db,s.origin)).toBeNull();
  expect(houseRecoveryHeld(s.db,s.origin)).toBe(true);expect(readParticipation(s.db,s.origin)?.desired).toBe('disabled');
  expect(s.db.queryOne<{state:string}>('SELECT state FROM house_recovery_decisions_v1 WHERE decision_id=?',[d.decision_id])?.state).toBe('failed');
});
it('failed resource teardown cannot report successful cutover',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s),pin=pinnedBinding(s.db,s.origin);
  const fault=vi.spyOn(s.rt.resident.coordinator,'quiesceHouse').mockRejectedValue(new Error('SYNTHETIC_TEARDOWN_FAILED'));
  try {await expect(s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id})).rejects.toThrow('SYNTHETIC_TEARDOWN_FAILED');}
  finally {fault.mockRestore();}
  expect(pinnedBinding(s.db,s.origin)).toEqual(pin);expect(houseRecoveryHeld(s.db,s.origin)).toBe(true);
  expect(s.rt.captureGate(s.origin).isActive()).toBe(false);
});

it('ordinary resident restart retains the same incarnation and requires no owner reconfirmation',async()=>{
  const s=await fixture();await oldLogin(s);const before=pinnedBinding(s.db,s.origin);await s.rt.stop();
  const restarted=new HouseRuntime({db:s.db,signer:s.signer,origins:[s.origin],readAuthorityFor:refusingReadAuthorityFor,
    configuredPinFor:()=>hex,commandPollMs:1,commandTimeoutMs:3000,publicV1Mode:true});
  cleanup.push(()=>restarted.stop());restarted.configureResources(s.resources);restarted.resident.configureOrigins([]);restarted.resident.start();await restarted.manager.resumeAfterOwnership();restarted.startReader();
  expect((await restarted.commands.loginHouse(s.origin)).status).toBe('connected');expect(pinnedBinding(s.db,s.origin)).toEqual(before);
  await expect(restarted.recovery.prepare(s.origin)).rejects.toThrow('HOUSE_RECOVERY_NOT_CHANGED');expect(s.prompts).toEqual([]);
});
it('an old queued push is retired without sending and retains its immutable forensic capture',async()=>{
  const s=await fixture();await oldLogin(s);let release!:()=>void;
  const count=s.calls.filter(c=>c.path==='/v1/manifest').length;
  s.holdManifest(new Promise<void>(resolve=>{release=resolve;}));
  const login=s.rt.commands.loginHouse(s.origin);
  await vi.waitFor(()=>expect(s.calls.filter(c=>c.path==='/v1/manifest').length).toBeGreaterThan(count));
  s.holdManifest(undefined);
  const reader=new HouseCommandBus({db:s.db,coordinator:s.rt.commands,authority:{captureEpoch:()=>null,isEpochCurrent:()=>false},pollMs:1});
  cleanup.push(()=>reader.stop());
  const waiting=reader.push(s.origin,new Uint8Array([7,8,9]));
  expect(s.db.queryOne<{state:string}>("SELECT state FROM house_lifecycle_commands WHERE kind='push'")?.state).toBe('pending');
  s.restore();const d=await decision(s);
  const confirmation=s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});
  await vi.waitFor(()=>expect(houseRecoveryHeld(s.db,s.origin)).toBe(true));
  release();expect(await confirmation).toMatchObject({status:'reconfirmed'});
  await login;
  expect(await waiting).toMatchObject({state:'failed',errorCode:'STALE_OPERATION'});
  expect(s.calls.filter(c=>c.path==='/v1/push')).toEqual([]);
  expect(s.db.queryOne<{capture_json:string}>('SELECT capture_json FROM house_recovery_command_evidence_v1')?.capture_json).toContain('070809');
});
it('pending old leave requests stay as evidence and cannot settle or resend under new participation',async()=>{
  const s=await fixture();await oldLogin(s);s.refuseLeave();await s.rt.commands.logoutHouse(s.origin);
  const before=s.db.queryAll('SELECT * FROM house_lifecycle_outbox');expect(before).toHaveLength(1);
  s.restore();const d=await decision(s);await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});
  const calls=s.calls.filter(c=>c.path==='/v1/house-session' && c.body && popclaw.housesession.HouseSessionRequest.decode(c.body).core?.operation===3).length;
  await s.rt.commands.loginHouse(s.origin);await s.rt.manager.resumeAfterOwnership();
  expect(s.db.queryAll('SELECT * FROM house_lifecycle_outbox')).toEqual(before);
  expect(s.calls.filter(c=>c.path==='/v1/house-session' && c.body && popclaw.housesession.HouseSessionRequest.decode(c.body).core?.operation===3)).toHaveLength(calls);
});
it('a signed board changed during guide preparation refuses the final cutover',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s);let release!:()=>void;
  const count=s.calls.filter(c=>c.path==='/v1/guide.md').length;
  s.holdGuide(new Promise<void>(resolve=>{release=resolve;}));
  const confirmation=s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});
  await vi.waitFor(()=>expect(s.calls.filter(c=>c.path==='/v1/guide.md').length).toBeGreaterThan(count));
  s.setManifestVersion();release();
  await expect(confirmation).rejects.toThrow('HOUSE_RECOVERY_MANIFEST_CHANGED');
  expect(houseRecoveryHeld(s.db,s.origin)).toBe(true);expect(pinnedBinding(s.db,s.origin)?.incarnation).toBe('server_old');
});

it('the registered recovery tool also completes through the native OpenClaw owner approval seam',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s),params={decision_id:d.decision_id},ref='native_recovery_1';
  expect(await scriptOwnerApproval('popclaw_house_reconfirm',params,ref)).toBe('asked');
  const tool=s.c.tools.find(t=>t.name==='popclaw_house_reconfirm')!;
  expect(JSON.parse((await tool.execute(ref,params) as {text:string}).text)).toMatchObject({status:'reconfirmed',next:'login'});
  expect(s.prompts).toEqual([]);expect(pinnedBinding(s.db,s.origin)?.incarnation).toBe('server_new');
});

it('a preexisting future-dated native policy cannot become new authority when its date arrives',async()=>{
  const s=await fixture(true);await oldLogin(s);
  const future=Date.now()+20_000;
  s.hostConfig.plugins.entries.popclaw.config.worldExecution.policies[0]!.authorizedAt=new Date(future).toISOString().replace(/\.\d{3}Z$/,'Z');
  const factory=s.nativeAdapter!.bindFactory({agentId:'main',getRuntimeConfig:()=>s.hostConfig});
  s.restore();const d=await decision(s);await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});await s.rt.commands.loginHouse(s.origin);
  const input={house:s.origin,kind:'test.note',params:{text:'future policy'},expected_capability_revision:readHouseCapabilityView(s.db,s.origin)!.verified.capabilityRevision};
  const clock=vi.spyOn(Date,'now').mockReturnValue(future+1000);
  try {
    expect(s.nativeAdapter!.actionReadiness({house:s.origin,kind:'test.note',recoveryDecisionId:d.decision_id})).toMatchObject({ready:false,reason:'NATIVE_POLICY_RECONFIRMATION_REQUIRED'});
    await expect(factory.withInvocation('future_old_policy',input,undefined,async permit=>s.worlds.nativeCommandContext(permit))).rejects.toThrow('NATIVE_POLICY_RECONFIRMATION_REQUIRED');
  } finally {clock.mockRestore();}
  expect(s.calls.filter(c=>c.path==='/v1/push')).toEqual([]);
});
it('a freshly configured native policy bound to the completed recovery can authorize new work',async()=>{
  const s=await fixture(true);await oldLogin(s);s.restore();const d=await decision(s);
  await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});await s.rt.commands.loginHouse(s.origin);
  s.worlds.stop();await s.worlds.whenIdle();s.nativeAdapter!.stop();await s.rt.stop();
  const freshConfig=structuredClone(s.hostConfig);
  Object.assign(freshConfig.plugins.entries.popclaw.config.worldExecution.policies[0]!,{recoveryDecisionId:d.decision_id});
  const adapter=createOpenClawWorldExecution({actorId,readActiveConfig:()=>freshConfig});cleanup.push(()=>adapter.stop());
  const houses=new HouseRuntime({db:s.db,signer:s.signer,origins:[s.origin],executionStores:s.catalog,publicV1Mode:true,
    readAuthorityFor:refusingReadAuthorityFor,configuredPinFor:()=>hex,commandPollMs:1,commandTimeoutMs:3000});
  cleanup.push(()=>houses.stop());houses.configureResources(s.resources);houses.resident.configureOrigins([]);houses.resident.start();await houses.manager.resumeAfterOwnership();houses.startReader();
  expect((await houses.commands.loginHouse(s.origin)).status).toBe('connected');
  const worlds=new WorldRuntime({mode:'commands',houses,signer:s.signer,actorId,nativeAuthorization:adapter,readCapabilities:o=>readHouseCapabilityView(s.db,o)});
  cleanup.push(async()=>{worlds.stop();await worlds.whenIdle();});
  const input={house:s.origin,kind:'test.note',params:{text:'fresh native approval'},expected_capability_revision:readHouseCapabilityView(s.db,s.origin)!.verified.capabilityRevision};
  expect(adapter.actionReadiness({house:s.origin,kind:'test.note',recoveryDecisionId:d.decision_id})).toEqual({ready:true,reason:null});
  const factory=adapter.bindFactory({agentId:'main',getRuntimeConfig:()=>freshConfig});
  await factory.withInvocation('fresh_recovery_policy',input,undefined,permit=>runWorldInvokeCommand(worlds.nativeCommandContext(permit),input));
  expect(s.calls.filter(c=>c.path==='/v1/push')).toHaveLength(1);
});
it('recovery cannot reselect a retired incarnation and reactivate its historical namespace',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();const d=await decision(s);
  await s.invoke('popclaw_house_reconfirm',{decision_id:d.decision_id});await s.rt.commands.loginHouse(s.origin);
  s.setIncarnation('server_old');await expect(decision(s)).rejects.toThrow('HOUSE_RECOVERY_INCARNATION_RETIRED');
  expect(pinnedBinding(s.db,s.origin)?.incarnation).toBe('server_new');expect(s.prompts).toHaveLength(1);
  expect(pinnedBinding(s.db,s.origin)?.blockedReason).toBeTruthy();expect(s.rt.captureGate(s.origin).isActive()).toBe(false);
  s.setIncarnation('server_third');const third=await decision(s);
  expect(await s.invoke('popclaw_house_reconfirm',{decision_id:third.decision_id})).toMatchObject({status:'reconfirmed'});
  expect(pinnedBinding(s.db,s.origin)?.incarnation).toBe('server_third');
  s.setIncarnation('server_new');await expect(decision(s)).rejects.toThrow('HOUSE_RECOVERY_INCARNATION_RETIRED');
});
it('takeover diagnoses an approved held decision even when caller exit prevented enqueue',async()=>{
  const s=await fixture();await oldLogin(s);s.restore();
  const recovery=new HouseRecovery({db:s.db,configuredPinFor:()=>hex,isOwnerCurrent:()=>false,quiesce:async()=>{},
    enqueue:async()=>{throw new Error('SYNTHETIC_CALLER_EXIT_BEFORE_ENQUEUE');}});
  const c=makeToolCollector();registerHouseTools({api:c.api,deps:{getHouseCommandContext:async()=>({coordinator:()=>s.rt.commands,recovery})}} as never);
  const d=await recovery.prepare(s.origin),params={decision_id:d.decision_id},ref='crash_before_enqueue';
  expect(await scriptOwnerApproval('popclaw_house_reconfirm',params,ref)).toBe('asked');
  await expect(c.tools.find(t=>t.name==='popclaw_house_reconfirm')!.execute(ref,params)).rejects.toThrow('SYNTHETIC_CALLER_EXIT_BEFORE_ENQUEUE');
  expect(s.db.queryOne<{state:string}>('SELECT state FROM house_recovery_decisions_v1 WHERE decision_id=?',[d.decision_id])?.state).toBe('approved');
  expect(s.db.queryOne('SELECT * FROM house_lifecycle_commands WHERE request_id=?',[d.decision_id])).toBeNull();
  await s.rt.stop();
  const restarted=new HouseRuntime({db:s.db,signer:s.signer,origins:[s.origin],readAuthorityFor:refusingReadAuthorityFor,configuredPinFor:()=>hex,commandPollMs:1,commandTimeoutMs:3000,publicV1Mode:true});
  cleanup.push(()=>restarted.stop());restarted.resident.configureOrigins([]);restarted.resident.start();await restarted.manager.resumeAfterOwnership();restarted.startReader();
  await vi.waitFor(()=>expect(s.db.queryOne('SELECT state,detail FROM house_recovery_decisions_v1 WHERE decision_id=?',[d.decision_id])).toEqual({state:'failed',detail:'HOUSE_RECOVERY_INTERRUPTED'}));
  expect(houseRecoveryHeld(s.db,s.origin)).toBe(true);expect((await restarted.commands.getHouseStatus(s.origin)).recovery).toMatchObject({state:'failed',detail:'HOUSE_RECOVERY_INTERRUPTED'});
  expect(pinnedBinding(s.db,s.origin)?.incarnation).toBe('server_old');
});
