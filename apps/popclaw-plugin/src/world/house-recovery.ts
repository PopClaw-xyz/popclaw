import { ensureHouseRecoverySchema } from '../host/runtime-storage-schema.js';
/** Same-origin, same-key recovery. The host approval is consumed here, never a
 * model-supplied boolean. Preparation has no authority; cutover never logs in. */
import bs58 from 'bs58';
import type { HostDb } from '../host/host-db.js';
import { consumeOwnerApproval, hasInvisibleCharacter, type OwnerApprovalSubjectDescriptor } from '../host/owner-approval.js';
import { storageDatabasePathAllowed } from '../host/storage-maintenance.js';
import { newRequestId, normalizeHouseOrigin } from '../runtime/house-lifecycle/control-client.js';
import { readParticipation } from '../runtime/house-lifecycle/participation-store.js';
import { fetchTrustedManifest } from './house-trust.js';
import { verifyManifestProof, houseKeyFromAckHex } from './house-binding.js';
import { confirmBinding, pinnedBinding, resolveBlock } from './house-binding-pin.js';
import { projectReadDeclarationInTx } from './house-read-declaration.js';
import { makeWorldManifestPreparer, revokeHouseCapabilityView } from './world-capabilities.js';
import { isLoopbackOrigin } from '../social-graph/relation-host.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export const HOUSE_RECONFIRM_TOOL = 'popclaw_house_reconfirm';
export interface HouseRecoveryDecision {
  readonly decision_id: string; readonly origin: string; readonly house_key: string;
  readonly old_incarnation: string; readonly new_incarnation: string;
  readonly pin_revision: number; readonly manifest_digest: string; readonly expires_at: number;
}
interface DecisionRow { decision_id: string; origin: string; decision_json: string; pin_json: string;
  participation_json: string; raw_bytes: Uint8Array; proof_header: string; state: string; detail: string }
