import { createNativeReadContext } from '../../../src/host/native-read-context.js';
import { withNativeReadContext } from '../../../src/host/native-read-context-tools.js';
import { expect, it, vi } from 'vitest';
import { withTail } from '../../../src/tools/tool-tail.js';
import { houseGuideContextKey, type HouseGuideContext } from '../../../src/world/house-guide-context.js';
import { entryDigest } from '../../../src/runtime/house-lifecycle/participation-journal.js';
import type { GuideReadScope } from '../../../src/runtime/read-request-scope.js';
import type { RegisterToolsDeps } from '../../../src/tools/tools-context.js';

const guide: HouseGuideContext = { status: 'available', origin: 'https://guide.invalid', bindingDigest: 'bound', opSeq: 1,
  guideUrl: 'https://guide.invalid/guide.md', guide: 'Complete synthetic guide', guideDigest: entryDigest('Complete synthetic guide'), delivered: true };
const key = houseGuideContextKey(guide);
function scope(initial: string[] = []) {
  const observed = new Set(initial), emitted = new Set<string>();
  let live = true;
  const value: GuideReadScope = { token: {}, isCurrent: () => live,
    get presentGuideKeys() { return new Set([...observed, ...emitted]); },
    recordEmittedGuideKeys: vi.fn(keys => { if (live) for (const k of keys) emitted.add(k); }),
  };
  return { value, observed, emitted, close: () => { live = false; } };
}
function fixture(current?: () => GuideReadScope | undefined, globallyDelivered = true) {
  const pendingHouseGuides = vi.fn(async (present?: ReadonlySet<string>) =>
    present ? present.has(key) ? [] : [guide] : globallyDelivered ? [] : [guide]);
  const markHouseGuideDelivered = vi.fn();
  const runtime = async () => ({ houseRuntime: { pendingHouseGuides, markHouseGuideDelivered,
    publicReadGate: () => ({ isActive: () => false }) } });
  let tool!: { execute(id: string, args: unknown): Promise<{text: string}> };
  const api = Reflect.apply(withTail, undefined, [{registerTool: (t: unknown) => { tool = t as typeof tool; }},
    runtime as unknown as RegisterToolsDeps['runtime'], undefined, undefined, current]) as RegisterToolsDeps['api'];
  api.registerTool({ name: 'popclaw_show_inbox', execute: async (_id: string, args: {plain?: boolean; fail?: boolean}) =>
    args.fail ? {text: 'business refusal', isError: true} : {text: args.plain ? 'Ordinary reply' : JSON.stringify({owner_text: 'Requested private text'})} });
  return { execute: (id: string, args = {}) => tool.execute(id, args), pendingHouseGuides, markHouseGuideDelivered };
}
const count = (result: {text: string}) => result.text.match(/"house_guide_contexts"/g)?.length ?? 0;

