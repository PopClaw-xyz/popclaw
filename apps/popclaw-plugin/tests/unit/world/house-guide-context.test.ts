import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { establishTrustInTx } from '../../../src/world/house-binding-pin.js';
import { readJoinedHouseGuide, guideBindingDigest, markGuidesInAgentInput, recordJoinedGuide, pendingHouseGuides, readHouseGuideContext, houseGuideContextKey, observedHouseGuideKeys } from '../../../src/world/house-guide-context.js';
import { entryDigest } from '../../../src/runtime/house-lifecycle/participation-journal.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const ORIGIN = 'https://guide.invalid';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'house-guide-'));
  const db = new LocalHostDb(join(root, 'host.db'));
  runMigrations(db, resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations'));
  ensureHouseLifecycleSchema(db);
  const house = mintHouse({ origin: ORIGIN });
  db.transaction(tx => {
    establishTrustInTx(tx, { origin: ORIGIN, houseKey: house.houseKey, incarnation: house.incarnation }, 'tofu', 1);
    tx.execute(`INSERT INTO house_participation(house_origin,installation_id,op_seq,desired,phase,updated_at)
      VALUES (?,'guide-test-install',1,'enabled','connected',1)`, [ORIGIN]);
    recordJoinedGuide(tx, { origin: ORIGIN, opSeq: 1,
      rawBytes: new TextEncoder().encode('{"guide_url":"/guide.md"}'), manifestDigest: 'manifest' });
  });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const row = () => db.queryOne<Record<string, unknown>>('SELECT * FROM house_guide_context WHERE origin=?', [ORIGIN]);
  return { db, row };
}

it('joined replacement synchronously clears an existing body and delivery even at the same pointer', () => {
  const f = fixture();
  f.db.execute(`UPDATE house_guide_context SET guide_body='old',guide_digest='old-digest',delivered_digest='old-digest'`);
  const result = f.db.transaction(tx => recordJoinedGuide(tx, { origin: ORIGIN, opSeq: 2,
    rawBytes: new TextEncoder().encode('{"guide_url":"/guide.md"}'), manifestDigest: 'next-manifest' }));
  expect(result).toBeUndefined();
  expect(f.row()).toMatchObject({ op_seq: 2, guide_url: ORIGIN + '/guide.md', manifest_digest: 'next-manifest',
    guide_body: null, guide_digest: null, delivered_digest: null });
});

it('JSON parsing remains inside the callers SQLite transaction and rolls its prior writes back', () => {
  const f = fixture(), before = f.row();
  expect(() => f.db.transaction(tx => {
    tx.execute('UPDATE house_participation SET op_seq=2 WHERE house_origin=?', [ORIGIN]);
    recordJoinedGuide(tx, { origin: ORIGIN, opSeq: 2, rawBytes: new TextEncoder().encode('{invalid'), manifestDigest: 'bad' });
  })).toThrow();
  expect(f.row()).toEqual(before);
  expect(f.db.queryOne<{op_seq:number}>('SELECT op_seq FROM house_participation WHERE house_origin=?', [ORIGIN])?.op_seq).toBe(1);
});

it('observer requires every captured field and a current binding, through actual serialized wrappers', () => {
  const f = fixture();
  f.db.execute(`UPDATE house_guide_context SET guide_body='complete guide',guide_digest='body-digest'`);
  const context = { status: 'available', origin: ORIGIN, opSeq: 1, bindingDigest: guideBindingDigest(f.db, ORIGIN),
    guideDigest: 'body-digest', guide: 'complete guide' };
  const emit = (value: unknown) => markGuidesInAgentInput(f.db, JSON.stringify({content:[{type:'text',text:'joined\n' + JSON.stringify(value)}]}));
  for (const invalid of [{...context, guide: 'complete'}, {...context, opSeq: 2},
    {...context, bindingDigest: 'other'}, {...context, guideDigest: 'other'}, {...context, origin: 'https://other.invalid'}]) {
    emit(invalid); expect(f.row()?.delivered_digest).toBeNull();
  }
  emit(context); expect(f.row()?.delivered_digest).toBe('body-digest');
  f.db.execute('UPDATE house_guide_context SET delivered_digest=NULL');
  f.db.execute('UPDATE house_binding_pin SET revision=revision+1 WHERE origin=?', [ORIGIN]);
  emit(context); expect(f.row()?.delivered_digest).toBeNull();
});

