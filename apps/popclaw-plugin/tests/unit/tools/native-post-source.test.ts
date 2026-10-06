import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { registerWriteTools } from '../../../src/tools/write-tools.js';
import { registerWorldTools } from '../../../src/tools/world-tools.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { _draftsForTest, peekDraftSnapshot } from '../../../src/tools/draft-store.js';
import { _observedPostIdsForTest, rememberObservedPostIds, resolvePostRefWithSource, type PostRefCache } from '../../../src/world/post-ref.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { verifyInboundEnvelope } from '../../../src/ingress/verify-envelope.js';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { WorldFeedCatalog } from '../../../src/ingress/world-feed-catalog.js';

const ID = 'abcdef1234' + 'a'.repeat(54), ROOT = 'b'.repeat(64);
const WEB = 'https://fixture.invalid';
function signer(byte: number) {
  const seed = new Uint8Array(32).fill(byte), key = nacl.sign.keyPair.fromSeed(seed);
  return new MasterKeySigner({seed, ...key, popclawId: bs58.encode(key.publicKey)});
}
const servers: Server[] = [];
beforeEach(() => {_draftsForTest.clear(); _observedPostIdsForTest.clear(); setOwnerLang('en', 'config');});
afterEach(async () => {
  _draftsForTest.clear(); _observedPostIdsForTest.clear(); setOwnerLang(undefined); vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => {server.closeAllConnections(); server.close(() => done());})));
});
async function fixture() {
  const owner = signer(21), author = await signer(22).popclawId();
  let active = true;
  let payload: unknown = {root_event_id: ROOT, nodes: [
    {event_id: ROOT, actor: {popclaw_id: author, nickname: 'Thread root', handle: ''}, body_text: 'Root text'},
    {event_id: ID, actor: {popclaw_id: author, nickname: 'Parent author', handle: 'parent'}, body_text: 'Exact parent text'},
  ], truncated: false};
  let status = 200;
  let redirect = false;
  const requests: Array<{url: string; method: string; headers: Record<string, unknown>}> = [];
  const server = createServer((req, res) => {
    requests.push({url: req.url!, method: req.method!, headers: req.headers});
    if (redirect) { res.writeHead(302, {Location: `${WEB}/post/${ID}`}); res.end(); return; }
    res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  // Real public-read method/audience/credential restrictions and actionFetch;
  // the lifecycle gate and configured HTTP peer are synthetic test fixtures.
  const houseRuntime = Object.assign(Object.create(HouseRuntime.prototype) as HouseRuntime, {
    opts: {fetch: globalThis.fetch},
    capturePublicReadTargets: () => plan.targets,
    publicReadGate: (input: string) => ({origin: input, signal: new AbortController().signal, isActive: () => active}),
  });
  const pushed: Array<{house: string | undefined; bytes: Uint8Array}> = [];
  const pushTo = async (house: string | undefined, bytes: Uint8Array) => {pushed.push({house, bytes}); return {status: 200};};
  const cache: Required<PostRefCache> = {findFullEventId: () => ({full: null, ambiguous: [] as string[]}),
    findByEventIdPrefix: () => ({item: null, ambiguous: [] as string[]})};
  const plan = {targets: [{slug: 'house-parent', origin}], egress: {push: (bytes: Uint8Array) => pushTo('house-parent', bytes), pushTo}};
  const runtime = async () => ({boot: {signer: owner, nickname: 'Owner', webBaseUrl: WEB},
    houseRuntime, worldFeedCache: cache,
    egress: {home: {slug: 'house-home'}, capturePlan: () => plan, push: (bytes: Uint8Array) => pushTo('house-home', bytes), pushTo},
    nameOf: () => '',
  });
  type Tool = {name: string; execute(id: string, p: unknown): Promise<{text: string}>};
  const tools = new Map<string, Tool>();
  const context = {agentId: 'main', sessionKey: 'agent:main:chat', sessionId: 'chat', senderIsOwner: true,
    requesterSenderId: 'synthetic-owner', assertInvocationCurrent: () => {if (!active) throw new Error('EXPIRED');}};
  const api = {registerTool: (definition: unknown) => {
    const descriptor = definition as {contextVersion?: number; create?: (ctx: unknown) => Tool};
    const t = typeof definition === 'function' ? definition(context) : descriptor.contextVersion === 2 ? descriptor.create!(context) : definition as Tool;
    tools.set(t.name, t);
  }};
  registerWriteTools({api, runtime, deps: {api, runtime}, total: 4} as unknown as ToolsCtx);
  const call = (name: string, params: unknown) => tools.get(name)!.execute('fixture-call', params);
  return {api, runtime, call, requests, pushed, cache, plan, author, origin, setPayload: (v: unknown) => {payload = v;}, setStatus: (n: number) => {status = n;}, redirect: () => {redirect = true;}, retire: () => {active = false;}};
}
const draftId = (r: {text: string}) => /draft_id: (\S+)/.exec(r.text)?.[1];

async function observedParent() {
  const author = signer(22), authorId = await author.popclawId();
  const body = ('Already read complete parent ' + 'long full body '.repeat(100)).trim();
  const env = {actor: {popclawId: authorId, nickname: 'Already read author'}, post: {blocks: [{content: body}]}};
  const canonical = canonicalizeEnvelope(env), eventId = cidFromCanonical(canonical);
  const envelope = popclaw.event.EventEnvelope.encode({...env, eventId, signature: await author.sign(canonical)}).finish();
  return {platform: 'popclaw', platformPostId: eventId, eventId, authorPopclawId: authorId,
    textPreview: 'Short preview', houseSlug: 'house-parent', envelope, body};
}

describe('native link to exact parent manuscript', () => {
  it('resolves a first-seen short URL and freezes exact parent context before one native confirmation', async () => {
    const f = await fixture();
    const preview = await f.call('popclaw_draft_post', {body: 'Reviewed reply', reply_to_event_id: `${WEB}/post/${ID.slice(0,10)}`});
    const token = draftId(preview); expect(token).toBeTruthy();
    expect(preview.text).toContain('Parent author'); expect(preview.text).toContain('Exact parent text');
    expect(preview.text).toContain('house-parent'); expect(preview.text).not.toContain('context is unavailable');
    expect(peekDraftSnapshot(token!)!.target).toBe(`reply:${ID}`);
    expect(f.requests).toHaveLength(1); expect(f.requests[0]!.url).toBe(`/v1/thread/${ID.slice(0,10)}?limit=1000`);
    expect(f.requests[0]!.method).toBe('GET');
    expect(f.requests[0]!.headers.authorization).toBeUndefined(); expect(f.requests[0]!.headers.cookie).toBeUndefined();
    expect(f.requests[0]!.headers['x-popclaw-inbox-token']).toBeUndefined();
    expect(f.pushed).toHaveLength(0);
    f.setPayload({root_event_id: ROOT, nodes: [{event_id: ROOT, actor: {popclaw_id: f.author, nickname: 'Changed'}, body_text: 'Changed'}]});
    f.plan.targets.splice(0); // later mounting must not redirect the captured manuscript
    await f.call('popclaw_send_draft', {draft_id: token});
    expect(f.pushed).toHaveLength(1); expect(f.pushed[0]!.house).toBe('house-parent');
    const signed = popclaw.identity.SignedPayload.decode(f.pushed[0]!.bytes);
    const sent = verifyInboundEnvelope(signed.payload);
    expect(sent.prevEventId).toBe(ID); expect(sent.prevEventId).not.toBe(ROOT);
    expect(f.requests).toHaveLength(1);
  });
  it('repairs the already-observed ID path when the local cache has no context', async () => {
    const f = await fixture(); rememberObservedPostIds([{platform: 'popclaw', platformPostId: ID}]);
    const preview = await f.call('popclaw_draft_post', {body: 'Reviewed reply', reply_to_event_id: ID.slice(0,10)});
    expect(preview.text).toContain('Parent author'); expect(preview.text).toContain('Exact parent text');
    expect(preview.text).toContain('house-parent'); expect(draftId(preview)).toBeTruthy();
    expect(f.pushed).toHaveLength(0);
  });
});


describe('public target lookup boundaries', () => {
  it.each([ID.slice(0,10), '#'+ID.slice(0,10)])('accepts visible short form %s without an internal ID', async ref => {
    const f = await fixture(); const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ref});
    expect(draftId(r)).toBeTruthy();
    expect(peekDraftSnapshot(draftId(r)!)!.target).toBe(`reply:${ID}`);
    expect(r.text).toContain('Exact parent text');
  });
  it('quotes the same accurate node and source without publishing', async () => {
    const f = await fixture(); const r = await f.call('popclaw_draft_post', {body: 'quote', quote_of_event_id: `${WEB}/post/${ID.slice(0,10)}`});
    expect(peekDraftSnapshot(draftId(r)!)!.target).toBe(`quote:${ID}`);
    expect(r.text).toContain('Parent author'); expect(f.pushed).toHaveLength(0);
  });
  it.each(['https://foreign.invalid/post/abcdef1234', 'https://fixture.invalid.evil/post/abcdef1234', '#abc', 'abcdZZZZZZ'])('never queries malformed or foreign reference %s', async ref => {
    const f = await fixture(); const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ref});
    expect(draftId(r)).toBeUndefined(); expect(f.requests).toEqual([]); expect(f.pushed).toEqual([]);
  });
  it.each([404, 503])('creates no draft for HTTP %s', async status => {
    const f = await fixture(); f.setStatus(status);
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: `${WEB}/post/${ID.slice(0,10)}`});
    expect(draftId(r)).toBeUndefined(); expect(f.pushed).toEqual([]);
    expect(r.text).not.toContain('64-hex');
  });
  it('refuses the existing API ambiguity response', async () => {
    const f = await fixture(); f.setStatus(400); f.setPayload({error: 'prefix ambiguous: abcdef1234...'});
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(r.text).toContain('more than one'); expect(draftId(r)).toBeUndefined();
  });
  it.each([
    {root_event_id: ID, nodes: []},
    {root_event_id: ID, nodes: [{event_id: ROOT, actor: {popclaw_id: 'author', nickname: 'Root', handle: ''}, body_text: 'root'}]},
    {root_event_id: ID, nodes: [{event_id: ID.slice(0,10), actor: {popclaw_id: 'author', nickname: 'Wrong', handle: ''}, body_text: 'short only'}]},
    {root_event_id: ID, nodes: [{event_id: ID, actor: {nickname: 'Missing ID', handle: ''}, body_text: 'invalid'}]},
    {root_event_id: ROOT, nodes: [], truncated: true},
  ])('never substitutes a thread root or an unverifiable node: %j', async payload => {
    const f = await fixture(); f.setPayload(payload);
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(draftId(r)).toBeUndefined(); expect(f.pushed).toEqual([]);
  });
  it('refuses a collision with the previously observed native ID', async () => {
    const f = await fixture(); rememberObservedPostIds([{platform: 'popclaw', platformPostId: ID.slice(0,10)+'c'.repeat(54)}]);
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(draftId(r)).toBeUndefined(); expect(f.pushed).toEqual([]);
  });
  it('does not follow a public peer redirect to the web link', async () => {
    const f = await fixture(); f.redirect();
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(draftId(r)).toBeUndefined(); expect(f.requests).toHaveLength(1);
  });
  it('refuses the existing public gate instead of opening an anonymous fallback', async () => {
    const f = await fixture(); f.retire();
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(draftId(r)).toBeUndefined(); expect(f.requests).toEqual([]);
  });
  it.each([
    {ref: ID, status: 404}, {ref: ID, status: 503},
    {ref: `${WEB}/post/${ID}`, status: 404}, {ref: `${WEB}/post/${ID}`, status: 503},
  ])('retains explicit full-ID legacy draft $ref for HTTP $status', async ({ref, status}) => {
    const f = await fixture(); f.setStatus(status);
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ref});
    expect(draftId(r)).toBeTruthy();
    expect(peekDraftSnapshot(draftId(r)!)!.target).toBe(`reply:${ID}`);
    expect(r.text).toContain('context is unavailable'); expect(f.pushed).toEqual([]);
  });
});


