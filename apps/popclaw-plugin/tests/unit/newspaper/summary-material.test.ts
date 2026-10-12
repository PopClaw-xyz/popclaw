import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareSummaryMaterial } from '../../../src/newspaper/summary-material.js';
import type { GuideTextResult } from '../../../src/world/guide-client.js';
import type { WorldSummaryResponse, WorldSummaryResult } from '../../../src/world/world-summary-client.js';

const origin = 'https://summary-material.invalid';
const guide = '---\nstreams:\n  - name: summary\n    endpoint: /v1/world-summary\n---\nHouse guide';
const snapshot = JSON.parse(readFileSync(new URL('../../fixtures/world-summary-snapshot.json', import.meta.url), 'utf8'));
const summary: WorldSummaryResponse = { window_hours: 24, generated_at_ms: snapshot.generated_at_ms,
  total_posts: 1, distinct_authors: 2, authors: {}, hot_posts: [], snapshot };
function fixture() {
  const fetchGuideText = vi.fn(async () => null as string | null);
  const fetchGuideResult = vi.fn(async (): Promise<GuideTextResult> => ({ ok: true, text: guide }));
  const fetchSummary = vi.fn(async () => null as WorldSummaryResponse | null);
  const fetchSummaryResult = vi.fn(async (): Promise<WorldSummaryResult> => ({ ok: true, summary,
    freshness: { status: 'refresh_failed', origin, fetchedAtMs: 1000, checkedAtMs: 2000, attemptedAtMs: 3000 } }));
  return { origin, lang: 'en' as const, guideClient: { fetchGuideText, fetchGuideResult },
    summaryClient: { fetchSummary, fetchSummaryResult } };
}
afterEach(() => vi.useRealTimers());

describe('declared summary operation within the optional newspaper read', () => {
  it('uses typed guide facts and preserves cached-read timestamps beside the frozen snapshot', async () => {
    const f = fixture();
    const material = await prepareSummaryMaterial(f);
    expect(material).toMatchObject({ origin, snapshotId: snapshot.snapshot_id,
      cutoffAtMs: snapshot.cutoff_at_ms, generatedAtMs: snapshot.generated_at_ms });
    expect(material?.text).toContain('fetched: 1970-01-01T00:00:01.000Z');
    expect(material?.text).toContain('checked: 1970-01-01T00:00:02.000Z');
    expect(material?.text).toContain('last attempt: 1970-01-01T00:00:03.000Z');
    expect(f.guideClient.fetchGuideResult).toHaveBeenCalledOnce();
    expect(f.guideClient.fetchGuideText).not.toHaveBeenCalled();
    expect(f.summaryClient.fetchSummaryResult).toHaveBeenCalledOnce();
    expect(f.summaryClient.fetchSummary).not.toHaveBeenCalled();
  });

  it('rejects a captured generation revoked while the typed guide is being read', async () => {
    const f = fixture();
    let current = true;
    f.guideClient.fetchGuideResult.mockImplementation(async () => { current = false; return { ok: true, text: guide }; });
    const input = { ...f, summaryClient: { ...f.summaryClient,
      captureReadGeneration: () => ({ token: {}, isCurrent: () => current }) } };
    expect(await prepareSummaryMaterial(input)).toBeUndefined();
    expect(f.guideClient.fetchGuideResult).toHaveBeenCalledOnce();
    expect(f.summaryClient.fetchSummaryResult).not.toHaveBeenCalled();
  });

  it('ends a hanging declared-guide read at 1.5 seconds and never starts a late summary', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (result: GuideTextResult) => void;
    f.guideClient.fetchGuideResult.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = prepareSummaryMaterial(f);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBeUndefined();
    expect(f.guideClient.fetchGuideResult).toHaveBeenCalledOnce();
    release({ ok: true, text: guide });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.summaryClient.fetchSummaryResult).not.toHaveBeenCalled();
  });
});
