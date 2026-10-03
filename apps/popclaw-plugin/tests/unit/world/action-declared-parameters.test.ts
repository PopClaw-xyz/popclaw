import { describe, expect, it } from 'vitest';
import {
  WORLD_ACTION_PARAM_UNDECLARED, WORLD_ACTION_SCHEMA_UNAVAILABLE,
  actionParameterRefusal, declaredParameterKeys,
} from '../../../src/world/action-declared-parameters.js';

/**
 * The house's own declaration of what a check-in carries. Property names are
 * bounded by the schema profile to `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, so a key
 * with a space in it is not expressible as a DECLARED key at all — which is
 * exactly why comparing against the declaration closes the confusable-row hole
 * without touching the house contract.
 */
const schema = {
  type: 'object',
  properties: {
    place: { type: 'string' }, latitude: { type: 'string' },
    longitude: { type: 'string' }, status: { type: 'string' },
  },
  required: ['place'],
};
const params = { place: 'Hangzhou', latitude: '30.0000', longitude: '120.0000', status: 'ok' };

describe('the keys an action schema declares', () => {
  it('reads the declared names off the schema, not off the call', () => {
    expect([...declaredParameterKeys(schema)!].sort())
      .toEqual(['latitude', 'longitude', 'place', 'status']);
    // The same schema answers the same set however the call is shaped — the
    // declaration cannot be widened by what a model chose to send.
    expect([...declaredParameterKeys(schema)!].sort())
      .toEqual(['latitude', 'longitude', 'place', 'status']);
  });

  it('collects names through root-level composition and internal refs', () => {
    const composed = {
      type: 'object',
      $defs: { core: { type: 'object', properties: { place: { type: 'string' } } } },
      allOf: [{ $ref: '#/$defs/core' }],
      anyOf: [{ type: 'object', properties: { status: { type: 'string' } } }],
    };
    expect([...declaredParameterKeys(composed)!].sort()).toEqual(['place', 'status']);
  });

  it('does not take a nested object\'s property names for top-level declarations', () => {
    const nested = { type: 'object', properties: { place: { type: 'object', properties: { house: { type: 'string' } } } } };
    expect([...declaredParameterKeys(nested)!]).toEqual(['place']);
  });

  it('answers "cannot tell" rather than "nothing is constrained" when the schema is unusable', () => {
    for (const unusable of [null, undefined, 'a schema', 42, [],
      { type: 'object', properties: 'not an object' },
      { type: 'object', allOf: { $ref: '#/$defs/core' } },
      { type: 'object', allOf: [{ $ref: '#/$defs/missing' }] },
      { type: 'object', allOf: [{ $ref: 'https://elsewhere/schema' }] }]) {
      expect(declaredParameterKeys(unusable), JSON.stringify(unusable)).toBeNull();
      expect(actionParameterRefusal(unusable, params)).toBe(WORLD_ACTION_SCHEMA_UNAVAILABLE);
    }
  });

  it('treats a schema that declares no property at all as declaring nothing, not as declaring everything', () => {
    expect([...declaredParameterKeys({ type: 'object' })!]).toEqual([]);
    expect(actionParameterRefusal({ type: 'object' }, params)).toBe(WORLD_ACTION_PARAM_UNDECLARED);
    expect(actionParameterRefusal({ type: 'object' }, {})).toBeNull();
  });
});

describe('a parameter key the house never declared', () => {
  it('passes the call the house did declare', () => {
    expect(actionParameterRefusal(schema, params)).toBeNull();
    expect(actionParameterRefusal(schema, { place: 'Hangzhou' })).toBeNull();
  });

  /**
   * PROBE-8c, the reviewer's confusable row. A leading space sorts the key
   * first, so ` house: <anything the model wrote>` paints directly under the
   * genuine `house:` row. A plain space cannot go in the invisible class —
   * values need spaces — so the only honest answer is not to render a key the
   * house never declared.
   */
  it('refuses a leading-space key by name', () => {
    expect(actionParameterRefusal(schema, { ...params, ' house': 'http://evil.example' }))
      .toBe(WORLD_ACTION_PARAM_UNDECLARED);
  });

  it('refuses a trailing-space key by name', () => {
    expect(actionParameterRefusal(schema, { ...params, 'house ': 'http://evil.example' }))
      .toBe(WORLD_ACTION_PARAM_UNDECLARED);
    // And the same shape on a key that IS declared, so the space is what is
    // being caught rather than the word. Trimming ` house` still leaves a key
    // nobody declared; trimming ` place` does not, which is why this pair is
    // the one that tells a raw comparison from a tidied-up one.
    expect(actionParameterRefusal(schema, { ...params, 'place ': 'x' }))
      .toBe(WORLD_ACTION_PARAM_UNDECLARED);
    expect(actionParameterRefusal(schema, { ...params, ' place': 'x' }))
      .toBe(WORLD_ACTION_PARAM_UNDECLARED);
  });

  /**
   * The row the owner reads as a SECOND `house:` line. `house` is a frame
   * label this house never declared as a parameter, so the duplicate row can
   * never be built.
   */
  it('refuses a key that duplicates a frame row the dialog already draws', () => {
    expect(actionParameterRefusal(schema, { ...params, house: 'http://evil.example' }))
      .toBe(WORLD_ACTION_PARAM_UNDECLARED);
    expect(actionParameterRefusal(schema, { ...params, action: 'rangermap.nothing' }))
      .toBe(WORLD_ACTION_PARAM_UNDECLARED);
  });

  it('refuses a case variant, because the comparison is exact code points', () => {
    expect(actionParameterRefusal(schema, { ...params, House: 'x' })).toBe(WORLD_ACTION_PARAM_UNDECLARED);
    expect(actionParameterRefusal(schema, { ...params, PLACE: 'x' })).toBe(WORLD_ACTION_PARAM_UNDECLARED);
    // Unicode case folding is not applied either: Kelvin sign folds to `k`.
    expect(actionParameterRefusal({ type: 'object', properties: { k: {} } }, { 'K': 'x' }))
      .toBe(WORLD_ACTION_PARAM_UNDECLARED);
  });

  it('refuses a plain extra field that resembles nothing', () => {
    expect(actionParameterRefusal(schema, { ...params, souvenir: 'x' })).toBe(WORLD_ACTION_PARAM_UNDECLARED);
  });

  it('does not normalize before comparing, so a compatibility form is still undeclared', () => {
    // U+FF50 FULLWIDTH LATIN SMALL LETTER P normalizes (NFKC) to `p`.
    expect(actionParameterRefusal(schema, { 'ｐlace': 'x' })).toBe(WORLD_ACTION_PARAM_UNDECLARED);
  });

  it('refuses when the parameters are not an object at all', () => {
    for (const bad of [null, undefined, 'text', 42, ['place']]) {
      expect(actionParameterRefusal(schema, bad), JSON.stringify(bad)).toBe(WORLD_ACTION_SCHEMA_UNAVAILABLE);
    }
  });
});
