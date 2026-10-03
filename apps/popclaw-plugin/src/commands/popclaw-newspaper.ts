/**
 * /popclaw newspaper [hours] — the render happens in the AGENT's own turn (it has
 * the host's already-authed model; popclaw never calls an LLM). The command hands
 * off to the agent via continueAgent; the agent calls popclaw_newspaper → renders
 * structured copy → calls popclaw_publish_newspaper; the plugin renders the page.
 *
 * --feedback "<comment>" records a layout note to canvas-style.md and returns the
 * ack instead (layout-coaching channel, inherited from the retired brief — #137).
 *
 * ⚠️ Validation item: if continueAgent does not hand off on the target host, this
 * still returns a useful directive — the owner can ask for the paper in conversation
 * (the natural-language path drives the same two tools).
 */
import { handleStyleFeedback } from '../visual/style-notes.js';

export interface PopclawNewspaperArgs {
  positional: string[];
  flags?: Record<string, string>;
}

export interface PopclawNewspaperDeps {
  styleFile?: string; // canvas-style.md for --feedback (PopclawPaths.canvasStyleFile())
  now?: () => number;
}

export async function runPopclawNewspaperCommand(
  args: PopclawNewspaperArgs,
  deps: PopclawNewspaperDeps = {},
): Promise<{ text: string; continueAgent?: boolean }> {
  const fb = handleStyleFeedback(args.flags ?? {}, deps.styleFile ?? '', deps.now);
  if (fb) return fb;

  // LLM-facing handoff: English is the only source (decision doc section 4).
  // **Do NOT attach languageDirective here**: the language directive is already included in the
  // popclaw_newspaper payload (`buildNewspaperPrompt`), and the slash path's next step is to call
  // that tool. Attaching it here would give the slash path two copies, while the tool path (the
  // owner just saying "give me the paper") would get none.
  const n = Number(args.positional[0]);
  const window = Number.isInteger(n) && n > 0 && n <= 168 ? `the last ${n} hours` : 'today';
  const firstCall = window === 'today' ? 'with no arguments' : `with hours=${n}`;
  return {
    continueAgent: true,
    text:
      `Produce the paper for ${window}: call popclaw_newspaper ${firstCall}. ` +
      'If it returns a finished workshop receipt or a failure note, relay that verbatim and stop; do not start another edition. ' +
      'If it returns a candidate page, choose from that page and call popclaw_newspaper with your picks and its exact basis. ' +
      'Write structured edit copy from the returned material page, using that page\'s item numbers and copying its basis into every edit. ' +
      'Each item carries q (a passage copied verbatim from that item\'s own body, which publish checks), h and s. ' +
      'Submit with popclaw_publish_newspaper in batches of at most 12 items; include the structure fields and teaser in the first batch. ' +
      'Continue only the unwritten items named by the receipt until the issue is finished. ' +
      'The plugin renders the page: do not write HTML or URLs. Send the final receipt and link verbatim.',
  };
}