it('native calls without an exact scope redeliver even when another conversation has a durable receipt', async () => {
  const f = fixture(() => undefined);
  expect(count(await f.execute('missing'))).toBe(1);
  expect(f.pendingHouseGuides.mock.calls[0]?.[0]).toEqual(new Set());
  expect(f.markHouseGuideDelivered).not.toHaveBeenCalled();
});
it('a complete observed guide is suppressed only for its current context', async () => {
  const s = scope([key]), f = fixture(() => s.value, false);
  expect(count(await f.execute('observed'))).toBe(0);
  expect(f.pendingHouseGuides.mock.calls[0]?.[0]).toEqual(new Set([key]));
  expect(s.value.recordEmittedGuideKeys).not.toHaveBeenCalled();
});
it('parallel tool results emit one provisional copy without recording durable delivery', async () => {
  const s = scope(), f = fixture(() => s.value, false);
  const results = await Promise.all([f.execute('first'), f.execute('second')]);
  expect(results.reduce((n, r) => n + count(r), 0)).toBe(1);
  expect(count(await f.execute('third'))).toBe(0);
  expect(s.observed.size).toBe(0);
  expect(s.emitted).toEqual(new Set([key]));
  expect(f.markHouseGuideDelivered).not.toHaveBeenCalled();
});
it('expired context never suppresses a guide and never claims a provisional emission', async () => {
  const s = scope([key]); s.close();
  const f = fixture(() => s.value);
  expect(count(await f.execute('stale'))).toBe(1);
  expect(f.pendingHouseGuides.mock.calls[0]?.[0]).toEqual(new Set());
  expect(s.value.recordEmittedGuideKeys).not.toHaveBeenCalled();
});
it('business refusal leaves guide presence untouched; plain text still gets a complete context', async () => {
  const s = scope(), f = fixture(() => s.value, false);
  expect(count(await f.execute('refusal', {fail: true}))).toBe(0);
  expect(s.emitted.size).toBe(0);
  const result = await f.execute('plain', {plain: true});
  expect(result.text.startsWith('Ordinary reply\n')).toBe(true);
  expect(count(result)).toBe(1);
  expect(s.emitted).toEqual(new Set([key]));
});
it('other hosts retain their existing receipt semantics', async () => {
  const f = fixture();
  expect(count(await f.execute('legacy'))).toBe(0);
  expect(f.pendingHouseGuides.mock.calls[0]?.[0]).toBeUndefined();
});

function deferred() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve}; }
function nativeFixture() {
  const context=createNativeReadContext(),id={agentId:'main',sessionKey:'key',sessionId:'session',runId:'run'},name='popclaw_show_inbox';
  const observed=context.observe({runId:id.runId,sessionId:id.sessionId,historyMessages:[]},id)!;
  const afterTail=deferred(),release=deferred();
  let resolved!: (ctx:unknown)=>{execute:(id:string,args:unknown,signal?:AbortSignal)=>Promise<{text:string}>};
  const outer=withNativeReadContext({registerTool:tool=>{resolved=tool as typeof resolved;}},context);
  const middle: RegisterToolsDeps['api']={registerTool:(tool:unknown,opts?:unknown)=>{
    const t=tool as {execute:(...args:unknown[])=>Promise<unknown>};
    outer.registerTool({...t,execute:async(...args:unknown[])=>{
      const result=await t.execute(...args);
      if(args[0]==='cancelled'){afterTail.resolve();await release.promise;}
      return result;
    }},opts);
  }};
  const runtime=async()=>({houseRuntime:{pendingHouseGuides:async()=>[guide],publicReadGate:()=>({isActive:()=>true})}});
  withTail(middle,runtime as unknown as RegisterToolsDeps['runtime'],undefined,undefined,()=>context.current())
    .registerTool({name,execute:async()=>({text:JSON.stringify({owner_text:'private output retained'})})});
  const tool=resolved({...id,assertInvocationCurrent:()=>{}});
  return {context,observed,afterTail,release,execute:(callId:string,signal?:AbortSignal)=>{
    context.beforeToolCall({toolName:name,toolCallId:callId,runId:id.runId},{...id,toolName:name,toolCallId:callId});
    return tool.execute(callId,{},signal);
  }};
}
it('a cancelled consumer never suppresses the guide of another successful consumer',async()=>{
  const f=nativeFixture(),abort=new AbortController();
  const cancelled=f.execute('cancelled',abort.signal);await f.afterTail.promise;
  const successful=await f.execute('successful');
  abort.abort(new Error('consumer cancelled'));f.release.resolve();
  await expect(cancelled).rejects.toThrow('consumer cancelled');
  expect(count(successful)).toBe(1);
  expect(JSON.parse(successful.text).owner_text).toBe('private output retained');
  expect(f.observed.scope.isCurrent()).toBe(true);
  expect(count(await f.execute('later'))).toBe(0);
});
it('the outer boundary deduplicates two successful parallel guide results',async()=>{
  const f=nativeFixture();const results=await Promise.all([f.execute('one'),f.execute('two')]);
  expect(results.reduce((n,r)=>n+count(r),0)).toBe(1);
  for(const result of results)expect(JSON.parse(result.text).owner_text).toBe('private output retained');
});
