/**
 * The snapshot recovery consumer — the second missing link of the
 * cursor-reset chain (work-order C's map §1): when a house has said "I could
 * not honour your cursor", THIS is what pays the debt.
 *
 * The rule the whole shape hangs on: **the snapshot is a hint, the
 * evidence is the fact.** Nothing in a snapshot entry — state, applied_seq,
 * timestamps — is ever applied. What this consumer does is fetch the house's
 * VERBATIM SIGNED ORIGINALS (`/v1/relation-evidence/<event_id>`) and hand
 * each one to the ORDINARY commit boundary (`handle.receive` →
 * verifyInboundEnvelope → decide), where signature, CID, per-type
 * authorization and the participation fence judge it exactly as a live frame
 * would. An edge appears only from a verified author-signed original; a
 * revocation lands only from a verified signed revoke; a hostile or
 * incomplete snapshot therefore adds nothing, and — because nothing in this
 * file ever deletes — an edge MISSING from the snapshot is not a deletion.
 * The house's `hints` are ignored on arrival.
 *
 * The completion rule is just as strict: the gap closes and the watermark is
 * adopted ONLY after the last page of one checkpoint arrived with
 * `complete: true` (`complete: false` means unknown, never "fully
 * synced"). Any failure — network, HTTP, an expired continuation (410), a
 * spent page or evidence budget — leaves the gap open and the cursor
 * untouched; the next drain tick tries again. A 404 on one evidence item
 * skips that item (the uniform-404 design means "not found" is not evidence
 * of anything), it never fails the run.
 */
import type { HostDb } from '../host/host-db.js';
import type { ReadAuthority } from '../identity/read-authority.js';
import { setResumePosition, resumePosition } from '../ingress/inbound-commit.js';
import { RelationGapStore } from './relation-gap-store.js';
import { pinnedBinding } from '../world/house-binding-pin.js';
import type { RelationSessionHandle } from './relation-wiring.js';

export interface SnapshotRecoveryDeps {
  readonly db: HostDb;
  /**
   * How this house's reads prove who is asking. A refusal here is the end of
   * the sweep, not a prompt to try something older: the snapshot and the
   * evidence both carry the owner's identity, and a house that cannot verify
   * it must not be sent one of the shapes that no longer exists.
   */
  readonly readAuth: ReadAuthority;
  readonly fetch: typeof globalThis.fetch;
  /** The house's canonical origin — the two endpoints live under it. */
  readonly origin: string;
  /** The live session handle for that house: evidence bytes commit through it. */
  readonly handle: RelationSessionHandle;
  readonly houseKey: string;
  readonly incarnation: string;
  /**
   * The ORIGINAL handle the sweep set out under: the
   * completion's in-transaction authorization compares against THIS
   * generation and the pinned key identity — an active row under a NEWER
   * generation (logout, relogin) is a different session's authority and
   * must not clear this sweep's debt.
   */
  readonly expected?: {
    readonly ownerGeneration: number;
    readonly houseKeyOfPin: string;
    /** The pin's incarnation when the sweep set out: a same-key restore
     *  (confirmable without touching participation) must refuse the old
     *  sweep's completion too. */
    readonly incarnationOfPin: string;
  };
  readonly log?: { readonly info?: (msg: string) => void; readonly warn?: (msg: string) => void };
  /** Bounds for one run; the drain tick retries whatever a run cannot finish. */
  readonly maxPages?: number;
  readonly maxEvidence?: number;
  readonly now?: () => number;
  /**
   * The caller's round: checked before the run starts and again
   * before the completion transaction — a sweep whose lease round or host
   * lifetime died mid-fetch completes NOTHING, on the same fence the resend
   * sweep uses.
   */
  readonly stillValid?: () => boolean;
}

export type RecoveryOutcome =
  | { readonly recovered: true; readonly watermark: string; readonly evidenceFetched: number }
  | { readonly recovered: false; readonly reason: string };

interface SnapshotPage {
  readonly checkpoint_id: string;
  readonly log_generation: string;
  readonly floor: string;
  readonly watermark: string;
  readonly entries: ReadonlyArray<{ readonly evidence_event_ids: readonly string[] }>;
  readonly next_cursor?: string | null;
  readonly complete: boolean;
}

interface EvidenceBody {
  readonly event_id: string;
  readonly envelope_b64: string;
}

/** Exact-integer domain checks: a strict digit
 *  string within the server's i64 range. No parseInt — it would read
 *  "0garbage" as 0 and hand garbage the cold-start branch. */
function isI64String(raw: string): boolean {
  if (!/^-?\d+$/u.test(raw)) return false;
  const v = BigInt(raw);
  return v >= -9223372036854775808n && v <= 9223372036854775807n;
}
function isNonNegativeI64String(raw: string): boolean {
  return /^\d+$/u.test(raw) && isI64String(raw);
}

