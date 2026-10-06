import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { registerWriteTools } from '../../../src/tools/write-tools.js';
import { _draftsForTest, peekDraftSnapshot, putDraft, DRAFT_TTL_MS } from '../../../src/tools/draft-store.js';
import { ownerApprovalBeforeToolCall, resetOwnerApprovals, setOwnerApprovalSurface } from '../../../src/host/owner-approval.js';
import { makeToolCollector } from '../../../src/tools/mcp-adapter.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftReviewFiles } from '../../../src/host/draft-review-files.js';
import { withDraftReview } from '../../../src/tools/draft-review.js';
import { socialToolFactory } from '../../../src/host/social-send-context.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { popclaw } from '@popclaw/contracts';

function key(byte: number) {
  const seed = new Uint8Array(32).fill(byte), kp = nacl.sign.keyPair.fromSeed(seed);
  const id = bs58.encode(kp.publicKey);
  return { id, signer: new MasterKeySigner({seed, ...kp, popclawId: id}) };
}
type Tool = {name: string; execute(id: string, params: unknown, signal?: AbortSignal): Promise<{text: string}>};
function turn(overrides: Record<string, unknown> = {}) {
  let active = true;
  return {agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'session-a',
    senderIsOwner: true, requesterSenderId: 'owner',
    assertInvocationCurrent: vi.fn(() => { if (!active) throw new Error('HOST_REVOKED'); }),
    retire: () => { active = false; }, ...overrides};
}
function fixture(mode: 'native' | 'local-stdio' = 'native') {
  const owner = key(3), recipient = key(5), pushed: Uint8Array[] = [];
  const push = vi.fn(async (bytes: Uint8Array) => {pushed.push(bytes); return {status: 200};});
  const runtime = async () => ({
    boot: {signer: owner.signer, nickname: 'Owner', popclawId: owner.id, webBaseUrl: 'https://fixture.invalid'},
    egress: {home: {slug: 'home'}, push, pushTo: async (_h: unknown, bytes: Uint8Array) => push(bytes)},
    bondsStore: {list: () => [{popclawId: recipient.id, nickname: 'Alice', remarkName: ''}]},
    knownFollowers: {allFollowerIds: () => [recipient.id]},
    inboxStore: {get: () => ({fromPopclawId: recipient.id, eventId: 'cd'.repeat(32), houseSlug: 'home', body: 'Original incoming message'})},
    worldFeedCache: {lookup: () => ({handle: 'alice', authorPopclawId: recipient.id, houseSlug: 'home', textPreview: 'source'}),
      findFullEventId: () => ({ambiguous: []}), findByEventIdPrefix: () => ({item: null})},
  });
  const registrations = new Map<string, unknown>();
  const api = {registerTool: (definition: unknown, opts?: unknown) => {
    const name = (opts as {name?: string})?.name ?? (definition as Tool).name;
    registrations.set(name, definition);
  }};
  registerWriteTools({api, runtime, deps: {api, runtime, socialSendHost: mode}, total: 4} as unknown as ToolsCtx);
  const call = (name: string, params: unknown, ctx: unknown = turn(), signal?: AbortSignal) => {
    const registered = registrations.get(name);
    const descriptor = registered as {contextVersion?: number; create?: (ctx: unknown) => unknown};
    const tool = (typeof registered === 'function' ? registered(ctx)
      : descriptor.contextVersion === 2 ? descriptor.create!(ctx) : registered) as Tool;
    return tool.execute('call', params, signal);
  };
  return {call, pushed, push, owner, recipient, runtime, registrations};
}
const tokenOf = (r: {text: string}) => /draft_id: (\S+)/.exec(r.text)![1]!;
beforeEach(() => {_draftsForTest.clear(); resetOwnerApprovals(); setOwnerLang('en', 'config');});
afterEach(() => {_draftsForTest.clear(); resetOwnerApprovals(); setOwnerLang(undefined); vi.restoreAllMocks();});

