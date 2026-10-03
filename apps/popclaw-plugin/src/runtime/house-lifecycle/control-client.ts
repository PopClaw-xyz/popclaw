/**
 * ADR-0051 S2 — house-session control-plane client: origin normalization,
 * manifest discovery, request signing/sending, ack verification.
 *
 * Fail closed: if any step does not hold (address not normalizable, house
 * declares no board, ack not signed by the expected house key, cross-origin
 * redirect), no "remote confirmed" is ever produced; unknown targets never
 * fall back to the home house. Redirects are never followed
 * (redirect: 'error').
 */

import { popclaw } from '@popclaw/contracts';
import { isHouseSessionBoard, type HouseSessionBoard } from '@popclaw/contracts';
import {
  canonicalRequestCore,
  requestSigningInput,
  ackSigningInput,
  stripDefaultKeys,
} from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export type { HouseSessionBoard };
/** The optional manifest board is discovery-only; absent ⇒ unsupported. */
export type { HouseSessionBoard as SessionBoard };

const ns = (popclaw as unknown as {
  housesession: {
    HouseSessionRequest: { encode(m: unknown): { finish(): Uint8Array } };
    HouseSessionAck: { decode(b: Uint8Array): Record<string, unknown> };
  };
}).housesession;

/** Hard per-stage wall deadline for EVERY await inside a control request:
 * key fetch, signing, the transport, and the body read. A signer or
 * transport that never resolves (and ignores its abort signal) still
 * releases the caller within this bound — the resume drain's "bounded"
 * claim depends on it (resume-review probe 1: a hung sign stage sits
 * BEFORE any abort signal exists, so signal-only bounds cannot cover it). */
export const CONTROL_STAGE_DEADLINE_MS = 30_000;

/** Race `stage` against a wall deadline and (when given) an abort signal.
 * Late resolution after a timeout/abort is dropped: zero side effects —
 * and the stage's OWN rejection is ALWAYS consumed (a no-op catch is
 * attached even on the early-abort path), so a hostile signer/fetch that
 * later rejects never surfaces as an unhandledRejection. */
function boundedStage<T>(
  stage: Promise<T>,
  what: string,
  signal?: AbortSignal,
  deadlineMs: number = CONTROL_STAGE_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    // Consume the stage regardless of who wins the race: attach FIRST so
    // the early-abort return below cannot leave the promise unhandled.
    stage.then(
      (value) => done(() => resolve(value)),
      (err) => done(() => reject(err)),
    );
    const timer = setTimeout(
      () => done(() => reject(new Error(`${what} timed out after ${deadlineMs}ms`))),
      deadlineMs,
    );
    function onAbort() {
      done(() => reject(new Error(`${what} aborted`)));
    }
    function done(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const HOUSE_SESSION_ENDPOINT = '/v1/house-session';

/** Minimal signing identity surface (MasterKeySigner satisfies it). */
export interface ControlSigner {
  publicKey(): Promise<Uint8Array>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  popclawId(): Promise<string>;
}

/**
 * Canonical origin (ADR-0051 §3):
 * - bare domains -> https; explicit http allowed only for loopback fixtures
 *   (localhost/127.x/[::1]).
 * - ports preserved; scheme/host lowercased; explicit URL paths stripped
 *   (v1 is root-origin only). Bare inputs must not contain a path.
 * - rejected: backslashes, userinfo, query/fragment, non-http(s),
 *   protocol-relative.
 */
export function normalizeHouseOrigin(input: string): string {
  const raw = input.trim();
  if (!raw || /\s/.test(raw) || raw.includes('\\')) {
    throw new Error(`invalid house address: ${input}`);
  }
  // Protocol-relative (//host) is rejected explicitly: the URL parser
  // swallows extra leading slashes for special schemes and would turn it
  // into a valid https URL — but browsers resolve it against the current
  // page's scheme, the classic cross-origin smuggling shape.
  if (raw.startsWith('//')) {
    throw new Error(`protocol-relative house address: ${input}`);
  }
  const explicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  // URL's special-scheme parser turns /private/file into a host named
  // "private". Reject filesystem/path input before adding the HTTPS scheme.
  if (!explicitScheme && raw.includes('/')) {
    throw new Error(`house address must be a domain or full URL: ${input}`);
  }
  const withScheme = explicitScheme ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`invalid house address: ${input}`);
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'https:' && scheme !== 'http:') {
    throw new Error(`non-http(s) house address: ${input}`);
  }
  if (scheme === 'http:') {
    const host = url.hostname.toLowerCase();
    const loopback =
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
    if (!loopback) {
      throw new Error(`plain http only allowed for local fixtures: ${input}`);
    }
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`house address must be a bare origin: ${input}`);
  }
  if (!url.hostname) {
    throw new Error(`house address has no host: ${input}`);
  }
  const port = url.port ? `:${url.port}` : '';
  return `${scheme}//${url.hostname.toLowerCase()}${port}`;
}

