/** Bounded local reader over authenticated durable private material.
 *
 * Reads are list/read only: no writes, no acknowledgements, no policy changes,
 * no model invocation, no private HTTP. Every row is revalidated against the
 * current first-release evidence with an ACTUAL body-schema worker run —
 * envelope CID/signature, recipient-only decryption, digest equality, current
 * revision/kind/official producer — before any byte is exposed; a cache row or
 * a digest stored beside forgeable plaintext never attests content.
 *
 * Fixed per-call bounds: at most 100 returned messages, 256 scanned rows,
 * 8 MiB of stored envelope bytes, and a page whose COMPLETE JSON serialization
 * (items including their serializedBytes field, commas, the fully escaped
 * cursor, counters and invalid notes) stays within the requested budget of at
 * most 64 KiB (callers may request a smaller positive budget). Rows are
 * planned by SQLite `length()` on BOTH BLOB columns before anything is
 * materialized: an envelope over the scan cap or a plaintext over the 64 KiB
 * wrapper ceiling is reported by id and skipped — never fetched, never able to
 * displace or hide valid rows. Fetching is by exact planned ids, and single
 * reads pass the same pre-materialization guards. An item that cannot fit in
 * any valid page at this budget returns an explicit size-limit outcome with
 * the cursor still before it. The reader owns its stop/whenIdle lifecycle so
 * no read can touch a closed database. */
import type { HostDb } from '../host/host-db.js';
import type { Signer } from '../identity/signer.js';
import {
  privateMessageBindingId, privateMessageStateDigest, revalidateStoredPrivateMessage,
  selectFirstReleasePrivateEvidence, type FirstReleasePrivateEvidence, type RevalidatedPrivateMessage,
} from './private-message-evidence.js';
import {
  assertPrivateMessageJournalSchema, planPrivateMessageRows,
  readPrivateMessageRowBounded, readPrivateStateRow, PRIVATE_MESSAGE_MAX_PLAINTEXT, PRIVATE_MESSAGE_SCAN_BYTES_MAX,
} from './private-message-storage.js';
import type { HouseCapabilityView } from './world-capabilities.js';

const LIST_LIMIT_MAX = 100;
const SCAN_ROWS_MAX = 256;
const INVALID_NOTES_MAX = 64;
const CURSOR_PROFILE = 'first-release-private-list-v1';
const CURSOR_MAX_BYTES = 4096;
const ID_PATTERN = /^[A-Za-z0-9_./:-]{0,128}$/;
const utf8 = new TextEncoder();
const jsonBytes = (value: unknown): number => utf8.encode(JSON.stringify(value)).length;

export interface PrivateMessageLocalFacts {
  readonly consumerPending: boolean;
  readonly envelopeDigest: string; readonly plaintextDigest: string; readonly wrapperDigest: string;
}
export interface PrivateMessageListItem {
  readonly messageId: string; readonly eventId: string; readonly kind: string;
  readonly deliveryClass: string; readonly senderId: string;
  readonly capabilityRevision: string; readonly summary: string | null;
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly stateRef: string | null; readonly stateRevision: string | null;
  readonly local: PrivateMessageLocalFacts;
  readonly serializedBytes: number;
}
export interface PrivateMessageListQuery {
  /** 1..100, default 100. */
  readonly limit?: number;
  /** Opaque scoped cursor from a previous page. */
  readonly cursor?: string;
  /** 1..65536 bytes for the COMPLETE serialized page, default 65536. */
  readonly maxPageBytes?: number;
}
export type PrivateMessageListResult =
  | {
    readonly status: 'ok'; readonly items: readonly PrivateMessageListItem[]; readonly nextCursor: string | null;
    readonly scannedRows: number; readonly scannedBytes: number; readonly truncatedByScan: boolean;
    readonly invalid: ReadonlyArray<{ readonly messageId: string; readonly reason: string }>;
  }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'cursor_rejected'; readonly reason: string }
  | { readonly status: 'item_over_budget'; readonly messageId: string; readonly budgetBytes: number; readonly itemBytes: number; readonly cursor: string | null };

