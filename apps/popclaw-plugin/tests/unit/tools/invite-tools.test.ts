import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { _draftsForTest, expiredDraftText, makeDraftToken, putDraft } from '../../../src/tools/draft-store.js';
import { sendDraftConfirmed } from '../../helpers/owner-approval-script.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';

// The tool renders in ownerLang(); pin the en lane so the assertions below read
// as the copy an English-speaking owner actually sees.
beforeAll(() => setOwnerLang('en', 'config'));

/** Same fake api shape as register-tools.test.ts: captures registered tools. */
function buildFakeApi() {
  const tools: Array<{
    name: string;
    description?: string;
    parameters?: { properties?: Record<string, unknown> };
    execute: (callId: string, params: unknown) => Promise<{ type: string; text: string }>;
  }> = [];
  const push = (tool: { name?: string; execute?: unknown }) => {
    if (tool?.name && typeof tool.execute === 'function') tools.push(tool as (typeof tools)[number]);
  };
  const api = {
    registerTool: (tool: unknown, _opts?: unknown) => {
      const resolved =
        typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({ agentId: 'main-agent' }) : tool;
      if (Array.isArray(resolved)) resolved.forEach((t) => push(t as { name?: string; execute?: unknown }));
      else push(resolved as { name?: string; execute?: unknown });
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  return { api, tools };
}

/** A runtime carrying exactly what the invite path touches. */
function makeFx(opts: { taskId?: string | undefined } = {}) {
  const initiate = vi.fn(async (_o: unknown) => ({
    expectedSigil: 'abcdef',
    pushedEventId: 'event-1',
    push: {
      status: 200,
      eventId: 'event-1',
      deduplicated: false,
      ...('taskId' in opts ? { taskId: opts.taskId } : { taskId: 'task-1' }),
    },
  }));
  const add = vi.fn();
  const runtime = vi.fn(async () => ({
    initiator: { initiate },
    pendingInvites: { add },
    inviteWatch: { logger: { info: vi.fn() } },
    boot: { nickname: 'Blackfeather', webBaseUrl: 'https://popclaw.me' },
  })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'];
  return { initiate, add, runtime };
}

function toolsOf(runtime: Parameters<typeof registerPopclawTools>[0]['runtime']) {
  const { api, tools } = buildFakeApi();
  // The MCP dep shape: no world/onboarding getters, no inboundMediaDirs, wallet off.
  registerPopclawTools({socialSendHost: 'local-stdio',  api, runtime });
  const find = (name: string) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`${name} was not registered`);
    return t;
  };
  return { find };
}

function inviteTool(runtime: Parameters<typeof registerPopclawTools>[0]['runtime']) {
  return toolsOf(runtime).find('popclaw_invite');
}

beforeEach(() => _draftsForTest.clear());
afterEach(() => {
  vi.useRealTimers();
  _draftsForTest.clear();
});

describe('popclaw_invite (preview → confirm)', () => {
  it('registers on the MCP dep shape (no world deps, no inboundMediaDirs)', () => {
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);
    expect(tool.description!.length).toBeLessThanOrEqual(600);
    expect(Object.keys(tool.parameters?.properties ?? {})).toEqual(
      expect.arrayContaining(['platform', 'handle', 'proof_url', 'sync', 'confirm_token']),
    );
  });

  it('the first call previews the canonicalised payload and submits nothing', async () => {
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);

    const r = await tool.execute('c1', { posted:true, platform: 'Twitter', handle: '@blackfeather' });

    expect(fx.initiate).not.toHaveBeenCalled();
    expect(fx.add).not.toHaveBeenCalled();
    expect(r.text).toMatch(/platform: x\b/); // "Twitter" canonicalised before anything is signed
    expect(r.text).not.toContain('Twitter');
    expect(r.text).toMatch(/handle: blackfeather\b/);
    expect(r.text).not.toContain('@blackfeather'); // the leading @ is stripped here, not server-side
    // A nickname is submitted either way — absent, it becomes the owner's own
    // name. The preview has to say which, or the owner approves an unseen field.
    expect(r.text).toContain(renderCopy('en', 'invite.tool.nicknameDefault'));
    expect(r.text).toMatch(/invite-\d+/);
  });

  it('the preview names an explicit nickname instead of the owner default', async () => {
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);

    const r = await tool.execute('c1', { posted:true, platform: 'x', handle: 'blackfeather', nickname: 'Kaito' });

    expect(r.text).toMatch(/nickname: Kaito\b/);
    expect(r.text).not.toContain(renderCopy('en', 'invite.tool.nicknameDefault'));
  });

  it('the confirm call submits once with the canonicalised args and records the pending invite', async () => {
    vi.useFakeTimers(); // watchInvite's poll loop must not outlive the test
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);

    const preview = await tool.execute('c1', {
      posted:true, platform: 'Twitter',
      handle: '@blackfeather',
      proof_url: 'https://x.com/blackfeather/status/1234567890',
      sync: true,
    });
    const token = preview.text.match(/invite-\d+/)![0];

    const done = await tool.execute('c2', { confirm_token: token });

    expect(fx.initiate).toHaveBeenCalledTimes(1);
    expect(fx.initiate).toHaveBeenCalledWith({
      platform: 'x',
      handle: 'blackfeather',
      nickname: 'Blackfeather',
      replace: false,
      proofUrl: 'https://x.com/blackfeather/status/1234567890',
      mirrorOptin: true,
    });
    expect(fx.add).toHaveBeenCalledWith({
      taskId: 'task-1',
      platform: 'x',
      handle: 'blackfeather',
      sigil: 'abcdef',
      proofUrl: 'https://x.com/blackfeather/status/1234567890',
    });
    expect(done.text).toContain('blackfeather#abcdef');
  });

  it('a receipt without a task_id still submits, it just has nothing to watch', async () => {
    const fx = makeFx({ taskId: undefined });
    const tool = inviteTool(fx.runtime);
    const preview = await tool.execute('c1', { posted:true, platform: 'x', handle: 'blackfeather' });
    await tool.execute('c2', { confirm_token: preview.text.match(/invite-\d+/)![0] });
    expect(fx.initiate).toHaveBeenCalledTimes(1);
    expect(fx.add).not.toHaveBeenCalled();
  });

  it('--sync is opt-in: absent means the mirror consent was never given', async () => {
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);
    const preview = await tool.execute('c1', { posted:true, platform: 'x', handle: 'blackfeather' });
    await tool.execute('c2', { confirm_token: preview.text.match(/invite-\d+/)![0] });
    expect(fx.initiate).toHaveBeenCalledWith(expect.objectContaining({ mirrorOptin: false }));
  });

  // ADR-0026: replace takes the platform's existing verified account away. The
  // owner cannot consent to what the preview didn't show them.
  it('the preview spells out replace, and stays quiet about it when it is off', async () => {
    vi.useFakeTimers();
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);

    const plain = await tool.execute('c1', { posted:true, platform: 'x', handle: 'blackfeather' });
    expect(plain.text).not.toContain(renderCopy('en', 'invite.tool.replaceLine'));

    const swap = await tool.execute('c2', { posted:true, platform: 'x', handle: 'blackfeather', replace: true });
    expect(swap.text).toContain(renderCopy('en', 'invite.tool.replaceLine'));

    await tool.execute('c3', { confirm_token: swap.text.match(/invite-\d+/)![0] });
    expect(fx.initiate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
  });

  it('a malformed proof link is refused at preview — never signed, never stored', async () => {
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);

    const r = await tool.execute('c1', {
      posted:true, platform: 'x',
      handle: 'blackfeather',
      proof_url: 'https://x.com/blackfeather',
    });

    expect(fx.initiate).not.toHaveBeenCalled();
    expect(r.text).not.toMatch(/invite-\d+/); // no token minted → nothing to confirm
    expect(r.text).toContain(renderCopy('en', 'invite.badProofUrl', { got: 'https://x.com/blackfeather' }));
  });

  // `proof_url: ""` used to coerce to undefined and submit with no proof at all:
  // the owner thinks their post is attached, verification quietly falls back to
  // search, and the REJECT surfaces ~5min later. The slash lane already refuses
  // `--proof ""` at preflight — this lane has to give the same answer.
  it('an empty or whitespace proof_url is refused, not silently dropped', async () => {
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);

    for (const blank of ['', '   ']) {
      const r = await tool.execute('c1', { posted:true, platform: 'x', handle: 'blackfeather', proof_url: blank });
      expect(fx.initiate).not.toHaveBeenCalled();
      expect(r.text).not.toMatch(/invite-\d+/); // no token minted → nothing to confirm
      expect(r.text).toContain(renderCopy('en', 'invite.badProofUrl', { got: blank }));
    }
  });

  it('asks for the missing half instead of guessing it', async () => {
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);
    const r = await tool.execute('c1', { posted:true, platform: 'x' });
    expect(fx.initiate).not.toHaveBeenCalled();
    expect(r.text).toContain(renderCopy('en', 'invite.tool.usage'));
  });

  it('a confirm_token is single-use', async () => {
    vi.useFakeTimers();
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);
    const preview = await tool.execute('c1', { posted:true, platform: 'x', handle: 'blackfeather' });
    const token = preview.text.match(/invite-\d+/)![0];

    await tool.execute('c2', { confirm_token: token });
    const again = await tool.execute('c3', { confirm_token: token });

    expect(fx.initiate).toHaveBeenCalledTimes(1);
    expect(again.text).toContain(renderCopy('en', 'invite.tool.expiredToken', { token }));
  });

  // The draft table is shared with the write chain, and the guard has to hold in
  // BOTH directions — popclaw_send_draft says it sends "a draft (reply / DM /
  // post)", and popclaw_invite's own copy promises a confirm_token belongs to it
  // alone. A one-way check would make both of those statements false.
  it('popclaw_send_draft refuses an invite token instead of submitting the invite', async () => {
    vi.useFakeTimers();
    const fx = makeFx();
    const { find } = toolsOf(fx.runtime);

    const preview = await find('popclaw_invite').execute('c1', { posted:true, platform: 'x', handle: 'blackfeather' });
    const token = preview.text.match(/invite-\d+/)![0];

    // Even with the owner willing to approve, the wrong door stays shut: an
    // invite token carries no send snapshot, so there is nothing to approve.
    const wrongDoor = await sendDraftConfirmed(find('popclaw_send_draft').execute, token);

    expect(fx.initiate).not.toHaveBeenCalled();
    expect(wrongDoor.text).toContain(expiredDraftText(token));
    // And refusing must not have eaten the token: the right door still works.
    await find('popclaw_invite').execute('c3', { confirm_token: token });
    expect(fx.initiate).toHaveBeenCalledTimes(1);
  });

  // The token is spent before initiate runs (it is single-use by design), so a
  // failed submission leaves the agent holding a dead token. Say so, or it retries
  // with the token forever.
  it('a failed submission says the token is spent and how to get a new one', async () => {
    vi.useFakeTimers();
    const fx = makeFx();
    fx.initiate.mockRejectedValueOnce(new Error('lore-house unreachable'));
    const tool = inviteTool(fx.runtime);

    const preview = await tool.execute('c1', { posted:true, platform: 'x', handle: 'blackfeather' });
    const failed = await tool.execute('c2', { confirm_token: preview.text.match(/invite-\d+/)![0] });

    expect(failed.text).toContain('lore-house unreachable');
    expect(failed.text).toContain(renderCopy('en', 'invite.tool.submitFailed'));
  });

  // The draft table is shared with the write chain. Handing popclaw_invite a
  // message draft_id must not fire that DM through the verification door.
  it('refuses a token minted by another tool instead of firing it', async () => {
    const fx = makeFx();
    const tool = inviteTool(fx.runtime);
    const sent = vi.fn(async () => ({ text: 'the DM went out' }));
    const foreign = makeDraftToken('message');
    putDraft(foreign, sent);

    const r = await tool.execute('c1', { confirm_token: foreign });

    expect(sent).not.toHaveBeenCalled();
    expect(fx.initiate).not.toHaveBeenCalled();
    expect(r.text).toContain(renderCopy('en', 'invite.tool.expiredToken', { token: foreign }));
  });
});