it('observer preserves the depth-eight limit and permits a shallower positive control', () => {
  const f = fixture();
  f.db.execute(`UPDATE house_guide_context SET guide_body='complete guide',guide_digest='body-digest'`);
  const context = { status: 'available', origin: ORIGIN, opSeq: 1, bindingDigest: guideBindingDigest(f.db, ORIGIN),
    guideDigest: 'body-digest', guide: 'complete guide' };
  const nested = (depth: number) => {
    let value: unknown = context;
    for (let i = 0; i < depth; i++) value = { child: value };
    return JSON.stringify(value);
  };
  markGuidesInAgentInput(f.db, nested(8)); expect(f.row()?.delivered_digest).toBeNull();
  markGuidesInAgentInput(f.db, nested(7)); expect(f.row()?.delivered_digest).toBe('body-digest');
});

it('a fresh native input receives its guide even after another conversation acknowledged it', async () => {
  const f = fixture();
  const body = 'Complete source-bound House guide';
  const digest = entryDigest(body);
  f.db.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=?,delivered_digest=?', [body, digest, digest]);
  const read = (origin: string) => readHouseGuideContext(f.db, origin,
    async () => { throw new Error('cached guide must not fetch'); }, () => true);
  expect(await pendingHouseGuides(f.db, read)).toEqual([]);
  // The explicitly observed input is empty. Global historical delivery cannot
  // mean this new conversation (or a compacted input) still contains the guide.
  const pending = await pendingHouseGuides(f.db, read, new Set<string>());
  expect(pending).toHaveLength(1);
  expect(pending[0]?.guide).toBe(body);
});

it('suppresses only the complete current bound guide present in this input', async () => {
  const f = fixture(), body = 'Full guide\nwith source instructions', digest = entryDigest(body);
  f.db.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=?', [body, digest]);
  const read = (origin: string) => readHouseGuideContext(f.db, origin,
    async () => { throw new Error('cached guide must not fetch'); }, () => true);
  const context = await read(ORIGIN);
  if (context.status !== 'available') throw new Error('fixture guide unavailable');
  const wrapped = (value: unknown) => JSON.stringify([{role: 'toolResult', content: [{type: 'text', text: JSON.stringify({house_guide_contexts: [value]})}]}]);
  const present = observedHouseGuideKeys(wrapped(context));
  expect([...present]).toEqual([houseGuideContextKey(context)]);
  expect(await pendingHouseGuides(f.db, read, present)).toEqual([]);
  for (const invalid of [{...context, guide: body.slice(0, 4)}, {...context, guideDigest: 'forged'},
    {...context, bindingDigest: 'stale'}, {...context, opSeq: 2}, {...context, origin: 'https://another.invalid'}]) {
    expect(await pendingHouseGuides(f.db, read, observedHouseGuideKeys(wrapped(invalid)))).toHaveLength(1);
  }
  expect(await pendingHouseGuides(f.db, read, observedHouseGuideKeys('compacted history'))).toHaveLength(1);
  f.db.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=?', ['revised guide', entryDigest('revised guide')]);
  expect(await pendingHouseGuides(f.db, read, present)).toHaveLength(1);
  f.db.execute("UPDATE house_participation SET desired='disabled',phase='disconnected'");
  const inactiveRead = (origin: string) => readHouseGuideContext(f.db, origin, globalThis.fetch, () => false);
  expect(await pendingHouseGuides(f.db, inactiveRead, new Set())).toEqual([]);
});

