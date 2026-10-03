/**
 * The bond-context trailer line — "who this person is, what we've done
 * together before".
 *
 * The owner's own words (2026-07-29): getting a DM and seeing only a name
 * still leaves me blank. The whole value of having AI handle my incoming
 * mail is telling me, in passing, who this person is and what interactions
 * we've already had, so I have context to judge and reply.
 *
 *     📨 Blackfeather#7t4k2n9q sent you a DM: thanks, bro! …
 *        ↳ close friend · they messaged you yesterday · into mind-bending
 *          sci-fi, gearing up for a launch
 *
 * Three segments: tier (bond-book tier, localized) · most recent interaction
 * (direction + human-readable time) · what the night digest wrote down about
 * knowing them (first clause of bonds.description). **Show it if present,
 * omit it if not, and if everything is empty, drop the whole line** —
 * interruption budget is finite, and a stranger never gets a padded-out line
 * of filler.
 *
 * Discipline (same rule as the single name chain `makeNameChain` — the two
 * run right next to each other on the same hot path):
 *   - **Fully local, zero network, fully synchronous**: only reads the two
 *     indexed tables in my-social-assets.db.
 *   - **A db-lookup exception → the whole trailer line is dropped**, never
 *     rethrown. The trailer is a nice-to-have; the notification itself is
 *     what matters.
 *
 * Where the material comes from (why there are only these two sources):
 *   - Incoming direction = the `inbox` table (index
 *     `inbox_dedup(from_popclaw_id, ts, …)` prefix hit).
 *   - Outgoing direction = `bonds.last_interaction_ts` (the rolling window
 *     from "a row opens the moment you act", primary-key hit).
 *     ⚠️ Today only `follow` goes through `recordInteraction()`; sending a DM
 *     only lands in the social-log, so this segment's wording is
 *     deliberately neutral — "you reached out to them" rather than "you sent
 *     them a DM" — it must never claim more certainty than the data
 *     supports.
 *   - **The social-log is never touched**: it's month-sharded JSONL, and
 *     reading it would mean doing file I/O on the notification hot path.
 *   - The `reply_pings` table **has no author column** (only
 *     reply_event_id/target_post_id/arrived_at/read_at), so the "they replied
 *     to your post" tier can't be looked up in this version; doing so needs
 *     a column added first.
 */
import { tierRank, tierLabel, type BondTier } from './bond-tier.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/**
 * Trailer-line indent prefix — visually hangs below the line above it,
 * unobtrusive. zh-CN (kept exported as-is: byte-for-byte the pre-migration
 * production text, and existing zh test assertions build on it directly).
 */
export const BOND_CONTEXT_PREFIX = '　 ↳ ';

/**
 * Owner-facing (L1 push hot path), so this is language-branched rather than
 * unified to ASCII: the zh line keeps its full-width leading space, the en
 * line gets a plain ASCII one — U+3000 has no Latin sibling and reads as a
 * stray double space in an English line (the CJK ratchet's Han-ideograph-only
 * regex doesn't catch it either — it's punctuation, not a Han ideograph).
 */
export function bondContextPrefix(lang: Lang): string {
  return lang === 'zh-CN' ? BOND_CONTEXT_PREFIX : ' ↳ ';
}

/** Cap on the whole line (prefix included). It's a one-line hint, not a bio. */
const MAX_LINE_CHARS = 80;

/** Cap on the "what I know" segment. */
const MAX_DESCRIPTION_CHARS = 30;

const DAY_SECONDS = 86_400;

/** The three bond-book fields this line needs. null = this person isn't in the book. */
export interface BondFacts {
  readonly tier: BondTier;
  readonly description: string;
  /** The most recent time I proactively reached out to them (unix seconds). */
  readonly lastInteractionTs: number | null;
}

export interface BondContextSources {
  bond(popclawId: string): BondFacts | null;
  /** The most recent time they messaged me, **strictly before** `beforeTs` (unix seconds). If not supplied, only the outgoing direction is reported. */
  lastIncomingTs?(popclawId: string, beforeTs: number): number | null;
  now?(): number;
}

/**
 * `(popclawId, beforeTs?, lang?)` → the trailer line, or `''` (whole line omitted).
 *
 * `beforeTs` = the timestamp of "this specific event": by the time a DM is
 * queued it's already landed in the db, and without excluding it, this would
 * always say "they messaged you today" — referring to the very message the
 * owner is currently reading.
 *
 * `lang` defaults to `ownerLang()` (consistent with S3's existing pattern:
 * same default-parameter convention as `renderL1`/`tierLabel`) — this line
 * runs on the L1 push hot path, and the caller (index.ts) never passes a
 * language explicitly; this default lets it automatically follow the
 * owner's current language without needing to change the caller's
 * signature.
 */
