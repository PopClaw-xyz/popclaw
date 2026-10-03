import nacl from 'tweetnacl';
import { request } from 'undici';
import type { Signer } from '../identity/signer.js';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';
import { pullSigningBytes, syncReplySigningBytes, type SyncReply, type SyncState } from './canvas-signing.js';
import type { FetchJson } from './intent-pull-client.js';
import type { PostJson } from './pair-claim.js';
import { viewingSignal, type ViewingSignal } from './viewing-signal.js';

/**
 * The plugin's half of the page-state sync round-trip: answering, for the
 * owner and about the owner only, "which of the people on this page do I
 * follow".
 *
 * Canvas cannot ask a house this any more, so it asks here, and the answer is
 * the only reason a chip on a newspaper can say anything true. Everything the
 * answer is bound to — one challenge, one page's exact bytes, one reader, one
 * minute, one Canvas — lives in the signed bytes, not in this transport.
 *
 * What this module owes beyond signing: it is the last place that can refuse.
 * Canvas derives the author list from the page it stores, so a question is
 * already a subset of some page — but this side cannot see that page and must
 * not take it on faith. Hence the refusals in `admissible`, each of which
 * bounds what one canvas can learn even if its question-building were wrong.
 */

/** Most names we will answer about in one question. Past a real paper's worth
 *  of authors, a question stops looking like a page and starts looking like a
 *  list. */
export const SYNC_AUTHOR_CAP = 200;

/**
 * How often we will answer about the SAME page.
 *
 * Deliberately shorter than the canvas answer TTL (apps/popclaw-canvas
 * src/sync-store.ts, ANSWER_TTL_MS): this is a brake on being asked
 * repeatedly, and it must never become the reason a page stays stale after
 * the owner follows someone.
 */
export const SAME_PAGE_MIN_INTERVAL_MS = 5 * 60_000;

/** Half the reply's validity window, centred on now.
 *
 *  The canvas judges the window against ITS clock while we build it from
 *  OURS, so this IS the clock-skew tolerance, and at 30s a machine a minute
 *  out failed every reply for good — a silent, permanent outage whose only
 *  symptom is chips that never colour. Matched to the ±60s the pull
 *  credential already allows; the verifier's cap moved to 120s to fit. */
const REPLY_SKEW_MS = 60_000;

const NONCE_BYTES = 12;

/** One question, as it arrives on the wire. Everything here is untrusted. */
interface WireRequest {
  request_id: string;
  canvas_id: string;
  page_digest: string;
  viewer: string;
  authors: string[];
  not_after: number;
}

export interface SyncAnswerClient {
  /** One pass: take whatever is waiting and answer what we should. Resolves to
   *  the number of answers the canvas accepted. Throws on transport failure —
   *  the caller owns backoff, like the intent pull. */
  answerPending(): Promise<number>;
}

