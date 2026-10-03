import { describe, it, expect, vi } from 'vitest';
import { runPopclawNextCommand, runPopclawSkipCommand } from '../../../src/commands/popclaw-next.js';
import type { OnboardingOrchestrator } from '../../../src/onboarding/orchestrator.js';

// /popclaw next|skip are thin delegations into the orchestrator spine —
// these tests lock the verb wiring (next → 'next', skip → 'skip') and the
// S3-T4 free-text answer passthrough (/popclaw next <text>).
function makeFakeOrchestrator() {
  // vi.fn records actual call args (incl. the answer) regardless of the
  // handler's declared params — keep the signature minimal for lint.
  const handleAdvance = vi.fn(async (action: 'next' | 'skip') => ({
    text: `advanced:${action}`,
  }));
  const orchestrator = { handleAdvance } as unknown as OnboardingOrchestrator;
  return { orchestrator, handleAdvance };
}

describe('runPopclawNextCommand', () => {
  it("delegates to orchestrator.handleAdvance('next') without answer", async () => {
    const { orchestrator, handleAdvance } = makeFakeOrchestrator();
    const res = await runPopclawNextCommand({ orchestrator });
    expect(handleAdvance).toHaveBeenCalledTimes(1);
    expect(handleAdvance).toHaveBeenCalledWith('next', undefined);
    expect(res.text).toBe('advanced:next');
  });

  it('passes the free-text answer through (S3: 取名/菜单选择/兴趣自述)', async () => {
    const { orchestrator, handleAdvance } = makeFakeOrchestrator();
    await runPopclawNextCommand({ orchestrator }, '夜行白驹');
    expect(handleAdvance).toHaveBeenCalledWith('next', '夜行白驹');
  });
});

describe('runPopclawSkipCommand', () => {
  it("delegates to orchestrator.handleAdvance('skip')", async () => {
    const { orchestrator, handleAdvance } = makeFakeOrchestrator();
    const res = await runPopclawSkipCommand({ orchestrator });
    expect(handleAdvance).toHaveBeenCalledTimes(1);
    expect(handleAdvance).toHaveBeenCalledWith('skip');
    expect(res.text).toBe('advanced:skip');
  });
});
