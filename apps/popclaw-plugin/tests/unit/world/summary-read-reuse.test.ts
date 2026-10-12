import {expect,it,vi} from 'vitest';
import {SummaryReadReuse} from '../../../src/world/summary-read-reuse.js';
import type {WorldSummaryResult} from '../../../src/world/world-summary-client.js';
const failure:WorldSummaryResult={ok:false,failure:{code:'HOUSE_REMOTE_TIMEOUT',diagnostic:{phase:'fetch',cause:'timeout',timeoutMs:10000}}};
const success:WorldSummaryResult={ok:true,summary:{window_hours:24,generated_at_ms:1,total_posts:1,distinct_authors:1,authors:{},hot_posts:[]}};
const clientScope=()=>{const generation=scope();return {captureReadGeneration:()=>generation,validateCachedResult:(result:WorldSummaryResult)=>result};};
const scope=()=>({token:{},requestToken:{},isCurrent:()=>true});
function deferred() {let resolve!:(value:WorldSummaryResult)=>void;const promise=new Promise<WorldSummaryResult>(r=>{resolve=r;});return {promise,resolve};}
it('coalesces simultaneous reads without caching a completed successful overview',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),client=clientScope(),wait=deferred();
  const work=vi.fn(()=>wait.promise);
  const a=reuse.read(request,client,24,false,work),b=reuse.read(request,client,24,false,work);
  await Promise.resolve();expect(work).toHaveBeenCalledTimes(1);
  wait.resolve(success);expect(await a).toBe(success);expect(await b).toBe(success);
  await reuse.read(request,client,24,false,work);expect(work).toHaveBeenCalledTimes(2);
});
it('reuses typed remote failures only within the same request, client and window',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),client=clientScope(),work=vi.fn(async()=>failure);
  await reuse.read(request,client,24,false,work);
  expect(await reuse.read({...request,token:{}},client,24,false,work)).toMatchObject({...failure,reused:true});
  expect(work).toHaveBeenCalledTimes(1);
  await reuse.read(request,clientScope(),24,false,work);await reuse.read(request,client,48,false,work);
  await reuse.read(scope(),client,24,false,work);expect(work).toHaveBeenCalledTimes(4);
});
it('explicit retry makes a fresh request and replaces the failed attempt',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),client=clientScope(),work=vi.fn(async()=>failure);
  await reuse.read(request,client,24,false,work);await reuse.read(request,client,24,true,work);
  expect(work).toHaveBeenCalledTimes(2);
  await reuse.read(request,client,24,false,work);expect(work).toHaveBeenCalledTimes(2);
});
it('does not infer a request from an input-generation token or a call id',async()=>{
  const reuse=new SummaryReadReuse(),client=clientScope(),work=vi.fn(async()=>failure);
  const unknown={token:{},isCurrent:()=>true};
  await reuse.read(unknown,client,24,false,work);await reuse.read(unknown,client,24,false,work);
  await reuse.read(undefined,client,24,false,work);expect(work).toHaveBeenCalledTimes(3);
});
it('rechecks currentness before using a cached failure and after every awaited result',async()=>{
  const reuse=new SummaryReadReuse(),client=clientScope(),wait=deferred();let live=true;
  const request={...scope(),isCurrent:()=>live},work=vi.fn(()=>wait.promise);
  const pending=reuse.read(request,client,24,false,work);await Promise.resolve();live=false;wait.resolve(failure);
  expect(await pending).toMatchObject({ok:false,failure:{code:'HOUSE_ACTION_STALE'}});
  expect(await reuse.read(request,client,24,false,work)).toMatchObject({ok:false,failure:{code:'HOUSE_ACTION_STALE'}});
  expect(work).toHaveBeenCalledTimes(1);
});
it('does not cache a lifecycle refusal or a rejected implementation promise',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),client=clientScope();
  const refused=vi.fn(async():Promise<WorldSummaryResult>=>({ok:false,failure:{code:'HOUSE_TRUST_REVOKED'}}));
  await reuse.read(request,client,24,false,refused);await reuse.read(request,client,24,false,refused);
  expect(refused).toHaveBeenCalledTimes(2);
  const rejected=vi.fn(async()=>{throw new Error('synthetic implementation failure');});
  await expect(reuse.read(request,client,24,false,rejected)).rejects.toThrow();
  await expect(reuse.read(request,client,24,false,rejected)).rejects.toThrow();expect(rejected).toHaveBeenCalledTimes(2);
});