it('revalidates stale cached guides conditionally and retains a failed refresh for retry', async () => {
  const f = fixture(), body = 'old guide', digest = entryDigest(body);
  f.db.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=?', [body,digest]);
  const requests: RequestInit[] = [];
  let fail = true;
  const fetcher: typeof fetch = async (_url, init) => {
    requests.push(init!);
    return fail ? new Response('offline',{status:503}) : new Response('new guide');
  };
  expect((await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true)).status).toBe('available');
  expect(requests).toHaveLength(1);
  expect(new Headers(requests[0]?.headers).get('if-none-match')).toBe(`"${digest}"`);
  expect(f.row()?.guide_body).toBe(body);
  fail = false;
  await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true);
  expect(f.row()?.guide_body).toBe('new guide');
  await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true);
  expect(requests).toHaveLength(2);
});

it('coalesces concurrent cache fills and handles 304 with and without a cached body', async () => {
  const f=fixture(); let calls=0; let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const fetcher: typeof fetch=async()=>{calls++;await pending;return calls===1?new Response(null,{status:304}):new Response('fresh');};
  const a=readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true), b=readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true);
  release(); await Promise.all([a,b]);
  expect(calls).toBe(2); expect(f.row()?.guide_body).toBe('fresh');
});

it('coalesces duplicate and reordered hints while taking only the GET body as current', async () => {
  const {invalidateHouseGuide}=await import('../../../src/world/house-guide-context.js');
  const f=fixture(); let calls=0;
  const fetcher:typeof fetch=async()=>{calls++;return new Response('current');};
  await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true);
  invalidateHouseGuide(f.db,ORIGIN,entryDigest('current'));
  await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true); expect(calls).toBe(1);
  invalidateHouseGuide(f.db,ORIGIN,entryDigest('older'));
  invalidateHouseGuide(f.db,ORIGIN,entryDigest('older'));
  await Promise.all([readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true),readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true)]);
  expect(calls).toBe(2);expect(f.row()?.guide_body).toBe('current');
});

it.each(['exit','binding','generation','gate'])('fences a pending fetch after %s changes', async change=>{
  const f=fixture();let release!:(response:Response)=>void,active=true;
  const fetched=new Promise<Response>(resolve=>{release=resolve;});
  const pending=readHouseGuideContext(f.db,ORIGIN,async()=>fetched,()=>active);
  if(change==='exit')f.db.execute("UPDATE house_participation SET desired='disabled'");
  if(change==='binding')f.db.execute('UPDATE house_binding_pin SET revision=revision+1');
  if(change==='generation')f.db.execute('UPDATE house_participation SET op_seq=op_seq+1');
  if(change==='gate')active=false;
  release(new Response('must not land'));
  expect((await pending).status).toBe('unavailable');expect(f.row()?.guide_body).toBeNull();
});

it('uses 304 for the current body and revalidates after six hours without repeating normal reads',async()=>{
  const {vi}=await import('vitest');
  const {GUIDE_REVALIDATE_MS}=await import('../../../src/world/house-guide-context.js');
  const f=fixture();let calls=0;
  const fetcher:typeof fetch=async()=>{calls++;return calls===1?new Response('cached'):new Response(null,{status:304});};
  vi.useFakeTimers();try{
    await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true);
    await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true);expect(calls).toBe(1);
    vi.setSystemTime(Date.now()+GUIDE_REVALIDATE_MS);
    expect(await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true)).toMatchObject({status:'available',guide:'cached'});
    expect(calls).toBe(2);
  }finally{vi.useRealTimers();}
});

it('rejects oversized UTF-8 bytes and mismatched cached body digests',async()=>{
  const f=fixture();
  f.db.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=?',['corrupt',entryDigest('different')]);
  const result=await readHouseGuideContext(f.db,ORIGIN,async()=>new Response('中'.repeat(100_000)),()=>true);
  expect(result.status).toBe('unavailable');expect(f.row()?.guide_body).toBe('corrupt');
});

