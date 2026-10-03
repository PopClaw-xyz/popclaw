import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { registerOpenClawPromptHooks, type OpenClawPromptHookPorts } from '../../../src/host/openclaw-prompt-hooks.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import type { Notifier } from '../../../src/notifier/notifier.js';
import type { PendingFollowStore } from '../../../src/social-graph/pending-follow-store.js';
import { _resetBudgetForTest, lastContextTokens } from '../../../src/newspaper/host-budget.js';
import { resetRoutingStats, routingStats } from '../../../src/routing/stats.js';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  _resetBudgetForTest();
  resetRoutingStats();
  vi.unstubAllEnvs();
});
const OWNER = { trigger: 'user', sessionKey: 'agent:main:main' };
type Hook = (event: unknown, context?: unknown) => unknown;

function harness(failAt?: string) {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-prompt-owner-'));
  roots.push(root);
  const hooks = new Map<string, Hook>();
  const logs: string[] = [];
  const calls: string[] = [];
  const api = {
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
    on(this: unknown, name: string, hook: Hook) {
      expect(this).toBe(api);
      calls.push(name);
      if (name === failAt) throw new Error('REGISTER-BOOM');
      hooks.set(name, hook);
    },
  };
  let notifier: Notifier | undefined;
  let pending: PendingFollowStore | undefined;
  const ports: OpenClawPromptHookPorts = {
    routingPaths: vi.fn(() => new PopclawPaths(root)),
    runtimeConfig: vi.fn(() => ({})),
    inboundMediaDirs: [],
    notifierForTurn: vi.fn(() => notifier),
    proposalsForTurn: vi.fn(() => undefined),
    namesForTurn: vi.fn(() => undefined),
    pendingFollowsForTurn: vi.fn(() => pending),
  };
  const register = () => registerOpenClawPromptHooks(api as unknown as Pick<OpenClawPluginApi, 'on' | 'logger'>, ports);
  return { hooks, logs, calls, ports, register, setNotifier: (n: Notifier | undefined) => { notifier = n; }, setPending: (p: PendingFollowStore) => { pending = p; } };
}
function queue(order: string[]): Notifier {
  let count = 1;
  return {
    count: () => count,
    drain: () => { order.push('drain'); count = 0; return [{ id: 1, level: 'L2', kind: 'system_notice', payload: { text: 'OWNER-MARKER' }, enqueuedAt: 0 }]; },
    enqueue: () => { order.push('requeue'); count++; },
  };
}

