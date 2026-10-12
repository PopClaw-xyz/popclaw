import { assertReadCallActive, budgetedFetch, waitForRead, withReadCallBudget, currentReadCallBudget, withSharedReadProducer } from '../runtime/read-call-budget.js';
import type { ReadFreshness } from './read-freshness.js';
/** Source-bound House business knowledge; reading or emitting it grants no action. */
import { RemoteHouseReadError, type HouseReadFailure, type HouseReadDiagnostic } from '../runtime/house-lifecycle/read-failure.js';
import { currentActionSignal } from '../runtime/house-lifecycle/action-context.js';
import { remoteReadFailure } from './house-read-diagnostic.js';
import type { SessionManifest } from '../runtime/house-lifecycle/control-client.js';
import type { HostDb } from '../host/host-db.js';
import { entryDigest } from '../runtime/house-lifecycle/participation-journal.js';
import { readParticipation } from '../runtime/house-lifecycle/participation-store.js';
import { pinnedBinding } from './house-binding-pin.js';
import { parseGuideFrontmatter } from './guide.js';
export interface HouseGuideContext {
  readonly status: 'available'; readonly origin: string; readonly bindingDigest: string; readonly opSeq: number;
  readonly guideUrl: string; readonly guideDigest: string; readonly guide: string;
  readonly entry?: unknown; readonly delivered: boolean; readonly freshness?: ReadFreshness;
}
export type HouseGuideResult = HouseGuideContext | {readonly status:'unavailable';readonly code:string;readonly origin:string;readonly failure?:HouseReadFailure};
interface Row {origin:string;binding_digest:string;op_seq:number;guide_url:string;manifest_digest:string;guide_digest:string|null;guide_body:string|null;delivered_digest:string|null}
export function guideBindingDigest(db:HostDb,origin:string): string {
  const b = pinnedBinding(db,origin);
  return entryDigest(b ? {origin:b.origin,houseKey:b.houseKey,incarnation:b.incarnation,revision:b.revision,blockedReason:b.blockedReason} : null);
}
export const GUIDE_REVALIDATE_MS = 6 * 60 * 60 * 1000;
const GUIDE_MAX_BYTES = 256 * 1024;
type RefreshState = { identity: string; checkedAt: number; fetchedAt?:number; dirty: boolean; revision: number; hint?: string; attemptedAt?: number; failure?: HouseReadFailure; pending?: Promise<void>; waiters:Set<() => boolean>; abort?:AbortController };
const refreshStates = new WeakMap<HostDb, Map<string, RefreshState>>();
function refreshState(db: HostDb, row: Row): RefreshState {
  let states = refreshStates.get(db);
  if (!states) { states = new Map(); refreshStates.set(db, states); }
  const identity = JSON.stringify([row.binding_digest,row.op_seq,row.guide_url,row.manifest_digest]);
  let state = states.get(row.origin);
  if (!state || state.identity !== identity) {
    state = {identity,checkedAt:0,dirty:true,revision:0,waiters:new Set()}; states.set(row.origin,state);
  }
  return state;
}
/** A digest is only an invalidation hint. It cannot change a URL, trust or authority. */
export function invalidateHouseGuide(db: HostDb, origin: string, digest?: string): void {
  if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) return;
  const row = db.queryOne<Row>('SELECT * FROM house_guide_context WHERE origin=?',[origin]);
  if (!row) return;
  const state = refreshState(db,row);
  if (digest !== undefined && (digest === row.guide_digest || digest === state.hint)) return;
  state.hint = digest;
  state.dirty = true; state.revision++;
}
function currentGuideRow(db: HostDb, origin: string, active: () => boolean): Row | null {
  if (!active()) return null;
  const row = db.queryOne<Row>('SELECT * FROM house_guide_context WHERE origin=?',[origin]);
  const participation = readParticipation(db,origin);
  return row && participation?.desired === 'enabled' && participation.phase === 'connected'
    && participation.op_seq === row.op_seq && guideBindingDigest(db,origin) === row.binding_digest ? row : null;
}
/** Local-only lookup for model-input hooks. Never fetches or changes receipts. */
export function cachedHouseGuide(db: HostDb, origin: string, active: () => boolean): HouseGuideResult {
  const row = currentGuideRow(db,origin,active);
  if (!row) return {status:'unavailable',origin,code:'HOUSE_GUIDE_CONTEXT_STALE'};
  if (!row.guide_url || !row.guide_body || !row.guide_digest || entryDigest(row.guide_body) !== row.guide_digest)
    return {status:'unavailable',origin,code:'HOUSE_GUIDE_NOT_CACHED'};
  const state = refreshState(db,row);
  const freshness: ReadFreshness = {status:state.failure ? 'refresh_failed' : state.dirty || Date.now()-state.checkedAt >= GUIDE_REVALIDATE_MS ? 'stale' : 'fresh',origin,
    fetchedAtMs:state.fetchedAt ?? null,checkedAtMs:state.checkedAt || null,attemptedAtMs:state.attemptedAt ?? null,...(state.failure ? {failure:state.failure} : {})};
  return Object.freeze({freshness,status:'available',origin,bindingDigest:row.binding_digest,opSeq:row.op_seq,guideUrl:row.guide_url,
    guideDigest:row.guide_digest,guide:row.guide_body,entry:parseGuideFrontmatter(row.guide_body).frontmatter?.entry,
    delivered:row.delivered_digest === row.guide_digest});
}
/** Read a bounded complete UTF-8 body. Digest strings use raw UTF-8 SHA-256,
 * matching the House ETag; object entryDigest callers serialize JSON instead. */
