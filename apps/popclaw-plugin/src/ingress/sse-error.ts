/**
 * Describe an SSE failure in words (#142).
 *
 * `EventSource.onerror` hands out a DOM-ish *event object*, not an Error, so
 * `String(err)` renders it `[object Object]` — which is what a whole day of
 * "the lore-house is down" reports actually said in the field. The fields that
 * tell you whether you are looking at a 401, a dropped socket, or a DNS
 * failure are all there; only the stringification threw them away.
 *
 * Kept deliberately shallow: message/status/code/type is everything the
 * `eventsource` package puts on an error, and a JSON fallback covers whatever
 * a future runtime invents.
 */
/** How much of an unrecognised error object may reach a log line. */
const MAX_DUMP_CHARS = 300;

export function describeSseError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof e['status'] === 'number') parts.push(`status=${e['status']}`);
    if (typeof e['code'] === 'string' || typeof e['code'] === 'number') parts.push(`code=${e['code']}`);
    if (typeof e['message'] === 'string' && e['message']) parts.push(e['message']);
    if (parts.length === 0 && typeof e['type'] === 'string') parts.push(`type=${e['type']}`);
    if (parts.length > 0) return parts.join(' ');
    // Nothing recognisable — dump it rather than print [object Object], but
    // BOUNDED: this lands in a log line, and an unrecognised object is exactly
    // the one whose size nobody has checked. A cyclic object cannot be
    // stringified, so name its keys instead: never fall back to the very tag
    // this function exists to eliminate.
    try {
      const dump = JSON.stringify(err);
      if (dump === undefined) return `object with keys: ${Object.keys(e).join(',') || '(none)'}`;
      return dump.length > MAX_DUMP_CHARS ? `${dump.slice(0, MAX_DUMP_CHARS)}… (truncated)` : dump;
    } catch {
      return `unserialisable object with keys: ${Object.keys(e).join(',') || '(none)'}`;
    }
  }
  return String(err);
}
