import { assertReadCallActive, waitForRead, withReadCallBudget } from '../runtime/read-call-budget.js';
import { freshnessText } from '../world/read-freshness.js';
/** A frozen editorial reference, not signed article material or authority. */
import { prepareDeclaredSummaryRead, type SummaryGuideReader } from '../world/declared-summary-read.js';
import { renderWorldSummary } from '../world/summary-snapshot-format.js';
import type { WorldSummaryResponse, WorldSummaryResult } from '../world/world-summary-client.js';
import type { ReadRequestScope } from '../runtime/read-request-scope.js';
import type { NameChain } from '../identity/person-name.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export interface WorldSummaryMaterial {
  readonly origin: string;
  readonly snapshotId: string;
  readonly cutoffAtMs: number;
  readonly generatedAtMs: number;
  readonly text: string;
}
export interface NewspaperSummarySource {
  readonly origin: string;
  readonly guideClient: SummaryGuideReader;
  readonly summaryClient: {
    captureReadGeneration?(): ReadRequestScope | undefined;
    fetchSummary(windowHours?: number): Promise<WorldSummaryResponse | null>;
    fetchSummaryResult?(windowHours?: number): Promise<WorldSummaryResult>;
  };
}

/** Only initial collection calls this. Continuations consume the stored issue.
 * The injected clients keep their existing House read lane and currentness checks.
 * An unavailable reference does not prevent editing the collected signed articles. */
export async function prepareSummaryMaterial(input: NewspaperSummarySource & {
  readonly nameOf?: NameChain; readonly lang?: Lang;
}): Promise<WorldSummaryMaterial | undefined> {
  try {
    return await withReadCallBudget({timeoutMs:1500},async () => {
    const generation = input.summaryClient.captureReadGeneration?.();
    const current = () => !generation || generation.isCurrent();
    if (!current()) return undefined;
    const prepared = await waitForRead(prepareDeclaredSummaryRead(input.guideClient, input.summaryClient));
    if (!current() || prepared.status !== 'supported') return undefined;
    const result = await waitForRead(prepared.read());
    if (!current() || !result.ok || !result.summary.snapshot) return undefined;
    const snapshot = result.summary.snapshot;
    const lang=input.lang ?? ownerLang();
    const text = [freshnessText('freshness' in result ? result.freshness : undefined,lang),renderWorldSummary(result.summary,{lang,nameOf:input.nameOf})].filter(Boolean).join('\n\n');
    assertReadCallActive();
    if (!current()) return undefined;
    return {origin:input.origin,snapshotId:snapshot.snapshot_id,cutoffAtMs:snapshot.cutoff_at_ms,
      generatedAtMs:snapshot.generated_at_ms,text};
    });
  } catch { return undefined; }
}

/** Snapshot ranking numbers are not article selection numbers. */
export function summaryMaterialText(material: WorldSummaryMaterial | undefined, lang = ownerLang()): string {
  if (!material) return '';
  return renderCopy(lang,'world.snapshot.newspaperHeading') + '\n' +
    renderCopy(lang,'world.snapshot.newspaperSource',{origin:material.origin,snapshotId:material.snapshotId}) + '\n' + material.text;
}
