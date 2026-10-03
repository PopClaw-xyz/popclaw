/**
 * The composition step of an owner turn's context, on its own. The effectful
 * steps (drain, hand-off, claim, doorbell block) are pinned through the real
 * root in tests/unit/runtime/prompt-build-hook-characterization.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { composeTurnContext } from '../../../src/notifier/owner-turn-context.js';

describe('composeTurnContext', () => {
  it('lays the parts down as notice, L2, doorbell, routing — in that order', () => {
    const out = composeTurnContext({
      notice: 'NOTICE',
      l2Block: 'L2',
      pendingBlock: 'PENDING',
      injection: { prependContext: 'ROUTING', appendSystemContext: 'SYSTEM' },
    });
    expect(out).toEqual({ appendSystemContext: 'SYSTEM', prependContext: 'NOTICE\nL2\nPENDING\nROUTING' });
  });

  it('skips empty parts without leaving blank lines', () => {
    const out = composeTurnContext({ notice: undefined, l2Block: '', pendingBlock: 'PENDING', injection: undefined });
    expect(out).toEqual({ prependContext: 'PENDING' });
  });

  it('nothing to say → undefined', () => {
    expect(composeTurnContext({ notice: undefined, l2Block: '', pendingBlock: '', injection: undefined })).toBeUndefined();
    expect(composeTurnContext({ notice: '', l2Block: '', pendingBlock: '', injection: {} })).toBeUndefined();
  });

  it('routing system context alone is still returned', () => {
    expect(
      composeTurnContext({ notice: undefined, l2Block: '', pendingBlock: '', injection: { appendSystemContext: 'SYSTEM' } }),
    ).toEqual({ appendSystemContext: 'SYSTEM' });
  });

  it('passes on only the host fields — routing evidence stays out', () => {
    const injection = { prependContext: 'ROUTING', hits: [{ tool: 'popclaw_show_feed' }] } as unknown as Parameters<
      typeof composeTurnContext
    >[0]['injection'];
    const out = composeTurnContext({ notice: undefined, l2Block: '', pendingBlock: '', injection });
    expect(out).toEqual({ prependContext: 'ROUTING' });
    expect(Object.keys(out!)).toEqual(['prependContext']);
  });
});
