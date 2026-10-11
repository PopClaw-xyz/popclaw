import { withOutcomes } from '../../helpers/with-outcomes.js';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerWorldTools } from '../../../src/tools/world-tools.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import { WorldSummaryClient, type WorldSummaryResponse } from '../../../src/world/world-summary-client.js';
import { _observedPostIdsForTest, rememberObservedPostIds, resolvePostRef } from '../../../src/world/post-ref.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { _observedPeopleForTest } from '../../../src/identity/observed-people.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { setOwnerTz } from '../../../src/time/time-context.js';

function fixture() {
  return JSON.parse(readFileSync(new URL('../../fixtures/world-summary-snapshot.json', import.meta.url), 'utf8'));
}
function response(snapshot = fixture()): WorldSummaryResponse {
  return { window_hours: 24, generated_at_ms: snapshot.generated_at_ms, total_posts: 1, distinct_authors: 2, authors: {}, hot_posts: [], snapshot } as WorldSummaryResponse;
}
function setup(body = response(), cache?: unknown) {
  const fetchSummary = vi.fn(async () => body);
  const fetchSnapshot = vi.fn(async (_q: { limit?: number; author?: string }) => []);
  const resolve = vi.fn(async () => []);
  const declareFollow = vi.fn(async (_id: string) => undefined);
  const tools: Array<{ name: string; execute: (id: string, p: unknown) => Promise<{text: string}> }> = [];
  const runtime = async () => ({ nameOf: (_id: string, name?: string) => name === 'River' ? 'My River' : name, worldFeedCache: cache, boot: {loreHouseUrls:[]}, socialGraph: withOutcomes({ following: () => [], declareFollow }) });
  registerWorldTools({ api: { registerTool: (t: unknown) => tools.push(t as typeof tools[number]) }, runtime, deps: { runtime, getWorldDeps: async () => ({ guideClient: {fetchGuideText: async () => '---\nstreams:\n  - name: summary\n    endpoint: /v1/world-summary\n---'}, summaryClient: { fetchSummary }, snapshotClient: { fetchSnapshot }, resolveClient: { resolve }, webBaseUrl: 'https://popclaw.me' }) } } as unknown as ToolsCtx);
  return { tool: tools.find(t => t.name === 'popclaw_world_summary')!, tools, fetchSummary, fetchSnapshot, resolve, declareFollow };
}
beforeEach(() => { setOwnerLang('en', 'config'); setOwnerTz('Asia/Shanghai'); _observedPostIdsForTest.clear(); _observedPeopleForTest.clear(); });

