/**
 * Build the LLM prompt from scored items + cadence config, call the
 * (injected) LLM, return the text. The LLM is instructed to write in the
 * owner's language — read from the register (`owner-language.ts`), never from
 * cadence directly — with cadence.delivery.tone.
 */

import type { CadenceConfig } from '../cadence/cadence-loader.js';
import type { ScoredItem } from './score-against-taste.js';
import { languageDirective } from '../lexicon/directive.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';

export type LLMRenderFn = (prompt: string) => Promise<string>;

export async function renderDigest(
  scored: readonly ScoredItem[],
  cadence: CadenceConfig,
  llm: LLMRenderFn,
): Promise<string> {
  if (scored.length === 0) {
    return renderCopy(ownerLang(), 'recommend.empty');
  }

  const sysLines: string[] = [];
  sysLines.push(
    `You are popclaw-recommend, a personal social-feed concierge. Your owner has configured the following preferences for HOW you talk to them:`,
    // S1: the ad-hoc "Language:" line became the one shared directive, so the
    // digest, the onboarding briefings and the pings material all say it the
    // same way (and all pin the same house terms).
    // No argument, on purpose: the language register is the single read port
    // (it already ranks an explicit cadence highest, so a configured owner is
    // unaffected). Reading `cadence.delivery.primaryLanguage` here handed the
    // LLM the *default* `en-US` on every machine that never configured one —
    // the same bug that put an English date on a Chinese masthead.
    languageDirective(),
    `  - Style: ${cadence.delivery.summaryStyle}`,
    `  - Tone: ${cadence.delivery.tone}`,
  );
  if (cadence.delivery.includeSourceLinks) sysLines.push(`  - Always include the source URL.`);
  if (cadence.delivery.includeLineage) sysLines.push(`  - Include a short [because <source>] note for each pick so they can trace the recommendation.`);
  sysLines.push(
    `  - When citing an author, use the handle (e.g. @karpathy), NOT the popclaw_id. The popclaw_id is internal; the handle is what the owner recognizes.`,
  );
  if (cadence.promptOverrides) sysLines.push(`Owner's additional voice instructions:\n${cadence.promptOverrides}`);

  const userLines: string[] = [];
  userLines.push(`Here are ${scored.length} scored items from the popclaw world feed (highest score first). Render them as the digest the owner wants to read:`);
  userLines.push('');
  scored.forEach((s, i) => {
    const url = `https://example.invalid/${s.item.platform}/${s.item.platformPostId}`;
    const lineageStr = cadence.delivery.includeLineage
      ? ` [lineage: ${s.lineage.map((l) => `${l.path}=${l.contribution.toFixed(2)}`).join(', ')}]`
      : '';
    const handlePart = s.item.handle ? ` handle=${s.item.handle}` : '';
    userLines.push(
      `[${i + 1}] platform=${s.item.platform}${handlePart} popclaw_id=${s.item.authorPopclawId} score=${s.score.toFixed(2)}${lineageStr}`,
      `    text: ${s.item.textPreview}`,
      `    url: ${url}`,
    );
  });

  const prompt = sysLines.join('\n') + '\n\n' + userLines.join('\n');
  return llm(prompt);
}
