/**
 * renderNewspaper — the layout, in code (v0.2).
 *
 * Takes the issue gather stored, the copy the agent wrote (`edit`) and the
 * owner's knobs (`style`), and returns one finished page. Nothing here asks the
 * model for anything: every link, avatar, figure, count and section head is
 * assembled from the materials, which is why the fidelity check that used to
 * police the model's HTML no longer needs to exist.
 *
 * The rules laid out here are the ones the layout codex used to read aloud
 * (`layout.md` §1–§9, `content.md` §5/§7/§8). Where a rule was a
 * self-check item ("does the world stack print a discussion button?"), it is an
 * invariant of this file now, and the tests assert it.
 */
import { renderCopy, type Lang } from '../lexicon/index.js';
import { tierLabel, tierRank, type BondTier } from '../bonds/bond-tier.js';
import { planNewspaper, type Deck } from './render-plan.js';
import { createPersonItemRenderer, type PersonItemRenderer } from './person-item-renderer.js';
import { a, esc, head3, linkText, NO_REFERRER } from './render-html.js';
import { createHouseMaterialRenderer, type HouseMaterialRenderer } from './house-material-renderer.js';
import type { EditorialCopy } from './editorial-copy.js';
import { doorbellScript, type ChipStrings } from './follow-chip.js';
import {
  castList,
  numberedPulse,
  type IssueData,
  type PulseItem,
} from './issue.js';
import {
  buildCss,
  fontLinks,
  sectionsFor,
  type NewspaperStyle,
  type SectionId,
} from './newspaper-style.js';

/**
 * What the agent hands in. Every field is optional at the type level and checked
 * at the door (`checkEdit`) — a model that drops a key must get a page and a
 * named complaint, never a stack trace.
 */
export interface NewspaperEdit {
  masthead?: string;
  /**
   * The basis id of the page this copy was numbered from — the publish token of that
   * very issue, printed on the material page and carried back verbatim inside `edit`
   * (a plain field, NOT a `*_token` tool argument, so token-scrubbing channels have no
   * rule against it — a protocol requirement the page teaches, not a physical
   * guarantee). Publish treats it as the batch SELECTOR: it names the exact materials
   * the item numbers refer to (2026-09-06 r7; since r9 the only tokenless binding —
   * a hand-in carrying neither basis nor token is refused). The layout never reads it.
   */
  basis?: string;
  edition?: string;
  weather?: readonly string[];
  /** Item numbers for the front page, weightiest first. */
  leads?: readonly number[];
  /**
   * Item number → the headline and summary for it, plus `q`: the passage of that
   * item's own body the writer copied verbatim before writing them. `q` is the
   * faithfulness anchor publish checks (`copy-anchor.ts`) — the one mechanical
   * defence against a summary landing under another item's legal number. **The
   * layout never reads it**: an item counts as written on `h` or `s`, exactly as
   * before, and `q` is never printed.
   */
  items?: EditorialCopy['items'];
  /** Item number → one verbatim quotation to set as a pull quote. */
  pulls?: Readonly<Record<string, string>>;
  /** Item number → one sentence naming a real connection to another item in this issue. */
  xrefs?: Readonly<Record<string, string>>;
  /**
   * Item number → a 2-6 character subsection name. The codex asks the owner's own
   * stack to be split into thematic subsections, and which items belong together is a
   * judgement only the writer can make. Absent = one unnamed column, as before.
   */
  topics?: Readonly<Record<string, string>>;
  /** lore-house slug → one sentence of editor's note. */
  deckNotes?: Readonly<Record<string, string>>;
  /** sigil → 2-3 sentences on a new face. */
  newbies?: Readonly<Record<string, string>>;
  /**
   * A line the layout prints word for word (a lore-house's ranking basis, a keeper's own
   * line) → its translation into the owner's language. Keyed by the original **exactly**:
   * a key that matches nothing is simply never looked up, so a writer who paraphrases the
   * key, or translates a name we never ask about, costs the page nothing.
   */
  translations?: Readonly<Record<string, string>>;
  teaser?: string;
}

/** How many new faces the front-page ear carries. */
const EAR_NEW_FACES = 6;

