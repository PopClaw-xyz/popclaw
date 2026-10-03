/**
 * The language instruction popclaw staples onto agent-facing material
 * (decision doc section 2.5). The agent IS the translation engine — no i18n
 * framework, no extra LLM call: we hand it the material plus three lines
 * saying which language to speak and which house terms not to touch.
 *
 * Deliberately CJK-free: the Chinese words come out of `lexiconFor('zh-CN')`,
 * never out of a literal here (CJK-leak ratchet).
 */

import { lexiconFor, type Lang } from './index.js';
import { hasRealLanguageSignal, ownerLang, ownerLangTag } from './owner-language.js';

/**
 * The house terms worth pinning. Only the flat string terms — the nested
 * label tables (tier/roles/worldKinds) belong to the material that uses them,
 * not to a directive the agent reads on every turn.
 */
const PINNED_TERMS = [
  'loreHouse',
  'ranger',
  'sigil',
  'name',
  'alias',
  'bondBook',
  'theWorld',
  'dailyPaper',
  'noticeBoard',
  'houseGuide',
  'namecard',
  'dream',
  'pings',
  'redPacket',
] as const;

/**
 * `Speak to the owner in <tag>` + the term glossary for that language.
 * Defaults to whatever the process register holds (`owner-language.ts`);
 * callers that already have a cadence value in hand pass it explicitly.
 *
 * When nothing at all is known about the owner's language we name **no** tag:
 * telling a Chinese owner's agent to "speak en-US" because we happen to
 * default to it is exactly how a machine ends up half English and half Chinese
 * (2026-07-31 live report). The agent can see the owner's own words — let it
 * mirror them until an observation or an instruction arrives. The host locale
 * is not such an arrival (`hasRealLanguageSignal`): `LANG=en_US.UTF-8` says
 * where the machine was built, not who is typing.
 *
 * The glossary prints `en-term=local-term` when the two differ and the bare
 * term when they don't, so the English side reads as a "leave these alone"
 * list rather than a row of identities.
 */
export function languageDirective(
  lang: Lang = ownerLang(),
  tag: string | undefined = hasRealLanguageSignal() ? ownerLangTag() : undefined,
): string {
  const en = lexiconFor('en').terms;
  const local = lexiconFor(lang).terms;
  const glossary = PINNED_TERMS.map((k) => (en[k] === local[k] ? en[k] : `${en[k]}=${local[k]}`)).join(', ');
  return [
    tag === undefined
      ? 'Speak to the owner in whatever language they are writing to you in — match them turn by turn, whatever language this material is written in.'
      : `Speak to the owner in ${tag} — everything you say to them, whatever language this material is written in.`,
    `Use these house terms exactly, never re-translate them: ${glossary}.`,
    `Quoted content (posts, replies, people's names) stays in its original language — never translate what someone else wrote.`,
  ].join('\n');
}

/**
 * How the agent should lay the material out when it speaks it back to the owner.
 *
 * Two failures this is aimed at, both observed on real hosts (ledger #005/#008):
 * a todo relayed as its title with the command dropped — the command being the
 * only actionable thing in the line — and the reply dressed up in `>` blockquotes
 * and `---` dividers, which the owner's channel renders as grey cards and rules
 * that shatter on a phone.
 *
 * A probabilistic fix, not a guarantee: an instruction only bends a model, and
 * one sample proves nothing either way (see the connected-shot verification in
 * the polish spec). English on purpose — this is read by the model, not the owner.
 */
export function renderDirective(): string {
  return [
    'INSTRUCTIONS FOR YOU, NOT FOR THE OWNER — never show these lines to them.',
    'Relay each todo line verbatim, including the command after the arrow —',
    'never summarize a todo down to its title; the command is the whole point.',
    'Never drop the \u2699 config line or its path.',
    '"Verbatim" is about the wording only: never mention relaying or quoting to',
    'the owner, and never wrap the lines in quote markup.',
    'Format the whole reply as plain short lines: no tables, no > blockquotes,',
    'no --- dividers, no [text](url) links, no inline backticks. Bare URLs',
    'and **bold** are fine. One idea per line, short enough for a phone.',
  ].join('\n');
}
