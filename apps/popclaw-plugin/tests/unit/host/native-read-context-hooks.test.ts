import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../../src/host/migrations.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { establishTrustInTx } from '../../../src/world/house-binding-pin.js';
import { guideBindingDigest, markHouseGuideDelivered, recordJoinedGuide } from '../../../src/world/house-guide-context.js';
import { entryDigest } from '../../../src/runtime/house-lifecycle/participation-journal.js';
import { clearPerProcess, getOrCreatePerProcess, peekPerProcess } from '../../../src/runtime/once.js';
import { adoptOrRebootRuntime } from '../../../src/runtime/stale-runtime-memo.js';
import { createNativeReadContext, sharedNativeReadContext } from '../../../src/host/native-read-context.js';
import { acknowledgeNativeGuideInput, registerNativeReadContextHooks } from '../../../src/host/native-read-context-hooks.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const id={agentId:'main',sessionKey:'synthetic',sessionId:'physical',runId:'run'};
const close: Array<()=>void>=[];
afterEach(()=>{clearPerProcess('runtime');clearPerProcess('runtime:revoked-readers');clearPerProcess('native-read-context-v1');for(const fn of close.splice(0))fn();});
function fixture() {
  const db=new InMemoryHostDb();close.push(()=>db.close());runMigrations(db,fileURLToPath(new URL('../../../migrations',import.meta.url)));ensureHouseLifecycleSchema(db);
  const origin='https://guide.invalid',house=mintHouse({origin}),body='Complete synthetic guide',digest=entryDigest(body);
  db.transaction(tx=>{
    establishTrustInTx(tx,{origin,houseKey:house.houseKey,incarnation:house.incarnation},'tofu',1);
    tx.execute("INSERT INTO house_participation(house_origin,installation_id,op_seq,desired,phase,updated_at) VALUES (?,'fixture',1,'enabled','connected',1)",[origin]);
    recordJoinedGuide(tx,{origin,opSeq:1,rawBytes:new TextEncoder().encode('{"guide_url":"/guide.md"}'),manifestDigest:'manifest'});
    tx.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=?',[body,digest]);
  });
  const guide={status:'available',origin,bindingDigest:guideBindingDigest(db,origin),opSeq:1,guide:body,guideDigest:digest};
  const event={runId:id.runId,sessionId:id.sessionId,historyMessages:[{role:'toolResult',content:[{type:'text',text:JSON.stringify({house_guide_contexts:[guide]})}]}]};
  const mark=vi.fn(context=>markHouseGuideDelivered(db,context));
  const rt={host:{db},houseRuntime:{markHouseGuideDelivered:mark,publicReadGate:()=>({isActive:()=>true})}};
  const delivered=()=>db.queryOne<{delivered_digest:string|null}>('SELECT delivered_digest FROM house_guide_context')?.delivered_digest;
  return {db,guide,event,rt,mark,delivered};
}
function hooks(context=createNativeReadContext()) {
  const registered=new Map<string,(event:unknown,context:unknown)=>unknown>();
  const api={on:(name:string,fn:(event:unknown,context:unknown)=>unknown)=>registered.set(name,fn),logger:{error:vi.fn()}};
  registerNativeReadContextHooks(api as unknown as Pick<OpenClawPluginApi,'on'|'logger'>,context);
  return {registered,context,emit:(name:string,event:unknown,ctx:unknown=id)=>registered.get(name)?.(event,ctx)};
}
it('a cold llm_input establishes a synchronous input scope without booting a runtime',async()=>{
  const h=hooks();const result=h.emit('llm_input',{runId:id.runId,sessionId:id.sessionId,historyMessages:[]});
  h.emit('before_tool_call',{toolName:'popclaw_show_feed',toolCallId:'cold',runId:id.runId},{...id,toolName:'popclaw_show_feed',toolCallId:'cold'});
  const ctx={...id,assertInvocationCurrent:()=>{}};
  expect(await h.context.run(ctx,'popclaw_show_feed','cold',undefined,async()=>h.context.current()?.isCurrent())).toBe(true);
  await result;expect(peekPerProcess('runtime')).toBeUndefined();
});
it('a second registration observes complete input and acknowledges the existing shared runtime',async()=>{
  const f=fixture(),a=hooks(sharedNativeReadContext()),b=hooks(sharedNativeReadContext());
  expect(a.context).toBe(b.context);
  getOrCreatePerProcess('runtime',()=>Promise.resolve(f.rt));
  await b.emit('llm_input',f.event);
  expect(f.delivered()).toBe(f.guide.guideDigest);expect(f.mark).toHaveBeenCalledOnce();
});
it.each(['closed','replaced','stopping','scope-ended'])('does not acknowledge a %s runtime/input after awaiting the memo',async reason=>{
  const f=fixture(),context=createNativeReadContext(),observation=context.observe(f.event,id)!;
  let resolve!:(rt:typeof f.rt)=>void;
  const pending=new Promise<typeof f.rt>(r=>{resolve=r;}),closing=new AbortController();
  const boot=adoptOrRebootRuntime('runtime',()=>pending,()=>{},closing.signal);
  const ack=acknowledgeNativeGuideInput(observation);
  if(reason==='closed') f.db.close();
  if(reason==='replaced'){clearPerProcess('runtime');getOrCreatePerProcess('runtime',()=>Promise.resolve({other:true}));}
  if(reason==='stopping') closing.abort();
  if(reason==='scope-ended') context.endRun({runId:id.runId},id);
  resolve(f.rt);await boot;await ack;
  expect(f.mark).not.toHaveBeenCalled();
});
it('does not acknowledge a truncated body, revised guide or changed House binding',async()=>{
  const f=fixture(),context=createNativeReadContext();getOrCreatePerProcess('runtime',()=>Promise.resolve(f.rt));
  const incomplete={...f.event,historyMessages:[{house_guide_contexts:[{...f.guide,guide:'truncated'}]}]};
  await acknowledgeNativeGuideInput(context.observe(incomplete,id)!);expect(f.delivered()).toBeNull();
  const observed=context.observe(f.event,id)!;
  f.db.execute('UPDATE house_binding_pin SET revision=revision+1 WHERE origin=?',[f.guide.origin]);
  await acknowledgeNativeGuideInput(observed);expect(f.delivered()).toBeNull();
  f.db.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=?',['new body',entryDigest('new body')]);
  await acknowledgeNativeGuideInput(context.observe(f.event,id)!);expect(f.delivered()).toBeNull();
});
it.each(['before_reset','before_compaction','after_compaction','session_end','agent_end','gateway_stop'])('%s closes the observed scope',async eventName=>{
  const h=hooks(),observed=h.context.observe({runId:id.runId,sessionId:id.sessionId,historyMessages:[]},id)!;
  await h.emit(eventName,{runId:id.runId,sessionId:id.sessionId});
  expect(observed.scope.isCurrent()).toBe(false);
});

