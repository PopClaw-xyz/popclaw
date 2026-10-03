/**
 * The faithfulness anchor.
 *
 * Numeric validation cannot catch the failure this exists for: on real hardware
 * (2026-09-10/11) the material page was numbered correctly and every number the
 * writer used was legal — it simply wrote ANOTHER item's summary under a legal
 * number (Quanta's summary under MKBHD's [100], MKBHD's under verge's [120]).
 * The only thing that can catch that is the copy quoting its own source, so
 * publish asks for a passage of the body verbatim and checks it against that
 * very item. The check has to be mechanical, not literal: a writer that copies a
 * passage faithfully still normalizes quotes, collapses whitespace and drops an
 * emoji, and none of that is a misattribution.
 */
import { describe, expect, it } from 'vitest';
import { anchorIsAmbiguous, anchorMatches, anchorVerdict } from '../../../src/newspaper/copy-anchor.js';

const LATIN = 'The booster landed on the pad, upright, at 04:12 local time.';
const CJK = '猎鹰九号昨夜完成了第二十次复用发射，助推器直立落回海上平台。';

describe('anchorMatches', () => {
  it('accepts a passage copied verbatim out of the body', () => {
    expect(anchorMatches(LATIN, 'The booster landed on the pad')).toBe(true);
  });

  it('accepts the whole body as its own anchor', () => {
    expect(anchorMatches(LATIN, LATIN)).toBe(true);
  });

  it('ignores case, punctuation, quotes, whitespace and emoji', () => {
    expect(anchorMatches(LATIN, '  the   BOOSTER “landed” on the pad!!! 🚀  ')).toBe(true);
  });

  /**
   * Mirrored feeds carry HTML character references in the body ("Starship &amp;
   * Cybertruck" was real material on 2026-09-10) while a faithful writer quotes the
   * bare `&`. The entity is removed whole on both sides, so neither its name nor
   * a double escape can turn a correct anchor into a refusal.
   */
  it('ignores stray ampersands, semicolons and HTML character references on either side', () => {
    expect(anchorMatches('Bell & Ross announced the dive watch today.', 'Bell&Ross announced the dive watch')).toBe(true);
    expect(anchorMatches('Stainless Steel Starship &amp; Cybertruck', 'Stainless Steel Starship & Cybertruck')).toBe(true);
    expect(anchorMatches('Stainless Steel Starship &amp;amp; Cybertruck', 'Stainless Steel Starship & Cybertruck')).toBe(true);
    expect(anchorMatches('Stainless Steel Starship & Cybertruck', 'Stainless Steel Starship &amp; Cybertruck')).toBe(true);
    expect(anchorMatches('it&#39;s here and it&#x27;s real, finally', "it's here and it's real")).toBe(true);
  });

  it('works on CJK, where a short passage is still many characters of meaning', () => {
    expect(anchorMatches(CJK, '完成了第二十次复用发射')).toBe(true);
    expect(anchorMatches(CJK, '助推器直立落回海上平台')).toBe(true);
  });

  /**
   * The floor is weighted by script, not counted in code points. One Chinese
   * character carries about as much identity as a short English word, so a flat
   * count of ten made a perfectly specific Chinese passage — 「折叠屏真香」 — fail
   * while eight throwaway English letters passed. Han/Kana/Hangul count double.
   */
  it('weighs a CJK character as two, so a short but specific passage still anchors', () => {
    const snow = '今天北京下了今年第一场雪，路上全是拍照的人。';
    expect(anchorMatches(snow, '路上全是拍照的人')).toBe(true);
    expect(anchorMatches('这代折叠屏真香，终于不硌手了。', '折叠屏真香')).toBe(true);
    expect(anchorMatches('这代折叠屏真香，终于不硌手了。', '真香')).toBe(false);
  });

  it('a short link is enough on the latin side, where eight characters are eight', () => {
    expect(anchorMatches('https://t.co/aB3xQ', 't.co/aB3xQ')).toBe(true);
    expect(anchorMatches(LATIN, 'landed')).toBe(false);
  });

  /**
   * Mirrors also carry the typographic references — a curly apostrophe, an em dash,
   * an ellipsis — and a writer quoting faithfully types the character itself. Both
   * sides have to end up at the same string or the anchor punishes correct copying.
   */
  it('ignores the typographic character references a mirror leaves in a body', () => {
    expect(anchorMatches('Apple&rsquo;s new chip is wild', "Apple's new chip is wild")).toBe(true);
    expect(anchorMatches('The Verge &mdash; first look at the new Pixel', 'The Verge — first look at the new Pixel')).toBe(true);
    expect(anchorMatches('We tested it&hellip; and it broke', 'We tested it… and it broke')).toBe(true);
    expect(anchorMatches('a &ldquo;quiet&rdquo; launch, they said', 'a “quiet” launch, they said')).toBe(true);
  });

  /**
   * Only real HTML character references are removed. `R&D;` is not one — treating
   * any `&word;` as an entity ate the `D` and refused a faithful anchor.
   */
  it('leaves a non-entity ampersand word alone', () => {
    expect(anchorMatches('R&D; spending is up sharply this year', 'R&D spending is up sharply')).toBe(true);
  });

  it('refuses a passage taken from a different item — the whole point', () => {
    expect(anchorMatches(LATIN, '完成了第二十次复用发射')).toBe(false);
    expect(anchorMatches(CJK, 'The booster landed on the pad')).toBe(false);
    expect(anchorMatches(LATIN, 'the cat rode the escalator down')).toBe(false);
  });

  it('refuses a missing, empty or punctuation-only anchor', () => {
    expect(anchorMatches(LATIN, undefined)).toBe(false);
    expect(anchorMatches(LATIN, '')).toBe(false);
    expect(anchorMatches(LATIN, '   ')).toBe(false);
    expect(anchorMatches(LATIN, '“…” !!!')).toBe(false);
  });

  /**
   * A few characters of one body are a few characters of half the other bodies
   * too, so a short anchor proves nothing — unless the source itself is short,
   * in which case quoting the whole of it is the most faithful thing there is.
   */
  it('refuses a passage too short to prove anything', () => {
    expect(anchorMatches(LATIN, 'The')).toBe(false);
    expect(anchorMatches(LATIN, 'landed')).toBe(false);
  });

  it('accepts a short body quoted whole, and nothing less', () => {
    expect(anchorMatches('Yup', 'Yup')).toBe(true);
    expect(anchorMatches('Yup', 'yup.')).toBe(true);
    expect(anchorMatches('Yup', 'Yu')).toBe(false);
    expect(anchorMatches('Uploading...', 'Uploading...')).toBe(true);
    expect(anchorMatches('Uploading...', 'Upload')).toBe(false);
  });

  it('refuses an anchor longer than the body it claims to come from', () => {
    expect(anchorMatches('Yup', 'Yup, it landed on the pad')).toBe(false);
  });

  /**
   * A body with no letters or digits (an emoji-only post, a bare picture link that
   * compacts to nothing) gives the anchor nothing to decide with. Refusing would make
   * that item unwritable forever, so any non-blank anchor is accepted there — and a
   * blank one is still refused, because the writer must at least have looked.
   */
  it('accepts any non-blank anchor when the body has nothing to anchor against', () => {
    expect(anchorMatches('🟡🔵', '🟡🔵')).toBe(true);
    expect(anchorMatches('🟡🔵', 'yellow and blue')).toBe(true);
    expect(anchorMatches('🟡🔵', '   ')).toBe(false);
    expect(anchorMatches('', 'anything')).toBe(true);
    expect(anchorMatches('', '')).toBe(false);
  });
});

