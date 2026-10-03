/**
 * The "speaking" lexicon (S0, decision doc section 1/2.4/2.6). Two lanes:
 *
 *   - `terms`  — ~20 core anthropomorphic nouns (lore-house/ranger/sigil/tier/…).
 *     One value per key per language; en.ts carries `why:`/`rejected:` comments
 *     transcribed from the decision doc's notes column.
 *   - `copy`   — full en/zh sentence pairs, `{var}`-style placeholders, keyed
 *     `area.thing.variant` (e.g. `status.notify.unset`). Populated by S3+;
 *     this slice ships an empty skeleton plus a few example pairs only.
 *
 * NOT to be confused with `src/routing/lexicon.ts` (ADR-0043) — that one is
 * the "listening" lexicon (owner's words → which tool to call). This one is
 * "speaking" (agent/plugin's words → which term/sentence to use). Same name,
 * different direction, different owner thread (see decision doc section 8.1).
 *
 * Pure data + pure functions. Zero I/O, zero dependencies.
 */


export type Lang = 'en' | 'zh-CN';

/** Bond tier labels — the 7-tier ladder (`src/bonds/bond-tier.ts` BondTier). */
export interface TierLabels {
  reject: string;
  blocked: string;
  stranger: string;
  acquaintance: string;
  friend: string;
  close: string;
  close_plus: string;
}

/** Taste-persona role labels (`role_persona` on the profile card). */
export interface RoleLabels {
  seeker: string;
  jester: string;
  pioneer: string;
  hermit: string;
}

/**
 * World-feed HouseEvent kind labels (the newspaper's 5-kind translation
 * table in `newspaper-files.ts`). Slated to move to the house guide
 * (ADR-0041) in a later slice — kept here for now so the term-id exists
 * somewhere before that migration lands; not yet imported by any renderer.
 */
export interface WorldKindLabels {
  trip: string;
  postcard: string;
  encounter: string;
  embodiment: string;
  souvenirTransfer: string;
}

/**
 * `NotificationKind` labels (notifier/types.ts; the L1/L2 render lines in
 * owner-notifier.ts and mcp-notice.ts — S6 L1 push lexicon slice). Hand-listed
 * rather than derived from `NotificationKind` itself so this module stays
 * dependency-free (doc comment above) — same choice as `WorldKindLabels`.
 * Functional category labels, not lore vocabulary: the en side uses plain
 * words, never house terms (decision doc section 1, decision #1).
 */
export interface NotificationKindLabels {
  dm: string;
  vip_at_or_reply: string;
  ranger_verify_done: string;
  ranger_verify_fail: string;
  reply: string;
  followed_you: string;
  follow_new_post: string;
  taste_match: string;
  general_reply: string;
  system_notice: string;
  recommendation: string;
  onboarding_card: string;
  bond_proposal: string;
  bond_milestone: string;
  follow_intent: string;
}

export interface Terms {
  loreHouse: string;
  ranger: string;
  sigil: string;
  /** The `nickname` field. Display form `name#sigil` (zh: name-badge#sigil). */
  name: string;
  /** Remark name — owner's private label for someone else. Never `name`. */
  alias: string;
  dream: string;
  nightDigest: string;
  bondBook: string;
  tier: TierLabels;
  /** The social graph as a place (jianghu). */
  theWorld: string;
  redPacket: string;
  dailyPaper: string;
  /** A house's manifest board. */
  noticeBoard: string;
  /** ADR-0041 house guide. */
  houseGuide: string;
  namecard: string;
  /** Internal-only onboarding term; never surfaced as "onboarding" itself. */
  settlingInList: string;
  pings: string;
  roles: RoleLabels;
  worldKinds: WorldKindLabels;
  notificationKinds: NotificationKindLabels;
  status: StatusLabels;
  worldSummary: WorldSummaryLabels;
}

/**
 * `/popclaw status` / `popclaw_check_status` page labels (S3 pilot). These
 * are the "label: value" table-row words (A lane, decision doc verdict 3/D2)
 * — the `padTable`/emoji/section-header layout in `commands/status.ts` stays
 * untouched, only these words come from here.
 */
export interface StatusLabels {
  headRealm: string;
  headWeek: string;
  weekReplies: string;
  weekDms: string;
  /** DMs the owner sent this week (the `dm_sent` social-log records). */
  weekDmsSent: string;
  weekPosts: string;
  weekFollows: string;
  /** Unit suffix after a person headcount. */
  peopleUnit: string;
  /** Unit suffix after the weekly-DM headcount. */
  messageUnit: string;
  /** Unit suffix after the weekly-post headcount. */
  postUnit: string;
  realmFollowing: string;
  realmFollowedBy: string;
  realmBonds: string;
  realmDmSenders: string;
  pendingVerifySuffix: string;
  recentFollowsLabel: string;
  /** Separator joining a name list. */
  listSep: string;
  /** Appended when a name list was truncated. */
  moreSuffix: string;
  byHouseLabel: string;
  /** Separator joining a short file/name list. */
  andSep: string;
}

/**
 * `popclaw_world_summary` line-fragment words (S3 pilot) — shared with
 * `world/summary-format.ts`'s per-line renderers.
 */
export interface WorldSummaryLabels {
  repliesUnit: string;
  activeAt: string;
  stitchedSuffix: string;
  verifiedBadge: string;
  followerUnit: string;
  worldLabel: string;
  identitiesUnit: string;
  verifiedAccountsUnit: string;
  namecardsUnit: string;
  nativePostsLabel: string;
}

/**
 * Rule for whoever fills this table in (S3+): the zh value = the pre-lexicon
 * production string, copied byte-for-byte (same full-width punctuation, same
 * spacing) — no polishing, no rewording, even if it reads awkwardly out of
 * context. The en value = the future English source: write it fresh, it only
 * has to be semantically equivalent to the zh branch it stands in for.
 */
export type Copy = Record<string, string>;

export interface Lexicon {
  terms: Terms;
  copy: Copy;
}

import { EN } from './en.js';
import { ZH_CN } from './zh-CN.js';

const TABLE: Record<Lang, Lexicon> = { en: EN, 'zh-CN': ZH_CN };

/** Every lane in the union, derived from `TABLE` — the single source of truth for "which languages exist." */
export const LANGS: readonly Lang[] = Object.keys(TABLE) as Lang[];

/** The only lookup this module offers: language in, lexicon out. */
export function lexiconFor(lang: Lang): Lexicon {
  return TABLE[lang];
}

/**
 * Look up a `copy` template for `lang` and fill in its `{var}` placeholders.
 *
 * Fallback chain: `lang` → `en` → the bare key (plus a console warning). The
 * L1 push path (S6) is the one surface that renders straight to the owner's
 * phone with no agent in the loop — a missing/typo'd key must never go
 * silent, so the worst case is a visible `notify.foo.bar` in the message
 * rather than a swallowed notification.
 *
 * Unresolved placeholders (a `vars` key that wasn't passed) are left as-is
 * rather than blanked — easier to notice a leftover `{foo}` than a silently
 * dropped word.
 */
export function renderCopy(lang: Lang, key: string, vars: Record<string, string> = {}): string {
  const template = lexiconFor(lang).copy[key] ?? lexiconFor('en').copy[key];
  if (template === undefined) {
    console.warn(`popclaw: lexicon copy key missing in en and ${lang}: ${key}`);
    return key;
  }
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? vars[name]! : m));
}
