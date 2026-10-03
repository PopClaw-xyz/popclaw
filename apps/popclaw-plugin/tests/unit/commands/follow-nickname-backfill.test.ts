import { describe, it, expect, vi } from 'vitest';
import { runFollowCommand } from '../../../src/commands/follow.js';
import { withOutcomes } from '../../helpers/with-outcomes.js';

/** Minimal deps: declareFollow succeeds, bonds records the projection. */
function deps(extra: Record<string, unknown> = {}) {
  const fillNickname = vi.fn();
  const d = {
    socialGraph: withOutcomes({ declareFollow: vi.fn(async () => undefined) }),
    bondsStore: {
      setFollowed: vi.fn(),
      recordInteraction: vi.fn(),
      fillNickname,
    },
    ...extra,
  } as unknown as Parameters<typeof runFollowCommand>[1];
  return { d, fillNickname };
}

// #468 variant B: following is where a nameless bond row gets a name, because
// following is rare, deliberate, and already on the network.
describe('runFollowCommand nickname backfill (#468)', () => {
  it('writes the name the house reports into the bond book', async () => {
    const { d, fillNickname } = deps({ resolveNickname: async () => '青山小待诏' });
    const r = await runFollowCommand('ID1', d);
    expect(r.text).toMatch(/^✓/);
    expect(fillNickname).toHaveBeenCalledWith('ID1', '青山小待诏');
  });

  it('writes nothing when the house has no name either', async () => {
    const { d, fillNickname } = deps({ resolveNickname: async () => '' });
    await runFollowCommand('ID1', d);
    expect(fillNickname).not.toHaveBeenCalled();
  });

  it('a failing lookup never fails the follow — it is already on the wire', async () => {
    const { d, fillNickname } = deps({
      resolveNickname: async () => {
        throw new Error('lantern down');
      },
    });
    const r = await runFollowCommand('ID1', d);
    expect(r.text).toMatch(/^✓/);
    expect(fillNickname).not.toHaveBeenCalled();
  });

  it('writes the name resolution already had', async () => {
    const { d, fillNickname } = deps({ knownNickname: 'Reh8120A-062c' });
    const r = await runFollowCommand('ID1', d);
    expect(r.text).toMatch(/^✓/);
    expect(fillNickname).toHaveBeenCalledWith('ID1', 'Reh8120A-062c');
  });

  it('a follow that is not yet accepted writes no name', async () => {
    const queued = { mode: 'ordered', transport: 'queued', action: 'declare', followee: 'ID1' };
    const { d, fillNickname } = deps({
      knownNickname: 'Reh8120A-062c',
      socialGraph: { declareFollowWithOutcome: vi.fn(async () => queued) },
    });
    const r = await runFollowCommand('ID1', d);
    expect(r.text).not.toMatch(/^✓/);
    expect(fillNickname).not.toHaveBeenCalled();
  });

  it('no resolver injected = unchanged behaviour, no lookup', async () => {
    const { d, fillNickname } = deps();
    const r = await runFollowCommand('ID1', d);
    expect(r.text).toMatch(/^✓/);
    expect(fillNickname).not.toHaveBeenCalled();
  });
});
