import { request } from 'undici';
import type { Signer } from '../identity/signer.js';
import { canvasSigningBytes } from '../canvas/canvas-signing.js';
import { LORE_HOUSE_UPLOAD_TIMEOUT_MS } from '../world/http-timeout.js';

export interface UploadCanvasOpts {
  baseUrl: string;
  signer: Signer;
  nickname: string;
  title: string;
  html: string;
  /** Optional page lifetime in hours (server default 24h — daily-paper semantics;
   *  server caps at 72). A delivery knob outside the content signature; no user
   *  command sets it today. */
  ttlHours?: number;
  /** Cap; defaults to 30s (a full newspaper's HTML is a large body). Tests shrink it to ms. */
  timeoutMs?: number;
}

/** Sign title\0html with the owner's popclaw_id key and POST it to the canvas
 *  service. Returns the tokenized view URL. Throws on a non-2xx response. */
export async function uploadCanvas(opts: UploadCanvasOpts): Promise<{ url: string }> {
  const sig = await opts.signer.sign(canvasSigningBytes(opts.title, opts.html));
  const body = JSON.stringify({
    popclaw_id: await opts.signer.popclawId(),
    nickname: opts.nickname,
    title: opts.title,
    html: opts.html,
    signature: Buffer.from(sig).toString('base64'),
    ...(opts.ttlHours !== undefined ? { ttl_hours: opts.ttlHours } : {}),
  });
  const endpoint = `${opts.baseUrl.replace(/\/$/, '')}/v1/canvas`;
  const timeout = opts.timeoutMs ?? LORE_HOUSE_UPLOAD_TIMEOUT_MS;
  const res = await request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    // Same as ServerPushEgress: undici defaults both to 300s; one alone caps nothing.
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const detail = await res.body.text();
    throw new Error(`canvas upload failed: ${res.statusCode} ${detail}`);
  }
  try {
    return (await res.body.json()) as { url: string };
  } catch {
    await res.body.dump().catch(() => {}); // drain to release the keep-alive connection
    throw new Error('canvas upload: server returned a non-JSON 200');
  }
}
