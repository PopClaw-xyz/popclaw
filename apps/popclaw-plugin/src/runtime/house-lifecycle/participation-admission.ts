/** Trusted host authority for local participation. It grants no HTTP or business action. */
import type { HostDb } from '../../host/host-db.js';
import type { ParticipationRow } from './participation-store.js';
export type HouseParticipationReason = 'initial_me_setup' | 'explicit_owner_join';
export interface HouseParticipationCapture {
  readonly reason: HouseParticipationReason;
  readonly origin: string;
  readonly actorId: string;
  readonly installationId: string;
}
export interface HouseParticipationSource extends HouseParticipationCapture {
  readonly originalIntentRef: string;
  readonly originalOperationRef: string;
  readonly authorityRef: string;
  /** Stable identity/provision + purpose, never a request/session/policy version. */
  readonly eligibilityRef?: string;
}
export interface HouseParticipationHistory {
  readonly participation: ParticipationRow | null;
  readonly commands: readonly Readonly<Record<string, unknown>>[];
  readonly leaves: readonly Readonly<Record<string, unknown>>[];
  readonly selectedSessionBoard: boolean;
}
export interface HouseParticipationPlan extends HouseParticipationSource {
  readonly version: 1;
  readonly admissionRequestKey: string;
  readonly attemptRef: string;
  readonly expectedParticipationJson: string;
  readonly controlEvidenceJson: string;
  readonly manifestDigest: string;
  readonly bindingDigest: string;
  readonly configurationDigest: string;
  readonly ownerGeneration: number | null;
  readonly storageGeneration: string;
  readonly beforeOpSeq: number;
  readonly afterOpSeq: number;
  readonly transitionDigest: string;
  readonly planDigest: string;
}
export interface HouseParticipationReceipt {
  readonly originalIntentRef: string;
  readonly originalOperationRef: string;
  readonly attemptRef: string;
  readonly planDigest: string;
  readonly actorId: string;
  readonly installationId: string;
  readonly origin: string;
  readonly beforeOpSeq: number;
  readonly afterOpSeq: number;
  readonly committedAtMs: number;
}
export type HouseParticipationReceiptQuery = Pick<HouseParticipationReceipt,
  'originalIntentRef' | 'originalOperationRef' | 'attemptRef' | 'planDigest'>;
export type HouseParticipationReceiptResult = { readonly status: 'found'; readonly receipt: HouseParticipationReceipt }
  | { readonly status: 'absent' | 'unavailable' };
export interface HouseParticipationPermit<Db> {
  /** Synchronous, one shot, under the SQLite write lock. Must throw on expiry/fence mismatch. */
  beforeCommit(tx: Db, plan: HouseParticipationPlan): void;
}
export type HouseParticipationDecision<Db> = { readonly status: 'permitted'; readonly permit: HouseParticipationPermit<Db> }
  | { readonly status: 'denied'; readonly code: string }
  | { readonly status: 'unresolved'; readonly attemptRef: string };
export type HouseParticipationSettlement = { readonly status: 'committed'; readonly receipt: HouseParticipationReceipt }
  | { readonly status: 'not_committed'; readonly detail: string }
  | { readonly status: 'unknown' };
export interface HouseParticipationAdmissionPort<Db = HostDb> {
  /** Called in the original trusted source scope, BEFORE enqueue. Never read from tool arguments. */
  capture(input: HouseParticipationCapture): HouseParticipationSource | undefined;
  /** Known host extensions must positively assess retained control/dispatch facts. */
  assessHistory?(origin: string, history: HouseParticipationHistory): boolean;
  admit(plan: HouseParticipationPlan, lifetime: { readonly signal: AbortSignal; readonly deadlineAtMs: number }): Promise<HouseParticipationDecision<Db>>;
  settle(attemptRef: string, outcome: HouseParticipationSettlement): Promise<void>;
}
