/**
 * **Which language popclaw speaks TO the owner** (S1; decision doc
 * section 2.3).
 *
 * Two tiers, not a ladder:
 *
 *   1. `config` — the owner **told** us (cadence.json's `primaryLanguage`, or
 *      `popclaw_update_cadence`). An instruction sticks: no observation of
 *      ours ever argues with it.
 *   2. observations — what language the owner is *actually* writing in, seen
 *      every turn (`observeOwnerText`, lane `guess`) or concluded by the agent
 *      (`owner_language` on the onboarding / dream tools, lane `agent`).
 *      **The newest observation wins**, whichever lane it came from: the
 *      current language is a live state that follows the conversation, not a
 *      setting that latches. (2026-07-31 live bug: `agent` used to outrank
 *      `guess` forever, so an owner who switched languages was stuck.)
 *   3. `env` — the host's own locale signals (`LC_ALL`/`LC_MESSAGES`/`LANG`),
 *      read by `useOwnerLangSignals`. Weakest lane on purpose: it fills the
 *      blank on a fresh machine and any observation whatsoever displaces it.
 *      (`talk.speechLocale` and `OPENCLAW_LOCALE` are *not* in this lane — the
 *      owner set those by hand, so they count as `config`.)
 *   4. nothing observed and nothing configured → `en-US`, and the agent is told
 *      to simply mirror the owner (see `languageDirective`).
 *
 * Observations survive a restart in `data/owner-language.json`
 * (`useOwnerLangFile`) — never in cadence.json, which would promote a guess
 * into an instruction on the next boot.
 *
 * Process-wide singleton, same reasoning as `setOwnerTz` in
 * `../time/time-context.ts`: the language is one-per-owner config, and
 * threading it through every display site would be paying for a multi-owner
 * process that does not exist (P-006 §3 — resources are singletons).
 * The composition root (index.ts / mcp.ts) registers it after loading cadence.
 *
 * NOT to be confused with `src/routing/lexicon.ts` (ADR-0043) — see `./index.ts`.
 */

// A one-key state file; HostAdapter has no arbitrary-fs surface, so node:fs
// directly — same exemption as `runtime/last-run.ts`.
/* eslint-disable no-restricted-imports */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/* eslint-enable no-restricted-imports */

import { noteEnvelopeStripped } from '../routing/stats.js';
import { renderCopy, type Lang } from './index.js';

/**
 * Where a language value came from. Kept for logs and for the one rule that
 * matters: `config` (the owner's instruction) outranks both observation lanes,
 * and the two observation lanes are equals — the later one overwrites.
 */
export type LangSource = 'env' | 'guess' | 'agent' | 'config';

const RANK: Record<LangSource, number> = { env: 0, guess: 1, agent: 1, config: 2 };

/** What we speak when nobody has said otherwise (matches `defaultCadence()`). */
export const DEFAULT_OWNER_LANGUAGE = 'en-US';

let current: { tag: string; source: LangSource } | undefined;

/**
 * BCP-47 tag → the lexicon lane that carries it. Only `zh*` has a non-English
 * lane today; every other tag falls to `en` (the agent still speaks the tag's
 * language — see `languageDirective` — it just borrows English house terms).
 * Add a lane here when `Lang` grows one.
 */
export function langOf(bcp47: string): Lang {
  return /^zh([-_]|$)/i.test(bcp47.trim()) ? 'zh-CN' : 'en';
}

/**
 * Register the owner's language **in this process only**. Returns whether it
 * was accepted — callers that persist go through `reportOwnerLang` /
 * `observeOwnerText`, which only write on `true`.
 * An empty/absent tag **resets** the register, state file and all (tests, and
 * a boot with no explicit config), mirroring `setOwnerTz(undefined)`.
 */
export function setOwnerLang(bcp47: string | null | undefined, source: LangSource = 'config'): boolean {
  const tag = (bcp47 ?? '').trim();
  if (tag === '') {
    current = undefined;
    stateFile = undefined;
    onDisk = undefined;
    return false;
  }
  if (current !== undefined && RANK[current.source] > RANK[source]) return false;
  current = { tag, source };
  return true;
}

