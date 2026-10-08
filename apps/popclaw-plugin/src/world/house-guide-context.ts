/** Source-bound House business knowledge; reading or emitting it grants no action. */
import type { SessionManifest } from '../runtime/house-lifecycle/control-client.js';
import type { HostDb } from '../host/host-db.js';
import { entryDigest } from '../runtime/house-lifecycle/participation-journal.js';
import { readParticipation } from '../runtime/house-lifecycle/participation-store.js';
import { pinnedBinding } from './house-binding-pin.js';
import { parseGuideFrontmatter } from './guide.js';
export interface HouseGuideContext {
  readonly status: 'available'; readonly origin: string; readonly bindingDigest: string; readonly opSeq: number;
  readonly guideUrl: string; readonly guideDigest: string; readonly guide: string;
  readonly entry?: unknown; readonly delivered: boolean;
}
export type HouseGuideResult = HouseGuideContext | {readonly status:'unavailable';readonly code:string;readonly origin:string};
interface Row {origin:string;binding_digest:string;op_seq:number;guide_url:string;manifest_digest:string;guide_digest:string|null;guide_body:string|null;delivered_digest:string|null}
export function guideBindingDigest(db:HostDb,origin:string): string {
  const b = pinnedBinding(db,origin);
  return entryDigest(b ? {origin:b.origin,houseKey:b.houseKey,incarnation:b.incarnation,revision:b.revision,blockedReason:b.blockedReason} : null);
}
export async function readHouseGuideContext(db: HostDb, origin: string, fetchDocument: typeof globalThis.fetch,
  active: () => boolean): Promise<HouseGuideResult> {
  const unavailable = (code:string):HouseGuideResult => ({status:'unavailable',origin,code});
  const row = db.queryOne<Row>('SELECT * FROM house_guide_context WHERE origin=?',[origin]);
  const current = () => active() && row !== null && readParticipation(db,origin)?.op_seq === row.op_seq && guideBindingDigest(db,origin) === row.binding_digest;
  if (!row || !current()) return unavailable('HOUSE_GUIDE_CONTEXT_STALE');
  if (!row.guide_url) return unavailable('HOUSE_GUIDE_NOT_DECLARED');
  let body = row.guide_body, digest = row.guide_digest;
  if (!body || !digest) {
    try {
      const response = await fetchDocument(row.guide_url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15_000)});
      if (!response.ok) return unavailable('HOUSE_GUIDE_FETCH_FAILED');
      const text = await response.text();
      if (text.length > 256*1024) return unavailable('HOUSE_GUIDE_TOO_LARGE');
      if (!text.trim() || !current()) return unavailable('HOUSE_GUIDE_CONTEXT_STALE');
      body = text; digest = entryDigest(body);
      db.transaction(tx => {
        if (!current()) throw new Error('HOUSE_GUIDE_CONTEXT_STALE');
        tx.execute('UPDATE house_guide_context SET guide_body=?,guide_digest=? WHERE origin=? AND op_seq=? AND binding_digest=?',
          [body,digest,origin,row.op_seq,row.binding_digest]);
      });
    } catch { return unavailable('HOUSE_GUIDE_FETCH_FAILED'); }
  }
  if (!current()) return unavailable('HOUSE_GUIDE_CONTEXT_STALE');
  return Object.freeze({status:'available',origin,bindingDigest:row.binding_digest,opSeq:row.op_seq,guideUrl:row.guide_url,guideDigest:digest,
    guide:body,entry:parseGuideFrontmatter(body).frontmatter?.entry,delivered:row.delivered_digest === digest});
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
  // Existing joined Houses may predate the journal. Refresh their verified
  // declared pointer without creating a join or first trust.
  if (gate.isActive() && !db.queryOne('SELECT origin FROM house_guide_context WHERE origin=?',[origin])) {
    const row = readParticipation(db,origin), binding = pinnedBinding(db,origin);
    if (row && binding) try {
      const manifest = await ports.fetchManifest();
      const prepared = await ports.prepareBinding(manifest);
      db.transaction(tx => {
        if (!gate.isActive() || JSON.stringify(readParticipation(tx,origin)) !== JSON.stringify(row)) throw new Error('HOUSE_GUIDE_CONTEXT_STALE');
        const refusal = prepared.commit(tx);
        if (refusal) return;
        const guideUrl = declaredGuideUrl(origin, manifest.rawBytes);
        tx.execute(`INSERT INTO house_guide_context(origin,binding_digest,op_seq,guide_url,manifest_digest) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`,
          [origin,guideBindingDigest(tx,origin),row.op_seq,guideUrl,entryDigest(Buffer.from(manifest.rawBytes).toString('base64'))]);
      });
    } catch { /* Joined status remains separate from guide availability. */ }
  }
  return readHouseGuideContext(db,origin,ports.documentFetch(),ports.active);
}

export async function pendingHouseGuides(db: HostDb, readGuide: (origin: string) => Promise<HouseGuideResult>): Promise<HouseGuideContext[]> {
  const result: HouseGuideContext[] = [];
  for (const {origin} of db.queryAll<{origin:string}>(`SELECT origin FROM house_guide_context WHERE delivered_digest IS NULL OR delivered_digest!=guide_digest`)) {
    const context = await readGuide(origin);
    if (context.status === 'available' && !context.delivered) result.push(context);
  }
  return result;
}

/** Actual host output/LLM-input observer; never claim a prepared or truncated body was delivered. */
export function markGuidesInAgentInput(db: HostDb, serialized: string): void {
  const rows = db.queryAll<{origin:string;guide_body:string;guide_digest:string;binding_digest:string;op_seq:number}>(
    `SELECT * FROM house_guide_context WHERE guide_body IS NOT NULL AND (delivered_digest IS NULL OR delivered_digest!=guide_digest)`);
  // MCP serializes JSON context inside a text result; native history wraps
  // the same text in messages. Inspect those actual emitted values.
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      for (const text of [value, ...value.split('\n')]) {
        if (!text.startsWith('{') && !text.startsWith('[')) continue;
        try { inspect(JSON.parse(text), depth + 1); } catch { /* Ordinary reply text. */ }
      }
    } else if (value && typeof value === 'object') {
      const context = value as Record<string, unknown>;
      for (const row of rows) {
        if (context.status !== 'available' || context.origin !== row.origin || context.opSeq !== row.op_seq
          || context.guide !== row.guide_body || context.guideDigest !== row.guide_digest
          || context.bindingDigest !== row.binding_digest) continue;
        markHouseGuideDelivered(db,{status:'available',origin:row.origin,bindingDigest:row.binding_digest,opSeq:row.op_seq,
          guideUrl:'',guideDigest:row.guide_digest,guide:row.guide_body,delivered:false});
      }
      for (const child of Object.values(context)) inspect(child, depth + 1);
    }
  };
  inspect(serialized, 0);
}