it('injects the cached guide into the next ordinary prompt and suppresses only actual history presence', async()=>{
  const f=fixture(),h=hooks();
  getOrCreatePerProcess('runtime',()=>Promise.resolve(f.rt));
  const fresh=await h.emit('before_prompt_build',{prompt:'hello',messages:[]}) as {prependContext?:string};
  expect(fresh?.prependContext).toContain(f.guide.guide);
  expect(f.delivered()).toBeNull();
  expect(await h.emit('before_prompt_build',{prompt:'hello',messages:f.event.historyMessages})).toBeUndefined();
  const compacted=await h.emit('before_prompt_build',{prompt:'hello',messages:[]}) as {prependContext?:string};
  expect(compacted?.prependContext).toContain(f.guide.guide);
});

it('observes a freshly injected current prompt as actual input before the first tool',async()=>{
  const f=fixture(),h=hooks();getOrCreatePerProcess('runtime',()=>Promise.resolve(f.rt));
  await h.emit('llm_input',{...f.event,historyMessages:[],prompt:'source rules\n'+JSON.stringify({house_guide_contexts:[f.guide]})});
  expect(f.delivered()).toBe(f.guide.guideDigest);
});

it('does not wait for an existing runtime boot to finish in before_prompt_build',async()=>{
  const f=fixture(),h=hooks();let ready!:(rt:typeof f.rt)=>void;
  const pending=new Promise<typeof f.rt>(resolve=>{ready=resolve;});
  getOrCreatePerProcess('runtime',()=>pending);
  const result=h.emit('before_prompt_build',{prompt:'hello',messages:[]});
  const marker=Symbol('still waiting');
  expect(await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve(marker),20))])).toBeUndefined();
  ready(f.rt);
});