/**
 * The BCP-47 tag in effect — what the agent is told to speak, and which lane
 * every rendered surface reads.
 *
 * `POPCLAW_LANG` is the escape hatch (S12): set it (typically `POPCLAW_LANG=en`)
 * and everything popclaw says comes out in that language whatever the owner
 * actually writes in — for filing issues, pasting output into docs, and
 * comparing two machines side by side. It deliberately outranks all four lanes
 * above, config included: it is the operator's override, not another signal.
 * Read live rather than latched, so flipping it takes effect without a restart.
 */
export function ownerLangTag(): string {
  return normalizeLocale(process.env.POPCLAW_LANG) ?? current?.tag ?? DEFAULT_OWNER_LANGUAGE;
}

/** The lexicon lane in effect. */
export function ownerLang(): Lang {
  return langOf(ownerLangTag());
}

/**
 * Thin wrapper around `renderCopy`, bound to the current owner language —
 * every plugin-emitted surface (act cards, canvas pages, the orchestrator)
 * used to define this exact function locally; collected here so there is one
 * place to change if the binding ever needs to be anything other than
 * `ownerLang()`.
 */
export function t(key: string, vars: Record<string, string> = {}): string {
  return renderCopy(ownerLang(), key, vars);
}

/**
 * The one owner-facing "it did not work" line (ledger #010).
 *
 * Sixty catch-arms used to build this string in English by hand, so an owner
 * who had just switched popclaw to Chinese — and been told so, in Chinese —
 * got an English apology the moment anything went wrong. The CJK ratchet
 * cannot catch that class: it guards against Chinese escaping the lexicon,
 * not against English literals bypassing it.
 *
 * `err` stays verbatim. Translating an error string we have never read
 * ourselves would destroy the only lead the owner can forward to us.
 *
 * Lives here rather than beside `renderCopy` because it is bound to
 * `ownerLang()`, exactly like `t()` above — and because `index.ts` importing
 * from this file would close an import cycle.
 */
export function failureText(what: string, err: unknown): string {
  return t('error.actionFailed', { what, err: String(err) });
}

/**
 * Which lane set the current value; `undefined` = nothing set yet.
 * `POPCLAW_LANG` reports as `config`: it is an operator instruction, and this
 * is what makes `languageDirective` name the forced tag instead of falling
 * back to "mirror the owner" on a machine that has observed nothing yet.
 */
export function ownerLangSource(): LangSource | undefined {
  if (normalizeLocale(process.env.POPCLAW_LANG) !== undefined) return 'config';
  return current?.source;
}

/**
 * Has anyone **but the host locale** said anything about the owner's language?
 *
 * The `env` lane is good enough to render *something* with and worth nothing
 * as evidence: `LANG=en_US.UTF-8` is a near-constant on developer machines —
 * a Chinese owner's Mac reports it too — and an MCP host hands it straight
 * down to the server it spawns. So it must not be mistaken for the owner
 * having spoken.
 *
 * Every surface that changes **shape** depending on whether we actually know
 * (the deliberately bilingual first screen, the `Speak to the owner in <tag>`
 * line, the naming prompt's language instruction) asks this instead of
 * `ownerLangSource() !== undefined`. On a fresh identity the env lane fills in
 * a millisecond after boot and used to silence all three at once: the
 * 2026-08-24 MCP smoke put an all-English first screen in front of an owner
 * whose every word was Chinese, while the driving agent was writing Chinese
 * back at him.
 */
export function hasRealLanguageSignal(): boolean {
  const source = ownerLangSource();
  return source !== undefined && source !== 'env';
}

/**
 * First contact (Decision 5, tier 1): the arrival card, its hint line, and the
 * "not settling in yet" lines. Until a real signal arrives these are
 * deliberately **bilingual** — English on top, Chinese below — because this is
 * the one screen whose whole job is to get the owner to speak up, and it may
 * not bet on which language he will answer in. The sentence he then types is
 * what tier 2 (script sniffing) reads, and from that moment on everything is
 * one language all the way through (§9.5).
 */
export function firstContact(render: (lang: Lang) => string): string {
  return hasRealLanguageSignal() ? render(ownerLang()) : `${render('en')}\n\n${render('zh-CN')}`;
}

