/** Select the front page and stacks without rendering or consuming ornament budgets. */
import { tierRank, type BondTier } from '../bonds/bond-tier.js';
import type { IssueData, PulseItem } from './issue.js';
import { accentsFor, type NewspaperStyle } from './newspaper-style.js';
import { hasCopy, type EditorialCopy } from './editorial-copy.js';

/** The first three stacks always print in full; the codex folds only from the fifth stack onward. */
const MAX_FULL_DECKS = 3;
const MIN_DECKS_TO_FOLD = 5;
/**
 * How many person cards an issue carries, all stacks together. A fixed quota, not a share
 * of the day: the share rule (30% of each stack, capped by `style.cardMax`) collapsed on
 * real hardware into "carries a picture = gets a card", because a picture was the only
 * signal with any spread in it — 2026-08-26 came out as 28 cards from 28 pictures, and
 * 2026-08-27 as 5 from 5. The paper's shape was being decided by how many people happened
 * to post photos that day. Twelve is the owner's number, and it is also what the issue he
 * approved carries.
 */
const CARD_QUOTA = 12;

export interface Deck {
  slug: string;
  accent: string;
  /** Ordinary posts that earn a card, front-page picks already removed. */
  cards: PulseItem[];
  briefs: PulseItem[];
  postcards: PulseItem[];
  chron: PulseItem[];
  misc: PulseItem[];
  /** Card item → that person's other items in this stack, printed under their one card head. */
  also: Map<PulseItem, PulseItem[]>;
  /** Total items this stack carried before the front page took any. */
  total: number;
  /** Ordinary posts the writer never wrote up — left out of the issue, said out loud below. */
  unwritten: number;
  /** How many of them are on the front page — printed in the stack head so the count still adds up. */
  onFront: number;
}

/** Two items by the same person — by popclaw id where there is one, else by name#sigil. */
const sameAuthor = (x: PulseItem, y: PulseItem): boolean =>
  x.authorPopclawId ? x.authorPopclawId === y.authorPopclawId : Boolean(x.author) && x.author === y.author && x.sigil === y.sigil;

/** The last segment of an event kind, lowercased: `world.Postcard` / `house:postcard` → `postcard`. */
export function kindLeaf(kind: string): string {
  return kind.split(/[.:]/).pop()?.toLowerCase() ?? '';
}

const CHRON_KINDS = new Set(['trip', 'encounter', 'embodiment', 'souvenirtransfer', 'souvenir']);

/** Which column a lore-house event belongs in. Anything we don't recognise goes to "also noted", verbatim — never guessed at. */
function columnOfEvent(p: PulseItem): 'postcards' | 'chron' | 'misc' {
  const leaf = kindLeaf(p.kind);
  if (leaf === 'postcard') return 'postcards';
  return CHRON_KINDS.has(leaf) ? 'chron' : 'misc';
}

export interface RenderPlan {
  leads: PulseItem[];
  postcard: PulseItem | undefined;
  onFront: Set<PulseItem>;
  decks: Deck[];
  full: Deck[];
  rest: Deck[];
  notes: string[];
}

/**
 * Numbering belongs to the caller's material page. Every item and deck in the
 * plan retains its identity; full/rest partition the same decks, never copies.
 * Only placement facts cross this interface: no HTML, language, IO or budgets.
 */
