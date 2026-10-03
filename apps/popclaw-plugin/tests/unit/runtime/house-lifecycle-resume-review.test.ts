import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { ackSigningInput } from '@popclaw/algorithms';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import { OwnerLease } from '../../../src/runtime/house-lifecycle/owner-lease.js';
import { ResidentLifecycle } from '../../../src/runtime/house-lifecycle/resident.js';
import { readOutboxRow } from '../../../src/runtime/house-lifecycle/participation-store.js';

const ORIGIN = 'https://owner-probe.invalid';
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(53));
const houseKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
const houseHex = Buffer.from(houseKey.publicKey).toString('hex');
const ns = (popclaw as any).housesession;
const signer = {
  popclawId: async () => bs58.encode(key.publicKey),
  publicKey: async () => key.publicKey,
  sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, key.secretKey),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function flush() { for (let n=0;n<30;n++) await Promise.resolve(); }
function signedLeaveAck(init: RequestInit): Response {
  const request = ns.HouseSessionRequest.decode(init.body as Uint8Array);
  const core = { ...request.core, outcome: 4, serverCommittedAt: 1757200000 };
  const signature = nacl.sign.detached(ackSigningInput(core), houseKey.secretKey);
  return new Response(ns.HouseSessionAck.encode({ core, signature, signerPubkey: houseKey.publicKey }).finish());
}

describe('independent fixed 77587 resume/owner boundary probes', () => {
  for (const hungStage of ['sign', 'fetch'] as const) {
    it(`resume drain remains bounded when old ${hungStage} never settles or obeys abort`, async () => {
      vi.useFakeTimers();
      // Advance the actual advertised timeout semantics without waiting 30s.
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const c = new AbortController();
        setTimeout(() => c.abort(new Error('probe timeout')), ms);
        return c.signal;
      });
      const tmp=mkdtempSync(join(tmpdir(),'resume-hang-'));
      const db=new LocalHostDb(join(tmp,'host.db'));
      let entered=false, sends=0, transportSignal: AbortSignal | null | undefined;
      const m=new HouseLifecycleManager({ db, installationId:'synthetic', configuredPinFor:()=>houseHex,
        signer: {...signer, sign: async (bytes) => {
          if(hungStage==='sign') { entered=true; return new Promise<Uint8Array>(()=>{}); }
          return signer.sign(bytes);
        }},
        fetch: async (_url,init) => {
          sends++; entered=true; transportSignal=init?.signal;
          return new Promise<Response>(()=>{});
        },
      });
      try {
        await m.logoutHouse(ORIGIN); await flush(); expect(entered).toBe(true);
        m.quiesce();
        let resumed=false;
        void m.resumeAfterOwnership().then(()=>{resumed=true;});
        await vi.advanceTimersByTimeAsync(35_000); await flush();
        console.log('HUNG_DRAIN',JSON.stringify({hungStage,elapsedMs:35000,resumed,sends,transportAborted:transportSignal?.aborted}));
        expect(resumed,'quiesced generation must release recovery within the claimed 30-second bound').toBe(true);
      } finally { m.stopHost(); db.close(); rmSync(tmp,{recursive:true,force:true}); timeoutSpy.mockRestore(); vi.useRealTimers(); }
    });
  }

  for (const takeoverStage of ['sign', 'ack'] as const) {
    it(`old owner must not ${takeoverStage==='sign'?'send after deferred signing':'settle a delayed ACK'} before timer notices takeover`, async () => {
      vi.useFakeTimers();
      const tmp=mkdtempSync(join(tmpdir(),'owner-worker-'));
      const dbA=new LocalHostDb(join(tmp,'host.db')), dbB=new LocalHostDb(join(tmp,'host.db'));
      let now=1757200000000, signEntered=false, sends=0;
      const signBarrier=deferred<void>(), ackBarrier=deferred<Response>();
      let requestInit!: RequestInit;
      const m=new HouseLifecycleManager({db:dbA, installationId:'synthetic', configuredPinFor:()=>houseHex,
        clock:()=>now,
        signer:{...signer,sign:async(bytes)=>{signEntered=true;if(takeoverStage==='sign') await signBarrier.promise;return signer.sign(bytes);}},
        fetch:async(_url,init)=>{sends++;requestInit=init!;return takeoverStage==='ack'?ackBarrier.promise:signedLeaveAck(init!);},
      });
      const a=new ResidentLifecycle({manager:m,token:'A',ttlMs:30000,now:()=>now,streams:{open:()=>({stop(){}})}});
      const b=new OwnerLease({db:dbB,token:'B',ttlMs:30000,now:()=>now});
      try {
        a.start(); await flush();
        const result=await a.coordinator.logoutHouse(ORIGIN); await flush();
        expect(signEntered).toBe(true);
        expect(sends).toBe(takeoverStage==='sign'?0:1);
        now+=31000;
        expect(b.tryAcquire()).toBe(true);
        expect(dbA.queryOne<{holder:string}>('SELECT holder FROM house_lifecycle_owner')!.holder).toBe('B');
        // Clock jumped; fake timer scheduler did not advance: A onLost has not run.
        if(takeoverStage==='sign') signBarrier.resolve(); else ackBarrier.resolve(signedLeaveAck(requestInit));
        await flush(); await m.waitForQuiet();
        const row=readOutboxRow(dbA,result.operationId)!;
        console.log('OLD_OWNER_WORKER',JSON.stringify({takeoverStage,sends,owner:dbA.queryOne('SELECT * FROM house_lifecycle_owner'),settledAt:row.settled_at}));
        if(takeoverStage==='sign') expect(sends,'final send must re-read captured owner epoch, independent of callback timing').toBe(0);
        else expect(row.settled_at,'lost durable owner epoch cannot settle ACK before timer callback').toBeNull();
      } finally { a.stop();b.release();dbA.close();dbB.close();rmSync(tmp,{recursive:true,force:true});vi.useRealTimers(); }
    });
  }
});
