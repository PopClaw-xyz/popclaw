/** PC008 pending-IPC trust capture probe. Synthetic SQLite, no transport. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { HouseCommandBus } from '../../../src/runtime/house-lifecycle/command-bus.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import type { HouseCommandPort } from '../../../src/runtime/house-lifecycle/command-bus.js';
import { mintHouse } from '../../helpers/signed-manifest.js';
const ORIGIN='https://house.pc008-queue.invalid';
const closers: Array<() => void | Promise<void>>=[];
afterEach(async()=>{for(const close of closers.splice(0).reverse()) await close(); vi.unstubAllGlobals();});
it('PC008 queued trust regression: a newer approved pin cannot authorize an older pending social push', async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('PC008_REAL_NETWORK_FORBIDDEN');}));
  const root=mkdtempSync(join(tmpdir(),'pc008-queued-trust-'));
  closers.push(()=>rmSync(root,{recursive:true,force:true}));
  const writer=new LocalHostDb(join(root,'synthetic.db'));
  const reader=new LocalHostDb(join(root,'synthetic.db'));
  closers.push(()=>writer.close(),()=>reader.close());
  runMigrations(writer,resolve(dirname(fileURLToPath(import.meta.url)),'../../../migrations'));
  ensureHouseLifecycleSchema(writer);
  writer.execute(`INSERT INTO house_participation(house_origin,installation_id,op_seq,desired,phase)
    VALUES (?, 'synthetic-install', 1, 'enabled', 'connected')`,[ORIGIN]);
  const old=mintHouse({origin:ORIGIN,seed:91}), next=mintHouse({origin:ORIGIN,seed:92});
  establishTrust(writer,{origin:ORIGIN,houseKey:old.houseKey,incarnation:old.incarnation},'tofu',()=>1);
  const port={knownHouseOrigins:()=>[ORIGIN]} as HouseCommandPort;
  let sends=0;
  const b=new HouseCommandBus({db:reader,coordinator:port,
    authority:{captureEpoch:()=>null,isEpochCurrent:()=>false},timeoutMs:5,pollMs:1});
  const a=new HouseCommandBus({db:writer,coordinator:port,
    authority:{captureEpoch:()=>7,isEpochCurrent:e=>e===7},pollMs:1,
    executePush:async(_origin,_bytes,context)=>{context.authorizeSend();sends++;return{status:202};}});
  closers.push(()=>a.stop(),()=>b.stop());
  const pending=await b.push(ORIGIN,new Uint8Array([1,2,3]));
  expect(pending.state).toBe('pending');
  // Production owner-explicit configured upgrade, not a hand-damaged pin.
  expect(establishTrust(writer,{origin:ORIGIN,houseKey:next.houseKey,incarnation:next.incarnation},'configured',()=>2).outcome).toBe('upgraded');
  a.start();
  await vi.waitFor(()=>expect(b.getPushOperation(pending.operationId)?.state).toBe('done'));
  expect(sends,'original pin decision must survive the durable reader-to-owner queue').toBe(0);
  expect(b.getPushOperation(pending.operationId)?.result).toMatchObject({state:'failed',errorCode:'STALE_OPERATION'});
  expect(fetch).not.toHaveBeenCalled();
});

import { LegacyHouseCommandBus } from '../../helpers/legacy-house-command-bus.js';
import { parseLegacyPushCapture } from '../../../src/runtime/house-lifecycle/push-capture.js';

async function queuedFixture() {
  const root=mkdtempSync(join(tmpdir(),'pc008-queue-compat-'));
  closers.push(()=>rmSync(root,{recursive:true,force:true}));
  const a=new LocalHostDb(join(root,'queue.db')), b=new LocalHostDb(join(root,'queue.db'));
  closers.push(()=>a.close(),()=>b.close());
  runMigrations(a,resolve(dirname(fileURLToPath(import.meta.url)),'../../../migrations'));
  ensureHouseLifecycleSchema(a);
  a.execute(`INSERT INTO house_participation(house_origin,installation_id,op_seq,desired,phase)
    VALUES (?, 'same-install', 1, 'enabled', 'connected')`,[ORIGIN]);
  const house=mintHouse({origin:ORIGIN,seed:91});
  establishTrust(a,{origin:ORIGIN,houseKey:house.houseKey,incarnation:house.incarnation},'tofu',()=>1);
  const port={knownHouseOrigins:()=>[ORIGIN]} as HouseCommandPort;
  const owner={captureEpoch:()=>1,isEpochCurrent:(e:number)=>e===1}, reader={captureEpoch:()=>null,isEpochCurrent:()=>false};
  return {root,a,b,house,port,owner,reader};
}

it.each(['new-to-new','new-to-old','old-to-new'] as const)('PC008 queue: %s preserves effect or refuses before sending',async combination=>{
  const f=await queuedFixture();
  const ref={version:1 as const,kind:'world_intent' as const,requestId:'a'.repeat(64),executionReference:{kind:'owner_action' as const,reservationId:'explicit-reference'}};
  const Reader=combination==='old-to-new'?LegacyHouseCommandBus:HouseCommandBus;
  const Owner=combination==='new-to-old'?LegacyHouseCommandBus:HouseCommandBus;
  const b=new Reader({db:f.b,coordinator:f.port,authority:f.reader,pollMs:1,timeoutMs:1});
  const sends=vi.fn(async(_origin:string,_bytes:Uint8Array,ctx:import('../../../src/runtime/house-lifecycle/command-bus.js').PushExecutionContext)=>{
    ctx.authorizeSend();expect(ctx.effectReference).toEqual(ref);return{status:201};
  });
  const a=new Owner({db:f.a,coordinator:f.port,authority:f.owner,executePush:sends,pollMs:1});
  closers.push(()=>a.stop(),()=>b.stop());
  const queued=await b.push(ORIGIN,new Uint8Array([7]),ref);
  expect(queued.state).toBe('pending');
  if(combination!=='old-to-new') {
    const payload=f.b.queryOne<{effect_json:string}>('SELECT effect_json FROM house_lifecycle_commands WHERE request_id=?',[queued.operationId])!;
    expect(parseLegacyPushCapture(payload.effect_json).effect).toEqual(ref);
  }
  a.start();await vi.waitFor(()=>expect(b.getPushOperation(queued.operationId)?.state).toBe('done'));
  expect(sends).toHaveBeenCalledTimes(combination==='new-to-new'?1:0);
  if(combination!=='new-to-new') expect(b.getPushOperation(queued.operationId)?.result).toMatchObject({state:'failed',errorCode:'STALE_OPERATION'});
});

it.each([null,'{}','{"version":999,"kind":"house_command_capture"}','{"version":1,"version":1}'])('PC008 queue: old or damaged capture %s never falls back',async damaged=>{
  const f=await queuedFixture();
  const b=new HouseCommandBus({db:f.b,coordinator:f.port,authority:f.reader,pollMs:1,timeoutMs:1});
  const sends=vi.fn(async()=>({status:200}));
  const a=new HouseCommandBus({db:f.a,coordinator:f.port,authority:f.owner,executePush:sends,pollMs:1});
  closers.push(()=>a.stop(),()=>b.stop());
  const queued=await b.push(ORIGIN,new Uint8Array([1]));
  f.b.execute('UPDATE house_lifecycle_commands SET effect_json=? WHERE request_id=?',[damaged,queued.operationId]);
  a.start();await vi.waitFor(()=>expect(b.getPushOperation(queued.operationId)?.state).toBe('done'));
  expect(sends).not.toHaveBeenCalled();
  expect(b.getPushOperation(queued.operationId)?.result).toMatchObject({state:'failed',errorCode:'STALE_OPERATION'});
});

it('PC008 queue: no-pin compatibility is explicit and loses captured authority when a pin appears',async()=>{
  const f=await queuedFixture(); f.a.execute('DELETE FROM house_binding_pin');
  const b=new HouseCommandBus({db:f.b,coordinator:f.port,authority:f.reader,pollMs:1,timeoutMs:1});
  const sends=vi.fn(async()=>({status:200}));
  const a=new HouseCommandBus({db:f.a,coordinator:f.port,authority:f.owner,executePush:sends,pollMs:1});
  closers.push(()=>a.stop(),()=>b.stop());
  const queued=await b.push(ORIGIN,new Uint8Array([1]));
  expect(parseLegacyPushCapture(f.a.queryOne<{effect_json:string}>('SELECT effect_json FROM house_lifecycle_commands')!.effect_json).trust.binding).toBeNull();
  establishTrust(f.a,{origin:ORIGIN,houseKey:f.house.houseKey,incarnation:f.house.incarnation},'tofu',()=>1);
  a.start();await vi.waitFor(()=>expect(b.getPushOperation(queued.operationId)?.state).toBe('done'));
  expect(sends).not.toHaveBeenCalled();
});

it('PC008 queue: capture survives closing caller and owner handles before execution',async()=>{
  const f=await queuedFixture();
  const b=new HouseCommandBus({db:f.b,coordinator:f.port,authority:f.reader,pollMs:1,timeoutMs:1});
  const queued=await b.push(ORIGIN,new Uint8Array([1])); await b.stop(); f.a.close();f.b.close();
  const c=new LocalHostDb(join(f.root,'queue.db'));closers.push(()=>c.close());
  c.execute('UPDATE house_binding_pin SET revision=revision+1 WHERE origin=?',[ORIGIN]);
  const sends=vi.fn(async()=>({status:200}));
  const a=new HouseCommandBus({db:c,coordinator:f.port,authority:f.owner,executePush:sends,pollMs:1});closers.push(()=>a.stop());
  a.start(); await vi.waitFor(()=>expect(a.getPushOperation(queued.operationId)?.state).toBe('done'));
  expect(sends).not.toHaveBeenCalled();
});

it('PC008 queue: in-flight captured trust loss yields unknown and never replays',async()=>{
  const f=await queuedFixture();let release!:()=>void;
  const sent=vi.fn();
  const a=new HouseCommandBus({db:f.a,coordinator:f.port,authority:f.owner,pollMs:1,
    executePush:async(_o,_b,ctx)=>{await new Promise<void>(r=>{release=r;});ctx.authorizeSend();sent();return{status:200};}});
  closers.push(()=>a.stop(),()=>release?.());
  const work=a.push(ORIGIN,new Uint8Array([1]));await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  f.b.execute("UPDATE house_binding_pin SET blocked_reason='blocked',revision=revision+1 WHERE origin=?",[ORIGIN]);
  release();const result=await work;
  expect(result).toMatchObject({state:'unknown',errorCode:'ACTION_RESULT_UNKNOWN'});
  expect(sent).not.toHaveBeenCalled();
  a.start();expect(a.getPushOperation(result.operationId)?.result).toMatchObject({state:'unknown'});
});


it.each(['new-no-pin','old-no-pin'])('PC008 queue: %s retains compatibility only with an explicit new capture',async kind=>{
  const f=await queuedFixture(); f.a.execute('DELETE FROM house_binding_pin');
  const Reader=kind==='old-no-pin'?LegacyHouseCommandBus:HouseCommandBus;
  const b=new Reader({db:f.b,coordinator:f.port,authority:f.reader,pollMs:1,timeoutMs:1});
  const sends=vi.fn(async()=>({status:200}));
  const a=new HouseCommandBus({db:f.a,coordinator:f.port,authority:f.owner,executePush:sends,pollMs:1});
  closers.push(()=>a.stop(),()=>b.stop());
  const queued=await b.push(ORIGIN,new Uint8Array([1]));
  a.start();await vi.waitFor(()=>expect(b.getPushOperation(queued.operationId)?.state).toBe('done'));
  expect(sends).toHaveBeenCalledTimes(kind==='new-no-pin'?1:0);
  if(kind==='old-no-pin') expect(b.getPushOperation(queued.operationId)?.result).toMatchObject({state:'failed',errorCode:'STALE_OPERATION'});
});

it('PC008 compatibility limit: old caller plus old owner does not acquire new pin semantics',async()=>{
  const f=await queuedFixture();
  const b=new LegacyHouseCommandBus({db:f.b,coordinator:f.port,authority:f.reader,pollMs:1,timeoutMs:1});
  const sends=vi.fn(async()=>({status:200}));
  const a=new LegacyHouseCommandBus({db:f.a,coordinator:f.port,authority:f.owner,executePush:sends,pollMs:1});
  closers.push(()=>a.stop(),()=>b.stop());
  const queued=await b.push(ORIGIN,new Uint8Array([1]));
  const next=mintHouse({origin:ORIGIN,seed:92});
  establishTrust(f.a,{origin:ORIGIN,houseKey:next.houseKey,incarnation:next.incarnation},'configured',()=>2);
  a.start();await vi.waitFor(()=>expect(b.getPushOperation(queued.operationId)?.state).toBe('done'));
  expect(sends).toHaveBeenCalledTimes(1); // frozen old interpreter characterization, not candidate permission
});
