/**
 * Collect one newspaper transaction from local material sources. Windowing,
 * people, letters and house context stay together here; candidate page sizing
 * and persistence belong to gather-materials.ts.
 */
import type { PublicMaterialBatch } from './public-material-source.js';
import type { CachedFeedItem, ReadableFeedItem } from '../ingress/world-feed-cache.js';
import { personVerdict } from '../butler/person-verdict.js';
import type { InboxItem } from '../messaging/inbox-store.js';
import { IMAGE_URL_RE, splitHomeletterHeader, urlsIn } from '../messaging/letter-text.js';
import {
  houseCounts,
  mastheadDateLabel,
  type IssueData,
  type PulseItem,
  type PingItem,
  type HouseLetterItem,
  type MantleItem,
  type HomeItem,
  type HomeSection,
} from './issue.js';
import { buildAuthorBlock, type AuthorBlock } from './author-block.js';
import { displayNamed, type NameChain } from '../identity/person-name.js';
import { deriveSigil } from '../invite/sigil.js';
import type { DigestFigure, DigestHome, WorldDigest } from '../world/digest-client.js';
import { tierRank, type BondTier } from '../bonds/bond-tier.js';
import { renderCopy } from '../lexicon/index.js';
import { langOf, ownerLang, ownerLangTag } from '../lexicon/owner-language.js';
import { ownerTz, startOfLocalDay } from '../time/time-context.js';


const MAX_SCAN = 1000;
const MAX_PINGS = 50;
const PING_BODY_PREVIEW = 80;
/** Body cap for a lore-house's official letters (house letters). The 80-char
 *  preview is sized for "a dozen-plus strangers' messages on one screen";
 *  a lore-house sends at most two or three letters a day, and its entire value is in that one sentence itself. */
const HOUSE_LETTER_BODY_MAX = 400;
/** A recommendation reason is one line of small print, not a list: at most 2 taste words + 1 relation path per material item. */
const MAX_TASTE_HITS = 2;
const MAX_RELATION_PATHS = 1;
/** Truncation length for a bond-book update / lore-house self-description (both used for one line of small print in the layout). */
const DYNAMIC_MAX = 60;
const VOICE_MAX = 40;
/** The owner's own line in "homes worth visiting": it's card-body text, not small print, one notch wider than the lore-house notice board. */
const HOME_VOICE_MAX = 80;
/** The "newcomer" window: first seen on this machine ≤14 days ago. We only know what this machine has seen, so the wording must say "first seen on this machine". */
const NEWCOMER_DAYS = 14;

/**
 * The body text's **display-layer budget** (I5). Doesn't conflict with
 * ADR-0029: ADR-0029 governs **storage and protocol** — the relay and the local
 * cache always store the full text, not a single character dropped; this governs
 * how much of it this issue hands to the agent. The body was originally the only
 * field in the material section with no cap at all, so one long post could eat
 * the budget of ten brief notes.
 *
 * v0.2 sizes it to **what the agent is going to write from it**. The density tier
 * is decided here now (see `tier`), and a brief note is one or two sentences of
 * output — feeding it 1,200 characters of source to produce sixty was the old
 * shape, from back when the agent was also laying out the page and might promote
 * an item itself. It no longer can: the tier the agent is told is the tier the
 * renderer prints, so the source budget can follow it. Measured on the real feed
 * of 2026-08-25 this is most of the difference between a brief that fits the
 * host's 32k tier and one that does not.
 */
const TEXT_MAX_CARD = 1600;
const TEXT_MAX_BRIEF = 400;
/** The "significant engagement count" threshold: replies + marks. */
const FEATURE_ENGAGEMENT = 5;