export type LifecycleFetch = typeof fetch;

/** Network-layer failure (unreachable/interrupted) — distinct from "house
 * does not exist / response invalid". */
export class LifecycleNetworkError extends Error {
  constructor(cause: unknown) {
    super(`manifest network error: ${String(cause)}`);
  }
}

export interface SessionManifest {
  readonly board: HouseSessionBoard | null;
  /** Absence differs from a present null/invalid/partial declaration. */
  readonly sessionBoardAbsent: boolean;
  readonly rawBytes: Uint8Array;
  readonly proofHeader: string | null;
}
export const MAX_SESSION_MANIFEST_BYTES = 1024 * 1024;

/** Preserve the exact response once: a proof must never authenticate a
 * reserialized JSON object or a second fetch from another board revision. */
export async function fetchSessionManifest(
  origin: string,
  fetchImpl: LifecycleFetch,
  signal?: AbortSignal,
): Promise<SessionManifest> {
  const transportSignal = composeSignals(signal, AbortSignal.timeout(CONTROL_STAGE_DEADLINE_MS));
  let resp: Response;
  try {
    if (transportSignal.aborted) throw new Error('manifest fetch aborted');
    resp = await boundedStage(fetchImpl(`${origin}/v1/manifest`, {
      // Timeout ALWAYS applies; a caller signal composes with it (finding 3:
      // `??` let a signal cancel the timeout entirely).
      signal: transportSignal,
      redirect: 'error',
      headers: { accept: 'application/json' },
    }), 'manifest fetch', transportSignal);
  } catch (err) {
    throw new LifecycleNetworkError(err);
  }
  if (!resp.ok) {
    // 5xx/429: server or path trouble — classify as UNKNOWN (retryable), not
    // an invalid address.
    if (resp.status >= 500 || resp.status === 429) {
      throw new LifecycleNetworkError(`HTTP ${resp.status}`);
    }
    throw new Error(`manifest fetch failed: HTTP ${resp.status}`);
  }
  let rawBytes: Uint8Array;
  try {
    rawBytes = await boundedStage(readManifestBytes(resp, transportSignal), 'manifest body', transportSignal);
  } catch (err) {
    if (err instanceof ManifestLimitError) throw err;
    throw new LifecycleNetworkError(err);
  }
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(rawBytes)); }
  catch { throw new Error('manifest fetch failed: invalid JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest fetch failed: invalid JSON');
  const board = (manifest as Record<string, unknown>)['house_session'];
  return {board: isHouseSessionBoard(board) ? board : null, sessionBoardAbsent: !Object.hasOwn(manifest, 'house_session'), rawBytes,
    proofHeader: resp.headers.get('X-Popclaw-Manifest-Proof')};
}

class ManifestLimitError extends Error {}
async function readManifestBytes(resp: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = resp.headers.get('content-length');
  if (declared && Number(declared) > MAX_SESSION_MANIFEST_BYTES) {
    void resp.body?.cancel().catch(() => {});
    throw new ManifestLimitError('manifest exceeds 1 MiB');
  }
  if (!resp.body) return new Uint8Array();
  const reader = resp.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, {once: true});
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('manifest body aborted');
      const {done, value} = await reader.read();
      if (signal.aborted) throw new Error('manifest body aborted');
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SESSION_MANIFEST_BYTES) {abort();throw new ManifestLimitError('manifest exceeds 1 MiB');}
      chunks.push(new Uint8Array(value));
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset);offset += chunk.byteLength;}
    return bytes;
  } finally {signal.removeEventListener('abort', abort);reader.releaseLock();}
}

