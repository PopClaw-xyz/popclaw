/**
 * The three onboarding tools on the natural-language path (S3-T5). Registered
 * only when the composition root supplied `getOrchestrator`.
 *
 * Split out of register-tools.ts (2026-08-25).
 */

import {
  OnboardingStatusSchema,
  OnboardingContinueSchema,
  OnboardingSkipSchema,
} from './tool-schemas.js';
import { noteOwnerLanguage, type ToolsCtx } from './tools-context.js';

/** Onboarding registrations, in their original order. */
export function registerOnboardingAgentTools(ctx: ToolsCtx): void {
  const { api, deps } = ctx;

  // === ONBOARDING AGENT TOOLS (S3-T5: natural-language path per O-5 spike) ===
  // These are read/lightweight tools — onboarding advances are conversational
  // and reversible; irreversibility is enforced inside the orchestrator itself
  // (namecard push, taste write). No draft/confirm pattern needed.
  //
  // getOrchestrator() resolves the singleton already wired in runtimePromise —
  // no second instantiation ever occurs.

  const { getOrchestrator } = deps;
  // Routing discipline shared by all three onboarding tools (host-c machine incident,
  // 2026-07-29): a short reply got claimed by the agent's own more-recent pending question,
  // hijacking what was meant to be a name choice. On the new gateway, this kind of short
  // reply is already claimed directly by the plugin's before_dispatch hard gate
  // (onboarding/inbound-claim.ts), so the agent never even sees it; this instruction covers
  // the fallback path on the old gateway.
  const ONBOARDING_ROUTING =
    "While onboarding is in progress, the owner's short replies (a number/a keyword) **are claimed by the plugin directly**; " +
    'if one still reaches you (an older gateway with no claim hook), always call popclaw_onboarding_continue first and ' +
    'let your own pending question give way — do not open a new question before the walkthrough is done, and do not read the owner\'s "1" as an answer to you.';
  if (getOrchestrator !== undefined) {
    api.registerTool({
      name: 'popclaw_onboarding_status',
      description:
        'Call when the owner asks about the popclaw walkthrough progress / which step he is on. ' +
        'Returns what the current act should say (canvas links and numbered material included); it does not advance the state and triggers no LLM. ' +
        'Six acts: pick a name → collect the namecard → meet the lore-houses → attune taste → first errand → set the cadence. ' +
        'Settling in is a checklist, not a rail — in open conversation call this tool first to see where the owner got to and what is missing. ' +
        '**After he graduates**, when you spot a gap nudge gently in the order of the /popclaw status todo list, ' +
        'one item at a time, spelling out the honest consequence (e.g. following nobody → tomorrow morning\'s paper will be empty); ' +
        'never bring up again anything the owner has said he does not want (the morning paper, say). ' +
        // §6 re-render semantics: both pages expire (the passport in 72h), so once the link the owner is holding goes stale, there needs to be a path forward.
        'Both the namecard page and the getting-started page can be re-issued at any time: when the owner says "give me another namecard", ' +
        'pass his own words to popclaw_onboarding_continue (call it even after the walkthrough is over — it re-renders with current data); ' +
        'the getting-started page is yours, so re-render the HTML and call popclaw_canvas. ' +
        // The status tool takes no parameters, so this is where a fresh MCP identity is told
        // where the language signal has to go — otherwise the very first screen is rendered
        // before anyone has said a word about what the owner speaks (2026-08-24 smoke).
        'This tool takes no parameters, so it cannot carry the owner\'s language: pass owner_language ' +
        'on your very first popclaw_onboarding_continue, and keep passing it. ' +
        ONBOARDING_ROUTING,
      parameters: OnboardingStatusSchema,
      execute: async () => {
        const orch = await getOrchestrator();
        const text = await orch.currentCardText();
        return { type: 'text' as const, text };
      },
    });

    api.registerTool({
      name: 'popclaw_onboarding_continue',
      description:
        'If settling in has not begun yet, calling this **starts it** and returns act one — an MCP host has no ' +
        '/popclaw slash command to type, so this is how a new citizen gets in; call it as soon as the owner says he wants to. ' +
        '(Starting fresh ignores answer — there was no question yet — so just read act one back to him.) ' +
        "While onboarding is in progress, the owner's next reply — a number, a name, \"you decide\", " +
        '"mark 2" / "meh, 3", a line like "lately I have been reading…", a plain-language answer about who he wants to follow, ' +
        'or a 1/2 for the morning paper — is almost always an answer to the current act, so pass it through as answer and call this tool to advance; ' +
        'do not take it as small talk. ' +
        'Only switch to another tool when the owner is plainly asking about something else (browsing the world / finding someone / posting). ' +
        'Put the owner\'s own words in answer. "That is enough for now / let me look around first" = the whole walkthrough stops here, pass that through verbatim as well. ' +
        'Read the canvas links and numbers this tool returns back to the owner exactly as they are, not one character changed. ' +
        'owner_language: always pass the language the owner is writing to you in right now — read it off his own ' +
        'words, never ask; it is the only thing that tells popclaw which language to settle him in. ' +
        ONBOARDING_ROUTING,
      parameters: OnboardingContinueSchema,
      execute: async (_callId: string, params: unknown) => {
        const p = params as { answer?: unknown; owner_language?: unknown };
        const answer = typeof p.answer === 'string' ? p.answer : undefined;
        noteOwnerLanguage(p.owner_language);
        const orch = await getOrchestrator();
        const result = await orch.handleAdvance('next', answer);
        return { type: 'text' as const, text: result.text };
      },
    });

    api.registerTool({
      name: 'popclaw_onboarding_skip',
      description:
        'Call when the owner says he wants to skip **the current step** (does not want to pick a name / talk about taste / follow anyone yet), to advance to the next act. ' +
        'Skipping does not close the door: the gap is booked, and after graduation it is nudged one at a time in the status todo order — never asked a second time on the spot. ' +
        'Tell it apart from this: "that is enough for now / let me look around first" means he wants **the whole thing to stop**, and that goes to continue with his words passed through. ' +
        ONBOARDING_ROUTING,
      parameters: OnboardingSkipSchema,
      execute: async () => {
        const orch = await getOrchestrator();
        const result = await orch.handleAdvance('skip');
        return { type: 'text' as const, text: result.text };
      },
    });

  }
}
