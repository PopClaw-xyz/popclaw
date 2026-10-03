import { describe, it, expect, beforeEach } from 'vitest';
import {
  BROKEN_AFTER,
  markRoutingMode,
  noteInboundTurn,
  noteRoutingFire,
  noteRoutingL2Hits,
  resetRoutingStats,
  routingStats,
} from '../../../src/routing/stats.js';

beforeEach(() => resetRoutingStats());

describe('routing stats counters', () => {
  it('counts fires and L2 hits, stamps lastFiredAt', () => {
    markRoutingMode('wired');
    noteRoutingFire(1000);
    noteRoutingL2Hits(2);
    noteRoutingFire(2000);
    const s = routingStats();
    expect(s.fireCount).toBe(2);
    expect(s.l2HitCount).toBe(2);
    expect(s.lastFiredAt).toBe(2000);
  });

  it('flags "registered but never fired" exactly once, after BROKEN_AFTER inbound turns', () => {
    markRoutingMode('wired');
    const flags = Array.from({ length: BROKEN_AFTER + 3 }, () => noteInboundTurn());
    // First BROKEN_AFTER-1 turns are below the threshold, then exactly one true.
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(flags.indexOf(true)).toBe(BROKEN_AFTER - 1);
    expect(routingStats().inboundCount).toBe(BROKEN_AFTER + 3);
  });

  it('never flags once the hook has fired', () => {
    markRoutingMode('wired');
    noteRoutingFire();
    const flags = Array.from({ length: BROKEN_AFTER + 2 }, () => noteInboundTurn());
    expect(flags).not.toContain(true);
  });

  it('never flags when routing is off or the host has no api.on (already logged at register)', () => {
    for (const mode of ['off', 'unavailable'] as const) {
      resetRoutingStats();
      markRoutingMode(mode);
      const flags = Array.from({ length: BROKEN_AFTER + 2 }, () => noteInboundTurn());
      expect(flags).not.toContain(true);
    }
  });
});
