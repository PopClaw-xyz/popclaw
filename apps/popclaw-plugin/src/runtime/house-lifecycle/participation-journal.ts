import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../../host/host-db.js';
import type { HouseParticipationPlan, HouseParticipationSource, HouseParticipationReceipt,
  HouseParticipationReceiptQuery, HouseParticipationReceiptResult } from './participation-admission.js';
export function entryDigest(value: unknown): string {
  return cidFromCanonical(new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)));
}
/** Called only by an authorized source, not by reads, config seeding or worker restart. */
export function stageParticipationPlan(db: HostDb, source: HouseParticipationSource,
  facts: Omit<HouseParticipationPlan, keyof HouseParticipationSource | 'version' | 'attemptRef' | 'admissionRequestKey' | 'planDigest'>): HouseParticipationPlan {
  return db.transaction(tx => {
    if (source.reason === 'initial_me_setup') {
      if (!source.eligibilityRef) throw new Error('HOUSE_SETUP_ELIGIBILITY_REQUIRED');
      tx.execute(`INSERT INTO house_initial_setup VALUES (?,?, 'initial_me_setup',?,?, 'pending') ON CONFLICT DO NOTHING`,
        [source.actorId,source.installationId,source.eligibilityRef,source.originalIntentRef]);
      const setup = tx.queryOne<{state:string;eligibility_ref:string;original_intent_ref:string}>(
        `SELECT * FROM house_initial_setup WHERE actor_id=? AND installation_id=? AND purpose='initial_me_setup'`,[source.actorId,source.installationId]);
      if (setup?.state !== 'pending' || setup.eligibility_ref !== source.eligibilityRef || setup.original_intent_ref !== source.originalIntentRef)
        throw new Error('HOUSE_SETUP_ALREADY_RESOLVED');
    }
    const old = tx.queryOne<{plan_json:string;state:string}>(`SELECT plan_json,state FROM house_participation_attempts WHERE original_intent_ref=? AND original_operation_ref=?`,
      [source.originalIntentRef,source.originalOperationRef]);
    if (old) {
      const plan = JSON.parse(old.plan_json) as HouseParticipationPlan;
      const previous = Object.fromEntries(Object.entries(plan).filter(([key]) => !['version','attemptRef','admissionRequestKey','planDigest'].includes(key)));
      if (old.state !== 'prepared' || entryDigest(previous) !== entryDigest({...source,...facts})) throw new Error('HOUSE_ADMISSION_UNRESOLVED');
      return Object.freeze(plan);
    }
    // A different request key cannot hide an unresolved attempt for the same logical intent.
    if (tx.queryOne(`SELECT attempt_ref FROM house_participation_attempts WHERE original_intent_ref=? AND state IN ('prepared','unknown')`,[source.originalIntentRef]))
      throw new Error('HOUSE_ADMISSION_UNRESOLVED');
    const material = {version:1 as const,...source,...facts,attemptRef:crypto.randomUUID(),admissionRequestKey:crypto.randomUUID()};
    const plan = Object.freeze({...material,planDigest:entryDigest(material)});
    tx.execute(`INSERT INTO house_participation_attempts VALUES (?,?,?,?,?,?,'prepared',NULL)`,
      [plan.attemptRef,plan.admissionRequestKey,plan.originalIntentRef,plan.originalOperationRef,plan.planDigest,JSON.stringify(plan)]);
    return plan;
  });
}
export function recordParticipationReceipt(tx: HostDb, plan: HouseParticipationPlan, now: number): HouseParticipationReceipt {
  const receipt: HouseParticipationReceipt = {originalIntentRef:plan.originalIntentRef,originalOperationRef:plan.originalOperationRef,
    attemptRef:plan.attemptRef,planDigest:plan.planDigest,actorId:plan.actorId,installationId:plan.installationId,origin:plan.origin,
    beforeOpSeq:plan.beforeOpSeq,afterOpSeq:plan.afterOpSeq,committedAtMs:now};
  if (plan.reason === 'initial_me_setup') {
    const changed = tx.execute(`UPDATE house_initial_setup SET state='completed' WHERE actor_id=? AND installation_id=? AND original_intent_ref=? AND state='pending'`,
      [plan.actorId,plan.installationId,plan.originalIntentRef]).changes;
    if (changed !== 1) throw new Error('HOUSE_SETUP_ALREADY_RESOLVED');
  }
  if (tx.execute(`UPDATE house_participation_attempts SET state='committed',receipt_json=? WHERE attempt_ref=? AND plan_digest=? AND state='prepared'`,
    [JSON.stringify(receipt),plan.attemptRef,plan.planDigest]).changes !== 1) throw new Error('HOUSE_ADMISSION_ALREADY_RESOLVED');
  return receipt;
}
export function findParticipationReceipt(db: HostDb, query: HouseParticipationReceiptQuery): HouseParticipationReceiptResult {
  try {
    const row = db.queryOne<{receipt_json:string|null}>(`SELECT receipt_json FROM house_participation_attempts WHERE original_intent_ref=? AND original_operation_ref=? AND attempt_ref=? AND plan_digest=?`,
      [query.originalIntentRef,query.originalOperationRef,query.attemptRef,query.planDigest]);
    return row?.receipt_json ? {status:'found',receipt:JSON.parse(row.receipt_json) as HouseParticipationReceipt} : {status:'absent'};
  } catch { return {status:'unavailable'}; }
}
export function cancelInitialSetup(tx: HostDb, actorId: string, installationId: string): void {
  tx.execute(`INSERT INTO house_initial_setup VALUES (?,?, 'initial_me_setup','explicit_leave','explicit_leave','cancelled')
    ON CONFLICT(actor_id,installation_id,purpose) DO UPDATE SET state='cancelled'`,[actorId,installationId]);
}
