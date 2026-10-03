/**
 * Keyword recognition for the owner's answers. The host is an OpenClaw agent, and
 * the owner speaks in plain human language (not slash arguments), so we route by
 * keyword first; bare digits are kept for back-compat with the TUI slash path.
 *
 * Matching discipline: short/common words only ever get **whole-string** exact
 * matching — names can already contain these characters (e.g. names like "Good
 * Sword", "Keep-Walking Wanderer", "Maybe-Guest" contain substrings that overlap
 * with keywords), and substring matching would swallow the name the owner wanted.
 *
 * S5 language discipline (decision doc §4, the "input parsing" row): entries were
 * moved into the lexicon, but matching is a **union across all languages**, and
 * **never gated by `ownerLang()`** — it's routine for a bilingual owner to type
 * "skip" this turn and "跳过" (skip) next turn, and gating by locale would judge
 * the latter as free text. And this table **does not grow with each language**: it
 * only holds the closed set of short replies that "the plugin must claim before the
 * agent does" — every long-tail case is handed to the agent.
 */
import { lexiconFor, type Lang } from '../lexicon/index.js';

/** All lanes in the union. Add one line here when adding a language; nothing else needs to change. */
const LANES: readonly Lang[] = ['en', 'zh-CN'];

/** The union of a key's entries across all lanes (`|`-separated in the lexicon). */
function words(key: string): string[] {
  return LANES.flatMap((lane) => {
    const raw = lexiconFor(lane).copy[key] ?? '';
    return raw ? raw.split('|') : [];
  });
}

function matchesExact(key: string, answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return words(key).some((w) => a === w.toLowerCase());
}

export function isProceedKeyword(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  // "进江湖" / "enter the world" is distinctive enough to substring-match (e.g. "进江湖吧" [let's enter the world], "好就进江湖" [okay, entering the world]).
  if (words('onboarding.kw.proceedSubstring').some((w) => a.includes(w.toLowerCase()))) return true;
  return matchesExact('onboarding.kw.proceed', a);
}

/** "yes" (any lane) = confirms the name on the naming confirmation card. Whole-string match. */
export function isConfirmWord(answer: string): boolean {
  return matchesExact('onboarding.kw.confirm', answer);
}

/** "no" (any lane) = turns down the name on the naming confirmation card. Whole-string match. */
export function isDenyWord(answer: string): boolean {
  return matchesExact('onboarding.kw.deny', answer);
}

/** The naming act's phrase tables (N1, name-answer.ts): union across lanes, lexicon order. */
export interface NameAnswerTables {
  prefixes: string[];
  weakPrefixes: string[];
  weakStops: string[];
  suffixes: string[];
  trailing: string[];
  hedges: string[];
  questionWords: string[];
  questionTails: string[];
  /** ordinals[i] = the whole answers that mean candidate i + 1. */
  ordinals: string[][];
  ordinalMentions: string[];
}

export function nameAnswerTables(): NameAnswerTables {
  return {
    prefixes: words('onboarding.kw.namePrefix'),
    weakPrefixes: words('onboarding.kw.nameWeakPrefix'),
    weakStops: words('onboarding.kw.nameWeakStop'),
    suffixes: words('onboarding.kw.nameSuffix'),
    trailing: words('onboarding.kw.nameTrailing'),
    hedges: words('onboarding.kw.nameHedge'),
    questionWords: words('onboarding.kw.nameQuestionWord'),
    questionTails: words('onboarding.kw.nameQuestionTail'),
    ordinals: [1, 2, 3].map((n) => words(`onboarding.kw.ordinal${n}`)),
    ordinalMentions: words('onboarding.kw.ordinalMention'),
  };
}

/** "你定" ("you decide") = hands the choice back (arrival takes the first candidate). Whole-string match. */
export function isYouDecide(answer: string): boolean {
  return matchesExact('onboarding.kw.youDecide', answer);
}

/**
 * "先这样 / 先看看" ("that's enough for now / let me just look around") = bail
 * (spec §1, the other half of skip's dual meaning): not skipping this one step,
 * but ending the whole onboarding here → completed, with the gap still recorded.
 * Whole-string match, never swallows a name.
 */
export function isBailKeyword(answer: string): boolean {
  return matchesExact('onboarding.kw.bail', answer);
}

/** Changing one's mind about the name after the passport is issued (spec §2 passport: "换个名字" ["change my name"] → back to arrival). */
export function isRenameRequest(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return words('onboarding.kw.rename').some((w) => a === w.toLowerCase() || a.includes(w.toLowerCase()));
}

/**
 * "再给我一张护照 / 名帖过期了重出一张" ("give me another passport" / "the
 * namecard expired, issue a new one") (R1 spec §6): the passport page expires
 * after 72h, and the owner can ask for a new one anytime. Requires the word
 * "护照/名帖" (passport/namecard) PLUS a sense of "再/重/新/过期" (again/re-/new/
 * expired) — both conditions must hold. "这护照真好" ("this passport is great")
 * is not a request, and neither is "我不要护照" ("I don't want a passport").
 */
export function isPassportReissueRequest(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  const has = (key: string): boolean =>
    words(key).some((w) => a.includes(w.toLowerCase()));
  return has('onboarding.kw.passportNoun') && has('onboarding.kw.reissue');
}

