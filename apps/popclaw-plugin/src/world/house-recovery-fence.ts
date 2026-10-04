/** Durable, per-origin fence for an explicitly approved House recovery. */
import type { HostDb } from '../host/host-db.js';
export function houseRecoveryHeld(db: HostDb, origin: string): boolean {
  return !!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='house_recovery_fences_v1'")
    && !!db.queryOne("SELECT 1 FROM house_recovery_fences_v1 WHERE origin=? AND state='held'", [origin]);
}
export function recoveredCapabilityBinding(db: HostDb, origin: string, houseKey: string, incarnation: string): boolean {
  return !!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='house_recovery_fences_v1'")
    && !!db.queryOne("SELECT 1 FROM house_recovery_fences_v1 WHERE origin=? AND house_key=? AND new_incarnation=? AND state='complete'", [origin, houseKey, incarnation]);
}
/** Old leave requests are evidence, never current operations after recovery. */
export function recoveryRetiredLeave(db: HostDb, origin: string, seq: number): boolean {
  return !!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='house_recovery_fences_v1'")
    && !!db.queryOne("SELECT 1 FROM house_recovery_fences_v1 WHERE origin=? AND (state='held' OR fence_seq>=?)", [origin, seq]);
}

/** A signed disagreement closes existing session gates across processes too. */
export function houseBindingBlocked(db: HostDb, origin: string): boolean {
  return !!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='house_binding_pin'")
    && !!db.queryOne('SELECT 1 FROM house_binding_pin WHERE origin=? AND blocked_reason IS NOT NULL',[origin]);
}
export interface HouseRecoveryStatus {
  decisionId: string; state: string; detail: string; oldIncarnation: string; newIncarnation: string;
}
export function readHouseRecoveryStatus(db: HostDb, origin: string): HouseRecoveryStatus | undefined {
  if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='house_recovery_fences_v1'")) return undefined;
  const row = db.queryOne<{decision_id:string;state:string;detail:string;old_incarnation:string;new_incarnation:string}>(`
    SELECT f.decision_id,d.state,d.detail,f.old_incarnation,f.new_incarnation FROM house_recovery_fences_v1 f
    JOIN house_recovery_decisions_v1 d USING(decision_id) WHERE f.origin=?`,[origin]);
  return row ? {decisionId:row.decision_id,state:row.state,detail:row.detail,oldIncarnation:row.old_incarnation,newIncarnation:row.new_incarnation}:undefined;
}
