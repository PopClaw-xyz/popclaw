/**
 * Person cards, briefs, new faces and roster entries share one issue-local renderer.
 * Change person display rules here and their CSS in newspaper-style.ts. Placement
 * belongs to render-plan.ts; column order remains in render-newspaper.ts and
 * lore-house material presentation belongs to house-material-renderer.ts.
 * Author grouping is decided by the caller.
 */
import { renderCopy, type Lang } from '../lexicon/index.js';
import { tierLabel, tierRank, type BondTier } from '../bonds/bond-tier.js';
import { monogramDataUri } from './author-block.js';
import { chipHtml, type ChipStrings } from './follow-chip.js';
import { followerLabel, type PulseItem } from './issue.js';
import { copyFor, hasCopy, type EditorialCopy } from './editorial-copy.js';
import { a, esc, img, NO_REFERRER } from './render-html.js';

export interface PersonItemOptions {
  /** The page's one numbering pass; keys retain the gathered item identities. */
  numberOf: ReadonlyMap<PulseItem, number>;
  copy: EditorialCopy & {
    pulls?: Readonly<Record<string, string>>;
    xrefs?: Readonly<Record<string, string>>;
  };
  lang: Lang;
  primaryHouseSlug?: string;
  avatars: 'inline' | 'off';
  /** Absent for a page without a doorbell. The owner never receives their own follow chip. */
  follow?: { ownerPopclawId: string; strings: ChipStrings };
}

export interface PersonItemRenderer {
  card(p: PulseItem, opts?: { lead?: boolean; drop?: boolean; more?: readonly PulseItem[] }): string;
  brief(p: PulseItem, house?: string): string;
  newFace(p: PulseItem): string;
  rosterEntry(p: PulseItem, label: string): string;
  /** A fresh Map of the complete numbered set; does not render cards or spend quotas. */
  headsByNumber(): Map<number, string>;
}

/**
 * Create once per page. Only card calls spend the private 4-pull / 8-xref quota,
 * in call order; leads spend no xrefs and continuations spend neither quota.
 * Briefs, new faces, roster entries and headline queries never spend it.
 */