export async function readBoundedGuide(response: Response): Promise<string> {
  if (!response.body) throw new Error('HOUSE_GUIDE_EMPTY');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8',{fatal:true});
  let bytes = 0, body = '';
  try {
    while (true) {
      const chunk = await waitForRead(reader.read());
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > GUIDE_MAX_BYTES) throw new Error('HOUSE_GUIDE_TOO_LARGE');
      body += decoder.decode(chunk.value,{stream:true});
    }
    body += decoder.decode();
    if (!body.trim()) throw new Error('HOUSE_GUIDE_EMPTY');
    return body;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function readHouseGuideContext(db: HostDb, origin: string, fetchDocument: typeof globalThis.fetch,
  active: () => boolean): Promise<HouseGuideResult> {
  const cached=cachedHouseGuide(db,origin,active);
  const remaining=currentReadCallBudget()?.remainingMs() ?? 10_000;
  try {
    return await withReadCallBudget({timeoutMs:cached.status === 'available' ? Math.min(1500,Math.max(0,remaining-50)) : Math.max(0,remaining-50)},
      () => refreshHouseGuideContext(db,origin,fetchDocument,active));
  } catch(error) {
    const failure=remoteReadFailure(error,origin,{phase:'delegate'});
    if (!failure.code.startsWith('HOUSE_REMOTE_')) return {status:'unavailable',origin,code:'HOUSE_GUIDE_FETCH_FAILED',failure};
    const result=cachedHouseGuide(db,origin,active);
    if (result.status === 'available') return {...result,freshness:{...result.freshness!,status:'refresh_failed',attemptedAtMs:Date.now(),failure:remoteReadFailure(error,origin,{phase:'delegate'})}};
    return {status:'unavailable',origin,code:'HOUSE_GUIDE_FETCH_FAILED',failure:remoteReadFailure(error,origin,{phase:'delegate'})};
  }
}
async function refreshHouseGuideContext(db: HostDb, origin: string, fetchDocument: typeof globalThis.fetch,
  active: () => boolean): Promise<HouseGuideResult> {
  const row = currentGuideRow(db,origin,active);
  if (!row) return {status:'unavailable',origin,code:'HOUSE_GUIDE_CONTEXT_STALE'};
  if (!row.guide_url) return {status:'unavailable',origin,code:'HOUSE_GUIDE_NOT_DECLARED'};
  const state = refreshState(db,row), waiting=currentReadCallBudget();
  const waiter=() => { try { waiting?.assertActive(); return active(); } catch { return false; } };
  state.waiters.add(waiter);
  const release=() => {
    state.waiters.delete(waiter);
    if (![...state.waiters].some(check=>check())) state.abort?.abort();
  };
  waiting?.signal.addEventListener('abort',release,{once:true});
  const current = () => {
    assertReadCallActive();
    const latest = currentGuideRow(db,origin,active);
    return latest !== null && refreshState(db,latest) === state && [...state.waiters].some(check=>check());
  };
  if (!state.pending && (state.dirty || Date.now()-state.checkedAt >= GUIDE_REVALIDATE_MS || !row.guide_body)) {
    const revision = state.revision; state.attemptedAt = Date.now();
    const startedAt = performance.now(), actionSignal = currentActionSignal();
    let phase: HouseReadDiagnostic['phase'] = 'before-fetch';
    let deadline: AbortSignal | undefined;
    const abort=new AbortController(); state.abort=abort;
    const failed=(error:unknown) => { state.dirty=true; state.failure=remoteReadFailure(error,origin,{phase,deadline,timeoutMs:10_000,startedAt,actionSignal}); };
    state.pending = withSharedReadProducer(abort.signal,async () => {
      try {
        const cached = row.guide_body && row.guide_digest === entryDigest(row.guide_body);
        const request = (conditional: boolean) => {
          phase = 'fetch'; deadline = AbortSignal.timeout(10_000);
          return budgetedFetch(fetchDocument)(row.guide_url,{method:'GET',redirect:'error',signal:deadline,
            headers:conditional ? {'If-None-Match':`"${row.guide_digest}"`} : {}});
        };
        let response = await request(!!cached);
        if (response.status === 304 && !cached) response = await request(false);
        if (response.status === 304 && cached) {
          if (!current()) return;
        } else {
          if (!response.ok) { await response.body?.cancel(); throw new RemoteHouseReadError({code:'HOUSE_REMOTE_HTTP',origin,status:response.status}); }
          phase = 'body';
          const body = await readBoundedGuide(response), digest = entryDigest(body);
          if (!current()) return;
          db.transaction(tx => {
            if (!current()) throw new Error('HOUSE_GUIDE_CONTEXT_STALE');
            tx.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=? WHERE origin=? AND op_seq=? AND binding_digest=?',
              [body,digest,origin,row.op_seq,row.binding_digest]);
          });
        }
        const latestDigest = db.queryOne<Row>('SELECT * FROM house_guide_context WHERE origin=?',[origin])?.guide_digest;
        if (response.status !== 304) state.fetchedAt=Date.now();
        state.checkedAt = Date.now(); state.failure = undefined;
        state.dirty = state.revision !== revision && state.hint !== latestDigest;
      } catch (error) {
        failed(error);
        // Preserve the last complete body and pending invalidation.
      }
    }).catch(failed).finally(() => { state.pending = undefined; state.abort=undefined; });
  }
  try {
  if (state.pending) await waitForRead(state.pending);
  const result = cachedHouseGuide(db,origin,active);
  return result.status === 'unavailable' && result.code === 'HOUSE_GUIDE_NOT_CACHED' && state.failure
    ? {...result,code:'HOUSE_GUIDE_FETCH_FAILED',failure:state.failure} : result;
  } finally { waiting?.signal.removeEventListener('abort',release); release(); }
}
/** Existing resident cadence only revalidates initialized caches. Historical
 * pointer backfill remains a foreground read; failures cannot become 1s polling. */
