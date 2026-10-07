import type { PublicMaterialBasis, PublicMaterialCoverage } from './public-material-source.js';
import { renderCopy } from '../lexicon/index.js';
import { langOf, ownerLangTag } from '../lexicon/owner-language.js';
import { ownerTz } from '../time/time-context.js';
/**
 * One issue of the daily paper, as structured data — the single object shared by
 * the three halves of the newspaper:
 *   gather  → builds it from the local cache + inbox and persists it (issue-store);
 *   prompt  → renders the agent-facing brief out of it (build-newspaper-prompt);
 *   render  → lays the finished page out of it plus the agent's `edit` (render-newspaper).
 *
 * v0.2: the LAYOUT lives in code (render-newspaper), the agent only writes the
 * words. That is why this file holds no HTML and no class names — it is the
 * material, not the page.
 */
export interface PulseItem {
  /** Immutable candidate-page number, stamped at selection before caps/top-up/budget trimming.
   * Absent on legacy manifests, which retain their original positional numbering. */
  itemNumber?: number;
  author: string; // display name (nickname / @handle); '' if the source post carried no author name
  handle: string; // platform handle, no '@'; '' if none
  /** popclaw sigil (short fingerprint of the author's popclaw_id) — our identity marker; '' if no author. */
  sigil: string;
  /** Avatar image URL (real photo via unavatar w/ monogram fallback). '' if unattributed. */
  avatarUrl: string;
  /** Card head profile — always popclaw.me `/<name>/<sigil>` (ADR-0032). '' = can't be built → no link given. */
  profileUrl: string;
  /** The person's profile page on the verified platform (`x.com/…`). Only used as a "view original" source-return exit, **never as the card head**. '' = none. */
  platformProfileUrl?: string;
  /** Follower count snapshot; 0 = unknown (hide). */
  followerCount: number;
  /** Whether the author has a verified platform binding. */
  verified: boolean;
  text: string; // full original body (ADR-0029)
  platform: string;
  /** Link to the original post (source URL for mirrors, else the popclaw.me post page). '' / undefined → not linkable. */
  url?: string;
  /** popclaw.me discussion page for this post, keyed by the SHORT event id (10-hex
   * prefix; web + lore-house resolve ≥6-hex). Target of the "💬 join the talk" button. '' → omit button. */
  postPageUrl: string;
  /** Image / video-thumbnail URLs (source CDN, not rehosted). [] if none. */
  media: string[];
  /** lore-house event_id of this post — used to wire the interactive action buttons. */
  eventId: string;
  /**
   * Why this item is in the issue at all — the writer's own answer, given when it chose:
   * the owner's taste, someone in their bond book, or simply what was lively that day.
   *
   * The paper says this out loud rather than keeping it: on a machine whose bond book holds
   * two people, most of an issue is going to be the third kind for a while, and the owner
   * asked to be shown that number rather than handed a page that quietly implies the whole
   * of it was chosen for him.
   */
  pickedFor?: 'taste' | 'bond' | 'lively';
  /** Author's popclaw_id — used to wire the follow button + dedupe follow-state. */
  authorPopclawId: string;
  /** Mark (like/favorite) count snapshot. */
  markCount: number;
  /** Reply count snapshot. */
  replyCount: number;
  /** Whether the owner already follows this author (→ hide the follow button). */
  isFollowing: boolean;
  /** Source lore-house slug (prerequisite for per-house sections). '' = unavailable (single lore-house / old row) → this line is omitted. */
  houseSlug: string;
  /**
   * Which density tier the layout puts this item in — `card` (a person card with
   * a headline and a few sentences) or `brief` (one line in the brief column).
   * Decided at gather time from three **locally verifiable** signals (bond-book
   * friend or closer / carries a picture / replies+marks over the threshold), so
   * the tier the agent sizes its summary against and the tier the renderer lays
   * out are the same one. The front page is separate: it comes from the agent's
   * `leads`, capped by `style.leadMax`.
   */
  tier: 'card' | 'brief';
  /** Event kind (the envelope body's oneof member name; across lore-houses this may
   *  be a word not in the local lexicon). '' = unknown → this line is omitted. The
   *  layout has an "annotation" degradation path for a kind it doesn't recognize. */
  kind: string;
  /** Raw bond-book tier (`close_plus` / `close` / …). Bond book not wired / not yet in the bond book = undefined. */
  bondTier?: string;
  /** The alias the owner gave this person. '' / undefined = none. */
  remarkName?: string;
  /** The most recent bond-book update note (already truncated). '' / undefined = none → this line is omitted entirely. */
  bondDynamic?: string;
  /** Recommendation-reason **materials** (P4): locally verifiable factual markers —
   *  the agent's stated reason may only be drawn from here.
   *  [] / undefined = this item has no verifiable reason → this line is omitted (better to not recommend than to invent one). */
  reasons?: readonly string[];
  /** Day N since first seen on this machine (P5, only given if ≤14). undefined = not a new face / lookup failed → this line is omitted. */
  newcomerDays?: number;
  /** F1 lore-house event fields: the key/value pairs the lore-house itself declared
   *  in its notice-board JSON Schema, **carried over verbatim**
   *  (`place_name` / `scene` / `present.1.figure_name` / `home_url`…).
   *  undefined = this item isn't a lore-house event / the body isn't recognized → this line is omitted, never guessed. */
  houseFields?: Readonly<Record<string, string>>;
}

