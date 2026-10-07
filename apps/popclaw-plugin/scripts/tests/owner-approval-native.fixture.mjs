import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {createHash} from 'node:crypto';

// Run from scripts/tests, or pass the absolute plugin package as argv[2].
// Official SDK loader and resolver execute unchanged. The isolated host supplies
// synthetic admitted-run facts; only the final social sender is replaced.
// This fixture does not verify actual channel authentication or human review.
test('pinned native SDK registers v2 social tools and retains current confirmation authority', async () => {
  const root=resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)),'../..'));
  const require=createRequire(join(root,'package.json'));
  const {build}=require('esbuild');
  const sdk=realpathSync(join(root,'node_modules/openclaw'));
  assert.equal(JSON.parse(readFileSync(join(sdk,'package.json'))).version,'2026.9.8');
  const inputFiles=['host/social-send-context.ts','tools/write-tools.ts','tools/register-tools.ts','tools/tool-tail.ts','tools/mcp-adapter.ts','tools/draft-store.ts','runtime/house-lifecycle/action-context.ts'];
  const hashInputs=()=>Object.fromEntries(inputFiles.map(file=>[file,createHash('sha256').update(readFileSync(join(root,'src',file))).digest('hex')]));
  const sourceSha256=hashInputs();
  const box=realpathSync(mkdtempSync(join(tmpdir(),'popclaw-social-sdk-')));
  symlinkSync(join(root,'node_modules'),join(box,'node_modules'),'dir');
  // Never consult a live user's host configuration or data.
  const env={...process.env,HOME:join(box,'home'),OPENCLAW_STATE_DIR:join(box,'state'),OPENCLAW_CONFIG_PATH:join(box,'state/openclaw.json'),POPCLAW_DATA_ROOT:join(box,'popclaw')};
  for(const name of ['HOME','OPENCLAW_STATE_DIR','POPCLAW_DATA_ROOT']) mkdirSync(env[name]);
  writeFileSync(env.OPENCLAW_CONFIG_PATH,'{}');
  Object.assign(process.env,env);
  globalThis.fetch=async()=>{throw Error('fixture forbids network');};
  const spec=file=>JSON.stringify(join(root,'src',file));
  const entry=`
    import {registerPopclawTools} from ${spec('tools/register-tools.ts')};
    import {putDraft,peekDraftSnapshot,noteDraftToolOutput} from ${spec('tools/draft-store.ts')};
    import {assertActionActive} from ${spec('runtime/house-lifecycle/action-context.ts')};
    import {makeToolCollector} from ${spec('tools/mcp-adapter.ts')};
    export {peekDraftSnapshot};
    export function register(api) {
      const runtime=async()=>({egress:{home:{slug:'house-synthetic'},capturePlan:()=>({egress:{},targets:[]})}});
      return registerPopclawTools({api,runtime,socialSendHost:'native',nativeToolNotices:true,
        getToolNoticeContext:async()=>{throw Error('isolated fixture has no notification store');}});
    }
    export function replaceSender(id,beforeEffect,effect) {
      const snapshot=peekDraftSnapshot(id); if(!snapshot) throw Error('missing real draft');
      putDraft(id,async()=>{await beforeEffect();assertActionActive();effect();return {text:'synthetic sender completed'};},snapshot);
      noteDraftToolOutput(id,'Synthetic fixture manuscript');
    }
    export function collectNativeAsMcp() {
      const {tools,api}=makeToolCollector(); const runtime=async()=>({});
      registerPopclawTools({api,runtime,socialSendHost:'native'});
      return tools.find(t=>t.name==='popclaw_send_draft');
    }`;
  await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},absWorkingDir:root,tsconfig:join(root,'tsconfig.json'),outfile:join(box,'a.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',external:['openclaw','openclaw/*','better-sqlite3','bindings','file-uri-to-path'],banner:{js:"import {createRequire as __fixtureRequire} from 'node:module';const require=__fixtureRequire(import.meta.url);"}});
  writeFileSync(join(box,'b.mjs'),readFileSync(join(box,'a.mjs')));
  const a=await import(pathToFileURL(join(box,'a.mjs'))),b=await import(pathToFileURL(join(box,'b.mjs')));
  const pluginId='popclaw-social-fixture',plugin=join(box,'fixture-plugin-b'),pluginA=join(box,'fixture-plugin-a');
  mkdirSync(plugin);mkdirSync(pluginA);
  const manifest=JSON.parse(readFileSync(join(root,'openclaw.plugin.json')));
  writeFileSync(join(plugin,'openclaw.plugin.json'),JSON.stringify({id:pluginId,name:'Social SDK fixture',version:'1.0.0',contracts:{tools:manifest.contracts.tools},configSchema:{type:'object',properties:{},additionalProperties:false}}));
  writeFileSync(join(plugin,'package.json'),JSON.stringify({name:pluginId,version:'1.0.0',type:'module',openclaw:{extensions:['./index.mjs']}}));
  writeFileSync(join(plugin,'index.mjs'),`import {register} from ${JSON.stringify(pathToFileURL(join(box,'b.mjs')).href)};export default {id:${JSON.stringify(pluginId)},register};`);
  for(const file of ['openclaw.plugin.json','package.json'])writeFileSync(join(pluginA,file),readFileSync(join(plugin,file)));
  writeFileSync(join(pluginA,'index.mjs'),`import {register} from ${JSON.stringify(pathToFileURL(join(box,'a.mjs')).href)};export default {id:${JSON.stringify(pluginId)},register};`);
  const sdkImport=file=>import(pathToFileURL(join(sdk,'dist',file)));
  const loader=await sdkImport('loader-runtime-load-DCwhg2IV.mjs');
  const resolver=await sdkImport('tools-CL6qlaud.mjs');
  const errors=[],logger={info(){},warn(){},error(m){errors.push(m);},debug(){}};
  const config={plugins:{enabled:true,allow:[pluginId],load:{paths:[plugin]},entries:{[pluginId]:{enabled:true}}}};
  const acquisition=await loader.t({config,env,workspaceDir:join(box,'workspace'),onlyPluginIds:[pluginId],toolDiscovery:true,runtimeSideEffects:false,logger});
  const configA={...config,plugins:{...config.plugins,load:{paths:[pluginA]}}};
  const acquisitionA=await loader.t({config:configA,env,workspaceDir:join(box,'workspace-a'),onlyPluginIds:[pluginId],toolDiscovery:true,runtimeSideEffects:false,logger});
  let sends=0;
  const cases=[];
  const context={config,workspaceDir:join(box,'workspace'),agentId:'main',sessionId:'synthetic-session',sessionKey:'agent:main:synthetic',requesterSenderId:'synthetic-human',senderIsOwner:false,messageChannel:'weixin',agentAccountId:'synthetic-weixin-account',logger};
  const resolveTools=(assertInvocationCurrent,extra={})=>resolver.i({context,env,runtimeRegistry:acquisition.registry,toolAllowlist:[pluginId],assertInvocationCurrent,...extra});
  const resolveDraftTools=(assertInvocationCurrent,extra={})=>resolver.i({context:{...context,config:configA,workspaceDir:join(box,'workspace-a')},env,runtimeRegistry:acquisitionA.registry,toolAllowlist:[pluginId],assertInvocationCurrent,...extra,
    ...extra.context?{context:{...extra.context,config:configA,workspaceDir:join(box,'workspace-a')}}:{}});
  const tool=(tools,name)=>{const t=tools.find(t=>t.name===name);assert.ok(t,`${name} resolved from official registry; errors=${JSON.stringify(errors)}`);return t;};
  const guard=()=>{let current=true;return {assert(){if(!current)throw Error('synthetic admitted turn closed');},close(){current=false;}};};
  const draft=async(g=guard(),extra={})=>{
    const tools=resolveDraftTools(()=>g.assert(),extra);
    const result=await tool(tools,'popclaw_draft_post').execute('fixture:draft',{body:'Synthetic manuscript reviewed in original chat.'});
    const text=result.text ?? result.content?.find(x=>x.type==='text')?.text;
    const id=text?.match(/draft_id: (\S+)/)?.[1];assert.ok(id,text);
    return {id,g,tools};
  };
  const send=(tools,id)=>tool(tools,'popclaw_send_draft').execute('fixture:confirm',{draft_id:id});
  const sentText=result=>result.text ?? result.content?.find(x=>x.type==='text')?.text;
  try {
    const record=acquisition.registry.plugins.find(p=>p.id===pluginId);assert.ok(record,JSON.stringify(acquisition.registry.diagnostics));
    const names=['popclaw_draft_reply','popclaw_draft_message','popclaw_draft_post','popclaw_send_draft','popclaw_feedback'];
    for(const name of names)assert.equal(acquisition.registry.tools.find(t=>t.names.includes(name))?.contextVersion,2,name);
    assert.equal(acquisition.registry.diagnostics.filter(d=>d.level==='error').length,0,JSON.stringify(acquisition.registry.diagnostics));
    assert.equal(acquisitionA.registry.diagnostics.filter(d=>d.level==='error').length,0,JSON.stringify(acquisitionA.registry.diagnostics));
    cases.push('official loader accepts current v2 descriptors including full registration/tail path');

    const first=await draft();
    // Module A owns the deferred closure; B owns all SDK-registered tools.
    a.replaceSender(first.id,async()=>{},()=>sends++);first.g.close();
    await assert.rejects(send(first.tools,first.id),/turn closed/);assert.equal(sends,0);assert.ok(b.peekDraftSnapshot(first.id));
    const confirmation=guard();
    assert.equal(sentText(await send(resolveTools(()=>confirmation.assert()),first.id)),'synthetic sender completed');assert.equal(sends,1);
    assert.equal(a.peekDraftSnapshot(first.id),null);
    cases.push('stale drafting turn rejected; fresh confirmation sends cross-bundle draft exactly once');
    assert.notEqual(sentText(await send(resolveTools(()=>confirmation.assert()),first.id)),'synthetic sender completed');assert.equal(sends,1);

    const stale=await draft();a.replaceSender(stale.id,async()=>{},()=>sends++);
    const staleConfirmation=guard(),staleTools=resolveTools(()=>staleConfirmation.assert());staleConfirmation.close();
    await assert.rejects(send(staleTools,stale.id),/turn closed/);assert.equal(sends,1);assert.ok(a.peekDraftSnapshot(stale.id));
    cases.push('closed confirmation before execute rejects without consuming draft/effect');

    const mid=await draft();const midConfirmation=guard();
    a.replaceSender(mid.id,async()=>{await Promise.resolve();midConfirmation.close();},()=>sends++);
    await assert.rejects(send(resolveTools(()=>midConfirmation.assert()),mid.id),/turn closed/);assert.equal(sends,1);
    cases.push('confirmation revoked after await reaches module A final action guard; no effect');

    const absent=await draft();a.replaceSender(absent.id,async()=>{},()=>sends++);
    await assert.rejects(send(resolveTools(undefined),absent.id),/authority is unavailable outside an admitted run or request/);assert.equal(sends,1);
    const collector=await b.collectNativeAsMcp().execute('fixture:missing',{draft_id:absent.id});
    assert.match(sentText(collector),/no valid conversation context|缺少有效的会话信息/);assert.equal(sends,1);assert.ok(a.peekDraftSnapshot(absent.id));
    cases.push('native with no admitted context rejects; contextless collector cannot select stdio authority');

    for (const channel of ['weixin','telegram','custom-chat-provider']) {
      for (const ownerMarker of [false,undefined]) {
        const route={...context,messageChannel:channel,senderIsOwner:ownerMarker};
        const before=sends,d=await draft(guard(),{context:route});
        assert.equal(a.peekDraftSnapshot(d.id).binding.messageChannel,channel);
        a.replaceSender(d.id,async()=>{},()=>sends++);
        const tools=resolveTools(()=>confirmation.assert(),{context:route});
        assert.equal(sentText(await send(tools,d.id)),'synthetic sender completed');
        assert.equal(sends,before+1);assert.equal(route.senderIsOwner,ownerMarker);
        await send(tools,d.id);assert.equal(sends,before+1);
      }
    }
    cases.push('official SDK wrapper admits owner=false/undefined on Weixin and arbitrary channels; sends once without owner configuration');
    const changingMarker=await draft();a.replaceSender(changingMarker.id,async()=>{},()=>sends++);
    const liveMarkerTools=resolveTools(()=>confirmation.assert());context.senderIsOwner=undefined;
    assert.equal(sentText(await send(liveMarkerTools,changingMarker.id)),'synthetic sender completed');context.senderIsOwner=false;
    cases.push('changing an owner marker does not revoke an otherwise current admitted invocation');
    for (const change of [{messageChannel:'other-channel'},{agentAccountId:'other-account'},{requesterSenderId:'other-sender'},{sessionId:'other-session'}]) {
      const before=sends,d=await draft();a.replaceSender(d.id,async()=>{},()=>sends++);
      const wrong=resolveTools(()=>confirmation.assert(),{context:{...context,...change}});
      assert.match(sentText(await send(wrong,d.id)),/different conversation|另一个会话/);
      assert.equal(sends,before);assert.ok(a.peekDraftSnapshot(d.id));
    }
    cases.push('same-session sender text cannot reuse a draft across channel/account; session and sender isolation remain');

    // Actual SDK continuation issuance, run ownership and caller scope. No
    // handwritten ownerContinuation is passed to the official tool resolver.
    const runs=await sdkImport('agent-run-registry-BDW3IRlF.mjs');
    const callers=await sdkImport('gateway-caller-context-DQ2iIITl.mjs');
    const cron=await sdkImport('cron-creator-authority-context-D-BVNJXy.mjs');
    const runId='synthetic-continuation-run',instance={runId,instanceId:'synthetic-continuation-instance'};
    const continuationGuard=guard(),ownerGuard=guard();
    const authority=runs.i(instance,()=>continuationGuard.assert());
    runs.y(runId,{agentId:context.agentId,sessionKey:context.sessionKey,sessionId:context.sessionId});
    const scope=cron.u(runId,{kind:'unknown'},undefined,()=>{continuationGuard.assert();return true;},undefined,{senderId:context.requesterSenderId,channel:'tui',accountId:'synthetic-account',isCurrent(){try{ownerGuard.assert();return true;}catch{return false;}}});
    const caller={agentId:context.agentId,sessionKey:context.sessionKey,approvalAuthority:authority,operationalRunInstance:instance,receiptAuthority:()=>runs.A(authority)};
    const beforeContinuation=sends;
    await callers.c(caller,()=>cron.f(scope,async()=>{
      const ownerContinuation=cron.o({runId,agentId:context.agentId,sessionKey:context.sessionKey,sessionId:context.sessionId});
      assert.ok(ownerContinuation,'official SDK must issue continuation');assert.equal(ownerContinuation.isCurrent(),true);
      const continuationContext={...context,senderIsOwner:false,requesterSenderId:'untrusted-route'};
      const extra={context:continuationContext,ownerContinuation};
      const d=await draft(guard(),extra);a.replaceSender(d.id,async()=>{},()=>sends++);
      assert.equal(a.peekDraftSnapshot(d.id).binding.senderId,context.requesterSenderId);
      assert.equal(sentText(await send(resolveTools(undefined,extra),d.id)),'synthetic sender completed');assert.equal(sends,beforeContinuation+1);
      const revoked=await draft(guard(),extra);a.replaceSender(revoked.id,async()=>{},()=>sends++);
      const tools=resolveTools(undefined,extra);ownerGuard.close();assert.equal(ownerContinuation.isCurrent(),false);
      await assert.rejects(send(tools,revoked.id),/Requester owner identity is no longer active/);assert.equal(sends,beforeContinuation+1);assert.ok(a.peekDraftSnapshot(revoked.id));
      cases.push('SDK-issued owner continuation overrides untrusted route identity; revocation rejects live tools');
    }));
    runs.C(authority);
    assert.deepEqual(hashInputs(),sourceSha256,'fixture inputs changed during execution; rerun on a fixed candidate');
    console.log(JSON.stringify({sdk:'2026.9.8',node:process.version,box,syntheticSends:sends,registeredTools:acquisition.registry.tools.length,draftingRegistryTools:acquisitionA.registry.tools.length,sourceSha256,cases,errors,boundaries:['synthetic local host admission/owner facts; no actual channel authentication or human review','synthetic final sender; no product signer/egress/network/real IM','official SDK modules imported unchanged; no descriptor/context logic mocked']}));
  } finally {await acquisitionA.release();await acquisition.release();}
});
