import type { OnboardingOrchestrator } from '../onboarding/orchestrator.js';

/**
 * `/popclaw next [answer]` / `/popclaw skip` — onboarding continuation commands.
 *
 * Per spec §6.1, numbered-text reply is the load-bearing path until O-5
 * lands interactive-runtime properly; today the TUI doesn't render
 * MessagePresentation buttons reliably so the slash-command flow IS the
 * primary way for owners to progress through onboarding stages.
 *
 * `next` accepts free text after the verb — a name-candidate number, a
 * self-chosen name, a highlight-entry number, a taste self-description, or a
 * plain-language sentence about who to follow — all passed through verbatim
 * into the orchestrator.
 */
export async function runPopclawNextCommand(
  deps: { orchestrator: OnboardingOrchestrator },
  answer?: string,
): Promise<{ text: string }> {
  return deps.orchestrator.handleAdvance('next', answer);
}

export async function runPopclawSkipCommand(deps: {
  orchestrator: OnboardingOrchestrator;
}): Promise<{ text: string }> {
  return deps.orchestrator.handleAdvance('skip');
}
