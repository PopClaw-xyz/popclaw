/** Rebuildable connection-local metadata. No original or identity data is changed.
 * TEMP state and its change queue roll back with the caller's SQLite snapshot. */
import type { HostDb, Params } from '../host/host-db.js';
import type { PublicDisplayCapture, PublicDisplayItem, PublicDisplaySource } from './public-feed-display.js';
import type { FrameRow, PublicJournalReadOptions } from './public-journal-reader.js';
import { numberOrZero } from './feed-item-projection.js';

type Result = { items: PublicDisplayItem[]; status: PublicDisplaySource };
type Scan = (control?: { page?: () => FrameRow[]; visit?: (frame: FrameRow, hit: PublicDisplayItem | null) => void }) => Result;
const ROWS = 'popclaw_material_rows', META = 'popclaw_material_meta', DIRTY = 'popclaw_material_dirty';
const MAX_INDEX_FRAMES = 100_000;
const tables = ['frames', 'events', 'associations'] as const;
function temporarySchema(db: HostDb, schemaVersion: number): void {
  db.execute(`CREATE TEMP TABLE IF NOT EXISTS ${META}(binding TEXT NOT NULL,log TEXT NOT NULL,config TEXT NOT NULL,version INTEGER NOT NULL,schema_version INTEGER NOT NULL,invalid INTEGER NOT NULL,observed INTEGER,frame_count INTEGER NOT NULL,PRIMARY KEY(binding,log))`);
  db.execute(`CREATE TEMP TABLE IF NOT EXISTS ${DIRTY}(binding TEXT NOT NULL,log TEXT NOT NULL,seq TEXT NOT NULL,PRIMARY KEY(binding,log,seq))`);
  db.execute(`CREATE TEMP TABLE IF NOT EXISTS ${ROWS}(binding TEXT NOT NULL,log TEXT NOT NULL,seq TEXT NOT NULL,seq_len INTEGER NOT NULL,event_id TEXT NOT NULL,canonical TEXT NOT NULL,material_time INTEGER NOT NULL,PRIMARY KEY(binding,log,seq))`);
  db.execute(`CREATE INDEX IF NOT EXISTS temp.popclaw_material_time ON ${ROWS}(binding,log,material_time)`);
  db.execute(`CREATE INDEX IF NOT EXISTS temp.popclaw_material_latest ON ${ROWS}(binding,log,canonical,seq_len,seq)`);
  if (db.queryOne(`SELECT 1 FROM temp.${META} WHERE schema_version<>? LIMIT 1`, [schemaVersion])) {
    for (const table of tables) for (const op of ['insert','update','delete']) db.execute(`DROP TRIGGER IF EXISTS temp.popclaw_material_${table}_${op}`);
    db.execute(`UPDATE temp.${META} SET invalid=1,schema_version=?`, [schemaVersion]);
  }
  for (const table of tables) {
    const main = `world_public_${table}_v1`;
    const logNew = table === 'events' ? '' : ' AND log=NEW.log_incarnation';
    const logOld = table === 'events' ? '' : ' AND log=OLD.log_incarnation';
    // REPLACE's implicit delete need not fire a delete trigger. Detect an
    // existing event before every insert, rather than trusting delete delivery.
    const conflict = table === 'events' ? `event_id=NEW.event_id` : table === 'frames'
      ? `log_incarnation=NEW.log_incarnation AND (seq=NEW.seq OR event_id=NEW.event_id)`
      : `log_incarnation=NEW.log_incarnation AND lane=NEW.lane AND scope_id=NEW.scope_id AND event_id=NEW.event_id`;
    db.execute(`CREATE TEMP TRIGGER IF NOT EXISTS popclaw_material_${table}_insert BEFORE INSERT ON main.${main} BEGIN
      UPDATE ${META} SET invalid=1 WHERE binding=NEW.binding_id${logNew} AND EXISTS(SELECT 1 FROM ${main} WHERE binding_id=NEW.binding_id AND ${conflict});
      ${table === 'frames' ? `UPDATE ${META} SET frame_count=frame_count+1 WHERE binding=NEW.binding_id AND log=NEW.log_incarnation AND invalid=0;
      UPDATE ${META} SET invalid=2 WHERE (SELECT COALESCE(SUM(frame_count),0) FROM ${META})>${MAX_INDEX_FRAMES};` : ''}
      ${table === 'events' ? '' : `INSERT OR IGNORE INTO ${DIRTY}(binding,log,seq) SELECT NEW.binding_id,NEW.log_incarnation,NEW.seq WHERE EXISTS(SELECT 1 FROM ${META} WHERE binding=NEW.binding_id AND log=NEW.log_incarnation AND invalid=0);`}
      END`);
    for (const op of ['update','delete']) db.execute(`CREATE TEMP TRIGGER IF NOT EXISTS popclaw_material_${table}_${op} AFTER ${op.toUpperCase()} ON main.${main}
      ${table === 'events' && op === 'update' ? 'WHEN OLD.envelope IS NOT NEW.envelope OR OLD.binding_id IS NOT NEW.binding_id OR OLD.event_id IS NOT NEW.event_id' : ''}
      BEGIN UPDATE ${META} SET invalid=1${op === 'update' ? '' : ` WHERE binding=OLD.binding_id${logOld}`}; END`);
  }
}
function through(alias: string, checkpoint: string | null): { sql: string; params: Params } {
  return checkpoint === null ? { sql: '', params: [] } : {
    sql: ` AND (length(${alias}.seq)<? OR (length(${alias}.seq)=? AND ${alias}.seq COLLATE BINARY<=?))`, params: [checkpoint.length,checkpoint.length,checkpoint],
  };
}

