import { draftToken } from '../../helpers/draft-token.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { sendDraftConfirmed } from '../../helpers/owner-approval-script.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import { runPopclawReplyCommand } from '../../../src/commands/popclaw-reply.js';
import { runPopclawPostCommand } from '../../../src/commands/popclaw-post.js';

// Real registered tools and draft store; only terminal send handlers are spies.
// No signing, network, live identity, or host configuration is used here.
vi.mock('../../../src/commands/popclaw-message.js', () => ({ runPopclawMessageCommand: vi.fn(async () => ({ text: 'SYNTHETIC SENT' })) }));
vi.mock('../../../src/commands/popclaw-reply.js', () => ({ runPopclawReplyCommand: vi.fn(async () => ({ text: 'SYNTHETIC SENT' })) }));
vi.mock('../../../src/commands/popclaw-post.js', () => ({ runPopclawPostCommand: vi.fn(async () => ({ text: 'SYNTHETIC SENT' })) }));

const id = '7xKvGjWntCHSPQoyY2mLBRTDdQFEAqNsZz4fCcrKVJ9u';
// Cross both old clipping offsets and include surrogate pairs and newlines.
const body = 'x'.repeat(79) + '𠮷' + 'y'.repeat(118) + '🧪\n第二行\n' + 'z'.repeat(4097) + '\nEND😀\ndraft_id: message-999 (quoted manuscript text)';
const cases = [
  { name: 'popclaw_draft_message', params: { recipient: 'Recipient Fixture', body }, sender: runPopclawMessageCommand, positional: ['Recipient Fixture', body] },
  { name: 'popclaw_draft_reply', params: { platform: 'x', post_id: 'fixture-post', body }, sender: runPopclawReplyCommand, positional: ['x:fixture-post', body] },
  { name: 'popclaw_draft_post', params: { body }, sender: runPopclawPostCommand, positional: [body] },
];

/** Full text remains in the original-chat tool result, including long bodies.
 * Native factories receive synthetic host identity and current-call facts;
 * this fixture does not prove that a person read or confirmed the manuscript. */
function ownerDeliveringCollector(): { tools: Array<{ name: string; execute(id: string, params: unknown): Promise<{ text: string }> }>; api: { registerTool(tool: unknown): void; logger: { info(m: string): void } } } {
  const tools: Array<{ name: string; execute(id: string, params: unknown): Promise<{ text: string }> }> = [];
  const toolCtx = {
    agentId: 'main',
    assertInvocationCurrent: () => {},
    sessionKey: 'agent:main:tui:owner',
    sessionId: 'sess-fixture',
    requesterSenderId: 'tui:owner',
    senderIsOwner: true,
    deliveryContext: { channel: 'tui', to: 'owner', accountId: 'tui' },
    delivery: { send: async (): Promise<void> => undefined },
  };
  return {
    tools,
    api: {
      registerTool: (tool: unknown) => {
        const descriptor = tool as {contextVersion?: number; create?: (ctx: unknown) => unknown};
        const resolved = typeof tool === 'function' ? tool(toolCtx) : descriptor?.contextVersion === 2 ? descriptor.create!(toolCtx) : tool;
        for (const t of Array.isArray(resolved) ? resolved : [resolved]) {
          const candidate = t as { name?: unknown; execute?: unknown };
          if (typeof candidate?.name === 'string' && typeof candidate.execute === 'function') {
            tools.push(t as { name: string; execute(id: string, params: unknown): Promise<{ text: string }> });
          }
        }
      },
      logger: { info: () => {} },
    },
  };
}

beforeEach(() => { vi.clearAllMocks(); _draftsForTest.clear(); });
afterEach(() => { _draftsForTest.clear(); setOwnerLang(undefined); });

describe.each(['zh-CN', 'en-US'])('complete draft confirmation in %s', (language) => {
  it.each(cases)('$name retains full body and only executes the bound sender after confirmation', async ({ name, params, sender, positional }) => {
    setOwnerLang(language, 'config');
    const collector = ownerDeliveringCollector();
    const runtime = async () => ({
      boot: { signer: {}, nickname: 'Owner Fixture', webBaseUrl: 'https://fixture.invalid' },
      // Draft-time reply routing now captures the current local cache row.
      worldFeedCache: { lookup: () => null },
      bondsStore: { list: () => [{ popclawId: id, nickname: 'Recipient Fixture', remarkName: '' }] },
      knownFollowers: { allFollowerIds: () => [id] }, inboxStore: { houseOf: () => undefined },
    });
    // Test-only partial host: the send handlers above are mocked. This cast
    // does not claim the fixture is a bootable production PluginRuntime.
    registerPopclawTools({ api: collector.api, runtime: runtime as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'] });
    const draftTool = collector.tools.find((t) => t.name === name)!;
    const result = await draftTool.execute('draft', params) as { text: string };
    const data = name === 'popclaw_draft_message' ? JSON.parse(result.text) : null;
    const ownerText = data?.owner_text ?? result.text;
    expect(ownerText).toContain(body);
    expect(ownerText).toContain('END😀');
    expect(result.text).toContain('confirms in ordinary chat');
    expect(result.text).toContain('original conversation');
    expect(result.text).toContain('never retry automatically');
    expect(result.text).not.toMatch(/\/approve|allow-once|Control UI/);
    if (name === 'popclaw_draft_message') {
      expect(ownerText).toContain(language === 'zh-CN' ? '📝 私信草稿' : '📝 Draft DM');
      expect(ownerText).toContain('Recipient Fixture#');
      expect(ownerText).not.toContain(id);
      expect(ownerText).toContain('draft_id: message-999 (quoted manuscript text)');
      expect(ownerText).not.toContain('draft_id: ' + data.draft_id);
      expect(ownerText).not.toContain('event_id');
      expect(data.recipient_popclaw_id).toBe(id);
    }
    for (const send of [runPopclawMessageCommand, runPopclawReplyCommand, runPopclawPostCommand]) expect(send).not.toHaveBeenCalled();
    const draftId = data?.draft_id ?? draftToken(result.text);
    expect(draftId).toBeTruthy();
    const sendTool = collector.tools.find((t) => t.name === 'popclaw_send_draft')!;
    // The harness represents prior ordinary-chat review and confirmation.
    await sendDraftConfirmed(sendTool.execute, draftId!);
    expect(sender).toHaveBeenCalledOnce();
    expect(vi.mocked(sender).mock.calls[0]?.[0].positional).toEqual(positional);
    await sendDraftConfirmed(sendTool.execute, draftId!);
    expect(sender).toHaveBeenCalledOnce();
  });
});