/** `firstContact` for a plain lexicon key. */
export function tFirstContact(key: string, vars: Record<string, string> = {}): string {
  return firstContact((lang) => renderCopy(lang, key, vars));
}

/**
 * Last-resort lane: guess a language from the script the owner typed in.
 * Three stdlib regexes, no dependency, no LLM call. Kana is checked before
 * Han on purpose — Japanese text is full of kanji, so a Han-first test would
 * call every Japanese sentence Chinese.
 *
 * Returns `undefined` for Latin script rather than guessing `en-US`: leaving
 * it unset lets the chain fall through to the default on its own, and keeps a
 * later, better signal (the agent's observation) able to fill the gap.
 */
export function guessLangFromText(s: string): string | undefined {
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(s)) return 'ja-JP';
  if (/\p{Script=Hangul}/u.test(s)) return 'ko-KR';
  if (/\p{Script=Han}/u.test(s)) return 'zh-CN';
  return undefined;
}

// --- the live signal ------------------------------------------------------

let stateFile: string | undefined;
let onDisk: string | undefined;

/**
 * Point the register at `data/owner-language.json` and, if nothing has been
 * registered yet, restore the last language we observed. The composition root
 * calls this **after** the explicit cadence value, so an instruction always
 * beats a remembered observation, and an observation made earlier in this
 * process (the hook can fire before boot finishes) beats the stale file.
 *
 * Why not cadence.json: anything written there comes back as
 * `explicitDelivery` next boot — a guess would silently promote itself to "the
 * owner said so" and could never be observed away again.
 */
export function useOwnerLangFile(file: string): void {
  stateFile = file;
  try {
    const saved = (JSON.parse(readFileSync(file, 'utf-8')) as { tag?: unknown }).tag;
    if (typeof saved !== 'string' || saved.trim() === '') return;
    onDisk = saved;
    if (current === undefined) setOwnerLang(saved, 'guess');
  } catch {
    // No file yet, or corrupt: we simply have not observed anything.
  }
}

/**
 * POSIX locale → BCP-47: `zh_CN.UTF-8` → `zh-CN`, `en_US@euro` → `en-US`.
 * `undefined` for anything that is not a language tag — which is how `C` and
 * `POSIX`, the "no locale" values, fall out for free (neither is 2-3 letters).
 */
export function normalizeLocale(raw: string | null | undefined): string | undefined {
  const tag = (raw ?? '').trim().split('.')[0]!.split('@')[0]!.replaceAll('_', '-');
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(tag) ? tag : undefined;
}

/**
 * Everything the host already knows about the owner's language, applied in
 * priority order — the composition root calls this right after registering an
 * explicit cadence, in place of a bare `useOwnerLangFile`:
 *
 *   `config.talk.speechLocale` / `OPENCLAW_LOCALE` (the owner configured these
 *   by hand, so `config` tier — an explicit cadence, registered first, still
 *   outranks them) → the remembered observation on disk → `LC_ALL` /
 *   `LC_MESSAGES` / `LANG` (`env` tier, loses to everything, including the
 *   observation restored a line earlier).
 *
 * Same sources and same order the host itself uses to pick a wizard locale
 * (openclaw 7.1 `dist/i18n-CSQb1QYq.js:2964`), so an owner who made the
 * installer speak Chinese does not have to say it twice. One deliberate
 * divergence: the host's own chain treats an *empty* `LC_ALL` as a value (and
 * ends up "en"); here a blank counts as unset and the chain falls through to
 * the next variable — see the comment at the chain itself.
 */
export function useOwnerLangSignals(opts: {
  speechLocale?: string | null | undefined;
  file: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = opts.env ?? process.env;
  const configured = normalizeLocale(opts.speechLocale) ?? normalizeLocale(env.OPENCLAW_LOCALE);
  // Guarded rather than rank-guarded: `config` does not displace `config`.
  if (configured !== undefined && current === undefined) setOwnerLang(configured, 'config');
  useOwnerLangFile(opts.file);
  // Treat blank values as absent for this locale fallback (without changing
  // the process environment). Unlike the host wizard's nullish chain, a
  // blank LC_ALL/LC_MESSAGES does not mask LANG. Preserve the old behavior
  // for nonblank C/POSIX/invalid overrides: select first, then normalize,
  // rather than searching lower-priority variables for a supported locale.
  const hostRaw = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => (v ?? '').trim() !== '');
  const host = normalizeLocale(hostRaw);
  if (host !== undefined) setOwnerLang(host, 'env');
}