interface Ctx {
  lang: Lang;
  issue: IssueData;
  edit: NewspaperEdit;
  style: NewspaperStyle;
  numberOf: ReadonlyMap<PulseItem, number>;
  L: (key: string, vars?: Record<string, string>) => string;
  house: HouseMaterialRenderer;
  person: PersonItemRenderer;
}

/** How many of a thing, in the measure word the whole paper uses. */
const items = (c: Ctx, n: number): string => c.L('page.items', { count: String(n) });

/* -------------------------------------------------------------- the page */

/** A column head with its count on the right. */
function kicker(c: Ctx, id: SectionId, count: number, anchor = ''): string {
  return head3(c.L(`page.section.${id}`), items(c, count), anchor);
}

/**
 * Group a column's items by author, keeping page order: one card head per person,
 * their other items appended as "also" lines (codex §2). Returns `[first, ...rest]` runs.
 */
function byAuthor(list: readonly PulseItem[]): PulseItem[][] {
  const runs = new Map<string, PulseItem[]>();
  const order: string[] = [];
  for (const p of list) {
    // `${p.author}#${p.sigil}` is '#' for an unattributed item — truthy, so every
    // one of them used to collapse under a single head with "also" continuations,
    // which is the paper's notation for ONE person's follow-ups. Attributing two
    // strangers to each other is the iron rule's worst failure, so they never group.
    const key = p.authorPopclawId || (p.author ? `${p.author}#${p.sigil}` : `anon:${order.length}`);
    if (!runs.has(key)) {
      runs.set(key, []);
      order.push(key);
    }
    runs.get(key)!.push(p);
  }
  return order.map((k) => runs.get(k)!);
}

/**
 * Split the brief column into the agent's themed subsections — the shape the
 * approved issue had — the column's own name, then the theme, one section per theme.
 *
 * Grouped **by name**, not by run: a theme is one section wherever its items
 * happen to sit in page order, otherwise an interleaved feed splits one theme into
 * three separate columns. Sections come in the order each name is first used, and
 * anything unnamed falls to the end as the plain column. No topics at all = one
 * unnamed column, which is the behaviour without the field.
 */
function byTopic(c: Ctx, list: readonly PulseItem[]): { title: string; items: PulseItem[] }[] {
  const groups = new Map<string, PulseItem[]>();
  for (const p of list) {
    const title = c.edit.topics?.[String(c.numberOf.get(p))]?.trim() ?? '';
    (groups.get(title) ?? groups.set(title, []).get(title)!).push(p);
  }
  const named = [...groups].filter(([title]) => title);
  const rest = groups.get('') ?? [];
  return [...named.map(([title, items]) => ({ title, items })), ...(rest.length ? [{ title: '', items: rest }] : [])];
}

