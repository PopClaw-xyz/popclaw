import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { HouseCommandBus, MAX_IPC_PUSH_BYTES } from '../../../src/runtime/house-lifecycle/command-bus.js';
import type { HouseCommandPort, PushExecutionContext } from '../../../src/runtime/house-lifecycle/command-bus.js';
const A='https://a.invalid', B='https://b.invalid';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanups.reverse())await fn();cleanups.length=0;vi.useRealTimers();});
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'house-command-push-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
 const a=new LocalHostDb(join(dir,'ipc.db')),b=new LocalHostDb(join(dir,'ipc.db'));cleanups.push(()=>a.close(),()=>b.close());ensureHouseLifecycleSchema(a);
 for(const origin of [A,B])a.execute(`INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,session_id,house_revision,lease_expires_at,ack_key_hex) VALUES(?,'installation','enabled','connected',4,'session',7,?,'pin')`,[origin,Math.floor(Date.now()/1000)+600]);
 const port={knownHouseOrigins:()=>[A,B],loginHouse:vi.fn(async()=>({scope:'local_installation',origin:A,status:'connected',sessionId:'session'})),getHouseStatus:vi.fn(),logoutHouse:vi.fn()} as unknown as HouseCommandPort;
 let epoch=1;const owner={captureEpoch:()=>epoch===1?1:null,isEpochCurrent:(e:number)=>e===epoch};const next={captureEpoch:()=>epoch===2?2:null,isEpochCurrent:(e:number)=>e===epoch};const reader={captureEpoch:()=>null,isEpochCurrent:()=>false};
 return {a,b,port,owner,next,reader,takeover:()=>{epoch=2;}};
}
function bus(opts:ConstructorParameters<typeof HouseCommandBus>[0]){const b=new HouseCommandBus({pollMs:2,timeoutMs:1000,...opts});cleanups.push(()=>b.stop());return b;}
it('reader pushes exact bytes through one owner and preserves all receipt fields',async()=>{
 const s=setup();const execute=vi.fn(async(origin:string,bytes:Uint8Array,ctx:PushExecutionContext)=>{ctx.authorizeSend();expect(origin).toBe(A);expect([...bytes]).toEqual([1,2,3]);expect(ctx).toMatchObject({opSeq:4,sessionId:'session',houseRevision:7});return {status:201,eventId:'cid',deduplicated:false,detail:'accepted',taskId:'task'};});
 const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:execute});const reader=bus({db:s.b,coordinator:s.port,authority:s.reader});owner.start();
 const result=await reader.push(A,new Uint8Array([1,2,3]));expect(result).toMatchObject({status:201,eventId:'cid',taskId:'task',state:'done'});expect(execute).toHaveBeenCalledTimes(1);expect(reader.getPushOperation(result.operationId)?.result).toMatchObject(result);
});
it.each(['logout','session'])('queued A push becomes stale after %s while B continues',async(change)=>{
 const s=setup();const execute=vi.fn(async(_origin:string)=>({status:200}));const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:execute});const reader=bus({db:s.b,coordinator:s.port,authority:s.reader});
 const old=reader.push(A,new Uint8Array([1]));if(change==='logout')s.b.execute("UPDATE house_participation SET desired='disabled',op_seq=op_seq+1 WHERE house_origin=?",[A]);else s.b.execute("UPDATE house_participation SET session_id='replacement',house_revision=8 WHERE house_origin=?",[A]);
 const fresh=reader.push(B,new Uint8Array([2]));owner.start();expect(await old).toMatchObject({status:409,errorCode:'STALE_OPERATION'});expect(await fresh).toMatchObject({status:200});expect(execute).toHaveBeenCalledTimes(1);expect(execute.mock.calls[0]?.[0]).toBe(B);
});
it('pending deadline prevents send even when the owner appears later',async()=>{
 const s=setup();const reader=bus({db:s.b,coordinator:s.port,authority:s.reader,timeoutMs:5,pushDeadlineMs:20});const result=await reader.push(A,new Uint8Array([1]));expect(result).toMatchObject({status:0,state:'pending'});
 s.a.execute('UPDATE house_lifecycle_commands SET deadline_at = 0 WHERE request_id=?',[result.operationId]);const execute=vi.fn(async()=>({status:200}));const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:execute});owner.start();expect(reader.getPushOperation(result.operationId)?.result).toMatchObject({status:408,errorCode:'STALE_OPERATION'});expect(execute).not.toHaveBeenCalled();
});
it('owner takeover never replays running push and late old result cannot replace unknown',async()=>{
 const s=setup();const entered=deferred<void>(),release=deferred<void>();const execute=vi.fn(async()=>{entered.resolve();await release.promise;return {status:200,eventId:'late'};});const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:execute});const replay=vi.fn(async()=>({status:200}));const reader=bus({db:s.b,coordinator:s.port,authority:s.next,executePush:replay});cleanups.push(()=>release.resolve());owner.start();const resultP=reader.push(A,new Uint8Array([1]));await entered.promise;s.takeover();reader.start();const result=await resultP;expect(result).toMatchObject({status:0,errorCode:'ACTION_RESULT_UNKNOWN',state:'unknown'});release.resolve();await owner.stop();expect(replay).not.toHaveBeenCalled();expect(reader.getPushOperation(result.operationId)?.result).toMatchObject(result);
});
it('caller timeout during send reports unknown with a queryable later receipt',async()=>{
 const s=setup();const release=deferred<void>();const entered=deferred<void>();const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:async()=>{entered.resolve();await release.promise;return {status:200,eventId:'known'};}});const reader=bus({db:s.b,coordinator:s.port,authority:s.reader,timeoutMs:5});cleanups.push(()=>release.resolve());owner.start();const p=reader.push(A,new Uint8Array([1]));await entered.promise;const uncertain=await p;expect(uncertain).toMatchObject({status:0,errorCode:'ACTION_RESULT_UNKNOWN',state:'unknown'});release.resolve();await new Promise(r=>setTimeout(r,5));expect(reader.getPushOperation(uncertain.operationId)?.result).toMatchObject({status:200,eventId:'known'});
});
it('shutdown drains real executor before database close and stopped caller gets operation id',async()=>{
 const s=setup();const release=deferred<void>(),entered=deferred<void>();let context!:PushExecutionContext;const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:async(_origin,_bytes,ctx)=>{context=ctx;entered.resolve();await release.promise;s.a.queryOne('SELECT 1');return {status:200};}});owner.start();const work=owner.push(A,new Uint8Array([1]));await entered.promise;let drained=false;const stopping=owner.stop().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);expect(context.isActive()).toBe(false);const uncertain=await work;expect(uncertain).toMatchObject({status:0,errorCode:'ACTION_RESULT_UNKNOWN'});expect(uncertain.operationId).toBeTruthy();release.resolve();await stopping;s.a.close();
});
it('context final-send check rejects same-session logout after an await',async()=>{
 const s=setup();const entered=deferred<void>(),release=deferred<void>();const actual=vi.fn();const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:async(_o,_b,ctx)=>{entered.resolve();await release.promise;ctx.authorizeSend();actual();return {status:200};}});const reader=bus({db:s.b,coordinator:s.port,authority:s.reader});cleanups.push(()=>release.resolve());owner.start();const work=reader.push(A,new Uint8Array([1]));await entered.promise;s.b.execute("UPDATE house_participation SET desired='disabled',op_seq=5 WHERE house_origin=?",[A]);release.resolve();expect(await work).toMatchObject({status:0,errorCode:'ACTION_RESULT_UNKNOWN'});expect(actual).not.toHaveBeenCalled();
});
it('caps raw bytes at existing HTTP limit without storing oversized payload',async()=>{
 const s=setup();const reader=bus({db:s.b,coordinator:s.port,authority:s.reader});expect(MAX_IPC_PUSH_BYTES).toBe(2*1024*1024);expect(await reader.push(A,new Uint8Array(MAX_IPC_PUSH_BYTES+1))).toMatchObject({status:413,state:'failed'});expect(s.a.queryAll('SELECT * FROM house_lifecycle_commands')).toHaveLength(0);
});
it('stop resolves only after the public push promise has settled',async()=>{
 const s=setup();const reader=bus({db:s.b,coordinator:s.port,authority:s.reader});
 let settled=false;const pushing=reader.push(A,new Uint8Array([1])).finally(()=>{settled=true;});
 await reader.stop();expect(settled).toBe(true);s.b.close();await pushing;
});
it('result-write failure persists unknown without replaying the raw action',async()=>{
 const s=setup();const execute=vi.fn(async()=>({status:200,eventId:'accepted'}));
 const reader=bus({db:s.b,coordinator:s.port,authority:s.reader});const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:execute});
 const original=s.a.execute.bind(s.a);let fail=true;
 vi.spyOn(s.a,'execute').mockImplementation((sql,params)=>{
  if(fail && sql.includes("SET state = 'done'") && sql.includes('payload_bytes = NULL')){fail=false;throw new Error('simulated write failure');}
  return original(sql,params);
 });
 const pending=reader.push(A,new Uint8Array([1]));owner.start();
 expect(await pending).toMatchObject({state:'unknown',errorCode:'ACTION_RESULT_UNKNOWN'});
 await new Promise(r=>setTimeout(r,10));expect(execute).toHaveBeenCalledTimes(1);
});
it('migrates a pre-push command table without changing its queued intent',async()=>{
 const s=setup();s.a.execute(`CREATE TABLE house_lifecycle_commands(request_id TEXT PRIMARY KEY,kind TEXT NOT NULL,house_origin TEXT NOT NULL,baseline_seq INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',running_epoch INTEGER,result_json TEXT,created_at INTEGER NOT NULL)`);
 s.a.execute("INSERT INTO house_lifecycle_commands(request_id,kind,house_origin,baseline_seq,created_at) VALUES('existing','login',?,4,1)",[A]);
 bus({db:s.a,coordinator:s.port,authority:s.reader});bus({db:s.b,coordinator:s.port,authority:s.reader});
 expect(s.a.queryOne('SELECT request_id,kind,state FROM house_lifecycle_commands')).toEqual({request_id:'existing',kind:'login',state:'pending'});
 expect(s.a.queryAll<{name:string}>('PRAGMA table_info(house_lifecycle_commands)').map(c=>c.name)).toContain('payload_bytes');
});

