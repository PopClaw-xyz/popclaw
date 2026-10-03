import { expect, it, vi } from 'vitest';
import { Ranger } from '../../../src/runtime/ranger.js';
import { WatchLoop } from '../../../src/watch/watch-loop.js';
import { WatchRegistry, defaultEntry } from '../../../src/watch/watch-registry.js';


import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { PluginConfig } from '../../../src/config/schema.js';
import { noDmCrypto } from '../../helpers/test-signer.js';


function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function gate() { const controller = new AbortController(); return { signal: controller.signal, isActive: () => !controller.signal.aborted, close: () => controller.abort() }; }
const signer = { publicKey: async () => new Uint8Array(32), sign: async () => new Uint8Array(64), popclawId: async () => 'self', ...noDmCrypto };

import {buildScraperRegistryFor} from '../../../src/runtime/ranger.js';
const wireSigner={...signer,popclawId:async()=> '11111111111111111111111111111111'};
it('WatchCancel while mirror signing prevents that old entry from later pushing',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1000);vi.stubEnv('POPCLAW_TWITTERAPI_IO_KEY','fake');
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({tweets:[{type:'tweet',id:'p',text:'old',url:'https://content.invalid/p',createdAt:new Date(2000000).toISOString()}],has_next_page:false}))));
  const signature=deferred<Uint8Array>();const signing=deferred<void>();let count=0;
  const push=vi.fn(async()=>({status:200,deduplicated:false}));let deliver!:(e:any)=>Promise<void>|void;
  const host=new InMemoryHostAdapter();const ranger=new Ranger({host,gate:gate(),houseOrigin:'https://house.invalid',config:PluginConfig.parse({lore_houses:['https://house.invalid'],ranger_mode:true,watch:{tick_interval_ms:10000,heartbeat_interval_ms:1000000}}),signer:{...wireSigner,sign:async()=>{if(++count===3){signing.resolve();return signature.promise;}return new Uint8Array(64);}},nickname:'test',egress:{push},ingress:{start:async h=>{deliver=h;},stop:async()=>{}}});
  try{
    await ranger.start();await deliver({eventId:'watch',envelope:{watchDispatch:{watchId:'w',targetPopclawId:'target',platform:'x',handle:'tester',since:1}}});
    await vi.advanceTimersByTimeAsync(300001);await signing.promise;
    await deliver({eventId:'cancel',envelope:{watchCancel:{watchId:'w'}}});
    signature.resolve(new Uint8Array(64));await vi.advanceTimersByTimeAsync(0);
    console.log('WATCH_CANCEL_SIGN',JSON.stringify({pushes:push.mock.calls.length,signs:count,watermarks:host.db.queryAll('SELECT * FROM watch_watermarks')}));
    expect(push,'only startup registration may be emitted').toHaveBeenCalledTimes(1);
  }finally{signature.resolve(new Uint8Array(64));await ranger.stop();host.db.close();vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();}
});
it('cancelled watch cannot buy a second provider page after first body finishes',async()=>{
  const g=gate();const save=vi.fn();const registry=new WatchRegistry({load:()=>null,save});registry.add('w','target','tester','x',defaultEntry(-1000000,1));
  const calls:string[]=[];let page=0;const fetch=vi.fn(async(input:any)=>{
    calls.push(String(input));const first=++page===1;
    return {ok:true,status:200,arrayBuffer:async()=>{if(first)registry.remove('w');return new TextEncoder().encode(JSON.stringify({tweets:[{type:'tweet',id:String(page),text:'p',createdAt:new Date(2000000).toISOString()}],has_next_page:first,next_cursor:first?'next':''})).buffer;}} as Response;
  });
  const scrapers=await buildScraperRegistryFor({backendOverride:'twitterapi_io',twitterApiIoKey:'fake',apifyToken:undefined,youtubeApiKey:undefined,gate:g,fetch,sleep:async()=>{}});
  const push=vi.fn();const loop=new WatchLoop({registry,scraperRegistry:scrapers,push,maxScanItems:10,gate:g});
  await loop.tick(1000);console.log('WATCH_CANCEL_PAGINATION',JSON.stringify({calls,pushes:push.mock.calls.length,saves:save.mock.calls.length}));
  expect(calls).toHaveLength(1);expect(push).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
});
