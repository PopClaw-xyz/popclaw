/**
 * Current-turn direct draft preview delivery (additive fix, 2026-09-06).
 *
 * Confirmed defect: the draft tool result already carried the complete
 * preview, but the host Agent may answer the owner with only "full content
 * above" — never displaying the body, or dropping the identity warnings. On
 * OpenClaw 8.2 the factory tool-context can carry a current-turn delivery
 * capability bound to the owner's route; the fix pushes ONE immutable preview
 * (the exact same string the tool result embeds) through that capability, and
 * keeps the full tool result as the compatibility fallback.
 *
 * Everything here drives the REAL registerPopclawTools registration. The
 * synthetic "Agent that discards output" is simulated by never reading
 * result.text: if the separately captured preview did not exist, the first
 * test in this file could not pass. The mocked delivery.send records a
 * **captured delivery request** — never evidence of a real IM delivery (the
 * host's send resolves void and discards its own result), and the terminal
 * send handlers stay mocked so no signed event can ever leave this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot,
} from 'openclaw/plugin-sdk/runtime-config-snapshot';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { makeToolCollector } from '../../../src/tools/mcp-adapter.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import {
  draftPreviewStats,
  _draftPreviewStatsForTest,
} from '../../../src/tools/draft-preview-delivery.js';
import { ownerLang, setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { nextCallRef, scriptOwnerApproval, sendDraftApproved } from '../../helpers/owner-approval-script.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import { runPopclawReplyCommand } from '../../../src/commands/popclaw-reply.js';
import { runPopclawPostCommand } from '../../../src/commands/popclaw-post.js';
import { loadDmAttachment } from '../../../src/messaging/dm-media.js';

// Real registered tools and draft store; only terminal send handlers are spies.
// No signing, network, live identity, or host configuration is used here.
vi.mock('../../../src/commands/popclaw-message.js', () => ({ runPopclawMessageCommand: vi.fn(async () => ({ text: 'SYNTHETIC SENT' })) }));
vi.mock('../../../src/commands/popclaw-reply.js', () => ({ runPopclawReplyCommand: vi.fn(async () => ({ text: 'SYNTHETIC SENT' })) }));
vi.mock('../../../src/commands/popclaw-post.js', () => ({ runPopclawPostCommand: vi.fn(async () => ({ text: 'SYNTHETIC SENT' })) }));
// Synthetic attachment loader (task fixture): bytes conjured in-memory — the
// preview only ever shows name + size, and no disk read happens in this file.
vi.mock('../../../src/messaging/dm-media.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/messaging/dm-media.js')>();
  return {
    ...actual,
    loadDmAttachment: vi.fn((path: string) => ({
      ok: true,
      name: path.split('/').pop() || path,
      mime: 'image/png',
      bytes: new Uint8Array(2048),
    })),
  };
});

/** Resolved-recipient fixture (a real-shape bs58 id, zero crypto involved). */
const ID = '7xKvGjWntCHSPQoyY2mLBRTDdQFEAqNsZz4fCcrKVJ9u';
/** Cross the 449 and 4K clipping offsets, surrogate pairs, newlines, emoji. */
const LONG_BODY =
  'x'.repeat(79) + '𠮷' + 'y'.repeat(118) + '🧪\n第二行\n' + 'z'.repeat(4097) + '\nEND😀';
const SHORT_BODY = '一句话就够 Sentence.';

type DeliveryPayload = { text?: string; mediaUrl?: string };
type Tool = { name: string; execute: (c: string, p: unknown) => Promise<{ text: string }> };

/**
 * The host's factory tool context (reviewer-verified OpenClaw 8.2 shape; the
 * SDK surface is structural, so this fixture is too). `over` mutates one axis
 * at a time for the not-credible scenarios.
 */
function ownerToolCtx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionKey: 'agent:main:telegram:12345',
    sessionId: 'sess-fixture',
    requesterSenderId: 'telegram:12345',
    senderIsOwner: true,
    deliveryContext: { channel: 'telegram', to: '12345', accountId: 'telegram' },
    ...over,
  };
}

/**
 * The pinned runtime snapshot that makes `ownerToolCtx`'s own chat the chat
 * the host would ask the owner for approval in. Off `webchat`/`tui` that is
 * now what admits a preview at all, so every test in this file that expects a
 * push states the route it is pushing down instead of leaving it to chance.
 */
