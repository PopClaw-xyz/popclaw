import { houseReadFailure, type HouseReadFailure } from '../runtime/house-lifecycle/read-failure.js';
import { summaryDeclaration } from './guide.js';
import type { GuideTextResult } from './guide-client.js';
import type { WorldSummaryResponse, WorldSummaryResult } from './world-summary-client.js';

export interface SummaryGuideReader {
  fetchGuideText(): Promise<string | null>;
  fetchGuideResult?(): Promise<GuideTextResult>;
}

export interface SummaryReader {
  fetchSummary(windowHours?: number): Promise<WorldSummaryResponse | null>;
  fetchSummaryResult?(windowHours?: number): Promise<WorldSummaryResult>;
}

/** Only a supported declaration exposes a summary read. These are read facts,
 * not an authority grant: the injected clients retain their current read gates. */
export type DeclaredSummaryRead =
  | { readonly status: 'supported'; readonly guideText: string; read(windowHours?: number): Promise<WorldSummaryResult> }
  | { readonly status: 'unsupported'; readonly guideText: string }
  | { readonly status: 'unknown'; readonly failure?: HouseReadFailure };

/** Read the primary House guide before preparing its optional summary read.
 * Caller-owned snapshot reads can start beside read(), after this resolves.
 * No presentation, retry, memoization or transport policy lives here. */
export async function prepareDeclaredSummaryRead(
  guideClient: SummaryGuideReader,
  summaryClient: SummaryReader,
): Promise<DeclaredSummaryRead> {
  let guide: GuideTextResult;
  try {
    if (guideClient.fetchGuideResult) guide = await guideClient.fetchGuideResult();
    else {
      const text = await guideClient.fetchGuideText();
      guide = text === null ? { ok: false, failure: { code: 'HOUSE_REMOTE_UNKNOWN' } } : { ok: true, text };
    }
  } catch (error) {
    guide = { ok: false, failure: houseReadFailure(error) };
  }
  if (!guide.ok) return { status: 'unknown', failure: guide.failure };
  const status = summaryDeclaration(guide.text);
  if (status === 'unknown') return { status };
  if (status === 'unsupported') return { status, guideText: guide.text };
  return {
    status,
    guideText: guide.text,
    read(windowHours) {
      // Invoke on the source object to retain its this-binding. Keep synchronous
      // throws distinct from rejected reads, as at the original foreground entries.
      return (summaryClient.fetchSummaryResult ? summaryClient.fetchSummaryResult(windowHours)
        : summaryClient.fetchSummary(windowHours).then((summary): WorldSummaryResult => summary
          ? { ok: true, summary } : { ok: false, failure: { code: 'HOUSE_REMOTE_UNKNOWN' } }))
        .catch((error): WorldSummaryResult => ({ ok: false, failure: houseReadFailure(error) }));
    },
  };
}