export function createPersonItemRenderer({
  numberOf, copy, lang, primaryHouseSlug, avatars, follow,
}: PersonItemOptions): PersonItemRenderer {
  const budget = { pulls: 4, xrefs: 8 };
  const L = (key: string, vars: Record<string, string> = {}): string =>
    renderCopy(lang, key.startsWith('page.') ? `newspaper.${key}` : `newspaper.material.${key}`, vars);

  /**
   * A person's face. Same as `img`, plus a **local** stand-in: a face that fails to
   * load swaps to a monogram drawn here, instead of vanishing.
   *
   * This matters because of how the remote one fails. unavatar rate-limits (measured
   * 2026-08-26: six of twelve faces came back 429 under load), and a 429 is JSON, so
   * the `<img>` errors and the old handler hid it — a rate-limited read produced a
   * paper with no faces on it. Publishing bakes the faces in so most readers never
   * ask; this is what happens to the ones that could not be baked, and it needs no
   * network at all, which is the entire point of a fallback.
   */
  function face(p: PulseItem, cls = ''): string {
    if (!p.avatarUrl) return '';
    const remote = /^https?:/i.test(p.avatarUrl);
    const mono = remote ? monogramDataUri(p.author || p.handle || '?', p.author || p.handle || p.authorPopclawId) : '';
    // `avatars: 'off'`: nobody is going to fetch anything, so the stand-in IS the
    // face. Drawn here rather than left for publish to swap, because a page that
    // never reaches the network must not carry a url it expects someone to resolve.
    const src = avatars === 'off' && remote ? mono : p.avatarUrl;
    return (
      `<img${cls ? ` class="${cls}"` : ''} src="${esc(src)}"${NO_REFERRER} loading="lazy"` +
      (mono && src !== mono
        ? ` data-mono="${esc(mono)}" onerror="this.onerror=null;this.src=this.dataset.mono"`
        : ` onerror="this.style.display='none'"`) +
      `>`
    );
  }

  /** Split a summary into the short paragraphs the codex asks for; a blank line or a line break is the author's own break. */
  function paras(text: string): string[] {
    return text
      .split(/\n{2,}|\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  /**
   * Is there someone here the reader could be offered?
   *
   * Three ways there is not: the page has no doorbell at all, the author carries
   * no popclaw identity (an external-platform byline — the quiet tag says so),
   * or the author IS the publisher. Nobody follows themselves, and the offer was
   * not merely decorative: a click on it minted a real canvas intent naming the
   * publisher as both sides, which the publisher's own plugin then pulled.
   */
  function followable(p: PulseItem): boolean {
    return Boolean(follow) && Boolean(p.authorPopclawId) && p.authorPopclawId !== follow?.ownerPopclawId;
  }

  /* ---------------------------------------------------------------- card parts */

  /**
   * The card head: the person, loudest thing on the card, **on one line** — the
   * anchor itself is the flex row (`.who`), so avatar, name, sigil, handle,
   * follower count and tags all sit together. Splitting the small print into a
   * sibling block wraps every card head onto two lines, which is most of what
   * "the layout got worse" turns out to mean.
   *
   * An item whose author the ingest dropped gets the compact
   * "(unattributed) · platform" line — never an invented identity, never a card
   * with no head at all.
   */
  function cardHead(p: PulseItem): string {
    if (!p.author) {
      return `<div class="who"><span class="meta">${esc(L('pulse.unattributed', { platform: p.platform }))}</span></div>`;
    }
    // Doorbell: the follow chip rides AFTER the anchor, never inside it — a
    // button nested in a link is invalid HTML and a click that both rings and
    // opens the author's page (the same reasoning the brief row already follows).
    // `.who-row` repeats the anchor's own flex line so the chip still sits on the
    // byline row, at its end. The external tag stays inside: a span in a link
    // is fine, only the interactive thing had to move.
    const chip = followable(p)
      ? chipHtml({ authorPopclawId: p.authorPopclawId!, author: p.author, sigil: p.sigil }, follow!.strings)
      : '';
    return (
      `<div class="who-row">` +
      a(p.profileUrl, `${face(p)}<b>${esc(p.author)}</b>${sigilSpan(p)}${pickMark(p)}${personMeta(p)}`, 'who') +
      `${chip}</div>`
    );
  }

  /** The small print that belongs on the same line as the name: platform, handle, followers, newcomer day, tags. */
  function personMeta(p: PulseItem): string {
    const meta = [
      p.platform,
      p.handle ? `@${esc(p.handle)}${p.verified ? ' ✓' : ''}` : '',
      followerLabel(p.followerCount, lang),
      p.newcomerDays !== undefined ? L('page.newcomer', { days: String(p.newcomerDays) }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const tier = p.bondTier as BondTier | undefined;
    // Only the two closest tiers earn a mark on the card — a label for everyone would be noise, and "stranger" is not a thing we print.
    const bond =
      tier && tierRank(tier) >= tierRank('close')
        ? `<span class="tag hot">${esc(p.remarkName || tierLabel(tier, lang))}</span>`
        : '';
    // Doorbell (spec §6.1): the follow state is no longer baked into the page —
    // `isFollowing` was this machine's own view, useless to a reader holding a
    // shared link. The interactive chip itself is NOT emitted here — it renders
    // outside the `.who` anchor (see cardHead); only an author with no PopClaw
    // identity at all gets this quiet non-interactive tag on the line, which the
    // foot line below explains once.
    const external = p.authorPopclawId ? '' : externalTagSpan();
    return `${meta ? `<span class="meta">${meta}</span>` : ''}${bond}${external}`;
  }

  /** `#sigil`, in its own span so it can sit quieter than the name. Nothing at all when there is no sigil. */
  const sigilSpan = (p: PulseItem): string => (p.sigil ? `<span class="sig">#${esc(p.sigil)}</span>` : '');

  /** The quiet non-interactive "external platform" mark an author with no PopClaw
   * identity wears. One span, two homes: the card byline (personMeta) and the
   * brief row's who segment — the same key, the same markup, so the inline
   * static identification (spec §6.1, criterion 3) holds in every tier, not
   * just where there is room for a meta line. */
  const externalTagSpan = (): string => `<span class="tag">${esc(L('page.externalTag'))}</span>`;

  /**
   * The card foot. Which exits an item gets is decided here and nowhere else:
   * **a stack that is not the owner's own lore-house never gets a discussion
   * button**, because that discussion page lives in a different lore-house's
   * database and would 404 (codex §3). gather already withholds the url in that
   * case; this is the second lock on the same door.
   */
  function cardFoot(p: PulseItem, opts: { also?: boolean } = {}): string {
    const ownHouse = !p.houseSlug || !primaryHouseSlug || p.houseSlug === primaryHouseSlug;
    const talk = opts.also ? L('button.talkAlso') : L('button.talk');
    const btns = [
      opts.also || !p.profileUrl ? '' : a(p.profileUrl, esc(L('button.person')), 'btn'),
      ownHouse && p.postPageUrl ? a(p.postPageUrl, esc(talk), 'btn') : '',
      p.url && p.url !== p.postPageUrl ? a(p.url, esc(L('button.original')), 'btn') : '',
    ].filter(Boolean);
    const counts = tally(p);
    if (!btns.length && !counts) return '';
    return `<div class="foot">${btns.join(' ')}${counts ? `<span class="cnt">${esc(counts)}</span>` : ''}</div>`;
  }

  /** "Picked for you: <a verifiable fact>" — assembled from gather's reason material, never from an opinion. */
  /**
   * The mark that says an item was chosen **for the owner** rather than to fill out the day.
   *
   * Only the two rare kinds get one. Heat is the majority on a machine whose bond book holds
   * two people, and marking the majority says nothing while turning every line into a small
   * confession that it was not really chosen for them; the count goes in the ledger line
   * instead, once. Mark what is rare, let the common go unmarked.
   */
  function pickMark(p: PulseItem): string {
    if (p.pickedFor !== 'taste' && p.pickedFor !== 'bond') return '';
    return ` <span class="tag">${esc(L(`page.pickedFor.${p.pickedFor}`))}</span>`;
  }

  function whyLine(p: PulseItem): string {
    return p.reasons?.length
      ? `<span class="why">${esc(L('page.why', { reason: p.reasons.join(' · ') }))}</span>`
      : '';
  }

  /** A pull quote / cross-reference, if the agent supplied one and the issue's quota still has room. */
  function extras(n: number, opts: { xref?: boolean } = {}): { pull: string; xref: string } {
    const key = String(n);
    const pullText = copy.pulls?.[key]?.trim();
    // A lead prints no cross-reference, so it must not spend one either — the quota
    // is for the whole issue and a silently burnt slot is one the page never shows.
    const xrefText = opts.xref === false ? '' : copy.xrefs?.[key]?.trim();
    const pull = pullText && budget.pulls > 0 ? (budget.pulls--, `<div class="pull">${esc(pullText)}</div>`) : '';
    const xref = xrefText && budget.xrefs > 0 ? (budget.xrefs--, `<span class="xref">${esc(xrefText)}</span>`) : '';
    return { pull, xref };
  }

  /** One item's headline + body, as the `.body` block that links to its discussion page. */
  function bodyBlock(p: PulseItem, opts: { lead?: boolean; drop?: boolean }): string {
    const n = numberOf.get(p)!;
    const { h, s } = copyFor(copy, p, n);
    const heading = opts.lead ? 'h2' : 'h3';
    const paragraphs = paras(s)
      .map((t, i) => `<p${i === 0 && opts.drop ? ' class="drop"' : ''}>${esc(t)}</p>`)
      .join('');
    return a(p.postPageUrl || p.url, `<${heading}>${esc(h)}</${heading}>${paragraphs}`, 'body');
  }

  /**
   * One person card, in the skeleton the codex fixes (§4):
   *   lead: `.who` → h2 → `.body` → `img.fig` → `.pull` → `.foot`
   *   card: `.who` → h3 → `.body` → `img.fig` → `.why` → `.note` → `.xref` → `.foot`
   * The picture sits **after** the words, never between the byline and the headline.
   *
   * `more` carries this person's other items in the same column: one head, the rest
   * appended as "also" continuations, each linking its own post and keeping its own
   * counts — the codex forbids merging their figures. `drop` sets the single drop
   * cap the whole paper is allowed (the front page's first story).
   */
  function personCard(
    p: PulseItem,
    opts: { lead?: boolean; drop?: boolean; more?: readonly PulseItem[] } = {},
  ): string {
    const n = numberOf.get(p)!;
    const { pull, xref } = extras(n, { xref: !opts.lead });
    const picture = p.media[0] ? a(p.url, img(p.media[0], 'fig')) : '';
    const bondNote = p.bondDynamic ? `<span class="note">${esc(L('page.note', { text: p.bondDynamic }))}</span>` : '';
    const also = (opts.more ?? [])
      .map((q) => {
        const qn = numberOf.get(q)!;
        const { h, s } = copyFor(copy, q, qn);
        // One sentence, the way the approved issue reads it ("Also: ..."). The headline
        // and the summary say the same thing in different lengths, so printing both
        // reads as a stutter — the summary is the one written to be read.
        return (
          `<div class="also">` +
          a(q.postPageUrl || q.url, `<b>${esc(L('page.also'))}</b>${esc(s || h)}`) +
          cardFoot(q, { also: true }) +
          `</div>`
        );
      })
      .join('');
    return (
      `<article class="${opts.lead ? 'lead' : 'card'}">` +
      cardHead(p) +
      bodyBlock(p, opts) +
      picture +
      (opts.lead ? pull : whyLine(p) + bondNote + pull + xref) +
      cardFoot(p) +
      also +
      `</article>`
    );
  }

  /** Replies and marks, in the one convention the whole issue counts in; nothing at all at zero. */
  function tally(p: PulseItem): string {
    return [
      p.replyCount ? L('page.replies', { count: String(p.replyCount) }) : '',
      p.markCount ? L('page.marks', { count: String(p.markCount) }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** One brief: face, person, one sentence and counts. `house` names the folded stack's lore-house (codex §5). */
  function briefRow(p: PulseItem, house = ''): string {
    const n = numberOf.get(p)!;
    const { h, s } = copyFor(copy, p, n);
    // Every item carries a head, briefs included: an item with information and no
    // person in it is exactly what the person-first rule forbids. No author =
    // the compact "(unattributed) · platform" marker, never an invented identity.
    // An author with no PopClaw identity wears the external tag here too — the
    // same span personMeta prints on cards (criterion 3's inline static mark
    // must not depend on the item's tier), riding inside the row's anchor just
    // as the card's tag rides inside the `.who` anchor.
    const who = p.author
      ? `${face(p)}<b>${esc(p.author)}</b>${sigilSpan(p)}${pickMark(p)}${p.authorPopclawId ? '' : externalTagSpan()} `
      : `<span class="meta">${esc(L('pulse.unattributed', { platform: p.platform }))}</span> `;
    const line = esc(s || h);
    const ownHouse = !p.houseSlug || !primaryHouseSlug || p.houseSlug === primaryHouseSlug;
    const tail = p.url && p.url !== p.postPageUrl ? ` ${a(p.url, esc(L('button.original')), 'btn')}` : '';
    // The codex asks the brief column to carry its counts too — the whole issue reports in one convention.
    const counts = tally(p);
    const from = house ? `<span class="meta">${esc(house)}</span> ` : '';
    // The doorbell's small chip, one position on every row that has someone to
    // follow: at the row's end, before the counts. It sits OUTSIDE the row's
    // anchor — a button nested in a link is both invalid HTML and a click that
    // navigates; an author with no PopClaw identity gets no chip (the foot line
    // says why, once).
    const chip = followable(p)
      ? ` ${chipHtml({ authorPopclawId: p.authorPopclawId!, author: p.author, sigil: p.sigil }, follow!.strings)}`
      : '';
    return `<div class="brief">${from}${a(ownHouse ? p.postPageUrl || p.url : p.url, `${who}${line}`)}${tail}${chip}${counts ? ` <span class="cnt">${esc(counts)}</span>` : ''}</div>`;
  }

  /** A new-face ear entry, with its own reason and written headline only. */
  function newFace(p: PulseItem): string {
    const n = numberOf.get(p)!;
    return (
      `<div class="row">${a(p.profileUrl, `<b>${esc(p.author)}</b>${sigilSpan(p)}`)}` +
      `<span class="tag">${esc(L('page.notFollowing'))}</span>` +
      (p.reasons?.length ? `<span class="why">${esc(p.reasons[0]!)}</span>` : '') +
      (hasCopy(copy, n) ? `<span class="latest">${a(p.postPageUrl || p.url, esc(copyFor(copy, p, n).h))}</span>` : '') +
      `</div>`
    );
  }

  function rosterEntry(p: PulseItem, label: string): string {
    return a(p.profileUrl, `${face(p)}<b>${esc(label)}</b>`);
  }

  /** All numbered items, including those omitted from the page and lore-house events. */
  function headsByNumber(): Map<number, string> {
    return new Map([...numberOf].map(([p, n]) => [n, copyFor(copy, p, n).h]));
  }

  return { card: personCard, brief: briefRow, newFace, rosterEntry, headsByNumber };
}
