import { describe, expect, it, vi } from 'vitest';
import { prepareDeclaredSummaryRead, type SummaryGuideReader, type SummaryReader } from '../../../src/world/declared-summary-read.js';
import { ActionInactiveError } from '../../../src/runtime/house-lifecycle/action-context.js';
import { RemoteHouseReadError, type HouseReadFailure } from '../../../src/runtime/house-lifecycle/read-failure.js';
import { invalidSummaryDeclarations } from '../../helpers/summary-declaration-cases.js';
import type { WorldSummaryResponse } from '../../../src/world/world-summary-client.js';

const declaredGuide = '---\nstreams:\n  - name: summary\n    endpoint: /v1/world-summary\n---\nHouse guide';
const summary: WorldSummaryResponse = { window_hours: 24, generated_at_ms: 0, total_posts: 0,
  distinct_authors: 0, authors: {}, hot_posts: [] };
const origin = 'https://summary-read.invalid';
const unknownFailure = { ok: false, failure: { code: 'HOUSE_REMOTE_UNKNOWN' } };

function readers() {
  return {
    guide: { fetchGuideText: vi.fn(async () => declaredGuide as string | null) },
    summary: { fetchSummary: vi.fn(async (_hours?: number) => summary as WorldSummaryResponse | null) },
  };
}

