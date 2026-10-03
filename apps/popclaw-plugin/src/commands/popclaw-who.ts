/**
 * /popclaw who <natural language> — "pull up a group of people with one
 * sentence" (§C4). Thin surface over findBonds.
 * e.g. /popclaw who what have my business partners been up to lately
 */
import { renderCopy } from '../lexicon/index.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';

export interface PopclawWhoArgs {
  positional: string[];
}
export interface PopclawWhoDeps {
  findBonds: (query: string) => Promise<string>;
}

export async function runPopclawWhoCommand(
  args: PopclawWhoArgs,
  deps: PopclawWhoDeps,
): Promise<{ text: string }> {
  const query = args.positional.join(' ').trim();
  if (!query) {
    return { text: renderCopy(ownerLang(), 'who.usage') };
  }
  try {
    return { text: await deps.findBonds(query) };
  } catch (err) {
    return { text: failureText('/popclaw who', err) };
  }
}
