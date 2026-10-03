/** Standard JSON values with bounded UTF-8 input and duplicate-key rejection.
 * This is a transport carrier, so opaque metadata retains JSON.parse's number
 * and property-name semantics rather than a manifest/schema profile's rules. */
export function parsePushJsonResponse(bytes: Uint8Array, maxBytes: number): unknown {
  const invalid = (): never => { throw new Error('Push JSON response invalid'); };
  if (bytes.length > maxBytes) return invalid();
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let offset = 0;
  const whitespace = () => { while (offset < text.length && ' \t\r\n'.includes(text[offset]!)) offset++; };
  function string(): string {
    if (text[offset] !== '"') return invalid();
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '\\') { offset++; continue; }
      if (char === '"') return text.slice(start, offset);
    }
    return invalid();
  }
  function value(depth: number): void {
    if (depth > 64) return invalid();
    whitespace();
    if (text[offset] === '"') { string(); return; }
    if (text[offset] === '{') {
      offset++; whitespace(); const keys = new Set<string>();
      if (text[offset] === '}') { offset++; return; }
      while (offset < text.length) {
        whitespace(); const key = JSON.parse(string()) as string;
        if (keys.has(key)) return invalid(); keys.add(key);
        whitespace(); if (text[offset++] !== ':') return invalid();
        value(depth + 1); whitespace();
        const next = text[offset++];
        if (next === '}') return;
        if (next !== ',') return invalid();
      }
      return invalid();
    }
    if (text[offset] === '[') {
      offset++; whitespace();
      if (text[offset] === ']') { offset++; return; }
      while (offset < text.length) {
        value(depth + 1); whitespace(); const next = text[offset++];
        if (next === ']') return;
        if (next !== ',') return invalid();
      }
      return invalid();
    }
    // JSON.parse below validates primitive spelling, numeric grammar and all
    // string escapes. The structural scan only needs to locate their boundary.
    const start = offset;
    while (offset < text.length && !' \t\r\n,]}'.includes(text[offset]!)) offset++;
    if (offset === start) return invalid();
  }
  value(1); whitespace();
  if (offset !== text.length) return invalid();
  return JSON.parse(text);
}
