/** Source-bound House business knowledge; reading or emitting it grants no action. */
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