describe('ordinary social sends under the current host invocation', () => {
  it('sends on a later owner turn without a second native approval', async () => {
    const fx = fixture(), drafting = turn();
    const id = tokenOf(await fx.call('popclaw_draft_message', {recipient: 'Alice', body: 'Owner reviewed this'}, drafting));
    expect(fx.pushed).toHaveLength(0);
    drafting.retire();
    setOwnerApprovalSurface(true);
    expect(await ownerApprovalBeforeToolCall({toolName: 'popclaw_send_draft', params: {draft_id: id}}, {})).toBeUndefined();
    const confirming = turn();
    await fx.call('popclaw_send_draft', {draft_id: id}, confirming);
    expect(fx.pushed).toHaveLength(1);
    expect(confirming.assertInvocationCurrent).toHaveBeenCalled();
  });
  it.each([{}, {senderIsOwner: false}, {senderIsOwner: true}, {senderIsOwner: true, assertInvocationCurrent: () => {}}])(
    'missing native authority never falls back to stdio: %j', async ctx => {
      const fx = fixture(), id = tokenOf(await fx.call('popclaw_draft_message', {recipient: 'Alice', body: 'hello'}));
      await fx.call('popclaw_send_draft', {draft_id: id, owner: true, grant: 'allow', senderIsOwner: true}, ctx);
      expect(fx.pushed).toHaveLength(0);
      expect(peekDraftSnapshot(id)).not.toBeNull();
    });
  it.each([{sessionId: 'other'}, {sessionKey: 'other'}, {agentId: 'other'}, {requesterSenderId: 'other'}])(
    'does not send another native conversation draft: %j', async change => {
      const fx = fixture(), id = tokenOf(await fx.call('popclaw_draft_message', {recipient: 'Alice', body: 'hello'}));
      await fx.call('popclaw_send_draft', {draft_id: id}, turn(change));
      expect(fx.pushed).toHaveLength(0);
    });
  it('refuses a retired confirmation invocation before taking the draft', async () => {
    const fx = fixture(), id = tokenOf(await fx.call('popclaw_draft_message', {recipient: 'Alice', body: 'hello'})), ctx = turn();
    ctx.retire();
    await expect(fx.call('popclaw_send_draft', {draft_id: id}, ctx)).rejects.toThrow('HOST_REVOKED');
    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(id)).not.toBeNull();
  });
  it('checks current authority after async signing, at actual egress', async () => {
    const fx = fixture(), ctx = turn(), original = fx.owner.signer.sign.bind(fx.owner.signer);
    const id = tokenOf(await fx.call('popclaw_draft_message', {recipient: 'Alice', body: 'hello'}));
    vi.spyOn(fx.owner.signer, 'sign').mockImplementation(async bytes => {const signed = await original(bytes); ctx.retire(); return signed;});
    await expect(fx.call('popclaw_send_draft', {draft_id: id}, ctx)).rejects.toThrow('HOST_REVOKED');
    expect(fx.pushed).toHaveLength(0);
  });
  it('sends exactly once from frozen parameters and does not retransmit an unknown outcome', async () => {
    const fx = fixture(), params = {recipient: 'Alice', body: 'Reviewed body'};
    const id = tokenOf(await fx.call('popclaw_draft_message', params)); params.body = 'Replacement';
    fx.push.mockImplementationOnce(async bytes => {fx.pushed.push(bytes); throw new Error('UNKNOWN');});
    await expect(fx.call('popclaw_send_draft', {draft_id: id})).rejects.toThrow('UNKNOWN');
    await fx.call('popclaw_send_draft', {draft_id: id});
    expect(fx.pushed).toHaveLength(1);
    expect(peekDraftSnapshot(id)).toBeNull();
    const signed = popclaw.identity.SignedPayload.decode(fx.pushed[0]!);
    expect(popclaw.event.EventEnvelope.decode(signed.payload).directMessage?.toPopclawId).toBe(fx.recipient.id);
  });
  it.each(['reply', 'post'] as const)('keeps the %s send door free of host approval', async kind => {
    const fx = fixture(), id = tokenOf(await fx.call(`popclaw_draft_${kind}`, kind === 'reply'
      ? {platform: 'x', post_id: 'p1', body: 'Reviewed reply'} : {body: 'Reviewed post'}));
    await fx.call('popclaw_send_draft', {draft_id: id});
    expect(fx.pushed).toHaveLength(1);
  });
  it('explicit local stdio registration remains listed and works with no native owner fields', async () => {
    const fx = fixture('local-stdio'), collector = makeToolCollector();
    registerWriteTools({api: collector.api, runtime: fx.runtime, deps: {api: collector.api, runtime: fx.runtime, socialSendHost: 'local-stdio'}, total: 4} as unknown as ToolsCtx);
    const draft = collector.tools.find(t => t.name === 'popclaw_draft_message')!;
    const id = tokenOf(await draft.execute('draft', {recipient: 'Alice', body: 'Reviewed MCP manuscript'}) as {text: string});
    const send = collector.tools.find(t => t.name === 'popclaw_send_draft')!;
    expect(send).toBeDefined();
    await send.execute('send', {draft_id: id});
    expect(fx.pushed).toHaveLength(1);
  });
});

