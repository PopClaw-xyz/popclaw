import { it, expect, vi } from 'vitest';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import { ResidentLifecycle } from '../../../src/runtime/house-lifecycle/resident.js';
it('captured notification gate denies after terminal drain and database close without reading SQLite', async()=>{
  vi.useFakeTimers(); const db=new LocalHostDb(':memory:');
  const manager=new HouseLifecycleManager({db,installationId:'synthetic',signer:{popclawId:async()=>'synthetic',publicKey:async()=>new Uint8Array(32),sign:async()=>new Uint8Array(64)},fetch:async()=>{throw new Error('no network permitted');}});
  const resident=new ResidentLifecycle({manager,token:'A',streams:{open:()=>({stop:()=>undefined})}});
  resident.configureOrigins(['https://synthetic.invalid']);
  try {
    resident.start(); await Promise.resolve();
    const gate=resident.captureGate('https://synthetic.invalid'); expect(gate.isActive()).toBe(true);
    await resident.stop(); expect(gate.signal.aborted).toBe(true); db.close();
    let result:unknown; try {result=gate.isActive();}catch(error){result=String(error);}
    console.log('CAPTURED_GATE_AFTER_DRAIN',JSON.stringify({aborted:gate.signal.aborted,result}));
    expect(result,'aborted captured authority must short circuit before consulting a closed durable store').toBe(false);
  }finally{db.close();vi.useRealTimers();}
});
