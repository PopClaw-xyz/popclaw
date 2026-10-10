import { expect, it } from 'vitest';
import { createNativeReadContext, type NativeReadContext } from '../../../src/host/native-read-context.js';
import type { GuideReadScope } from '../../../src/runtime/read-request-scope.js';
import { houseGuideContextKey } from '../../../src/world/house-guide-context.js';
import { entryDigest } from '../../../src/runtime/house-lifecycle/participation-journal.js';

const identity = {agentId: 'main', sessionKey: 'agent:main:synthetic', sessionId: 'session-a', runId: 'run-a'};
const guide = {status: 'available', origin: 'https://guide.invalid', bindingDigest: 'binding', opSeq: 1,
  guide: 'Complete synthetic body', guideDigest: entryDigest('Complete synthetic body')};
const key = houseGuideContextKey(guide);
const input = (historyMessages: unknown[] = []) => ({runId: identity.runId, sessionId: identity.sessionId, historyMessages});
const history = (value: unknown = guide) => [{role:'toolResult', content:[{type:'text',text:JSON.stringify({house_guide_contexts:[value]})}]}];
const factory = (overrides: Record<string, unknown> = {}) => ({agentId:identity.agentId, sessionKey:identity.sessionKey,
  sessionId:identity.sessionId, assertInvocationCurrent: () => {}, ...overrides});
function bridge(c: NativeReadContext, callId = 'call-a', id = identity, name = 'popclaw_show_feed') {
  c.beforeToolCall({toolName: name, toolCallId:callId, runId:id.runId}, {...id, toolName:name, toolCallId:callId});
}
function execute(c: NativeReadContext, callId = 'call-a', ctx: unknown = factory(), work = async () => c.current()) {
  return c.run(ctx, 'popclaw_show_feed', callId, undefined, work);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => {resolve=r;}); return {promise,resolve}; }

it('observes complete guide keys synchronously and bridges a factory without a runId', async () => {
  const c=createNativeReadContext(), observation=c.observe(input(history()),identity);
  expect(observation?.keys).toEqual(new Set([key]));
  bridge(c);
  const scope=await execute(c);
  expect(scope).toBe(observation?.scope);
  expect(scope?.presentGuideKeys).toEqual(new Set([key]));
  expect(scope?.isCurrent()).toBe(true);
  expect(c.current()).toBeUndefined();
});
it('reobservation replaces presence and provisional emission and invalidates captured objects', async () => {
  const c=createNativeReadContext(), first=c.observe(input(history()),identity)!;
  expect(first).toBeDefined(); first.scope.recordEmittedGuideKeys(['provisional']);
  const second=c.observe(input(history({...guide,guide:'truncated'})),identity)!;
  expect(first.scope.isCurrent()).toBe(false);
  expect(second.scope.token).not.toBe(first.scope.token);
  expect(second.keys.size).toBe(0);
  expect(second.scope.presentGuideKeys.size).toBe(0);
  first.scope.recordEmittedGuideKeys([key]);
  expect(second.scope.presentGuideKeys.size).toBe(0);
});
it('isolates concurrent conversations and runs sharing a tool call id', async () => {
  const c=createNativeReadContext(), a=c.observe(input(history()),identity)!;
  const other={...identity,sessionId:'session-b',runId:'run-b'};
  const b=c.observe({...input(),sessionId:other.sessionId,runId:other.runId},other)!;
  expect(a).toBeDefined();expect(b).toBeDefined();
  bridge(c,'same',identity);bridge(c,'same',other);
  const values=await Promise.all([execute(c,'same'),execute(c,'same',factory({sessionId:other.sessionId}))]);
  expect(values).toEqual([a.scope,b.scope]);
  expect(values[0]?.token).not.toBe(values[1]?.token);
});
it('different runs colliding on the same factory identity and call id disable both scopes', async () => {
  const c=createNativeReadContext(), a=c.observe(input(history()),identity)!;
  expect(a).toBeDefined();bridge(c,'collision');
  const entered=deferred(),release=deferred();let captured: GuideReadScope|undefined;
  const running=execute(c,'collision',factory(),async()=>{captured=c.current();entered.resolve();await release.promise;return c.current();});
  await entered.promise;
  const other={...identity,runId:'other-run'},b=c.observe({...input(),runId:other.runId},other)!;
  bridge(c,'collision',other);
  expect(captured?.isCurrent()).toBe(false);
  expect(b.scope.isCurrent()).toBe(false);
  expect(await execute(c,'collision')).toBeUndefined();
  release.resolve();expect(await running).toBe(captured);
});
it('duplicate hooks are idempotent and late cleanup for another run cannot erase the current call', async () => {
  const c=createNativeReadContext(), observed=c.observe(input(),identity)!;
  expect(observed).toBeDefined();bridge(c);bridge(c);
  c.afterToolCall({toolName:'popclaw_show_feed',toolCallId:'call-a',runId:'old-run'}, {...identity,runId:'old-run'});
  expect(await execute(c)).toBe(observed.scope);
  // Execute owns a conditional cleanup too, so no stale call bridge can be replayed.
  expect(await execute(c)).toBeUndefined();
});
it.each(['agentId','sessionKey','sessionId','runId'])('missing or conflicting %s disables reuse', async field => {
  const c=createNativeReadContext();
  c.observe(input(history()), {...identity,[field]:undefined});
  bridge(c);
  // event supplies sessionId/runId, so those are tested as conflicts as well.
  if(field==='sessionId'||field==='runId') c.observe({...input(),[field]:'conflict'},identity);
  expect(await execute(c)).toBeUndefined();
});
it('missing bridges do not inherit an outer ALS scope', async () => {
  const c=createNativeReadContext(), observed=c.observe(input(),identity)!;
  expect(observed).toBeDefined();bridge(c);
  await execute(c,'call-a',factory(),async()=>{
    expect(c.current()).toBe(observed.scope);
    expect(await execute(c,'not-registered')).toBeUndefined();
    expect(c.current()).toBe(observed.scope);
    return c.current();
  });
});
it.each(['end','reset','close'])('%s invalidates an in-flight object without returning an absent scope', async reason => {
  const c=createNativeReadContext(), observed=c.observe(input(),identity)!;
  expect(observed).toBeDefined();bridge(c);
  await execute(c,'call-a',factory(),async()=>{
    if(reason==='end') c.endRun({runId:identity.runId},identity);
    else if(reason==='reset') c.reset({},identity);
    else c.closeAll();
    expect(c.current()).toBe(observed.scope);
    expect(c.current()?.isCurrent()).toBe(false);
    return c.current();
  });
});
it('session reset closes matching runs and leaves a different conversation current', () => {
  const c=createNativeReadContext(), a=c.observe(input(),identity)!;
  const other={...identity,sessionId:'other',runId:'other'};
  const b=c.observe({...input(),...other},other)!;
  expect(a).toBeDefined();expect(b).toBeDefined();
  c.reset({},identity);
  expect(a.scope.isCurrent()).toBe(false);expect(b.scope.isCurrent()).toBe(true);
});
it('the wrapper rejects its own aborted consumer without closing another call in the run', async () => {
  const c=createNativeReadContext(), observed=c.observe(input(),identity)!;
  expect(observed).toBeDefined();bridge(c,'cancelled');bridge(c,'other');
  const controller=new AbortController();
  await expect(c.run(factory(),'popclaw_show_feed','cancelled',controller.signal,async()=>{
    controller.abort(new Error('consumer cancelled'));return 'completed underlying read';
  })).rejects.toThrow('consumer cancelled');
  expect(observed.scope.isCurrent()).toBe(true);
  expect(await execute(c,'other')).toBe(observed.scope);
});

