/**
 * `/popclaw taste` — a **one-time harvest**: has the agent dig out what it
 * already knows about "who the owner is, what they care about" from its own
 * memory, and write it into taste.
 *
 * ## Why this path has to exist
 *
 * The night digest (social log + world feed) answers "who and what did they
 * react to in the world." But what the owner actually cares about **happens
 * mostly outside the world** — they talk to the agent about Flutter, about
 * building a literacy game for their kid, about red-packet contracts, and
 * the social log doesn't see a word of any of it. That other half lives
 * only in the agent's own memory.
 *
 * Measured in practice (2026-07-27, on real hardware: lcm, 28 sessions /
 * 3408 messages): `lcm_grep` across all sessions for "不喜欢|讨厌|烦"
 * (dislike/hate/annoyed) hit 37 matches, "识字|宝宝|孩子|游戏"
 * (literacy/kid/child/game) hit 20 — the knowledge really is there, and
 * specific enough to use.
 *
 * ## Why it must be initiated by the owner
 *
 * That investigation burned **594,000 tokens**. That's not something that
 * can ride along on every night's dream cycle. The owner speaking up is
 * both the authorization and the cost gate — both reasons hold on their
 * own.
 *
 * ## Why popclaw doesn't read lcm.db itself
 *
 * (1) That's OpenClaw core's territory, and also the owner's most private
 * data; (2) architecturally this belongs to the agent anyway — the same
 * principle of "the plugin provides structure, the agent provides content."
 * popclaw only supplies four things: **the digging instructions, the write
 * entry point, format constraints (must carry tags), and showing the result
 * back to the owner verbatim once it's saved**.
 */
import { languageDirective } from '../lexicon/directive.js';

export interface PopclawTasteArgs {
  positional: string[];
  flags: Record<string, string>;
}

/**
 * The digging instructions handed to the agent. **Discipline matters more
 * than how much gets found** — a fabricated taste profile is worse than an
 * empty one: an empty one gets flagged by status as needing to be filled
 * in, a fabricated one keeps lying indefinitely, and it will poison every
 * recommendation ranking from then on.
 *
 * LLM-facing, so English is the one and only source (decision doc section 4:
 * material for the agent is not owner copy — it never gets a zh twin). The
 * owner still hears the result in their own language: `languageDirective()`
 * rides along on the handoff below.
 */
export const TASTE_HARVEST_PROMPT = [
  'Dig out what you already know about who I am and what I have been into lately, and write it into my taste file.',
  '',
  '[How to dig] In this order, and **do not just look at the current session**:',
  '1. `memory_search` — semantic search. If it comes back disabled the index was never built: skip to step 2,',
  '   and remind me at the end to run `openclaw memory index --force` (this gets a lot cheaper once it exists).',
  '2. `lcm_grep` — keyword search across [every session] (not just this one!); `lcm_describe` reads a session summary.',
  '3. `memory_get` — read MEMORY.md and the journals under memory/.',
  '',
  '[Discipline — this matters more than how much you find]',
  '· Only write down what you have **evidence** for. For every tag you must be able to say which conversation / which summary it came from.',
  '· **Do not pad it out with the persona in USER.md / SOUL.md** — I wrote that when I first set the persona up,',
  '  and it froze there; what I want is what I am **actually** busy with, and annoyed by, lately.',
  '· What I do not want to see (mute): **leave it empty if there is no evidence**. Better empty than guessed.',
  '· Tags must be specific ("red-packet contract", "literacy game for my kid", "terminal toolchain"), not vague ("tech", "AI").',
  '',
  '[Cost gate] At most 8 searches + 5 summaries. Stop as soon as you have enough — trawling old conversations is expensive.',
  '',
  '[How to deliver] Call `popclaw_write_taste` to write back: tags / mute / summary.',
  'Spell out the evidence line by line in summary (which conversation, when). Then read it back to me exactly as written, so I can overrule it on the spot.',
].join('\n');

export async function runPopclawTasteCommand(
  _args: PopclawTasteArgs = { positional: [], flags: {} },
): Promise<{ text: string; continueAgent?: boolean }> {
  return { continueAgent: true, text: `${TASTE_HARVEST_PROMPT}\n\n${languageDirective()}` };
}
