/**
 * On the off chance the model comes back with markdown / plain text (common with weaker
 * hosts), this wraps it in a minimal responsive HTML shell as a fallback, guaranteeing canvas
 * always gets something viewable.
 * ponytail: this is a fallback shell, not a design template; on the normal path the model
 * produces the full HTML page itself.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function coerceHtml(raw: string): string {
  const unfenced = raw
    .trim()
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const lower = unfenced.toLowerCase();
  if (lower.includes('<!doctype') || lower.includes('<html') || lower.includes('<body')) {
    return unfenced;
  }
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;' +
    'max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6}</style></head>' +
    '<body><pre style="white-space:pre-wrap;word-break:break-word">' +
    escapeHtml(unfenced) +
    '</pre></body></html>'
  );
}
