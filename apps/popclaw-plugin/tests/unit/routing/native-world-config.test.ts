import { describe, expect, it } from 'vitest';
import { configuredRoutingHouseOrigins } from '../../../src/routing/native-world-config.js';
const origin = 'http://127.0.0.1:49300', actor = '11111111111111111111111111111111';
const config = {plugins: {entries: {popclaw: {config: {worldExecution: {policies: [{agentId: 'main', actorId: actor,
  house: origin, kinds: ['reading.annotate'], authorizedAt: '2026-09-08T00:00:00Z', expiresAt: '2026-09-09T00:00:00Z'}]}}}}}};
describe('House routing configuration is identification only', () => {
  it('extracts only validated configured origins without mutating policy', () => {
    const before = JSON.stringify(config);
    expect(configuredRoutingHouseOrigins(config)).toEqual([origin]);
    expect(JSON.stringify(config)).toBe(before);
  });
  it('degrades safely for missing, invalid or disabled plugin configuration', () => {
    expect(configuredRoutingHouseOrigins(undefined)).toEqual([]);
    expect(configuredRoutingHouseOrigins({plugins: {enabled: false, entries: config.plugins.entries}})).toEqual([]);
    expect(configuredRoutingHouseOrigins({plugins: {entries: {popclaw: {config: {worldExecution: {policies: [{house: origin}]}}}}}})).toEqual([]);
  });
});
