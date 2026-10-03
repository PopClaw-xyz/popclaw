/**
 * The newspaper's issue-identity rules that were written out identically in
 * several places: telling a candidate page from a material page, cleaning an
 * id a writer carried back, the placeholder heuristic, the per-author key,
 * the candidate-page number of a stored item, and minting a token.
 *
 * Only rules that were the SAME everywhere live here. Where a caller applied
 * a different rule it keeps its own — the picks path's strict token check
 * (tools/newspaper-call.ts), checkEdit's basis cleaning, the renderer's and
 * the followable list's author comparisons, and issue.ts's author key (which
 * has no anonymous branch).
 *
 * Classification, not validation: nothing here proves an id names a real
 * page; the ledger lookup does that.
 */

/** A candidate page's id starts with `c` (`ctok_…`); a material page's does not. */
export function isCandidateId(id: string): boolean {
  return id.startsWith('c');
}

/**
 * An id as a writer carried it back: trimmed, one pair of flanking quotes
 * stripped. Anything that is not a string is ''.
 */
export function cleanProvenanceId(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '') : '';
}

/**
 * The heuristic for "this is not a real id but a stand-in for one": empty,
 * or carrying an ellipsis, a mask or bracket character, `xxx` or `redacted`.
 * A heuristic only — a real id could in principle contain one of these.
 */
export function isPlaceholderId(id: string): boolean {
  return !id || /\.\.\.|[*<>]|xxx|redacted/i.test(id);
}

/**
 * Two items by the same person — by popclaw id where there is one, else by
 * name#sigil. An item with neither is keyed by `i`, its position in the list
 * the caller is walking, so anonymous items never merge with each other.
 */
export function authorKey(
  p: { readonly authorPopclawId?: string; readonly author?: string; readonly sigil?: string },
  i: number,
): string {
  return p.authorPopclawId || (p.author ? `${p.author}#${p.sigil}` : `anon:${i}`);
}

/**
 * The number a candidate page prints for the item stored at index `i`. The
 * contract that keeps picks and pages aligned: gather stores candidates in
 * the order the page prints them (candidateOrder), so [n] is index n−1.
 */
export function candidateNumberAt(i: number): number {
  return i + 1;
}

/**
 * A fresh issue token. Not a pure function: every call draws from
 * Math.random. Injected as `mintToken` wherever a page is built, so tests can
 * pin it; the candidate side prefixes its own `c`.
 */
export function mintIssueToken(): string {
  return `tok_${Math.random().toString(36).slice(2, 12)}`;
}