it('reads afresh after the same client moves to a different House connection generation',async()=>{
  const reuse=new SummaryReadReuse(),request=scope();let connection=scope();
  const client={captureReadGeneration:()=>connection};
  const work=vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
  await reuse.read(request,client,24,false,work);
  connection=scope();
  expect(await reuse.read({...request,token:{}},client,24,false,work)).toBe(success);
  expect(work).toHaveBeenCalledTimes(2);
});
it('does not reuse failures when the host cannot prove a connection generation',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),client={},work=vi.fn(async()=>failure);
  await reuse.read(request,client,24,false,work);await reuse.read(request,client,24,false,work);
  expect(work).toHaveBeenCalledTimes(2);
});
it('rejects a result whose scope expires while awaiting even without a request reuse token',async()=>{
  const reuse=new SummaryReadReuse(),wait=deferred();let live=true;
  const request={token:{},isCurrent:()=>live};
  const pending=reuse.read(request,{},24,false,()=>wait.promise);
  live=false;wait.resolve(success);
  expect(await pending).toMatchObject({ok:false,failure:{code:'HOUSE_ACTION_STALE'}});
});
it('rejects an inactive connection before attempting work or reusing a previous remote failure',async()=>{
  const reuse=new SummaryReadReuse(),request=scope();let live=true;
  const client={captureReadGeneration:()=>({token:connection,isCurrent:()=>live})},connection={};
  const work=vi.fn(async()=>failure);
  await reuse.read(request,client,24,false,work);live=false;
  expect(await reuse.read(request,client,24,false,work)).toMatchObject({ok:false,failure:{code:'HOUSE_ACTION_STALE'}});
  expect(work).toHaveBeenCalledTimes(1);
});
it('rejects an old connection result after an awaited network read completes',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),wait=deferred();let live=true;
  const client={captureReadGeneration:()=>({token:{},isCurrent:()=>live})};
  const pending=reuse.read(request,client,24,false,()=>wait.promise);
  await Promise.resolve();live=false;wait.resolve(success);
  expect(await pending).toMatchObject({ok:false,failure:{code:'HOUSE_ACTION_STALE'}});
});

it('refreshes an expired captured gate even if the manager has not rotated its signal yet',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),token={};let oldLive=true;
  let gate={token,isCurrent:()=>oldLive};const client={captureReadGeneration:()=>gate};
  const work=vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
  await reuse.read(request,client,24,false,work);oldLive=false;
  gate={token,isCurrent:()=>true};
  expect(await reuse.read(request,client,24,false,work)).toBe(success);
  expect(work).toHaveBeenCalledTimes(2);
});
it('rechecks source and access before reusing a successful cached fallback',async()=>{
  const reuse=new SummaryReadReuse(),request=scope();
  const cached:WorldSummaryResult={...success,freshness:{status:'refresh_failed',origin:'https://example.test',sourceBinding:'old',fetchedAtMs:1,checkedAtMs:1,attemptedAtMs:2}};
  const validateCachedResult=vi.fn(()=>({ok:false as const,failure:{code:'HOUSE_ACTION_STALE' as const}}));
  const client={...clientScope(),validateCachedResult},work=vi.fn(async()=>cached);
  expect(await reuse.read(request,client,24,false,work)).toBe(cached);
  expect(await reuse.read(request,client,24,false,work)).toMatchObject({ok:false,failure:{code:'HOUSE_ACTION_STALE'}});
  expect(validateCachedResult).toHaveBeenCalledTimes(1);
  expect(work).toHaveBeenCalledTimes(1);
});
it('revalidates a pending fresh success against a changed binding even with the same generation token',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),wait=deferred();
  let binding='old';
  const client={...clientScope(),validateCachedResult:(result:WorldSummaryResult)=>binding==='old' ? result : {ok:false as const,failure:{code:'HOUSE_ACTION_STALE' as const}}};
  const first=reuse.read(request,client,24,false,()=>wait.promise);
  const second=reuse.read(request,client,24,false,()=>wait.promise);
  await Promise.resolve();binding='new';wait.resolve(success);
  await first;
  expect(await second).toMatchObject({ok:false,failure:{code:'HOUSE_ACTION_STALE'}});
});