const pinnedToTheFixtureChat = () => ({
  commands: { ownerAllowFrom: ['12345'] },
  approvals: {
    plugin: {
      enabled: true, mode: 'targets',
      targets: [{ channel: 'telegram', to: '12345', accountId: 'telegram' }],
    },
  },
});
/** An owner-direct origin: admitted without any configuration at all. */
const ownerDirectCtx = (channel: string, to: string, over: Record<string, unknown> = {}) =>
  ownerToolCtx({
    sessionKey: `agent:main:${channel}:${to}`,
    requesterSenderId: `${channel}:${to}`,
    deliveryContext: { channel, to },
    ...over,
  });

/**
 * The synthetic channel capability. `mode`:
 *  - 'void'    — resolves undefined (the documented normal outcome)
 *  - 'throw'   — rejects before doing anything
 *  - 'partial' — records the request, THEN rejects (a throw may follow partial
 *                delivery — the capture is the only trace it ever went out)
 */
function makeDelivery(mode: 'void' | 'throw' | 'partial' = 'void') {
  const captured: DeliveryPayload[] = [];
  const send = vi.fn(async (payload: DeliveryPayload): Promise<void> => {
    if (mode === 'throw') throw new Error('host channel refused');
    captured.push(payload);
    if (mode === 'partial') throw new Error('channel failed after enqueue');
    return undefined;
  });
  return { send, captured };
}

/**
 * registerPopclawTools against a collector api whose factories resolve with
 * `toolCtx` (what the real host does per session). `opts.emptyRuntime` drops
 * the local identity fixtures while retaining empty routing stores so person resolution falls to the lore-house leg.
 */
function register(
  toolCtx: unknown,
  opts: { getWorldDeps?: Parameters<typeof registerPopclawTools>[0]['getWorldDeps']; emptyRuntime?: boolean } = {},
): Tool[] {
  const collector = makeToolCollector();
  const api = {
    ...collector.api,
    registerTool: (tool: unknown, regOpts?: unknown) => {
      const resolved =
        typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)(toolCtx) : tool;
      collector.api.registerTool(resolved, regOpts);
    },
  };
  registerPopclawTools({
    api,
    runtime: (async () =>
      opts.emptyRuntime
        ? { worldFeedCache: { lookup: () => null }, inboxStore: { houseOf: () => undefined } }
        : {
            boot: { signer: {}, nickname: 'Owner Fixture', webBaseUrl: 'https://fixture.invalid' },
            worldFeedCache: { lookup: () => null },
            bondsStore: { list: () => [{ popclawId: ID, nickname: 'Recipient Fixture', remarkName: '' }] },
            knownFollowers: { allFollowerIds: () => [ID] },
            inboxStore: { houseOf: () => undefined },
          }) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    ...(opts.getWorldDeps ? { getWorldDeps: opts.getWorldDeps } : {}),
  });
  return collector.tools as unknown as Tool[];
}