it('treats a transport status zero as unknown rather than a completed receipt',async()=>{
 const s=setup();const execute=vi.fn(async()=>({status:0,detail:'connection closed'}));
 const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:execute});
 const result=await owner.push(A,new Uint8Array([1]));
 expect(result).toMatchObject({status:0,state:'unknown',errorCode:'ACTION_RESULT_UNKNOWN'});
 expect(owner.getPushOperation(result.operationId)?.result).toEqual(result);
 expect(execute).toHaveBeenCalledTimes(1);
});

it.each([
 ["desired='disabled'"], ["op_seq=op_seq+1"], ["session_id='replacement'"],
 ["house_revision=house_revision+1"], ["ack_key_hex='replacement'"],
 ["installation_id='replacement'"], ["lease_expires_at=0"],
])('final-send authorization rejects participation change: %s',async(change)=>{
 const s=setup();const entered=deferred<void>(),release=deferred<void>();const sent=vi.fn();
 const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:async(_origin,_bytes,ctx)=>{
  entered.resolve();await release.promise;ctx.authorizeSend();sent();return {status:200};
 }});cleanups.push(()=>release.resolve());
 const work=owner.push(A,new Uint8Array([1]));await entered.promise;
 s.b.execute(`UPDATE house_participation SET ${change} WHERE house_origin=?`,[A]);
 release.resolve();expect(await work).toMatchObject({state:'unknown',errorCode:'ACTION_RESULT_UNKNOWN'});expect(sent).not.toHaveBeenCalled();
});
it('claim race between two pumps in the same owner epoch sends once',async()=>{
 const s=setup();const release=deferred<void>();const execute=vi.fn(async()=>{await release.promise;return {status:200};});
 const first=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:execute});
 const second=bus({db:s.b,coordinator:s.port,authority:s.owner,executePush:execute});cleanups.push(()=>release.resolve());
 const reader=bus({db:s.b,coordinator:s.port,authority:s.reader});const work=reader.push(A,new Uint8Array([1]));
 const query=s.a.queryAll.bind(s.a);let race=true;
 vi.spyOn(s.a,'queryAll').mockImplementation((sql,params)=>{
  const rows=query(sql,params);
  if(race && sql.includes('ORDER BY created_at, request_id')){race=false;second.start();}
  return rows as never;
 });
 first.start();expect(execute).toHaveBeenCalledTimes(1);release.resolve();
 expect(await work).toMatchObject({status:200,state:'done'});expect(execute).toHaveBeenCalledTimes(1);
});
it('fallback rechecks owner authority after acquiring its write transaction',async()=>{
 const s=setup();const execute=vi.fn(async()=>({status:200}));
 const reader=bus({db:s.b,coordinator:s.port,authority:s.reader,timeoutMs:10});
 const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:execute});
 const write=s.a.execute.bind(s.a),transaction=s.a.transaction.bind(s.a);let fail=true,failed=false;
 vi.spyOn(s.a,'execute').mockImplementation((sql,params)=>{
  if(fail && sql.includes("SET state = 'done'") && sql.includes('payload_bytes = NULL')){
   fail=false;failed=true;throw new Error('simulated result-write failure');
  }
  return write(sql,params);
 });
 vi.spyOn(s.a,'transaction').mockImplementation(fn=>{
  if(failed){failed=false;s.takeover();}
  return transaction(fn);
 });
 const work=reader.push(A,new Uint8Array([1]));owner.start();const uncertain=await work;
 expect(uncertain).toMatchObject({state:'unknown',errorCode:'ACTION_RESULT_UNKNOWN'});
 expect(s.a.queryOne('SELECT state,running_epoch,result_json FROM house_lifecycle_commands WHERE request_id=?',[uncertain.operationId]))
  .toEqual({state:'running',running_epoch:1,result_json:null});
 const replay=vi.fn(async()=>({status:200}));const next=bus({db:s.b,coordinator:s.port,authority:s.next,executePush:replay});next.start();
 expect(reader.getPushOperation(uncertain.operationId)?.result).toMatchObject({state:'unknown',errorCode:'ACTION_RESULT_UNKNOWN'});
 expect(execute).toHaveBeenCalledTimes(1);expect(replay).not.toHaveBeenCalled();
});
it('stop drains a status caller already executing its timeout fallback',async()=>{
 const s=setup();const entered=deferred<void>(),release=deferred<void>();
 s.port.getHouseStatus=vi.fn(async()=>{
  entered.resolve();await release.promise;s.b.queryOne('SELECT 1');
  return {origin:A,desired:'enabled',phase:'connected',sessionId:'session',houseRevision:7,remoteStatus:'connected',gateActive:true,streams:{world:'active',inbox:'active'}} as const;
 });
 const reader=bus({db:s.b,coordinator:s.port,authority:s.reader,timeoutMs:5});cleanups.push(()=>release.resolve());
 const work=reader.getHouseStatus(A);await entered.promise;let drained=false;
 const stopping=reader.stop().then(()=>{drained=true;});await new Promise(r=>setTimeout(r,5));
 expect(drained).toBe(false);release.resolve();await stopping;s.b.close();await work;
});