/**
 * The anchor's blind spot, found in review: two items by the same person that both
 * open `@TimSweeneyEpic @ParkerThayer …` share a passage, so quoting that shared
 * head anchors to BOTH — and the swap this whole gate exists to catch walks
 * straight through it. A passage that is not unique to its item proves nothing, so
 * it counts as no anchor at all.
 */
describe('anchorIsAmbiguous', () => {
  const A = '@TimSweeneyEpic @ParkerThayer the storefront cut is the whole argument.';
  const B = '@TimSweeneyEpic @ParkerThayer and the court filing says so too.';

  it('a passage that is also in another item is no anchor', () => {
    expect(anchorIsAmbiguous('@TimSweeneyEpic @ParkerThayer', A, [B])).toBe(true);
  });

  it('a passage only this item has is fine', () => {
    expect(anchorIsAmbiguous('the storefront cut is the whole argument', A, [B])).toBe(false);
    expect(anchorIsAmbiguous('the court filing says so too', B, [A])).toBe(false);
  });

  /**
   * Two items whose bodies are byte-identical (a repost, the same line twice) can
   * only ever be anchored by quoting all of it — so quoting all of it must work.
   */
  it('identical bodies stay anchorable by quoting the whole of one', () => {
    expect(anchorIsAmbiguous(A, A, [A])).toBe(false);
  });

  it('says nothing about an empty anchor or an empty field of rivals', () => {
    expect(anchorIsAmbiguous(undefined, A, [B])).toBe(false);
    expect(anchorIsAmbiguous('   ', A, [B])).toBe(false);
    expect(anchorIsAmbiguous('the storefront cut', A, [])).toBe(false);
  });
});

/**
 * The receipt has to say WHY an item was not accepted — "your copy does not quote its
 * own source" leaves four different mistakes looking identical, and the writer picks
 * one at random to fix. `anchorMatches` is this verdict flattened, so the two can
 * never drift apart.
 */
describe('anchorVerdict', () => {
  it('names each way an anchor fails', () => {
    expect(anchorVerdict(LATIN, 'The booster landed on the pad')).toBe('ok');
    expect(anchorVerdict(LATIN, undefined)).toBe('missing');
    expect(anchorVerdict(LATIN, '   ')).toBe('missing');
    expect(anchorVerdict(LATIN, '“…” !!!')).toBe('missing'); // nothing left once punctuation goes
    expect(anchorVerdict(LATIN, 'the cat rode the escalator down')).toBe('notInBody');
    expect(anchorVerdict(LATIN, 'landed')).toBe('tooShort');
    expect(anchorVerdict('Yup', 'Yup')).toBe('ok'); // the whole of a short body
    expect(anchorVerdict('🟡🔵', 'yellow and blue')).toBe('ok'); // nothing to anchor against
  });

  it('is exactly what anchorMatches reports', () => {
    const cases: [string, string | undefined][] = [
      [LATIN, 'The booster landed on the pad'],
      [LATIN, undefined],
      [LATIN, 'landed'],
      [LATIN, 'the cat rode the escalator down'],
      ['Yup', 'Yup'],
      ['🟡🔵', 'yellow and blue'],
      ['🟡🔵', '   '],
    ];
    for (const [source, q] of cases) {
      expect(anchorMatches(source, q), `${source} / ${q}`).toBe(anchorVerdict(source, q) === 'ok');
    }
  });
});