export function houseGuideBackgroundDue(db: HostDb, origin: string): boolean {
  const row = db.queryOne<Row>('SELECT * FROM house_guide_context WHERE origin=?',[origin]);
  if (!row?.guide_body || !row.guide_digest) return false;
  const state = refreshState(db,row);
  if (state.pending || state.failure && state.attemptedAt !== undefined && Date.now()-state.attemptedAt < 60_000) return false;
  return state.dirty || Date.now()-state.checkedAt >= GUIDE_REVALIDATE_MS;
}
/** Call only after the host actually emitted this exact bound context. */
export function markHouseGuideDelivered(db:HostDb, context:HouseGuideContext): boolean {
  return db.transaction(tx => {
    const participation = readParticipation(tx,context.origin);
    if (participation?.desired !== 'enabled' || participation.phase !== 'connected' || participation.op_seq !== context.opSeq
      || guideBindingDigest(tx,context.origin) !== context.bindingDigest) return false;
    return tx.execute(`UPDATE house_guide_context SET delivered_digest=? WHERE origin=? AND op_seq=? AND binding_digest=? AND guide_digest=?`,
      [context.guideDigest,context.origin,context.opSeq,context.bindingDigest,context.guideDigest]).changes === 1;
  });
}

/** The runtime captures the read gate once. Transport factories are called at
 * their original stages; this module never captures join or action authority. */
