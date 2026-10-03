import { expect, it } from 'vitest';
import { withHouseActions, assertHouseActionActive, captureActionContext, withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
it('a captured continuation keeps its original house permission while another house remains usable',async()=>{
 let a=true;const b=true;const signal=new AbortController().signal;
 const saved=withHouseActions(new Map([['https://a.invalid',{signal,isActive:()=>a}],['https://b.invalid',{signal,isActive:()=>b}]]),()=>captureActionContext(async(origin:string)=>{await Promise.resolve();assertHouseActionActive(origin);return 'sent';}));
 a=false;
 await expect(withHouseActions(new Map([['https://a.invalid',{signal,isActive:()=>true}]]),()=>saved('https://a.invalid'))).rejects.toThrow();
 await expect(saved('https://b.invalid')).resolves.toBe('sent');
 await expect(saved('https://new.invalid')).rejects.toThrow();
});
it('a stored callback retains the enclosing single-house gate too',()=>{
 let active=true;const gate={signal:new AbortController().signal,isActive:()=>active};
 const saved=withAction(gate,()=>captureActionContext(()=>42));active=false;expect(saved).toThrow();
});