it.each(['poll', 'final'] as const)('preserves the operation id when the %s read fails after enqueue', async (stage) => {
  const s = setup(), entered = deferred<void>(), release = deferred<void>();
  const execute = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { status: 200, eventId: 'committed' };
  });
  const owner = bus({ db: s.a, coordinator: s.port, authority: s.owner, executePush: execute });
  const reader = bus({ db: s.b, coordinator: s.port, authority: s.reader, timeoutMs: stage === 'final' ? 10 : 1000 });
  cleanups.push(() => release.resolve());
  const query = s.b.queryOne.bind(s.b);
  let fail = false, faults = 0;
  vi.spyOn(s.b, 'queryOne').mockImplementation((sql, params) => {
    const isFinalRead = sql.includes("AND kind = 'push'");
    if (fail && sql.includes('house_lifecycle_commands') && isFinalRead === (stage === 'final')) {
      fail = false;
      faults++;
      throw new Error('SQLITE_BUSY: database is locked');
    }
    return query(sql, params) as never;
  });
  owner.start();
  const outcome = reader.push(A, new Uint8Array([1])).then(value => ({ value }), error => ({ error: String(error) }));
  await entered.promise;
  fail = true;
  const got = await outcome;
  const rows = s.a.queryAll<{ request_id: string }>('SELECT request_id FROM house_lifecycle_commands');
  expect(rows).toHaveLength(1);
  const operationId = rows[0]!.request_id;
  expect(got).toMatchObject({ value: { status: 0, operationId, state: 'unknown', errorCode: 'ACTION_RESULT_UNKNOWN' } });
  expect(faults).toBe(1);
  release.resolve();
  await vi.waitFor(() => expect(reader.getPushOperation(operationId)?.result).toMatchObject({ status: 200, eventId: 'committed' }));
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([false, true])('reports pending only when the final queued-state read succeeds (fault=%s)', async (fault) => {
  const s = setup();
  const reader = bus({ db: s.b, coordinator: s.port, authority: s.reader, timeoutMs: 0 });
  const query = s.b.queryOne.bind(s.b);
  vi.spyOn(s.b, 'queryOne').mockImplementation((sql, params) => {
    if (fault && sql.includes("AND kind = 'push'")) throw new Error('SQLITE_BUSY: database is locked');
    return query(sql, params) as never;
  });
  const outcome = await reader.push(A, new Uint8Array([1])).then(value => ({ value }), error => ({ error: String(error) }));
  const rows = s.a.queryAll<{ request_id: string; state: string }>('SELECT request_id,state FROM house_lifecycle_commands');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('pending');
  expect(outcome).toMatchObject({ value: { status: 0, operationId: rows[0]!.request_id, state: fault ? 'unknown' : 'pending' } });
  if (fault) expect(outcome).toMatchObject({ value: { errorCode: 'ACTION_RESULT_UNKNOWN' } });
});

