import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {loadDurableNativeSdk} from './helpers/durable-native-sdk.mjs';

// Official SDK unchanged; synthetic admission/egress, real storage and signer.
// Does not claim real channel authentication, delivery or human review.
test('native SDK restores durable manuscripts under a fresh admitted invocation and retains real rejection', async () => {
  const root=resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)),'../..'));
  const box=realpathSync(mkdtempSync(join(tmpdir(),'popclaw-durable-sdk-')));
  const state=join(box,'state'), home=join(box,'home');
  for(const path of [state,home])mkdirSync(path);
  const env={...process.env,HOME:home,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:join(state,'openclaw.json'),POPCLAW_DATA_ROOT:join(box,'data')};
  writeFileSync(env.OPENCLAW_CONFIG_PATH,'{}');Object.assign(process.env,env);
  globalThis.fetch=async()=>{throw Error('fixture forbids network');};
  const context={config:{},agentId:'main',sessionId:'synthetic-session',sessionKey:'agent:main:main',requesterSenderId:'synthetic-human',senderIsOwner:false,messageChannel:'weixin',agentAccountId:'synthetic-account'};
  const fx=await loadDurableNativeSdk({root,box,env,context}), {runtime,acquisition,tools}=fx;
  assert.equal(existsSync(join(fx.data,'host.db')),false,'official registration must not open persistent runtime');
  const call=(set,name,params)=>{const tool=set.find(t=>t.name===name);assert.ok(tool,JSON.stringify(fx.errors));return tool.execute('synthetic-call',params);};
  const text=result=>result.text ?? result.content?.find(c=>c.type==='text')?.text;
  let current=true;const guard=()=>{if(!current)throw Error('SDK_ADMITTED_INVOCATION_CLOSED');};
  const draft=async()=>{const result=await call(tools(guard),'popclaw_draft_post',{body:'Manuscript retained for a fresh admitted call.'});const id=text(result)?.match(/draft_id: (\S+)/)?.[1];assert.ok(id,text(result));assert.ok(runtime.exists(id));return id;};
  try {
    assert.equal(acquisition.registry.diagnostics.filter(d=>d.level==='error').length,0,JSON.stringify(acquisition.registry.diagnostics));
    const id=await draft(), closedTools=tools(guard);current=false;
    await assert.rejects(call(closedTools,'popclaw_send_draft',{draft_id:id}),/SDK_ADMITTED_INVOCATION_CLOSED/);assert.ok(runtime.exists(id));assert.equal(runtime.effects(),0);
    await assert.rejects(call(tools(undefined),'popclaw_send_draft',{draft_id:id}),/authority is unavailable outside an admitted run or request/);assert.ok(runtime.exists(id));
    current=true;
    assert.match(text(await call(tools(guard,{messageChannel:'other-channel'}),'popclaw_send_draft',{draft_id:id})),/different conversation|另一个会话/);assert.equal(runtime.effects(),0);
    assert.match(text(await call(tools(guard),'popclaw_send_draft',{draft_id:id})),/posted #/);assert.equal(runtime.effects(),1);assert.equal(runtime.exists(id),false);
    await call(tools(guard),'popclaw_send_draft',{draft_id:id});assert.equal(runtime.effects(),1);
    const revoked=await draft();runtime.onSign(()=>{current=false;});
    await assert.rejects(call(tools(guard),'popclaw_send_draft',{draft_id:revoked}),/SDK_ADMITTED_INVOCATION_CLOSED/);assert.equal(runtime.effects(),1);assert.equal(runtime.exists(revoked),false);
    current=true;runtime.onSign(undefined);await call(tools(guard),'popclaw_send_draft',{draft_id:revoked});assert.equal(runtime.effects(),1);
    console.log(JSON.stringify({sdk:'2026.9.8',node:process.version,syntheticEffects:runtime.effects(),cases:['official registration is lazy and v2; owner=false Weixin admitted','closed/unavailable SDK authority does not consume','cross-channel refuses persisted draft','fresh admitted invocation sends saved manuscript once','async SDK revocation fences real signer and spends draft permanently'],boundaries:['synthetic host admission; no real Weixin authentication or human consent','real product SQLite/manuscript/signer, synthetic final egress; no network']}));
  } finally {await fx.close();}
});
