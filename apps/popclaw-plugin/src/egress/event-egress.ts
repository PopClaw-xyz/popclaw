export interface PushResult {
  readonly status: number;
  /**
   * Opaque SignedActionResult response bytes (at most 1 MiB), preserved as base64.
   * Not decoded or authenticated here. HTTP status describes transport only;
   * a verifier must establish the signed business outcome before it is trusted.
   */
  readonly signedActionResultBase64?: string;
  readonly eventId?: string;
  readonly deduplicated?: boolean;
  /** lore-house's `{"error": ...}` reason on non-2xx (e.g. "already verified for x"). */
  readonly detail?: string;
  /**
   * ADR-0040: quest task_id echoed back when an InviteRequest is accepted — the
   * applicant's only handle on their own application (for querying/tracking whether it was
   * rejected). Absent for every other payload and for older lore-houses.
   */
  readonly taskId?: string;
}

export interface EventEgress {
  /** Default target = the home lore-house. A single-house implementation only has this one method. */
  push(signedPayloadBytes: Uint8Array): Promise<PushResult>;
  /**
   * Spec B slice ③: push to a specific lore-house. An omitted slug selects home; an unknown explicit slug must be rejected.
   * Optional: a single-house implementation (ServerPushEgress) not providing this = everything still lands on the one house as before.
   */
  pushTo?(houseSlug: string | undefined, signedPayloadBytes: Uint8Array): Promise<PushResult>;
  /** Broadcasts to every lore-house (for public artifacts like namecards). Optional, same as above. */
  broadcast?(signedPayloadBytes: Uint8Array): Promise<PushResult>;
  /**
   * The broadcast's **per-house receipt**: the passport's stamped-line entries need to
   * honestly report one line per house (onboarding spec §2).
   * Optional: a single-house implementation not providing this → the caller falls back to
   * broadcast/push, with only the home-house line. `[0]` is always the home house.
   */
  broadcastEach?(signedPayloadBytes: Uint8Array): Promise<readonly HouseBroadcastOutcome[]>;
  /**
   * Freeze the houses a broadcast would reach right now. Optional, same as
   * above: a single-house implementation has nothing that can change.
   */
  capturePlan?(): EgressPlan;
}

/**
 * One write's target set, captured once. `egress` broadcasts to exactly
 * `targets` (same order, `[0]` = home) through the same per-house channels,
 * so every send-time check still runs, and never to a house mounted later.
 * A pre-write check that reads `targets` has read every house the write can
 * reach.
 */
export interface EgressPlan {
  readonly targets: readonly { readonly slug: string; readonly origin?: string }[];
  readonly egress: EventEgress;
}

/** One lore-house's broadcast result. Missing `result` = network-level failure (not even a receipt). */
export interface HouseBroadcastOutcome {
  readonly slug: string;
  readonly result?: PushResult;
  readonly error?: unknown;
}

/** Legacy event approval requires 2xx; an opaque action receipt still needs verification. */
export function outcomeOk(o: HouseBroadcastOutcome): boolean {
  return o.result !== undefined && o.result.signedActionResultBase64 === undefined
    && o.result.status >= 200 && o.result.status < 300;
}

/**
 * The refusal carried by a push receipt, or `undefined` when there is none.
 *
 * A house REFUSES with a status code, not an exception — `ServerPushEgress`
 * returns `{status, detail}` on a non-2xx — so a caller that awaits a push
 * without reading its receipt has learned only that the transport spoke.
 *
 * 2xx is the whole of "accepted", deduplication included: lore-house answers
 * a duplicate with 200 and `deduplicated: true`, and keeps 409 for a genuine
 * conflict. A receipt that names NO status is not judged — the seam handed to
 * a command may report none, and silence is not a refusal.
 */
export function pushRejection(receipt: unknown): { readonly status: number; readonly detail?: string } | undefined {
  const result = receipt as Partial<PushResult> | null | undefined;
  const status = result?.status;
  if (typeof status !== 'number' || (status >= 200 && status < 300)) return undefined;
  const detail = result?.detail;
  return { status, ...(typeof detail === 'string' && detail ? { detail } : {}) };
}

/** The per-house-routed call entry point; if the implementation has no pushTo (single-house), it falls back to push — single-house behavior is bit-for-bit unchanged. */
export function pushRouted<R>(
  egress: {
    push(bytes: Uint8Array): Promise<R>;
    pushTo?(houseSlug: string | undefined, bytes: Uint8Array): Promise<R>;
  },
  houseSlug: string | undefined,
  bytes: Uint8Array,
): Promise<R> {
  return egress.pushTo ? egress.pushTo(houseSlug, bytes) : egress.push(bytes);
}

/** The broadcast call entry point; if the implementation has no broadcast (single-house), it falls back to push. */
export function broadcastAll<R>(
  egress: { push(bytes: Uint8Array): Promise<R>; broadcast?(bytes: Uint8Array): Promise<R> },
  bytes: Uint8Array,
): Promise<R> {
  return egress.broadcast ? egress.broadcast(bytes) : egress.push(bytes);
}
