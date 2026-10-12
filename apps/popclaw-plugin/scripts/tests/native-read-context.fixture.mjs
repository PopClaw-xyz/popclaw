import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {createHash} from 'node:crypto';

// Official SDK loader, factory resolver, hook runner, execution wrapper and
// CodeMode worker/bridge run unchanged. Host admission and business reads are
// synthetic; this proves context plumbing, not live IM delivery or authority.
test('Native read context survives official direct and CodeMode call chains',async()=>{
  const root=resolve(process.argv[2]??join(dirname(fileURLToPath(import.meta.url)),'../..'));
  const require=createRequire(join(root,'package.json')),{build}=require('esbuild');
  const sdk=realpathSync(join(root,'node_modules/openclaw'));
  assert.equal(JSON.parse(readFileSync(join(sdk,'package.json'))).version,'2026.9.8');
  const inputs=['host/native-read-context.ts','host/native-read-context-hooks.ts','host/native-read-context-tools.ts','tools/tool-tail.ts','tools/mcp-adapter.ts','host/openclaw-notify-route.ts','runtime/read-request-scope.ts'];
  const hashes=()=>Object.fromEntries(inputs.map(file=>[file,createHash('sha256').update(readFileSync(join(root,'src',file))).digest('hex')]));
  const sourceSha256=hashes(),box=realpathSync(mkdtempSync(join(tmpdir(),'popclaw-native-read-sdk-')));
  symlinkSync(join(root,'node_modules'),join(box,'node_modules'),'dir');
  const env={...process.env,HOME:join(box,'home'),OPENCLAW_STATE_DIR:join(box,'state'),OPENCLAW_CONFIG_PATH:join(box,'state/openclaw.json'),POPCLAW_DATA_ROOT:join(box,'popclaw')};
  for(const name of ['HOME','OPENCLAW_STATE_DIR','POPCLAW_DATA_ROOT'])mkdirSync(env[name]);
  writeFileSync(env.OPENCLAW_CONFIG_PATH,'{}');Object.assign(process.env,env);
  globalThis.fetch=async()=>{throw Error('fixture forbids network');};
  const spec=file=>JSON.stringify(join(root,'src',file));
  const entry=`
    import {sharedNativeReadContext} from ${spec('host/native-read-context.ts')};
    import {registerNativeReadContextHooks} from ${spec('host/native-read-context-hooks.ts')};
    import {withNativeReadContext} from ${spec('host/native-read-context-tools.ts')};
    import {withOpenClawNotifyRoute} from ${spec('host/openclaw-notify-route.ts')};
    import {withNativeToolNotice} from ${spec('tools/mcp-adapter.ts')};
    import {withTail} from ${spec('tools/tool-tail.ts')};
    import {getOrCreatePerProcess,peekPerProcess,clearPerProcess} from ${spec('runtime/once.ts')};
    import {entryDigest} from ${spec('runtime/house-lifecycle/participation-journal.ts')};
    export const context=sharedNativeReadContext();
    export const facts=getOrCreatePerProcess('native-read-fixture-facts',()=>[]);
    let tokenCount=0;const tokens=new WeakMap();
    export const guide={status:'available',origin:'https://guide.invalid',bindingDigest:'bound',opSeq:1,
      guideUrl:'https://guide.invalid/guide.md',guide:'Complete synthetic guide',guideDigest:entryDigest('Complete synthetic guide'),delivered:true};
    let receipts=0;
    const rt={host:{db:{queryAll:()=>[{origin:guide.origin,binding_digest:guide.bindingDigest,op_seq:guide.opSeq,guide_url:guide.guideUrl,guide_body:guide.guide,guide_digest:guide.guideDigest}]}},
      houseRuntime:{pendingHouseGuides:async()=>[guide],publicReadGate:()=>({isActive:()=>true}),markHouseGuideDelivered:()=>{receipts++;return true;}}};
    export const receiptCount=()=>receipts;
    export const hasRuntime=()=>peekPerProcess('runtime')!==undefined;
    export const installRuntime=()=>getOrCreatePerProcess('runtime',()=>Promise.resolve(rt));
    export const clearRuntime=()=>clearPerProcess('runtime');
    export function register(api){
      registerNativeReadContextHooks(api,context);
      const notice=async()=>{throw Error('synthetic fixture has no notice store');};
      const adapted=withTail(withNativeToolNotice(withOpenClawNotifyRoute(withNativeReadContext(api,context),async()=>rt,()=>{}),notice),async()=>rt,undefined,notice,()=>context.current());
      const tool=(shape,ctx)=>({name:'popclaw_fixture_'+shape,label:shape,description:'Synthetic Native context fixture',parameters:{type:'object',properties:{},additionalProperties:false},
        execute:async()=>{if(shape==='v2')ctx.assertInvocationCurrent();const scope=context.current();
          if(scope&&!tokens.has(scope.token))tokens.set(scope.token,++tokenCount);
          const fact={shape,scope:!!scope,current:scope?.isCurrent()??false,token:scope?tokens.get(scope.token):null,factoryHasRunId:ctx?.runId!==undefined};facts.push(fact);
          return {text:JSON.stringify({...fact,owner_text:'Private synthetic output kept byte-for-byte'})};}});
      adapted.registerTool(tool('plain'),{name:'popclaw_fixture_plain'});
      adapted.registerTool(ctx=>tool('factory',ctx),{name:'popclaw_fixture_factory'});
      adapted.registerTool({contextVersion:2,create:ctx=>tool('v2',ctx)},{name:'popclaw_fixture_v2'});
    }
  `;
  await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},absWorkingDir:root,tsconfig:join(root,'tsconfig.json'),outfile:join(box,'a.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',external:['openclaw','openclaw/*','better-sqlite3','bindings','file-uri-to-path'],banner:{js:"import {createRequire as __fixtureRequire} from 'node:module';const require=__fixtureRequire(import.meta.url);"}});
  writeFileSync(join(box,'b.mjs'),readFileSync(join(box,'a.mjs')));
  const a=await import(pathToFileURL(join(box,'a.mjs'))),b=await import(pathToFileURL(join(box,'b.mjs')));
  assert.equal(a.context,b.context,'separate bundles must share exactly one bridge');
  const pluginId='popclaw-native-read-fixture',paths={};
  for(const bundle of ['a','b']){
    const path=join(box,'plugin-'+bundle);paths[bundle]=path;mkdirSync(path);
    writeFileSync(join(path,'openclaw.plugin.json'),JSON.stringify({id:pluginId,name:'Native read fixture',version:'1.0.0',contracts:{tools:['plain','factory','v2'].map(shape=>'popclaw_fixture_'+shape)},configSchema:{type:'object',properties:{},additionalProperties:false}}));
    writeFileSync(join(path,'package.json'),JSON.stringify({name:pluginId,version:'1.0.0',type:'module',openclaw:{extensions:['./index.mjs']}}));
    writeFileSync(join(path,'index.mjs'),`import {register} from ${JSON.stringify(pathToFileURL(join(box,bundle+'.mjs')).href)};export default {id:${JSON.stringify(pluginId)},register};`);
  }
  const sdkImport=file=>import(pathToFileURL(join(sdk,'dist',file)));
  const loader=await sdkImport('loader-runtime-load-DCwhg2IV.mjs'),resolver=await sdkImport('tools-CL6qlaud.mjs');
  const hooks=await sdkImport('hook-runner-global-CwCyBBBr.mjs'),wrapper=await sdkImport('agent-tools.before-tool-call-BbipAsOC.mjs');
  const search=await sdkImport('tool-search-n_DuQ-T8.mjs'),codeMode=await sdkImport('tool-surface-bridge-CgDvORRC.mjs');
  const errors=[],logger={info(){},warn(){},error(m){errors.push(m);},debug(){}};
  const configFor=path=>({tools:{codeMode:{enabled:true,executor:'node',timeoutMs:10000}},plugins:{enabled:true,allow:[pluginId],load:{paths:[path]},entries:{[pluginId]:{enabled:true,hooks:{allowConversationAccess:true}}}}});
  const acquisitions=[];
  for(const label of ['a','b'])acquisitions.push(await loader.t({config:configFor(paths[label]),env,workspaceDir:join(box,'workspace-'+label),onlyPluginIds:[pluginId],toolDiscovery:true,runtimeSideEffects:false,logger}));
  const acquisition=acquisitions[1],config=configFor(paths.b);
  const id={agentId:'main',sessionKey:'agent:main:synthetic',sessionId:'synthetic-physical',runId:'synthetic-run'};
  const context={config,workspaceDir:join(box,'workspace-b'),...id,requesterSenderId:'synthetic-owner',senderIsOwner:false,messageChannel:'synthetic',logger};
  delete context.runId;
  const resolveTools=()=>resolver.i({context,env,runtimeRegistry:acquisition.registry,toolAllowlist:[pluginId],assertInvocationCurrent:()=>{}});
  const rawTools=resolveTools();
  const decode=result=>JSON.parse(result.content.find(block=>block.type==='text').text);
  const input=(identity,history=[])=>({runId:identity.runId,sessionId:identity.sessionId,historyMessages:history,provider:'synthetic',model:'synthetic',prompt:'synthetic'});
  const cases=[];
  try{
    for(const acquired of acquisitions)assert.equal(acquired.registry.diagnostics.filter(d=>d.level==='error').length,0,JSON.stringify(acquired.registry.diagnostics));
    assert.equal(rawTools.length,3,JSON.stringify(errors));
    hooks.i(acquisition.registry);const runner=hooks.t();
    await runner.runLlmInput(input(id),id);assert.equal(a.hasRuntime(),false);
    const direct=rawTools.map(tool=>wrapper.l(tool,{...id,config},{emitDiagnostics:false}));
    const results=[];
    for(const tool of direct)results.push(decode(await tool.execute('direct:'+tool.name,{})));
    assert.ok(results.every(value=>value.scope&&value.current),JSON.stringify({results,errors,hooks:acquisition.registry.typedHooks.map(h=>h.hookName)}));
    assert.equal(new Set(results.map(value=>value.token)).size,1);
    assert.equal(results.filter(value=>value.house_guide_contexts).length,1);
    assert.ok(results.every(value=>!value.factoryHasRunId));
    cases.push('official factory lacks runId; before-tool-call exact bridge scopes plain/factory/v2, serial guide appears once');
    cases.push('cold llm_input installs scope without creating the runtime memo');

    a.installRuntime();
    const history=[{role:'toolResult',content:[{type:'text',text:JSON.stringify({house_guide_contexts:[a.guide]})}]}];
    await runner.runLlmInput(input(id,history),id);
    assert.equal(a.receiptCount(),1);assert.equal(b.receiptCount(),0);
    const acknowledged=decode(await direct[0].execute('after-input',{}));
    assert.equal(acknowledged.house_guide_contexts,undefined);
    cases.push('bundle B llm_input sees bundle A runtime memo and acknowledges complete observed input; no service-local closure');

    const cmId={...id,runId:'synthetic-codemode-run'};
    await runner.runLlmInput(input(cmId),cmId);
    const catalogRef=search.h();search._({catalogRef,tools:rawTools,hookContext:{...cmId,config}});
    const before=b.facts.length;
    const cm=await codeMode.a({ctx:{...cmId,config,catalogRef},code:'const results = await Promise.all([popclaw_fixture_plain({}), popclaw_fixture_factory({}), popclaw_fixture_v2({})]); return results;',wallClockMs:15000,maxToolCalls:3});
    assert.equal(cm.status,'completed',JSON.stringify(cm));
    const facts=b.facts.slice(before);assert.equal(facts.length,3);assert.ok(facts.every(value=>value.scope&&value.current));
    assert.equal(new Set(facts.map(value=>value.token)).size,1);assert.notEqual(facts[0].token,acknowledged.token);
    const cmValues=cm.value.map(decode);
    assert.equal(cmValues.filter(value=>value.house_guide_contexts).length,1,JSON.stringify(cm));
    assert.ok(cmValues.every(value=>value.owner_text==='Private synthetic output kept byte-for-byte'));
    cases.push('official CodeMode node worker → tool catalog → before-tool-call wrapper → all three factories shares exact run; parallel guide once');

    const beforeReset=b.facts.length;
    await runner.runBeforeReset({sessionId:id.sessionId},id);
    const postReset=decode(await direct[0].execute('post-reset',{}));assert.equal(postReset.scope,false);assert.equal(postReset.house_guide_contexts.length,1);
    assert.equal(b.facts.length,beforeReset+1);
    cases.push('reset revokes prior scope; absent bridge redelivers guide despite process receipt');
    const deniedConfig=configFor(paths.b);deniedConfig.plugins.entries[pluginId].hooks.allowConversationAccess=false;
    const denied=await loader.t({config:deniedConfig,env,workspaceDir:join(box,'workspace-denied'),onlyPluginIds:[pluginId],toolDiscovery:true,runtimeSideEffects:false,logger});
    acquisitions.push(denied);
    assert.ok(!denied.registry.typedHooks.some(hook=>hook.hookName==='llm_input'||hook.hookName==='agent_end'));
    const deniedId={...id,runId:'synthetic-denied-run'};hooks.i(denied.registry);
    await hooks.t().runLlmInput(input(deniedId,history),deniedId);
    const deniedTool=resolver.i({context:{...context,config:deniedConfig},env,runtimeRegistry:denied.registry,toolAllowlist:[pluginId],assertInvocationCurrent:()=>{}})[0];
    const deniedResult=decode(await wrapper.l(deniedTool,{...deniedId,config:deniedConfig},{emitDiagnostics:false}).execute('denied-input',{}));
    assert.equal(deniedResult.scope,false);assert.equal(deniedResult.house_guide_contexts.length,1);
    cases.push('SDK denies llm_input/agent_end without conversation-access permission; tool uses no scope and redelivers guide safely');
    assert.deepEqual(hashes(),sourceSha256);
    console.log(JSON.stringify({sdk:'2026.9.8',node:process.version,sourceSha256,cases,facts:b.facts,codeModeToolCalls:cm.toolCallCount,errors,boundaries:['synthetic admitted host context and read bodies','no network, real private records, channel delivery, runtime boot or deployment','official SDK modules imported unchanged; no custom CodeMode transport or hook implementation']}));
  }finally{a.clearRuntime();a.context.closeAll();hooks.a();for(const acquired of acquisitions.reverse())await acquired.release();}
});
