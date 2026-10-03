import { it, expect, vi } from 'vitest';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import { ResidentLifecycle } from '../../../src/runtime/house-lifecycle/resident.js';

it('same-holder epoch rollover retains every resource until its stop is tracked',async()=>{
  vi.useFakeTimers();
  const db=new LocalHostDb(':memory:');let now=1757200000000;
  const manager=new HouseLifecycleManager({db,installationId:'synthetic',clock:()=>now,
    signer:{popclawId:async()=>'synthetic',publicKey:async()=>new Uint8Array(32),sign:async()=>new Uint8Array(64)},
    fetch:async()=>{throw new Error('no network permitted');}});
  const resources:Array<{id:number;stopped:boolean}>=[];
  const resident:ResidentLifecycle=new ResidentLifecycle({manager,token:'A',ttlMs:30000,now:()=>now,intentPollMs:60000,
    streams:{open:()=>{
      const resource={id:resources.length+1,stopped:false};resources.push(resource);
      return {stop:()=>{
        if(resource.stopped)return;
        resource.stopped=true;
        // Legitimate synchronous close callback asks the coordinator to
        // reconcile state. No private implementation is invoked.
        if(resource.id===1)resident.coordinator.syncHouse('https://synthetic.invalid');
      }};
    }},
  });
  resident.configureOrigins(['https://synthetic.invalid']);
  try {
    resident.start();await Promise.resolve();
    now+=31000;
    await vi.advanceTimersByTimeAsync(10000);
    expect(db.queryOne<{generation:number}>('SELECT generation FROM house_lifecycle_owner')!.generation).toBe(2);
    await resident.stop();await Promise.resolve();
    console.log('ROLLOVER_RESOURCE_DRAIN',JSON.stringify({resources,unclosed:resources.filter(r=>!r.stopped).map(r=>r.id)}));
    expect(resources.filter(r=>!r.stopped),'terminal drain must account for every resource opened during rollover callbacks').toEqual([]);
  }finally{await resident.stop();db.close();vi.useRealTimers();}
});