function renderDeck(c: Ctx, d: Deck, index: number): string {
  const out: string[] = [];
  const voice = c.issue.houseVoices?.[d.slug];
  const note = c.edit.deckNotes?.[d.slug]?.trim();
  const house = c.house.forDeck(d);
  const ordinal = c.L(`page.ordinal.${Math.min(index + 1, 9)}`);
  // The stack's character word: what this lore-house's items ARE. Comings and
  // goings for a house that carries a figure, a home or an event — including on a
  // day it carried nothing else, which is exactly when the word has to be right.
  const deeds =
    d.postcards.length + d.chron.length > d.cards.length + d.briefs.length ||
    (house.hasMantleOrHomes && !d.cards.length && !d.briefs.length);
  const character = c.L(deeds ? 'page.character.deeds' : 'page.character.talk');

  out.push(
    `<section class="deck" id="deck-${esc(d.slug)}" style="--accent:${esc(d.accent)}">`,
    `<div class="deckhead"><b>${esc(
      // One unnamed stack is not "stack one of one" — it is just the paper.
      d.slug ? c.L('page.deckName', { index: ordinal, house: d.slug }) : c.L('page.oneDeck'),
    )}</b>` +
      `<em>${esc(
        c.L('page.deckCount', {
          paper: c.edit.masthead ?? '',
          date: c.issue.dateLabel,
          index: ordinal,
          character,
          count: String(d.total),
          front: String(d.onFront),
        }),
      )}</em></div>`,
  );
  // The stack head counts everything the day carried, so what the writer never wrote
  // up has to be named here or the sections stop adding up (the same discipline as
  // the front-page line below).
  if (d.unwritten) out.push(`<p class="note">${esc(c.L('page.unwritten', { count: String(d.unwritten) }))}</p>`);
  if (voice) out.push(`<p class="voice">${esc(voice)}</p>`);

  // One ordered list of columns, every one of them gated on its own material.
  // Never a switch between two column sets — see SECTION_ORDER for what that cost.
  for (const section of sectionsFor(d.slug, c.style)) {
    switch (section) {
      case 'mantle':
      case 'letters':
      case 'postcards':
      case 'chron':
      case 'homes':
      case 'misc':
        out.push(...house.column(section));
        break;
      case 'leads':
        // Headline cards live on the front page; what stays here is the honest
        // line saying so, so the stack's own count still adds up.
        if (d.onFront) out.push(`<p class="note">${esc(c.L('page.onFront', { count: String(d.onFront) }))}</p>`);
        break;
      case 'cards':
        if (d.cards.length) {
          // Count what the column actually prints: a card carries that person's
          // other items as "also" lines, and those were taken out of the brief
          // column — leaving them out of both is how the sections stop adding up (§8).
          const alsoShown = [...d.also.values()].reduce((n, v) => n + v.length, 0);
          out.push(kicker(c, 'cards', d.cards.length + alsoShown));
          out.push(
            `<div class="grid">${byAuthor(d.cards)
              .map(([first, ...same]) => c.person.card(first!, { more: [...same, ...(d.also.get(first!) ?? [])] }))
              .join('')}</div>`,
          );
        }
        break;
      case 'briefs':
        if (c.style.briefs && d.briefs.length) {
          let first = true;
          for (const group of byTopic(c, d.briefs)) {
            // The head reads "<column> · <theme>" — the column keeps its name and the
            // theme qualifies it, which is how the approved issue reads.
            const label = group.title
              ? c.L('page.sectionTheme', { section: c.L('page.section.briefs'), theme: group.title })
              : c.L('page.section.briefs');
            out.push(head3(label, items(c, group.items.length), first ? `briefs-${d.slug}` : ''));
            out.push(`<div class="briefs">${group.items.map((p) => c.person.brief(p)).join('')}</div>`);
            first = false;
          }
        }
        break;
    }
  }
  // A subscribed lore-house with nothing today still gets its stack (E4) — otherwise
  // the owner thinks it went down. One restrained line, no invented items, and it
  // carries the same ▢ mark every editor's note on the page carries (§10, one symbol one meaning).
  if (note || !d.total) {
    out.push(`<p class="note">${esc(c.L('page.note', { text: note || c.L('page.quietHouse') }))}</p>`);
  }
  out.push(`</section>`);
  return out.join('\n');
}

/**
 * The awaiting-reply ear. Split out from the other two on purpose: the codex
 * fixes the **DOM** order on a phone as awaiting-reply -> the lead stories -> new faces ->
 * the count, and says in as many words not to fake it with CSS `order`. This is
 * the one thing on the page that is a to-do list; three full stories must not
 * stand in front of it on the device the owner actually reads on.
 */
function awaitingEar(c: Ctx): string {
  // An empty to-do list does not get the top of the front page. Before this, a day with
  // nobody waiting on the owner opened with a box saying so — on a phone, that box was the
  // first thing on the page, every day. The weather line already reports the count, so
  // nothing is lost by leaving the ear out entirely.
  if (!c.issue.pings.length) return '';
  const rows: string[] = [`<aside class="ear" id="await"><h4>${esc(c.L('page.ear.awaiting'))}</h4>`];
  for (const p of c.issue.pings) {
    const links = (p.links ?? []).map((u) => a(u, esc(linkText(u)))).join(' · ');
    const tier = p.bondTier as BondTier | undefined;
    const bond =
      tier && tierRank(tier) >= tierRank('acquaintance')
        ? ` <span class="tag">${esc(p.remarkName || tierLabel(tier, c.lang))}</span>`
        : '';
    // The bond-book update belongs right under the letter it bears on: who to
    // answer and how is decided here, so the context is here (codex §7).
    const recent = p.dynamic ? `<span class="note">${esc(c.L('page.note', { text: p.dynamic }))}</span>` : '';
    rows.push(
      `<div class="row"><b>${esc(p.fromShort)}</b>${bond} ${esc(p.bodyPreview)}${links ? `<br>${links}` : ''}${recent}</div>`,
    );
  }
  rows.push(`</aside>`);
  return rows.join('\n');
}

