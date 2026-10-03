/**
 * `/popclaw dream` -- manually trigger a dream. **The thinking happens in the agent's own turn**
 * (the host's already-authenticated model; the plugin cannot call an LLM), so the command itself
 * just hands off the work: the agent calls popclaw_dream to fetch material → thinks it through
 * itself → calls popclaw_record_dream to write it back. Same pattern as `/popclaw newspaper`.
 *
 * The scheduled branch goes through OpenClaw cron, set up by the agent at the owner's word --
 * the plugin never registers a scheduled task on its own (spec 2026-07-26 §1).
 */
import { languageDirective } from '../lexicon/directive.js';

export interface PopclawDreamArgs {
  positional: string[];
  flags: Record<string, string>;
}

export async function runPopclawDreamCommand(
  _args: PopclawDreamArgs = { positional: [], flags: {} },
): Promise<{ text: string; continueAgent?: boolean }> {
  // LLM-facing handoff: English is the only source (decision doc section 4).
  // The owner still hears the result in their own language — languageDirective.
  return {
    continueAgent: true,
    text:
      'Use the popclaw_dream tool to fetch the material for "since the last dream", digest it into ' +
      '(1) what you now know about each person and (2) the owner\'s taste tags, write it back with ' +
      'popclaw_record_dream, then tell me how it went.\n\n' +
      languageDirective(),
  };
}
