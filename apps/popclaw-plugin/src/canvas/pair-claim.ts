import { request } from 'undici';
import type { Signer } from '../identity/signer.js';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';
import { pairClaimSigningBytes } from './canvas-signing.js';

/**
 * The reader-pass claim (design §5.3): the owner reads a 6-digit code off the
 * newspaper page open in his browser and tells his PopClaw; this signs
 * pairClaimSigningBytes(code, popclaw_id, ts) with the owner's key and POSTs
 * it to the canvas service's /v1/pair/claim — possession of the owner's key
 * is the only credential, which is what turns "someone read a code" into
 * "the OWNER vouches for this browser".
 *
 * Error contract (deliberately three-way, unlike the pull client which always
 * throws): a non-2xx is an honest "didn't pair" → false, because wrong /
 * expired / used codes are an expected owner-facing outcome (the recovery is
 * "re-issue a code on the page", which the tool's receipt says); network
 * trouble still throws, so the tool layer can report a network failure
 * instead of sending the owner off hunting for a fresh code that would not
 * help.
 */

/** HTTP seam: one POST returning status + raw body. Same shape as
 *  intent-pull-client's FetchJson plus the request body; the default uses the
 *  same undici `request` mechanics as egress/canvas-egress.ts (module-level
 *  import, both timeouts set — one alone caps nothing); tests inject a fake. */
export type PostJson = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; text: string }>;

/** Claims the pairing `code` for the signer's own popclaw_id. */
export async function pairBrowser(opts: {
  baseUrl: string;
  signer: Signer;
  code: string;
  fetchJson?: PostJson;
  clock?: () => number;
}): Promise<boolean> {
  const fetchJson = opts.fetchJson ?? undiciPostJson;
  const clock = opts.clock ?? Date.now;
  const id = await opts.signer.popclawId();
  const ts = clock();
  const sig = await opts.signer.sign(pairClaimSigningBytes(opts.code, id, ts));
  const res = await fetchJson(
    `${opts.baseUrl.replace(/\/$/, '')}/v1/pair/claim`,
    { 'Content-Type': 'application/json' },
    JSON.stringify({
      code: opts.code,
      popclaw_id: id,
      ts,
      signature: Buffer.from(sig).toString('base64'),
    }),
  );
  return res.status >= 200 && res.status < 300;
}

/** Default seam — canvas-egress's request mechanics with the read-tier
 *  timeout: the body here is a four-field JSON object, not an HTML upload,
 *  so the 10s budget of LORE_HOUSE_TIMEOUT_MS (not the 30s upload one)
 *  applies. Reading the body to completion also releases the keep-alive
 *  connection — including on the non-2xx paths, which is where this leg
 *  usually ends. */
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