export interface PrivateMessageSingleRead {
  readonly item: PrivateMessageListItem;
  readonly originalText: string;
  readonly envelopeBytes: Uint8Array;
  readonly plaintextBytes: Uint8Array;
}
export type PrivateMessageReadResult =
  | { readonly status: 'ok'; readonly message: PrivateMessageSingleRead }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'invalid'; readonly reason: string };

export interface PrivateStateRead {
  readonly stateRef: string; readonly revision: string; readonly messageId: string; readonly stateDigest: string;
  /** Whether the anchoring message revalidates under current evidence AND its
   * authenticated wrapper recomputes this exact anchor. */
  readonly messageValid: boolean; readonly reason?: string;
}
export type PrivateStateReadResult =
  | { readonly status: 'ok'; readonly state: PrivateStateRead }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'not_found' };

export interface PrivateMessageReaderOptions {
  /** Prepared protected execution DB. */
  readonly executionDb: HostDb;
  readonly gate: { readonly origin: string; readonly signal: AbortSignal; isActive(): boolean };
  /** G0-supplied durable currentness; rechecked before every exposure, after
   * every schema-worker await. */
  assertCurrent(): void;
  readonly recipientId: string;
  view(): HouseCapabilityView | null;
  readonly recipient: Pick<Signer, 'openDm'>;
  readonly isOfficialActor: (actorId: string) => boolean;
}
export interface PrivateMessageReader {
  list(query?: PrivateMessageListQuery): Promise<PrivateMessageListResult>;
  readMessage(messageId: string): Promise<PrivateMessageReadResult>;
  readState(stateRef: string): Promise<PrivateStateReadResult>;
  /** Synchronous fence; pending reads observe it at their next check. */
  stop(): void;
  whenIdle(): Promise<void>;
}

interface CursorFacts {
  readonly profile: string; readonly house: { readonly origin: string; readonly houseKey: string; readonly incarnation: string };
  readonly actorId: string; readonly capabilityRevision: string; readonly afterMessageId: string;
}
function cursorOf(evidence: FirstReleasePrivateEvidence, afterMessageId: string): string {
  return JSON.stringify({
    profile: CURSOR_PROFILE, house: { ...evidence.house }, actorId: evidence.recipientId,
    capabilityRevision: evidence.capabilityRevision, afterMessageId,
  });
}