export function readMaterialWindow(db: HostDb, capture: PublicDisplayCapture, options: PublicJournalReadOptions, scan: Scan): Result {
  const since = options.materialSince!;
  const shadows = new Set(options.materialShadowEventIds ?? []);
  const filter = (result: Result): Result => ({ ...result, items: result.items.filter(hit => numberOrZero(hit.item.platformPostCreatedAt) >= since || shadows.has(hit.item.eventId!)) });
  // Only fixed frame projections have a reusable per-frame time. Other display
  // modes and explicitly query-only connections retain their existing scan.
  if (!options.completeWindow || !options.ownProjection || options.reference || db.queryOne<{ query_only: number }>('PRAGMA query_only')?.query_only) return filter(scan());
  // This main-db read pins the snapshot before data_version is consulted.
  const base = scan({ page: () => [] });
  const capability = capture.capability, log = capability.publicStream.log_incarnation;
  const binding = JSON.stringify([capability.house.origin,capability.house.houseKey,capability.house.incarnation]);
  const source = db.queryOne<{ selection_json: string; active_log: string; capability_revision: string }>('SELECT selection_json,active_log,capability_revision FROM main.world_public_bindings_v1 WHERE binding_id=?', [binding]);
  if (!source || source.active_log !== log || source.capability_revision !== capability.capabilityRevision) return base;
  const checkpoint = base.status.checkpointHighWater ?? null;
  const version = db.queryOne<{ data_version: number }>('PRAGMA main.data_version')!.data_version;
  const schemaVersion = db.queryOne<{ schema_version: number }>('PRAGMA main.schema_version')!.schema_version;
  temporarySchema(db, schemaVersion);
  for (const old of db.queryAll<{ log: string }>(`SELECT log FROM temp.${META} WHERE binding=? AND log<>?`, [binding,log])) {
    for (const table of [ROWS,DIRTY,META]) db.execute(`DELETE FROM temp.${table} WHERE binding=? AND log=?`, [binding,old.log]);
  }
  const config = JSON.stringify([capability.capabilityRevision,capture.producerPolicy,source.selection_json]);
  const meta = db.queryOne<{ config: string; version: number; invalid: number; observed: number | null }>(`SELECT * FROM temp.${META} WHERE binding=? AND log=?`, [binding,log]);
  const visited = (frame: FrameRow, hit: PublicDisplayItem | null) => {
    if (hit) db.execute(`INSERT OR REPLACE INTO temp.${ROWS}(binding,log,seq,seq_len,event_id,canonical,material_time) VALUES(?,?,?,?,?,?,?)`,
      [binding,log,frame.seq,frame.seq.length,frame.event_id,JSON.stringify([hit.item.platform,hit.item.platformPostId]),numberOrZero(hit.item.platformPostCreatedAt)]);
    db.execute(`DELETE FROM temp.${DIRTY} WHERE binding=? AND log=? AND seq=?`, [binding,log,frame.seq]);
  };
  if (!meta || meta.invalid || meta.version !== version || meta.config !== config) {
    db.execute(`DELETE FROM temp.${ROWS} WHERE binding=? AND log=?`, [binding,log]);
    db.execute(`DELETE FROM temp.${DIRTY} WHERE binding=? AND log=?`, [binding,log]);
    db.execute(`DELETE FROM temp.${META} WHERE binding=? AND log=?`, [binding,log]);
    // Internal cache capacity never truncates material. This bounded metadata
    // probe runs only at rebuild, not on the normal warm path.
    if (db.queryOne('SELECT seq FROM main.world_public_frames_v1 WHERE binding_id=? AND log_incarnation=? LIMIT 1 OFFSET ?', [binding,log,MAX_INDEX_FRAMES])) {
      return filter(scan());
    }
    // Include existing frames beyond the current checkpoint in the pending
    // queue: a later checkpoint must admit them without rescanning history.
    const count = db.execute(`INSERT INTO temp.${DIRTY}(binding,log,seq) SELECT binding_id,log_incarnation,seq FROM main.world_public_frames_v1 WHERE binding_id=? AND log_incarnation=?`, [binding,log]).changes;
    const used = db.queryOne<{ n: number }>(`SELECT COALESCE(SUM(frame_count),0) AS n FROM temp.${META}`)!.n;
    if (used + count > MAX_INDEX_FRAMES) {
      db.execute(`DELETE FROM temp.${DIRTY} WHERE binding=? AND log=?`, [binding,log]);
      return filter(scan());
    }
    const result = scan({ visit: visited });
    if (!result.status.truncated) db.execute(`INSERT OR REPLACE INTO temp.${META}(binding,log,config,version,schema_version,invalid,observed,frame_count) VALUES(?,?,?,?,?,0,?,?)`, [binding,log,config,version,schemaVersion,result.status.observedAt,count]);
    return filter(result);
  }
  const bound = through('d', checkpoint);
  const changed = scan({
    page: () => db.queryAll<FrameRow>(`SELECT f.seq,f.event_id,f.frame_bytes,f.observed_at,e.envelope,e.current_projection,e.projection_log,e.projection_seq
      FROM temp.${DIRTY} d CROSS JOIN main.world_public_frames_v1 f CROSS JOIN main.world_public_events_v1 e
      WHERE d.binding=? AND d.log=?${bound.sql}
      AND f.binding_id=d.binding AND f.log_incarnation=d.log AND f.seq=d.seq AND e.binding_id=f.binding_id AND e.event_id=f.event_id
      ORDER BY length(d.seq) DESC,d.seq COLLATE BINARY DESC LIMIT 32`, [binding,log,...bound.params]),
    visit: visited,
  });
  const observed = meta.observed === null ? changed.status.observedAt : Math.max(meta.observed,changed.status.observedAt ?? 0);
  db.execute(`UPDATE temp.${META} SET observed=? WHERE binding=? AND log=?`, [observed,binding,log]);
  const currentBound = through('m',checkpoint), newerBound = through('n',checkpoint);
  // Sort only small metadata once. Per-page range queries would repeatedly
  // visit and sort the same window even when no new events had arrived.
  const candidates = db.queryAll<{ seq: string; event_id: string }>(`SELECT m.seq,m.event_id FROM temp.${ROWS} m INDEXED BY popclaw_material_time
      WHERE m.binding=? AND m.log=? AND m.material_time>=?${currentBound.sql}
      AND NOT EXISTS(SELECT 1 FROM temp.${ROWS} n WHERE n.binding=m.binding AND n.log=m.log AND n.canonical=m.canonical${newerBound.sql}
        AND (n.seq_len>m.seq_len OR (n.seq_len=m.seq_len AND n.seq COLLATE BINARY>m.seq)))
      ORDER BY m.seq_len DESC,m.seq COLLATE BINARY DESC`, [binding,log,since,...currentBound.params,...newerBound.params]);
  const ids = [...shadows];
  for (let i=0;i<ids.length;i+=32) {
    const wanted = ids.slice(i,i+32);
    candidates.push(...db.queryAll<{seq:string;event_id:string}>(`WITH wanted(event_id) AS (VALUES ${wanted.map(()=>'(?)').join(',')})
      SELECT m.seq,m.event_id FROM wanted CROSS JOIN main.world_public_frames_v1 f CROSS JOIN temp.${ROWS} m
      WHERE f.binding_id=? AND f.log_incarnation=? AND f.event_id=wanted.event_id
      AND m.binding=f.binding_id AND m.log=f.log_incarnation AND m.seq=f.seq AND m.event_id=f.event_id${currentBound.sql}
      AND m.material_time<? AND NOT EXISTS(SELECT 1 FROM temp.${ROWS} n WHERE n.binding=m.binding AND n.log=m.log AND n.canonical=m.canonical${newerBound.sql}
        AND (n.seq_len>m.seq_len OR (n.seq_len=m.seq_len AND n.seq COLLATE BINARY>m.seq)))`, [...wanted,binding,log,...currentBound.params,since,...newerBound.params]));
  }
  if (ids.length) candidates.sort((a,b)=>a.seq.length===b.seq.length ? b.seq.localeCompare(a.seq) : b.seq.length-a.seq.length);
  let offset = 0;
  const result = scan({ page: () => {
    const page = candidates.slice(offset,offset += 32);
    if (!page.length) return [];
    return db.queryAll<FrameRow>(`WITH wanted(seq,event_id) AS (VALUES ${page.map(() => '(?,?)').join(',')})
      SELECT f.seq,f.event_id,f.frame_bytes,f.observed_at,e.envelope,e.current_projection,e.projection_log,e.projection_seq
      FROM wanted CROSS JOIN main.world_public_frames_v1 f CROSS JOIN main.world_public_events_v1 e
      WHERE f.binding_id=? AND f.log_incarnation=? AND f.seq=wanted.seq AND f.event_id=wanted.event_id
      AND e.binding_id=f.binding_id AND e.event_id=f.event_id ORDER BY length(f.seq) DESC,f.seq COLLATE BINARY DESC`,
      [...page.flatMap(row => [row.seq,row.event_id]),binding,log]);
  } });
  return { ...result, status: { ...result.status, observedAt: observed } };
}
