import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { registerWriteTools } from '../../../src/tools/write-tools.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import { _draftsForTest, makeDraftToken, putDraft, takeDraft } from '../../../src/tools/draft-store.js';
import { ActionInactiveError, assertActionActive, assertHouseActionActive, withAction, withHouseActions } from '../../../src/runtime/house-lifecycle/action-context.js';
import { sendDraftConfirmed } from '../../helpers/owner-approval-script.js';
import { makeNameChain } from '../../../src/identity/person-name.js';

afterEach(() => _draftsForTest.clear());

function signer(byte: number) {
  const seed = new Uint8Array(32).fill(byte);
  const key = nacl.sign.keyPair.fromSeed(seed);
  return new MasterKeySigner({ seed, ...key, popclawId: bs58.encode(key.publicKey) });
}

function gate() {
  const controller = new AbortController();
  return { signal: controller.signal, isActive: () => !controller.signal.aborted, retire: () => controller.abort() };
}

async function setup(origin?: string) {
  const recipient = await signer(2).popclawId();
  const post = { handle: 'Author A', textPreview: 'Original post', authorPopclawId: recipient, houseSlug: 'house-a', eventId: 'a'.repeat(64) };
  const source = { fromPopclawId: recipient, senderNickname: '', houseSlug: 'house-a', eventId: 'b'.repeat(64) };
  let remarkName = '';
  let latestName: string | undefined;
  const nameOf = makeNameChain({ bond: () => ({ remarkName }), handleFromFeed: () => latestName ?? post.handle });
  const home = { slug: 'house-home' };
  let messageHouse: string | undefined = 'house-a';
  const pushed: Array<{ house: string | undefined; bytes: Uint8Array }> = [];
  const pushTo = vi.fn(async (house: string | undefined, bytes: Uint8Array) => {
    assertHouseActionActive(house ?? 'house-a');
    pushed.push({ house, bytes });
  });
  const lookup = vi.fn(() => post);
  const houseOf = vi.fn(() => messageHouse);
  const runtime = async () => ({
    boot: { signer: signer(1), nickname: 'Owner', webBaseUrl: 'https://example.invalid' },
    egress: { home, capturePlan: () => ({ targets: ['house-home', 'house-a', 'house-b'].map(slug => ({ slug, origin: slug === 'house-a' && origin ? origin : slug })) }), pushTo, push: (bytes: Uint8Array) => pushTo(undefined, bytes) },
    worldFeedCache: { lookup, findByEventIdPrefix: () => ({ item: post, ambiguous: [] }) },
    inboxStore: { houseOf, get: () => source },
    nameOf,
    bondsStore: { list: () => [{ popclawId: recipient, nickname: 'Recipient', remarkName: '' }] },
  });
  type Tool = { name: string; execute(id: string, params: unknown): Promise<{ text: string }> };
  const tools = new Map<string, Tool>();
  // write-tools registers in the FACTORY form `(toolCtx) => toolDef` (the
  // host passes the session context); resolve it the way the host does.
  const api = {
    registerTool: (tool: unknown) => {
      const context = {agentId: 'test', sessionKey: 'agent:test:fixture', sessionId: 'fixture', senderIsOwner: true, assertInvocationCurrent: () => {}};
      const descriptor = tool as {contextVersion?: number; create?: (ctx: unknown) => Tool};
      const resolved = typeof tool === 'function' ? tool(context) : descriptor?.contextVersion === 2 ? descriptor.create!(context) : (tool as Tool);
      tools.set(resolved.name, resolved);
    },
  };
  registerWriteTools({ api, runtime, deps: { api, runtime }, total: 4 } as unknown as ToolsCtx);
  const call = (name: string, params: unknown) => tools.get(name)!.execute('test', params);
  // The harness represents prior ordinary-chat review and confirmation; it
  // does not prove human content consent.
  const confirm = (preview: { text: string }) => {
    const token = preview.text.match(/draft_id: (\S+)/)?.[1];
    expect(token).toBeTruthy();
    return sendDraftConfirmed((id, params) => tools.get('popclaw_send_draft')!.execute(id, params), token!);
  };
  return { recipient, post, source, pushed, lookup, houseOf, call, confirm, home, setLatestName: (name: string) => { latestName = name; }, setRemark: (name: string) => { remarkName = name; }, setHouse: (house: string | undefined) => { messageHouse = house; } };
}