function persist(tag: string): void {
  if (stateFile === undefined || onDisk === tag) return;
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ tag }), 'utf-8');
    onDisk = tag;
  } catch {
    // Best-effort: a read-only data dir must not disturb the conversation.
  }
}

/**
 * A language the **agent** concluded the owner is speaking (`owner_language`
 * on the onboarding and dream tools). Registered and remembered across
 * restarts; loses to an explicit configuration, and any later observation —
 * including the next turn's script sniff — replaces it. Never throws.
 */
export function reportOwnerLang(tag: string | null | undefined, source: LangSource = 'agent'): void {
  const t = (tag ?? '').trim();
  if (t === '' || !setOwnerLang(t, source)) return;
  persist(t);
}

const CJK_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_CHARS = /\p{Script=Latin}/gu;
/**
 * Not the owner speaking, so counted as nothing: code (fenced or inline),
 * URLs, quoted spans (straight, curly and CJK brackets — a pasted quotation is
 * somebody else's language, in either direction), and **filesystem paths and
 * filenames**.
 *
 * Paths and filenames were the miss (#376). Real machine, five consecutive
 * turns: the owner switched to Chinese, then sent a file — and the register
 * flipped back to en-US on exactly the turn that carried an attachment.
 * An inbound media path is ~58 Latin characters of pure machinery, so a short
 * Chinese sentence sent alongside it drops under the 10% line that means "no
 * longer writing Chinese". Nobody spoke those letters.
 *
 * Same failure shape as the envelope header (#362): metadata the owner did not
 * say, counted as if they had.
 *
 * Both new alternatives are **ASCII-only on purpose**. A greedy "token
 * containing a slash" would swallow a slash written between two Chinese words
 * ("this one / that one") and take real CJK with it — stripping the owner's
 * actual words is the one way this could get worse rather than better.
 */
