import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingDiscovery, type DiscoveryDeps, type DiscoveryDrafts } from '../../../src/onboarding/discovery.js';
import { appendCorePrivate } from '../../../src/taste/taste-writer.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

vi.mock('../../../src/taste/taste-writer.js', () => ({ appendCorePrivate: vi.fn() }));

function setup() {
  let stored: DiscoveryDrafts = {};
  const effects: string[] = [];
  const ports: DiscoveryDeps = {
    presenter: { present: vi.fn(async () => { effects.push('present'); }) },
    llm: { complete: vi.fn(async () => { effects.push('rank'); return '{"order":[2,1]}'; }) },
    tasteRoot: '/unused-test-taste-root',
    guideClient: { fetchGuideText: vi.fn(async () => 'Guide paragraph') },
    summaryClient: { fetchSummary: vi.fn(async () => ({
      window_hours: 24, generated_at_ms: 0, total_posts: 2, distinct_authors: 2,
      authors: { alice: { nickname: 'Alice' }, bob: { nickname: 'Bob' } },
      hot_posts: ['alice', 'bob'].map((author, i) => ({
        event_id: `e${i}`, author, platform: 'popclaw', body_preview: `Preview ${i}`,
        reply_count: 0, quote_count: 0, created_at_ms: 0,
      })),
    })) },
    snapshotClient: { fetchSnapshot: vi.fn(async () => []) },
    tasteLoader: { enabledSources: vi.fn(async () => []) },
    learnedWriter: { appendPick: vi.fn(async () => { effects.push('learned'); }) },
    markService: { mark: vi.fn(async () => { effects.push('mark'); return { pushed: false }; }) },
    contextIndex: { register: vi.fn(() => { effects.push('index'); }) },
    webBaseUrl: 'https://web.test',
    houses: vi.fn(() => [{ slug: 'home', name: 'Home' }]),
    houseKnowsYou: vi.fn(() => false),
    nowSeconds: () => 123,
    drafts: vi.fn(() => { effects.push('read'); return JSON.parse(JSON.stringify(stored)) as DiscoveryDrafts; }),
    setDrafts: vi.fn((drafts) => { effects.push('write'); stored = JSON.parse(JSON.stringify(drafts)) as DiscoveryDrafts; }),
    recordDone: vi.fn(() => { effects.push('done'); }),
  };
  vi.mocked(appendCorePrivate).mockImplementation(async () => { effects.push('taste'); });
  const discovery = new OnboardingDiscovery(ports);
  const presentNext = vi.fn(async () => { effects.push('next'); return { text: 'Next card' }; });
  return { discovery, ports, effects, presentNext, persisted: () => stored };
}

beforeEach(() => { vi.resetAllMocks(); setOwnerLang('en', 'config'); });
afterEach(() => { setOwnerLang(undefined); });