export interface HouseGuideReadPorts {
  readonly gate: { readonly signal: AbortSignal; isActive(): boolean };
  fetchManifest(): Promise<SessionManifest>;
  prepareBinding(manifest: SessionManifest): Promise<{ commit(tx: HostDb): string | undefined }>;
  documentFetch(): typeof globalThis.fetch;
  active(): boolean;
}

function declaredGuideUrl(origin: string, rawBytes: Uint8Array): string {
  const doc = JSON.parse(new TextDecoder().decode(rawBytes)) as {guide_url?: unknown};
  const url = typeof doc.guide_url === 'string' ? new URL(doc.guide_url, origin) : undefined;
  return url && ['http:', 'https:'].includes(url.protocol) ? url.href : '';
}

/** Synchronous inside the caller's join transaction, before its receipt.
 * A new participation replaces the pointer and invalidates old body/delivery. */
export function recordJoinedGuide(tx: HostDb, input: {
  readonly origin: string; readonly opSeq: number; readonly rawBytes: Uint8Array; readonly manifestDigest: string;
}): void {
  const guideUrl = declaredGuideUrl(input.origin, input.rawBytes);
  const binding = pinnedBinding(tx, input.origin);
  if (!binding) throw new Error('HOUSE_BINDING_UNAVAILABLE');
  tx.execute(`INSERT INTO house_guide_context (origin,binding_digest,op_seq,guide_url,manifest_digest)
    VALUES (?,?,?,?,?) ON CONFLICT(origin) DO UPDATE SET binding_digest=excluded.binding_digest,op_seq=excluded.op_seq,
    guide_url=excluded.guide_url,manifest_digest=excluded.manifest_digest,guide_digest=NULL,guide_body=NULL,delivered_digest=NULL`,
    [input.origin,guideBindingDigest(tx,input.origin),input.opSeq,guideUrl,input.manifestDigest]);
}

/** Read an already joined House, including historical pointer backfill.
 * Backfill only inserts missing rows; it is not a join or a first-trust path. */
export async function readJoinedHouseGuide(db: HostDb, origin: string, ports: HouseGuideReadPorts): Promise<HouseGuideResult> {
  const gate = ports.gate;
  const startedAt = performance.now(), actionSignal = currentActionSignal();
  let backfillFailure: HouseReadFailure | undefined;
  let backfillCurrent = () => false;
  // Existing joined Houses may predate the journal. Refresh their verified
  // declared pointer without creating a join or first trust.
  if (gate.isActive() && !db.queryOne('SELECT origin FROM house_guide_context WHERE origin=?',[origin])) {
    const row = readParticipation(db,origin), binding = pinnedBinding(db,origin);
    if (row && binding) try {
      backfillCurrent = () => gate.isActive()
        && JSON.stringify(readParticipation(db,origin)) === JSON.stringify(row)
        && JSON.stringify(pinnedBinding(db,origin)) === JSON.stringify(binding);
      assertReadCallActive();
      const manifest = await waitForRead(ports.fetchManifest());
      assertReadCallActive();
      const prepared = await waitForRead(ports.prepareBinding(manifest));
      assertReadCallActive();
      const concurrent = db.transaction(tx => {
        if (!gate.isActive() || JSON.stringify(readParticipation(tx,origin)) !== JSON.stringify(row)) throw new Error('HOUSE_GUIDE_CONTEXT_STALE');
        const refusal = prepared.commit(tx);
        if (refusal) return;
        const guideUrl = declaredGuideUrl(origin, manifest.rawBytes);
        return tx.execute(`INSERT INTO house_guide_context(origin,binding_digest,op_seq,guide_url,manifest_digest) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`,
          [origin,guideBindingDigest(tx,origin),row.op_seq,guideUrl,entryDigest(Buffer.from(manifest.rawBytes).toString('base64'))]).changes === 0;
      });
      if (concurrent) {
        const cached = cachedHouseGuide(db,origin,ports.active);
        if (cached.status === 'available') return cached;
      }
    } catch (error) {
      // Joined status remains separate from guide availability. Retain only a
      // safe observation of the pre-guide manifest/binding stage.
      backfillFailure = remoteReadFailure(error,origin,{phase:'before-fetch',startedAt,actionSignal});
    }
  }
  const result = await readHouseGuideContext(db,origin,ports.documentFetch(),ports.active);
  return result.status === 'unavailable' && !result.failure && backfillFailure && backfillCurrent()
    ? {...result,failure:backfillFailure} : result;
}

