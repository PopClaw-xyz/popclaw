import { describe, it, expect } from 'vitest';
import {
  isOwnerTurn,
  handoffDrainedL2,
  dropSettledBondProposals,
} from '../../../src/notifier/l2-handoff.js';
import type { NotificationItem, NotificationKind } from '../../../src/notifier/types.js';

/**
 * Issue #221's whole risk is in this gate. `before_prompt_build` fires for
 * every prompt build — cron, heartbeat, memory flush, sub-agent turns — and
 * `drain()` is transactional: whatever it hands to a machine turn nobody reads
 * is gone. ADR-0012 puts L2 at "the owner's next turn", not "any turn".
 */
describe('isOwnerTurn — the gate in front of a transactional drain', () => {
  it('opens for a turn the owner started', () => {
    expect(isOwnerTurn({ trigger: 'user', sessionKey: 'agent:main' })).toBe(true);
    expect(isOwnerTurn({ trigger: 'manual', sessionKey: 'agent:main' })).toBe(true);
  });

  it('stays shut for every machine-initiated trigger', () => {
    for (const trigger of ['cron', 'heartbeat', 'memory', 'overflow']) {
      expect(isOwnerTurn({ trigger, sessionKey: 'agent:main' })).toBe(false);
    }
  });

  it("stays shut on a sub-agent turn even when the trigger says 'user'", () => {
    // The owner started the run, but this prompt is being built for a
    // sub-agent — handing it the owner's notifications drops them into a
    // context the owner never reads.
    expect(isOwnerTurn({ trigger: 'user', sessionKey: 'agent:main:subagent:explore-1' })).toBe(false);
  });

  it('fails closed on an unknown or absent trigger', () => {
    // `trigger` is a bare `string` in the 7.1 SDK, so a host may report
    // something we have never seen. Costing a queued batch is recoverable;
    // silently swallowing one is not.
    expect(isOwnerTurn({ trigger: 'some-future-thing', sessionKey: 'agent:main' })).toBe(false);
    expect(isOwnerTurn({ sessionKey: 'agent:main' })).toBe(false);
    expect(isOwnerTurn(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The post-drain policy of the L2
// leg — settled proposals are dropped (decided is decided, never resurrected,
// not even on a render failure), a render that throws re-enqueues only the
// LIVE items, and an all-settled batch says nothing at all.
// ---------------------------------------------------------------------------

const item = (
  kind: NotificationKind,
  payload: Record<string, unknown>,
): NotificationItem => ({ id: 1, level: 'L2', kind, payload, enqueuedAt: 0 });

describe('dropSettledBondProposals — decided proposals stop being suggestions', () => {
  it('drops bond_proposal rows with no live pending proposal; keeps everything else', () => {
    const kept = dropSettledBondProposals(
      [
        item('bond_proposal', { popclawId: 'ALIVE', toTier: 'friend' }),
        item('bond_proposal', { popclawId: 'GONE', toTier: 'friend' }),
        item('bond_milestone', { popclawId: 'GONE' }),
        item('dm', { fromPopclawId: 'GONE' }),
      ],
      { hasPendingFor: (id, tier) => id === 'ALIVE' && tier === 'friend' },
    );
    expect(kept.map((k) => k.kind)).toEqual(['bond_proposal', 'bond_milestone', 'dm']);
    expect(kept.map((k) => k.payload['popclawId'] ?? k.payload['fromPopclawId'])).toEqual(['ALIVE', 'GONE', 'GONE']);
  });

  it('proposals store absent → items unchanged（查不了就照发，过滤不许吞通知）', () => {
    const items = [item('bond_proposal', { popclawId: 'X', toTier: 'friend' })];
    expect(dropSettledBondProposals(items)).toEqual(items);
  });

  it('liveness check throws → item delivered, not swallowed（DB 忙不等于已决定）', () => {
    const items = [item('bond_proposal', { popclawId: 'X', toTier: 'friend' })];
    expect(
      dropSettledBondProposals(items, {
        hasPendingFor: () => {
          throw new Error('db locked');
        },
      }),
    ).toEqual(items);
  });

  it('malformed payload (no toTier / null payload / bogus tier string) → delivered, not dropped by accident', () => {
    const store = { hasPendingFor: () => false };
    const noTier = [item('bond_proposal', { popclawId: 'X' })];
    expect(dropSettledBondProposals(noTier, store)).toEqual(noTier);
    const bogusTier = [item('bond_proposal', { popclawId: 'X', toTier: 'megafriend' })];
    expect(dropSettledBondProposals(bogusTier, store)).toEqual(bogusTier);
    const nullPayload = [{ ...item('dm', {}), payload: null as unknown as Record<string, unknown> }];
    expect(dropSettledBondProposals(nullPayload, store)).toEqual(nullPayload);
  });
});

describe('handoffDrainedL2 — the leg after the drain (native-leg policy)', () => {
  function rig(opts: { render?: (items: NotificationItem[]) => string } = {}) {
    const requeued: NotificationItem[] = [];
    const logs: string[] = [];
    const afterRender: string[] = [];
    const deps = {
      render: opts.render ?? (() => 'BLOCK'),
      requeue: (it: NotificationItem) => void requeued.push(it),
      log: (m: string) => void logs.push(m),
      afterRender: (live: NotificationItem[]) => void afterRender.push(`n=${live.length}`),
    };
    return { deps, requeued, logs, afterRender };
  }

  it('renders the live batch, reports dropped count, runs post-render passengers once', () => {
    const { deps, logs, afterRender } = rig();
    const block = handoffDrainedL2(
      [item('bond_proposal', { popclawId: 'A', toTier: 'friend' }), item('dm', { fromPopclawId: 'B' })],
      { ...deps, proposals: { hasPendingFor: () => false } }, // the proposal settled; the dm is not a proposal
    );
    expect(block).toBe('BLOCK');
    expect(logs[0]).toContain('n=1');
    expect(logs[0]).toContain('dropped=1');
    expect(afterRender).toEqual(['n=1']);
  });

  it('all settled → renders nothing, requeues nothing, one honest log line', () => {
    const { deps, requeued, logs, afterRender } = rig();
    const block = handoffDrainedL2([item('bond_proposal', { popclawId: 'GONE', toTier: 'friend' })], {
      ...deps,
      proposals: { hasPendingFor: () => false },
    });
    expect(block).toBe('');
    expect(requeued).toHaveLength(0);
    expect(afterRender).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('dropped');
  });

  it('render throw → only the LIVE items re-queued verbatim（settled 不复活）', () => {
    const { deps, requeued, logs, afterRender } = rig({
      render: () => {
        throw new Error('boom');
      },
    });
    const block = handoffDrainedL2(
      [item('dm', { fromPopclawId: 'KEEP' }), item('bond_proposal', { popclawId: 'GONE', toTier: 'friend' })],
      { ...deps, proposals: { hasPendingFor: () => false } },
    );
    expect(block).toBe('');
    expect(requeued.map((r) => r.kind)).toEqual(['dm']); // the settled one stays gone
    expect(requeued[0]!.level).toBe('L2');
    expect(afterRender).toHaveLength(0);
    expect(logs[0]).toContain('re-queued n=1');
    expect(logs[0]).toContain('boom');
  });

  it('empty drain → silent', () => {
    const { deps, logs } = rig();
    expect(handoffDrainedL2([], deps)).toBe('');
    expect(logs).toHaveLength(0);
  });
});