const NOT_SPEECH =
  /```[\s\S]*?```|`[^`\n]*`|\bhttps?:\/\/\S+|"[^"\n]*"|\u201c[^\u201d\n]*\u201d|\u300c[^\u300d\n]*\u300d|\u300e[^\u300f\n]*\u300f|[A-Za-z0-9_.-]*[/\\][A-Za-z0-9_./\\-]*|\b[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}\b/g;
/**
 * Two, not three: the most common Chinese openers ("hello", "thanks", "you
 * there?", "ok", "got it") are all exactly two characters. A floor of 3 threw
 * away the very first sentence a Chinese owner types, which is the whole point
 * of a per-turn signal.
 *
 * The ≥50% ratio below is the real defence, not this floor: an English
 * sentence carrying a two-character Chinese word ("what does <word> mean?")
 * is 2 CJK against ~12 Latin letters, around 14% — nowhere near a majority —
 * so lowering the floor does not loosen a single mixed sentence.
 * Not 1: a lone character carries too little to bet a language switch on.
 * Examples live in the tests, which are exempt from the CJK ratchet.
 */
const MIN_CJK = 2;
const MIN_LATIN = 12;

/**
 * Which language **dominates** this message — deliberately a majority test and
 * not a "contains" test, because owners quote, paste and name-drop constantly:
 *
 *   - a CJK language when there are ≥2 CJK characters *and* they are ≥50% of
 *     the letters (`guessLangFromText` then separates zh / ja / ko);
 *   - `en-US` when ≥12 Latin letters carry ≤10% CJK **and** the language on
 *     record is a CJK one. Latin script cannot tell en from de, so this can
 *     only ever mean "no longer writing Chinese" — it never overwrites a
 *     Latin-script tag somebody knew better than us (e.g. an agent's `de-DE`);
 *   - `undefined` — leave the register alone — for anything short or mixed.
 *
 * ponytail: quotes/code/URLs are stripped by one regex, not parsed — an
 * unquoted pasted block still counts as speech and can flip the register.
 * Self-correcting: the owner's next ordinary sentence flips it straight back,
 * which is the whole point of a live signal. Parse harder only if that shows
 * up on a real machine.
 */
function dominantLangOf(text: string): string | undefined {
  const s = text.replace(NOT_SPEECH, ' ');
  const cjk = s.match(CJK_CHARS)?.length ?? 0;
  const latin = s.match(LATIN_CHARS)?.length ?? 0;
  const letters = cjk + latin;
  if (letters === 0) return undefined;
  if (cjk >= MIN_CJK && cjk / letters >= 0.5) return guessLangFromText(s);
  if (latin >= MIN_LATIN && cjk / letters <= 0.1 && /^(zh|ja|ko)([-_]|$)/i.test(ownerLangTag())) {
    return DEFAULT_OWNER_LANGUAGE;
  }
  return undefined;
}

/**
 * `[Telegram Alice id:12345 2026-07-31T09:12] Alice: <what the owner typed>`
 * → `<what the owner typed>`.
 *
 * The host wraps the owner's words in an envelope before the agent (and our
 * `before_prompt_build` hook) ever sees them — openclaw 7.1
 * `dist/envelope-CXHEh-mU.js:125 formatAgentEnvelope`, `[${parts.join(" ")}]
 * ${body}`, plus a `Sender: ` body prefix from `formatInboundEnvelope`. That
 * header is 25+ Latin letters of pure metadata, and `dominantLangOf` counts
 * letters: it drowns any short CJK sentence (a 3-character greeting scores
 * ~11% CJK, and a long display name pushes it under the 10% line that flips
 * the register to en-US instead). Strip it, do not parse it.
 *
 * Safe to run on un-enveloped text (the slash path passes `ctx.args`): the
 * header must be a bracketed run with no newline, and the sender prefix is
 * only stripped when a header actually preceded it. Anything malformed, or a
 * strip that leaves nothing behind, falls back to the original string — a
 * failed strip is never worse than today's behaviour.
 */
export function stripEnvelope(text: string): string {
  // Header parts are sanitised host-side: no newlines, and `[`/`]` become
  // parens — so the first `]` really is the end of the envelope. The sender
  // label is likewise colon-free (`resolveDirectEnvelopeBodyLabel` degrades to
  // `(sender)` otherwise), so the lazy quantifier takes exactly that label.
  const body = text.replace(/^\[[^\]\n]*\]\s+(?:[^:\n]{1,64}?:\s)?/, '');
  const stripped = body !== text && body.trim() !== '';
  // Counter, not eyeballs: this strip matches a host format we never imported,
  // so a change is silent. See noteEnvelopeStripped.
  noteEnvelopeStripped(stripped);
  return stripped ? body : text;
}

/**
 * The free, every-turn signal: what the owner just typed. Registers and
 * persists only when the message clearly changed languages; a no-op otherwise
 * (including for the language already in effect, so we write once per switch
 * rather than once per turn). Never throws — nothing here may cost a turn.
 *
 * Strips the host envelope first, for every caller: the hook passes the whole
 * enveloped prompt, and any future caller will too.
 *
 * Returns its verdict (a language **code**, never any of the owner's words) so
 * the caller can trace it — this signal rode the same dead hook as the routing
 * injection for three weeks (#374) and had no live evidence of its own.
 * `switched` is measured, not assumed: `reportOwnerLang` may decline (a
 * config-pinned language outranks a guess), and the trace must say what really
 * happened.
 */
export function observeOwnerText(
  text: string | null | undefined,
): { detected: string | null; switched: boolean } {
  const before = current?.tag ?? null;
  const tag = dominantLangOf(stripEnvelope(text ?? ''));
  if (tag === undefined) return { detected: null, switched: false };
  if (tag === current?.tag) {
    // Already in effect — but the hook can observe before boot binds the file,
    // so give the state file a chance to catch up (a no-op once it matches).
    if (current.source !== 'config') persist(tag);
    return { detected: tag, switched: false };
  }
  reportOwnerLang(tag, 'guess');
  return { detected: tag, switched: (current?.tag ?? null) !== before };
}
