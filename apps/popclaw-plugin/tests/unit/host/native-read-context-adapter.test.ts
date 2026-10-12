import { expect, it, vi } from 'vitest';
import { createNativeReadContext } from '../../../src/host/native-read-context.js';
import { withNativeReadContext } from '../../../src/host/native-read-context-tools.js';

const id = {agentId:'main',sessionKey:'synthetic',sessionId:'physical',runId:'run'};
const factory = {agentId:id.agentId,sessionKey:id.sessionKey,sessionId:id.sessionId,assertInvocationCurrent:vi.fn()};
const toolName = 'popclaw_show_feed';
function setup() {
  const context=createNativeReadContext(), observation=context.observe({runId:id.runId,sessionId:id.sessionId,historyMessages:[]},id)!;
  const registrations: Array<{tool:unknown;options:unknown}>=[];
  const api=withNativeReadContext({registerTool:(tool,options)=>registrations.push({tool,options})},context);
  const before=(callId:string)=>context.beforeToolCall({toolName,toolCallId:callId,runId:id.runId},{...id,toolName,toolCallId:callId});
  const resolve=(tool:any):any=>typeof tool==='function'?tool(factory):tool?.contextVersion===2?tool.create(factory):tool;
  return {context,observation,registrations,api,before,resolve};
}
it.each(['plain','factory','v2'])('wraps %s registration outside the tool body while preserving its contract',async shape=>{
  const f=setup(), prepare=vi.fn((args:unknown)=>args), create=vi.fn((ctx:unknown)=>{
    expect(ctx).toBe(factory);return {name:toolName,description:'unchanged',prepareArguments:prepare,
      execute:async()=>({scope:f.context.current(),input:'untouched'})};
  });
  const original=shape==='plain'?create(factory):shape==='factory'?create:{contextVersion:2,custom:'retained',create};
  f.api.registerTool(original,{optional:true,name:toolName});
  const registered=f.registrations[0]!;
  expect(registered.options).toEqual({optional:true,name:toolName});
  if(shape==='v2') expect(registered.tool).toMatchObject({contextVersion:2,custom:'retained'});
  const tool=f.resolve(registered.tool);
  expect(tool.prepareArguments).toBe(prepare);expect(tool.description).toBe('unchanged');
  f.before(shape);
  expect((await tool.execute(shape,{})).scope).toBe(f.observation.scope);
  expect(f.context.current()).toBeUndefined();
});
it('retains discovery name hints and handles factories returning arrays or null',async()=>{
  const f=setup();f.api.registerTool({name:toolName,execute:async()=>f.context.current()});
  expect(f.registrations[0]?.options).toEqual({name:toolName});
  f.api.registerTool(()=>[{name:toolName,execute:async()=>f.context.current()}],{names:[toolName]});
  f.api.registerTool(()=>null,{name:'absent'});
  f.before('array');expect(await f.resolve(f.registrations[1]?.tool)[0].execute('array',{})).toBe(f.observation.scope);
  expect(f.resolve(f.registrations[2]?.tool)).toBeNull();
});
it('does not import a scope from tool arguments or bypass the original v2 guard',async()=>{
  const f=setup();
  f.api.registerTool({contextVersion:2,create:(ctx:typeof factory)=>({name:toolName,execute:async()=>{ctx.assertInvocationCurrent();return f.context.current();}})},{name:toolName});
  const tool=f.resolve(f.registrations[0]?.tool);
  expect(await tool.execute('missing',{...id,runId:id.runId})).toBeUndefined();
  const broken={...factory,assertInvocationCurrent:()=>{throw new Error('SDK authority revoked');}};
  const definition=f.registrations[0]?.tool as {create(ctx:unknown):typeof tool};
  f.before('revoked');
  await expect(definition.create(broken).execute('revoked',{})).rejects.toThrow('SDK authority revoked');
});