/** Compatibility API for consumers that only need the session board. */
export async function fetchSessionBoard(origin: string, fetchImpl: LifecycleFetch, signal?: AbortSignal): Promise<HouseSessionBoard | null> {
  return (await fetchSessionManifest(origin, fetchImpl, signal)).board;
}


export type ControlOperation = 'enter' | 'renew' | 'leave' | 'status';

export interface ControlRequestOptions {
  opSeq: number;
  requestId: string;
  installationId: string;
  targetSessionId?: string;
  expectedHouseRevision?: number;
  nonce?: string;
  /** Signature validity window (milliseconds). */
  validityMs?: number;
  clock?: () => number;
  /** Rides the request: an aborted signal tears down an in-flight fetch. */
  signal?: AbortSignal;
  /**
   * Final pre-send authorization, invoked AFTER every internal await (key
   * fetch, signing) and immediately before the fetch leaves. A cross-manager
   * logout committed to the shared SQLite while this call was signing shows
   * up HERE — a local AbortSignal alone cannot see it (finding 1). Throw to
   * cancel the send.
   */
  authorizeSend?: () => void;
}

export interface ControlAck {
  outcome: number;
  errorCode: number;
  sessionId: string;
  sessionActive: boolean;
  houseRevision: number;
  leaseExpiresAt: number;
  inboxReadToken: string;
  serverCommittedAt: number;
  detail: string;
  /** True only after verification (expected house key + matched to THIS request). */
  verified: boolean;
}