export function makeSyncAnswerClient(opts: {
  baseUrl: string;
  signer: Signer;
  /** This owner's own state toward one person. Kept outside so the caller
   *  decides what `unknown` means — today the relation projection answers
   *  follows/none; a reader whose own relation log has an open gap for that
   *  house should answer `unknown`, because "none" would be a lie. */
  stateOf: (author: string) => SyncState;
  fetchJson?: FetchJson;
  postJson?: PostJson;
  clock?: () => number;
}): SyncAnswerClient {
  const fetchJson = opts.fetchJson ?? undiciFetchJson;
  const postJson = opts.postJson ?? undiciPostJson;
  const clock = opts.clock ?? Date.now;
  const base = opts.baseUrl.replace(/\/$/, '');
  /* Derived on the first tick, NOT at construction. `canvas_base_url` is
   * plugin config and has never been validated as a URL (canvas-fallback.ts
   * only strips a trailing slash), so parsing it eagerly would let one typo
   * throw inside register() and take the whole plugin down with it — the
   * opposite of ADR-0035's "loading must be cheap and must not fail". A bad
   * value costs this one leg a tick and a backoff, and nothing else. */
  let canvasOrigin: string | null = null;
  /** Page digest → when we last answered about it. In memory: a restart costs
   *  one extra answer, which is the cheap direction to be wrong in. */
  const answeredAt = new Map<string, number>();

  return {
    async answerPending(): Promise<number> {
      if (canvasOrigin === null) canvasOrigin = new URL(base).origin; // throws → this leg backs off, nothing else
      const self = await opts.signer.popclawId();
      const nonce = Buffer.from(nacl.randomBytes(NONCE_BYTES)).toString('base64url');
      const ts = clock();
      const sig = await opts.signer.sign(pullSigningBytes(self, nonce, ts));
      const res = await fetchJson(`${base}/v1/sync-requests?owner=${encodeURIComponent(self)}`, {
        'X-Popclaw-Id': self,
        'X-Nonce': nonce,
        'X-Ts': String(ts),
        'X-Signature': Buffer.from(sig).toString('base64'),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`sync request pull failed: ${res.status} ${res.text}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        throw new Error('sync request pull: server returned a non-JSON 200');
      }
      const requests = (parsed as { requests?: unknown }).requests;
      // A malformed 200 must not read as "nothing to answer" — that would be
      // indistinguishable from a healthy quiet canvas.
      if (!Array.isArray(requests)) throw new Error('sync request pull: server returned a malformed 200');

      // The brake map is bounded here rather than left to grow for the life of
      // the process: one entry per page ever answered is small, but nothing
      // else would ever remove it.
      for (const [digest, at] of answeredAt) {
        if (clock() - at >= SAME_PAGE_MIN_INTERVAL_MS) answeredAt.delete(digest);
      }

      let accepted = 0;
      for (const raw of requests) {
        const q = admissible(raw as WireRequest, self, clock(), answeredAt);
        if (q === null) continue;
        const reply = buildReply(q, self, canvasOrigin, clock(), opts.stateOf);
        const signature = Buffer.from(await opts.signer.sign(syncReplySigningBytes(reply))).toString('base64');
        const out = await postJson(
          `${base}/v1/sync-reply`,
          { 'Content-Type': 'application/json' },
          JSON.stringify({ reply, signature }),
        );
        // Marked on the attempt, not on success: a canvas that refuses our
        // answers must not be able to make us re-sign the same page in a loop.
        answeredAt.set(q.page_digest, clock());
        if (out.status >= 200 && out.status < 300) accepted += 1;
      }
      return accepted;
    },
  };
}

/**
 * The question, if we should answer it at all — otherwise null.
 *
 * Every clause is a refusal this side owes regardless of what the canvas
 * believes it asked:
 *  - it must be about US. A signature is the only thing that makes an answer
 *    ours, so signing one about another reader is the unrecoverable move.
 *  - it must be a page's worth of names, not a list.
 *  - it must not be the page we just answered.
 *  - no field may carry the separator: the signed encoding is unambiguous
 *    only while none does, and all of this arrived as parsed JSON.
 */
function admissible(
  q: WireRequest,
  self: string,
  nowMs: number,
  answeredAt: ReadonlyMap<string, number>,
): WireRequest | null {
  if (q === null || typeof q !== 'object') return null;
  const NUL = String.fromCharCode(0);
  for (const f of [q.request_id, q.canvas_id, q.page_digest, q.viewer]) {
    if (typeof f !== 'string' || f.length === 0 || f.includes(NUL)) return null;
  }
  if (q.viewer !== self) return null;
  if (!Array.isArray(q.authors) || q.authors.length === 0 || q.authors.length > SYNC_AUTHOR_CAP) return null;
  if (q.authors.some((a) => typeof a !== 'string' || a.length === 0 || a.includes(NUL))) return null;
  if (!Number.isFinite(q.not_after) || nowMs > q.not_after) return null;
  const last = answeredAt.get(q.page_digest);
  if (last !== undefined && nowMs - last < SAME_PAGE_MIN_INTERVAL_MS) return null;
  return q;
}

/** The reply, in the one shape both ends rebuild the bytes from. Sorted and
 *  deduped because the verifier refuses any other order — one set of answers
 *  must have exactly one encoding. */
function buildReply(
  q: WireRequest,
  self: string,
  canvasOrigin: string,
  nowMs: number,
  stateOf: (author: string) => SyncState,
): SyncReply {
  const authors = [...new Set(q.authors)].sort();
  return {
    requestId: q.request_id,
    canvasId: q.canvas_id,
    pageDigest: q.page_digest,
    viewer: self,
    notBeforeMs: nowMs - REPLY_SKEW_MS,
    notAfterMs: nowMs + REPLY_SKEW_MS,
    canvasOrigin,
    states: authors.map((a) => [a, stateOf(a)] as const),
  };
}

/** Default seams — the same undici mechanics and read-tier budget the other
 *  two canvas clients use (both timeouts set; one alone caps nothing). */
async function undiciFetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const res = await request(url, {
    method: 'GET',
    headers,
    headersTimeout: LORE_HOUSE_TIMEOUT_MS,
    bodyTimeout: LORE_HOUSE_TIMEOUT_MS,
  });
  return { status: res.statusCode, text: await res.body.text() };
}

async function undiciPostJson(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  const res = await request(url, {
    method: 'POST',
    headers,
    body,
    headersTimeout: LORE_HOUSE_TIMEOUT_MS,
    bodyTimeout: LORE_HOUSE_TIMEOUT_MS,
  });
  return { status: res.statusCode, text: await res.body.text() };
}

// ---------------------------------------------------------------------------
// The starter — the one call every resident root makes
// ---------------------------------------------------------------------------

/**
 * How often we ask the canvas what it is holding.
 *
 * Flat, and deliberately so: there is no push channel from the canvas, so an
 * adaptive cadence could only be fast AFTER the first page of a reading
 * session — the one it would need to be fast for. The cost of flat is a
 * ~100-byte signed GET a minute; backoff is kept for failure, the one case
 * where continuing at full rate would be wrong.
 */
export const PAGE_STATE_TICK_MS = 60 * 1000;
export const PAGE_STATE_MAX_BACKOFF_MS = 15 * 60 * 1000;

/**
 * What a root has to hand. Not gated by the house duty token the doorbell
 * uses, and that is a decision, not an omission: that gate exists because the
 * doorbell WRITES (it claims pending rows through a shared mutex). This leg
 * writes nothing locally, and two roots on one data root would produce the
 * same signed answer from the same key — the challenge is spent on first use,
 * so the loser of the race gets a 404 and moves on.
 */
export interface PageStateSyncDeps {
  /**
   * `canvas_base_url`. Absent = no publisher, so there are no pages and
   * nothing can ever be asked about them. The loop then never starts.
   */
  readonly baseUrl?: string | null;
  readonly signer: Signer;
  /** This owner's own state toward one person — see `makeSyncAnswerClient`. */
  readonly stateOf: (author: string) => SyncState;
  readonly logger?: { info(m: string): void };
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  /** Test seam; the roots build the real signed client. */
  readonly client?: SyncAnswerClient;
  /**
   * Where an accepted answer is recorded, for the follow doorbell to pace off.
   * Defaults to the one per-process instance, which is what every root wants —
   * see `viewing-signal.ts`.
   */
  readonly viewing?: ViewingSignal;
}

export interface PageStateSyncLoop {
  /** Stop the loop. Safe before, during and after the first tick. */
  readonly stop: () => void;
  /** Resolves when the first tick has settled. Never rejects. */
  readonly firstTick: Promise<void>;
}

/**
 * Answer now, then every interval, until `stop`.
 *
 * Its own loop, NOT a passenger on the doorbell tick, because the two are
 * paced by different things. The doorbell's tiers are set by how fresh a paper
 * is; a page-state question is created the moment ANY page is opened, which
 * has nothing to do with when it was published. Riding that tick would leave a
 * week-old paper's chips waiting half an hour for state the reader's browser
 * gives up on after two minutes.
 */
export function startPageStateSync(deps: PageStateSyncDeps): PageStateSyncLoop {
  const logger = deps.logger;
  const baseUrl = deps.baseUrl;
  if (!baseUrl) {
    logger?.info('popclaw: page-state sync not started — no publisher configured');
    return { stop: () => {}, firstTick: Promise.resolve() };
  }
  const client =
    deps.client ?? makeSyncAnswerClient({ baseUrl, signer: deps.signer, stateOf: deps.stateOf });
  const tickMs = deps.intervalMs ?? PAGE_STATE_TICK_MS;
  const maxMs = deps.maxBackoffMs ?? PAGE_STATE_MAX_BACKOFF_MS;
  const viewing = deps.viewing ?? viewingSignal;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let consecutiveFailures = 0;

  const loop = async (): Promise<void> => {
    try {
      // The count is logged, not discarded. Everything that can go wrong with
      // this leg — clock skew, a signing-twin drift, changed chip markup, a
      // wrong canvas_base_url — lands as "chips never colour" and nothing
      // else; without a line saying answers were accepted there is no way to
      // tell a working leg from a dead one.
      const accepted = await client.answerPending();
      if (accepted > 0) {
        logger?.info(`popclaw: answered ${accepted} page-state question(s)`);
        // Same condition as the line above, and for the same reason: an
        // accepted answer is the one observable here that a paired browser of
        // this identity has a paper open. The doorbell reads it to poll for the
        // ➕ that tends to follow within minutes — cadence only, nothing about
        // what gets pulled. Answers the canvas refused are deliberately not
        // counted: a canvas that rejects our replies is not evidence of
        // anything, and this must not become a way to hold the doorbell hot.
        viewing.noteAnswer();
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      // Info, not warn: a canvas that is down is the ordinary state of a
      // plugin whose owner rarely publishes, and this loop runs every minute.
      // A warn a minute would bury the real ones.
      logger?.info(`popclaw: page-state sync tick failed (non-fatal): ${String(err)}`);
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), Math.min(tickMs * 2 ** consecutiveFailures, maxMs));
    // Never worth keeping a process alive for (ADR-0035's discipline).
    timer.unref?.();
  };

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    // Not awaited at the root: startup must not wait on a network round trip,
    // and the first question can only exist once somebody opens a page.
    firstTick: loop(),
  };
}
