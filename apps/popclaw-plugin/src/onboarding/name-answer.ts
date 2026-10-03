/**
 * Read the owner's free-text answer to the naming act before anything is signed.
 *
 * N1 (2026-09-27 acceptance): the owner answered with a sentence stating his
 * name, the agent passed those words through verbatim — exactly as the tool
 * asks — and the whole sentence was signed into the namecard and broadcast to
 * every house. Signed history cannot be recalled.
 *
 * The safety property does not depend on any phrase table: **free text is
 * never adopted as a name.** It becomes a confirmation card, and only an
 * explicit yes bound to that exact value signs it (orchestrator). What the
 * tables add is a better guess for the card ("my name is Kuroba" → Kuroba),
 * a candidate picked by ordinal ("the second one" → candidate 2), and a retry
 * instead of a card for answers that are plainly not a name ("I'm not sure").
 * The tables are lexicon keywords (`onboarding.kw.name*` / `ordinal*`, union
 * across lanes); see the en lane for what each one means.
 */
import { nameAnswerTables, type NameAnswerTables } from './answer-keywords.js';
import { nicknameProblem } from './identity-writer.js';

export type NameAnswer =
  /** A candidate named by ordinal (1-based; the caller checks the range). */
  | { kind: 'candidate'; index: number }
  /** A name to ask back. Never adopt it without the owner's yes. */
  | { kind: 'confirm'; name: string }
  | { kind: 'unclear'; reason: 'sentence' | 'tooLong' | 'placeholder' };

