/** Adapter for the injected OpenClaw 2026.8.2 API audited in openclaw-world-turn-audit.md. */
import type { PluginRuntime } from 'openclaw/plugin-sdk/core';
import { cidFromCanonical } from '@popclaw/algorithms';
import { captureHostWorldTurnEvidence, type HostWorldOutputEvidence, type HostWorldTurnHost } from '../runtime/host-world-turn.js';

export interface OpenClawWorldTurnRuntime {
  gateway: Pick<PluginRuntime['gateway'], 'isAvailable'>;
  subagent: Pick<PluginRuntime['subagent'], 'run' | 'waitForRun' | 'getSessionMessages'>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (value: string) => cidFromCanonical(new TextEncoder().encode(value));
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function transcriptText(value: unknown, role: 'user' | 'assistant', runId: string): string | null {
  const message = record(value);
  if (!message || message.role !== role || (message.runId !== undefined && message.runId !== runId)) return null;
  // Tool calls can appear either as content blocks or provider-shaped fields.
  if (['tool_calls', 'toolCalls', 'function_call', 'functionCall', 'toolCallId', 'tool_call_id'].some(key => message[key] !== undefined)) return null;
  if (role === 'assistant' && message.stopReason !== undefined && !['stop', 'end_turn'].includes(String(message.stopReason))) return null;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content) || !message.content.length) return null;
  const blocks: string[] = [];
  for (const value of message.content) {
    const block = record(value);
    if (!block || block.type !== 'text' || typeof block.text !== 'string'
      || Object.keys(block).some(key => !['type', 'text'].includes(key))) return null;
    blocks.push(block.text);
  }
  return blocks.join('');
}

export function createOpenClawWorldTurnHost(options: { runtime: OpenClawWorldTurnRuntime; agentId: string }): HostWorldTurnHost {
  const { runtime, agentId } = options;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) throw new Error('OPENCLAW_WORLD_AGENT_INVALID');
  if (typeof runtime?.gateway?.isAvailable !== 'function' || typeof runtime?.subagent?.run !== 'function'
    || typeof runtime?.subagent?.waitForRun !== 'function' || typeof runtime?.subagent?.getSessionMessages !== 'function') throw new Error('OPENCLAW_WORLD_RUNTIME_UNAVAILABLE');
  const session = (token: string): string => {
    if (!uuid.test(token)) throw new Error('OPENCLAW_WORLD_RUN_INVALID');
    return `agent:${agentId}:popclaw-world-turn:${token}`;
  };
  const checkRun = (runId: string, sessionKey?: string) => {
    const prefix = 'popclaw-world-turn:';
    if (!runId.startsWith(prefix) || !uuid.test(runId.slice(prefix.length))) throw new Error('OPENCLAW_WORLD_RUN_INVALID');
    if (sessionKey !== undefined && sessionKey !== session(runId.slice(prefix.length))) throw new Error('OPENCLAW_WORLD_SESSION_INVALID');
  };
  return {
    id: 'openclaw',
    createSessionKey: session,
    // Availability proves a current Gateway binding, never model authorization.
    isAvailable: () => runtime.gateway.isAvailable(),
    run: async ({ runId, sessionKey, prompt }) => {
      checkRun(runId, sessionKey);
      return runtime.subagent.run({ sessionKey, message: prompt, idempotencyKey: runId,
        disableTools: true, promptMode: 'minimal', deliver: false });
    },
    waitForRun: async ({ runId, timeoutMs }) => {
      checkRun(runId);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw new Error('OPENCLAW_WORLD_WAIT_INVALID');
      // The installed JS retains runId and terminalReply in metadata, despite
      // runId being omitted from the public AgentWaitResult declaration.
      return runtime.subagent.waitForRun({ runId, timeoutMs });
    },
    readOutput: async request => {
      const unverified = (reason: string, evidence?: Record<string, unknown>): HostWorldOutputEvidence => ({ kind: 'unverified', reason, ...(evidence ? { evidence } : {}) });
      checkRun(request.runId, request.sessionKey);
      const terminal = record(request.terminal), reply = record(terminal?.terminalReply);
      if (!terminal || terminal.runId !== request.runId || terminal.status !== 'ok') return unverified('OPENCLAW_WORLD_TERMINAL_NOT_BOUND');
      if ((terminal.sessionKey !== undefined && terminal.sessionKey !== request.sessionKey) || terminal.pendingError === true
        || terminal.providerStarted === false || terminal.yielded === true) return unverified('OPENCLAW_WORLD_TERMINAL_CONFLICT');
      if (terminal.terminalReceipt !== undefined) {
        const receipt = record(terminal.terminalReceipt);
        if (!receipt || receipt.runId !== request.runId || !Array.isArray(receipt.successfulToolNames)
          || receipt.successfulToolNames.length !== 0) return unverified('OPENCLAW_WORLD_TERMINAL_RECEIPT_CONFLICT');
      }
      // This is the actual SDK union: visible{text}, silent, or empty. Neither
      // silent nor empty is invented into an action/result or a text response.
      if (!reply || reply.disposition !== 'visible' || typeof reply.text !== 'string' || !reply.text.length
        || Object.keys(reply).some(key => !['disposition', 'text'].includes(key))) return unverified('OPENCLAW_WORLD_TERMINAL_TEXT_UNAVAILABLE');
      const capturedReply = reply.text, capturedPrompt = request.prompt;
      const capturedRun = request.runId, capturedSession = request.sessionKey;
      const response = captureHostWorldTurnEvidence(await runtime.subagent.getSessionMessages({ sessionKey: capturedSession, limit: 1000 }));
      const messages = response.messages;
      if (!Array.isArray(messages) || messages.length !== 2) return unverified('OPENCLAW_WORLD_SESSION_NOT_SINGLE_TURN');
      const user = transcriptText(messages[0], 'user', capturedRun), assistant = transcriptText(messages[1], 'assistant', capturedRun);
      // terminalReply is sanitized/trimmed and can be truncated at 4096 chars.
      // Exact equality prevents returning a clipped reply as complete raw output.
      if (user !== capturedPrompt || assistant !== capturedReply) return unverified('OPENCLAW_WORLD_TRANSCRIPT_NOT_BOUND');
      return { kind: 'bound', text: assistant, source: 'terminal_reply_and_dedicated_transcript', evidence: {
        runId: capturedRun, sessionKey: capturedSession, messageCount: 2,
        promptDigest: hash(capturedPrompt), outputDigest: hash(assistant), transcriptDigest: hash(JSON.stringify(messages)),
      } };
    },
  };
}
