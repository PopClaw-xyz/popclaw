/** Lore-house material interpretation, deck selection and the six material columns. */
import { renderCopy, type Lang } from '../lexicon/index.js';
import type { HomeItem, HomeSection, HouseLetterItem, MantleItem, PulseItem } from './issue.js';
import type { Deck } from './render-plan.js';
import { a, esc, head3, img, linkText } from './render-html.js';

export type HouseColumn = 'mantle' | 'letters' | 'postcards' | 'chron' | 'homes' | 'misc';

type HouseDeck = Readonly<Pick<Deck, 'slug'>> & {
  readonly [K in 'postcards' | 'chron' | 'misc']: readonly PulseItem[];
};

export interface HouseMaterialOptions {
  readonly lang: Lang;
  readonly translations?: Readonly<Record<string, string>>;
  readonly mantles?: readonly Readonly<MantleItem>[];
  readonly houseLetters?: readonly Readonly<HouseLetterItem>[];
  readonly homeSections?: readonly Readonly<HomeSection>[];
  /** Object identities promoted by the page's existing placement plan. */
  readonly onFront: ReadonlySet<PulseItem>;
}

export interface HouseDeckPresentation {
  /** Source fact used by the caller's deck character formula. Empty homes do not count. */
  readonly hasMantleOrHomes: boolean;
  /** Original push fragments; the page coordinator owns their order and newline joins. */
  column(id: HouseColumn): readonly string[];
}

export interface HouseMaterialRenderer {
  postcard(item: PulseItem): string;
  forDeck(deck: HouseDeck): HouseDeckPresentation;
}

interface MaterialContext {
  translations?: Readonly<Record<string, string>>;
  L: (key: string, vars?: Record<string, string>) => string;
}

/** First matching lore-house field, by key suffix. Never invents one. */
function field(p: PulseItem, ...suffixes: string[]): string {
  const entries = Object.entries(p.houseFields ?? {});
  for (const suffix of suffixes) {
    const hit = entries.find(([k]) => k === suffix || k.endsWith(`.${suffix}`) || k.endsWith(`_${suffix}`));
    if (hit?.[1]) return hit[1];
  }
  return '';
}

/** Every value under keys ending in `suffix`, in the lore-house's own order (`present.1.figure_name`, `present.2.figure_name`, …). */
function fieldsAll(p: PulseItem, suffix: string): string[] {
  return Object.entries(p.houseFields ?? {})
    .filter(([k]) => k === suffix || k.endsWith(`.${suffix}`) || k.endsWith(`_${suffix}`))
    .map(([, v]) => v)
    .filter(Boolean);
}

/** A lore-house field carrying a picture. */
function eventImage(p: PulseItem): string {
  return p.media[0] ?? field(p, 'media_url', 'image_url', 'cover_img', 'avatar_url');
}

/** `key=value · key=value`, keys copied character for character (codex F1). */
function fieldsLine(f: Readonly<Record<string, string>>): string {
  return Object.entries(f)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
}

/** The mantel: one line, "how is my little one doing", at whichever rung of the chain it landed on. */
function mantleLine(c: MaterialContext, m: MantleItem): string {
  if (m.level === 4) {
    // ④ the door card — three lines, every word of it the lore-house's own.
    return (
      `<div class="doorplate"><b>${esc(m.text)}</b>` +
      (m.url ? `<div>${a(m.url, esc(c.L('button.world')), 'btn')}</div>` : '') +
      `</div>`
    );
  }
  const src = [m.asOf ? c.L('page.asOf', { time: m.asOf }) : '', m.dateLabel ?? '']
    .filter(Boolean)
    .join(' · ');
  return (
    `<div class="mantle"><span>${esc(m.text)}</span>` +
    (m.url ? a(m.url, esc(c.L('button.home')), 'btn') : '') +
    (src ? `<span class="src">${esc(src)}</span>` : '') +
    `</div>`
  );
}

/** A letter from the world: the body verbatim, its links clickable, its pictures set as pictures. */
function letterItem(c: MaterialContext, l: HouseLetterItem): string {
  const links = (l.links ?? []).map((u) => a(u, esc(linkText(u)))).join(' · ');
  const pics = (l.imageLinks ?? []).map((u) => a(l.links?.[0], img(u, 'fig'))).join('');
  return (
    `<li><b>${esc(l.fromShort)}</b> · ${esc(l.dateLabel)}<br>${esc(l.body)}` +
    (links ? `<br>${links}` : '') +
    pics +
    `</li>`
  );
}