/** New faces and the issue's own accounts — the rest of the front-page ear. */
function ledgerEars(c: Ctx, decks: readonly Deck[], leads: readonly PulseItem[]): string {
  const rows: string[] = [];
  // New faces: people the owner does not follow yet who came with a verifiable
  // reason. The reason is set **short** here — the card prints the full sentence,
  // and the codex forbids repeating it word for word (§6).
  const seen = new Set<string>();
  // Gated on being new to this machine, not on carrying a recommendation reason. The reason
  // field is empty on real hardware (0 of 51 on 2026-08-26 — the taste matcher compared
  // Chinese tags against an English feed), so keying the ear off it meant the one surviving
  // "new faces" surface never appeared at all once the board beside it was deleted.
  const faces = c.issue.pulse
    .filter((p) => p.author && !p.isFollowing && p.newcomerDays !== undefined)
    .filter((p) => (seen.has(p.sigil) ? false : (seen.add(p.sigil), true)))
    .slice(0, EAR_NEW_FACES);
  if (faces.length) {
    rows.push(`<aside class="ear"><h4>${esc(c.L('page.ear.newFaces'))}</h4>`);
    for (const p of faces) rows.push(c.person.newFace(p));
    rows.push(`</aside>`);
  }

  // The count. Every figure is computed from the same arrays the page was laid
  // out from, and the measure-word convention is stated once, right here.
  const cast = castList(c.issue.pulse);
  const listed = cast.filter((m) => m.first.profileUrl).length;
  const replies = c.issue.pulse.reduce((n, p) => n + p.replyCount, 0);
  const marks = c.issue.pulse.reduce((n, p) => n + p.markCount, 0);
  rows.push(
    `<aside class="ear"><h4>${esc(c.L('page.ear.ledger'))}</h4>`,
    `<div class="row">${esc(decks.map((d) => c.L('page.deckTally', { house: d.slug, count: String(d.total) })).join(' · '))}</div>`,
    `<div class="row">${esc(
      c.L('page.ledgerTotals', {
        people: String(cast.length),
        laidOut: String(c.issue.pulse.length),
        gathered: String(c.issue.totalCount),
        front: String(leads.length),
      }),
    )}</div>`,
    `<div class="row">${esc(c.L('page.ledgerEchoes', { replies: String(replies), marks: String(marks) }))}</div>`,
    `<div class="row">${esc(
      c.L('page.ledgerPings', { pings: String(c.issue.pings.length), letters: String(c.issue.houseLetters?.length ?? 0) }),
    )}</div>`,
    // The gap between "people who appeared" and "people the roster can link to"
    // is disclosed once, here, and nowhere else (codex §8).
    ...(listed !== cast.length
      ? [`<div class="row meta">${esc(c.L('page.rosterGap', { listed: String(listed), cast: String(cast.length) }))}</div>`]
      : []),
    `<div class="row meta">${esc(c.L('page.ledgerBasis'))}</div>`,
    `</aside>`,
  );
  return rows.join('\n');
}

/**
 * Lay out one issue.
 *
 * Returns the page **and** whatever the copy got wrong (`notes`) — an item the
 * agent skipped, a number that points at nothing, a style key that isn't real.
 * The page is always produced: a paper thinner than it should be still beats no
 * paper, and the receipt says exactly what was thin about it.
 */
/**
 * What the page is allowed to reach for, and whether it has a doorbell.
 *
 * The defaults are today's page exactly — the hosted issue on the canvas — so a
 * caller that passes nothing gets what it always got. The opt-outs exist for the
 * copy that lands on the owner's own disk: "zero dependency" (owner ruling
 * 2026-09-12) means the file needs no popclaw service to be a paper, not that it
 * refuses to load a web font.
 */