export function createPrivateMessageReader(options: PrivateMessageReaderOptions): PrivateMessageReader {
  const { executionDb, gate, recipientId, recipient, isOfficialActor } = options;
  assertPrivateMessageJournalSchema(executionDb);
  const localStop = new AbortController();
  const signal = AbortSignal.any([gate.signal, localStop.signal]);
  let stopped = false;
  let tail = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(() => {}, () => {});
    return result;
  };
  const fence = (): boolean => !stopped && !signal.aborted && gate.isActive();
  const checkedAssert = (): void => {
    if (!fence()) throw new Error('PRIVATE_READER_STOPPED');
    options.assertCurrent();
  };
  const currentEvidence = (): FirstReleasePrivateEvidence => {
    const picked = selectFirstReleasePrivateEvidence(options.view(), recipientId);
    if (!picked.available) throw new Error(picked.reason);
    if (picked.evidence.house.origin !== gate.origin) throw new Error('PRIVATE_GATE_HOUSE_MISMATCH');
    return picked.evidence;
  };
  const toUnavailable = (error: unknown): { status: 'unavailable'; reason: string } => ({
    status: 'unavailable',
    reason: error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message) ? error.message : 'PRIVATE_READER_FAILED',
  });

  const buildItem = (validated: RevalidatedPrivateMessage, consumerPending: boolean, capabilityRevision: string): PrivateMessageListItem => {
    const wrapper = validated.wrapper;
    const summary = typeof wrapper.summary === 'string' ? wrapper.summary : null;
    const body = wrapper.body && typeof wrapper.body === 'object' && !Array.isArray(wrapper.body)
      ? structuredClone(wrapper.body) as Readonly<Record<string, unknown>> : null;
    const material = {
      messageId: validated.facts.messageId, eventId: validated.facts.eventId,
      kind: validated.kindEvidence.kind, deliveryClass: validated.deliveryClass, senderId: validated.senderId,
      capabilityRevision, summary, body,
      stateRef: typeof wrapper.state_ref === 'string' ? wrapper.state_ref : null,
      stateRevision: typeof wrapper.state_revision === 'string' ? wrapper.state_revision : null,
      local: {
        consumerPending, envelopeDigest: validated.facts.envelopeDigest,
        plaintextDigest: validated.facts.plaintextDigest, wrapperDigest: validated.facts.wrapperDigest,
      },
    };
    // serializedBytes counts the item's OWN final JSON serialization,
    // including this field's digits (converges in a couple of iterations).
    let size = jsonBytes({ ...material, serializedBytes: 0 });
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = jsonBytes({ ...material, serializedBytes: size });
      if (next === size) break;
      size = next;
    }
    return { ...material, serializedBytes: size };
  };
  const revalidateRow = (row: { message_id: string; event_id: string; envelope_bytes: Uint8Array; plaintext_bytes: Uint8Array; envelope_digest: string; plaintext_digest: string; wrapper_digest: string }, evidence: FirstReleasePrivateEvidence) =>
    revalidateStoredPrivateMessage({
      envelopeBytes: row.envelope_bytes, plaintextBytes: row.plaintext_bytes,
      stored: { messageId: row.message_id, eventId: row.event_id, envelopeDigest: row.envelope_digest,
        plaintextDigest: row.plaintext_digest, wrapperDigest: row.wrapper_digest },
      selection: { available: true, evidence }, recipient, isOfficialActor,
      signal, onAsyncBoundary: () => { checkedAssert(); },
    });
  const okPage = (items: PrivateMessageListItem[], invalid: { messageId: string; reason: string }[], nextCursor: string | null,
    scannedRows: number, scannedBytes: number, truncatedByScan: boolean) =>
    ({ status: 'ok' as const, items, invalid, nextCursor, scannedRows, scannedBytes, truncatedByScan });

  const list = (query: PrivateMessageListQuery = {}): Promise<PrivateMessageListResult> => serial(async () => {
    try {
      checkedAssert();
      const evidence = currentEvidence();
      const binding = privateMessageBindingId(evidence);
      const limit = query.limit === undefined ? LIST_LIMIT_MAX
        : Number.isSafeInteger(query.limit) && query.limit >= 1 && query.limit <= LIST_LIMIT_MAX ? query.limit : undefined;
      const budget = query.maxPageBytes === undefined ? 64 * 1024
        : Number.isSafeInteger(query.maxPageBytes) && query.maxPageBytes >= 1 && query.maxPageBytes <= 64 * 1024 ? query.maxPageBytes : undefined;
      if (limit === undefined) return { status: 'cursor_rejected', reason: 'PRIVATE_LIST_LIMIT_INVALID' };
      if (budget === undefined) return { status: 'cursor_rejected', reason: 'PRIVATE_PAGE_BUDGET_INVALID' };
      let afterMessageId = '';
      let incomingCursor: string | null = null;
      if (query.cursor !== undefined) {
        incomingCursor = query.cursor;
        if (query.cursor.length > CURSOR_MAX_BYTES) return { status: 'cursor_rejected', reason: 'PRIVATE_CURSOR_SIZE_INVALID' };
        let facts: CursorFacts;
        try { facts = JSON.parse(query.cursor) as CursorFacts; } catch { return { status: 'cursor_rejected', reason: 'PRIVATE_CURSOR_INVALID' }; }
        if (facts?.profile !== CURSOR_PROFILE || facts.actorId !== recipientId
          || facts.capabilityRevision !== evidence.capabilityRevision
          || JSON.stringify(facts.house) !== JSON.stringify({ ...evidence.house })
          || typeof facts.afterMessageId !== 'string' || !ID_PATTERN.test(facts.afterMessageId))
          return { status: 'cursor_rejected', reason: 'PRIVATE_CURSOR_SCOPE_MISMATCH' };
        afterMessageId = facts.afterMessageId;
      }

      // Inspect at most 256 distinct row headers, including rejected rows.
      // A full header window always returns a continuation (an extra empty page
      // is safe); no lookahead row or oversized-only window can certify EOF.
      const plan = planPrivateMessageRows(executionDb, binding, afterMessageId, SCAN_ROWS_MAX);
      const items: PrivateMessageListItem[] = [];
      const invalid: { messageId: string; reason: string }[] = [];
      let scannedRows = 0, scannedBytes = 0;
      let lastProcessedId = afterMessageId;
      const fullWindow = plan.length === SCAN_ROWS_MAX;
      // Each snapshot accounts for the ACTUAL complete response. Notes are
      // optional diagnostics; drop notes before ever excluding valid material.
      // Keep the last fitting snapshot so later counters/notes cannot force us
      // to shed an item and accidentally advance its cursor or claim EOF.
      const fit = (nextCursor: string | null, truncated: boolean) => {
        const notes = invalid.slice();
        let page = okPage(items.slice(), notes, nextCursor, scannedRows, scannedBytes, truncated);
        while (jsonBytes(page) > budget && notes.length) {
          notes.pop();
          page = okPage(items.slice(), notes, nextCursor, scannedRows, scannedBytes, truncated);
        }
        return jsonBytes(page) <= budget ? page : null;
      };
      let lastPage = fit(plan.length ? cursorOf(evidence, afterMessageId) : null, false);
      for (let index = 0; index < plan.length; index++) {
        checkedAssert();
        const entry = plan[index]!;
        const oversized = entry.plaintextBytes > PRIVATE_MESSAGE_MAX_PLAINTEXT
          ? 'PRIVATE_ROW_PLAINTEXT_OVER_SIZE'
          : entry.envelopeBytes > PRIVATE_MESSAGE_SCAN_BYTES_MAX ? 'PRIVATE_ROW_OVER_SCAN_BUDGET' : null;
        if (!oversized && scannedBytes + entry.envelopeBytes > PRIVATE_MESSAGE_SCAN_BYTES_MAX) {
          // Leave this unexamined body's position available to the next call.
          const page = fit(cursorOf(evidence, lastProcessedId), true);
          checkedAssert();
          return page ?? lastPage ?? { status: 'item_over_budget', messageId: entry.message_id,
            budgetBytes: budget, itemBytes: jsonBytes(okPage([], [], cursorOf(evidence, lastProcessedId), scannedRows, scannedBytes, true)), cursor: incomingCursor };
        }
        scannedRows++;
        let reason = oversized;
        let item: PrivateMessageListItem | undefined;
        if (!oversized) {
          // Bounds participate in the SAME SQL statement that selects the
          // BLOBs. A later row may change during an earlier schema-worker await;
          // exact ids alone do not prevent oversized materialization.
          const bounded = readPrivateMessageRowBounded(executionDb, binding, entry.message_id, entry);
          if (!bounded) reason = 'PRIVATE_ROW_CHANGED_OR_MISSING';
          else if ('oversized' in bounded) reason = bounded.oversized;
          else {
            scannedBytes += bounded.row.envelope_bytes.length;
            const validated = await revalidateRow(bounded.row, evidence);
            checkedAssert();
            if (!validated.ok) reason = validated.reason;
            else item = buildItem(validated.message, bounded.row.consumer_pending === 1, evidence.capabilityRevision);
          }
        }
        if (reason && invalid.length < INVALID_NOTES_MAX) invalid.push({ messageId: entry.message_id, reason });
        if (item) items.push(item);
        const more = index + 1 < plan.length || fullWindow;
        const nextCursor = more ? cursorOf(evidence, entry.message_id) : null;
        const page = fit(nextCursor, fullWindow && index + 1 === plan.length);
        if (!page) {
          checkedAssert();
          if (item && items.length === 1) {
            // Exact single-item eligibility, with no guessed cursor reserve.
            return { status: 'item_over_budget', messageId: item.messageId, budgetBytes: budget,
              itemBytes: jsonBytes(okPage([item], [], nextCursor, scannedRows, scannedBytes, fullWindow && index + 1 === plan.length)), cursor: incomingCursor };
          }
          if (lastPage) return lastPage;
          return { status: 'item_over_budget', messageId: entry.message_id, budgetBytes: budget,
            itemBytes: jsonBytes(okPage([], [], nextCursor, scannedRows, scannedBytes, fullWindow && index + 1 === plan.length)), cursor: incomingCursor };
        }
        lastProcessedId = entry.message_id;
        lastPage = page;
        if (items.length >= limit) break;
      }
      checkedAssert();
      return lastPage ?? { status: 'item_over_budget', messageId: '', budgetBytes: budget,
        itemBytes: jsonBytes(okPage([], [], null, 0, 0, false)), cursor: incomingCursor };
    } catch (error) {
      return toUnavailable(error);
    }
  });

  const readMessage = (messageId: string): Promise<PrivateMessageReadResult> => serial(async () => {
    try {
      checkedAssert();
      const evidence = currentEvidence();
      const binding = privateMessageBindingId(evidence);
      const bounded = readPrivateMessageRowBounded(executionDb, binding, messageId);
      if (!bounded) return { status: 'not_found' } as const;
      if ('oversized' in bounded) return { status: 'invalid', reason: bounded.oversized } as const;
      const validated = await revalidateRow(bounded.row, evidence);
      if (!validated.ok) return { status: 'invalid', reason: validated.reason } as const;
      checkedAssert();
      return { status: 'ok', message: {
        item: buildItem(validated.message, bounded.row.consumer_pending === 1, evidence.capabilityRevision),
        originalText: validated.message.originalText,
        envelopeBytes: new Uint8Array(validated.message.envelopeBytes),
        plaintextBytes: new Uint8Array(validated.message.plaintextBytes),
      } } as const;
    } catch (error) {
      return toUnavailable(error);
    }
  });

  const readState = (stateRef: string): Promise<PrivateStateReadResult> => serial(async () => {
    try {
      checkedAssert();
      const evidence = currentEvidence();
      const binding = privateMessageBindingId(evidence);
      const row = readPrivateStateRow(executionDb, binding, stateRef);
      if (!row) return { status: 'not_found' } as const;
      const message = readPrivateMessageRowBounded(executionDb, binding, row.message_id);
      let messageValid = false; let reason: string | undefined = 'PRIVATE_STATE_MESSAGE_MISSING';
      if (message) {
        if ('oversized' in message) { messageValid = false; reason = message.oversized; }
        else {
          const validated = await revalidateRow(message.row, evidence);
          if (validated.ok) {
            const wrapper = validated.message.wrapper;
            if (wrapper.state_ref !== stateRef || String(wrapper.state_revision) !== row.revision
              || privateMessageStateDigest(wrapper) !== row.state_digest) {
              messageValid = false; reason = 'PRIVATE_STATE_ANCHOR_MISMATCH';
            } else { messageValid = true; reason = undefined; }
          } else {
            messageValid = false; reason = validated.reason;
          }
        }
      }
      checkedAssert();
      return { status: 'ok', state: { stateRef: row.state_ref, revision: row.revision, messageId: row.message_id, stateDigest: row.state_digest, messageValid, ...(reason ? { reason } : {}) } } as const;
    } catch (error) {
      return toUnavailable(error);
    }
  });

  return {
    list, readMessage, readState,
    stop(): void { stopped = true; localStop.abort(); },
    whenIdle: () => tail,
  };
}