it.each(['participation read', 'insert'] as const)('still rejects a %s failure before enqueue commits', async (stage) => {
  const s = setup();
  const reader = bus({ db: s.b, coordinator: s.port, authority: s.reader });
  const failure = new Error('SQLITE_BUSY: database is locked');
  if (stage === 'participation read') {
    const query = s.b.queryOne.bind(s.b);
    vi.spyOn(s.b, 'queryOne').mockImplementation((sql, params) => {
      if (sql.includes('house_participation')) throw failure;
      return query(sql, params) as never;
    });
  } else {
    const execute = s.b.execute.bind(s.b);
    vi.spyOn(s.b, 'execute').mockImplementation((sql, params) => {
      if (sql.includes('INSERT INTO house_lifecycle_commands')) throw failure;
      return execute(sql, params);
    });
  }
  await expect(reader.push(A, new Uint8Array([1]))).rejects.toBe(failure);
  expect(s.a.queryAll('SELECT * FROM house_lifecycle_commands')).toHaveLength(0);
});

it('preserves the enqueued operation id when owner-authority lookup throws in pump', async () => {
  const s = setup();
  const authority = { captureEpoch: () => { throw new Error('SQLITE_BUSY: owner lookup failed'); }, isEpochCurrent: () => false };
  const reader = bus({ db: s.b, coordinator: s.port, authority });
  const outcome = await reader.push(A, new Uint8Array([1])).then(value => ({ value }), error => ({ error: String(error) }));
  const rows = s.a.queryAll<{ request_id: string; state: string }>('SELECT request_id,state FROM house_lifecycle_commands');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('pending');
  expect(outcome).toMatchObject({ value: { status: 0, operationId: rows[0]!.request_id, state: 'unknown', errorCode: 'ACTION_RESULT_UNKNOWN' } });
});


