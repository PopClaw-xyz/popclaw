import { describe, expect, it } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { worldActionJson } from '../../../src/world/action-json.js';

describe('world action tool JSON', () => {
  it('preserves maximum uint64 counters and renders epoch times without numeric coercion', () => {
    const result = popclaw.world.ActionResult.fromObject({ statusRevision: '18446744073709551615', committedAt: '-1',
      resultBody: Buffer.from('{"ok":true}'), status: 3, schemaVersion: 1 });
    expect(worldActionJson('ActionResult', result)).toMatchObject({ status_revision: '18446744073709551615',
      committed_at: '1969-12-31T23:59:59Z', result_body: 'eyJvayI6dHJ1ZX0=', status: 3, schema_version: 1 });
  });

  it('renders nested subscription revisions and participation window shape from the contract', () => {
    const result = popclaw.world.ActionResult.fromObject({ subscription: { descriptorRevision: '9007199254740993', scopes: ['sc_a'] },
      participation: { revision: '18446744073709551615', windowId: 'window', windowOpensAt: 0, windowClosesAt: 60,
        actionGroups: [{ id: 'group', intentKinds: ['example.reply'] }],
        opportunities: [{ id: 'reply', notBefore: 0, expiresAt: 60 }], budgets: [{ suggestedLimit: 3 }] } });
    const json = worldActionJson('ActionResult', result);
    expect(json.subscription).toMatchObject({ descriptor_revision: '9007199254740993', scopes: ['sc_a'] });
    expect(json.participation).toMatchObject({ revision: '18446744073709551615',
      window: { id: 'window', opens_at: '1970-01-01T00:00:00Z', closes_at: '1970-01-01T00:01:00Z' },
      budgets: [{ suggested_limit: 3 }], opportunities: [{ not_before: '1970-01-01T00:00:00Z' }] });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('renders independently signed progress using decimal counters and RFC3339 time', () => {
    const progress = popclaw.world.SubscriptionObservation.fromObject({ observationRevision: '9007199254740994',
      highWaterSeq: '18446744073709551615', observedAt: 0, queryNonce: 'nonce' });
    expect(worldActionJson('SubscriptionObservation', progress)).toMatchObject({ observation_revision: '9007199254740994',
      high_water_seq: '18446744073709551615', observed_at: '1970-01-01T00:00:00Z', query_nonce: 'nonce' });
  });

  it('renders canonical omitted scalar zeroes after real protobuf decoding', () => {
    const progress = popclaw.world.SubscriptionObservation.decode(popclaw.world.SubscriptionObservation.encode({
      version: 1, publishedThrough: [{ scopeId: 'sc_a' }],
    }).finish());
    expect(worldActionJson('SubscriptionObservation', progress)).toMatchObject({ observation_revision: '0',
      high_water_seq: '0', observed_at: '1970-01-01T00:00:00Z', published_through: [{ scope_id: 'sc_a', through_seq: '0' }] });
    const result = popclaw.world.ActionResult.decode(new Uint8Array());
    const json = worldActionJson('ActionResult', result);
    expect(json).toMatchObject({ status_revision: '0', committed_at: '1970-01-01T00:00:00Z', status: 0, result_body: '' });
    expect(json).not.toHaveProperty('participation');
    expect(json).not.toHaveProperty('snapshot');
  });

  it('rejects rounded, out-of-range and noncanonical integers before JSON can hide precision loss', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, '18446744073709551616', '-1', '01']) {
      expect(() => worldActionJson('ActionResult', { statusRevision: value })).toThrow();
    }
    for (const value of [Number.MAX_SAFE_INTEGER + 1, '253402300800', '1.5']) {
      expect(() => worldActionJson('ActionResult', { committedAt: value })).toThrow();
    }
    expect(() => worldActionJson('ActionResult', { schemaVersion: 4294967296 })).toThrow();
    expect(() => worldActionJson('ActionResult', { resultBody: 'plaintext' })).toThrow();
    expect(() => worldActionJson('ActionResult', { inventedAuthority: true })).toThrow();
  });

  it('does not retain mutable protobuf byte or array references in the tool result', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const scopes = ['sc_a'];
    const result = { resultBody: bytes, subscription: { scopes } };
    const json = worldActionJson('ActionResult', result);
    bytes.fill(0); scopes.push('sc_b');
    expect(json).toMatchObject({ result_body: 'AQID', subscription: { scopes: ['sc_a'] } });
  });
});


it.each(['constructor', 'toString', '__proto__'])('rejects own unknown %s keys in the tool JSON renderer', key => {
  expect(() => worldActionJson('ActionResult', JSON.parse('{"' + key + '":"unexpected"}'))).toThrow('WORLD_JSON_UNKNOWN_FIELD');
});
