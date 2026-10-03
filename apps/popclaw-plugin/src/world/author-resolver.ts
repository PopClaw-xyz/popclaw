/**
 * S4.1-T2 — Author resolver: a name/handle from the owner's mouth → popclaw_id candidates.
 *
 * Reuses notable-authors's AuthorSource for the data source shape
 * (summary.authors + snapshot entry aggregation; a second aggregation logic
 * is forbidden — both the aggregation and same-tier sorting are delegated to
 * aggregateNotableAuthors).
 *
 * Normalization: lowercase + strip whitespace — 'Elon Musk' / 'elonmusk' /
 * 'ELON' are the same person.
 */
import {
  aggregateNotableAuthors,
  type AuthorSource,
} from './notable-authors.js';

/** Resolution candidate: a popclaw_id + aggregated nickname + deduped platform list. */
export interface AuthorCandidate {
  readonly popclawId: string;
  readonly nickname: string;
  readonly platforms: string[];
}

/** Lowercase + strip all whitespace (names and handles often only differ by case/spacing). */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * Name/handle → candidates. Match priority: exact (case-insensitive) > prefix > substring;
 * data source = summary.authors + snapshot entry aggregation (reuses aggregateNotableAuthors's input).
 * Returns candidates sorted by priority + platform breadth (caller decides uniqueness/disambiguation).
 */
export function resolveAuthor(
  query: string,
  sources: AuthorSource[],
): AuthorCandidate[] {
  const q = normalize(query);
  if (q.length === 0) return [];

  // aggregateNotableAuthors already sorts by platform breadth desc → postCount desc →
  // nickname asc — same-tier (same-priority) order is inherited as-is, no separate sort written.
  const exact: AuthorCandidate[] = [];
  const prefix: AuthorCandidate[] = [];
  const substring: AuthorCandidate[] = [];

  for (const a of aggregateNotableAuthors(sources)) {
    const n = normalize(a.nickname);
    const candidate: AuthorCandidate = {
      popclawId: a.popclawId,
      nickname: a.nickname,
      platforms: a.platforms,
    };
    if (n === q) exact.push(candidate);
    else if (n.startsWith(q)) prefix.push(candidate);
    else if (n.includes(q)) substring.push(candidate);
  }

  return [...exact, ...prefix, ...substring];
}