it('persists an immutable effect reference from reader to owner execution', async () => {
 const s=setup();
 const ref={version:1 as const,kind:'world_direct_dm' as const,requestId:'a'.repeat(64),participationId:'participation',reservationId:'original',jobId:'job'};
 const seen=vi.fn(async(_origin:string,_bytes:Uint8Array,ctx:PushExecutionContext)=>{
  expect(ctx.effectReference).toEqual({...ref,reservationId:'original'});
  expect(Object.isFrozen(ctx.effectReference)).toBe(true);
  return {status:201};
 });
 const reader=bus({db:s.b,coordinator:s.port,authority:s.reader});
 const pending=reader.push(A,new Uint8Array([1]),ref);
 ref.reservationId='changed';
 const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:seen});owner.start();
 expect(await pending).toMatchObject({status:201,state:'done'});
 expect(seen).toHaveBeenCalledTimes(1);
});

it.each(['null','{}','{"version":1,"version":2}','damaged'])('a damaged persisted effect fails closed before executor: %s',async damaged=>{
 const s=setup();const reader=bus({db:s.b,coordinator:s.port,authority:s.reader});
 const ref={version:1 as const,kind:'world_direct_dm' as const,requestId:'a'.repeat(64),participationId:'participation',reservationId:'original',jobId:'job'};
 const pending=reader.push(A,new Uint8Array([1]),ref);
 s.b.execute('UPDATE house_lifecycle_commands SET effect_json=?',[damaged]);
 const execute=vi.fn(async()=>({status:201}));const owner=bus({db:s.a,coordinator:s.port,authority:s.owner,executePush:execute});owner.start();
 expect(await pending).toMatchObject({status:409,state:'failed'});expect(execute).not.toHaveBeenCalled();
});
