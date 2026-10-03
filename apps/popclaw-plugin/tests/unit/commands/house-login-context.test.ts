import { describe, expect, it, vi } from 'vitest';
import { runHouseLoginCommand, type HouseCommandContext } from '../../../src/commands/popclaw-house.js';
import type { HouseCommandPort } from '../../../src/runtime/house-lifecycle/command-bus.js';

describe('login result and material read are separate outcomes', () => {
  const origin = 'https://house.invalid';
  function context(status: 'connected' | 'connecting' | 'unsupported', readAgentContext: HouseCommandContext['readAgentContext']) {
    const loginHouse = vi.fn(async () => ({origin, scope: 'local_installation' as const, status, sessionId: status === 'connected' ? 'session_1' : ''}));
    return {loginHouse, ctx: {coordinator: () => ({loginHouse}) as unknown as HouseCommandPort, lang: () => 'en' as const, readAgentContext}};
  }
  it('preserves committed success when the read fails and never retries login', async () => {
    const read = vi.fn(async () => {throw new Error('read failed');}), {ctx, loginHouse} = context('connected', read);
    const text = await runHouseLoginCommand(ctx, origin);
    expect(text).toContain('"login_status":"connected"');
    expect(text).toContain('"code":"HOUSE_CONTEXT_UNAVAILABLE"');
    expect(read).toHaveBeenCalledWith(origin, 'session_1');
    expect(loginHouse).toHaveBeenCalledOnce();
  });
  it.each(['connecting', 'unsupported'] as const)('does not attach retained materials to %s', async status => {
    const read = vi.fn(() => ({status: 'unavailable' as const, code: 'old materials'})), {ctx} = context(status, read);
    expect(await runHouseLoginCommand(ctx, origin)).not.toContain('agent_context');
    expect(read).not.toHaveBeenCalled();
  });
});