export interface RenderOptions {
  /** The live owner nickname, for the masthead attribution and the share line. */
  ownerNickname?: string;
  /**
   * `web` (default): link the font stylesheets, as the hosted page does — the
   * local file then looks identical to the one online, and falls back to the
   * system stacks when there is no network. `system`: link nothing at all.
   */
  fonts?: 'web' | 'system';
  /**
   * `inline` (default): the faces are remote urls here, and publish bakes them
   * into the page as data URIs (`avatar-inline.ts`). `off`: no face is ever
   * fetched, by anyone — every one of them is the monogram, drawn here.
   */
  avatars?: 'inline' | 'off';
  /**
   * Whether this page has a doorbell (chips + the inline script). `false` drops
   * every trace of it: a paper nobody can publish has nothing to ring.
   */
  doorbell?: boolean;
  /**
   * The publisher's own popclaw id, so their byline never wears a follow chip
   * on their own paper. Following yourself is not a thing, and the intent it
   * minted was real: a click on it reached the canvas as publisher → publisher
   * and came back to the publisher's own plugin as somebody to follow.
   *
   * Nothing new lands on the page: the only id this removes is one the chip
   * itself was already carrying in `data-followee`. Absent (every local-copy
   * caller) leaves every chip exactly as it was — publish is the one caller
   * that turns the doorbell on, and it is the one that knows who signed.
   */
  ownerPopclawId?: string;
}

