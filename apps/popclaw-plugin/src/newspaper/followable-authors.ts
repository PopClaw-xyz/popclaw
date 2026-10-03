/**
 * The followable-author set one published issue drops (doorbell spec §5).
 *
 * Pure on purpose: filtering, dedupe, descriptors and the 48h expiry are all
 * decided here from the stored issue plus the heads the layout printed, so the
 * publish half stays a dumb persistence seam and the offline tests need no
 * database. The write callback lives at the assembly site (read-tools), same
 * as every other optional PublishDeps entry.
 */
import { numberedPulse, type IssueData } from './issue.js';

/** How long a doorbell stays answerable: two days after the paper lands. */
export const FOLLOWABLE_TTL_MS = 48 * 60 * 60 * 1000;

/** A descriptor is the item's printed headline, cut short enough to sit on a button. */
export const DESCRIPTOR_MAX = 12;

export interface FollowableAuthorRow {
  /** The issue's masthead date (`IssueData.dateLabel`) — the same label the owner saw. */
  issue_date: string;
  popclaw_id: string;
  /** "name#sigil" when the item carries a sigil, the bare name otherwise —
   *  the pending-follow rows this set validates take their display name (and
   *  the sigil the owner's summary shows) from here, plugin-side only. */
  display_name: string;
  /** The printed headline of this author's first item in the issue, cut to 12 chars; null when there was none. */
  descriptor: string | null;
  /** Epoch ms after which the row stops being answerable (`nowMs + 48h`). */
  expires_at: number;
}

/**
 * Every author of this issue the owner could follow from its pages, one row
 * per person. An item needs BOTH halves of an identity to count: no
 * `authorPopclawId` = nobody to follow, no `author` = no name to put on the
 * button. The same person twice in one issue yields one row, decided by their
 * first item (the roster's first-sighting rule — `castList` in issue.ts).
 */
export function followableAuthorsOf(
  issue: IssueData,
  heads: ReadonlyMap<number, string>,
  nowMs: number,
): FollowableAuthorRow[] {
  const out: FollowableAuthorRow[] = [];
  const seen = new Set<string>();
  for (const { p, n } of numberedPulse(issue.pulse)) {
    if (!p.authorPopclawId || !p.author) continue;
    if (seen.has(p.authorPopclawId)) continue;
    seen.add(p.authorPopclawId);
    const h = heads.get(n);
    out.push({
      issue_date: issue.dateLabel,
      popclaw_id: p.authorPopclawId,
      display_name: p.sigil ? `${p.author}#${p.sigil}` : p.author,
      descriptor: h ? h.slice(0, DESCRIPTOR_MAX) : null,
      expires_at: nowMs + FOLLOWABLE_TTL_MS,
    });
  }
  return out;
}

/** Persists the rows. Injected at the assembly site; absent = the feature is off. */
export type RecordFollowableAuthors = (rows: FollowableAuthorRow[]) => void;