export function planNewspaper(
  issue: Pick<IssueData, 'pulse' | 'byHouse' | 'mantles' | 'houseLetters' | 'homeSections'>,
  edit: EditorialCopy & { leads?: readonly number[] },
  style: Pick<NewspaperStyle, 'leadMax' | 'cardMax' | 'deckOrder' | 'accent' | 'houseAccents'>,
  numberOf: ReadonlyMap<PulseItem, number>,
): RenderPlan {
  const notes: string[] = [];
  const onFront = new Set<PulseItem>();
  // ——— the front page's picks, in the agent's own order, capped by the owner's knob.
  const byNumber = new Map([...numberOf].map(([p, n]) => [n, p] as const));
  const leads: PulseItem[] = [];
  for (const n of edit.leads ?? []) {
    const p = byNumber.get(n);
    if (!p) {
      notes.push(`edit.leads: no item [${n}] in this issue (ignored)`);
      continue;
    }
    if (p.houseFields) {
      // A lore-house event is written from its own fields, so the agent has no copy
      // for it and never sees its number — a postcard reaches the front page by the
      // rule below, not by being asked for.
      notes.push(`edit.leads: item [${n}] is a lore-house event and is laid out in its own column (ignored)`);
      continue;
    }
    if (!hasCopy(edit, n)) {
      // The front page is the one place a raw feed line would be loudest.
      notes.push(`edit.leads: item [${n}] has no copy and cannot be a headline (ignored)`);
      continue;
    }
    // The same face must not hold the front page twice — their other items go on
    // their card in the stack as an "also" line (codex §2).
    if (leads.some((q) => sameAuthor(q, p))) {
      notes.push(`edit.leads: item [${n}] is by someone already on the front page (moved into their card)`);
      continue;
    }
    if (leads.length < style.leadMax) leads.push(p);
  }
  if ((edit.leads?.length ?? 0) > style.leadMax) {
    notes.push(`edit.leads: ${edit.leads!.length} given, style.leadMax is ${style.leadMax} — the rest were dropped`);
  }
  // Content §5.2 asks for one postcard on the front page whenever the day has one:
  // faces of the day — what people said, and that someone is out walking around.
  // The agent cannot pick it (it never sees a lore-house event's number), so the
  // page promotes the first one itself, only when the front page has room.
  const postcard = leads.length < style.leadMax
    ? issue.pulse.find((p) => p.houseFields && columnOfEvent(p) === 'postcards')
    : undefined;
  leads.forEach((p) => onFront.add(p));
  // Settled before the stacks are built, so the column it came from can leave a
  // line where it was instead of printing it twice.
  if (postcard) onFront.add(postcard);

  // A front-page story stands **alone**: the approved issue has 28 "also" lines and
  // not one of them is in a lead. The author's other items stay in the stack below
  // and group onto their card there, which is where the codex puts them — folding
  // them onto the front page instead piles a wall of continuations under the
  // headline, which is what "there is a lot of repetition" turns out to mean.

  // ——— stacks. One per lore-house, plus the unsplit fallback for a machine whose
  // feed carries no lore-house field at all.
  const slugs = Object.keys(issue.byHouse);
  const ordered = style.deckOrder.length
    ? [...slugs].sort((x, y) => {
        const ix = style.deckOrder.indexOf(x);
        const iy = style.deckOrder.indexOf(y);
        return (ix < 0 ? Infinity : ix) - (iy < 0 ? Infinity : iy);
      })
    : [...slugs].sort((x, y) => (issue.byHouse[y] ?? 0) - (issue.byHouse[x] ?? 0));
  const accents = accentsFor(ordered.length ? ordered : [''], style);
  const decks: Deck[] = (ordered.length ? ordered : ['']).map((slug) => {
    const mine = issue.pulse.filter((p) => (p.houseSlug || '') === slug);
    const events = mine.filter((p) => p.houseFields);
    const written = mine.filter((p) => !p.houseFields && hasCopy(edit, numberOf.get(p)));
    const plain = written.filter((p) => !onFront.has(p));
    const unwritten = mine.filter((p) => !p.houseFields).length - written.length;
    // The codex fixes the shape as roughly 5% headline / 30% card / 65% brief —
    // the paper's whole look comes from that difference in density, and a page
    // that is 44% cards reads as a wall. `tier` says who is ELIGIBLE for a card;
    // how many actually get one is a share of the stack, and **which** ones is a
    // ranking (the codex says: the weightiest of the day), never "whichever arrived first".
    const weight = (p: PulseItem): number =>
      (p.bondTier ? tierRank(p.bondTier as BondTier) * 100 : 0) +
      p.replyCount + p.markCount +
      (p.media.length ? 3 : 0) +
      (p.reasons?.length ? 2 : 0);
    // This stack's share of the issue-wide card quota, by how much of the day it carried.
    const share = issue.pulse.length ? mine.length / issue.pulse.length : 0;
    const room = Math.min(style.cardMax, Math.max(1, Math.round(CARD_QUOTA * share)));
    const cardSet = new Set(
      plain
        .filter((p) => p.tier === 'card')
        .sort((x, y) => weight(y) - weight(x))
        .slice(0, room),
    );
    const cards = plain.filter((p) => cardSet.has(p)); // back into page order
    // Someone with a card takes their other items with them, out of the brief
    // column and onto their own card as "also" lines — one person, one card head.
    const claimed = new Set<PulseItem>();
    const also = new Map<PulseItem, PulseItem[]>();
    for (const p of cards) {
      const more = plain.filter((q) => q !== p && !cardSet.has(q) && sameAuthor(q, p));
      if (more.length) also.set(p, more);
      for (const q of more) claimed.add(q);
    }
    return {
      slug,
      accent: accents[slug] ?? style.accent,
      cards,
      briefs: plain.filter((p) => !cardSet.has(p) && !claimed.has(p)),
      also,
      postcards: events.filter((p) => columnOfEvent(p) === 'postcards'),
      chron: events.filter((p) => columnOfEvent(p) === 'chron'),
      misc: events.filter((p) => columnOfEvent(p) === 'misc'),
      total: mine.length,
      unwritten,
      onFront: mine.filter((p) => onFront.has(p)).length,
    };
  });
  // At five stacks or more the tail's ORDINARY posts fold into one "other
  // lore-houses" column, so the paper stays a map and not a warehouse (codex §5).
  // Everything that only exists once — a mantel, a letter from the world, a
  // postcard, a home worth visiting — stays in its own stack: folding those away
  // silently deleted the world stack the moment a fourth lore-house appeared,
  // because the stacks are ordered by item count and the world one is usually the
  // quiet one.
  const foldable = (d: Deck): boolean =>
    !d.postcards.length && !d.chron.length && !d.misc.length &&
    !issue.mantles?.some((m) => m.houseSlug === d.slug) &&
    !issue.houseLetters?.some((l) => l.houseSlug === d.slug) &&
    !issue.homeSections?.some((h) => h.houseSlug === d.slug);
  const rest = decks.length >= MIN_DECKS_TO_FOLD ? decks.slice(MAX_FULL_DECKS).filter(foldable) : [];
  const restSet = new Set(rest);
  const full = decks.filter((d) => !restSet.has(d));

  return { leads, postcard, onFront, decks, full, rest, notes };
}