/** One numbering authority for material, publish and render. Never mix stable and legacy IDs. */
export function numberedPulse(pulse: readonly PulseItem[]): { p: PulseItem; n: number }[] {
  const stable = pulse.some(p => p.itemNumber !== undefined);
  const seen = new Set<number>();
  return pulse.map((p, i) => {
    const n = stable ? p.itemNumber : i + 1;
    if (n === undefined || !Number.isSafeInteger(n) || n < 1 || seen.has(n)) {
      throw new Error('newspaper material has invalid or mixed item numbering');
    }
    seen.add(n);
    return { p, n };
  });
}

/**
 * F3 house letter: a letter sent by a lore-house's own official name (welcome /
 * homecoming / postcard). **Never enters pings** — the postman doesn't wait for a reply.
 * Body allows more room than a ping (400 chars), links and images are listed
 * separately, and a date is mandatory (Mantel level ③ cites it across windows).
 */
export interface HouseLetterItem {
  houseSlug: string;
  /** How to address the sender: `name#sigil` (just `#sigil` if not in the roster). */
  fromShort: string;
  /** Date the letter was received, same format as the masthead. */
  dateLabel: string;
  /** Raw body text (≤400 chars). **The machine header on the first line has already been stripped** (the lore-house's own guide §3 says never read it aloud). */
  body: string;
  /** Fields from the G4 house-letter header `[homeletter/v1]` (`kind=postcard · place=…`), verbatim.
   *  undefined = this letter has no header (an old lore-house / an ordinary letter) → this line is omitted. */
  header?: string;
  /** Page links inside the letter (a photo's back page / a sigil-touch link…). */
  links?: readonly string[];
  /** Image links inside the letter (the postcard's picture; a public URL the lore-house itself gave in the body). */
  imageLinks?: readonly string[];
}

/**
 * F4 Mantel: one lore-house's headline line — "how's my little one doing".
 * The level is which rung of the degradation chain it landed on
 * (① the lore-house digest's live status / ② today's one outing / ③ the most
 * recent house letter (cross-window, date mandatory) / ④ the lore-house's door
 * card); if none of those are available, the line is omitted entirely (⑤).
 */
export interface MantleItem {
  houseSlug: string;
  level: 1 | 2 | 3 | 4;
  /** Raw material text (① is that pet's live status from the lore-house digest, ② is the lore-house's self-reported field verbatim, ③ is the letter's body, ④ is the door card's one sentence). */
  text: string;
  /** Exit url (door plate / the link inside the letter / the lore-house gate). '' / undefined = no button given. */
  url?: string;
  /** Mandatory date for level ③ (material pulled across a window; omitting the date would be dishonest). */
  dateLabel?: string;
  /** Mandatory as-of time for level ① (the lore-house's `as_of`, already formatted in the owner's timezone). A figure must always carry its source. */
  asOf?: string;
}

/**
 * G3 "homes worth visiting" — one card. All material comes from the lore-house
 * digest's `homes[]`, **not a single field is invented**.
 * If either the home's name or door plate is missing, this card was already
 * dropped at the digest-client layer.
 */