/** A postcard: picture first, and **no person card head** — the person here is the owner themself (codex §5.2). */
function postcardCard(c: MaterialContext, p: PulseItem): string {
  const place = field(p, 'place_name', 'place');
  const caption = field(p, 'scene', 'lore', 'line', 'title');
  const present = fieldsAll(p, 'figure_name');
  const keepers = fieldsAll(p, 'owner_popclaw_id');
  const back = field(p, 'view', 'view_url');
  const home = field(p, 'home_url');
  const meta = [...present, ...keepers].filter(Boolean).join(' · ');
  return (
    `<article class="card">` +
    (eventImage(p) ? a(back || home, img(eventImage(p), 'fig')) : '') +
    (place ? `<h3>${esc(place)}</h3>` : '') +
    (caption ? `<p class="body">${esc(caption)}</p>` : '') +
    (meta ? `<div class="meta">${esc(meta)}</div>` : '') +
    `<div class="foot">` +
    (back ? a(back, esc(c.L('button.back')), 'btn') : '') +
    (home ? a(home, esc(c.L('button.home')), 'btn') : '') +
    `</div></article>`
  );
}

/**
 * The five event words the codex fixes, and the two `phase` values. Anything not
 * on this list prints as the lore-house wrote it — the codex forbids guessing at a
 * translation, and the "also noted" column exists for exactly that case.
 */
function houseWord(c: MaterialContext, group: 'kind' | 'phase', raw: string): string {
  const alias: Record<string, string> = { home: 'returned', away: 'left', souvenir: 'souvenirtransfer' };
  const key = alias[raw.toLowerCase()] ?? raw.toLowerCase();
  const known =
    group === 'kind'
      ? ['trip', 'postcard', 'encounter', 'embodiment', 'souvenirtransfer']
      : ['returned', 'left'];
  return known.includes(key) ? c.L(`${group}.${key}`) : raw;
}

/** One line of comings and goings, written out of the lore-house's own fields — not a word added (codex §5.3). */
function chronRow(c: MaterialContext, p: PulseItem): string {
  const phase = field(p, 'phase');
  const parts = [
    field(p, 'occurred_at'),
    houseWord(c, 'kind', p.kind.split(/[.:]/).pop()?.toLowerCase() ?? ''),
    field(p, 'place_name', 'place'),
    fieldsAll(p, 'figure_name').join(' · '),
    field(p, 'scene', 'lore', 'line', 'title'),
    phase ? houseWord(c, 'phase', phase) : '',
  ].filter(Boolean);
  const keeper = fieldsAll(p, 'owner_popclaw_id').join(' · ');
  const home = field(p, 'home_url');
  return (
    `<li>${esc(parts.join(' · '))}` +
    (keeper ? ` <span class="meta">${esc(keeper)}</span>` : '') +
    (home ? ` ${a(home, esc(c.L('button.home')), 'btn')}` : '') +
    `</li>`
  );
}