export interface HouseRecoveryPort {
  prepare(origin: string): Promise<HouseRecoveryDecision>;
  read(decisionId: string): HouseRecoveryDecision | null;
  confirm(params: unknown, callRef: string): Promise<unknown>;
}
export interface HouseRecoveryOptions {
  db: HostDb; fetch?: typeof globalThis.fetch; now?(): number;
  configuredPinFor?(origin: string): string | undefined;
  enqueue(decisionId: string, origin: string): Promise<unknown>;
  quiesce(origin: string, decisionId: string): Promise<void>;
  /** Rechecked after every await and under the final write lock. */
  isOwnerCurrent(): boolean;
}
const fail = (code: string): never => { throw new Error(code); };
function decisionId(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).join() !== 'decision_id'
    || typeof (params as {decision_id?: unknown}).decision_id !== 'string') return fail('HOUSE_RECOVERY_INPUT_INVALID');
  const id = (params as {decision_id: string}).decision_id;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return fail('HOUSE_RECOVERY_INPUT_INVALID');
  return id;
}
export function houseRecoverySubject(read: (id: string) => HouseRecoveryDecision | null | Promise<HouseRecoveryDecision | null>): OwnerApprovalSubjectDescriptor {
  return {
    canonicalize(params) { try { return JSON.stringify([HOUSE_RECONFIRM_TOOL, decisionId(params)]); } catch { return '\u0000INVALID'; } },
    async describe(params) {
      let d: HouseRecoveryDecision | null;
      try { d = await read(decisionId(params)); } catch { d = null; }
      if (!d || d.expires_at <= Date.now()) return {kind: 'refuse', reason: 'HOUSE_RECOVERY_DECISION_STALE'};
      if ([d.origin,d.house_key,d.old_incarnation,d.new_incarnation].some(hasInvisibleCharacter)) return {kind:'refuse',reason:'HOUSE_RECOVERY_UNPRINTABLE'};
      const lang = ownerLang();
      return {kind: 'ask', title: renderCopy(lang, 'house.recovery.title'), description: [
        d.origin, d.house_key, `${d.old_incarnation} → ${d.new_incarnation} (rev ${d.pin_revision})`,
        d.manifest_digest, renderCopy(lang, 'house.recovery.consequence')],
        confirmLabel: renderCopy(lang, 'house.recovery.confirm')};
    },
  };
}
export { ensureHouseRecoverySchema } from '../host/runtime-storage-schema.js';
export class HouseRecovery implements HouseRecoveryPort {
  private readonly now: () => number;
  constructor(private readonly opts: HouseRecoveryOptions) {
    this.now = opts.now ?? Date.now;
    ensureHouseRecoverySchema(opts.db);
  }
  private row(id: string): DecisionRow | null {
    return this.opts.db.queryOne<DecisionRow>('SELECT * FROM house_recovery_decisions_v1 WHERE decision_id=?', [id]);
  }
  read(id: string): HouseRecoveryDecision | null {
    const row = this.row(id);
    if (!row || row.state !== 'prepared') return null;
    const d = JSON.parse(row.decision_json) as HouseRecoveryDecision;
    try { this.check(row, d); return Object.freeze(d); } catch { return null; }
  }
  private incarnationRetired(origin: string, key: string, incarnation: string): boolean {
    // Selecting a historical namespace would rearm its old pending messages
    // and reservations. A real restore must mint an unused incarnation.
    const history = this.opts.db.queryAll<{decision_json:string}>(
      "SELECT decision_json FROM house_recovery_decisions_v1 WHERE origin=? AND state='complete'",[origin]);
    return history.some(row => {
      const old = JSON.parse(row.decision_json) as HouseRecoveryDecision;
      return old.house_key === key && (old.old_incarnation === incarnation || old.new_incarnation === incarnation);
    });
  }
  private requireUnseenIncarnation(origin: string, key: string, incarnation: string): void {
    if (this.incarnationRetired(origin,key,incarnation)) fail('HOUSE_RECOVERY_INCARNATION_RETIRED');
  }
  private configured(origin: string, key: string): void {
    const hex = this.opts.configuredPinFor?.(origin);
    if (hex && houseKeyFromAckHex(hex.toLowerCase()) !== key) fail('HOUSE_RECOVERY_KEY_CHANGED');
  }
  private check(row: DecisionRow, d: HouseRecoveryDecision): void {
    if (!storageDatabasePathAllowed(this.opts.db, 'execution')) fail('STORAGE_RECOVERY_HELD');
    if (d.expires_at <= this.now()) fail('HOUSE_RECOVERY_DECISION_STALE');
    this.configured(d.origin, d.house_key);
    this.requireUnseenIncarnation(d.origin,d.house_key,d.new_incarnation);
    if (JSON.stringify(pinnedBinding(this.opts.db, d.origin)) !== row.pin_json) fail('HOUSE_RECOVERY_PIN_STALE');
    if (JSON.stringify(readParticipation(this.opts.db, d.origin)) !== row.participation_json) fail('HOUSE_RECOVERY_PARTICIPATION_STALE');
  }
  async prepare(input: string): Promise<HouseRecoveryDecision> {
    const origin = normalizeHouseOrigin(input), db = this.opts.db;
    if (!storageDatabasePathAllowed(db, 'execution')) fail('STORAGE_RECOVERY_HELD');
    const pin = pinnedBinding(db, origin), participation = readParticipation(db, origin);
    if (!pin || !participation) return fail('HOUSE_RECOVERY_NO_OLD_BINDING');
    this.configured(origin, pin.houseKey);
    const served = await fetchTrustedManifest(origin, {fetch: this.opts.fetch, allowInsecureOrigin: isLoopbackOrigin(origin)});
    if (served.status !== 'ok') return fail('HOUSE_RECOVERY_MANIFEST_UNAVAILABLE');
    const verified = verifyManifestProof({origin, rawBytes: served.rawBytes, proofHeader: served.proofHeader, pinnedHouseKey: pin.houseKey});
    if (verified.incarnation === pin.incarnation) return fail('HOUSE_RECOVERY_NOT_CHANGED');
    const id = newRequestId();
    const prepared = db.transaction(tx => {
      if (JSON.stringify(pinnedBinding(tx, origin)) !== JSON.stringify(pin)
        || JSON.stringify(readParticipation(tx, origin)) !== JSON.stringify(participation)) return fail('HOUSE_RECOVERY_PREPARATION_STALE');
      this.configured(origin, pin.houseKey);
      if (!pin.blockedReason) confirmBinding(tx, verified);
      revokeHouseCapabilityView(tx,origin,'HOUSE_INCARNATION_CHANGED');
      // Even an unusable historical target is a verified disagreement. Keep
      // the block committed, but never issue a recovery decision for it.
      if (this.incarnationRetired(origin,pin.houseKey,verified.incarnation)) return null;
      const blocked = pinnedBinding(tx, origin)!;
      const d = Object.freeze({decision_id: id, origin, house_key: pin.houseKey, old_incarnation: pin.incarnation,
        new_incarnation: verified.incarnation, pin_revision: blocked.revision, manifest_digest: verified.manifestDigest, expires_at: this.now() + 300_000});
      tx.execute(`INSERT INTO house_recovery_decisions_v1
        (decision_id,origin,decision_json,pin_json,participation_json,raw_bytes,proof_header,state) VALUES(?,?,?,?,?,?,?,'prepared')`,
      [id, origin, JSON.stringify(d), JSON.stringify(blocked), JSON.stringify(participation), served.rawBytes, served.proofHeader]);
      return d;
    });
    return prepared ?? fail('HOUSE_RECOVERY_INCARNATION_RETIRED');
  }
  async confirm(params: unknown, callRef: string): Promise<unknown> {
    const approval = consumeOwnerApproval(HOUSE_RECONFIRM_TOOL, params, callRef);
    if (approval.decision !== 'approved') return fail(approval.decision === 'unavailable' ? approval.reason : `HOUSE_RECOVERY_${approval.decision.toUpperCase()}`);
    const id = decisionId(params), row = this.row(id);
    if (!row || row.state !== 'prepared') return fail('HOUSE_RECOVERY_DECISION_SPENT');
    const d = JSON.parse(row.decision_json) as HouseRecoveryDecision;
    this.opts.db.transaction(tx => {
      this.check(row,d);
      const p = readParticipation(tx,d.origin)!;
      const owner = tx.queryOne<{generation:number;holder:string}>('SELECT generation,holder FROM house_lifecycle_owner WHERE id=1');
      if (tx.execute("UPDATE house_recovery_decisions_v1 SET state='approved',approved_epoch=? WHERE decision_id=? AND state='prepared'", [owner?.holder ? owner.generation : null,id]).changes !== 1) fail('HOUSE_RECOVERY_DECISION_SPENT');
      // The normal IPC executor may clear payloads when it retires stale
      // commands. Retain their complete captures before that can happen.
      for (const command of tx.queryAll<{request_id:string} & Record<string,unknown>>(
        "SELECT * FROM house_lifecycle_commands WHERE house_origin=? AND kind='push' AND state IN ('pending','running')",[d.origin])) {
        tx.execute('INSERT INTO house_recovery_command_evidence_v1 VALUES(?,?,?)',[id,command.request_id,
          JSON.stringify({...command, payload_bytes: command.payload_bytes instanceof Uint8Array
            ? {encoding:'hex',bytes:Buffer.from(command.payload_bytes).toString('hex')} : command.payload_bytes})]);
      }
      // Fence first, before waiting for the resident. Even a caller crash here
      // cannot leave old participation active or old capabilities selected.
      tx.execute(`INSERT INTO house_recovery_fences_v1(origin,decision_id,house_key,old_incarnation,new_incarnation,fence_seq,state)
        VALUES(?,?,?,?,?,?,'held') ON CONFLICT(origin) DO UPDATE SET decision_id=excluded.decision_id,
        house_key=excluded.house_key,old_incarnation=excluded.old_incarnation,new_incarnation=excluded.new_incarnation,
        fence_seq=excluded.fence_seq,state='held'`, [d.origin,id,d.house_key,d.old_incarnation,d.new_incarnation,p.op_seq+1]);
      tx.execute(`UPDATE house_participation SET op_seq=op_seq+1,desired='disabled',phase='disconnected',remote_status='error',
        remote_error='HOUSE_RECOVERY_HELD' WHERE house_origin=?`, [d.origin]);
      revokeHouseCapabilityView(tx,d.origin,'HOUSE_RECOVERY_HELD');
    });
    return this.opts.enqueue(id,d.origin);
  }
  /** Resident only. Interrupted attempts are never automatically resumed. */
  async apply(id: string, ownerCurrent: () => boolean = this.opts.isOwnerCurrent): Promise<{status: 'reconfirmed'; origin: string; next: 'login'}> {
    const row = this.row(id);
    if (!row || row.state !== 'approved') return fail('HOUSE_RECOVERY_DECISION_SPENT');
    const d = JSON.parse(row.decision_json) as HouseRecoveryDecision;
    const current = (): void => {
      if (!ownerCurrent() || !storageDatabasePathAllowed(this.opts.db,'execution')) fail('HOUSE_RECOVERY_OWNER_LOST');
      const fence = this.opts.db.queryOne<{decision_id: string; fence_seq: number; state: string}>('SELECT * FROM house_recovery_fences_v1 WHERE origin=?',[d.origin]);
      const p = readParticipation(this.opts.db,d.origin);
      if (d.expires_at <= this.now() || !fence || fence.decision_id !== id || fence.state !== 'held'
        || p?.op_seq !== fence.fence_seq || p.desired !== 'disabled'
        || JSON.stringify(pinnedBinding(this.opts.db,d.origin)) !== row.pin_json) fail('HOUSE_RECOVERY_DECISION_STALE');
      this.configured(d.origin,d.house_key);
      this.requireUnseenIncarnation(d.origin,d.house_key,d.new_incarnation);
    };
    try {
      current();
      if (this.opts.db.execute("UPDATE house_recovery_decisions_v1 SET state='applying' WHERE decision_id=? AND state='approved'",[id]).changes !== 1) fail('HOUSE_RECOVERY_DECISION_SPENT');
      await this.opts.quiesce(d.origin,id); current();
      const served = await fetchTrustedManifest(d.origin,{fetch:this.opts.fetch,allowInsecureOrigin:isLoopbackOrigin(d.origin)}); current();
      if (served.status !== 'ok') return fail('HOUSE_RECOVERY_MANIFEST_UNAVAILABLE');
      const verified = verifyManifestProof({origin:d.origin,rawBytes:served.rawBytes,proofHeader:served.proofHeader,pinnedHouseKey:d.house_key});
      if (verified.incarnation !== d.new_incarnation || verified.manifestDigest !== d.manifest_digest) fail('HOUSE_RECOVERY_MANIFEST_CHANGED');
      const signal = new AbortController().signal;
      const capability = await makeWorldManifestPreparer({fetch:this.opts.fetch})({origin:d.origin,rawBytes:served.rawBytes,proofHeader:served.proofHeader,
        ackKeyHex:[...bs58.decode(d.house_key)].map(n=>n.toString(16).padStart(2,'0')).join(''),provenance:'persisted_pin',signal}); current();
      // Guide preparation is asynchronous too. Re-read the signed manifest
      // after it, so a board replaced during preparation cannot be selected.
      const latest = await fetchTrustedManifest(d.origin,{fetch:this.opts.fetch,allowInsecureOrigin:isLoopbackOrigin(d.origin)}); current();
      if (latest.status !== 'ok') return fail('HOUSE_RECOVERY_MANIFEST_UNAVAILABLE');
      const finalBinding = verifyManifestProof({origin:d.origin,rawBytes:latest.rawBytes,proofHeader:latest.proofHeader,pinnedHouseKey:d.house_key});
      if (finalBinding.incarnation !== d.new_incarnation || finalBinding.manifestDigest !== d.manifest_digest) fail('HOUSE_RECOVERY_MANIFEST_CHANGED');
      this.opts.db.transaction(tx => {
        current();
        if (!resolveBlock(tx,{origin:d.origin,houseKey:d.house_key,incarnation:d.new_incarnation},d.pin_revision)) fail('HOUSE_RECOVERY_PIN_STALE');
        tx.execute("UPDATE house_recovery_fences_v1 SET state='complete',completed_at=? WHERE origin=? AND decision_id=?",[this.now(),d.origin,id]);
        projectReadDeclarationInTx(tx,verified,served.rawBytes,Math.floor(this.now()/1000));
        capability.commit(tx);
        // Selecting a signed board grants no execution authority and leaves the
        // House disabled. Normal explicit login creates entirely new participation.
        tx.execute(`UPDATE house_participation SET session_id='',house_revision=0,lease_expires_at=0,inbox_read_token='',
          renew_after=0,pending_enter_request_id=NULL,remote_status='none',remote_error='' WHERE house_origin=?`,[d.origin]);
        tx.execute("UPDATE house_recovery_decisions_v1 SET state='complete' WHERE decision_id=?",[id]);
      });
      return {status:'reconfirmed',origin:d.origin,next:'login'};
    } catch(error) {
      this.opts.db.execute("UPDATE house_recovery_decisions_v1 SET state='failed',detail=? WHERE decision_id=? AND state IN ('approved','applying')",
        [error instanceof Error ? error.message : 'HOUSE_RECOVERY_FAILED',id]);
      throw error;
    }
  }
}
