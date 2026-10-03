/**
 * Bond Book semantic retrieval (§C4): "pull up a group of people with one
 * sentence" — e.g. "my business partners' recent activity". FTS5 coarse
 * filter (falls back to all positive-tier bonds when thin — the default
 * tokenizer is weak on CJK), then ONE LLM call that writes the human-facing
 * summary directly (no structured parsing). ADR-0022.
 *
 * S2 scope call (rollout slice 1): this prompt is LLM-facing, not owner-facing
 * material, so it lives in plain English like every other agent-facing prompt
 * in this codebase (register-tools.ts descriptions, recommend/render-digest.ts,
 * onboarding/briefing.ts) — no lexicon lane. The LLM still answers in the
 * owner's actual language via the shared `languageDirective()` instruction.
 */
import type { Bond, BondsStore } from './bonds-store.js';
import type { LLMCompleteFn } from '../recommend/score-against-taste.js';
import { languageDirective } from '../lexicon/directive.js';

const FTS_FLOOR = 3; // below this many FTS hits, broaden to all positive-tier bonds
const MAX_CANDIDATES = 200; // cap on people fed to the LLM (bond-book scale guard)
const RECENT_PER_PERSON = 3;

export interface FindBondsDeps {
  bondsStore: BondsStore;
  llmComplete: LLMCompleteFn;
}

export async function findBonds(deps: FindBondsDeps, query: string): Promise<string> {
  const { bondsStore, llmComplete } = deps;

  const hits = bondsStore.search(query);
  const pool: Bond[] =
    hits.length >= FTS_FLOOR
      ? hits.slice(0, MAX_CANDIDATES)
      : bondsStore.list({ minTier: 'acquaintance', limit: MAX_CANDIDATES });

  if (pool.length === 0) {
    return "There's nobody in your bond book yet. Interact with people first, and I'll have something to remember them by.";
  }

  const lines: string[] = [
    `The owner asked: "${query}"`,
    '',
    'Below are the people in the bond book (remark name / popclaw_id / tags / description / recent activity). ' +
      'Pick out the people who genuinely match what the owner means, and answer concisely: who matches + their ' +
      'recent situation. Only mention people who match; if none do, say so plainly.',
    languageDirective(),
    "Include each person's popclaw_id when you mention them (needed as the key for a later DM/follow).",
    '',
  ];
  for (const b of pool) {
    const who = b.remarkName || b.popclawId.slice(0, 10);
    const dyn = bondsStore
      .recentDynamics(b.popclawId, RECENT_PER_PERSON)
      .map((d) => d.summary)
      .join('; ');
    lines.push(
      `- ${who} | popclaw_id:${b.popclawId} | tags:${JSON.stringify(b.tags)} | ${b.description || '(no description)'}${dyn ? ` | recent:${dyn}` : ''}`,
    );
  }

  return llmComplete(lines.join('\n')); // throws on LLM failure → caller handles
}