describe('OnboardingDiscovery interface', () => {
  it('owns preparation and answers without a lifecycle or state-machine dependency', async () => {
    const h = setup();
    await h.discovery.presentLantern();
    expect(h.effects).toEqual(['index', 'done', 'write', 'present']);
    h.effects.length = 0;
    await h.discovery.answerLantern('1');
    await h.discovery.answerLantern('mark 2');
    await h.discovery.answerLantern('meh 1');
    expect(h.effects).toEqual(['read', 'learned', 'present', 'read', 'mark', 'done', 'read', 'learned']);
    const answer = await h.discovery.answerLantern('');
    expect(answer).toEqual({ attune: h.persisted().lantern });
    expect(h.persisted()).not.toHaveProperty('attune');
    if (!('attune' in answer)) throw new Error('expected continuation');
    h.ports.setDrafts(answer);
    h.effects.length = 0;
    await h.discovery.saveTaste('software', h.presentNext);
    expect(h.effects).toEqual(['taste', 'done', 'read', 'rank', 'index', 'present', 'next']);
    expect(h.ports.contextIndex.register).toHaveBeenLastCalledWith([
      expect.objectContaining({ eventId: 'e1', summaryLine: expect.stringContaining('was #2') }),
      expect.objectContaining({ eventId: 'e0', summaryLine: expect.stringContaining('was #1') }),
    ]);
    // No transition is performed here: the caller still owns the same persisted batch.
    expect(h.persisted()).toEqual(answer);
  });

  it('reads the authoritative attune batch only after the taste write succeeds', async () => {
    const h = setup();
    await h.discovery.presentLantern();
    const answer = await h.discovery.answerLantern('');
    if (!('attune' in answer)) throw new Error('expected continuation');
    h.ports.setDrafts(answer);
    vi.mocked(appendCorePrivate).mockImplementation(async () => {
      const entries = answer.attune.entries.slice(0, 1).map((e) => ({ ...e, bodyPreview: 'Changed while writing taste' }));
      h.ports.setDrafts({ attune: { entries } });
    });
    const reply = await h.discovery.saveTaste('software', h.presentNext);
    expect(reply.text).toContain('Changed while writing taste');
    expect(h.ports.llm!.complete).not.toHaveBeenCalled();
  });

  it('updates no session state or done ledger when taste persistence rejects', async () => {
    const h = setup();
    const before = h.discovery.currentCardText('attune');
    vi.mocked(appendCorePrivate).mockRejectedValueOnce(new Error('disk full'));
    await expect(h.discovery.saveTaste('software', h.presentNext)).rejects.toThrow('disk full');
    expect(h.effects).toEqual([]);
    expect(h.discovery.currentCardText('attune')).toBe(before);
    expect(h.ports.drafts).not.toHaveBeenCalled();
  });

  it('retains cached presentation and done before a failed draft write, without showing the card', async () => {
    const h = setup();
    vi.mocked(h.ports.setDrafts).mockImplementation(() => { h.effects.push('write'); throw new Error('DB full'); });
    await expect(h.discovery.presentLantern()).rejects.toThrow('DB full');
    expect(h.effects).toEqual(['index', 'done', 'write']);
    expect(h.discovery.currentCardText('lantern')).toContain('Preview 0');
    expect(h.ports.presenter.present).not.toHaveBeenCalled();
    expect(h.persisted()).toEqual({});
  });

  it('re-narrates both caches with zero calls through any dependency', async () => {
    const h = setup();
    await h.discovery.presentLantern();
    const answer = await h.discovery.answerLantern('');
    if (!('attune' in answer)) throw new Error('expected continuation');
    h.ports.setDrafts(answer);
    await h.discovery.saveTaste('software', h.presentNext);
    vi.clearAllMocks();
    h.effects.length = 0;
    expect(h.discovery.currentCardText('lantern')).toContain('Preview 0');
    expect(h.discovery.currentCardText('attune')).toContain('software');
    expect(h.discovery.tasteText()).toBe('software');
    expect(h.effects).toEqual([]);
    for (const port of [h.ports.presenter.present, h.ports.llm!.complete, h.ports.guideClient.fetchGuideText,
      h.ports.summaryClient.fetchSummary, h.ports.snapshotClient.fetchSnapshot, h.ports.tasteLoader.enabledSources,
      h.ports.learnedWriter.appendPick, h.ports.markService.mark, h.ports.contextIndex.register,
      h.ports.houses, h.ports.houseKnowsYou, h.ports.drafts, h.ports.setDrafts, h.ports.recordDone, appendCorePrivate, h.presentNext]) {
      expect(port).not.toHaveBeenCalled();
    }
  });

  it('never invokes the spine continuation when presentation fails', async () => {
    const h = setup();
    vi.mocked(h.ports.presenter.present).mockRejectedValueOnce(new Error('present failed'));
    await expect(h.discovery.saveTaste('software', h.presentNext)).rejects.toThrow('present failed');
    expect(h.presentNext).not.toHaveBeenCalled();
    expect(h.discovery.currentCardText('attune')).toContain('software');
  });

  it('reads current stamp facts after material fetch, never a constructor-time snapshot', async () => {
    const h = setup();
    let known = false;
    vi.mocked(h.ports.houseKnowsYou).mockImplementation(() => known);
    const fetch = h.ports.guideClient.fetchGuideText;
    vi.mocked(fetch).mockImplementation(async () => { known = true; return 'Guide paragraph'; });
    const reply = await h.discovery.presentLantern();
    expect(reply.text).toContain('has your namecard ✓');
    expect(h.ports.houseKnowsYou).toHaveBeenCalledWith('home');
  });
});
