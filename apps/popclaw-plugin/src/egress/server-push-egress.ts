import { request } from 'undici';
import type { HouseGate } from '../runtime/house-lifecycle/manager.js';
import type { EventEgress, PushResult } from './event-egress.js';
import { LORE_HOUSE_UPLOAD_TIMEOUT_MS } from '../world/http-timeout.js';
import { parsePushJsonResponse } from './push-json-response.js';

const MAX_SIGNED_ACTION_RESULT_BYTES = 1024 * 1024;
const MAX_SIGNED_ACTION_RESULT_BASE64 = Math.ceil(MAX_SIGNED_ACTION_RESULT_BYTES / 3) * 4;
const MAX_PUSH_JSON_BYTES = MAX_SIGNED_ACTION_RESULT_BASE64 + 16 * 1024;

function jsonReceipt(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SIGNED_ACTION_RESULT_BASE64
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('SignedActionResult base64 invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_SIGNED_ACTION_RESULT_BYTES) throw new Error('SignedActionResult exceeds 1 MiB');
  // Node's base64 decoder is permissive about padding and unused pad bits.
  // Keep the original canonical carrier; do not decode/re-encode its protobuf.
  if (bytes.toString('base64') !== value) throw new Error('SignedActionResult base64 invalid');
  return value;
}

export interface ServerPushEgressOptions {
  baseUrl: string; // e.g. "http://localhost:8080"
  /** Cap; defaults to 30s (a push with media carries a large body). Tests shrink it to ms. */
  timeoutMs?: number;
  /** Captured before the action starts, never refreshed after an await. */
  gate?: Pick<HouseGate, 'isActive' | 'signal'>;
}

export class ServerPushEgress implements EventEgress {
  constructor(private readonly opts: ServerPushEgressOptions) {}

  async push(signedPayloadBytes: Uint8Array): Promise<PushResult> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1/push`;
    const timeout = this.opts.timeoutMs ?? LORE_HOUSE_UPLOAD_TIMEOUT_MS;
    this.assertActive();
    const res = await request(url, {
      method: 'POST',
      maxRedirections: 0,
      ...(this.opts.gate ? { signal: this.opts.gate.signal } : {}),
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: signedPayloadBytes,
      // undici defaults both to 300s, so a wedged house can hang a post for five
      // minutes. BOTH must be set — setting one still leaves the other unbounded.
      // The throw lands in the caller's existing push-failure path; no retry here.
      headersTimeout: timeout,
      bodyTimeout: timeout,
    });
    try {
      this.assertActive();
      const contentType = res.headers['content-type'];
      const mediaType = typeof contentType === 'string' ? contentType.split(';', 1)[0]!.trim().toLowerCase() : '';
      if (mediaType === 'application/x-protobuf') {
        const bytes = await this.readBody(res.body, res.headers['content-length'], MAX_SIGNED_ACTION_RESULT_BYTES, 'SignedActionResult exceeds 1 MiB');
        this.assertActive();
        return { status: res.statusCode, signedActionResultBase64: bytes.toString('base64') };
      }
      const raw = await this.readBody(res.body, res.headers['content-length'], MAX_PUSH_JSON_BYTES, 'Push JSON response exceeds limit');
      this.assertActive();
      const success = res.statusCode >= 200 && res.statusCode < 300;
      const first = raw.find(byte => byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13);
      // Non-2xx empty/plain-text infrastructure errors historically carry no
      // structured reason. An apparent JSON carrier must pass strict parsing.
      if (!success && first === undefined) return { status: res.statusCode, detail: undefined };
      let parsed: unknown;
      try { parsed = parsePushJsonResponse(raw, MAX_PUSH_JSON_BYTES); }
      catch {
        const startsJson = first === 123 || first === 91;
        if (!success && mediaType !== 'application/json' && !startsJson) return { status: res.statusCode, detail: undefined };
        throw new Error('Push JSON response invalid');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (!success) return { status: res.statusCode, detail: undefined };
        throw new Error('Push JSON response invalid');
      }
      const body = parsed as Record<string, unknown>;
      const receipt = Object.hasOwn(body, 'receipt_base64') ? { signedActionResultBase64: jsonReceipt(body.receipt_base64) } : {};
      this.assertActive();
      if (success) {
        return {
          status: res.statusCode,
          ...receipt,
          eventId: typeof body.event_id === 'string' ? body.event_id : undefined,
          deduplicated: typeof body.deduplicated === 'boolean' ? body.deduplicated : undefined,
          // ADR-0040: only InviteRequest responses carry it; absent elsewhere.
          ...(typeof body.task_id === 'string' && body.task_id ? { taskId: body.task_id } : {}),
        };
      }
      return { status: res.statusCode, ...receipt, detail: typeof body.error === 'string' && body.error ? body.error : undefined };
    } catch (error) {
      // Header-time rejection has no iterator to cancel the body. Explicitly
      // abort it, and consume undici's asynchronous RequestAbortedError.
      if (!res.body.destroyed) {
        res.body.on('error', () => {});
        res.body.destroy();
      }
      throw error;
    }
  }

  private async readBody(body: AsyncIterable<Uint8Array>, declaredLength: unknown, limit: number, error: string): Promise<Buffer> {
    this.assertActive();
    if (Number(declaredLength) > limit) throw new Error(error);
    const chunks: Buffer[] = [];
    let length = 0;
    // Check every streamed chunk before retaining it. json()/text()/arrayBuffer()
    // would allocate the complete untrusted body before the size check.
    for await (const chunk of body) {
      this.assertActive();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > limit) throw new Error(error);
      chunks.push(bytes);
    }
    this.assertActive();
    return Buffer.concat(chunks, length);
  }

  private assertActive(): void {
    const gate = this.opts.gate;
    if (gate && (gate.signal.aborted || !gate.isActive())) throw new Error('HOUSE_DISABLED');
  }
}