export class HouseSessionControlClient {
  constructor(
    private readonly origin: string,
    private readonly signer: ControlSigner,
    private readonly board: HouseSessionBoard,
    private readonly fetchImpl: LifecycleFetch,
    private readonly expectedAckPubkeyHex: string = board.ack_pubkey,
    /** Millisecond clock (same contract as the manager); divided by 1000 exactly once. */
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async enter(opts: ControlRequestOptions): Promise<ControlAck> {
    return this.request('enter', opts);
  }

  async renew(opts: ControlRequestOptions): Promise<ControlAck> {
    return this.request('renew', opts);
  }

  async leave(opts: ControlRequestOptions): Promise<ControlAck> {
    return this.request('leave', opts);
  }

  async status(opts: ControlRequestOptions): Promise<ControlAck> {
    return this.request('status', opts);
  }

  private async request(
    op: ControlOperation,
    opts: ControlRequestOptions,
  ): Promise<ControlAck> {
    // Clock contract (S2a review): milliseconds. Divided by 1000 exactly
    // once here — the old default was already seconds, and dividing twice
    // shrank signature timestamps by 1000x.
    const now = Math.floor(this.clock() / 1000);
    const validity = Math.floor((opts.validityMs ?? 60_000) / 1000);
    const core = stripDefaultKeys({
      operation: OPERATION_VALUES[op],
      popclawId: await boundedStage(this.signer.popclawId(), 'control popclawId', opts.signal),
      installationId: opts.installationId,
      opSeq: opts.opSeq,
      requestId: opts.requestId,
      houseOrigin: this.origin,
      issuedAt: now,
      expiresAt: now + validity,
      nonce: opts.nonce ?? `n-${opts.requestId}-${now}`,
      expectedHouseRevision: opts.expectedHouseRevision ?? 0,
      targetSessionId: opts.targetSessionId ?? '',
    });
    // Signing input and wire bytes share one source: the canonical core
    // (no explicit proto3 defaults). Bounded: a hung signer must not park
    // the worker (or an ownership recovery drain) forever — the sign stage
    // predates every abort signal, so only a wall deadline covers it.
    const signature = await boundedStage(
      this.signer.sign(requestSigningInput(core)),
      'control sign',
      opts.signal,
    );
    const body = ns.HouseSessionRequest.encode({
      core,
      signature,
      signerPubkey: await boundedStage(this.signer.publicKey(), 'control publicKey', opts.signal),
    }).finish();

    // Never issue the fetch when the caller's signal already aborted or the
    // caller's persistent-row authorization no longer holds (the signing
    // await may have straddled a logout — review counter-example 2 + finding
    // 1: another MANAGER's logout is invisible to a local signal, so the
    // caller-supplied check runs here too, after every internal await).
    if (opts.signal?.aborted) {
      throw new Error('request aborted before send');
    }
    opts.authorizeSend?.();
    // Every control request is bounded: caller signal ∪ 30s timeout. A wedged
    // fetch must not hang a leave worker past its retry cadence (static
    // finding B); stopHost tears in-flight requests down via the signal.
    const transportSignal = composeSignals(opts.signal, AbortSignal.timeout(30_000));
    // Bounded transport: the signal aborts cooperative transports; the race
    // also releases against one that IGNORES the signal (late responses are
    // dropped — the request is already dead to us).
    const resp = await boundedStage(
      this.fetchImpl(`${this.origin}${HOUSE_SESSION_ENDPOINT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: body as unknown as BodyInit,
        redirect: 'error',
        signal: transportSignal,
      }),
      'control fetch',
      transportSignal,
    );
    if (resp.status === 401 || resp.status === 400 || resp.status === 404) {
      throw new Error(`house-session ${op}: HTTP ${resp.status}`);
    }
    if (!resp.ok) {
      throw new Error(`house-session ${op}: HTTP ${resp.status}`);
    }
    const bytes = new Uint8Array(
      await boundedStage(Promise.resolve(resp.arrayBuffer()), 'control body', transportSignal),
    );
    const ack = ns.HouseSessionAck.decode(bytes) as unknown as {
      core: Record<string, unknown>;
      signature: Uint8Array;
      signerPubkey: Uint8Array;
    };
    return this.verify(ack, core);
  }

  /**
   * Ack verification: identity first (the signer MUST be the house key the
   * manifest declared), then the signature, then matched to THIS request
   * (origin/popclaw_id/installation/request_id/op_seq). Any mismatch =>
   * verified=false (the caller must not settle).
   */
  private verify(
    ack: { core: Record<string, unknown>; signature: Uint8Array; signerPubkey: Uint8Array },
    requestCore: Record<string, unknown>,
  ): ControlAck {
    const core = ack.core ?? {};
    const expected = hexToBytes(this.expectedAckPubkeyHex);
    let verified = false;
    if (bytesEqual(ack.signerPubkey, expected)) {
      const input = ackSigningInput(core);
      if (nacl.sign.detached.verify(input, ack.signature, expected)) {
        verified =
          core.houseOrigin === this.origin &&
          core.popclawId === requestCore.popclawId &&
          core.installationId === requestCore.installationId &&
          core.requestId === requestCore.requestId &&
          // The ack must answer THIS operation: a correctly-signed ack for a
          // different op (e.g. a LEAVE receipt echoing an Entered outcome)
          // never verifies (review counter-example 3).
          Number(core.operation) === Number(requestCore.operation) &&
          Number(core.opSeq) === Number(requestCore.opSeq);
      }
    }
    return {
      outcome: Number(core.outcome ?? 0),
      errorCode: Number(core.errorCode ?? 0),
      sessionId: String(core.sessionId ?? ''),
      sessionActive: Boolean(core.sessionActive),
      houseRevision: Number(core.houseRevision ?? 0),
      leaseExpiresAt: Number(core.leaseExpiresAt ?? 0),
      inboxReadToken: String(core.inboxReadToken ?? ''),
      serverCommittedAt: Number(core.serverCommittedAt ?? 0),
      detail: String(core.detail ?? ''),
      verified,
    };
  }
}

const OPERATION_VALUES: Record<ControlOperation, number> = {
  enter: 1,
  renew: 2,
  leave: 3,
  status: 4,
};

/** Union of abort sources: AbortSignal.any when available, manual otherwise. */
function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.length === 0) return new AbortController().signal;
  const anyOf = (AbortSignal as unknown as { any?: (ss: AbortSignal[]) => AbortSignal }).any;
  if (anyOf) return anyOf(live);
  const controller = new AbortController();
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Normalize an operator-supplied ack-key pin to lowercase hex (32 bytes / 64
 * chars). Accepts hex (G0 convention) or base58 (G1's HouseBinding encoding)
 * — same 32 bytes, two spellings; conflicts between them fail closed at the
 * caller. Returns '' for empty input, throws for anything unparsable.
 */
export function normalizeAckKeyHex(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  const bytes = bs58.decode(raw);
  if (bytes.length === 32) return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  throw new Error(`ack key pin is neither 64-hex nor base58-of-32-bytes: ${input.slice(0, 12)}…`);
}

/** Mint an idempotent request id (uuid v4; crypto.randomUUID preferred). */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  const bytes = nacl.randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

void canonicalRequestCore;