/** Truncate if too long, appending an ellipsis; a short string is returned unchanged. */
function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function isHttpUrl(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

/** One line carrying a lore-house's self-reported fields over verbatim: `place_name=Suzhou · phase=returned`. Translation is the layout's job, not touched here. */
function fieldsLine(f: Readonly<Record<string, string>>): string {
  return Object.entries(f)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
}

/** The "most complete information" card head for a given author: whichever has the most non-empty fields wins (the basis for E1's id-keyed backfill). */
function blockScore(a: AuthorBlock): number {
  return (
    (a.name ? 1 : 0) + (a.handle ? 1 : 0) + (a.avatarUrl ? 1 : 0) + (a.profileUrl ? 1 : 0) +
    (a.platformProfileUrl ? 1 : 0) + (a.followerCount > 0 ? 1 : 0) + (a.verified ? 1 : 0)
  );
}

export interface MaterialSources {
  publicBatch?: PublicMaterialBatch;
  cache: {
    recentForReading(n: number): ReadableFeedItem[];
    /** First-seen time (seconds) for each author on this machine. Not implemented = no newcomer tag (an honest degradation). */
    authorFirstSeen?(): Map<string, number>;
  };
  inbox: { recent(n: number): InboxItem[] };
  ownerNickname: string;
  /** The owner's id, so their own posts are bylined with `ownerNickname`. Absent = no owner special case. */
  ownerPopclawId?: string;
  webBaseUrl: string;
  now: () => number; // seconds
  mintToken: () => string; // random publish token
  /** owner already follows this author **in that house**? (→ hide follow btn)
   *  ADR-0037 "content attention is per lore-house": following someone in the me lore-house ≠ following them in the world lore-house too. */
  isFollowing: (popclawId: string, houseSlug?: string) => boolean;
  /** The unified name chain (alias > self-reported name > handle); not injected = only the name baked into the post is used. */
  nameOf?: NameChain;
  /** Bond-book lookup. Not injected = the paper carries no bond info and does no blocked-person filtering (an honest degradation for test stubs / unwired assemblies). */
  bondOf?: (popclawId: string) => NewspaperBond | null | undefined;
  /** The owner's taste as **locally matchable tags** (the tags from taste
   *  frontmatter). Plain case-insensitive string-contains matching, zero LLM
   *  (ADR-0030). Not injected / empty = no taste-based recommendation reason is shown. */
  tasteTags?: readonly string[];
  /** lore-house slug → its notice-board self-description, one line. Returning '' = this lore-house has none available → that line is omitted. */
  houseVoiceOf?: (houseSlug: string) => string;
  /**
   * The lore-houses the owner **has subscribed to** (each `lore_houses` entry's
   * `hostDbSlug`). A lore-house with zero materials that day still gets its own
   * stack (for the notice board and pointers) — if a subscribed lore-house's
   * whole stack vanished, the owner would think it went down. Not injected =
   * only lore-houses that actually appear in the materials get a stack (old behavior).
   */
  configuredHouseSlugs?: readonly string[];
  /**
   * The primary lore-house's slug (`lore_houses[0]`) — the lore-house
   * `webBaseUrl` belongs to. Only it can produce a "join the talk" page
   * (F2/D5, see `postPageUrl`). Not injected = old behavior (build the link
   * for every item, including dead links for other lore-houses).
   */
  primaryHouseSlug?: string;
  /**
   * A lore-house's official names (the `official_ids` persisted at
   * guide-handshake time). Letters from these names are **house letters, not
   * pings** — the postman doesn't wait for a reply. Not injected = old
   * behavior (lore-house broadcasts still crowd into the pings column).
   */
  houseOfficialIds?: (houseSlug: string) => readonly string[];
  /**
   * A lore-house's self-reported "first thing" (the `entry:` from guide
   * frontmatter, persisted at guide-handshake time). Mantel level ④'s sole
   * material: an owner who's never actually entered the world still gets one
   * clickable door on the page. Not injected = no level ④.
   */
  houseEntryOf?: (houseSlug: string) => { headline?: string; home?: string; firstMove?: string } | undefined;
  /**
   * A lore-house's digest for the newspaper (fetched from
   * `newspaper.digest_url`, already best-effort degraded). The sole material
   * source for Mantel level ① and "homes worth visiting". Not injected /
   * returns undefined = this lore-house has no digest → Mantel falls back to
   * levels ②-⑤, the homes column is omitted, the rest of the page is unaffected.
   */
  digestOf?: (houseSlug: string) => WorldDigest | undefined;
  /**
   * The names this machine recognizes (the entire bond book) — if a digest's
   * `owner` doesn't carry a `popclaw_id` (an old lore-house / an old cache),
   * only the sigil is left, and looking the id back up from this list is the
   * only way in to the unified name chain. Authors from the world-feed cache
   * are contributed by `cache` itself and don't need to be injected again.
   */
  knownPopclawIds?: readonly string[];
  /** The language used for the masthead date (the registered `ownerLangTag()`, **not** cadence read directly). Not injected = `en-US`. */
  language?: string;
}

/** The bond-book fields relevant to the newspaper. */
export interface NewspaperBond {
  tier: BondTier;
  remarkName: string;
  /** Raw text of the most recent bond-book update (the sole material source for content.md's "editor's note"). */
  dynamic?: string;
}

/**
 * People the owner has blocked / rejected must never appear on the newspaper,
 * not one — the newspaper is the biggest table in the house; letting it route
 * around the bond book and set someone back down in front of the owner would
 * make the block a no-op. The check uses rank rather than an enumerated list:
 * if a lower tier is ever added ahead of BOND_TIERS, this follows automatically.
 */
function isMuted(bond: NewspaperBond | null | undefined): boolean {
  // The check itself now lives in the receptionist (ADR-0046): the same rule
  // "a blocked person must not be shown" used to be privately duplicated in the
  // newspaper, and notifications had no such check at all. Behavior here is
  // **unchanged, character for character** — it just no longer compares
  // tierRank itself — the first nail toward a single source of truth.
  return personVerdict('x', { bondOf: () => bond ?? null }).blocked;
}

/** Sort-order score by tier; not yet in the bond book = -1 (sorted after everyone who is). */
function bondSortRank(tier: string | undefined): number {
  return tier ? tierRank(tier as BondTier) : -1;
}

/**
 * popclaw.me discussion page for a feed item, keyed by the SHORT event id — 10-hex
 * prefix, the canonical clickable form (web + lore-house resolve ≥6-hex prefixes;
 * same canon as /popclaw post). Target of the "💬 join the talk" button. '' if no id.
 *
 * **Only the primary lore-house can produce this** (F2/D5): `webBaseUrl` is a
 * single global value (the web surface of the owner's own lore-house), while
 * every lore-house has its own separate database — building a URL out of a
 * world event_id against popclaw.me is guaranteed to 404. A different
 * lore-house's web base URL **cannot be derived** client-side: a real pull of
 * `/v1/manifest` on 2026-07-31 carried no web/post-url field at all (only
 * core_primitives / event_kinds / guide_url / house / intent_kinds /
 * official_ids), and `guide_url`'s source (`https://popclaw.world`) returns
 * its own 404 page for `/post/<id>`. So **omit rather than serve a dead
 * link**: a non-primary lore-house gets no "join the talk" url, and the world
 * stack instead uses the envelope's `home_url` / the letter's door-plate short link as its exit.
 * Restoring cross-lore-house discussion pages in the future means the
 * lore-house declaring its own post-url template on its notice board.
 */
function postPageUrl(it: CachedFeedItem, webBaseUrl: string, primaryHouseSlug?: string): string {
  if (it.houseSlug && primaryHouseSlug && it.houseSlug !== primaryHouseSlug) return '';
  const id = it.eventId || (it.platform === 'popclaw' ? it.platformPostId : '');
  return id ? `${webBaseUrl.replace(/\/$/, '')}/post/${id.slice(0, 10)}` : '';
}

/** Best link back to a feed item's original post (source URL, else the popclaw.me
 * post page — short id, never the raw 64-hex; empty for other houses, see above). */
function itemUrl(it: CachedFeedItem, webBaseUrl: string, primaryHouseSlug?: string): string {
  return it.originalUrl || postPageUrl(it, webBaseUrl, primaryHouseSlug);
}

/**
 * The house's own wording for how it ordered the homes. When the house publishes that
 * statement in the tag the owner reads, that is the one to print — the house speaking for
 * itself beats any translation of it. Exact tag first (`zh-CN`), then the primary subtag
 * (`zh`), then the original.
 */
function rankingBasisOf(d: WorldDigest, tag: string): string | undefined {
  const i18n = d.ranking_basis_i18n;
  if (i18n) {
    const primary = tag.split('-')[0] ?? tag;
    const hit = i18n[tag] ?? i18n[primary];
    if (hit) return hit;
  }
  return d.ranking_basis;
}

/** Complete, untrimmed materials; the page stamps its language when it is built. */
export type MaterialDraft = Omit<IssueData, 'language'>;

export type CollectionResult =
  | { kind: 'empty'; message: string }
  | { kind: 'collected'; candidateToken: string; lang: ReturnType<typeof langOf>; draft: MaterialDraft };

/**
 * No explicit hours means the owner's local calendar day. Token minting happens
 * after all house context is collected, before notice-board voices are read.
 */
export function collectNewspaperMaterials(
  sources: MaterialSources,
  opts: { hours?: number } = {},
): CollectionResult {
  const tz = ownerTz();
  const lang = sources.language ? langOf(sources.language) : ownerLang();
  // Material mechanical slots (Mantel level ①'s "on the way home / postcard
  // progress" line, level ④'s door-card phrase): the codex quotes them
  // verbatim, so they follow the owner's language — the same lexicon keys as build-newspaper-prompt.
  const material = (key: string, vars: Record<string, string> = {}): string =>
    renderCopy(lang, `newspaper.material.${key}`, vars);
  // The wording must track the window: a rolling window calling itself "today" is exactly the self-contradiction bug B2 traced.
  const windowLabel = opts.hours === undefined ? 'today' : `in the last ${opts.hours} hours`;
  const start =
    opts.hours === undefined ? startOfLocalDay(sources.now(), tz) : sources.now() - opts.hours * 3600;
  const bondOf = (id: string): NewspaperBond | null =>
    (id && sources.bondOf ? sources.bondOf(id) : null) ?? null;
  const inWindow = (sources.publicBatch?.items ?? sources.cache.recentForReading(MAX_SCAN))
    .filter((i) => i.platformPostCreatedAt >= start)
    .filter((i) => !isMuted(bondOf(i.authorPopclawId)));

  // Empty feed = likely an ingestion problem; surface honestly, never silent (spec §7).
  // This sentence is **spoken to the owner** (the tool hands it verbatim to the agent to relay) → goes through the lexicon, not a single English source.
  if (inWindow.length === 0) {
    return {
      kind: 'empty',
      message:
        opts.hours === undefined
          ? renderCopy(lang, 'newspaper.empty.today')
          : renderCopy(lang, 'newspaper.empty.window', { hours: String(opts.hours) }),
    };
  }

  // Everything the window carried. It used to be `inWindow.slice(0, MAX_ITEMS)` — the newest
  // eighty, chosen by nothing — which is what the owner threw out on 2026-08-26: a paper
  // that prints whatever it happened to read is not a paper. Reading is uncapped now
  // (the feed scan bounds it at
  // MAX_SCAN); what gets into the issue is decided afterwards, by taste, by the bond book, and
  // by heat, on the candidate page.
  const items = inWindow;

  // ——— E1 same-person name backfill: ingest sometimes drops actor_nickname/handle
  // entirely on a reply (on a real machine, all of elonmusk's replies rendered as
  // "(unattributed)" while his top-level posts in the same batch had the name
  // intact). First pass builds a popclaw_id → most-complete-card-head map, then
  // nameless items are backfilled **keyed by that same id**. Never cross ids,
  // never guess: an item that can't be backfilled stays "(unattributed)".
  const self = sources.ownerPopclawId ? { popclawId: sources.ownerPopclawId, nickname: sources.ownerNickname } : undefined;
  const blocks = items.map((i) => buildAuthorBlock(i, sources.webBaseUrl, self));
  const bestById = new Map<string, AuthorBlock>();
  items.forEach((i, n) => {
    const b = blocks[n]!;
    if (!i.authorPopclawId || !b.name) return;
    const hit = bestById.get(i.authorPopclawId);
    if (!hit || blockScore(b) > blockScore(hit)) bestById.set(i.authorPopclawId, b);
  });
  const blockOf = (i: ReadableFeedItem, n: number): AuthorBlock => {
    const b = blocks[n]!;
    return b.name ? b : bestById.get(i.authorPopclawId) ?? b;
  };
  const nameOfItem = (i: ReadableFeedItem, n: number): string => {
    const baked = blockOf(i, n).name;
    return sources.nameOf?.(i.authorPopclawId, baked) || baked;
  };

  // ——— P4 relation paths: within the window, "someone the owner already follows replied to them". O(items), pure id comparison, zero LLM.
  const repliedToByFollowed = new Map<string, Set<string>>();
  for (const [n, i] of items.entries()) {
    const target = i.replyToAuthorPopclawId;
    if (!target || target === i.authorPopclawId) continue;
    if (!sources.isFollowing(i.authorPopclawId, i.houseSlug)) continue;
    const who = nameOfItem(i, n);
    if (!who) continue;
    (repliedToByFollowed.get(target) ?? repliedToByFollowed.set(target, new Set()).get(target)!).add(who);
  }

  // ——— P4 taste hits: case-insensitive tag × body-text contains matching. O(items × tags) string operations.
  const tags = (sources.tasteTags ?? []).filter((t) => t.trim());
  const tasteHits = (text: string): string[] => {
    if (!tags.length || !text) return [];
    const hay = text.toLowerCase();
    return tags.filter((t) => hay.includes(t.toLowerCase())).slice(0, MAX_TASTE_HITS);
  };

  // ——— P5 first seen on this machine: one GROUP BY over all authors, not one query per item.
  const firstSeen = sources.publicBatch ? undefined : sources.cache.authorFirstSeen?.();
  /**
   * sigil → this machine's popclaw_id reverse-lookup table (see `idOfSigil`). If
   * a digest's `owner` doesn't carry `popclaw_id` (an old lore-house / an old
   * cache), only the sigil is left, and the id is the entry point into the
   * unified name chain. **Lazily built**: if there are no homes to lay out, not even one sha256 gets computed.
   */
  let sigilTable: Map<string, string> | undefined;
  const now = sources.now();

  // Inject the real date so the model stops guessing the year — the owner's
  // local timezone + the owner's configured language (B1: this used to
  // hardcode both zh-CN and Asia/Shanghai, so an owner not on UTC+8 got
  // tomorrow's date, and that wrong value would then be permanently baked into the social log).
  // The formatting itself lives in issue.ts (`mastheadDateLabel`) — the
  // same-day binding rule (issue-store) computes "today" through the same
  // function, so stamp and yardstick can never drift apart.
  const dateOf = (ts: number): string => mastheadDateLabel(ts, { language: sources.language, timeZone: tz });
  /** `hh:mm` in the owner's local timezone — this is exactly what gets printed for a lore-house's `as_of` (a figure's source and time). */
  const timeOf = (ts: number): string =>
    new Date(ts * 1000).toLocaleTimeString(sources.language || 'en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  /** ISO string → an owner-local time label; if a lore-house gives something that isn't ISO, it's **copied verbatim** (never guessed). */
  const stampOf = (iso: string, mode: 'time' | 'date' | 'datetime'): string => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    const ts = ms / 1000;
    if (mode === 'time') return timeOf(ts);
    if (mode === 'date') return dateOf(ts);
    return `${dateOf(ts)} ${timeOf(ts)}`;
  };

  // ——— F1 lore-house event fields: the lore-house published its own schema on
  // the notice board, and the cache has already flattened body into a flat
  // table per that schema. The only thing done here: any `owner_popclaw_id`
  // sharing this frame gets swapped in place for "name#sigil" — a bare id is
  // both meaningless and makes two strangers look like the same person
  // (ADR-0032), and that's exactly the most valuable sentence in a "you crossed paths" line.
  const houseFieldsOf = (i: ReadableFeedItem): Record<string, string> | undefined => {
    if (!i.houseFields) return undefined;
    return Object.fromEntries(
      Object.entries(i.houseFields).map(([k, v]) => {
        if (k.endsWith('popclaw_id')) return [k, displayNamed(v, sources.nameOf, bestById.get(v)?.name)];
        // These three reach the page verbatim now that the layout is code, so they
        // are put into the owner's own reading here: a raw ISO stamp and an English
        // enum on a Chinese page are exactly what content §5 forbids.
        if (k === 'occurred_at' || k.endsWith('.occurred_at') || k.endsWith('_at')) {
          return [k, stampOf(v, 'datetime')];
        }
        // `phase` is deliberately NOT localized here: the mantel reads it back to
        // decide which sentence to compose, and a translated enum would be
        // unrecognisable to it. The page translates it where it prints it.
        return [k, v];
      }),
    );
  };

  const pulse: PulseItem[] = items.map((i, n) => {
    const a = blockOf(i, n); // avatar / profile / followers (v2), nameless items already backfilled by id
    const bond = bondOf(i.authorPopclawId);
    // v0.2: these go onto the page verbatim as the "picked for you" line, so they
    // are written in the owner's language here rather than left as English for the
    // model to translate. Facts only — the phrasing is a slot, the content is a lookup.
    const reasons = [
      ...tasteHits(i.body).map((t) => material('reason.taste', { tag: t })),
      ...[...(repliedToByFollowed.get(i.authorPopclawId) ?? [])]
        .slice(0, MAX_RELATION_PATHS)
        .map((who) => material('reason.relation', { who })),
    ];
    const firstTs = i.authorPopclawId ? firstSeen?.get(i.authorPopclawId) : undefined;
    const days = firstTs === undefined ? undefined : Math.floor((now - firstTs) / 86400) + 1;
    const houseFields = houseFieldsOf(i);
    // The three locally verifiable signals that earn an item a wide card: someone
    // the owner actually cares about / carries a picture (the standard for a
    // headline card) / already picking up heat. Any one hit is enough.
    const feature =
      (bond && tierRank(bond.tier as BondTier) >= tierRank('friend')) ||
      i.media.length > 0 ||
      i.markCount + i.replyCount >= FEATURE_ENGAGEMENT;
    return {
      // The alias the owner gave overrides the name baked into the post (unified name chain); if the chain isn't wired, the raw name is used.
      author: sources.nameOf?.(i.authorPopclawId, a.name) || a.name, // '' when the ingest dropped the author → won't attribute (iron rule)
      handle: a.handle,
      sigil: a.sigil,
      avatarUrl: a.avatarUrl,
      profileUrl: a.profileUrl, // card head is always popclaw.me (ADR-0032)
      platformProfileUrl: a.platformProfileUrl, // the platform profile is only a source-return exit, never the card head
      followerCount: a.followerCount,
      verified: a.verified,
      // I5 display-layer budget (see the TEXT_MAX comment). The full text per ADR-0029 stays in the cache, not one character trimmed there.
      text: truncate(i.body, feature ? TEXT_MAX_CARD : TEXT_MAX_BRIEF),
      // v0.2: the same three signals also decide the density tier the renderer
      // lays this item out at, and the tier is printed in the brief so the agent
      // sizes its summary to it. One decision, made once, honoured in both halves.
      tier: feature ? ('card' as const) : ('brief' as const),
      platform: i.platform,
      url: itemUrl(i, sources.webBaseUrl, sources.primaryHouseSlug),
      // "💬 join the talk" button target (short id) — only exists for the primary lore-house, see postPageUrl.
      postPageUrl: postPageUrl(i, sources.webBaseUrl, sources.primaryHouseSlug),
      media: i.media.map((m) => m.url), // source-CDN image / video-thumbnail URLs
      eventId: i.eventId,
      authorPopclawId: i.authorPopclawId,
      markCount: i.markCount,
      replyCount: i.replyCount,
      isFollowing: sources.isFollowing(i.authorPopclawId, i.houseSlug),
      houseSlug: i.houseSlug || '', // prerequisite for per-lore-house sections; reads as undefined on the single-lore-house / SSE side
      kind: i.kind || '',
      ...(houseFields ? { houseFields } : {}),
      ...(bond ? { bondTier: bond.tier, remarkName: bond.remarkName } : {}),
      ...(bond?.dynamic ? { bondDynamic: truncate(bond.dynamic, DYNAMIC_MAX) } : {}),
      ...(reasons.length ? { reasons } : {}),
      ...(days !== undefined && days <= NEWCOMER_DAYS ? { newcomerDays: days } : {}),
    };
  });

  const dateLabel = dateOf(now);

  // ——— F3 house-letter diversion: a message from a lore-house's official name
  // (the official_ids persisted at guide-handshake time) is a **house letter,
  // not a ping**. Pings hold the paper's highest-priority spot, and their value
  // comes from "every single one here is genuinely waiting on you"; mix in
  // lore-house broadcasts and the owner starts skimming past the column by day
  // three. Diverting them must never turn into an undercount: the ledger discloses both figures consistently in two places (see prompt).
  const officialHouseOf = new Map<string, string>();
  for (const slug of sources.configuredHouseSlugs ?? []) {
    for (const id of sources.houseOfficialIds?.(slug) ?? []) if (id) officialHouseOf.set(id, slug);
  }
  const inboxItems = sources.inbox
    .recent(MAX_PINGS)
    .filter((m) => !isMuted(bondOf(m.fromPopclawId)));
  // Kept across windows: Mantel level ③ needs "the most recent letter from the world" (the paper's only place allowed to reach outside the window, and it must always carry a date).
  const allLetters = inboxItems.filter((m) => officialHouseOf.has(m.fromPopclawId));
  const houseLetters: HouseLetterItem[] = allLetters
    .filter((m) => m.ts >= start)
    .map((m) => letterOf(m, officialHouseOf.get(m.fromPopclawId)!));

  function letterOf(m: InboxItem, houseSlug: string): HouseLetterItem {
    // G4: the machine header is stripped whole out of the body (the lore-house's own guide §3 says "don't read this aloud"), its fields listed separately.
    const { header, rest } = splitHomeletterHeader(m.body || '');
    const links = urlsIn(rest);
    const images = links.filter((u) => IMAGE_URL_RE.test(u));
    const pages = links.filter((u) => !IMAGE_URL_RE.test(u));
    return {
      houseSlug,
      fromShort: displayNamed(m.fromPopclawId || '', sources.nameOf, bestById.get(m.fromPopclawId)?.name),
      dateLabel: dateOf(m.ts),
      body: truncate(rest, HOUSE_LETTER_BODY_MAX),
      ...(header ? { header } : {}),
      ...(pages.length ? { links: pages } : {}),
      ...(images.length ? { imageLinks: images } : {}),
    };
  }

  const pings: PingItem[] = inboxItems
    .filter((m) => m.ts >= start)
    .filter((m) => !officialHouseOf.has(m.fromPopclawId))
    .map((m) => {
      const bond = bondOf(m.fromPopclawId);
      const links = urlsIn(m.body || '');
      return {
        // This line gets laid out into the paper the owner reads. The inbox
        // table only has an id, no name → only a sigil is reported; a bare id
        // prefix is both meaningless and makes two strangers look like the
        // same person (ADR-0032). E1: if this issue's materials recognize the
        // id, feed the name into the name chain as a "self-reported name" (an alias still overrides it).
        fromShort: displayNamed(
          m.fromPopclawId || '',
          sources.nameOf,
          bestById.get(m.fromPopclawId)?.name,
        ),
        bodyPreview: (m.body || '').slice(0, PING_BODY_PREVIEW),
        ...(bond ? { bondTier: bond.tier, remarkName: bond.remarkName } : {}),
        // The bond-book update rides along so the page can print it under this
        // letter — that context is the reason pings sit on the front page at all.
        ...(bond?.dynamic ? { dynamic: truncate(bond.dynamic, DYNAMIC_MAX) } : {}),
        // E3: links inside the body are pulled out on their own — a url buried in the 80-char preview would render as plain text and be unclickable.
        ...(links.length ? { links } : {}),
      };
    })
    // Closest bonds first: pings are already the complete, none-omitted list; the sort only decides who the owner reads first.
    .sort((a, b) => bondSortRank(b.bondTier) - bondSortRank(a.bondTier));


  const byHouse = houseCounts(pulse);
  // E4: a subscribed lore-house with zero materials that day still gets its own
  // stack (masthead + notice board + pointer), or the owner would think it went
  // down. Only backfilled when this issue **is already split by lore-house** —
  // the fully-unsplit degradation path (a single "the world" stack with no lore-house field at all) is unaffected.
  if (Object.keys(byHouse).length) {
    for (const slug of sources.configuredHouseSlugs ?? []) byHouse[slug] ??= 0;
  }

  // ——— F4 Mantel: one line per lore-house laid out on the page, "how's my
  // little one doing", falling back one rung at a time down a five-level
  // degradation chain. ① (a lore-house digest) trumps everything else when
  // available; ②③④ have zero world dependency; if not even one level is reachable, the line is omitted entirely (⑤ = the old zero-material stack behavior).
  const mantles: MantleItem[] = [];
  for (const slug of Object.keys(byHouse)) {
    const m = mantleFor(slug);
    if (m) mantles.push(m);
  }

  // ——— G3 homes worth visiting: the public door-plate listing a lore-house
  // digest gives us (`visitUrl` is the door plate — constant, permanent,
  // clickable by anyone; world itself defines it as public enough to "share
  // freely on your feed"). The ranking basis is copied verbatim from what the lore-house gave; the paper only lays it out, never invents its own ranking.
  const homeSections: HomeSection[] = [];
  for (const slug of Object.keys(byHouse)) {
    const d = sources.digestOf?.(slug);
    if (!d?.homes.length) continue;
    const basis = rankingBasisOf(d, sources.language ?? ownerLangTag());
    homeSections.push({
      houseSlug: slug,
      asOf: stampOf(d.as_of, 'time'),
      ...(basis ? { rankingBasis: basis } : {}),
      homes: d.homes.map(homeItemOf),
    });
  }

  function idOfSigil(sig: string): string | undefined {
    if (!sigilTable) {
      sigilTable = new Map();
      const ids = new Set<string>([
        ...(firstSeen?.keys() ?? []),
        ...items.map((i) => i.authorPopclawId),
        ...(sources.knownPopclawIds ?? []),
      ]);
      for (const id of ids) if (id) sigilTable.set(deriveSigil(id), id);
    }
    return sigilTable.get(sig);
  }

  /**
   * How to address a home's owner, in priority order: the lore-house's own
   * `popclaw_id` (shipped 2026-07-31T07:32) → reverse-lookup by sigil on this
   * machine → the lore-house's own `display` → a bare sigil. Once an id is
   * found, go through the unified name chain (alias > self-reported name >
   * …); if all three levels come up empty, keep the old fallback. **Never invent a name.**
   *
   * When both are present, first verify `deriveSigil(popclaw_id) === sigil`
   * (the sigil is derived from the id in the first place): a mismatch means
   * this digest is internally inconsistent (a lore-house bug / a mixed-up
   * cache / manual tampering), and in that case it's better to discard this
   * id — falling back to sigil reverse-lookup or even a bare sigil — than to
   * pin the alias belonging to the id onto the person the sigil actually
   * points at — **misidentifying someone is worse than not recognizing them at all**.
   */
  function ownerLabel(o: DigestHome['owner']): string {
    const trustedId =
      o.popclaw_id && o.sigil && deriveSigil(o.popclaw_id) !== o.sigil ? undefined : o.popclaw_id;
    const id = trustedId || (o.sigil ? idOfSigil(o.sigil) : undefined);
    if (id) return displayNamed(id, sources.nameOf, o.nickname);
    const disp = (o.display ?? '').trim();
    // A bare sigil is a legitimate way to address someone — just add the `#` mark used consistently across the whole paper (the same notation as `name#sigil`).
    if (disp && disp === o.sigil) return `#${disp}`;
    return disp || (o.sigil ? `#${o.sigil}` : '');
  }

  function homeItemOf(h: DigestHome): HomeItem {
    return {
      name: h.name,
      visitUrl: h.visit_url,
      owner: ownerLabel(h.owner),
      ...(h.voice ? { voice: truncate(h.voice, HOME_VOICE_MAX) } : {}),
      ...(h.cover_img ? { coverImg: h.cover_img } : {}),
      // 0 isn't printed (v5): "0 visits today" would just make the owner think nobody goes there — when really the world has only just opened.
      ...(h.visits_today ? { visitsToday: h.visits_today } : {}),
      ...(h.built_at ? { builtAt: stampOf(h.built_at, 'date') } : {}),
    };
  }

  /** The paragraph for Mantel level ①: one sentence per little one, every fact drawn from the lore-house digest (day counts / postcard counts are all computed by the lore-house). */
  function figureLine(f: DigestFigure): string {
    const parts: string[] = [f.figure];
    if (f.state === 'home') {
      parts.push(f.city ? material('figure.atHomeIn', { city: f.city }) : material('figure.atHome'));
      return parts.join(' · ');
    }
    const retMs = f.return_at ? Date.parse(f.return_at) : NaN;
    // guide §2: once the return time has passed, say "on the way home", not still at the destination (the world's settlement is lazy).
    const overdue = Number.isFinite(retMs) && retMs <= now * 1000;
    parts.push(
      overdue
        ? f.city
          ? material('figure.onWayHomeFrom', { city: f.city })
          : material('figure.onWayHome')
        : f.city
          ? material('figure.in', { city: f.city })
          : material('figure.away'),
    );
    if (f.day !== undefined) parts.push(material('figure.day', { day: String(f.day) }));
    if (f.postcards_sent !== undefined) {
      const sent = String(f.postcards_sent);
      parts.push(
        f.postcards_total !== undefined
          ? material('figure.postcardsOf', { sent, total: String(f.postcards_total) })
          : material('figure.postcards', { sent }),
      );
    }
    if (f.return_at) {
      const time = stampOf(f.return_at, 'datetime');
      parts.push(material(overdue ? 'figure.dueBackOverdue' : 'figure.dueBack', { time }));
    }
    return parts.join(' · ');
  }

  function mantleFor(slug: string): MantleItem | undefined {
    // ① The lore-house digest's live status — the only place where "the lore-house itself says how my little one is doing", trumping every other level when available.
    const d = sources.digestOf?.(slug);
    if (d?.figures.length) {
      const visitUrl = d.figures.find((f) => f.visit_url)?.visit_url;
      return {
        houseSlug: slug,
        level: 1,
        asOf: stampOf(d.as_of, 'time'), // a figure must always cite its source and time
        text: d.figures.map(figureLine).join('; '),
        ...(visitUrl ? { url: visitUrl } : {}),
      };
    }
    const ofHouse = pulse.filter((p) => p.houseSlug === slug && p.houseFields);
    // ② One outing within today's window (the lore-house's own `<house>.trip` kind + its schema's fields verbatim).
    const trip = ofHouse.find((p) => p.kind.endsWith('.trip'));
    // The door plate is taken only from materials: whatever `*home_url` the
    // lore-house self-reported in any of today's events for this lore-house; no door given if it can't be built.
    const home = ofHouse
      .flatMap((p) => Object.entries(p.houseFields ?? {}))
      .find(([k, v]) => k.endsWith('home_url') && isHttpUrl(v))?.[1];
    if (trip) {
      // A sentence, not a field dump. `phase=returned · place_name=<city>` is the
      // MATERIAL; the mantel is the one line answering "how is my little one
      // doing", and layout §8 forbids an internal field name reaching the page.
      // The model used to compose this; with the layout in code it is composed here.
      const f = trip.houseFields!;
      const pick = (...keys: string[]): string => {
        for (const k of keys) {
          const hit = Object.entries(f).find(([key]) => key === k || key.endsWith(`.${k}`) || key.endsWith(`_${k}`));
          if (hit?.[1]) return hit[1];
        }
        return '';
      };
      const who = pick('figure_name');
      const place = pick('place_name', 'place');
      const phase = pick('phase').toLowerCase();
      const key = phase === 'returned' || phase === 'home' ? 'trip.returned' : phase ? 'trip.left' : 'trip.plain';
      return {
        houseSlug: slug, level: 2,
        // Nothing recognised at all → the lore-house's own fields verbatim, which is
        // still honest; better a raw line than an invented one.
        text: who || place ? material(key, { who, place }) : fieldsLine(f),
        ...(home ? { url: home } : {}),
      };
    }
    // ③ The most recent house letter — the paper's only place allowed to reach outside the window, at the cost that **a date is mandatory**.
    const last = allLetters.find((m) => officialHouseOf.get(m.fromPopclawId) === slug);
    if (last) {
      const l = letterOf(last, slug);
      return {
        houseSlug: slug, level: 3, dateLabel: l.dateLabel, text: l.body,
        ...(l.links?.[0] ? { url: l.links[0] } : {}),
      };
    }
    // ④ The `entry:` persisted the day of the guide handshake — even an owner who's never actually entered the world gets one clickable door.
    const entry = sources.houseEntryOf?.(slug);
    if (entry?.headline || entry?.home) {
      return {
        houseSlug: slug, level: 4,
        text: [
          entry.headline,
          entry.firstMove ? material('doorCard.firstMove', { phrase: entry.firstMove }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
        ...(entry.home ? { url: entry.home } : {}),
      };
    }
    return undefined; // ⑤ only the notice-board voice is left → the Mantel line is omitted entirely
  }

  // The candidate set gets its own token, distinct from the publish token the writing half
  // carries: publishing straight off a candidate token would put the whole day on the page,
  // which is the exact thing the choosing step exists to prevent.
  const candidateToken = `c${sources.mintToken()}`;

  // P2 lore-house notice board: one lookup per lore-house laid out this issue (including the 0-item lore-houses E4 backfilled); a lore-house with nothing available gets no line.
  const houseVoices: Record<string, string> = {};
  for (const slug of Object.keys(byHouse)) {
    const v = truncate(sources.houseVoiceOf?.(slug) ?? '', VOICE_MAX);
    if (v) houseVoices[slug] = v;
  }

  const draft: MaterialDraft = {
    dateLabel,
    windowLabel,
    ownerNickname: sources.ownerNickname,
    ...(sources.primaryHouseSlug ? { primaryHouseSlug: sources.primaryHouseSlug } : {}),
    totalCount: inWindow.length, // teaser hook: N items gathered <windowLabel>
    pings,
    pulse,
    byHouse,
    ...(Object.keys(houseVoices).length ? { houseVoices } : {}),
    ...(houseLetters.length ? { houseLetters } : {}),
    ...(mantles.length ? { mantles } : {}),
    ...(homeSections.length ? { homeSections } : {}),
  };
  return { kind: 'collected', candidateToken, lang, draft };
}
