import { expect, it } from 'vitest';
import { withReadCallBudget } from '../../../src/runtime/read-call-budget.js';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
it('bounds the entire serial read, not each individual step', async () => {
  await expect(withReadCallBudget({ timeoutMs: 25 }, async () => {
    await delay(15); await delay(15); return 'late';
  })).rejects.toMatchObject({ code:'READ_CALL_BUDGET_EXCEEDED',failure: { code: 'HOUSE_REMOTE_TIMEOUT',diagnostic:{budget:'read-call'} } });
});
it('retains the earlier trusted host deadline across nested reads', async () => {
  await expect(withReadCallBudget({ deadlineAtMs: Date.now() + 15 }, () =>
    withReadCallBudget({ timeoutMs: 100 }, async () => { await delay(30); return 'late'; }),
  )).rejects.toMatchObject({ code:'READ_CALL_BUDGET_EXCEEDED',failure: { code: 'HOUSE_REMOTE_TIMEOUT',diagnostic:{budget:'read-call'} } });
});
it('stops waiting for work that ignores cancellation', async () => {
  const controller = new AbortController();
  const result = withReadCallBudget({ signal: controller.signal }, async () => { await delay(30); return 'late'; });
  controller.abort();
  await expect(result).rejects.toMatchObject({ code: 'HOUSE_ACTION_STALE' });
});

it('settles an aborted waiter even when an injected assertion does not throw',async()=>{
  const {waitForRead}=await import('../../../src/runtime/read-call-budget.js');
  const controller=new AbortController();
  const result=waitForRead(new Promise(()=>{}),{deadlineAtMs:Date.now()+1000,signal:controller.signal,remainingMs:()=>1000,assertActive(){}});
  controller.abort();
  await expect(result).rejects.toBeDefined();
});
it('preserves the existing action gate when its currentness changes without aborting its signal',async()=>{
  const {withAction}=await import('../../../src/runtime/house-lifecycle/action-context.js');
  let active=true;
  await expect(withAction({signal:new AbortController().signal,isActive:()=>active},()=>withReadCallBudget({},async()=>{active=false;return 'denied';}))).rejects.toMatchObject({code:'HOUSE_ACTION_STALE'});
});