describe('complete on-demand summary', () => {
  it('does one summary read without a feed scan and shows public identity facts inline', async () => {
    const { tool, fetchSummary, fetchSnapshot } = setup();
    expect(fetchSummary).not.toHaveBeenCalled();
    const { text } = await tool.execute('x', {});
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(text).toContain('My River');
    expect(text).toContain('River');
    expect(text).toContain('#' + fixture().people['11111111111111111111111111111111'].sigil);
    expect(text).toContain('Builds tools for public conversation.');
    expect(text).toContain('pioneer');
    expect(text).toContain('X @river');
    expect(text).toContain('1200');
    expect(text).toContain('YT @river-video');
    expect(text).toContain('unknown');
    expect(text).toContain('2026-10-11 21:20');
    expect(text).toContain('Asia/Shanghai');
    expect(text).toContain('Sky#' + fixture().people['22222222222222222222222222222222222222222222'].sigil);
    expect(text).toContain('Let us compare the results.');
    expect(text).toContain('bbbbbbbbbb');
    expect(text.indexOf('7d')).toBeLessThan(text.indexOf('24h'));
    expect(text).toContain('2026-10-10 22:20');
    expect(text).not.toContain('well-known');
  });

  it('shows all ten entries in every list, whole Unicode previews and reply relationships', async () => {
    const s = fixture();
    const person = Object.values(s.people)[0];
    const content = s.contents['a'.repeat(64)];
    s.popular_replies = [];
    for (let i = 0; i < 10; i++) {
      const id = (i + 1).toString(16).padStart(64, '0');
      const personId = `person-${i}`;
      s.people[personId] = { ...person as object, popclaw_id: personId, nickname: `Person ${i}`, sigil: deriveSigil(personId) };
      s.contents[id] = { ...content, event_id: id, author_id: personId, root_event_id: id, latest_reply_id: null, body_preview: '🌊'.repeat(199) + '末' };
      const replyId = (i + 50).toString(16).padStart(64, '0');
      s.contents[replyId] = { ...content, event_id: replyId, kind: 'reply', author_id: personId, parent_event_id: id, root_event_id: id, latest_reply_id: null, reply_count_total: 42, reply_count_7d: 7, reply_count_24h: 3, reply_count_8h: 1 };
      s.popular_replies.push({ event_id: replyId, new_replies: 7 });
      for (const w of s.windows) {
        if (i === 0) { w.people_growth = []; w.top_posts = []; }
        w.people_growth.push({ person_id: personId, net_followers: i + 1 });
        w.top_posts.push({ event_id: id, new_replies: i + 1 });
      }
    }
    const { text } = await setup(response(s)).tool.execute('x', {});
    expect(text.match(/10\. /g)?.length).toBe(7);
    expect(text).toContain('🌊'.repeat(199) + '末');
    expect(text).toContain('42');
    expect(text).toContain('parent');
    expect(text).toContain('root');
  });

  it('distinguishes an unobserved first baseline from zero growth and keeps empty rankings honest', async () => {
    const s = fixture();
    for (const w of s.windows) { w.follow_coverage_start_ms = null; w.public_follow_net = null; w.people_growth = []; w.top_posts = []; }
    const { text } = await setup(response(s)).tool.execute('x', {});
    expect(text).toContain('not yet observed');
    expect(text).toContain('No qualifying');
    expect(text).not.toContain('net 0');
  });

  it('prints full IDs once a cache is unreadable without repeatedly probing it', async () => {
    const findFullEventId = vi.fn(() => { throw Error('closed'); });
    const { text } = await setup(response(), { findFullEventId }).tool.execute('x', {});
    expect(text).toContain('a'.repeat(64));
    expect(text).toContain('b'.repeat(64));
    expect(findFullEventId).toHaveBeenCalledTimes(2);
  });

  it('extends known collisions and remembers canonical relayed IDs without trusting external IDs', async () => {
    const s = fixture();
    const canonical = 'a'.repeat(64);
    const collision = 'a'.repeat(10) + 'b'.repeat(54);
    s.contents[canonical].authorship = 'relayed';
    s.contents[canonical].platform = 'x';
    rememberObservedPostIds([{ platform: 'popclaw', platformPostId: collision }, { platform: 'x', platformPostId: 'c'.repeat(64) }]);
    const cache = { findFullEventId: vi.fn(() => ({ full: null, ambiguous: [] })) };
    const { text } = await setup(response(s), cache).tool.execute('x', {});
    expect(text).toContain('aaaaaaaaaaa');
    expect(resolvePostRef('aaaaaaaaaaa', { cache })).toEqual({ ok: true, eventId: canonical });
    expect(resolvePostRef('aaaaaaaaaa', { cache }).ok).toBe(false);
    expect(resolvePostRef('cccccccccc', { cache }).ok).toBe(false);
    expect(resolvePostRef('aaaaaaaaaaa', { cache: { findFullEventId: () => { throw Error('unreadable'); } } }).ok).toBe(false);
    expect(resolvePostRef('bbbbbbbbbb', { cache }).ok).toBe(true);
  });
});