/** Minimal runtime validation: required fields with
 *  the right primitive types; `complete` STRICTLY boolean — the string
 *  "false" is truthy and must never read as completion. */
function parseSnapshotPage(raw: unknown): SnapshotPage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r['checkpoint_id'] !== 'string' || r['checkpoint_id'].length === 0) return undefined;
  if (typeof r['log_generation'] !== 'string' || r['log_generation'].length === 0) return undefined;
  if (typeof r['floor'] !== 'string' || r['floor'].length === 0) return undefined;
  if (typeof r['watermark'] !== 'string' || r['watermark'].length === 0) return undefined;
  if (typeof r['complete'] !== 'boolean') return undefined;
  if (!Array.isArray(r['entries'])) return undefined;
  for (const e of r['entries']) {
    if (typeof e !== 'object' || e === null) return undefined;
    if (!Array.isArray((e as Record<string, unknown>)['evidence_event_ids'])) return undefined;
  }
  const next = r['next_cursor'];
  if (next !== undefined && next !== null && typeof next !== 'string') return undefined;
  return raw as SnapshotPage;
}

/** A bookmark from an older generation is debris the reset killed: resend
 *  it and the house refuses it again. One at this generation or newer is
 *  live state and stays. */
function retireDeadBookmark(
  tx: import('../host/host-db.js').HostDb,
  source: { houseKey: string; incarnation: string },
  checkpointGeneration: string,
): void {
  const prev = resumePosition(tx, source, 'personal');
  if (prev === undefined) return;
  const dot = prev.indexOf('.');
  if (dot <= 0) return; // unparseable: leave it for setResumePosition's rules
  const prevGen = BigInt(prev.slice(0, dot));
  if (prevGen < BigInt(checkpointGeneration)) {
    tx.execute(
      'DELETE FROM stream_cursors WHERE house_key = ? AND stream = ? AND incarnation = ?',
      [source.houseKey, 'personal', source.incarnation],
    );
  }
}

