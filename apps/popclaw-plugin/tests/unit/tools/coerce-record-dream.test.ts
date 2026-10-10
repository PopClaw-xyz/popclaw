/**
 * Hosts often pass nested objects as JSON strings because tool-call serialization differs.
 * Losing an entire dream's conclusions to this is too costly; normalize at the tool entry point.
 */
import { describe, it, expect } from 'vitest';
import { coerceRecordDream } from '../../../src/tools/dream-taste-tools.js';

describe('coerceRecordDream', () => {
  it('passes structured params through', () => {
    const out = coerceRecordDream({
      dream_token: 'tok',
      people: [{ popclaw_id: 'A', tags: ['x'] }],
      taste: { tags: ['航天'] },
    });
    expect(out).toEqual({
      dreamToken: 'tok',
      people: [{ popclaw_id: 'A', tags: ['x'] }],
      taste: { tags: ['航天'] },
    });
  });

  it('parses stringified nested params', () => {
    const out = coerceRecordDream({
      dream_token: 'tok',
      people: '[{"popclaw_id":"A"}]',
      taste: '{"tags":["航天"]}',
    });
    expect(out.people).toEqual([{ popclaw_id: 'A' }]);
    expect(out.taste).toEqual({ tags: ['航天'] });
  });

  it('unparseable garbage → treated as not given (record then rejects on empty tags)', () => {
    const out = coerceRecordDream({ dream_token: 'tok', people: 'not json', taste: '{' });
    expect(out.people).toBeUndefined();
    expect(out.taste).toBeUndefined();
  });

  it('missing token → empty string, not a throw', () => {
    expect(coerceRecordDream({}).dreamToken).toBe('');
  });

  // dream_basis rides INSIDE the people payload (a plain field, not a top-level
  // *_token argument) — the compatible provenance leg must survive the same
  // two shapes every other nested field survives.
  it('keeps dream_basis riding inside people entries, structured or stringified', () => {
    const structured = coerceRecordDream({
      dream_token: '***',
      people: [{ popclaw_id: 'A', dream_basis: 'dream_z', tags: ['x'] }],
    });
    expect(structured.people).toEqual([{ popclaw_id: 'A', dream_basis: 'dream_z', tags: ['x'] }]);

    const stringified = coerceRecordDream({
      dream_token: '***',
      people: '[{"popclaw_id":"A","dream_basis":"dream_z"}]',
    });
    expect(stringified.people).toEqual([{ popclaw_id: 'A', dream_basis: 'dream_z' }]);
  });

  // r26: the taught leg is the TOP-LEVEL dream_basis argument (people-independent).
  it('carries the top-level dream_basis through, absent dream_token included', () => {
    expect(coerceRecordDream({ dream_basis: 'dream_top', taste: { tags: ['x'] } })).toEqual({
      dreamToken: '',
      dreamBasis: 'dream_top',
      taste: { tags: ['x'] },
    });
    expect(coerceRecordDream({ dream_token: 'tok' }).dreamBasis).toBeUndefined();
  });
});
