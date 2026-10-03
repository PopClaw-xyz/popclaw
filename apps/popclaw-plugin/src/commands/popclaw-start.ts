import type { OnboardingOrchestrator } from '../onboarding/orchestrator.js';

/**
 * `/popclaw start` — owner-initiated entry to first-run onboarding.
 *
 * Idempotent: calling when already in welcoming re-presents the card;
 * calling when completed prints a "already done" message.
 *
 * In O-3b, this is the ONLY entry point. Future SDK-level implicit-mention
 * support (when OpenClaw exposes it) will also call into orchestrator.
 */
export async function runPopclawStartCommand(deps: {
  orchestrator: OnboardingOrchestrator;
}): Promise<{ text: string }> {
  return deps.orchestrator.handleStartCommand();
}