/** A home worth visiting / a busy place — the same skeleton, and it must always carry its door. */
function placeCard(c: MaterialContext, h: HomeItem): string {
  const counts = [
    h.visitsToday !== undefined ? c.L('page.visitsToday', { count: String(h.visitsToday) }) : '',
    h.builtAt ? c.L('page.builtAt', { date: h.builtAt }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    `<article class="card place">` +
    (h.coverImg ? a(h.visitUrl, img(h.coverImg, 'fig')) : '') +
    `<h3>${esc(h.name)}</h3>` +
    (h.owner ? `<div class="meta">${esc(h.owner)}</div>` : '') +
    (h.voice ? `<p>${verbatim(c, h.voice)}</p>` : '') +
    (counts ? `<div class="meta">${esc(counts)}</div>` : '') +
    `<div class="foot">${a(h.visitUrl, esc(c.L('button.visit')), 'btn')}</div>` +
    `</article>`
  );
}

/**
 * Someone else's own words, printed as given. If the writer handed in a translation for
 * this exact line, the translation takes the visible place and the original moves one
 * hover away — an owner who cannot read the line gets nothing out of it, and a slightly
 * lossy translation beats nothing (owner's ruling, 2026-08-26). The original never leaves
 * the page: what we told the lore-house was that we print its words and never rewrite
 * them, and "printed, with a translation beside it" keeps that promise.
 */
function verbatim(c: MaterialContext, s: string): string {
  const t = c.translations?.[s];
  if (!t) return esc(s);
  return `<span title="${esc(s)}">${esc(t)}</span> <span class="meta">${esc(c.L('page.translated'))}</span>`;
}

/** An event of a kind we don't recognise: small print, the lore-house's own fields in brackets, never guessed at (codex §5). */
function miscRow(c: MaterialContext, p: PulseItem): string {
  const raw = p.houseFields ? fieldsLine(p.houseFields) : p.text;
  return `<div class="brief"><span class="meta">${esc(c.L('page.miscRow', { kind: p.kind, fields: raw }))}</span></div>`;
}

/** Create once per page; no IO, placement or person ornament state is consumed here. */
export function createHouseMaterialRenderer({
  lang, translations, mantles, houseLetters, homeSections, onFront,
}: HouseMaterialOptions): HouseMaterialRenderer {
  const c: MaterialContext = {
    translations,
    L: (key, vars = {}) => renderCopy(
      lang, key.startsWith('page.') ? `newspaper.${key}` : `newspaper.material.${key}`, vars,
    ),
  };
  const kicker = (id: HouseColumn, count: number): string =>
    head3(c.L(`page.section.${id}`), c.L('page.items', { count: String(count) }));

  return {
    postcard: (p) => postcardCard(c, p),
    forDeck(d) {
      const mantle = mantles?.find((m) => !d.slug || m.houseSlug === d.slug);
      // The unsplit degradation takes every letter, but only the first mantle
      // and home section. Preserve that source ownership even for empty homes.
      const only = !d.slug;
      const letters = (houseLetters ?? []).filter((l) => only || l.houseSlug === d.slug);
      const homes = homeSections?.find((s) => only || s.houseSlug === d.slug);
      return {
        hasMantleOrHomes: mantle !== undefined || Boolean(homes?.homes.length),
        column(id) {
          const out: string[] = [];
          switch (id) {
            case 'mantle':
              if (mantle) out.push(mantleLine(c, mantle));
              break;
            case 'letters':
              if (letters.length) {
                out.push(kicker('letters', letters.length));
                out.push(`<ul class="chron">${letters.map((l) => letterItem(c, l)).join('')}</ul>`);
              }
              break;
            case 'postcards':
              if (d.postcards.length) {
                out.push(kicker('postcards', d.postcards.length));
                // The one on the front page leaves a line behind rather than vanishing,
                // so the column's own count still adds up (codex §5.2).
                const here = d.postcards.filter((p) => !onFront.has(p));
                if (here.length !== d.postcards.length) {
                  out.push(`<p class="note">${esc(c.L('page.onFront', { count: String(d.postcards.length - here.length) }))}</p>`);
                }
                out.push(`<div class="grid">${here.map((p) => postcardCard(c, p)).join('')}</div>`);
              }
              break;
            case 'chron':
              if (d.chron.length) {
                out.push(kicker('chron', d.chron.length));
                out.push(`<ul class="chron">${d.chron.map((p) => chronRow(c, p)).join('')}</ul>`);
              }
              break;
            case 'homes':
              // The paper never invents a ranking: the lore-house's own basis and
              // as-of time are printed verbatim above the column, in its own order.
              if (homes?.homes.length) {
                out.push(head3(c.L('page.section.homes'), c.L('page.houseList', { asOf: homes.asOf })));
                if (homes.rankingBasis) out.push(`<p class="note">${verbatim(c, homes.rankingBasis)}</p>`);
                out.push(`<div class="grid">${homes.homes.map((h) => placeCard(c, h)).join('')}</div>`);
              }
              break;
            case 'misc':
              if (d.misc.length) {
                out.push(kicker('misc', d.misc.length));
                out.push(`<div class="briefs">${d.misc.map((p) => miscRow(c, p)).join('')}</div>`);
              }
              break;
          }
          return out;
        },
      };
    },
  };
}