export interface HomeItem {
  name: string;
  /** Door plate (§2.5, public, permanent). The sole href for "🚪 visit". */
  visitUrl: string;
  /** How to address the owner: recognized locally → `name#sigil` (alias overrides the self-reported name); unrecognized → whatever display name the lore-house gave. */
  owner: string;
  /** The owner's own description, verbatim (truncated if very long). */
  voice?: string;
  coverImg?: string;
  /** Visits today. Already omitted by gather when 0 (v5 rule: don't print 0). */
  visitsToday?: number;
  /** Built-on date (already formatted in the owner's timezone). */
  builtAt?: string;
}

/** One lore-house's entire "homes worth visiting" column. `rankingBasis` is the **lore-house's own wording verbatim** — the paper copies it as-is, never invents a ranking. */
export interface HomeSection {
  houseSlug: string;
  /** The as-of time the lore-house gave (already formatted). Any figure appearing in this column cites it. */
  asOf: string;
  rankingBasis?: string;
  homes: readonly HomeItem[];
}

/** One inbound social action awaiting the owner's response (pings block). */
export interface PingItem {
  /** How to address the sender: `name#sigil`, just `#sigil` if not in the roster (never a bare id prefix). */
  fromShort: string;
  bodyPreview: string;
  /** Raw bond-book tier; pings are sorted by it (closest bonds first). */
  bondTier?: string;
  remarkName?: string;
  /**
   * The most recent bond-book update for this sender (already truncated). The
   * codex puts it directly under the letter it bears on — who to answer and how
   * is decided on the front page, so the context belongs on the front page.
   * Absent = no note under that letter.
   */
  dynamic?: string;
  /** http(s) links appearing in the message (verbatim, undecoded). [] / undefined = none → this line is omitted. */
  links?: readonly string[];
}

