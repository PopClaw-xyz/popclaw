/** Client distributions can consume house streams but cannot execute Ranger tasks.
 * Replaced at build time, not selected by a user-controlled environment flag.
 * Type-only imports preserve the real module contract without bundling providers. */
import type { RangerDeps, ScraperReportLogger } from './ranger.js';

export const RANGER_AVAILABLE = false;

export async function reportScrapers(_logger: ScraperReportLogger): Promise<void> {
  // No provider discovery, environment reads or missing-credential warnings.
}

export class Ranger {
  constructor(_deps: RangerDeps) {
    throw new Error('Ranger task execution is unavailable in the client distribution');
  }
  async start(): Promise<void> {
    throw new Error('Ranger task execution is unavailable in the client distribution');
  }
  async stop(): Promise<void> {}
}