describe('material and root scope boundaries', () => {
  it('does not send mutated stored attachment bytes', async () => {
    const fx = fixture(), id = 'message-attachment';
    const sent = vi.fn(async () => ({text: 'sent'}));
    const binding = {host: 'native' as const, agentId: 'main', sessionId: 'session-a', sessionKey: 'agent:main:main', senderId: 'owner'};
    putDraft(id, sent, {kind: 'dm', body: 'reviewed', attachments: [{name: 'photo.png', mime: 'image/png', bytes: new Uint8Array([1,2]), digest: 'ignored'}], binding, preview: null, output: null});
    peekDraftSnapshot(id)!.attachments[0]!.bytes[0] = 9;
    expect((await fx.call('popclaw_send_draft', {draft_id: id})).text).toContain('material changed');
    expect(sent).not.toHaveBeenCalled();
  });
  it('re-hashes the original-chat review copy without using it as send content', async () => {
    const fx = fixture(), body = 'Reviewed long manuscript. '.repeat(30);
    const id = tokenOf(await fx.call('popclaw_draft_message', {recipient: 'Alice', body}));
    const dir = mkdtempSync(join(tmpdir(), 'social-review-'));
    try {
      const files = createDraftReviewFiles(dir, {staleAfterMs: DRAFT_TTL_MS});
      withDraftReview(id, body, files);
      const path = peekDraftSnapshot(id)!.review!.file!.path;
      expect(readFileSync(path, 'utf8')).toContain(body.trim());
      writeFileSync(path, 'Replacement manuscript');
      expect((await fx.call('popclaw_send_draft', {draft_id: id})).text).toContain('review copy changed');
      expect(fx.pushed).toHaveLength(0);
    } finally {rmSync(dir, {recursive: true, force: true});}
  });
  it('keeps the complete original-chat review usable when an optional file cannot be written', async () => {
    const fx = fixture(), body = 'Long manuscript. '.repeat(50);
    const id = tokenOf(await fx.call('popclaw_draft_message', {recipient: 'Alice', body}));
    const text = withDraftReview(id, body, {dir: '/synthetic/review', write: () => {throw new Error('unavailable');}, sha256: () => null, remove: () => {}});
    expect(text).toContain(body);
    expect(peekDraftSnapshot(id)!.review!.failed).toBe('write');
    await fx.call('popclaw_send_draft', {draft_id: id});
    expect(fx.pushed).toHaveLength(1);
  });
  it('enforces expiry and cannot use an invitation token at the social send door', async () => {
    const fx = fixture(), now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const id = tokenOf(await fx.call('popclaw_draft_message', {recipient: 'Alice', body: 'hello'}));
    clock.mockReturnValue(now + DRAFT_TTL_MS + 1);
    await fx.call('popclaw_send_draft', {draft_id: id}); expect(fx.pushed).toHaveLength(0);
    const sent = vi.fn(async () => ({text: 'sent'}));
    putDraft('invite-1', sent, {kind: 'dm', body: 'hello', attachments: [], preview: null, output: null,
      binding: {host: 'native', agentId: 'main', sessionId: 'session-a', sessionKey: 'agent:main:main', senderId: 'owner'}});
    await fx.call('popclaw_send_draft', {draft_id: 'invite-1'}); expect(sent).not.toHaveBeenCalled();
  });
  it('shows the exact incoming message context before drafting a private reply', async () => {
    const fx = fixture();
    const result = await fx.call('popclaw_draft_message', {reply_to_message_id: 7, body: 'Reviewed private reply'});
    expect(result.text).toContain('message 7');
    expect(result.text).toContain('cd'.repeat(32));
    expect(result.text).toContain('Original incoming message');
    expect(result.text).toContain(fx.recipient.id);
    expect(fx.pushed).toHaveLength(0);
  });
  it('pins the post source house before its cached record changes', async () => {
    const fx = fixture(), eventId = 'ab'.repeat(32), item = {houseSlug: 'original-house', textPreview: 'original source', handle: 'Original Author', authorPopclawId: fx.recipient.id};
    const runtime = await fx.runtime();
    Object.assign(runtime.worldFeedCache, {findByEventIdPrefix: () => ({item, ambiguous: []})});
    const pushedTo: unknown[] = [];
    runtime.egress.pushTo = async (house: unknown, bytes: Uint8Array) => {pushedTo.push(house); return fx.push(bytes);};
    const definitions = new Map<string, unknown>();
    const api = {registerTool: (t: unknown, opts?: unknown) => definitions.set((opts as {name: string}).name, t)};
    registerWriteTools({api, runtime: async () => runtime, deps: {api, runtime: async () => runtime, socialSendHost: 'native'}, total: 4} as unknown as ToolsCtx);
    const call = (name: string, args: unknown) => (definitions.get(name) as {create(ctx: unknown): Tool}).create(turn()).execute('call', args);
    const result = await call('popclaw_draft_post', {body: 'Reviewed quote', quote_of_event_id: eventId});
    expect(result.text).toContain('Original Author');
    expect(result.text).toContain(fx.recipient.id);
    expect(result.text).toContain('original source');
    const id = tokenOf(result);
    item.houseSlug = 'different-house';
    await call('popclaw_send_draft', {draft_id: id});
    expect(pushedTo).toEqual(['original-house']);
  });
  it('explicit Hosted scope refuses preparation and missing authority, then uses a fresh confirmed-send invocation', async () => {
    const fx = fixture(), collector = makeToolCollector();
    let current: {scope: string; purpose: 'prepare' | 'chat-send'; assertCurrent(): void} | null = {scope: 'opaque-identity-connection', purpose: 'prepare', assertCurrent: vi.fn()};
    registerWriteTools({api: collector.api, runtime: fx.runtime, deps: {api: collector.api, runtime: fx.runtime,
      socialSendHost: 'hosted', getHostedSocialInvocation: () => current}, total: 4} as unknown as ToolsCtx);
    const draft = collector.tools.find(t => t.name === 'popclaw_draft_message')!, send = collector.tools.find(t => t.name === 'popclaw_send_draft')!;
    const id = tokenOf(await draft.execute('draft', {recipient: 'Alice', body: 'Hosted manuscript'}) as {text: string});
    await send.execute('freeze', {draft_id: id, purpose: 'chat-send', owner: true}); expect(fx.pushed).toHaveLength(0);
    current = null; await send.execute('missing', {draft_id: id}); expect(fx.pushed).toHaveLength(0);
    current = {scope: 'other-connection', purpose: 'chat-send', assertCurrent: vi.fn()};
    await send.execute('other', {draft_id: id}); expect(fx.pushed).toHaveLength(0);
    current = {scope: 'opaque-identity-connection', purpose: 'chat-send', assertCurrent: vi.fn()};
    await send.execute('confirmed', {draft_id: id}); expect(fx.pushed).toHaveLength(1);
    expect(current.assertCurrent).toHaveBeenCalled();
  });
  it('uses no native context fabrication for a Hosted factory without its trusted getter', () => {
    const create = vi.fn(); const factory = socialToolFactory('hosted', create) as (ctx: unknown) => void;
    factory({senderIsOwner: true});
    expect(create).toHaveBeenCalledWith({getHostedSocialInvocation: undefined});
  });
});