/** lore-house slug → count, descending. Materials without a lore-house field aren't counted. */
export function houseCounts(pulse: readonly PulseItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pulse) if (p.houseSlug) out[p.houseSlug] = (out[p.houseSlug] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/**
 * The masthead date label — the ONE formatting every `dateLabel` in the system
 * goes through (ADR-0045's "don't hand-roll date formatting anywhere else",
 * applied to the paper's own date). Gather stamps every issue's `dateLabel`
 * with it, and the same-day binding rule (issue-store, 2026-09-03) computes
 * "today" with the very same call — stamp and yardstick share one code path,
 * so the comparison can never drift from what was stamped.
 *
 * `language` is the registered `ownerLangTag()` gather is handed (not cadence
 * read directly — B1's ruling); `timeZone` defaults to the owner's tz the same
 * way gather resolves it.
 */
export function mastheadDateLabel(
  tsSec: number,
  opts?: { language?: string; timeZone?: string },
): string {
  return new Date(tsSec * 1000).toLocaleDateString(opts?.language || 'en-US', {
    timeZone: opts?.timeZone ?? ownerTz(),
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Today's masthead label, in the owner's language and timezone — the same-day
 * rule's yardstick. Same sources gather's read-tools wiring uses
 * (`ownerLangTag()` / `ownerTz()`), so an issue stamped "now" and this label
 * agree by construction.
 *
 * Known edge, accepted (2026-09-03): a batch handed in across local midnight
 * reads as "previous day" — the 2h TTL already bounded that window, and the
 * boss's ruling is explicit that a leftover from a previous day must never be
 * bindable; the writer re-gathers and writes the new day's paper instead.
 */
export function todayDateLabel(nowMs: number = Date.now()): string {
  return mastheadDateLabel(Math.floor(nowMs / 1000), { language: ownerLangTag() });
}

/**
 * `<slug> N · <slug> M` — the social-log field (an internal ledger, written per the "logs are always English" rule).
 * The per-lore-house distribution inside the newspaper materials instead goes
 * through the lexicon (`newspaper.material.houseCount`): the zh codex quotes
 * the per-lore-house count verbatim, in the same measure word the whole paper uses.
 */
export function formatHouseCounts(byHouse: Record<string, number>): string {
  return Object.entries(byHouse)
    .map(([slug, n]) => `${slug} ${n}`)
    .join(' · ');
}

/**
 * The small bond-book tag for this person: `bond: close friend` /

/** Cast members (P3): one roster entry per person, count descending. Unattributed items don't count as a person. */
export interface CastMember {
  label: string; // name#sigil
  count: number;
  /**
   * This person's **first** material item in this issue — every "belongs to the
   * person" field in the roster (avatar / profile / followers / verified /
   * follow state / bond / alias / recent update / newcomer) is drawn from it
   * (I3). The same person posting from a different platform within one issue is
   * rare; when it happens, the first-seen item wins, consistent with the old
   * behavior (profileUrl taken from the first sighting).
   */
  first: PulseItem;
}

/**
 * Dedupe table of this issue's authors — a ready-made ledger for the roster /
 * newcomer board, so the agent doesn't have to count people across dozens of
 * material items itself. Dedupe key prefers popclaw_id (the same person is
 * still the same person even after changing their display name), falling back to `name#sigil`.
 */
export function castList(pulse: readonly PulseItem[]): CastMember[] {
  const by = new Map<string, CastMember>();
  for (const p of pulse) {
    if (!p.author) continue; // "(unattributed)" is not a person — never enters the roster
    const key = p.authorPopclawId || `${p.author}#${p.sigil}`;
    const hit = by.get(key);
    if (hit) hit.count += 1;
    else by.set(key, { label: `${p.author}${p.sigil ? `#${p.sigil}` : ''}`, count: 1, first: p });
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

/**
 * The whole issue, persisted at gather time and read back at publish time
 * (`issue-store`). Everything the page needs is in here — the renderer never
 * goes back to the database, which is also why the offline harness can
 * reproduce a real issue byte for byte.
 *
 * The **order of `pulse` is the contract**: the agent addresses each item by its
 * 1-based position (`[3]` in the materials → `"3"` in `edit.items`), so
 * anything that reorders this array breaks every issue in flight.
 */
export interface IssueData {
  publicMaterials?: PublicMaterialBasis;
  publicCoverage?: readonly PublicMaterialCoverage[];
  /** BCP-47 tag of the owner's language (`ownerLangTag()`), for the page's `lang` attribute and the label set. */
  language: string;
  /** The masthead date, already formatted in the owner's timezone. */
  dateLabel: string;
  /** How the window is described: `today` / `in the last N hours`. Wording must stay consistent with the window. */
  windowLabel: string;
  ownerNickname: string;
  /** Total in-window items **before** the layout budget trimmed anything (the honest "N gathered today" figure). */
  totalCount: number;
  pings: readonly PingItem[];
  /** The items that made the issue, in page order (see the note above). */
  pulse: readonly PulseItem[];
  /**
   * The owner's own lore-house (`lore_houses[0]`) — the only one whose posts have a
   * discussion page on `webBaseUrl`. Every other stack's "join the talk" button
   * would 404, so the renderer withholds it there. Absent = single-lore-house
   * assembly, nothing to withhold.
   */
  primaryHouseSlug?: string;
  /** The per-lore-house distribution, including a subscribed-but-0-items lore-house (E4). */
  byHouse: Readonly<Record<string, number>>;
  /** lore-house slug → its notice-board self-description (already truncated). */
  houseVoices?: Readonly<Record<string, string>>;
  houseLetters?: readonly HouseLetterItem[];
  mantles?: readonly MantleItem[];
  homeSections?: readonly HomeSection[];
}

/**
 * An item the agent must write words for. Anything the lore-house published with
 * its own declared fields (an outing, a postcard, a chance meeting) is laid out
 * **verbatim from those fields** by the renderer — the codex forbids adding a
 * word to them, so asking the agent to summarise one would be asking it to break
 * the iron rule. Those items are therefore left out of the brief entirely.
 */
export function needsEditorial(p: PulseItem): boolean {
  return !p.houseFields;
}

/**
 * A follower count in the owner's own units: `82K` in English, myriads in Chinese —
 * the codex asks for the owner's own way of counting, not a transliterated one.
 * 0 = unknown, printed nowhere.
 */
export function followerLabel(n: number, lang: string): string {
  if (n <= 0) return '';
  const l = langOf(lang);
  // Chinese counts in myriads (10^4) and their square (10^8); English in thousands
  // and millions. One decimal below ten of a unit, none above — 8.2 of one, 21M.
  const units: readonly (readonly [number, string])[] =
    l === 'zh-CN'
      ? [
          [100_000_000, 'yi'],
          [10_000, 'wan'],
        ]
      : [
          [1_000_000, 'm'],
          [1_000, 'k'],
        ];
  for (const [unit, key] of units) {
    if (n < unit) continue;
    const v = n / unit;
    return renderCopy(l, `newspaper.page.followers.${key}`, {
      n: v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, ''),
    });
  }
  return renderCopy(l, 'newspaper.page.followers.plain', { n: String(n) });
}