describe('complete OpenClaw prompt hook owner', () => {
  it('registers in order on the original receiver without reading lazy paths, config or slots', () => {
    const h = harness();
    expect(h.register()).toBe('wired');
    expect(h.calls).toEqual(['model_call_started', 'before_prompt_build']);
    for (const reader of Object.values(h.ports).filter(v => typeof v === 'function')) expect(reader).not.toHaveBeenCalled();
    expect(routingStats().mode).toBe('wired');
    expect(h.logs).toEqual([expect.stringMatching(/^popclaw: routing wired via api.on\(before_prompt_build\) · trace=/)]);
  });

  it('syncs each budget even after announcements are capped, preserving default and named session keys', () => {
    const h = harness(); h.register();
    const budget = h.hooks.get('model_call_started')!;
    budget({ contextTokenBudget: undefined });
    budget({ contextTokenBudget: 32_000 });
    budget({ sessionKey: 'chat', contextTokenBudget: 128_000 });
    budget({ sessionKey: 'chat', contextTokenBudget: 256_000 });
    for (let i = 0; i < 63; i++) budget({ sessionKey: `workshop:${i}`, contextTokenBudget: 64_000 });
    expect(h.logs.filter(l => l.includes('budget synced'))).toHaveLength(64);
    expect(lastContextTokens()).toBe(32_000);
    expect(lastContextTokens('chat')).toBe(256_000);
    expect(lastContextTokens('workshop:62')).toBe(64_000);
    expect(h.logs).toContain('popclaw: newspaper budget synced — session "" — context 32000 tokens → 16000 units per tool result');
    expect(h.ports.routingPaths).not.toHaveBeenCalled();
    expect(h.ports.notifierForTurn).not.toHaveBeenCalled();
  });

  it.each(['model_call_started', 'before_prompt_build'])('reports unavailable when %s registration throws; accepted earlier hooks remain', failed => {
    const h = harness(failed);
    expect(h.register()).toBe('unavailable');
    expect(routingStats().mode).toBe('unavailable');
    expect(h.hooks.has('model_call_started')).toBe(failed === 'before_prompt_build');
    expect(h.hooks.has('before_prompt_build')).toBe(false);
    expect(h.logs).toEqual([
      'popclaw: before_prompt_build registration failed — Error: REGISTER-BOOM',
      expect.stringMatching(/^popclaw: routing unavailable \(hook registration failed\) — L1\/L2 off · trace=/),
    ]);
    expect(h.ports.routingPaths).not.toHaveBeenCalled();
  });

  it('reads current slots synchronously on each turn, caches only paths, and reads config before drain', () => {
    const h = harness(); const order: string[] = []; h.register();
    const turn = () => h.hooks.get('before_prompt_build')!({ prompt: 'hello there' }, OWNER);
    expect(turn()).not.toBeInstanceOf(Promise);
    const n = queue(order); h.setNotifier(n);
    h.ports.runtimeConfig = vi.fn(() => { order.push('config'); return {}; });
    h.ports.proposalsForTurn = vi.fn(() => { order.push('proposals'); return undefined; });
    h.ports.namesForTurn = vi.fn(() => { order.push('names'); return undefined; });
    h.ports.pendingFollowsForTurn = vi.fn(() => { order.push('pending'); return undefined; });
    const out = turn() as { prependContext?: string };
    expect(out.prependContext).toContain('[L2]');
    expect(order).toEqual(['config', 'proposals', 'names', 'pending', 'drain']);
    expect(h.ports.routingPaths).toHaveBeenCalledOnce();
    expect(h.ports.notifierForTurn).toHaveBeenCalledTimes(2);
    h.setNotifier(undefined);
    expect((turn() as { prependContext?: string }).prependContext ?? '').not.toContain('[L2]');
    expect(h.ports.runtimeConfig).toHaveBeenCalledTimes(2);
  });

  it.each(['runtimeConfig', 'proposalsForTurn', 'namesForTurn', 'pendingFollowsForTurn'] as const)('a throwing %s reader fails open without consuming notifications', reader => {
    const h = harness(); const order: string[] = []; const n = queue(order); h.setNotifier(n); h.register();
    h.ports[reader] = () => { throw new Error('READ-BOOM'); };
    expect(h.hooks.get('before_prompt_build')!({ prompt: 'hello there' }, OWNER)).toBeUndefined();
    expect(order).toEqual([]);
    expect(n.count('L2')).toBe(1);
    expect(h.logs).toContain('popclaw: routing hook failed (non-fatal): Error: READ-BOOM');
  });

  it('a failing post-drain pending read degrades independently and keeps the delivered block', () => {
    const h = harness(); const order: string[] = []; const n = queue(order); h.setNotifier(n);
    h.setPending({ listPending: () => { order.push('pending-read'); throw new Error('PENDING-BOOM'); } } as unknown as PendingFollowStore);
    h.register();
    const out = h.hooks.get('before_prompt_build')!({ prompt: 'hello there' }, OWNER) as { prependContext?: string };
    expect(out.prependContext).toContain('[L2]');
    expect(order).toEqual(['drain', 'pending-read']);
    expect(n.count('L2')).toBe(0);
    expect(h.logs).toContain('popclaw: doorbell injection skipped (non-fatal) — Error: PENDING-BOOM');
    expect(h.logs.some(l => l.includes('routing hook failed'))).toBe(false);
  });
});
