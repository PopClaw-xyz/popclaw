import { describe, it, expect, vi } from 'vitest';
import {
  trace,
  traceEnabled,
  traceStatusLabel,
  traceTextEnabled,
  TRACE_DEFAULT_ON,
} from '../../../src/observability/trace.js';

describe('traceEnabled', () => {
  // Enabled by default during internal testing (owner ruling, 2026-07-31). Bind the assertion to the constant so when release sets it
  // false, this test follows without code changes.
  it('follows TRACE_DEFAULT_ON when nothing is set', () => {
    expect(traceEnabled('routing', {})).toBe(TRACE_DEFAULT_ON);
    expect(traceEnabled('routing', { POPCLAW_TRACE: '' })).toBe(TRACE_DEFAULT_ON);
  });

  it('off / none shut everything up, default or not', () => {
    expect(traceEnabled('routing', { POPCLAW_TRACE: 'off' })).toBe(false);
    expect(traceEnabled('anything', { POPCLAW_TRACE: 'none' })).toBe(false);
  });

  it('an explicit list picks exactly those modules', () => {
    expect(traceEnabled('routing', { POPCLAW_TRACE: 'routing' })).toBe(true);
    expect(traceEnabled('newspaper', { POPCLAW_TRACE: 'routing' })).toBe(false);
  });

  it('accepts a comma list, with whitespace and case slack', () => {
    const env = { POPCLAW_TRACE: 'Routing, newspaper' };
    expect(traceEnabled('routing', env)).toBe(true);
    expect(traceEnabled('NEWSPAPER', env)).toBe(true);
    expect(traceEnabled('dreamer', env)).toBe(false);
  });

  it('all turns on every module', () => {
    expect(traceEnabled('anything', { POPCLAW_TRACE: 'all' })).toBe(true);
  });

  it('the per-module switch overrides the list in both directions', () => {
    expect(traceEnabled('routing', { POPCLAW_TRACE: 'off', POPCLAW_ROUTING_TRACE: '1' })).toBe(true);
    expect(traceEnabled('routing', { POPCLAW_TRACE: 'all', POPCLAW_ROUTING_TRACE: '0' })).toBe(
      false,
    );
    expect(traceEnabled('newspaper', { POPCLAW_ROUTING_TRACE: '1' })).toBe(TRACE_DEFAULT_ON);
  });
});

describe('traceTextEnabled — the owner-words switch', () => {
  // Owner ruling, 2026-07-31: verbatim text is also recorded by default during internal testing. At release, flip only the same constant
  // (ADR-0045: one constant is the sole switch), never introduce a second switch to remember.
  it('follows TRACE_DEFAULT_ON when nothing is set', () => {
    expect(traceTextEnabled({})).toBe(TRACE_DEFAULT_ON);
    expect(traceTextEnabled({ POPCLAW_TRACE_TEXT: '' })).toBe(TRACE_DEFAULT_ON);
  });

  it('an explicit env value always beats the default, both ways', () => {
    expect(traceTextEnabled({ POPCLAW_TRACE_TEXT: '1' })).toBe(true);
    expect(traceTextEnabled({ POPCLAW_TRACE_TEXT: '0' })).toBe(false);
    expect(traceTextEnabled({ POPCLAW_TRACE_TEXT: 'off' })).toBe(false);
    expect(traceTextEnabled({ POPCLAW_TRACE_TEXT: 'false' })).toBe(false);
  });
});

describe('traceStatusLabel — the boot line tells you if this box is tracing', () => {
  it('reports the default, an explicit list, and off', () => {
    const text = TRACE_DEFAULT_ON ? '+text' : '';
    expect(traceStatusLabel({})).toBe(TRACE_DEFAULT_ON ? 'on(all)+text' : 'off');
    expect(traceStatusLabel({ POPCLAW_TRACE: 'routing, newspaper' })).toBe(
      `on(routing,newspaper)${text}`,
    );
    expect(traceStatusLabel({ POPCLAW_TRACE: 'off' })).toBe('off');
  });

  it('flags a box that is recording the owner’s own words', () => {
    expect(traceStatusLabel({ POPCLAW_TRACE: 'routing', POPCLAW_TRACE_TEXT: '1' })).toBe(
      'on(routing)+text',
    );
    expect(traceStatusLabel({ POPCLAW_TRACE: 'routing', POPCLAW_TRACE_TEXT: '0' })).toBe(
      'on(routing)',
    );
    // Nothing is traced at all → nothing to qualify.
    expect(traceStatusLabel({ POPCLAW_TRACE: 'off', POPCLAW_TRACE_TEXT: '1' })).toBe('off');
  });
});

describe('trace', () => {
  it('costs nothing when off: the builder is never called', () => {
    const build = vi.fn(() => 'never');
    const log = vi.fn();
    trace('routing', log, build, { POPCLAW_TRACE: 'off' });
    expect(build).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('builds and logs exactly once when on', () => {
    const build = vi.fn(() => 'line');
    const log = vi.fn();
    trace('routing', log, build, { POPCLAW_TRACE: 'routing' });
    expect(build).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('line');
  });
});