describe('source resolution across captured houses', () => {
  async function secondPeer(f: Awaited<ReturnType<typeof fixture>>, eventId: string, status = 200) {
    const server = createServer((_req, res) => {
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({nodes: [{event_id: eventId, actor: {popclaw_id: f.author, nickname: 'Second', handle: ''}, body_text: 'Second body'}]}));
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    f.plan.targets.push({slug: 'house-second', origin});
  }
  it('refuses different full IDs sharing a prefix across trusted peers', async () => {
    const f = await fixture(); await secondPeer(f, ID.slice(0,10)+'c'.repeat(54));
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(draftId(r)).toBeUndefined(); expect(f.pushed).toEqual([]);
  });
  it('cannot claim global uniqueness while another captured peer is unavailable', async () => {
    const f = await fixture(); await secondPeer(f, ID, 503);
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(draftId(r)).toBeUndefined(); expect(r.text).toContain('could not be checked');
  });
  it('uses a single matching peer when the other trusted peer reports absent', async () => {
    const f = await fixture(); await secondPeer(f, ID, 404);
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(peekDraftSnapshot(draftId(r)!)!.target).toBe(`reply:${ID}`);
    expect(r.text).toContain('house-parent'); expect(f.pushed).toEqual([]);
  });
  it('resolves a full trusted post URL with exact source context', async () => {
    const f = await fixture();
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: `${WEB}/post/${ID}`});
    expect(peekDraftSnapshot(draftId(r)!)!.target).toBe(`reply:${ID}`);
    expect(r.text).toContain('Parent author'); expect(r.text).toContain('house-parent');
  });
  it('refuses an unreadable local cache before public lookup', async () => {
    const f = await fixture(); vi.spyOn(f.cache, 'findFullEventId').mockImplementation(() => {throw new Error('UNREADABLE');});
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(draftId(r)).toBeUndefined(); expect(f.requests).toEqual([]);
  });
  it('keeps a complete cached parent snapshot without requesting any peer', async () => {
    const f = await fixture(); vi.spyOn(f.cache, 'findFullEventId').mockReturnValue({full: ID, ambiguous: []} as never);
    vi.spyOn(f.cache, 'findByEventIdPrefix').mockReturnValue({item: {eventId: ID, authorPopclawId: f.author,
      handle: 'Cached author', textPreview: 'Cached parent body', houseSlug: 'house-parent'}, ambiguous: []} as never);
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: ID.slice(0,10)});
    expect(r.text).toContain('Cached author'); expect(r.text).toContain('Cached parent body');
    expect(peekDraftSnapshot(draftId(r)!)!.target).toBe(`reply:${ID}`); expect(f.requests).toEqual([]);
  });
});