it('repeated stale hints after successful revalidation do not repeatedly fetch the same version',async()=>{
  const {invalidateHouseGuide}=await import('../../../src/world/house-guide-context.js');
  const f=fixture();let calls=0;
  const fetcher:typeof fetch=async()=>{calls++;return new Response('latest');};
  await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true);
  invalidateHouseGuide(f.db,ORIGIN,entryDigest('older'));
  await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true);
  invalidateHouseGuide(f.db,ORIGIN,entryDigest('older'));
  await readHouseGuideContext(f.db,ORIGIN,fetcher,()=>true);
  expect(calls).toBe(2);
});

it('normal MCP access checks already delivered guides when no stream is running',async()=>{
  const f=fixture(),digest=entryDigest('already delivered');
  f.db.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=?,delivered_digest=?',['already delivered',digest,digest]);
  const guides=await pendingHouseGuides(f.db,origin=>readHouseGuideContext(f.db,origin,async()=>new Response('new version'),()=>true));
  expect(guides).toHaveLength(1);expect(guides[0]?.guide).toBe('new version');expect(guides[0]?.delivered).toBe(false);
  expect(f.row()?.delivered_digest).toBe(digest);
});


it.each(['fetch','body'] as const)('retains safe native cache-fill %s diagnostics without persisting a failed body', async phase => {
  const f = fixture();
  const failure = () => new TypeError('SECRET transport auth/body', {cause:new AggregateError([
    Object.assign(new Error('SECRET address'),{code:'ENETUNREACH'})
  ],'SECRET addresses')});
  const result = await readHouseGuideContext(f.db,ORIGIN,async () => {
    if (phase === 'fetch') throw failure();
    return new Response(new ReadableStream({start(c){c.error(failure());}}));
  },()=>true);
  expect(result).toMatchObject({status:'unavailable',failure:{code:'HOUSE_REMOTE_NETWORK',
    diagnostic:{phase,cause:'connection',cancellation:'none',elapsedMs:expect.any(Number)}}});
  expect(JSON.stringify(result)).not.toMatch(/SECRET|ENETUNREACH/);
  expect(f.row()?.guide_body).toBeNull();
});


it('reports a failed historical manifest backfill without changing participation or creating a guide row',async()=>{
  const f=fixture();
  f.db.execute('DELETE FROM house_guide_context');
  const result=await readJoinedHouseGuide(f.db,ORIGIN,{
    gate:{signal:new AbortController().signal,isActive:()=>true},
    fetchManifest:async()=>{throw new TypeError('SECRET manifest',{cause:Object.assign(new Error('SECRET TLS'),{code:'CERT_HAS_EXPIRED'})});},
    prepareBinding:async()=>{throw new Error('must not prepare a missing manifest');},
    documentFetch:()=>async()=>{throw new Error('must not fetch an undeclared guide');},
    active:()=>true,
  });
  expect(result).toMatchObject({status:'unavailable',code:'HOUSE_GUIDE_CONTEXT_STALE',failure:{code:'HOUSE_REMOTE_NETWORK',
    diagnostic:{phase:'before-fetch',cause:'tls',elapsedMs:expect.any(Number),cancellation:'none'}}});
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(f.row()).toBeNull();
  expect(f.db.queryOne<{phase:string}>('SELECT phase FROM house_participation WHERE house_origin=?',[ORIGIN])?.phase).toBe('connected');
});


