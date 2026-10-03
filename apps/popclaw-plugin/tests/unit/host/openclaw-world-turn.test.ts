import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenClawWorldTurnHost } from '../../../src/host/openclaw-world-turn.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { HostWorldTurn, sealHostWorldTurnInput, type HostWorldOutputRequest } from '../../../src/runtime/host-world-turn.js';

const token = '00000000-0000-4000-8000-000000000001', runId = `popclaw-world-turn:${token}`;
const sessionKey = `agent:main:popclaw-world-turn:${token}`, prompt = 'The exact world turn input', text = '{"candidate":"untrusted"}';
function fixture() {
  const run = vi.fn(async (input: { sessionKey: string; idempotencyKey?: string }) => ({ runId: input.idempotencyKey!, sessionKey: input.sessionKey,
    runtime: { harness: 'openclaw', provider: 'configured-provider', model: 'configured-model' } }));
  const waitForRun = vi.fn(async (input: { runId: string; timeoutMs?: number }) => ({ runId: input.runId, status: 'ok' as const, startedAt: 1000, endedAt: 2000,
    providerStarted: true, terminalReply: { disposition: 'visible' as const, text } }));
  const getSessionMessages = vi.fn(async () => ({ messages: [
    { role: 'user', content: [{ type: 'text', text: prompt }] },
    { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
  ] as unknown[] }));
  const deleteSession = vi.fn(async () => {}), request = vi.fn(), isAvailable = vi.fn(async () => true);
  const runtime = { gateway: { isAvailable, request }, subagent: { run, waitForRun, getSessionMessages, deleteSession } };
  const host = createOpenClawWorldTurnHost({ agentId: 'main', runtime });
  const output: HostWorldOutputRequest = { runId, sessionKey, prompt,
    terminal: { runId, status: 'ok', startedAt: 1000, endedAt: 2000, terminalReply: { disposition: 'visible', text } } };
  return { host, run, waitForRun, getSessionMessages, deleteSession, request, isAvailable, output };
}

describe('installed OpenClaw world turn adapter', () => {
  it('uses only the audited injected tool-free arguments and makes no provider or permission override', async () => {
    const f = fixture();
    expect(f.host.createSessionKey(token)).toBe(sessionKey);
    expect(await f.host.isAvailable()).toBe(true);
    const ack = await f.host.run({ runId, sessionKey, prompt });
    expect(ack).toMatchObject({ runId, sessionKey, runtime: { provider: 'configured-provider', model: 'configured-model' } });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledWith({ sessionKey, message: prompt, idempotencyKey: runId,
      disableTools: true, promptMode: 'minimal', deliver: false });
    await f.host.waitForRun({ runId, timeoutMs: 15 });
    expect(f.waitForRun).toHaveBeenCalledOnce(); expect(f.waitForRun).toHaveBeenCalledWith({ runId, timeoutMs: 15 });
    expect(f.request).not.toHaveBeenCalled(); expect(f.deleteSession).not.toHaveBeenCalled();
  });

  it('requires a dedicated one-turn namespace and never reuses a shared session key', async () => {
    const f = fixture();
    await expect(f.host.run({ runId, sessionKey: 'agent:main', prompt })).rejects.toThrow('OPENCLAW_WORLD_SESSION_INVALID');
    await expect(f.host.run({ runId: 'foreign_run', sessionKey, prompt })).rejects.toThrow('OPENCLAW_WORLD_RUN_INVALID');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('binds untrusted output to the original terminal reply and exactly one input/reply pair', async () => {
    const f = fixture();
    expect(await f.host.readOutput(f.output)).toMatchObject({ kind: 'bound', text, source: 'terminal_reply_and_dedicated_transcript',
      evidence: { runId, sessionKey, messageCount: 2 } });
    expect(f.getSessionMessages).toHaveBeenCalledOnce(); expect(f.getSessionMessages).toHaveBeenCalledWith({ sessionKey, limit: 1000 });
    expect(f.deleteSession).not.toHaveBeenCalled();
  });

  it.each([
    { runId: 'wrong', status: 'ok', terminalReply: { disposition: 'visible', text } },
    { runId, status: 'pending', terminalReply: { disposition: 'visible', text } },
    { runId, status: 'timeout', terminalReply: { disposition: 'visible', text } },
    { runId, status: 'error', terminalReply: { disposition: 'visible', text } },
    { runId, status: 'ok' },
    { runId, status: 'ok', terminalReply: { disposition: 'silent' } },
    { runId, status: 'ok', terminalReply: { disposition: 'empty' } },
    { runId, status: 'ok', terminalReply: { disposition: 'visible', text: 7 } },
    { runId, sessionKey: 'agent:main:foreign', status: 'ok', terminalReply: { disposition: 'visible', text } },
    { runId, status: 'ok', terminalReceipt: { runId: 'foreign' }, terminalReply: { disposition: 'visible', text } },
    { runId, status: 'ok', terminalReceipt: { runId, successfulToolNames: ['send'] }, terminalReply: { disposition: 'visible', text } },
  ])('does not read transcript without verified original-run terminal text: %j', async terminal => {
    const f = fixture();
    expect(await f.host.readOutput({ ...f.output, terminal })).toMatchObject({ kind: 'unverified' });
    expect(f.getSessionMessages).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ role: 'assistant', content: text }],
    [{ role: 'user', content: 'foreign prompt' }, { role: 'assistant', content: text }],
    [{ role: 'user', content: prompt }, { role: 'assistant', content: 'wrong output' }],
    [{ role: 'user', content: prompt }, { role: 'assistant', content: text }, { role: 'assistant', content: text }],
    [{ role: 'user', content: 'prior turn' }, { role: 'assistant', content: 'prior output' }, { role: 'user', content: prompt }, { role: 'assistant', content: text }],
    [{ role: 'user', content: prompt }, { role: 'assistant', content: [{ type: 'toolCall', name: 'send' }, { type: 'text', text }] }],
    [{ role: 'user', content: prompt }, { role: 'assistant', content: text, tool_calls: [{ name: 'send' }] }],
    [{ role: 'user', content: prompt }, { role: 'assistant', content: text, runId: 'foreign' }],
    [{ role: 'user', content: prompt }, { role: 'assistant', content: text + 'long original tail omitted from terminalReply' }],
  ])('keeps contaminated, truncated, or unbound transcript unverified: %j', async (...messages) => {
    const f = fixture(); f.getSessionMessages.mockResolvedValue({ messages });
    expect(await f.host.readOutput(f.output)).toMatchObject({ kind: 'unverified' });
  });

  it('does not substitute the last assistant when transcript evidence is absent or the SDK read fails', async () => {
    const f = fixture(); f.getSessionMessages.mockRejectedValue(new Error('SESSION_READ_UNAVAILABLE'));
    await expect(f.host.readOutput(f.output)).rejects.toThrow('SESSION_READ_UNAVAILABLE');
    expect(f.run).not.toHaveBeenCalled(); expect(f.deleteSession).not.toHaveBeenCalled();
  });

  it.each([false, true])('composes the real journal and adapter with controlled SDK responses (cancel=%s)', async cancelled => {
    const f = fixture(), root = mkdtempSync(join(tmpdir(), 'openclaw-world-turn-')), db = new LocalHostDb(join(root, 'journal.db'));
    const journal = new HostWorldTurn({ db, host: f.host, now: () => 1000 });
    const actor = '11111111111111111111111111111111', input = sealHostWorldTurnInput({
      house: { origin: 'https://world.invalid', houseKey: actor, incarnation: 'inc_1' }, actorId: actor,
      installationId: 'install_1', sessionId: 'session_1', fence: '1', jobId: 'job_1', turnId: 'turn_1', ticketId: 'ticket_1',
      prompt, contextDigest: 'a'.repeat(64), validUntil: 1100, ticketExpiresAt: 1150, sessionLeaseExpiresAt: 1200 });
    const abort = new AbortController(), authority = { gate: { origin: input.house.origin, generation: 1, signal: abort.signal, isActive: () => !abort.signal.aborted }, check: () => {} };
    let release = () => {};
    try {
      const accepted = await journal.startOnce(input, authority);
      expect(accepted.state).toBe('accepted');
      if (cancelled) {
        const response = await f.getSessionMessages();
        const pending = new Promise<typeof response>(resolve => { release = () => resolve(response); });
        f.getSessionMessages.mockClear(); f.getSessionMessages.mockReturnValue(pending);
      }
      const reconciling = journal.reconcile(input, authority, { timeoutMs: 10 });
      if (cancelled) {
        await vi.waitFor(() => expect(f.getSessionMessages).toHaveBeenCalledOnce());
        abort.abort(); journal.stop();
        let idle = false; const joining = journal.whenIdle().then(() => { idle = true; });
        await Promise.resolve(); expect(idle).toBe(false);
        release(); await joining;
      }
      const result = await reconciling;
      expect(result.state).toBe(cancelled ? 'cancel_pending' : 'completed');
      expect(result.output?.text).toBe(cancelled ? undefined : text);
      expect(f.run).toHaveBeenCalledOnce(); expect(f.waitForRun).toHaveBeenCalledOnce();
      expect(f.waitForRun).toHaveBeenCalledWith({ runId: accepted.runId, timeoutMs: 10 });
      expect(f.getSessionMessages).toHaveBeenCalledWith({ sessionKey: accepted.acceptedSessionKey, limit: 1000 });
      expect(f.request).not.toHaveBeenCalled(); expect(f.deleteSession).not.toHaveBeenCalled();
    } finally { release(); journal.stop(); await journal.whenIdle(); db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
