import nacl from 'tweetnacl';
import { request } from 'undici';
import type { Signer } from '../identity/signer.js';
import type { FollowIntentRow } from '../social-graph/pending-follow-store.js';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';
import { pullSigningBytes } from './canvas-signing.js';
import { assertActionActive, currentActionSignal, rethrowActionCancellation } from '../runtime/house-lifecycle/action-context.js';

/**
 * Signed incremental pull of the owner's follow intents from the canvas
 * service (design §5.2): GET /v1/follow-intents?owner=&after= with
 * X-Popclaw-Id / X-Nonce / X-Ts / X-Signature, where the signature is a
 * detached Ed25519 sig over pullSigningBytes(owner, nonce, ts) — possession
 * of the owner's key is the only credential. Errors throw; the caller
 * (follow-doorbell service) owns backoff.
 */

/** HTTP seam: one GET returning status + raw body. The default uses the same
 *  undici `request` mechanism as egress/canvas-egress.ts (module-level import,
 *  both timeouts set — one alone caps nothing); tests inject a fake. Raw text
 *  rather than parsed JSON keeps the JSON parse — and its failure path —
 *  client-owned. */
export type FetchJson = (
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

export interface IntentPullClient {
  /** Rows whose latest_ts is after `afterMs` (ms cursor, 0 = full pull).
   *  Throws on any failure — never returns a partial batch as success. */
  pull(owner: string, afterMs: number): Promise<FollowIntentRow[]>;
}

/** 12 random bytes → 16 unpadded base64url chars. tweetnacl's randomBytes
 *  (same source as messaging/dm-crypto and identity/keystore) keeps this
 *  module free of node:* imports; the nonce needs no injection — tests read
 *  it back off the captured wire headers. */
const NONCE_BYTES = 12;

export function makeIntentPullClient(opts: {
  baseUrl: string;
  signer: Signer;
  fetchJson?: FetchJson;
  clock?: () => number;
}): IntentPullClient {
  const fetchJson = opts.fetchJson ?? undiciFetchJson;
  const clock = opts.clock ?? Date.now;
  return {
    async pull(owner: string, afterMs: number): Promise<FollowIntentRow[]> {
      assertActionActive();
      const self = await opts.signer.popclawId();
      assertActionActive();
      // Client-side mirror of the canvas server's id-mismatch check: the
      // signature only proves this signer's own id, so pulling anyone else's
      // rows is a guaranteed 401 — fail loudly before the wire. Safe to echo:
      // popclaw_id is public.
      if (self !== owner) {
        throw new Error(`intent pull: owner ${owner} is not this signer's id ${self}`);
      }
      const nonce = Buffer.from(nacl.randomBytes(NONCE_BYTES)).toString('base64url');
      const ts = clock();
      assertActionActive();
      const sig = await opts.signer.sign(pullSigningBytes(owner, nonce, ts));
      assertActionActive();
      const res = await fetchJson(
        `${opts.baseUrl.replace(/\/$/, '')}/v1/follow-intents` +
          `?owner=${encodeURIComponent(owner)}&after=${afterMs}`,
        {
          'X-Popclaw-Id': owner,
          'X-Nonce': nonce,
          'X-Ts': String(ts),
          'X-Signature': Buffer.from(sig).toString('base64'),
        },
        currentActionSignal(),
      );
      assertActionActive();
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`intent pull failed: ${res.status} ${res.text}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        throw new Error('intent pull: server returned a non-JSON 200');
      }
      const intents = (parsed as { intents?: unknown }).intents;
      // A malformed 200 must not masquerade as an empty batch — the caller
      // would advance its cursor past real intents.
      if (!Array.isArray(intents)) {
        throw new Error('intent pull: server returned a malformed 200');
      }
      return intents as FollowIntentRow[];
    },
  };
}

/** Default seam — canvas-egress's request mechanics with the read-tier
 *  timeout: this is a small GET, not a body upload, so the 10s budget of
 *  LORE_HOUSE_TIMEOUT_MS (not the 30s upload one) applies. Reading the body
 *  to completion also releases the keep-alive connection. */
async function undiciFetchJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  assertActionActive();
  const res = await request(url, {
    method: 'GET',
    headers,
    signal,
    headersTimeout: LORE_HOUSE_TIMEOUT_MS,
    bodyTimeout: LORE_HOUSE_TIMEOUT_MS,
  });
  try {
    assertActionActive();
    const text = await res.body.text();
    assertActionActive();
    return { status: res.statusCode, text };
  } catch (err) {
    // Disposing an unread undici body emits an abort error. Consume that
    // cleanup event so it cannot kill the host or replace the original failure.
    // The captured cancellation below remains the action's authority verdict.
    res.body.once('error', () => {});
    res.body.destroy();
    rethrowActionCancellation(err);
    throw err;
  }
}
