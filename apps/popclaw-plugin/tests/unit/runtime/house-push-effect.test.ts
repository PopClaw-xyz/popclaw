import {expect,it,vi} from 'vitest';
import {captureHousePushEffect,parseHousePushEffect} from '../../../src/runtime/house-lifecycle/push-effect.js';
const intent=(executionReference:unknown)=>({version:1,kind:'world_intent',requestId:'a'.repeat(64),executionReference});
it.each([
 {kind:'owner_action',reservationId:'reservation'},
 {kind:'native_policy',reservationId:'b'.repeat(64)},
 {kind:'read_state',reservationId:'reservation',participationId:'participation'},
 {kind:'participation',reservationId:'["canonical","reservation"]',participationId:'participation',jobId:'job'},
])('captures and roundtrips the exact $kind reference without authority',ref=>{
 const original=intent(ref);const fixed=captureHousePushEffect(original);
 expect(fixed).toEqual(original);expect(Object.isFrozen(fixed)).toBe(true);
 if(fixed.kind!=='world_intent')throw new Error('wrong kind');
 expect(Object.isFrozen(fixed.executionReference)).toBe(true);
 ref.reservationId='changed';expect(fixed.executionReference.reservationId).not.toBe('changed');
 expect(parseHousePushEffect(JSON.stringify(fixed))).toEqual(fixed);
});
it.each([
 {kind:'native_policy',reservationId:'b'.repeat(64),policy:{allowed:true}},
 {kind:'native_policy',reservationId:'reservation'},
 {kind:'native_policy',reservationId:'B'.repeat(64)},
 {kind:'owner_action',reservationId:'reservation',jobId:'extra'},
 {kind:'read_state',reservationId:'reservation'},
 {kind:'participation',reservationId:'reservation',participationId:'participation'},
 {kind:'other',reservationId:'reservation'},
 {kind:'owner_action',reservationId:'x'.repeat(8193)},
 {kind:'owner_action',reservationId:'bad\u0000'},
 {kind:'owner_action',reservationId:'bad\ud800'},
])('refuses incomplete, expanded or malformed references %#',ref=>{
 expect(()=>captureHousePushEffect(intent(ref))).toThrow('HOUSE_PUSH_EFFECT_INVALID');
});
it('rejects accessors and toJSON without invoking them',()=>{
 const getter=vi.fn(()=> 'owner_action');const toJSON=vi.fn(()=>({}));
 const ref=Object.defineProperty({reservationId:'reservation'},'kind',{enumerable:true,get:getter});
 expect(()=>captureHousePushEffect(intent(ref))).toThrow();expect(getter).not.toHaveBeenCalled();
 expect(()=>captureHousePushEffect({...intent({kind:'owner_action',reservationId:'reservation'}),toJSON})).toThrow();expect(toJSON).not.toHaveBeenCalled();
});
it('rejects duplicate JSON keys in a damaged persisted row',()=>{
 const fixed=captureHousePushEffect(intent({kind:'owner_action',reservationId:'reservation'}));
 const duplicate=JSON.stringify(fixed).replace('"version":1','"version":2,"version":1');
 expect(()=>parseHousePushEffect(duplicate)).toThrow('HOUSE_PUSH_EFFECT_INVALID');
});