/**
 * In the attune question, these whole-string answers mean "I'd rather not say"
 * rather than actual self-description content — bare digits, or a skip-type
 * word the owner (relayed through the agent) said again. Must never be written
 * into the sovereign layer. Whole-string exact match only: substring matching
 * would swallow a genuine self-description (e.g. "我关心开源治理，跳过热闹" —
 * "I care about open-source governance, skip the noise").
 */
export function isNotSelfDescription(answer: string): boolean {
  return matchesExact('onboarding.kw.notSelfDescription', answer);
}

/** "跳过这一步" ("skip this step") — once the inbound hard gate claims it, maps to skip (everything else maps to next). */
export function isSkipWord(answer: string): boolean {
  return matchesExact('onboarding.kw.skip', answer);
}

/**
 * The two action words for the lore-house act (`标一下 3` / `mark 3`, `无感 3`
 * / `not for me 3`). The ordinal is parsed out here too — orchestrator and
 * inbound-claim used to each carry their own copy of the regex, and lexiconizing
 * this merged them into the same matcher. Returns null = not this shape.
 */
function matchNumbered(key: string, answer: string): number | null {
  const a = answer.trim().toLowerCase();
  for (const w of words(key)) {
    const re = new RegExp(`^${escapeRe(w.toLowerCase())}\\s*(\\d+)$`);
    const m = a.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchMark(answer: string): number | null {
  return matchNumbered('onboarding.kw.mark', answer);
}

export function matchMeh(answer: string): number | null {
  return matchNumbered('onboarding.kw.meh', answer);
}

/** 零/〇/一…二十三 → 0-23. Built rather than written out: the owner dictates by
 *  voice, and Chinese ASR renders a spoken time as characters, not digits, so
 *  a digits-only reader would silently never work for him. */
const CJK_HOURS: ReadonlyMap<string, number> = (() => {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const m = new Map<string, number>([['〇', 0], ['十', 10]]);
  d.forEach((c, i) => m.set(c, i));
  for (let i = 1; i <= 9; i++) m.set(`十${d[i]}`, 10 + i);
  m.set('二十', 20);
  for (let i = 1; i <= 3; i++) m.set(`二十${d[i]}`, 20 + i);
  return m;
})();

/** Day-parts that push a small hour into the afternoon. 凌晨/早上/上午 leave it alone. */
const CJK_PM = /下午|晚上|傍晚|夜里|夜晚/;

/**
 * An hour the owner named for the daily paper, or undefined when they did not
 * name one (`1`/`2` are the menu, and an affirmative word is not a time).
 *
 * Digits only, on purpose. The owner's words arrive verbatim
 * (`popclaw_onboarding_continue` passes them through unchanged), so this has to
 * do the reading itself — and a natural-language time parser across two
 * languages is a far bigger thing than the question deserves. When this comes
 * back undefined the proposed hour simply stands, so a miss costs a nudge, not
 * a wrong alarm.
 */
export function readCadenceHour(answer: string): number | undefined {
  const a = answer.trim().toLowerCase();
  // `1` / `2` alone are the two menu options, never 1am / 2am. Anything longer
  // ("at 1", "1点", "1pm") is a time the owner actually spelled out.
  if (/^[12]$/.test(a)) return undefined;
  // A bare number counts only when the answer *is* that number; otherwise the
  // digits have to sit against a clock marker. The two mistakes cost very
  // different amounts: missing an hour falls back to the proposed one, which
  // the owner reads back and corrects — inventing one from "行，我有 2 个问题"
  // sets them a 02:00 alarm they never asked for.
  // Characters first: `晚上九点` has no digits at all for the numeric reader.
  const cjk = a.match(/([零〇一二三四五六七八九十]{1,3})\s*[点時时]/);
  if (cjk) {
    const base = CJK_HOURS.get(cjk[1]!);
    if (base === undefined) return undefined;
    return CJK_PM.test(a) && base < 12 ? base + 12 : base;
  }
  const m = /^\d{1,2}$/.test(a)
    ? ([a, a, undefined] as unknown as RegExpMatchArray)
    : a.match(/(\d{1,2})\s*(?::00|点|时)\s*(am|pm)?|(\d{1,2})\s*(am|pm)/);
  if (!m) return undefined;
  const digits = m[1] ?? m[3];
  const meridiem = m[2] ?? m[4];
  if (digits === undefined) return undefined;
  let h = Number(digits);
  if (!Number.isInteger(h) || h < 0 || h > 23) return undefined;
  if ((meridiem === 'pm' || CJK_PM.test(a)) && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  return h;
}

/** The two directions for cadence's closing question; if neither hits → undefined (never decide on the owner's behalf). */
export function readCadenceChoice(answer: string): 'daily' | 'declined' | undefined {
  const a = answer.trim().toLowerCase();
  const hit = (key: string): boolean => words(key).some((w) => a.includes(w.toLowerCase()));
  let choice: 'daily' | 'declined' | undefined;
  if (/^1$/.test(a) || isProceedKeyword(a) || hit('onboarding.kw.cadenceYes')) choice = 'daily';
  // Negative word judged second: "不要" ("don't want") contains "要" ("want"), "no thanks" contains "no" — judging it second means the negative wins.
  if (/^2$/.test(a) || hit('onboarding.kw.cadenceNo')) choice = 'declined';
  return choice;
}
