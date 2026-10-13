import test from 'node:test';
import assert from 'node:assert/strict';
import {NAMES,publishNative,getRegistryPackage} from '../publish-clawhub-native.mjs';
const packages=()=>NAMES.map(name=>({name,version:'0.1.3',filename:name+'-0.1.3.tgz',sha256:'a'.repeat(64)}));
function harness(states={}){
 const events=[];
 return {events,packages:packages(),dryRun:false,getPackage:async name=>{
  events.push(['read',name]);const state=states[name]??{name,versions:{'0.0.0':{}}};if(state instanceof Error)throw state;return state;
 },verify:async pkg=>{events.push(['verify',pkg.name]);},publish:async pkg=>{events.push(['publish',pkg.name]);},dryPublish:async pkg=>{events.push(['dry',pkg.name]);}};
}
test('dry run never publishes and clearly reports bootstrap required',async()=>{
 const h=harness({[NAMES[4]]:{missing:true}});h.dryRun=true;const r=await publishNative(h);
 assert.equal(h.events.filter(e=>e[0]==='publish').length,0);assert.deepEqual(r.bootstrapRequired,[NAMES[4]]);assert.equal(h.events.filter(e=>e[0]==='dry').length,5);
});
test('all package names are preflighted before first real publish; bootstrap blocks all',async()=>{
 const h=harness({[NAMES[4]]:{missing:true}});await assert.rejects(publishNative(h),/BOOTSTRAP_REQUIRED/);assert.equal(h.events.filter(e=>e[0]==='publish').length,0);assert.equal(h.events.filter(e=>e[0]==='read').length,5);
});
test('existing versions verify first, only missing versions publish then verify',async()=>{
 const h=harness({[NAMES[0]]:{name:NAMES[0],versions:{'0.1.3':{}}}});await publishNative(h);
 assert.equal(h.events.filter(e=>e[0]==='publish').length,4);assert.ok(!h.events.some(e=>e[0]==='publish'&&e[1]===NAMES[0]));assert.deepEqual(h.events.slice(0,5).map(e=>e[0]),Array(5).fill('read'));
 for(const name of NAMES.slice(1)){const i=h.events.findIndex(e=>e[0]==='publish'&&e[1]===name);assert.deepEqual(h.events[i+1],['verify',name]);}
});
test('unknown registry state or existing byte mismatch blocks every publish',async()=>{
 for(const state of [new Error('HTTP 401'),new Error('HTTP 503'),{name:'wrong',versions:{}},{name:NAMES[4],versions:[]}]){
  const h=harness({[NAMES[4]]:state});await assert.rejects(publishNative(h));assert.equal(h.events.filter(e=>e[0]==='publish').length,0);
 }
 const h=harness({[NAMES[4]]:{name:NAMES[4],versions:{'0.1.3':{}}}});h.verify=async()=>{throw new Error('bytes mismatch')};await assert.rejects(publishNative(h),/bytes mismatch/);assert.equal(h.events.filter(e=>e[0]==='publish').length,0);
});
test('receipt cannot select a main package, duplicate, missing or extra native',async()=>{
 for(const mutate of [p=>p[0].name='popclaw-clawhub',p=>p.push({...p[0]}),p=>p.pop(),p=>p[4].name=p[0].name]){
  const h=harness();mutate(h.packages);await assert.rejects(publishNative(h));assert.equal(h.events.length,0);
 }
});
test('post-publish verification failure prevents subsequent packages',async()=>{
 const h=harness();h.verify=async()=>{throw new Error('registry bytes mismatch')};await assert.rejects(publishNative(h));assert.equal(h.events.filter(e=>e[0]==='publish').length,1);
});
test('only an explicit registry package 404 means bootstrap; all other failures stay unknown',async()=>{
 const missing=await getRegistryPackage(NAMES[0],async()=>new Response(JSON.stringify({error:'Not found'}),{status:404}));
 assert.deepEqual(missing,{missing:true});
 for(const response of [new Response('{}',{status:404}),new Response('<html>error</html>',{status:404}),new Response('{}',{status:401}),new Response('{}',{status:503}),new Response('broken json',{status:200})]){
  await assert.rejects(getRegistryPackage(NAMES[0],async()=>response));
 }
 await assert.rejects(getRegistryPackage(NAMES[0],async()=>{throw new Error('network timeout')}),/timeout/);
});
test('no missing version is published before every pre-existing version is verified',async()=>{
 const h=harness({[NAMES[4]]:{name:NAMES[4],versions:{'0.1.3':{}}}});await publishNative(h);
 const firstPublish=h.events.findIndex(e=>e[0]==='publish');const oldVerify=h.events.findIndex(e=>e[0]==='verify'&&e[1]===NAMES[4]);
 assert.ok(oldVerify>0&&oldVerify<firstPublish);
});
