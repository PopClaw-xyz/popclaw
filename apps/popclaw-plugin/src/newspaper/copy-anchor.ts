/**
 * The per-item faithfulness anchor.
 *
 * The numbering gate in `admit-hand-in.ts` (`admitHandIn`) proves an item number exists on
 * the material page. It cannot prove the copy filed under that number was
 * written from THAT item — and on real hardware (2026-09-10/11) that is exactly
 * what broke: every number the writer used was legal, and it still put Quanta's
 * summary under MKBHD's [100] and MKBHD's under verge's [120], once even swapping
 * two adjacent items of the same author. Nothing numeric can see that.
 *
 * So the writer hands in `q` with each item: a passage of that item's own body,
 * copied verbatim. Publish checks it against that very item's text, which is a
 * mechanical binding between the copy and its source — a summary can no longer
 * land under another item's number without the anchor coming with it, and the
 * anchor cannot come with it, because it does not appear in that item's body.
 *
 * The comparison is deliberately forgiving about everything that is NOT identity:
 * a writer copying a passage faithfully still normalizes quotes, collapses
 * whitespace, drops an emoji or picks the body up with `&amp;` still in it. None
 * of that is a misattribution, and refusing it would teach the writer that the
 * anchor is a lottery.
 */

/**
 * The character references we actually remove: the numeric ones, the five XML names,
 * and the typographic names a mirror leaves behind where the writer types the
 * character itself (`&rsquo;` for ’, `&mdash;` for —, `&hellip;` for …).
 *
 * An allowlist, not `&[a-z]+;`: a body saying `R&D; spending is up` has no entity in
 * it, and treating `&D;` as one ate the `D` and refused a faithful anchor (review,
 * 2026-09-11).
 */
const ENTITY =
  /&(?:#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|ldquo|rdquo|mdash|ndash|hellip);/gi;

/**
 * HTML character references (`&amp;`, `&#39;`, `&#x27;`…) are removed whole, on both
 * sides, before compaction. Mirrored feeds carry them in the body ("Starship &amp;
 * Cybertruck", real material 2026-09-10) while a writer quoting faithfully writes
 * the bare `&` — leaving the entity name behind would turn that into `amp` versus
 * nothing and refuse a correct anchor. Applied until stable so a double-escaped
 * `&amp;amp;` leaves no residue either.
 */
const stripEntities = (s: string): string => {
  let out = s;
  for (let i = 0; i < 3; i++) {
    // `&amp;` decodes to the `&` it stands for (which compaction then drops), so a
    // double-escaped `&amp;amp;` unwinds a level per pass; every other reference is
    // simply removed.
    const next = out.replace(ENTITY, (ref) => (/^&amp;$/i.test(ref) ? '&' : ' '));
    if (next === out) break;
    out = next;
  }
  return out;
};

/** Entities out → NFKC → lowercase → letters and digits only. Whitespace, punctuation, quotes and emoji all vanish. */
const compact = (s: string): string =>
  stripEntities(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * How much identity a compacted passage carries.
 *
 * Counted by script rather than by code point: one Han/Kana/Hangul character says
 * about as much as a short English word, so a flat character count sets two
 * different floors for two languages. Ten code points refused a six-character
 * Chinese passage nothing else on the page contains, while passing eight throwaway
 * English letters. CJK characters therefore weigh two, everything else one.
 */
const weigh = (compacted: string): number => {
  let weight = 0;
  for (const ch of compacted) {
    weight += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch) ? 2 : 1;
  }
  return weight;
};

/** The identity a passage must carry before it can vouch for an item. */
const MIN_WEIGHT = 8;

/** Why an anchor did not hold — `ok` plus the three ways it can fail on its own body. */
export type AnchorVerdict = 'ok' | 'missing' | 'notInBody' | 'tooShort';

/**
 * Does `q` read as a passage of `source`, and if not, why not?
 *
 * `ok` only when the compacted `q` is non-empty, occurs inside the compacted source,
 * and either weighs enough to identify one item (a weight of 8: eight latin
 * characters, or four Chinese ones) or is the whole of a source too short to give
 * that much. A body of "Yup" can only be anchored by quoting all of it; a few letters
 * out of a long body prove nothing, because those same letters are in half the other
 * bodies too.
 *
 * The floor here is the GATE, not the guidance: the brief and the receipts ask for
 * about four English words or five Chinese characters, deliberately more than this,
 * so that a writer quoting faithfully never lands on the edge of the check and
 * learns that the anchor is a coin toss.
 *
 * The fourth way an anchor fails — a passage two items share — cannot be seen from
 * one body and lives in `anchorIsAmbiguous` below.
 */
export function anchorVerdict(source: string, q: string | undefined): AnchorVerdict {
  if (!q?.trim()) return 'missing';
  const haystack = compact(source);
  // A body with no letters or digits at all (an emoji-only post, a bare picture)
  // has nothing to anchor against. Refusing it would make that item unwritable
  // forever; accepting any non-blank `q` is the honest degradation — the anchor
  // decides nothing where there is nothing to decide with.
  if (!haystack) return 'ok';
  const needle = compact(q);
  // Punctuation and emoji only: the writer handed in something, but nothing that
  // survives compaction, which is the same as handing in no anchor at all.
  if (!needle) return 'missing';
  if (!haystack.includes(needle)) return 'notInBody';
  return weigh(needle) >= MIN_WEIGHT || needle === haystack ? 'ok' : 'tooShort';
}

/** The verdict, flattened. Both stay in step because there is only one rule. */
export function anchorMatches(source: string, q: string | undefined): boolean {
  return anchorVerdict(source, q) === 'ok';
}

/**
 * Is there anything in this body a quotation could be taken FROM?
 *
 * `anchorVerdict` waives the anchor for a body that compacts to nothing (an
 * emoji-only post, a bare picture), and for the item's own copy that waiver is
 * right: refusing would make such an item unwritable forever. It is wrong for a
 * pull quote, which the page prints inside quotation marks under a real person's
 * name — there the answer for a body with nothing to quote is no pull quote at
 * all, not any pull quote. Publish asks this question first, before the anchor.
 */
export function hasQuotableBody(source: string): boolean {
  return compact(source).length > 0;
}

/**
 * Is `q` a passage some OTHER item on this page also contains?
 *
 * The anchor's blind spot, found in review: two items by the same person opening
 * with the same `@handle @handle` run share a passage, and a shared passage anchors
 * to both — so the swap this gate exists to catch walks straight through it while
 * every check says yes. A passage that is not unique to its item proves nothing
 * about which item the copy was written from, so publish treats it as no anchor.
 *
 * The exception is the one case where nothing better exists: when `q` is the WHOLE
 * of its own body, two byte-identical bodies (a repost, the same line twice) stay
 * anchorable — there is no passage of such an item that another does not have.
 */
export function anchorIsAmbiguous(
  q: string | undefined,
  ownBody: string,
  otherBodies: readonly string[],
): boolean {
  if (!q?.trim()) return false;
  const needle = compact(q);
  if (!needle) return false;
  const own = compact(ownBody);
  // Nothing to be unique against: an unanchorable body (see `anchorMatches`) waives
  // the anchor entirely, and a waived anchor cannot be ambiguous.
  if (!own || needle === own) return false;
  return otherBodies.some((other) => compact(other).includes(needle));
}