it('keeps the already-read trusted native parent context when a later query is unavailable', async () => {
  const f = await fixture();
  const observed = await observedParent();
  rememberObservedPostIds([observed]);
  f.setStatus(503);
  const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: `${WEB}/post/${observed.eventId.slice(0,10)}`});
  expect(draftId(r)).toBeTruthy();
  expect(peekDraftSnapshot(draftId(r)!)!.target).toBe(`reply:${observed.eventId}`);
  expect(r.text).toContain('Already read author'); expect(r.text).toContain('Already read complete parent');
  expect(r.text).toContain('house-parent'); expect(f.requests).toEqual([]); expect(f.pushed).toEqual([]);
});

it('carries a readonly catalog snapshot through author_latest into a full parent draft without another GET', async () => {
  const f = await fixture(), observed = await observedParent(), db = new InMemoryHostDb();
  try {
    const cache = new WorldFeedCache({db});
    await cache.start();
    const catalog = new WorldFeedCatalog([{slug: 'house-parent', baseUrl: f.origin, dbPath: ':memory:', cache, cacheReadOnly: true,
      snapshot: {fetchSnapshot: async () => [{...observed, houseSlug: 'remote-spoof'}]}}]);
    vi.spyOn(f.cache, 'findFullEventId').mockImplementation(prefix => catalog.findFullEventId(prefix));
    vi.spyOn(f.cache, 'findByEventIdPrefix').mockImplementation(prefix => catalog.findByEventIdPrefix(prefix) as never);
    const deps = {api: f.api, runtime: f.runtime, getWorldDeps: async () => ({webBaseUrl: WEB, snapshotClient: catalog,
      guideClient: {fetchGuideText: async () => null}, summaryClient: {fetchSummary: async () => null},
      resolveClient: {resolve: async () => [{popclawId: f.author, nickname: 'Already read author'}]}})};
    registerWorldTools({api: f.api, runtime: f.runtime, deps, total: 4} as unknown as ToolsCtx);
    const read = await f.call('popclaw_author_latest', {name: f.author, count: 3});
    expect(read.text).toContain(`${WEB}/post/${observed.eventId.slice(0,10)}`);
    expect(cache.recent(10)).toEqual([]);
    const source = await resolvePostRefWithSource(observed.eventId.slice(0,10), {cache: catalog, mountedHouseSlugs: ['house-parent']});
    expect(source).toMatchObject({ok: true, source: {textPreview: observed.body, houseSlug: 'house-parent', authorPopclawId: f.author}});
    f.setStatus(503);
    const preview = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: `${WEB}/post/${observed.eventId.slice(0,10)}`});
    expect(peekDraftSnapshot(draftId(preview)!)!.target).toBe(`reply:${observed.eventId}`);
    expect(preview.text).toContain('Already read author'); expect(preview.text).toContain('house-parent');
    expect(f.requests).toEqual([]); expect(f.pushed).toEqual([]);
  } finally {db.close();}
});