it('does not attach an old preflight failure after participation changes',async()=>{
  const f=fixture();f.db.execute('DELETE FROM house_guide_context');
  const result=await readJoinedHouseGuide(f.db,ORIGIN,{
    gate:{signal:new AbortController().signal,isActive:()=>true},
    fetchManifest:async()=>{
      f.db.execute("UPDATE house_participation SET op_seq=op_seq+1,phase='disconnected'");
      throw Object.assign(new Error('SECRET old connection'),{code:'ECONNRESET'});
    },
    prepareBinding:async()=>{throw new Error('must not prepare');},
    documentFetch:()=>async()=>{throw new Error('must not fetch');},active:()=>true,
  });
  expect(result).toEqual({status:'unavailable',origin:ORIGIN,code:'HOUSE_GUIDE_CONTEXT_STALE'});
});

it('keeps a shared producer alive for another authorized waiter when its initiating waiter times out', async () => {
  const { withReadCallBudget }=await import('../../../src/runtime/read-call-budget.js');
  const f=fixture();
  let resolve!:(response:Response)=>void;
  const fetch=()=>new Promise<Response>(r=>{resolve=r;});
  const first=withReadCallBudget({timeoutMs:200},()=>readHouseGuideContext(f.db,ORIGIN,fetch,()=>true));
  await new Promise(r=>setTimeout(r,10));
  const second=withReadCallBudget({timeoutMs:1000},()=>readHouseGuideContext(f.db,ORIGIN,fetch,()=>true));
  expect(await first).toMatchObject({status:'unavailable'});
  resolve(new Response('complete shared guide'));
  expect(await second).toMatchObject({status:'available',guide:'complete shared guide'});
});

it('does not write a late guide body after its last waiter is cancelled', async () => {
  const { withReadCallBudget }=await import('../../../src/runtime/read-call-budget.js');
  const f=fixture(); let resolve!:(response:Response)=>void;
  const controller=new AbortController();
  const task=withReadCallBudget({signal:controller.signal},()=>readHouseGuideContext(f.db,ORIGIN,()=>new Promise<Response>(r=>{resolve=r;}),()=>true));
  await new Promise(r=>setTimeout(r,5)); controller.abort();
  await expect(task).rejects.toMatchObject({code:'HOUSE_ACTION_STALE'});
  resolve(new Response('too late'));
  await new Promise(r=>setTimeout(r,5));
  expect(f.row()?.guide_body).toBeNull();
});

it('returns a dated cached guide within the refresh cap when the remote body stalls',async()=>{
  const f=fixture(),body='previous complete guide';
  f.db.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=?',[body,entryDigest(body)]);
  const started=Date.now();
  const result=await readHouseGuideContext(f.db,ORIGIN,async()=>new Response(new ReadableStream({start(){}})),()=>true);
  expect(Date.now()-started).toBeLessThan(4000);
  expect(result).toMatchObject({status:'available',guide:body,freshness:{status:'refresh_failed',fetchedAtMs:null,attemptedAtMs:expect.any(Number),failure:{code:'HOUSE_REMOTE_TIMEOUT'}}});
});

it('rebuilds a joined read under the live waiter gate after the initiating action is revoked',async()=>{
  const {withAction}=await import('../../../src/runtime/house-lifecycle/action-context.js');
  const f=fixture(),a=new AbortController(),b=new AbortController();
  let release!:(response:Response)=>void, callsB=0;
  const first=withAction({signal:a.signal,isActive:()=>!a.signal.aborted},()=>readHouseGuideContext(f.db,ORIGIN,()=>new Promise<Response>(r=>{release=r;}),()=>!a.signal.aborted));
  await new Promise(r=>setTimeout(r,5));
  const second=withAction({signal:b.signal,isActive:()=>true},()=>readHouseGuideContext(f.db,ORIGIN,async()=>{callsB++;return new Response('B authorized guide');},()=>true));
  await new Promise(r=>setTimeout(r,5));a.abort();
  await first;
  expect(await second).toMatchObject({status:'available',guide:'B authorized guide'});
  expect(callsB).toBe(1);
  release(new Response('A late guide'));
  await new Promise(r=>setTimeout(r,5));
  expect(f.row()?.guide_body).toBe('B authorized guide');
});