function find(tools: Tool[], name: string): Tool {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

/** A credible owner context + its delivery capability, wired into one registration. */
function setup(toolCtx: Record<string, unknown> = ownerToolCtx(), mode: 'void' | 'throw' | 'partial' = 'void') {
  const delivery = makeDelivery(mode);
  const tools = register({ ...toolCtx, delivery });
  return { tools, delivery };
}

const SENDERS = [runPopclawMessageCommand, runPopclawReplyCommand, runPopclawPostCommand];

beforeEach(() => {
  vi.clearAllMocks();
  _draftsForTest.clear();
  _draftPreviewStatsForTest.reset();
  setRuntimeConfigSnapshot(pinnedToTheFixtureChat() as never);
});
afterEach(() => {
  _draftsForTest.clear();
  _draftPreviewStatsForTest.reset();
  clearRuntimeConfigSnapshot();
  setOwnerLang(undefined);
});

it('declares factory names without booting runtime or delivering during registration and factory resolution', () => {
  const delivery = makeDelivery();
  const runtime = vi.fn();
  const factories: Array<{ factory: (ctx: unknown) => unknown; opts: { name?: string } }> = [];
  registerPopclawTools({
    api: { registerTool: (tool: unknown, opts: unknown) => {
      if (typeof tool === 'function') factories.push({
        factory: tool as (ctx: unknown) => unknown,
        opts: (opts ?? {}) as { name?: string },
      });
    } },
    runtime,
  });
  const drafts = factories.filter(({ opts }) => opts.name?.startsWith('popclaw_draft_'));
  expect(drafts.map(({ opts }) => opts.name).sort()).toEqual([
    'popclaw_draft_message', 'popclaw_draft_post', 'popclaw_draft_reply',
  ]);
  for (const { factory, opts } of drafts) {
    const tool = factory({ ...ownerToolCtx(), delivery }) as { name: string };
    expect(tool.name).toBe(opts.name);
  }
  expect(runtime).not.toHaveBeenCalled();
  expect(delivery.send).not.toHaveBeenCalled();
});

it('uses each conversation\'s own capability when drafts are created concurrently', async () => {
  // Two owner-direct origins: one pinned route cannot admit two different
  // chats, and what this test is about is which capability each draft used.
  const a = setup(ownerDirectCtx('webchat', 'a', { sessionKey: 'conversation-a' }));
  const b = setup(ownerDirectCtx('tui', 'b', { sessionKey: 'conversation-b' }));
  await Promise.all([
    find(a.tools, 'popclaw_draft_post').execute('a', { body: 'Private fixture A' }),
    find(b.tools, 'popclaw_draft_post').execute('b', { body: 'Private fixture B' }),
  ]);
  expect(a.delivery.captured).toHaveLength(1);
  expect(b.delivery.captured).toHaveLength(1);
  expect(a.delivery.captured[0]!.text).toContain('Private fixture A');
  expect(a.delivery.captured[0]!.text).not.toContain('Private fixture B');
  expect(b.delivery.captured[0]!.text).toContain('Private fixture B');
  expect(b.delivery.captured[0]!.text).not.toContain('Private fixture A');
});

it('does not extend the draft TTL when requesting its preview', async () => {
  const { tools } = setup();
  const draft = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
  const token = draft.text.match(/draft_id: (post-\d+)/)![1]!;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60 * 1000 + 1);
  try {
    const result = await sendDraftApproved(find(tools, 'popclaw_send_draft').execute, token);
    expect(result.text).toContain('unknown or expired');
    for (const sender of SENDERS) expect(sender).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it('preserves developer text at the plugin boundary without claiming host normalization is lossless', async () => {
  const body = 'Literal "a\\nb" and [[reply_to:fixture]]\nEND🧪';
  const { tools, delivery } = setup();
  const result = await find(tools, 'popclaw_draft_post').execute('draft', { body });
  expect(delivery.captured[0]!.text).toContain(body);
  expect(result.text).toContain(body);
  expect(result.text).toContain('suppressed or changed');
  // The installed host normalizes these sequences (external pure host probe).
  // This assertion is only about the plugin's captured request, not IM output.
});

// ---------------------------------------------------------------------------
// The focused regression (TDD red first): discarding the tool output must not
// be able to remove the separately captured preview.
// ---------------------------------------------------------------------------

describe('direct draft preview — the defect it exists for', () => {
  it('a synthetic Agent that discards the tool output cannot remove the separate captured preview', async () => {
    const { tools, delivery } = setup();
    // The synthetic Agent: calls the tool and THROWS THE RESULT AWAY. (The
    // defect was exactly this agent answering "full content above".)
    await find(tools, 'popclaw_draft_message').execute('draft', {
      recipient: 'Recipient Fixture',
      body: LONG_BODY,
    });

    // The preview survives in its own channel — a captured delivery request,
    // NOT a real IM success (the send handlers below were never touched).
    expect(delivery.captured).toHaveLength(1);
    expect(delivery.captured[0]!.text).toContain(LONG_BODY);
    expect(delivery.captured[0]!.text).toContain('Recipient Fixture#');
    expect(delivery.captured[0]!.text).toMatch(/draft_id: message-\d+/);
    for (const sender of SENDERS) expect(sender).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Coverage matrix: 3 kinds × 2 languages × short/long bodies (non-BMP, emoji,
// newlines), recipient + draft id + one preview used for both destinations.
// ---------------------------------------------------------------------------

const CASES = [
  {
    name: 'popclaw_draft_message',
    params: (body: string) => ({ recipient: 'Recipient Fixture', body }),
  },
  {
    name: 'popclaw_draft_reply',
    params: (body: string) => ({ platform: 'x' as const, post_id: 'fixture-post', body }),
  },
  { name: 'popclaw_draft_post', params: (body: string) => ({ body }) },
];

describe.each(['zh-CN', 'en-US'])('direct preview in %s', (language) => {
  it.each(CASES)('$name carries the complete body, recipient and draft id in the captured preview', async ({ name, params }) => {
    setOwnerLang(language, 'config');
    const { tools, delivery } = setup();
    await find(tools, name).execute('draft', params(SHORT_BODY));
    await find(tools, name).execute('draft-long', params(LONG_BODY));
    expect(delivery.captured).toHaveLength(2);
    expect(delivery.captured[0]!.text).toContain(SHORT_BODY);
    expect(delivery.captured[1]!.text).toContain(LONG_BODY);
    expect(delivery.captured[1]!.text).toContain('END😀');
    if (name === 'popclaw_draft_message') {
      expect(delivery.captured[0]!.text).toContain(
        language === 'zh-CN' ? '📝 私信草稿：发给 ' : '📝 Draft DM to ',
      );
      expect(delivery.captured[0]!.text).toContain('Recipient Fixture#');
      expect(delivery.captured[0]!.text).toContain(ID);
    }
    // One preview for both destinations: the tool result embeds the exact
    // captured string (the result adds instructions + note AROUND it).
    const result = await find(tools, name).execute('draft-again', params(SHORT_BODY));
    expect(result.text).toContain(delivery.captured.at(-1)!.text!);
    expect(result.text).toContain('only after the owner has explicitly said to send');
    // Technical status jargon never reaches the direct user preview.
    expect(delivery.captured.at(-1)!.text).not.toContain('Direct preview delivery');
    for (const sender of SENDERS) expect(sender).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Identity warning + fixed recipient + attachment summary in the DIRECT
// preview (the defect's second half: warnings dropped when agent improvises).
// ---------------------------------------------------------------------------

describe('direct preview carries the warnings the owner must confirm against', () => {
  it('unverified-identity warning and the real fixed recipient ride along (full id, house serves nothing)', async () => {
    setOwnerLang('zh-CN', 'config');
    const delivery = makeDelivery();
    // No local identity fixtures: the full popclaw_id falls through to the
    // (reachable, empty) lore-house leg → resolved with `unverified: 'unknown'`.
    const tools = register(
      { ...ownerToolCtx(), delivery },
      {
        emptyRuntime: true,
        getWorldDeps: (async () => ({ resolveClient: { resolve: async () => [] } })) as unknown as Parameters<
          typeof registerPopclawTools
        >[0]['getWorldDeps'],
      },
    );
    await find(tools, 'popclaw_draft_message').execute('draft', {
      recipient: ID,
      body: 'fix this recipient',
    });
    const text = delivery.captured[0]!.text!;
    // The recipient is FIXED at draft time: name chain + full id in the preview.
    expect(text).toContain(`#${deriveSigil(ID)}`);
    expect(text).toContain(ID);
    expect(text).toContain(renderCopy('zh-CN', 'draft.unverified.unknown'));
    for (const sender of SENDERS) expect(sender).not.toHaveBeenCalled();
  });

  it('attachment summary (synthetic mocked loader) is in the captured preview, never the raw path', async () => {
    setOwnerLang('en-US', 'config');
    const { tools, delivery } = setup();
    await find(tools, 'popclaw_draft_message').execute('draft', {
      recipient: 'Recipient Fixture',
      body: 'look',
      attachment_path: '/synthetic/inbound/cat.png',
    });
    const text = delivery.captured[0]!.text!;
    expect(text).toContain('📎 attached: cat.png');
    expect(text).toContain('2.0 KB');
    expect(text).not.toContain('/synthetic/inbound/cat.png');
    expect(loadDmAttachment).toHaveBeenCalledWith('/synthetic/inbound/cat.png');
  });
});

// ---------------------------------------------------------------------------
// The confirmation gate is untouched: preview is display-only.
// ---------------------------------------------------------------------------

describe('preview never sends, never consumes the draft', () => {
  it('no send handler runs before confirmation; after it, the draft is still whole', async () => {
    const { tools, delivery } = setup();
    const draft = await find(tools, 'popclaw_draft_message').execute('draft', {
      recipient: 'Recipient Fixture',
      body: SHORT_BODY,
    });
    expect(delivery.captured).toHaveLength(1);
    for (const sender of SENDERS) expect(sender).not.toHaveBeenCalled();

    // The preview did NOT consume the draft: the same id still confirms once.
    const token = draft.text.match(/draft_id: (message-\d+)/)![1]!;
    const sendTool = find(tools, 'popclaw_send_draft');
    await sendDraftApproved(sendTool.execute, token);
    expect(runPopclawMessageCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(runPopclawMessageCommand).mock.calls[0]![0].positional).toEqual([
      'Recipient Fixture',
      SHORT_BODY,
    ]);

    // Repeat with the same id is refused (single-use core unchanged).
    const again = await sendDraftApproved(sendTool.execute, token);
    expect(again.text).toContain('unknown or expired');
    expect(runPopclawMessageCommand).toHaveBeenCalledOnce();
  });

  it('concurrent confirms of one draft id: exactly one sender call', async () => {
    const { tools } = setup();
    const draft = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    const token = draft.text.match(/draft_id: (post-\d+)/)![1]!;
    const sendTool = find(tools, 'popclaw_send_draft');
    // Two calls the owner approved separately, racing for one draft: the
    // approvals are per call, and the draft is still single-use.
    const c1 = nextCallRef('race');
    const c2 = nextCallRef('race');
    await scriptOwnerApproval('popclaw_send_draft', { draft_id: token }, c1);
    await scriptOwnerApproval('popclaw_send_draft', { draft_id: token }, c2);
    const [a, b] = await Promise.all([
      sendTool.execute(c1, { draft_id: token }),
      sendTool.execute(c2, { draft_id: token }),
    ]);
    expect(runPopclawPostCommand).toHaveBeenCalledOnce();
    // The loser is told plainly that nothing went out: its approval was for a
    // draft that no longer exists by the time it reached the table. Not
    // "changed" — nobody edited anything — and not the sequential re-send's
    // "unknown or expired" either: someone else got there first.
    const refusal = renderCopy(ownerLang(), 'sendDraft.refused.noLongerThere');
    expect([a, b].filter((r) => r.text === `${refusal} (reason: SUBJECT_CHANGED)`)).toHaveLength(1);
  });

  it('a failed direct preview does not damage the draft (owner can still confirm)', async () => {
    const { tools, delivery } = setup(ownerToolCtx(), 'throw');
    const draft = await find(tools, 'popclaw_draft_reply').execute('draft', {
      platform: 'x',
      post_id: 'fixture-post',
      body: SHORT_BODY,
    });
    expect(delivery.send).toHaveBeenCalledTimes(1);
    const token = draft.text.match(/draft_id: (reply-\d+)/)![1]!;
    await sendDraftApproved(find(tools, 'popclaw_send_draft').execute, token);
    expect(runPopclawReplyCommand).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Status truthfulness: void resolution is NOT evidence; throws may be partial;
// exactly one attempt, never a silent retry.
// ---------------------------------------------------------------------------

describe('delivery status is honest', () => {
  it('send resolving void → request completed, never claimed as shown; note says unknown', async () => {
    const { tools, delivery } = setup(ownerToolCtx(), 'void');
    const r = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(r.text).toContain('Direct preview delivery');
    expect(r.text).toContain('unknown');
    expect(r.text).not.toMatch(/has been (shown|delivered|seen)/i);
    expect(draftPreviewStats().unknown).toBe(1);
  });

  it('send throws → failed, one attempt only (no silent retry), draft + result intact', async () => {
    const { tools, delivery } = setup(ownerToolCtx(), 'throw');
    const r = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(delivery.captured).toHaveLength(0);
    expect(r.text).toContain('Direct preview delivery');
    expect(r.text).toContain('failed');
    expect(r.text).toContain('host channel refused');
    expect(draftPreviewStats().failed).toBe(1);
  });

  it('partial throw (captured then rejected) → failed, and the note never claims nothing went out', async () => {
    const { tools, delivery } = setup(ownerToolCtx(), 'partial');
    const r = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(delivery.captured).toHaveLength(1); // the request DID reach the channel mock
    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(r.text).toContain('failed');
    expect(r.text).not.toContain('was not sent');
    expect(draftPreviewStats().failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Not-credible contexts never dispatch: missing context, old host, MCP,
// non-owner — and tool arguments can never manufacture or reroute delivery.
// ---------------------------------------------------------------------------

describe('no capability, no dispatch (and tool args never override the trusted route)', () => {
  // A live-looking send wired INTO the context for the cases that carry one —
  // it must never fire: asserting on it is what makes "did not dispatch"
  // meaningful when the case's own capability is the one being gated.
  const noSend = vi.fn(async (): Promise<void> => undefined);

  it.each([
    // Empty context (what the MCP bridge's collector resolves factories with),
    // with a stray capability object present: owner/route/session metadata is
    // what gates, and none of it is there.
    ['factory context is empty (MCP resolves factories with {})', (d: ReturnType<typeof makeDelivery>) => ({ delivery: d })],
    // OpenClaw 7.1-2: credible route/owner/session context, no `delivery` at all.
    ['context without delivery (7.1-2 shape: route/owner/session, no capability)', () => ownerToolCtx()],
    ['non-owner sender', () => ownerToolCtx({ senderIsOwner: false, delivery: { send: noSend } })],
    ['missing session metadata', () => ownerToolCtx({ sessionKey: undefined, sessionId: undefined, delivery: { send: noSend } })],
    ['missing requester sender id', () => ownerToolCtx({ requesterSenderId: '', delivery: { send: noSend } })],
    ['missing route (deliveryContext absent)', () => ownerToolCtx({ deliveryContext: undefined, delivery: { send: noSend } })],
    ['route without a destination', () => ownerToolCtx({ deliveryContext: { channel: 'telegram' }, delivery: { send: noSend } })],
  ])('%s → unavailable, no dispatch, result keeps the fallback shape', async (_label, mkCtx) => {
    const delivery = makeDelivery();
    const tools = register(mkCtx(delivery));
    const r = await find(tools, 'popclaw_draft_message').execute('draft', {
      recipient: 'Recipient Fixture',
      body: SHORT_BODY,
    });
    expect(delivery.send).not.toHaveBeenCalled();
    expect(noSend).not.toHaveBeenCalled();
    // Compatibility fallback untouched: full preview + confirmation discipline,
    // and no direct-delivery note on a path where nothing was attempted.
    expect(r.text).toContain(SHORT_BODY);
    expect(r.text).toContain('only after the owner has explicitly said to send');
    expect(r.text).not.toContain('Direct preview delivery');
    expect(draftPreviewStats().unavailable).toBe(1);
  });

  it('the real MCP collector path (factories resolved with {}) stays on the fallback result', async () => {
    const collector = makeToolCollector();
    registerPopclawTools({
      api: collector.api,
      runtime: (async () => ({
        boot: { signer: {}, nickname: 'Owner Fixture', webBaseUrl: 'https://fixture.invalid' },
        bondsStore: { list: () => [{ popclawId: ID, nickname: 'Recipient Fixture', remarkName: '' }] },
        knownFollowers: { allFollowerIds: () => [ID] },
        inboxStore: { houseOf: () => undefined },
      })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const r = await find(collector.tools as unknown as Tool[], 'popclaw_draft_post').execute('c', {
      body: SHORT_BODY,
    });
    expect(r.text).toContain(SHORT_BODY);
    expect(r.text).not.toContain('Direct preview delivery');
    expect(draftPreviewStats().unavailable).toBe(1);
  });

  it('forged delivery-looking TOOL ARGUMENTS cannot create a capability where the context has none', async () => {
    const delivery = makeDelivery();
    const tools = register({}); // not credible: no owner/route/session at all
    const r = await find(tools, 'popclaw_draft_message').execute('draft', {
      recipient: 'Recipient Fixture',
      body: SHORT_BODY,
      // Everything a hallucinating model might stuff into the call to make
      // "direct delivery" happen — none of it is a trusted fact:
      senderIsOwner: true,
      sessionKey: 'agent:main:telegram:999',
      requesterSenderId: 'telegram:999',
      channel: 'telegram',
      to: '999',
      delivery: { send: delivery.send },
      deliveryContext: { channel: 'telegram', to: '999' },
    });
    expect(delivery.send).not.toHaveBeenCalled();
    expect(r.text).not.toContain('Direct preview delivery');
  });

  it('with a credible context, forged route arguments change neither the attempt nor its payload', async () => {
    const { tools, delivery } = setup();
    await find(tools, 'popclaw_draft_message').execute('draft', {
      recipient: 'Recipient Fixture',
      body: SHORT_BODY,
    });
    await find(tools, 'popclaw_draft_message').execute('draft2', {
      recipient: 'Recipient Fixture',
      body: SHORT_BODY,
      channel: 'whatsapp',
      to: 'evil-destination',
      deliveryContext: { channel: 'whatsapp', to: 'evil-destination' },
    });
    // The trusted route (the factory context's capability) is the only one
    // consulted — one attempt per draft, and the payloads are identical
    // modulo the sequential draft id.
    expect(delivery.send).toHaveBeenCalledTimes(2);
    expect(delivery.captured[0]!.text!.replace(/message-\d+/, 'N')).toBe(
      delivery.captured[1]!.text!.replace(/message-\d+/, 'N'),
    );
    for (const req of delivery.captured) {
      expect(req.text).toContain('Recipient Fixture#');
      // Text only — a local attachment path is never laundered into mediaUrl.
      expect(Object.keys(req)).toEqual(['text']);
    }
  });
});

// ---------------------------------------------------------------------------
// The preview goes only where the approval goes (ruling 2026-09-21T20:09Z:
// "the approve button being in the private chat does not prove the full text
// before it was also in the private chat"). Off webchat/tui the push now waits
// for the same decision the owner-approval seam makes about this turn.
// ---------------------------------------------------------------------------

describe('the preview goes only where the approval goes', () => {
  const pinnedElsewhere = () => {
    const cfg = pinnedToTheFixtureChat();
    cfg.approvals.plugin.targets = [{ channel: 'telegram', to: '99999', accountId: 'telegram' }];
    return cfg;
  };
  const forwardingOff = () => {
    const cfg = pinnedToTheFixtureChat();
    cfg.approvals.plugin.enabled = false;
    return cfg;
  };
  const sessionMode = () => {
    const cfg = pinnedToTheFixtureChat();
    cfg.approvals.plugin.mode = 'session';
    return cfg;
  };
  const noTargets = () => {
    const cfg = pinnedToTheFixtureChat();
    cfg.approvals.plugin.targets = [];
    return cfg;
  };

  it.each([
    ['the approval prompt is pinned to a DIFFERENT chat', pinnedElsewhere, 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN'],
    ['the mode resolves a second destination this plugin never checked', sessionMode, 'OWNER_ROUTE_MODE_NOT_TARGETS'],
    ['no approval target is configured at all', noTargets, 'OWNER_ROUTE_NO_TARGET'],
    ['this process holds no runtime snapshot to answer from', () => null, 'OWNER_ROUTE_CONFIG_UNAVAILABLE'],
  ])('%s → nothing is pushed, and the note names the reason', async (_label, cfg, reason) => {
    const config = cfg();
    if (config === null) clearRuntimeConfigSnapshot();
    else setRuntimeConfigSnapshot(config as never);
    const { tools, delivery } = setup();
    const r = await find(tools, 'popclaw_draft_message').execute('draft', {
      recipient: 'Recipient Fixture',
      body: SHORT_BODY,
    });
    // The private body never reached a chat this host would not have asked in.
    expect(delivery.send).not.toHaveBeenCalled();
    expect(delivery.captured).toHaveLength(0);
    // Not a silent skip: the reason is named, and the agent is told where the
    // full text actually is.
    expect(r.text).toContain(reason);
    expect(r.text).toContain('not the chat');
    expect(r.text).toContain(SHORT_BODY);
    expect(draftPreviewStats().unavailable).toBe(1);
    expect(draftPreviewStats().routeRefused).toBe(1);
    expect(draftPreviewStats().lastReason).toBe(reason);
    for (const sender of SENDERS) expect(sender).not.toHaveBeenCalled();
  });

  it.each([
    ['en', /has not enabled plugin approval forwarding/, /chat.*does not replace/i, /may expire/],
    ['zh-CN', /尚未开启插件审批转发/, /普通聊天.*不能替代/, /有效期/],
  ] as const)('names disabled forwarding in the preview (%s) and attempts no delivery', async (lang, disabled, chatConsent, expiry) => {
    setOwnerLang(lang, 'config');
    setRuntimeConfigSnapshot(forwardingOff() as never);
    const { tools, delivery } = setup();
    const r = await find(tools, 'popclaw_draft_message').execute('draft', {
      recipient: 'Recipient Fixture', body: SHORT_BODY,
    });
    expect(r.text).toContain('OWNER_ROUTE_FORWARDING_DISABLED');
    expect(r.text).toMatch(disabled);
    expect(r.text).toMatch(chatConsent);
    expect(r.text).toMatch(expiry);
    expect(r.text).not.toMatch(/not the chat|不是.*聊天/);
    expect(r.text).toContain(SHORT_BODY);
    expect(delivery.send).not.toHaveBeenCalled();
    expect(delivery.captured).toHaveLength(0);
    expect(draftPreviewStats().routeRefused).toBe(1);
    expect(draftPreviewStats().lastReason).toBe('OWNER_ROUTE_FORWARDING_DISABLED');
    for (const sender of SENDERS) expect(sender).not.toHaveBeenCalled();
  });

  it('a turn inside a thread is refused: the route comparison cannot see a thread', async () => {
    const { tools, delivery } = setup(
      ownerToolCtx({ deliveryContext: { channel: 'telegram', to: '12345', accountId: 'telegram', threadId: 'topic-7' } }),
    );
    const r = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(delivery.send).not.toHaveBeenCalled();
    expect(r.text).toContain('PREVIEW_ROUTE_TURN_THREADED');
    expect(r.text).toContain(SHORT_BODY);
  });

  it('the pinned approval chat IS this chat → pushed exactly as before', async () => {
    const { tools, delivery } = setup();
    await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(delivery.captured[0]!.text).toContain(SHORT_BODY);
    expect(draftPreviewStats().routeRefused).toBe(0);
  });

  it.each(['webchat', 'tui'])('an owner-direct origin (%s) still pushes with no approval routing configured', async (channel) => {
    clearRuntimeConfigSnapshot();
    const { tools, delivery } = setup(ownerDirectCtx(channel, 'owner'));
    await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(delivery.captured[0]!.text).toContain(SHORT_BODY);
  });

  it('an MCP root keeps its silent unavailable: no capability, no reason, no note', async () => {
    clearRuntimeConfigSnapshot();
    const tools = register({});
    const r = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(r.text).not.toContain('Direct preview delivery');
    expect(r.text).not.toContain('OWNER_ROUTE_');
    expect(draftPreviewStats().unavailable).toBe(1);
    expect(draftPreviewStats().routeRefused).toBe(0);
    expect(draftPreviewStats().lastReason).toBeNull();
  });

  it.each([
    ['en-US', 'is not the chat this host would ask the owner for approval in'],
    ['zh-CN', '不是宿主会向主人征求批准的那个聊天'],
  ])('the refusal note reads in %s', async (language, sentence) => {
    setOwnerLang(language, 'config');
    setRuntimeConfigSnapshot(pinnedElsewhere() as never);
    const { tools } = setup();
    const r = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(r.text).toContain(sentence);
  });
});

// ---------------------------------------------------------------------------
// The tool RESULT is the agent's copy, and only the agent's: this module hands
// it back and pushes nothing. The preview it pushes is the bare preview — the
// confirmation discipline and the delivery note are added AROUND it afterwards
// and never leave the tool result.
// ---------------------------------------------------------------------------

describe('the tool result is returned, never pushed', () => {
  it('the one captured request is the bare preview, and the result is a strict superset of it', async () => {
    const { tools, delivery } = setup();
    const r = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(delivery.send).toHaveBeenCalledTimes(1);
    const pushed = delivery.captured[0]!.text!;
    expect(r.text).toContain(pushed);
    expect(r.text.length).toBeGreaterThan(pushed.length);
    // Everything the result adds stays in the result.
    expect(pushed).not.toContain('only after the owner has explicitly said to send');
    expect(pushed).not.toContain('Direct preview delivery');
  });

  it('a refused route pushes nothing at all, so the result is the only copy', async () => {
    setRuntimeConfigSnapshot(forwardingOffFixture() as never);
    const { tools, delivery } = setup();
    const r = await find(tools, 'popclaw_draft_post').execute('draft', { body: SHORT_BODY });
    expect(delivery.send).not.toHaveBeenCalled();
    expect(r.text).toContain(SHORT_BODY);
  });
});

/** Local to the block above; the refusal shape does not matter there. */
function forwardingOffFixture() {
  const cfg = pinnedToTheFixtureChat();
  cfg.approvals.plugin.enabled = false;
  return cfg;
}
