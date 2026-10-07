import {mkdirSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Shared narrow fixture: unchanged SDK loader/registry/wrapper and real
 * product registrations, SQLite and signing. Only admission and egress are
 * synthetic. The caller owns its isolated environment and session setup. */
export async function loadDurableNativeSdk({root,box,env,context}) {
  const require=createRequire(join(root,'package.json')), {build}=require('esbuild');
  const sdk=realpathSync(join(root,'node_modules/openclaw'));
  if(JSON.parse(readFileSync(join(sdk,'package.json'))).version!=='2026.9.8')throw Error('Unpinned fixture SDK');
  symlinkSync(join(root,'node_modules'),join(box,'node_modules'),'dir');
  const data=join(box,'data');mkdirSync(data);
  const entry=`
    import {durableFixture} from ${JSON.stringify(join(root,'tests/helpers/durable-social-process.ts'))};
    import {registerPopclawTools} from ${JSON.stringify(join(root,'src/tools/register-tools.ts'))};
    import {DurableSocialDrafts} from ${JSON.stringify(join(root,'src/tools/durable-social-drafts.ts'))};
    let fixture; const hook=Symbol.for(${JSON.stringify(`durable-sdk-hook:${box}`)}), holders=Symbol.for(${JSON.stringify(`durable-sdk-handles:${box}`)});
    function get(){if(!fixture){fixture=durableFixture(${JSON.stringify(data)},{migrationsDir:${JSON.stringify(join(root,'migrations'))},revokeDuringSign:()=>globalThis[hook]?.()});(globalThis[holders]??=[]).push(fixture);}return fixture;}
    export function register(api){return registerPopclawTools({api,runtime:()=>get().runtime(),socialSendHost:'native',durableSocialDrafts:true});}
    export function manuscript(id){return new DurableSocialDrafts(get().db,get().owner.id).load(id);}
    export function exists(id){return !!manuscript(id);}
    export function effects(){return get().effects().length;}
    export function effectsData(){return get().effects();}
    export function onSign(fn){globalThis[hook]=fn;}
    export function close(){for(const fixture of globalThis[holders]??[])fixture.db.close();delete globalThis[holders];delete globalThis[hook];}
  `;
  await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},absWorkingDir:root,tsconfig:join(root,'tsconfig.json'),outfile:join(box,'runtime.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',external:['openclaw','openclaw/*','better-sqlite3','bindings','file-uri-to-path'],banner:{js:"import {createRequire as __fixtureRequire} from 'node:module';const require=__fixtureRequire(import.meta.url);"}});
  const runtime=await import(pathToFileURL(join(box,'runtime.mjs'))), pluginId='popclaw-durable-fixture', plugin=join(box,'plugin');mkdirSync(plugin);
  const manifest=JSON.parse(readFileSync(join(root,'openclaw.plugin.json')));
  writeFileSync(join(plugin,'openclaw.plugin.json'),JSON.stringify({id:pluginId,name:'Durable SDK fixture',version:'1.0.0',contracts:{tools:manifest.contracts.tools},configSchema:{type:'object',properties:{},additionalProperties:false}}));
  writeFileSync(join(plugin,'package.json'),JSON.stringify({name:pluginId,version:'1.0.0',type:'module',openclaw:{extensions:['./index.mjs']}}));
  writeFileSync(join(plugin,'index.mjs'),`import {register} from ${JSON.stringify(pathToFileURL(join(box,'runtime.mjs')).href)};export default {id:${JSON.stringify(pluginId)},register};`);
  const sdkImport=file=>import(pathToFileURL(join(sdk,'dist',file))), loader=await sdkImport('loader-runtime-load-DCwhg2IV.mjs'), resolver=await sdkImport('tools-CL6qlaud.mjs');
  const errors=[],logger={info(){},warn(){},error(m){errors.push(m);},debug(){}};
  const config={...context.config,plugins:{enabled:true,allow:[pluginId],load:{paths:[plugin]},entries:{[pluginId]:{enabled:true}}}};
  const acquisition=await loader.t({config,env,workspaceDir:join(box,'workspace'),onlyPluginIds:[pluginId],toolDiscovery:true,runtimeSideEffects:false,logger});
  const tools=(guard,extra={})=>resolver.i({context:{...context,config,workspaceDir:join(box,'workspace'),logger,...extra},env,runtimeRegistry:acquisition.registry,toolAllowlist:[pluginId],assertInvocationCurrent:guard});
  return {runtime,acquisition,tools,errors,data,async close(){await acquisition.release();runtime.close();}};
}