it.each(['mirror', 'no-envelope', 'wrong-id', 'wrong-author', 'bad-signature', 'no-house'])(
  'does not treat %s snapshot metadata as a complete trusted parent', async variant => {
    const f = await fixture(), observed = await observedParent();
    if (variant === 'mirror') observed.platform = 'x';
    if (variant === 'no-envelope') observed.envelope = new Uint8Array();
    if (variant === 'wrong-id') observed.eventId = ID;
    if (variant === 'wrong-author') observed.authorPopclawId = await signer(23).popclawId();
    if (variant === 'bad-signature') observed.envelope[observed.envelope.length - 1] = observed.envelope[observed.envelope.length - 1]! ^ 1;
    if (variant === 'no-house') observed.houseSlug = '';
    rememberObservedPostIds([observed]); f.setStatus(503);
    const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: observed.platformPostId.slice(0,10)});
    expect(draftId(r)).toBeUndefined(); expect(f.requests).toHaveLength(1); expect(f.pushed).toEqual([]);
  });

it('keeps the first trusted relay house and freezes source context through one confirmation', async () => {
  const f = await fixture(), observed = await observedParent();
  rememberObservedPostIds([observed]);
  rememberObservedPostIds([{...observed, houseSlug: 'house-second'}]);
  vi.spyOn(f.cache, 'findFullEventId').mockReturnValue({full: observed.eventId, ambiguous: []});
  vi.spyOn(f.cache, 'findByEventIdPrefix').mockReturnValue({item: {eventId: observed.eventId, authorPopclawId: f.author,
    handle: 'New display name', textPreview: 'Already read complete parent', houseSlug: 'house-second'}, ambiguous: []} as never);
  const preview = await f.call('popclaw_draft_post', {body: 'Reviewed reply', reply_to_event_id: observed.eventId.slice(0,10)});
  const token = draftId(preview)!; expect(token).toBeTruthy();
  expect(peekDraftSnapshot(token)!.house).toBe('house-parent');
  observed.houseSlug = 'mutated'; observed.envelope.fill(0);
  f.plan.targets.splice(0);
  await f.call('popclaw_send_draft', {draft_id: token});
  await f.call('popclaw_send_draft', {draft_id: token});
  expect(f.pushed).toHaveLength(1); expect(f.pushed[0]!.house).toBe('house-parent');
  const sent = verifyInboundEnvelope(popclaw.identity.SignedPayload.decode(f.pushed[0]!.bytes).payload);
  expect(sent.prevEventId).toBe(observed.eventId); expect(f.requests).toEqual([]);
});