describe('draft destination and action generation', () => {
  it('uses the inbox sender name in a DM reply preview without changing the pinned recipient or house', async () => {
    const fx = await setup();
    fx.source.senderNickname = 'Lee';
    const draft = await fx.call('popclaw_draft_message', { reply_to_message_id: 1, body: 'Synthetic reply' });
    expect(draft.text).toContain('Lee#');
    expect(draft.text).toContain(fx.recipient);
    fx.source.senderNickname = 'Later Name';
    await fx.confirm(draft);
    expect(fx.pushed.map(p => p.house)).toEqual(['house-a']);
    const signed = popclaw.identity.SignedPayload.decode(fx.pushed[0]!.bytes);
    const envelope = popclaw.event.EventEnvelope.decode(signed.payload);
    expect(envelope.directMessage!.toPopclawId).toBe(fx.recipient);
    expect(envelope.prevEventId).toBe(fx.source.eventId);
  });

  it('uses the local remark in a reply preview, keeping it out of outgoing bytes', async () => {
    const fx = await setup();
    fx.setRemark('Private Lee Alias');
    fx.post.handle = fx.recipient;
    const draft = await fx.call('popclaw_draft_reply', { platform: 'x', post_id: '123', body: 'Synthetic reply' });
    expect(draft.text).toContain('Private Lee Alias');
    expect(draft.text).toContain(fx.recipient);
    await fx.confirm(draft);
    expect(Buffer.from(fx.pushed[0]!.bytes).toString()).not.toContain('Private Lee Alias');
  });

  it('uses the same name chain in a quote preview without minting a send', async () => {
    const fx = await setup();
    fx.setRemark('Private Lee Alias');
    fx.post.handle = fx.recipient;
    const draft = await fx.call('popclaw_draft_post', { quote_of_event_id: fx.post.eventId, body: 'Synthetic quote' });
    expect(draft.text).toContain('Private Lee Alias');
    expect(draft.text).toContain(fx.recipient);
    expect(fx.pushed).toEqual([]);
  });

  it('uses the current observed name rather than the historic source handle', async () => {
    const fx = await setup();
    fx.post.handle = 'Old Author';
    fx.setLatestName('Lee');
    for (const [tool, params] of [
      ['popclaw_draft_reply', { platform: 'x', post_id: '123', body: 'Synthetic reply' }],
      ['popclaw_draft_post', { quote_of_event_id: fx.post.eventId, body: 'Synthetic quote' }],
    ] as const) {
      const draft = await fx.call(tool, params);
      expect(draft.text).toContain('Lee');
      expect(draft.text).not.toContain('Old Author');
      expect(draft.text).toContain(fx.recipient);
    }
    expect(fx.pushed).toEqual([]);
  });

  it('shows the reply recipient and source, and pins fallback home before conversation review', async () => {
    const fx = await setup();
    Reflect.deleteProperty(fx.post, 'houseSlug');
    const draft = await fx.call('popclaw_draft_reply', {platform: 'x', post_id: 'p1', body: 'Reviewed reply'});
    expect(draft.text).toContain(fx.recipient);
    expect(draft.text).toContain('Author A');
    expect(draft.text).toContain('Original post');
    expect(draft.text).toContain('house-home');
    fx.home.slug = 'different-home';
    await fx.confirm(draft);
    expect(fx.pushed.map(p => p.house)).toEqual(['house-home']);
  });

  it('new DM ignores the recipient history and pins home before approval', async () => {
    const fx = await setup();
    const draft = await fx.call('popclaw_draft_message', { recipient: fx.recipient, body: 'Approved message' });
    fx.setHouse('house-b');
    fx.home.slug = 'house-b';
    await fx.confirm(draft);
    expect(fx.pushed.map(p => p.house)).toEqual(['house-home']);
    expect(fx.houseOf).not.toHaveBeenCalled();
  });

  it('keeps the primary-house fallback when the recipient had no incoming house at draft time', async () => {
    const fx = await setup();
    fx.setHouse(undefined);
    const draft = await fx.call('popclaw_draft_message', { recipient: fx.recipient, body: 'Approved message' });
    fx.setHouse('house-b');
    await fx.confirm(draft);
    expect(fx.pushed.map(p => p.house)).toEqual(['house-home']);
  });

  it('pins an explicit house ahead of a reply source and later parameter mutation', async () => {
    const fx = await setup();
    const params = { reply_to_message_id: 1, body: 'Approved reply', house: 'house-b' };
    const draft = await fx.call('popclaw_draft_message', params);
    expect(draft.text).toContain('house-b');
    params.house = 'house-a';
    await fx.confirm(draft);
    expect(fx.pushed.map(p => p.house)).toEqual(['house-b']);
    const signed = popclaw.identity.SignedPayload.decode(fx.pushed[0]!.bytes);
    expect(popclaw.event.EventEnvelope.decode(signed.payload).prevEventId).toBe(fx.source.eventId);
  });

  it('selects a full mounted origin exactly', async () => {
    const fx = await setup('https://house-a');
    const draft = await fx.call('popclaw_draft_message', { recipient: fx.recipient, body: 'hello', house: 'https://house-a' });
    await fx.confirm(draft);
    expect(fx.pushed.map(p => p.house)).toEqual(['house-a']);
  });

  it.each(['http://house-a', 'https://user:secret@house-a', 'https://house-a/path', 'https://house-a?query=1', '//house-a', 'https://house-a:444'])('does not substitute a mounted origin for %s', async house => {
    const fx = await setup('https://house-a');
    await expect(fx.call('popclaw_draft_message', { recipient: fx.recipient, body: 'hello', house })).rejects.toThrow('INVALID_HOUSE');
    expect(fx.pushed).toEqual([]);
  });

  it('rejects an unknown explicit house before creating a draft', async () => {
    const fx = await setup();
    await expect(fx.call('popclaw_draft_message', { recipient: fx.recipient, body: 'hello', house: 'unknown-house' })).rejects.toThrow('INVALID_HOUSE');
    expect(fx.pushed).toEqual([]);
  });

  it('refuses an explicit target that is mounted but outside the active participation', async () => {
    const fx = await setup();
    await expect(withHouseActions(new Map([['house-home', gate()]]), () =>
      fx.call('popclaw_draft_message', { recipient: fx.recipient, body: 'hello', house: 'house-b' }))).rejects.toBeInstanceOf(ActionInactiveError);
    expect(fx.pushed).toEqual([]);
  });

  it('does not let an explicit DM reuse a draft after leaving and rejoining its house', async () => {
    const fx = await setup();
    const original = gate();
    const draft = await withHouseActions(new Map([['house-b', original]]), () =>
      fx.call('popclaw_draft_message', { recipient: fx.recipient, body: 'hello', house: 'house-b' }));
    original.retire();
    await expect(withHouseActions(new Map([['house-b', gate()]]), () => fx.confirm(draft))).rejects.toBeInstanceOf(ActionInactiveError);
    expect(fx.pushed).toEqual([]);
  });

  it('pins the reply source house even if the source object changes before confirmation', async () => {
    const fx = await setup();
    const draft = await fx.call('popclaw_draft_message', { reply_to_message_id: 1, body: 'Approved reply' });
    fx.source.houseSlug = 'house-b';
    await fx.confirm(draft);
    expect(fx.pushed.map(p => p.house)).toEqual(['house-a']);
    expect(fx.houseOf).not.toHaveBeenCalled();
  });

  it('pins the reply post author and source house before a cache record is changed in place', async () => {
    const fx = await setup();
    const draft = await fx.call('popclaw_draft_reply', { platform: 'x', post_id: '123', body: 'Approved reply' });
    fx.post.houseSlug = 'house-b';
    fx.post.authorPopclawId = await signer(3).popclawId();
    await fx.confirm(draft);
    expect(fx.pushed.map(p => p.house)).toEqual(['house-a']);
    expect(fx.lookup).toHaveBeenCalledOnce();
    expect(fx.lookup).toHaveBeenCalledWith('x', '123');
    const signed = popclaw.identity.SignedPayload.decode(fx.pushed[0]!.bytes);
    const envelope = popclaw.event.EventEnvelope.decode(signed.payload);
    expect(envelope.reply!.inReplyTo!.authorPopclawId).toBe(fx.recipient);
  });

  it('does not lend the confirmation generation to a draft from a retired generation', async () => {
    const fx = await setup();
    const oldA = gate(), newA = gate(), activeB = gate();
    const original = new Map([['house-a', oldA], ['house-b', activeB]]);
    const current = new Map([['house-a', newA], ['house-b', activeB]]);
    const draft = await withHouseActions(original, () => fx.call('popclaw_draft_reply', { platform: 'x', post_id: '123', body: 'Old approval' }));
    fx.post.houseSlug = 'house-b';
    const retainedB = await withHouseActions(original, () => fx.call('popclaw_draft_reply', { platform: 'x', post_id: '123', body: 'B approval' }));
    oldA.retire();
    await expect(withHouseActions(current, () => fx.confirm(draft))).rejects.toBeInstanceOf(ActionInactiveError);
    expect(fx.pushed).toEqual([]);
    // Failed confirmation still consumes the one-use draft.
    expect((await fx.confirm(draft)).text).toContain('unknown or expired');
    // Both an existing B draft and a fresh B draft survive A's retirement.
    await withHouseActions(current, () => fx.confirm(retainedB));
    const newDraft = await withHouseActions(current, () => fx.call('popclaw_draft_reply', { platform: 'x', post_id: '123', body: 'Fresh B approval' }));
    await withHouseActions(current, () => fx.confirm(newDraft));
    expect(fx.pushed.map(p => p.house)).toEqual(['house-b', 'house-b']);
  });

  it('does not grant a pre-login draft permission from a later login', async () => {
    const fx = await setup();
    const draft = await withHouseActions(new Map(), () => fx.call('popclaw_draft_reply', { platform: 'x', post_id: '123', body: 'Not yet joined' }));
    await expect(withHouseActions(new Map([['house-a', gate()]]), () => fx.confirm(draft))).rejects.toBeInstanceOf(ActionInactiveError);
    expect(fx.pushed).toEqual([]);
  });

  it('restores draft context through asynchronous confirmation without leaking it to the caller', async () => {
    const original = gate(), confirmation = gate();
    const token = makeDraftToken('reply');
    withAction(original, () => putDraft(token, async () => {
      await Promise.resolve();
      assertActionActive();
      return { text: 'sent' };
    }));
    const send = takeDraft(token, ['reply'])!;
    original.retire();
    await withAction(confirmation, async () => {
      await expect(Promise.resolve().then(send)).rejects.toBeInstanceOf(ActionInactiveError);
      expect(() => assertActionActive()).not.toThrow();
    });
  });
});