/** Identity of complete source-bound knowledge, never action authority. */
export function houseGuideContextKey(context: Pick<HouseGuideContext, 'origin' | 'bindingDigest' | 'opSeq' | 'guideDigest' | 'guide'>): string {
  return JSON.stringify([context.origin, context.bindingDigest, context.opSeq, context.guideDigest, entryDigest(context.guide)]);
}

function visitGuideContexts(serialized: unknown, visit: (context: Record<string, unknown>) => void): void {
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      for (const text of [value, ...value.split('\n')]) {
        if (!text.startsWith('{') && !text.startsWith('[')) continue;
        try { inspect(JSON.parse(text), depth + 1); } catch { /* Ordinary reply text. */ }
      }
    } else if (value && typeof value === 'object') {
      const context = value as Record<string, unknown>;
      visit(context);
      for (const child of Object.values(context)) inspect(child, depth + 1);
    }
  };
  inspect(serialized, 0);
}

/** Extract only complete guide identities from the actual input. No history is retained.
 * A claimed digest without its matching body is not proof of presence. */
export function observedHouseGuideKeys(serialized: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  visitGuideContexts(serialized, context => {
    if (context.status !== 'available' || typeof context.origin !== 'string'
      || typeof context.bindingDigest !== 'string' || !Number.isSafeInteger(context.opSeq)
      || typeof context.guideDigest !== 'string' || typeof context.guide !== 'string'
      || !context.guide || context.guide.length > 256 * 1024 || entryDigest(context.guide) !== context.guideDigest) return;
    keys.add(houseGuideContextKey(context as unknown as HouseGuideContext));
  });
  return keys;
}

/** Native callers supply the current input's presence set, including an empty
 * set for an unknown/new context. Other hosts keep their delivery receipts. */
export async function pendingHouseGuides(db: HostDb, readGuide: (origin: string) => Promise<HouseGuideResult>,
  present?: ReadonlySet<string>): Promise<HouseGuideContext[]> {
  const result: HouseGuideContext[] = [];
  // Even an acknowledged version can become stale while no resident stream runs.
  const query = 'SELECT origin FROM house_guide_context';
  for (const {origin} of db.queryAll<{origin:string}>(query)) {
    const context = await readGuide(origin);
    if (context.status === 'available' && (present === undefined ? !context.delivered : !present.has(houseGuideContextKey(context)))) result.push(context);
  }
  return result;
}

/** Actual host output/LLM-input observer; never claim a prepared or truncated body was delivered. */
export function markGuidesInAgentInput(db: HostDb, serialized: string): void {
  const rows = db.queryAll<{origin:string;guide_body:string;guide_digest:string;binding_digest:string;op_seq:number}>(
    `SELECT * FROM house_guide_context WHERE guide_body IS NOT NULL AND (delivered_digest IS NULL OR delivered_digest!=guide_digest)`);
  visitGuideContexts(serialized, context => {
    for (const row of rows) {
      if (context.status !== 'available' || context.origin !== row.origin || context.opSeq !== row.op_seq
        || context.guide !== row.guide_body || context.guideDigest !== row.guide_digest
        || context.bindingDigest !== row.binding_digest) continue;
      markHouseGuideDelivered(db,{status:'available',origin:row.origin,bindingDigest:row.binding_digest,opSeq:row.op_seq,
        guideUrl:'',guideDigest:row.guide_digest,guide:row.guide_body,delivered:false});
    }
  });
}