it.each(['author', 'body'])('refuses a conflicting cached %s instead of replacing the observed parent', async variant => {
  const f = await fixture(), observed = await observedParent(); rememberObservedPostIds([observed]);
  vi.spyOn(f.cache, 'findFullEventId').mockReturnValue({full: observed.eventId, ambiguous: []});
  vi.spyOn(f.cache, 'findByEventIdPrefix').mockReturnValue({item: {eventId: observed.eventId,
    authorPopclawId: variant === 'author' ? 'different-author' : f.author, handle: 'Cached',
    textPreview: variant === 'body' ? 'Different body' : observed.body, houseSlug: 'house-parent'}, ambiguous: []} as never);
  const preview = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: observed.eventId.slice(0,10)});
  expect(draftId(preview)).toBeUndefined(); expect(f.requests).toEqual([]); expect(f.pushed).toEqual([]);
});

it('refuses an observed source removed from the current mounted houses', async () => {
  const f = await fixture(), observed = await observedParent(); rememberObservedPostIds([observed]);
  f.plan.targets.splice(0);
  const r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: observed.eventId.slice(0,10)});
  expect(draftId(r)).toBeUndefined(); expect(f.requests).toEqual([]); expect(f.pushed).toEqual([]);
});

it('still refuses unreadable cache and colliding IDs despite a complete observed source', async () => {
  const f = await fixture(), observed = await observedParent(); rememberObservedPostIds([observed]);
  vi.spyOn(f.cache, 'findFullEventId').mockImplementation(() => {throw new Error('UNREADABLE');});
  let r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: observed.eventId.slice(0,10)});
  expect(draftId(r)).toBeUndefined(); expect(f.requests).toEqual([]);
  vi.restoreAllMocks();
  rememberObservedPostIds([{platform: 'popclaw', platformPostId: observed.eventId.slice(0,10)+'c'.repeat(54)}]);
  f.setStatus(503);
  r = await f.call('popclaw_draft_post', {body: 'reply', reply_to_event_id: observed.eventId.slice(0,10)});
  expect(draftId(r)).toBeUndefined(); expect(f.pushed).toEqual([]);
});
