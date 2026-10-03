/**
 * Trading a long home-entry link for the short one the house offers.
 *
 * A short link is the SAME key in fewer characters, not a weaker one: it does
 * not extend the validity window, and whoever holds it holds the key. So the
 * only things this module insists on are the two that could turn a
 * convenience into a redirection:
 *
 *  - the shortener that gets asked is the one the VERIFIED declaration named,
 *    and it already had to sit on the audience origin to get here;
 *  - the link that comes back has to sit on that same origin too. A house
 *    whose shortener answers with somebody else's address is answering about
 *    somebody else's site, and the reply is discarded rather than followed.
 *
 * Failure is never fatal and never a downgrade. The long link is the same key
 * on the same approved site, so a shortener that is down, slow, or talking
 * nonsense costs the owner some characters and nothing else. What it must not
 * do is send them somewhere else, or quietly produce a link in an older
 * format.
 *
 * The wire shape is pinned by the one-page contract: the request body is
 * exactly `{"token": "..."}`, and the ONLY meaningful field in a 200 JSON
 * reply is `url`. Older names (`short_url`, `shortUrl`) are not read — a
 * house that only speaks the old shape is treated the same as one that named
 * no link at all, rather than leaving a back door for future shape drift.
 */

import { request } from 'undici';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';
import type { VerifiedBrowserEntry } from './browser-entry.js';

/** HTTP seam: one POST returning status + raw body. Same shape as canvas' `PostJson`; tests inject a fake. */
export type PostJson = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; text: string }>;

export type ShortenOutcome =
  | { readonly kind: 'short'; readonly link: string }
  /** The house declared no shortener. Nothing failed; there was nothing to ask. */
  | { readonly kind: 'not-offered'; readonly reason?: string }
  /** Asked and could not use the answer. The long link stands. */
  | { readonly kind: 'failed'; readonly reason: string };

export async function shortenBrowserEntryLink(opts: {
  readonly entry: VerifiedBrowserEntry;
  readonly token: string;
  readonly postJson?: PostJson;
}): Promise<ShortenOutcome> {
  const endpoint = opts.entry.shortenUrl;
  if (endpoint === undefined) return { kind: 'not-offered' };
  const post = opts.postJson ?? undiciPostJson;
  let res: { status: number; text: string };
  try {
    res = await post(endpoint, { 'Content-Type': 'application/json' }, JSON.stringify({ token: opts.token }));
  } catch (err) {
    return { kind: 'failed', reason: String(err) };
  }
  if (res.status < 200 || res.status >= 300) return { kind: 'failed', reason: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    return { kind: 'failed', reason: 'unreadable reply' };
  }
  if (body === null || typeof body !== 'object') return { kind: 'failed', reason: 'unreadable reply' };
  const b = body as Record<string, unknown>;
  const raw = b['url'];
  if (typeof raw !== 'string' || raw.length === 0) return { kind: 'failed', reason: 'reply named no link' };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: 'failed', reason: 'reply named no link' };
  }
  // The origin check is the whole reason this is not just "use what came
  // back": a shortener answering with another origin is handing the owner's
  // key to another site.
  if (parsed.origin !== opts.entry.audience) return { kind: 'failed', reason: 'reply left the approved site' };
  return { kind: 'short', link: raw };
}

/**
 * A well-behaved reply is one JSON object naming one URL — a few hundred
 * bytes. Anything past a few KB is not that, and reading it out anyway would
 * mean buffering a bug- or attacker-controlled body to completion before
 * refusing it. The stream is cut the moment this is crossed instead.
 */
const SHORTENER_REPLY_MAX_BYTES = 8 * 1024;

/** Default seam — the read-tier timeout, both halves set (one alone caps nothing). */
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
    // Explicit, not left to the client's default: a redirect is an
    // instruction to send this request — the token inside it included —
    // somewhere else, and this leg must never do that on its own.
    maxRedirections: 0,
  });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += (chunk as Buffer).length;
    if (total > SHORTENER_REPLY_MAX_BYTES) {
      res.body.destroy();
      throw new Error(`shortener reply exceeded ${SHORTENER_REPLY_MAX_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') };
}
