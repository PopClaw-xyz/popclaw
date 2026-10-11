import {expect,it,vi} from 'vitest';
import {SummaryReadReuse} from '../../../src/world/summary-read-reuse.js';
import type {WorldSummaryResult} from '../../../src/world/world-summary-client.js';
const failure:WorldSummaryResult={ok:false,failure:{code:'HOUSE_REMOTE_TIMEOUT',diagnostic:{phase:'fetch',cause:'timeout',timeoutMs:10000}}};
const success:WorldSummaryResult={ok:true,summary:{window_hours:24,generated_at_ms:1,total_posts:1,distinct_authors:1,authors:{},hot_posts:[]}};
const scope=()=>({token:{},requestToken:{},isCurrent:()=>true});
function deferred() {let resolve!:(value:WorldSummaryResult)=>void;const promise=new Promise<WorldSummaryResult>(r=>{resolve=r;});return {promise,resolve};}
it('coalesces simultaneous reads without caching a completed successful overview',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),client={},wait=deferred();
  const work=vi.fn(()=>wait.promise);
  const a=reuse.read(request,client,24,false,work),b=reuse.read(request,client,24,false,work);
  await Promise.resolve();expect(work).toHaveBeenCalledTimes(1);
  wait.resolve(success);expect(await a).toBe(success);expect(await b).toBe(success);
  await reuse.read(request,client,24,false,work);expect(work).toHaveBeenCalledTimes(2);
});
it('reuses typed remote failures only within the same request, client and window',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),client={},work=vi.fn(async()=>failure);
  await reuse.read(request,client,24,false,work);
  expect(await reuse.read({...request,token:{}},client,24,false,work)).toMatchObject({...failure,reused:true});
  expect(work).toHaveBeenCalledTimes(1);
  await reuse.read(request,{},24,false,work);await reuse.read(request,client,48,false,work);
  await reuse.read(scope(),client,24,false,work);expect(work).toHaveBeenCalledTimes(4);
});
it('explicit retry makes a fresh request and replaces the failed attempt',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),client={},work=vi.fn(async()=>failure);
  await reuse.read(request,client,24,false,work);await reuse.read(request,client,24,true,work);
  expect(work).toHaveBeenCalledTimes(2);
  await reuse.read(request,client,24,false,work);expect(work).toHaveBeenCalledTimes(2);
});
it('does not infer a request from an input-generation token or a call id',async()=>{
  const reuse=new SummaryReadReuse(),client={},work=vi.fn(async()=>failure);
  const unknown={token:{},isCurrent:()=>true};
  await reuse.read(unknown,client,24,false,work);await reuse.read(unknown,client,24,false,work);
  await reuse.read(undefined,client,24,false,work);expect(work).toHaveBeenCalledTimes(3);
});
it('rechecks currentness before using a cached failure and after every awaited result',async()=>{
  const reuse=new SummaryReadReuse(),client={},wait=deferred();let live=true;
  const request={...scope(),isCurrent:()=>live},work=vi.fn(()=>wait.promise);
  const pending=reuse.read(request,client,24,false,work);await Promise.resolve();live=false;wait.resolve(failure);
  expect(await pending).toMatchObject({ok:false,failure:{code:'HOUSE_ACTION_STALE'}});
  expect(await reuse.read(request,client,24,false,work)).toMatchObject({ok:false,failure:{code:'HOUSE_ACTION_STALE'}});
  expect(work).toHaveBeenCalledTimes(1);
});
it('does not cache a lifecycle refusal or a rejected implementation promise',async()=>{
  const reuse=new SummaryReadReuse(),request=scope(),client={};
  const refused=vi.fn(async():Promise<WorldSummaryResult>=>({ok:false,failure:{code:'HOUSE_TRUST_REVOKED'}}));
  await reuse.read(request,client,24,false,refused);await reuse.read(request,client,24,false,refused);
  expect(refused).toHaveBeenCalledTimes(2);
  const rejected=vi.fn(async()=>{throw new Error('synthetic implementation failure');});
  await expect(reuse.read(request,client,24,false,rejected)).rejects.toThrow();
  await expect(reuse.read(request,client,24,false,rejected)).rejects.toThrow();expect(rejected).toHaveBeenCalledTimes(2);
});
