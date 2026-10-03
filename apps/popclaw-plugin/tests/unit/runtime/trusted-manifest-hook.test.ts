import { afterEach, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { HouseLifecycleManager, type PreparedTrustedManifest } from '../../../src/runtime/house-lifecycle/manager.js';
import { fetchSessionManifest, MAX_SESSION_MANIFEST_BYTES } from '../../../src/runtime/house-lifecycle/control-client.js';
const origin='https://house.invalid';
const key=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
const ackKeyHex=Buffer.from(key.publicKey).toString('hex');
const raw=' { "house_session": '+JSON.stringify({version:1,endpoint:'/v1/house-session',ack_pubkey:ackKeyHex,operations:['enter','renew','leave','status'],lease_seconds:90,renew_interval_seconds:30})+' }\n';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.reverse())await f();cleanup.length=0;});
function fixture(prepare:ConstructorParameters<typeof HouseLifecycleManager>[0]['prepareTrustedManifest'], configuredPinFor?:ConstructorParameters<typeof HouseLifecycleManager>[0]['configuredPinFor']){
 const db=new InMemoryHostDb();cleanup.push(()=>db.close());let enters=0;
 const transport=vi.fn(async(_input:unknown,init?:RequestInit)=>{
  if(!init?.method || init.method==='GET')return new Response(raw,{headers:{'X-Popclaw-Manifest-Proof':'same-response-proof'}});
  const request = popclaw.housesession.HouseSessionRequest.decode(new Uint8Array(init.body as Uint8Array));
  if(request.core?.operation === 1) enters++;
  return new Response('',{status:503});
 });
 const manager=new HouseLifecycleManager({db,installationId:'fixture-install',signer:{publicKey:async()=>key.publicKey,popclawId:async()=>bs58.encode(key.publicKey),sign:async b=>nacl.sign.detached(b,key.secretKey)},fetch:transport,retryBackoffMs:60000,prepareTrustedManifest:prepare,configuredPinFor});
 cleanup.push(async()=>{manager.stopHost();await manager.waitForQuiet();});
 return {db,manager,transport,enters:()=>enters};
}
it('retains exact bytes and proof from one bounded manifest response',async()=>{
 const transport=vi.fn(async()=>new Response(raw,{headers:{'X-Popclaw-Manifest-Proof':'same-response-proof'}}));
 const result=await fetchSessionManifest(origin,transport);
 expect(new TextDecoder().decode(result.rawBytes)).toBe(raw);expect(result.proofHeader).toBe('same-response-proof');expect(result.board?.ack_pubkey).toBe(ackKeyHex);expect(transport).toHaveBeenCalledTimes(1);
});
it('rejects oversized bodies without trusting a content-length header',async()=>{
 const payload=new Uint8Array(MAX_SESSION_MANIFEST_BYTES+1).fill(32);
 await expect(fetchSessionManifest(origin,async()=>new Response(payload))).rejects.toThrow('exceeds 1 MiB');
});
it('persists the pin before preparation and commits prepared state before ENTER',async()=>{
 const order:string[]=[];
 const s=fixture(input=>{
  expect(s.db.queryOne<{ack_key_hex:string}>('SELECT ack_key_hex FROM house_participation')?.ack_key_hex).toBe(ackKeyHex);
  expect(new TextDecoder().decode(input.rawBytes)).toBe(raw);expect(input.proofHeader).toBe('same-response-proof');expect(input.provenance).toBe('https_tofu');expect(s.enters()).toBe(0);order.push('prepare');
  return {commit:tx=>{expect(s.enters()).toBe(0);tx.execute('CREATE TABLE verified_capability (revision INTEGER)');tx.execute('INSERT INTO verified_capability VALUES(1)');order.push('commit');}};
 });
 await s.manager.loginHouse(origin);expect(order).toEqual(['prepare','commit']);expect(s.enters()).toBe(1);expect(s.db.queryOne('SELECT * FROM verified_capability')).toEqual({revision:1});
});
it('a verification failure keeps the pin and blocks ENTER',async()=>{
 const s=fixture(()=>{throw new Error('bad proof');});
 expect(await s.manager.loginHouse(origin)).toMatchObject({errorCode:'AUTH_INVALID'});expect(s.enters()).toBe(0);
 expect(s.db.queryOne<{ack_key_hex:string}>('SELECT ack_key_hex FROM house_participation')?.ack_key_hex).toBe(ackKeyHex);expect(s.manager.gateFor(origin).isActive()).toBe(false);
});
it('logout while preparation awaits cannot commit capability state or enter a new session',async()=>{
 let entered!:()=>void;const preparing=new Promise<void>(r=>entered=r);let release!:(p:PreparedTrustedManifest)=>void;
 const hold=new Promise<PreparedTrustedManifest>(r=>release=r);const commit=vi.fn();
 const s=fixture(()=>{entered();return hold;});const login=s.manager.loginHouse(origin);await preparing;
 await s.manager.logoutHouse(origin);release({commit});await login;expect(commit).not.toHaveBeenCalled();expect(s.enters()).toBe(0);
});

it('ownership lost before the capability commit lock blocks both persistence and ENTER',async()=>{
 let owner=true;let prepared=false;const commit=vi.fn();
 const s=fixture(()=>{prepared=true;return {commit};});
 s.manager.bindOwnerAuthority({captureEpoch:()=>owner?1:null,isEpochCurrent:()=>owner});
 const transact=s.db.transaction.bind(s.db);
 vi.spyOn(s.db,'transaction').mockImplementation(fn=>{if(prepared)owner=false;return transact(fn);});
 await s.manager.loginHouse(origin);expect(commit).not.toHaveBeenCalled();expect(s.enters()).toBe(0);
});

it('a configured-pin change during preparation blocks capability commit and ENTER', async () => {
  let configuredPin = ackKeyHex;
  let entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  let release!: (prepared: PreparedTrustedManifest) => void;
  const hold = new Promise<PreparedTrustedManifest>(resolve => { release = resolve; });
  const commit = vi.fn((tx: Parameters<PreparedTrustedManifest['commit']>[0]) => {
    tx.execute('INSERT INTO verified_capability VALUES (1)');
  });
  const s = fixture(input => {
    expect(input.ackKeyHex).toBe(ackKeyHex);
    expect(input.provenance).toBe('configured_pin');
    entered();
    return hold;
  }, () => configuredPin);
  s.db.execute('CREATE TABLE verified_capability (revision INTEGER)');
  const login = s.manager.loginHouse(origin);
  await preparing;
  configuredPin = Buffer.from(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18)).publicKey).toString('hex');
  release({ commit });
  await login;
  expect({ commits: commit.mock.calls.length, rows: s.db.queryAll('SELECT * FROM verified_capability'), enters: s.enters() })
    .toEqual({ commits: 0, rows: [], enters: 0 });
});