describe('declared primary-House summary read', () => {
  it('prepares without summary I/O, retains guide text, and performs a fresh read for each window', async () => {
    const clients = readers();
    const prepared = await prepareDeclaredSummaryRead(clients.guide, clients.summary);
    expect(prepared.status).toBe('supported');
    expect(clients.summary.fetchSummary).not.toHaveBeenCalled();
    if (prepared.status !== 'supported') throw new Error('Expected declared read');
    expect(prepared.guideText).toBe(declaredGuide);
    expect(await prepared.read(1)).toEqual({ ok: true, summary });
    expect(await prepared.read(48)).toEqual({ ok: true, summary });
    expect(clients.summary.fetchSummary.mock.calls).toEqual([[1], [48]]);
    expect(clients.guide.fetchGuideText).toHaveBeenCalledOnce();
  });

  it('prefers typed clients and retains their this-binding and result identity', async () => {
    const guide: SummaryGuideReader = {
      fetchGuideText: vi.fn(async () => null),
      async fetchGuideResult() { expect(this).toBe(guide); return { ok: true, text: declaredGuide }; },
    };
    const result = { ok: true as const, summary };
    const reader: SummaryReader = {
      fetchSummary: vi.fn(async () => null),
      async fetchSummaryResult(hours) { expect(this).toBe(reader); expect(hours).toBe(12); return result; },
    };
    const prepared = await prepareDeclaredSummaryRead(guide, reader);
    if (prepared.status !== 'supported') throw new Error('Expected declared read');
    expect(await prepared.read(12)).toBe(result);
    expect(guide.fetchGuideText).not.toHaveBeenCalled();
    expect(reader.fetchSummary).not.toHaveBeenCalled();
  });

  it('retains this-binding for nullable clients too', async () => {
    const guide: SummaryGuideReader = { async fetchGuideText() { expect(this).toBe(guide); return declaredGuide; } };
    const reader: SummaryReader = { async fetchSummary() { expect(this).toBe(reader); return summary; } };
    const prepared = await prepareDeclaredSummaryRead(guide, reader);
    if (prepared.status !== 'supported') throw new Error('Expected declared read');
    expect(await prepared.read()).toEqual({ ok: true, summary });
  });

  it('an undeclared summary returns its guide without exposing a read operation', async () => {
    const clients = readers();
    clients.guide.fetchGuideText.mockResolvedValue('A House without summary');
    const prepared = await prepareDeclaredSummaryRead(clients.guide, clients.summary);
    expect(prepared).toEqual({ status: 'unsupported', guideText: 'A House without summary' });
    expect(prepared).not.toHaveProperty('read');
    expect(clients.summary.fetchSummary).not.toHaveBeenCalled();
  });

  it.each(invalidSummaryDeclarations)('malformed %s exposes no read and no invented failure reason', async (_name, guide) => {
    const clients = readers();
    clients.guide.fetchGuideText.mockResolvedValue(guide);
    const prepared = await prepareDeclaredSummaryRead(clients.guide, clients.summary);
    expect(prepared).toEqual({ status: 'unknown' });
    expect(prepared).not.toHaveProperty('read');
    expect(clients.summary.fetchSummary).not.toHaveBeenCalled();
  });

  it('a nullable guide failure is unknown, distinct from unsupported', async () => {
    const clients = readers();
    clients.guide.fetchGuideText.mockResolvedValue(null);
    expect(await prepareDeclaredSummaryRead(clients.guide, clients.summary))
      .toEqual({ status: 'unknown', failure: unknownFailure.failure });
    expect(clients.summary.fetchSummary).not.toHaveBeenCalled();
  });

  it('preserves typed guide failure facts without invoking the nullable facade', async () => {
    const clients = readers();
    const failure: HouseReadFailure = { code: 'HOUSE_REMOTE_HTTP', origin, status: 503 };
    const guide: SummaryGuideReader = { ...clients.guide, fetchGuideResult: async () => ({ ok: false, failure }) };
    const prepared = await prepareDeclaredSummaryRead(guide, clients.summary);
    expect(prepared).toEqual({ status: 'unknown', failure });
    if (prepared.status !== 'unknown') throw new Error('Expected unknown');
    expect(prepared.failure).toBe(failure);
    expect(clients.guide.fetchGuideText).not.toHaveBeenCalled();
    expect(clients.summary.fetchSummary).not.toHaveBeenCalled();
  });

  it.each([false, true])('classifies a guide local refusal, including synchronous=%s', async synchronous => {
    const clients = readers();
    const error = new ActionInactiveError('HOUSE_TRUST_REVOKED', origin);
    clients.guide.fetchGuideText.mockImplementation(() => { if (synchronous) throw error; return Promise.reject(error); });
    expect(await prepareDeclaredSummaryRead(clients.guide, clients.summary))
      .toEqual({ status: 'unknown', failure: { code: 'HOUSE_TRUST_REVOKED', origin } });
    expect(clients.summary.fetchSummary).not.toHaveBeenCalled();
  });

  it('does not convert a nullable summary failure into empty success', async () => {
    const clients = readers();
    clients.summary.fetchSummary.mockResolvedValue(null);
    const prepared = await prepareDeclaredSummaryRead(clients.guide, clients.summary);
    if (prepared.status !== 'supported') throw new Error('Expected declared read');
    expect(await prepared.read()).toEqual(unknownFailure);
  });

  it('retains typed summary failure facts without invoking the nullable facade', async () => {
    const clients = readers();
    const failure: HouseReadFailure = { code: 'HOUSE_REMOTE_PARSE', origin };
    const result = { ok: false as const, failure };
    const reader: SummaryReader = { ...clients.summary, fetchSummaryResult: async () => result };
    const prepared = await prepareDeclaredSummaryRead(clients.guide, reader);
    if (prepared.status !== 'supported') throw new Error('Expected declared read');
    expect(await prepared.read()).toBe(result);
    expect(clients.summary.fetchSummary).not.toHaveBeenCalled();
  });

  it.each(['nullable', 'typed'] as const)('normalizes rejected %s reads while preserving local and remote classifications', async mode => {
    const clients = readers();
    const errors = [new ActionInactiveError('HOUSE_TRUST_REVOKED', origin),
      new RemoteHouseReadError({ code: 'HOUSE_REMOTE_HTTP', origin, status: 429 }), new TypeError('private diagnostic')];
    const read = vi.fn((_hours?: number): Promise<never> => Promise.reject(new Error('Expected configured rejection')));
    // Both read contracts reject the same errors; no transport text is exposed.
    const reader: SummaryReader = mode === 'typed' ? { ...clients.summary, fetchSummaryResult: read }
      : { fetchSummary: read };
    const prepared = await prepareDeclaredSummaryRead(clients.guide, reader);
    if (prepared.status !== 'supported') throw new Error('Expected declared read');
    const failures: HouseReadFailure[] = [{ code: 'HOUSE_TRUST_REVOKED', origin },
      { code: 'HOUSE_REMOTE_HTTP', origin, status: 429 }, { code: 'HOUSE_REMOTE_NETWORK', origin: undefined }];
    for (let i = 0; i < errors.length; i++) {
      read.mockRejectedValueOnce(errors[i]);
      expect(await prepared.read()).toEqual({ ok: false, failure: failures[i] });
    }
  });

  it.each(['nullable', 'typed'] as const)('preserves synchronous %s summary throws', async mode => {
    const clients = readers();
    const read = () => { throw new Error('synchronous summary failure'); };
    const reader: SummaryReader = mode === 'typed' ? { ...clients.summary, fetchSummaryResult: read }
      : { fetchSummary: read };
    const prepared = await prepareDeclaredSummaryRead(clients.guide, reader);
    if (prepared.status !== 'supported') throw new Error('Expected declared read');
    expect(() => prepared.read()).toThrow('synchronous summary failure');
  });
});
