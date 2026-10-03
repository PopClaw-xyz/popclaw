/**
 * S3 (three-act spec §3.1) — name suggestions. One LLM call produces ≤3
 * candidates (cost discipline: a single prompt). Materials: the persona-file
 * content the owner explicitly provided (the authorization gate is at the call
 * site — only read once the owner gives a path) + verified handles.
 * LLM unavailable / parse failure → static fallback (empty candidates, the
 * call site guides the owner to pick their own).
 */
import { z } from 'zod';
import { nicknameProblem } from './identity-writer.js';
import { hasRealLanguageSignal, ownerLangTag } from '../lexicon/owner-language.js';

export interface LLMClientLike {
  complete(prompt: string): Promise<string>;
}

export interface NamingMaterials {
  /** The persona-file content the owner explicitly authorized (already-read text, not a path); undefined if none. */
  readonly personaText?: string;
  readonly verifiedHandles: readonly string[];
}

const replySchema = z.object({ names: z.array(z.string()) });

export function buildNamingPrompt(m: NamingMaterials): string {
  // The host locale does not count as knowing (`hasRealLanguageSignal`): the
  // name candidates are the very first screen, and picking them in en-US
  // because the Mac says `LANG=en_US.UTF-8` is how a Chinese owner gets offered
  // three English names before he has typed a word.
  const tag = hasRealLanguageSignal() ? ownerLangTag() : undefined;
  const sections = [
    "You are helping the owner pick a name for the world — their display name on popclaw, " +
      'a decentralised social network.',
    'Requirements: memorable, not cloying, 2-12 characters; never output a `ranger-xxx` style ' +
      'placeholder; no explanations.',
    // The name is the owner's own language asset: candidates follow the owner's
    // language, and if it can't be guessed, don't force one (same discipline as
    // languageDirective — better to let the model mirror the owner than to
    // hard-code English).
    tag === undefined
      ? "Write the candidates in whatever language the material below is in; if you cannot tell, offer a mix."
      : `Write the candidates in ${tag} where that reads naturally; a Latin-script name is always acceptable too.`,
  ];
  if (m.personaText) {
    sections.push(`# The owner's own description / persona material\n${m.personaText.slice(0, 2000)}`);
  }
  if (m.verifiedHandles.length > 0) {
    sections.push(`# Accounts the owner has already verified\n${m.verifiedHandles.join(', ')}`);
  }
  sections.push('Output one JSON object and nothing else: {"names": ["first", "second", "third"]}');
  return sections.join('\n\n');
}

export async function suggestNames(
  llm: LLMClientLike | null,
  materials: NamingMaterials,
): Promise<string[]> {
  if (!llm) return [];
  try {
    const raw = await llm.complete(buildNamingPrompt(materials));
    // Strip markdown fences and any leading/trailing prose — extract first {...} block.
    const stripped = raw.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
    const parsed = replySchema.parse(JSON.parse(stripped));
    return parsed.names
      .map((n) => n.trim())
      .filter((n) => nicknameProblem(n) === undefined)
      .slice(0, 3);
  } catch {
    return [];
  }
}