/** Sentence punctuation and line breaks: a name does not carry these. */
const SENTENCE_PUNCT = /[。！？!?,，;；\n]/;
/** Where a stated name ends inside a longer sentence. */
const CLAUSE_BREAK = /[。！？!?,，;；、\n]/;
const LEADING = /^[\s:："'“”‘’「」『』()（）【】《》<>]+/;
/** Around a bare answer: quotes, brackets and a closing period only. */
const TRAILING_BARE = /[\s"'“”‘’「」『』()（）【】《》<>.。]+$/;
/** Around a name cut out of a sentence: also the sentence's own ending. */
const TRAILING_STATED = /[\s"'“”‘’「」『』()（）【】《》<>.。！？!?～~]+$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Latin-script phrases match on word boundaries; CJK phrases as substrings. */
function isLatinPhrase(phrase: string): boolean {
  return /^[\p{Script=Latin}#]/u.test(phrase);
}

function phraseRe(phrase: string, flags = 'iu'): RegExp {
  const body = escapeRe(phrase);
  return isLatinPhrase(phrase)
    ? new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags)
    : new RegExp(body, flags);
}

/** "<phrase>" then the separator before the name: a Latin phrase needs a
 *  space or a colon ("call me: Bob"), a CJK phrase needs nothing. */
function prefixRe(phrase: string): RegExp {
  const body = escapeRe(phrase);
  return isLatinPhrase(phrase)
    ? new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:\\s*[:：]\\s*|\\s+)`, 'iu')
    : new RegExp(`${body}\\s*[:：]?\\s*`, 'iu');
}

function containsAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => p.length > 0 && phraseRe(p).test(text));
}

/**
 * Input hygiene for every path. Format characters (zero-width spaces, bidi
 * marks) go, except the joiner inside an emoji sequence; line breaks become
 * `\n` (a sentence marker); every other control character becomes a space.
 */
function hygiene(s: string): string {
  return s
    .replace(/(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|(?!\u200D)\p{Cf}/gu, '')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(/[^\S\n]*\n[^\S\n]*/g, '\n')
    .replace(/(?!\n)\p{Cc}/gu, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

function strip(raw: string, trailing: RegExp, particles: readonly string[]): string {
  const tail = particles.filter((w) => w.length > 0).map(escapeRe);
  const particleRe = tail.length > 0 ? new RegExp(`(?:${tail.join('|')})$`, 'iu') : undefined;
  let s = raw;
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(LEADING, '').replace(trailing, '');
    if (particleRe) s = s.replace(particleRe, '');
  }
  return s;
}

interface Stated {
  value: string;
  weak: boolean;
}

/**
 * "<phrase> NAME" → the text after the leftmost phrase (ties → the longer
 * phrase), up to the clause break; else "NAME <phrase>". Undefined = the
 * answer states no name in a way we know.
 */
function extract(text: string, t: NameAnswerTables): Stated | undefined {
  let best: { index: number; end: number; len: number; weak: boolean } | undefined;
  const consider = (phrase: string, weak: boolean): void => {
    if (!phrase) return;
    const m = prefixRe(phrase).exec(text);
    if (!m) return;
    const hit = { index: m.index, end: m.index + m[0].length, len: phrase.length, weak };
    if (!best || hit.index < best.index || (hit.index === best.index && hit.len > best.len)) best = hit;
  };
  for (const p of t.prefixes) consider(p, false);
  for (const p of t.weakPrefixes) consider(p, true);
  if (best) {
    const clause = text.slice(best.end).split(CLAUSE_BREAK)[0] ?? '';
    return { value: strip(clause, TRAILING_STATED, t.trailing), weak: best.weak };
  }
  for (const p of t.suffixes) {
    const i = p ? text.toLowerCase().indexOf(p.toLowerCase()) : -1;
    if (i < 0) continue;
    const clause = text.slice(0, i).split(CLAUSE_BREAK).at(-1) ?? '';
    return { value: strip(clause, TRAILING_STATED, t.trailing), weak: false };
  }
  return undefined;
}

function ordinalIndex(value: string, t: NameAnswerTables): number | undefined {
  const v = value.toLowerCase();
  const i = t.ordinals.findIndex((list) => list.some((w) => w.toLowerCase() === v));
  return i >= 0 ? i + 1 : undefined;
}

/**
 * A question rather than a name. Anchored, because the same words sit
 * inside real names ("Doctor Who", "What If", and CJK names that start with
 * a question character): a question word counts when it is the whole
 * answer, or when a Latin one opens an answer of four or more words ("what
 * should I pick"); a tail marker (nameQuestionTail) only at the very end.
 */
function isQuestion(value: string, t: NameAnswerTables): boolean {
  const v = value.toLowerCase();
  if (t.questionWords.some((w) => w.toLowerCase() === v)) return true;
  if (
    v.split(' ').length >= 4 &&
    t.questionWords.some((w) => isLatinPhrase(w) && v.startsWith(`${w.toLowerCase()} `))
  ) {
    return true;
  }
  return t.questionTails.some((w) => w.length > 0 && v.endsWith(w.toLowerCase()));
}

export function parseNameAnswer(answer: string): NameAnswer {
  const t = nameAnswerTables();
  const text = hygiene(answer);
  const stated = extract(text, t);
  const value = stated ? stated.value : strip(text, TRAILING_BARE, []);

  // "the second one" / "let's go with 2" → that candidate.
  const ordinal = ordinalIndex(value, t);
  if (ordinal !== undefined) return { kind: 'candidate', index: ordinal };
  // A candidate reference we could not resolve is never a name to confirm.
  if (containsAny(text, t.ordinalMentions)) return { kind: 'unclear', reason: 'sentence' };

  if (SENTENCE_PUNCT.test(value) || containsAny(value, t.hedges) || isQuestion(value, t)) {
    return { kind: 'unclear', reason: 'sentence' };
  }
  // "I am thinking": a weak phrase only counts when what
  // follows looks like a name.
  if (stated?.weak && (/^\p{Ll}/u.test(value) || containsAny(value, t.weakStops))) {
    return { kind: 'unclear', reason: 'sentence' };
  }
  switch (nicknameProblem(value)) {
    case 'tooLong':
      return { kind: 'unclear', reason: 'tooLong' };
    case 'placeholder':
      return { kind: 'unclear', reason: 'placeholder' };
    case 'empty':
    case 'digits':
      return { kind: 'unclear', reason: 'sentence' };
    default:
      return { kind: 'confirm', name: value };
  }
}