export function renderNewspaper(
  issue: IssueData,
  edit: NewspaperEdit,
  style: NewspaperStyle,
  lang: Lang,
  opts: RenderOptions = {},
): { html: string; notes: string[]; unwritten: number; unwrittenNumbers: number[]; headsByNumber: Map<number, string> } {
  const notes: string[] = [];
  const L = (key: string, vars: Record<string, string> = {}): string => {
    // Page furniture lives under `newspaper.page.*`; the material slots the codex
    // already named (buttons, the unattributed fallback) keep their old keys so
    // both halves of the paper go on speaking with one vocabulary.
    const full = key.startsWith('page.') ? `newspaper.${key}` : `newspaper.material.${key}`;
    return renderCopy(lang, full, vars);
  };
  const numberOf = new Map(numberedPulse(issue.pulse).map(({ p, n }) => [p, n] as const));
  const chip: ChipStrings & { stripOwner: string; stripGuest: string; loginPrompt: string; pairHint: string } = {
    cta: L('page.followCta'),
    sent: L('page.followSent'),
    exists: L('page.followExists'),
    fail: L('page.followFail'),
    followed: L('page.followFollowed'),
    pairFirst: L('page.followPairFirst'),
    stripOwner: L('page.followStripOwner'),
    stripGuest: L('page.followStripGuest'),
    loginPrompt: L('page.followStripLogin'),
    pairHint: L('page.followPairHint'),
  };
  // Defaults are the hosted page: fonts linked, faces fetched at publish time,
  // doorbell live. Every existing caller passes none of them and changes nothing.
  const fonts = opts.fonts ?? 'web';
  const avatars = opts.avatars ?? 'inline';
  const doorbell = opts.doorbell !== false;
  // The doorbell's owner attribution comes from PublishDeps (the issue's own
  // `ownerNickname` is the gather-time snapshot; publish hands in the live one).
  // Absent = the paper still lays out, just unsigned — the same honest
  // degradation every optional material gets here.
  const owner = opts.ownerNickname?.trim() || '';

  const { leads, postcard, onFront, decks, full, rest, notes: planNotes } = planNewspaper(issue, edit, style, numberOf);
  notes.push(...planNotes);

  const c: Ctx = {
    lang, issue, edit, style, numberOf, L,
    house: createHouseMaterialRenderer({
      lang, translations: edit.translations, mantles: issue.mantles,
      houseLetters: issue.houseLetters, homeSections: issue.homeSections, onFront,
    }),
    person: createPersonItemRenderer({
      numberOf, copy: edit, lang, primaryHouseSlug: issue.primaryHouseSlug, avatars,
      follow: doorbell ? { ownerPopclawId: opts.ownerPopclawId ?? '', strings: chip } : undefined,
    }),
  };

  const cast = castList(issue.pulse);
  // Sorted by the basis the board prints — newest first. `castList` orders by item
  // count, so the board used to state one ranking and show another, which is the
  // false-ranking claim §8 forbids outright.
  const newFaces = cast
    .filter((m) => m.first.newcomerDays !== undefined)
    .sort((x, y) => (x.first.newcomerDays ?? 0) - (y.first.newcomerDays ?? 0));

  const body: string[] = [];
  body.push(`<div class="wrap">`);
  body.push(
    `<header class="masthead"><h1>${esc(edit.masthead ?? '')}</h1>` +
      // Masthead attribution (spec §6.1): the paper is signed by its owner. The
      // name is never baked into the lexicon — the layout pairs it with the h1.
      (owner ? `<div class="masthead-owner">${esc(L('page.mastheadOwner', { owner }))}</div>` : '') +
      `</header>`,
    `<div class="rule2"></div>`,
  );
  body.push(
    `<p class="dateline">${esc(
      // The dateline counts what is IN this paper; the gap to what was gathered
      // is stated once, in the ledger (codex §8: one convention, disclosed once).
      [issue.dateLabel, edit.edition ?? '', L('page.byline'), items(c, issue.pulse.length)].filter(Boolean).join(' · '),
    )}</p>`,
  );
  body.push(
    `<p class="weather">${esc(
      L('page.weather', {
        total: String(issue.totalCount),
        pings: String(issue.pings.length),
        // Diverting the lore-house letters out of the pings must not turn into an
        // undercount: the codex requires BOTH the weather line and the ledger to
        // state the two figures together.
        letters: String(issue.houseLetters?.length ?? 0),
        drifts: (edit.weather ?? []).join(' · '),
      }),
    )}</p>`,
  );
  // How much of this issue was actually chosen for the owner, said once, where he looks
  // first. On a machine whose bond book holds two people most of a paper is going to be the
  // filling for a while — he asked to be shown that number rather than handed a page that
  // quietly implies otherwise. The same figures repeat in the ledger ear.
  {
    const by = (kind: PulseItem['pickedFor']): number => issue.pulse.filter((p) => p.pickedFor === kind).length;
    const taste = by('taste');
    const bond = by('bond');
    if (taste || bond) {
      body.push(
        `<p class="weather meta">${esc(
          L('page.chosen', {
            taste: String(taste),
            bond: String(bond),
            lively: String(issue.pulse.length - taste - bond),
          }),
        )}</p>`,
      );
    }
  }
  // Every anchor here must land somewhere — the codex is explicit that an index
  // entry pointing at nothing is a defect, so each one is gated on its section
  // actually being emitted below.
  const listed = cast.filter((m) => m.first.profileUrl);
  // The board it used to point at is gone (see below); the index entry goes with it —
  // the codex is explicit that an index entry landing nowhere is a defect.
  const showNewbies = false;
  const showRoster = style.roster && listed.length > 0;
  if (style.index) {
    const links = [
      `<a href="#top">${esc(L('page.section.leads'))}</a>`,
      `<a href="#await">${esc(L('page.ear.awaiting'))}(${esc(String(issue.pings.length))})</a>`,
      ...full.map(
        (d) => `<a href="#deck-${esc(d.slug)}">${esc(d.slug || L('page.oneDeck'))}(${esc(items(c, d.total))})</a>`,
      ),
      rest.length ? `<a href="#misc-houses">${esc(L('page.otherHouses'))}</a>` : '',
      showNewbies ? `<a href="#newbies">${esc(L('page.newbies'))}(${esc(L('page.people', { count: String(newFaces.length) }))})</a>` : '',
      showRoster ? `<a href="#roster">${esc(L('page.roster'))}(${esc(L('page.people', { count: String(listed.length) }))})</a>` : '',
    ].filter(Boolean);
    body.push(`<nav class="index">${links.join(' · ')}</nav>`);
  }

  // DOM order is the phone's order: awaiting reply, the lead stories, new faces, the
  // count. Desktop puts the ears back in the right-hand column with grid, never
  // by reversing `order` (codex §2).
  body.push(`<section class="top" id="top">`, `<div class="rail-a">${awaitingEar(c)}</div>`);
  body.push(`<div class="lead-col">`);
  leads.forEach((p, i) => body.push(c.person.card(p, { lead: true, drop: i === 0 })));
  if (postcard) body.push(`<div class="grid">${c.house.postcard(postcard)}</div>`);
  body.push(`</div>`, `<div class="rail-b">${ledgerEars(c, decks, leads)}</div>`, `</section>`);

  for (const [i, d] of full.entries()) body.push(renderDeck(c, d, i));
  if (rest.length) {
    // Every row says which lore-house it came from — otherwise a folded stack's
    // items look like they belong to nobody (codex §5, name the lore-house at the head of each row).
    const spill = rest.flatMap((d) => [...d.cards, ...d.briefs].map((p) => [p, d.slug] as const));
    body.push(
      `<section class="deck" id="misc-houses" style="--accent:${esc(style.accent)}">`,
      `<div class="deckhead"><b>${esc(L('page.otherHouses'))}</b><em>${esc(items(c, spill.length))}</em></div>`,
      `<div class="briefs">${spill.map(([p, slug]) => c.person.brief(p, slug)).join('')}</div>`,
      `</section>`,
    );
  }

  // The new-faces board is gone: the ear on the front page already lists the same people,
  // with their reason and their latest line, and on a machine where nearly every author is
  // new to it the board grew into a second roster of the same names. The ear is short, it is
  // where the owner is already looking, and `style.newbieBoard` still turns it off.

  // No page url ⇒ not in the roster (codex §6). The count is of what is actually
  // listed, not of the cast — a number beside a list has to be that list's number,
  // and the gap between the two is disclosed once, in the ledger.
  if (showRoster) {
    body.push(
      `<section class="roster-wrap" id="roster">`,
      head3(L('page.roster'), L('page.people', { count: String(listed.length) })),
      `<div class="roster">`,
      listed.map((m) => c.person.rosterEntry(m.first, m.label)).join(''),
      `</div></section>`,
    );
  }

  // The doorbell's three foot lines (spec §6.1), above the colophon. The first
  // line is standing furniture addressed to whoever is holding the paper (a
  // guest as often as the owner, so it names neither); the share line needs
  // the owner's name to make a sentence; the
  // no-identity note prints only when this issue really carries such an author
  // — a line explaining a mark nobody has seen is noise.
  //
  // All three go with the doorbell: every one of them is about following
  // someone, and a paper with no chips on it would be explaining a control the
  // reader cannot see (and naming the web app to a page that is meant to
  // reference no popclaw service at all).
  if (doorbell) {
    body.push(`<p class="weather">${esc(L('page.footerOwner'))}</p>`);
    if (owner) body.push(`<p class="weather">${esc(L('page.footerShare', { owner }))}</p>`);
    if (issue.pulse.some((p) => p.author && !p.authorPopclawId)) {
      body.push(`<p class="weather">${esc(L('page.footerExternal'))}</p>`);
    }
  }

  // The model is the host's (it may well be a cloud one), and a paper with a
  // publisher is uploaded for its share link — so the colophon claims neither
  // "this machine" nor "never sent anywhere", and names the link only on a page
  // that has one.
  const colophon = doorbell ? 'page.colophonShared' : 'page.colophon';
  body.push(`<div class="end">${esc(L(colophon, { count: String(issue.pulse.length) }))}</div>`);
  body.push(`</div>`);

  // Anything the agent left unwritten, or wrote for something that is not there,
  // is said out loud. A silently thin issue is the failure mode this whole change
  // exists to end, and a key that quietly did nothing reads as a broken feature.
  // Which ones, not just how many. A writer told only "3 still unwritten" has to work out
  // *which* three, and if its copy of the material page was cut short it cannot — it is owed
  // items it can no longer see. The numbers cost a dozen characters and end that dead end.
  const unwrittenNumbers = issue.pulse
    .filter((p) => !p.houseFields && !edit.items?.[String(numberOf.get(p))])
    .map((p) => numberOf.get(p)!);
  const missing = unwrittenNumbers.length;
  if (missing) {
    notes.push(
      `edit.items: ${missing} item(s) had no copy and were left out of the issue — write them up and they are back in: [${unwrittenNumbers.join('] [')}]`,
    );
  }
  const numbers = new Set([...numberOf.values()].map(String));
  for (const [field, keys] of [
    ['items', Object.keys(edit.items ?? {})],
    ['pulls', Object.keys(edit.pulls ?? {})],
    ['xrefs', Object.keys(edit.xrefs ?? {})],
    ['topics', Object.keys(edit.topics ?? {})],
  ] as const) {
    const stray = keys.filter((k) => !numbers.has(k));
    if (stray.length) notes.push(`edit.${field}: no item ${stray.map((k) => `[${k}]`).join(' ')} in this issue (ignored)`);
  }
  const known = new Set(Object.keys(issue.byHouse));
  const strayDecks = Object.keys(edit.deckNotes ?? {}).filter((k) => !known.has(k));
  if (strayDecks.length) notes.push(`edit.deckNotes: no lore-house ${strayDecks.join(' ')} in this issue (ignored)`);
  const sigils = new Set(newFaces.map((m) => m.first.sigil));
  const straySigils = Object.keys(edit.newbies ?? {}).filter((k) => !sigils.has(k));
  if (straySigils.length) notes.push(`edit.newbies: #${straySigils.join(' #')} is not a new face on this issue's board (ignored)`);

  const links =
    fonts === 'system'
      ? ''
      : fontLinks(lang, style, edit.masthead ?? '')
          .map((f) => `<link href="${f}" rel="stylesheet"${NO_REFERRER}>`)
          .join('');
  const html =
    `<!doctype html><html lang="${esc(issue.language || (lang === 'en' ? 'en' : 'zh-CN'))}"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    // The document-wide half of the referrer promise. The per-element attributes
    // below cover what the page itself asks for; this covers what the STYLESHEETS
    // ask for — a font file is fetched by the CSS, never by an element we wrote,
    // so the document policy is the only place that request can be reached.
    `<meta name="referrer" content="no-referrer">` +
    `<title>${esc(edit.masthead ?? '')} · ${esc(issue.dateLabel)}</title>` +
    links +
    buildCss(lang, style) +
    // The doorbell script is the page's one and only script, right before
    // </body>: every chip on the page is dead HTML without it, and nothing else
    // on the page is allowed any script at all. With the doorbell off there is
    // no script on the page whatsoever.
    `</head><body>${body.join('\n')}${doorbell ? doorbellScript(chip) : ''}</body></html>`;
  // `unwritten` is the machine-readable half of the note above: the caller uses it to
  // decide whether this issue is finished or whether the writer still owes it a batch.
  //
  // The followable-author descriptors use the same headline rules as the page.
  // Preserve the complete numbered set, including omitted items and house events;
  // nothing in the layout reads this query or spends an ornament quota for it.
  const headsByNumber = c.person.headsByNumber();
  return { html, notes, unwritten: missing, unwrittenNumbers, headsByNumber };
}

/**
 * Walk the colophon's "share link" promise back to the plain closing line.
 *
 * `renderNewspaper` decides the colophon before the upload is even attempted
 * (`doorbell` only means a publisher is configured, not that this particular
 * upload succeeded — P7: the disk copy is written first, on purpose, so a
 * down publisher costs the receipt a link line and nothing else). When that
 * upload then fails, the page already sitting on disk is still claiming a
 * copy is on a share link for 24 hours. This is the one place a caller
 * corrects that, once the failure is known — never called for a page that
 * had no doorbell (and so no share claim) to begin with.
 *
 * If the shared line is not found (the page was patched or laid out
 * differently than expected), the replace is a no-op — the false claim then
 * stays on disk uncorrected, silently. That must at least be visible: one
 * warn line through the caller's logger, never a throw (this runs from a
 * failure path that must still return a receipt).
 */
export function unshareColophon(
  html: string,
  lang: Lang,
  pulseCount: number,
  logger?: { warn(m: string): void },
): string {
  const shared = esc(renderCopy(lang, 'newspaper.page.colophonShared', { count: String(pulseCount) }));
  const plain = esc(renderCopy(lang, 'newspaper.page.colophon', { count: String(pulseCount) }));
  const sharedBlock = `<div class="end">${shared}</div>`;
  if (!html.includes(sharedBlock)) {
    logger?.warn(
      'unshareColophon: shared colophon line not found on the page — the upload-failed copy may still claim a share link',
    );
    return html;
  }
  return html.replace(sharedBlock, `<div class="end">${plain}</div>`);
}