export async function recoverRelationGap(deps: SnapshotRecoveryDeps): Promise<RecoveryOutcome> {
  const gaps = new RelationGapStore(deps.db);
  if (deps.stillValid !== undefined && !deps.stillValid()) {
    return { recovered: false, reason: 'the round died before the sweep started' };
  }
  const owed = gaps.openFor(deps.houseKey, deps.incarnation);
  if (owed === undefined) {
    return { recovered: true, watermark: '', evidenceFetched: 0 }; // nothing owed
  }
  const maxPages = deps.maxPages ?? 20;
  const maxEvidence = deps.maxEvidence ?? 500;
  /**
   * One credential per REQUEST, not one per run.
   *
   * A single token signed at the top of the sweep assumed the whole sweep
   * fits inside the token's freshness window. A sweep is up to 20 pages and
   * 500 evidence fetches -- 520 network round trips. On a slow link that
   * crosses a minute, and whichever request happens to cross it is refused,
   * leaving the gap open. The next tick starts another sweep that is slow for
   * the same reason: the reconciliation cannot finish for as long as the link
   * stays slow. The window was never a budget for a batch; it is freshness
   * for one request.
   *
   * Signing is not close to expensive: ~520 Ed25519 signatures on an
   * in-memory key against a sweep already waiting on 520 round trips.
   *
   * Each build is an `await`, so the round's authority is re-checked after
   * it: a sweep whose owner logged out while the signature was being computed
   * does not get one more request out of the door.
   */
  const credential = async (
    purpose: 'relation-snapshot' | 'relation-evidence',
  ): Promise<{ headers: Record<string, string> } | { refused: string } | undefined> => {
    // The purpose is the CALLER's, declared at each request. One closure
    // serving both routes with one purpose is exactly the mistake the four
    // purposes exist to make impossible, and it is invisible from here.
    const outcome = await deps.readAuth(purpose);
    if (deps.stillValid !== undefined && !deps.stillValid()) return undefined;
    if (!outcome.ok) return { refused: `${outcome.refusal}: ${outcome.message}` };
    return { headers: { ...outcome.headers } };
  };

  let cursor: string | undefined;
  let pages = 0;
  let fetched = 0;
  let lastPage: SnapshotPage | undefined;
  // The completion contract: every page must belong to the SAME checkpoint —
  // one checkpoint_id, and one generation/floor/watermark set. A continuation
  // that hands back a different checkpoint's page means the two halves of
  // this "reconciliation" describe different worlds, and completing on that
  // would clear a debt with mismatched books.
  let bound: { readonly checkpoint_id: string; readonly log_generation: string; readonly floor: string; readonly watermark: string } | undefined;
  for (;;) {
    if (pages >= maxPages) {
      return { recovered: false, reason: `page budget (${maxPages}) spent before a complete checkpoint` };
    }
    const url = `${deps.origin.replace(/\/$/, '')}/v1/relation-snapshot${
      cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : ''
    }`;
    const pageCredential = await credential('relation-snapshot');
    if (pageCredential === undefined) {
      return { recovered: false, reason: 'the round died before the page was requested' };
    }
    if ('refused' in pageCredential) {
      // The gap stays open and nothing is claimed. Reconciliation that cannot
      // authenticate is not reconciliation that found nothing.
      return { recovered: false, reason: pageCredential.refused };
    }
    let res: Response;
    try {
      res = await deps.fetch(url, { headers: pageCredential.headers });
    } catch (err) {
      return { recovered: false, reason: `snapshot fetch failed: ${String(err)}` };
    }
    if (!res.ok) {
      // 410 = the checkpoint expired mid-paging: restart means a FRESH run,
      // which is what the next drain tick does anyway. Never a partial pass.
      return { recovered: false, reason: `snapshot HTTP ${res.status}` };
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      return { recovered: false, reason: `snapshot body unreadable: ${String(err)}` };
    }
    // Runtime validation, not a type assertion: `complete: "false"` is a
    // truthy STRING, a missing checkpoint header is undefined — both would
    // sail through `as SnapshotPage` and could clear a debt on a page that
    // never claimed completeness. Every required field
    // present with the right primitive type; complete STRICTLY boolean.
    const page = parseSnapshotPage(raw);
    if (page === undefined) {
      return { recovered: false, reason: 'snapshot page failed validation (missing or mistyped required fields)' };
    }
    // The numeric halves are validated against the SERVER's domain, with
    // EXACT integer semantics — `Number.parseInt("0garbage")` is 0, so a
    // garbage watermark riding the cold-start branch used to clear the gap.
    // Only a strict optional-sign-digits string that
    // fits the i64 domain passes.
    if (!isI64String(page.log_generation) || !isNonNegativeI64String(page.watermark)) {
      return { recovered: false, reason: 'snapshot header failed numeric validation' };
    }
    pages += 1;
    lastPage = page;
    const header = {
      checkpoint_id: page.checkpoint_id,
      log_generation: page.log_generation,
      floor: page.floor,
      watermark: page.watermark,
    };
    if (bound === undefined) bound = header;
    else if (
      bound.checkpoint_id !== header.checkpoint_id ||
      bound.log_generation !== header.log_generation ||
      bound.floor !== header.floor ||
      bound.watermark !== header.watermark
    ) {
      return { recovered: false, reason: `checkpoint changed mid-paging (${bound.checkpoint_id} → ${header.checkpoint_id}) — nothing claimed` };
    }

    for (const entry of page.entries) {
      for (const eventId of entry.evidence_event_ids) {
        if (fetched >= maxEvidence) {
          return { recovered: false, reason: `evidence budget (${maxEvidence}) spent before a complete checkpoint` };
        }
        const evCredential = await credential('relation-evidence');
        if (evCredential === undefined) {
          return { recovered: false, reason: 'the round died before the evidence was requested' };
        }
        if ('refused' in evCredential) {
          return { recovered: false, reason: evCredential.refused };
        }
        let evRes: Response;
        try {
          evRes = await deps.fetch(
            `${deps.origin.replace(/\/$/, '')}/v1/relation-evidence/${encodeURIComponent(eventId)}`,
            { headers: evCredential.headers },
          );
        } catch (err) {
          return { recovered: false, reason: `evidence fetch failed: ${String(err)}` };
        }
        // REQUIRED evidence (the checkpoint NAMES it): a 404 or a refusal is
        // not a skip — a checkpoint that names evidence it will not serve, or
        // that serves bytes the ordinary boundary refuses, is not a completed
        // reconciliation, and claiming it would clear a debt with an IOU.
        if (evRes.status === 404) {
          return { recovered: false, reason: `checkpoint named evidence ${eventId} but the house serves none` };
        }
        if (!evRes.ok) {
          return { recovered: false, reason: `evidence HTTP ${evRes.status} for ${eventId}` };
        }
        let evidence: EvidenceBody;
        try {
          evidence = (await evRes.json()) as EvidenceBody;
        } catch (err) {
          return { recovered: false, reason: `evidence body unreadable: ${String(err)}` };
        }
        if (evidence.event_id !== eventId) {
          return { recovered: false, reason: `evidence swap: asked for ${eventId}, served ${evidence.event_id}` };
        }
        const bytes = new Uint8Array(Buffer.from(evidence.envelope_b64, 'base64'));
        // The ordinary boundary judges: signature, CID, per-type
        // authorization, the participation fence, decide(). Its verdict is
        // the only one that counts — the snapshot's hints never got this far.
        const outcome = deps.handle.receive({ stream: 'personal', envelopeBytes: bytes, eventId: evidence.event_id });
        if (outcome.disposition === 'refused') {
          return { recovered: false, reason: `evidence ${eventId} refused by the commit boundary — nothing claimed` };
        }
        fetched += 1;
      }
    }

    if (page.next_cursor === undefined || page.next_cursor === null) break;
    cursor = page.next_cursor;
  }

  if (lastPage === undefined || !lastPage.complete) {
    return { recovered: false, reason: 'checkpoint ended incomplete — unknown, not synced' };
  }
  if (bound === undefined) {
    return { recovered: false, reason: 'no checkpoint header observed' };
  }
  if (deps.stillValid !== undefined && !deps.stillValid()) {
    return { recovered: false, reason: 'the round died before completion — nothing claimed' };
  }
  // Complete: adopt the published watermark as the synced position — in the
  // house's own cursor format, `<generation>.<seq>` (a bare seq names no
  // generation and the server would treat it as unreadable), never backwards
  // — frames that arrived during the recovery keep their lead — and close
  // the gap, as ONE transaction that first re-reads the gap and proceeds
  // only if it is STILL the one this sweep set out to pay. A newer reset
  // landing mid-recovery supersedes this completion entirely: the newer gap
  // stands, no cursor is written (the G5/G6 race).
  const at = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const source = { houseKey: deps.houseKey, incarnation: deps.incarnation };
  // A watermark of 0 is the server's legal "nothing published yet": the
  // cursor protocol has no position for it (seq must be positive), and the
  // cold-start semantics it names is "resume from the head" — i.e. NO
  // cursor. The checkpoint still reconciled everything there was (nothing),
  // so the gap closes. The old bookmark's fate is decided by generation:
  // the reset that opened this gap named a NEWER
  // generation than the bookmark's, so the bookmark is DEAD and must go —
  // resending it re-earns the reset. A bookmark already AT this checkpoint's
  // generation (or newer) stays: it is live state, not debris.
  const coldStart = lastPage.watermark === '0';
  const position = coldStart ? undefined : `${bound.log_generation}.${lastPage.watermark}`;
  const verdict = gaps.completeIfUnchanged(
    deps.houseKey,
    deps.incarnation,
    { logGeneration: owed.logGeneration, floor: owed.floor },
    (tx) => {
      if (position === undefined) {
        // Cold start: retire a bookmark the reset already killed (older
        // generation), keep one that is still live (this generation or
        // newer) — never a blanket clear.
        retireDeadBookmark(tx, source, bound.log_generation);
        return;
      }
      setResumePosition(tx, source, 'personal', position, at);
    },
    // CURRENT authorization, inside the transaction: the participation for
    // this house must still be live and the pin unblocked. A logout or a
    // block that landed in ANOTHER process while the last
    // page was in flight refuses the completion even though this process's
    // lease and the gap never moved.
    (tx) => {
      // The ORIGINAL session's authority, compared by identity: the
      // participation must be live AND still the generation this
      // sweep's handle captured — a relogin (g1 → g3) leaves an ACTIVE row
      // that is NOT this sweep's to act under — and the pin must be unblocked
      // AND still the same key the handle was built on.
      const part = tx.queryOne<{ owner_generation: number; active: number }>(
        'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
        [deps.houseKey],
      );
      if (part === undefined || part === null || part.active !== 1) return false;
      if (deps.expected !== undefined && part.owner_generation !== deps.expected.ownerGeneration) return false;
      const pin = pinnedBinding(tx, deps.origin);
      if (pin === undefined || pin.blockedReason !== undefined) return false;
      if (deps.expected !== undefined && pin.houseKey !== deps.expected.houseKeyOfPin) return false;
      if (deps.expected !== undefined && pin.incarnation !== deps.expected.incarnationOfPin) return false;
      return true;
    },
  );
  if (verdict === 'superseded') {
    return { recovered: false, reason: 'a newer reset superseded this checkpoint — nothing claimed' };
  }
  if (verdict === 'unauthorized') {
    return { recovered: false, reason: 'the participation or pin moved before completion — nothing claimed' };
  }
  if (verdict === 'no-gap') {
    return { recovered: false, reason: 'the gap closed elsewhere before completion' };
  }
  deps.log?.info?.(
    `popclaw: relation snapshot reconciled for ${deps.houseKey.slice(0, 8)}… (cursor ${position}, ${fetched} originals verified)`,
  );
  return { recovered: true, watermark: position ?? '', evidenceFetched: fetched };
}
