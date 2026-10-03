export interface ScopedSseEvent { type: string; data: string }

/** A sequential SSE reader with no EventSource/Last-Event-ID state. Each event
 * completes its durable consumer before the following checkpoint is parsed. */
export async function consumeScopedSse(response: Response, signal: AbortSignal, consume: (event: ScopedSseEvent) => Promise<void>): Promise<void> {
  if (!response.body) throw new Error('SCOPED_STREAM_BODY_MISSING');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', eventType = '', data: string[] = [], size = 0, afterCr = false;
  const limit = 1048576;
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  const active = () => { if (signal.aborted) throw new Error('SCOPED_STREAM_ABORTED'); };
  async function endLine(): Promise<void> {
    const current = line; line = '';
    if (!current) {
      if (data.length) {
        active();
        await consume({ type: eventType || 'message', data: data.join('\n') });
        active();
      }
      eventType = ''; data = []; size = 0;
      return;
    }
    if (current.startsWith(':')) return;
    const colon = current.indexOf(':');
    const field = colon < 0 ? current : current.slice(0, colon);
    let value = colon < 0 ? '' : current.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') throw new Error('SCOPED_SSE_ID_REJECTED');
    if (field === 'event') eventType = value;
    else if (field === 'data') { data.push(value); size += value.length + 1; }
    if (size > limit || eventType.length > 64) throw new Error('SCOPED_SSE_SIZE_LIMIT');
  }
  try {
    while (true) {
      active();
      const chunk = await reader.read();
      active();
      if (chunk.done) { decoder.decode(); return; }
      const text = decoder.decode(chunk.value, { stream: true });
      for (const char of text) {
        if (char === '\r') { await endLine(); afterCr = true; }
        else if (char === '\n') { if (!afterCr) await endLine(); afterCr = false; }
        else {
          afterCr = false; line += char;
          if (line.length > limit) throw new Error('SCOPED_SSE_SIZE_LIMIT');
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', aborted);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function scopedBase64(data: string): Uint8Array {
  // Newlines inserted by SSE's multiline data framing are transport syntax.
  const value = data.replace(/\n/g, '');
  if (!value || value.length > 1048576 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('SCOPED_BASE64_INVALID');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('SCOPED_BASE64_INVALID');
  return new Uint8Array(decoded);
}

/** Public-v1 has an explicit event name and a complete bounded block. Unknown
 * fields, repeated event fields and incomplete EOF cannot be silently ignored. */
export async function consumePublicSse(
  response: Response,
  signal: AbortSignal,
  consume: (event: ScopedSseEvent) => void | Promise<void>,
): Promise<void> {
  if (!response.body) throw new Error('PUBLIC_STREAM_BODY_MISSING');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const events = new Set(['public_boundary', 'public_frame', 'public_checkpoint', 'public_gap']);
  let line = '', type: string | null = null, data: string[] = [], size = 0, afterCr = false;
  let cancellation: Promise<void> | null = null;
  const cancel = () => cancellation ??= reader.cancel().catch(() => {});
  const aborted = () => { void cancel(); };
  const active = () => { if (signal.aborted) throw new Error('PUBLIC_STREAM_ABORTED'); };
  signal.addEventListener('abort', aborted, { once: true });
  async function endLine(): Promise<void> {
    const current = line; line = '';
    if (!current) {
      if (type !== null || data.length) {
        if (type === null || !events.has(type) || !data.length) throw new Error('PUBLIC_SSE_FRAMING_INVALID');
        active(); await consume({ type, data: data.join('\n') }); active();
      }
      type = null; data = []; size = 0; return;
    }
    if (current.startsWith(':')) return;
    const colon = current.indexOf(':');
    if (colon < 0) throw new Error('PUBLIC_SSE_FRAMING_INVALID');
    const field = current.slice(0, colon);
    let value = current.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      if (type !== null || !events.has(value)) throw new Error('PUBLIC_SSE_FRAMING_INVALID');
      type = value;
    } else if (field === 'data') data.push(value);
    else throw new Error('PUBLIC_SSE_FIELD_REJECTED');
  }
  try {
    while (true) {
      active(); const chunk = await reader.read(); active();
      if (chunk.done) {
        decoder.decode();
        if (line || type !== null || data.length) throw new Error('PUBLIC_SSE_TRUNCATED');
        return;
      }
      for (const char of decoder.decode(chunk.value, { stream: true })) {
        if (++size > 1048576) throw new Error('PUBLIC_SSE_SIZE_LIMIT');
        if (char === '\r') { await endLine(); afterCr = true; }
        else if (char === '\n') { if (!afterCr) await endLine(); afterCr = false; }
        else { afterCr = false; line += char; }
      }
    }
  } finally {
    signal.removeEventListener('abort', aborted);
    await cancel(); reader.releaseLock();
  }
}