export type BondContext = (popclawId: string, beforeTs?: number, lang?: Lang) => string;

export function makeBondContext(src: BondContextSources): BondContext {
  return (popclawId, beforeTs, lang = ownerLang()) => {
    if (!popclawId) return '';
    try {
      const now = src.now?.() ?? Math.floor(Date.now() / 1000);
      const bond = src.bond(popclawId);
      const parts: string[] = [];

      // 1. Closeness tier. Reject/blocked/stranger are not reported: that's
      //    my disposition toward them, or "don't know them yet" — not a bond.
      if (bond && tierRank(bond.tier) >= tierRank('acquaintance')) parts.push(tierLabel(bond.tier, lang));

      // 2. Most recent interaction — take whichever direction is more recent; direction decides the wording.
      const incoming = src.lastIncomingTs?.(popclawId, beforeTs ?? now) ?? null;
      const outgoing = bond?.lastInteractionTs ?? null;
      const interaction =
        validTs(incoming, now) && (!validTs(outgoing, now) || incoming! >= outgoing!)
          ? { ts: incoming!, key: 'bondContext.recentIncoming' as const }
          : validTs(outgoing, now)
            ? { ts: outgoing!, key: 'bondContext.recentOutgoing' as const }
            : null;
      if (interaction) {
        parts.push(renderCopy(lang, interaction.key, { ago: agoInWords(interaction.ts, now, lang) }));
      }

      // 3. What the night digest wrote down about knowing them (bonds.description, the dreamer's ≤60-char portrait).
      const knowledge = firstClause(bond?.description ?? '');
      if (knowledge) parts.push(knowledge);

      if (parts.length === 0) return '';
      return clamp(bondContextPrefix(lang) + parts.join(' · '), MAX_LINE_CHARS);
    } catch {
      // The trailer line is dropped; the notification body still goes out.
      return '';
    }
  };
}

/** Only a past, finite, non-zero timestamp counts (a clock glitch / uninitialized 0 is never reported). */
function validTs(ts: number | null, now: number): boolean {
  return ts !== null && Number.isFinite(ts) && ts > 0 && ts <= now;
}

/**
 * Today / yesterday / N days ago / N weeks ago / a long time ago — day-level
 * granularity is enough, the owner doesn't need minutes. The English side
 * needs two hand-written forms for 1 week vs. N weeks (`weekOne`/`weeksAgo`)
 * — in the days branch N is always ≥2 (`days === 1` is already caught by the
 * "yesterday" branch), so only the weeks branch can ever hit the singular 1.
 */
function agoInWords(ts: number, now: number, lang: Lang): string {
  const days = Math.floor((now - ts) / DAY_SECONDS);
  if (days <= 0) return renderCopy(lang, 'bondContext.ago.today');
  if (days === 1) return renderCopy(lang, 'bondContext.ago.yesterday');
  if (days < 7) return renderCopy(lang, 'bondContext.ago.daysAgo', { days: String(days) });
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1
      ? renderCopy(lang, 'bondContext.ago.weekOne')
      : renderCopy(lang, 'bondContext.ago.weeksAgo', { weeks: String(weeks) });
  }
  return renderCopy(lang, 'bondContext.ago.longAgo');
}

/** The portrait's first clause, truncated to ~30 chars, never cutting an English word in half. */
function firstClause(description: string): string {
  const head = description.trim().split(/[。；;!?！？\n]/)[0]?.trim() ?? '';
  if (!head) return '';
  return clamp(head, MAX_DESCRIPTION_CHARS);
}

/** Truncate with an ellipsis when too long; if the cut point lands mid-English-word, back off to a word boundary. */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max - 1;
  // Only back off when both sides of the cut are English/digits — Chinese
  // has no word boundaries, so backing off there would only waste characters.
  if (/[A-Za-z0-9]/.test(s[cut - 1] ?? '') && /[A-Za-z0-9]/.test(s[cut] ?? '')) {
    const back = s.slice(0, cut).search(/[A-Za-z0-9]+$/);
    if (back > 0) cut = back;
  }
  return `${s.slice(0, cut).trimEnd()}…`;
}