it('rejects a known stale SDK invocation without running an unscoped fallback',async()=>{
  const c=createNativeReadContext();c.observe(input(),identity);bridge(c);
  let work=0;
  await expect(execute(c,'call-a',factory({assertInvocationCurrent:()=>{throw Error('SDK invocation stale');}}),async()=>{work++;return c.current();}))
    .rejects.toThrow('SDK invocation stale');
  expect(work).toBe(0);
});
it('a factory that explicitly supplies another run cannot acquire the bridged scope',async()=>{
  const c=createNativeReadContext();c.observe(input(),identity);bridge(c);
  expect(await execute(c,'call-a',factory({runId:'different-run'}))).toBeUndefined();
});
it('missing SDK currentness capability disables reuse but leaves ordinary unscoped work available',async()=>{
  const c=createNativeReadContext();c.observe(input(),identity);bridge(c);
  expect(await execute(c,'call-a',factory({assertInvocationCurrent:undefined}))).toBeUndefined();
});
it('SDK currentness revoked during a read rejects final delivery',async()=>{
  const c=createNativeReadContext();c.observe(input(),identity);bridge(c);let active=true;
  await expect(execute(c,'call-a',factory({assertInvocationCurrent:()=>{if(!active)throw Error('SDK invocation stale');}}),async()=>{
    active=false;return c.current();
  })).rejects.toThrow('SDK invocation stale');
});

it.each(['conflicting','unobserved'])('a %s before hook cannot inherit an earlier call bridge',async reason=>{
  const c=createNativeReadContext(),old=c.observe(input(),identity)!;bridge(c);
  const other={...identity,runId:'unobserved-run'};
  c.beforeToolCall({toolName:'popclaw_show_feed',toolCallId:'call-a',runId:other.runId},
    {...(reason==='conflicting'?identity:other),toolName:'popclaw_show_feed',toolCallId:'call-a'});
  expect(await execute(c)).toBeUndefined();expect(old.scope.isCurrent()).toBe(false);
});
