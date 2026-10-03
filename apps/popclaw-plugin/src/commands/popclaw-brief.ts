/**
 * /popclaw brief — merged into the daily paper (#137), kept as a thin alias:
 *   --feedback "<comment>" still records a layout note to canvas-style.md (the layout-coaching
 *   channel, now owned by the paper); everything else goes through the same
 *   /popclaw newspaper agent hand-off flow, prefixed with one migration notice line.
 * The old text+image brief implementation (cache scan → plugin-side LLM renders the canvas) has
 * been removed: it depended on the plugin-side completion subsystem, which always fails on
 * subscription/OAuth hosts (the paper renders in the agent's own turn instead).
 */
import { handleStyleFeedback } from '../visual/style-notes.js';
import { languageDirective } from '../lexicon/directive.js';
import { runPopclawNewspaperCommand } from './popclaw-newspaper.js';

export interface PopclawBriefArgs {
  positional: string[];
  flags: Record<string, string>;
}

export interface PopclawBriefDeps {
  styleFile: string; // canvas-style.md for --feedback (PopclawPaths.canvasStyleFile())
  now?: () => number;
}

// Rides a continueAgent directive (the AGENT consumes this text): instruct the
// agent to relay the retirement, and name the replacement command so the line
// also stands alone if the owner reads it raw. LLM-facing, so English only —
// but this one line IS relayed to the owner **before** any tool runs, so it
// needs the language directive of its own (the paper's own directive only
// arrives with the popclaw_newspaper payload, one step later).
const RETIRED_NOTICE =
  'First tell the owner: /popclaw brief has merged into the paper, use /popclaw newspaper from now on; ' +
  'then put out this issue as usual.';

export async function runPopclawBriefCommand(
  args: PopclawBriefArgs,
  deps: PopclawBriefDeps,
): Promise<{ text: string; continueAgent?: boolean }> {
  const fb = handleStyleFeedback(args.flags, deps.styleFile, deps.now);
  if (fb) return fb;

  // Forward flags too (feedback was intercepted above, so no double-handling;
  // future newspaper flags pass through the alias untouched).
  const r = await runPopclawNewspaperCommand({ positional: args.positional, flags: args.flags });
  return { ...r, text: `${RETIRED_NOTICE}\n${languageDirective()}\n${r.text}` };
}