describe('snapshot validation', () => {
  it('accepts the shared cross-language fixture', async () => {
    const client = new WorldSummaryClient({ baseUrl: 'https://test', fetch: async () => new Response(JSON.stringify(response())) });
    expect(await client.fetchSummary()).toEqual(response());
  });
  it.each(['missing person', 'missing content', 'missing latest reply', 'negative count', 'missing window', 'overlong preview', 'wrong sigil', 'reply cycle', 'missing parent', 'unknown version'])('refuses %s', async (fault) => {
    const s = fixture();
    if (fault === 'wrong sigil') s.people['11111111111111111111111111111111'].sigil = 'wrong';
    if (fault === 'reply cycle') s.contents['b'.repeat(64)].parent_event_id = 'b'.repeat(64);
    if (fault === 'missing parent') s.contents['b'.repeat(64)].parent_event_id = 'c'.repeat(64);
    if (fault === 'unknown version') s.version = 9;
    if (fault === 'missing person') s.people = {};
    if (fault === 'missing content') s.contents = {};
    if (fault === 'missing latest reply') delete s.contents['b'.repeat(64)];
    if (fault === 'negative count') s.totals.posts = -1;
    if (fault === 'missing window') s.windows.pop();
    if (fault === 'overlong preview') s.contents['a'.repeat(64)].body_preview = '🌊'.repeat(201);
    const client = new WorldSummaryClient({ baseUrl: 'https://test', fetch: async () => new Response(JSON.stringify(response(s))) });
    expect(await client.fetchSummary()).toBeNull();
  });
});


describe('canonical cached references', () => {
  it('refuses a summary prefix colliding with a relayed canonical cache ID', () => {
    const known = 'd'.repeat(64);
    rememberObservedPostIds([{ platform: 'popclaw', platformPostId: known }]);
    const cache = {
      findFullEventId: () => ({ full: null, ambiguous: [] }),
      findByEventIdPrefix: () => ({ item: { eventId: 'd'.repeat(10) + 'e'.repeat(54), authorPopclawId:'synthetic',handle:'Synthetic',textPreview:'A canonical cache collision' }, ambiguous: [] }),
    };
    expect(resolvePostRef('dddddddddd', { cache }).ok).toBe(false);
    expect(resolvePostRef('dddddddddd', { cache: { ...cache, findByEventIdPrefix: () => { throw Error('unreadable'); } } }).ok).toBe(false);
  });
});


describe('people shown by a summary remain addressable', () => {
  it('can follow and read an actor with no cached posts or house namecard using the shown name and sigil', async () => {
    const { tool, tools, fetchSummary, fetchSnapshot, resolve, declareFollow } = setup();
    await tool.execute('summary', {});
    expect(declareFollow).not.toHaveBeenCalled();
    const id = '22222222222222222222222222222222222222222222';
    const name = `Sky#${deriveSigil(id)}`;
    await tools.find(t => t.name === 'popclaw_follow')!.execute('follow', { name });
    expect(declareFollow).toHaveBeenCalledWith(id);
    expect(resolve).not.toHaveBeenCalled();
    fetchSummary.mockResolvedValue({ window_hours: 24, generated_at_ms: 0, total_posts: 0, distinct_authors: 0, authors: {}, hot_posts: [] });
    await tools.find(t => t.name === 'popclaw_author_latest')!.execute('read', { name });
    expect(fetchSnapshot).toHaveBeenLastCalledWith({ author: id, limit: 1 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not choose another person when a shown alias matches their public name', async () => {
    const s = fixture();
    s.people['22222222222222222222222222222222222222222222'].nickname = 'My River';
    const { tool, tools, fetchSnapshot } = setup(response(s));
    await tool.execute('summary', {});
    const { text } = await tools.find(t => t.name === 'popclaw_author_latest')!.execute('read', { name: 'My River' });
    expect(fetchSnapshot.mock.calls.every(([query]) => query.author === undefined)).toBe(true);
    expect(text).toContain(deriveSigil('11111111111111111111111111111111'));
    expect(text).toContain(deriveSigil('22222222222222222222222222222222222222222222'));
  });

  it('keeps same-name people ambiguous across observed summaries', async () => {
    const one = fixture();
    one.people['11111111111111111111111111111111'].nickname = 'Same Name';
    one.people['22222222222222222222222222222222222222222222'].nickname = 'Same Name';
    const { tool, tools, declareFollow } = setup(response(one));
    await tool.execute('summary', {});
    const { text } = await tools.find(t => t.name === 'popclaw_follow')!.execute('follow', { name: 'Same Name' });
    expect(declareFollow).not.toHaveBeenCalled();
    expect(text).toContain(deriveSigil('11111111111111111111111111111111'));
    expect(text).toContain(deriveSigil('22222222222222222222222222222222222222222222'));
  });
});
