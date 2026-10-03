/** Written copy and honest source fallback, independent of layout and language. */
export interface EditorialCopy {
  items?: Readonly<Record<string, { h?: string; s?: string; q?: string }>>;
}

function writtenCopy(copy: EditorialCopy, n: number | undefined): { h: string; s: string } | undefined {
  const e = n === undefined ? undefined : copy.items?.[String(n)];
  const h = e?.h?.trim();
  const s = e?.s?.trim();
  return h || s ? { h: h || (s ?? '').slice(0, 40), s: s || '' } : undefined;
}

/**
 * Only nonblank headline or summary counts; the faithfulness anchor is not display copy.
 * Placement leaves unwritten ordinary posts out rather than filling a paper with raw
 * feed. The final missing-key receipt is a separate rule in render-newspaper.ts.
 */
export function hasCopy(copy: EditorialCopy, n: number | undefined): boolean {
  return writtenCopy(copy, n) !== undefined;
}

/** Missing display copy falls back to the item's own first sentence and body. */
export function copyFor(copy: EditorialCopy, p: { text: string }, n: number): { h: string; s: string; written: boolean } {
  const written = writtenCopy(copy, n);
  if (written) return { ...written, written: true };
  const first = p.text.split(/(?<=[。！？.!?])\s*/)[0] ?? p.text;
  return { h: first.slice(0, 40), s: p.text, written: false };
}
