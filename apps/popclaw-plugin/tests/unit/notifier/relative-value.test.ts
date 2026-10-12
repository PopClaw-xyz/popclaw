import { describe, it, expect } from 'vitest';
import { isInOwnerGraph, passesRelativeValueGate } from '../../../src/notifier/relative-value.js';
import { projectState } from '../../../src/social-graph/state-projection.js';

const graph = {
  following: () => [
    { popclawId: 'friend1', followType: 'PUBLIC' as const, tasteSubscribed: false, since: 0 },
  ],
};

describe('isInOwnerGraph', () => {
  it('returns true for a followed popclaw_id', () => {
    expect(isInOwnerGraph('friend1', graph)).toBe(true);
  });

  it('returns false for a stranger', () => {
    expect(isInOwnerGraph('stranger9', graph)).toBe(false);
  });

  it('returns false for an empty id', () => {
    expect(isInOwnerGraph('', graph)).toBe(false);
  });
});

describe('passesRelativeValueGate', () => {
  it('DM 仍走原闸：图谱内放行、陌生人丢弃', () => {
    expect(passesRelativeValueGate('dm', 'friend1', graph)).toBe(true);
    expect(passesRelativeValueGate('dm', 'stranger9', graph)).toBe(false);
  });

  // Without this exemption every new-follower notice would be dropped; new followers are outside the graph by definition.
  it('followed_you 显式豁免：完全陌生的新粉照样放行', () => {
    expect(passesRelativeValueGate('followed_you', 'stranger9', graph)).toBe(true);
  });

  // Joining a House establishes familiarity (ADR-0041): its official account is initially unknown to a new owner, so rejecting it
  // would silently discard every world-House postcard and return letter.
  it('已挂坊的官方名号视同图谱内', () => {
    const isHouseOfficial = (id: string) => id === 'WORLD_OFFICIAL_1';
    expect(passesRelativeValueGate('dm', 'WORLD_OFFICIAL_1', graph, isHouseOfficial)).toBe(true);
    expect(passesRelativeValueGate('dm', 'stranger9', graph, isHouseOfficial)).toBe(false);
  });

  it('不传坊官方判据 → 行为与从前一字不差', () => {
    expect(passesRelativeValueGate('dm', 'WORLD_OFFICIAL_1', graph)).toBe(false);
  });
});

// 2026-07-31 real-device incident: `bond block` only changed the tier and
// left the follow table untouched, so someone who was followed and then
// blocked still got pushed to the owner's phone — the exemption was present
// and did not win. The gate now checks `blocked` first (relative-value.ts
// ~line 96), but that behaviour has so far been held only by statement
// order, with no test pinning it by name.
describe('block beats the follow exemption', () => {
  it('followed and not blocked → announced (positive control)', () => {
    expect(
      passesRelativeValueGate('dm', 'friend1', graph, undefined, { blocked: false }),
    ).toBe(true);
  });

  it('followed and then blocked → silent, block overrides the follow exemption', () => {
    expect(
      passesRelativeValueGate('dm', 'friend1', graph, undefined, { blocked: true }),
    ).toBe(false);
  });

  // ADR-0037: `following()` is already the real cross-house, person-level
  // union — built here by the same `projectState` production code uses, not
  // a hand-rolled stub — so a person followed on one house is as much "in
  // the graph" as one followed on the house a DM arrived on. Note what this
  // does NOT test: `passesRelativeValueGate` takes no "which house did this
  // DM arrive on" argument at all, so "followed on house X, DM via house Y"
  // cannot be expressed as a behaviorally distinct case without adding an
  // arrival-house parameter to the gate — a production-code change out of
  // scope for this file. This case only confirms the block veto still wins
  // once the followed person's membership comes from a real multi-house
  // projection instead of the inline stub above.
  it('followed on another house (real cross-house projection) and blocked → still silent', () => {
    const crossHouseState = projectState('owner', [
      {
        type: 'FollowDeclared',
        followee: 'friend-other-house',
        followType: 'PUBLIC',
        tasteSubscribed: false,
        timestamp: 0,
        signature: 'sig',
        houseSlug: 'worldhouse',
      },
    ]);
    const crossHouseGraph = { following: () => crossHouseState.following };
    expect(
      passesRelativeValueGate('dm', 'friend-other-house', crossHouseGraph, undefined, { blocked: false }),
    ).toBe(true);
    expect(
      passesRelativeValueGate('dm', 'friend-other-house', crossHouseGraph, undefined, { blocked: true }),
    ).toBe(false);
  });

  it('mounted-house official and blocked → silent, block overrides the official-account exemption', () => {
    const isHouseOfficial = (id: string) => id === 'WORLD_OFFICIAL_1';
    expect(
      passesRelativeValueGate('dm', 'WORLD_OFFICIAL_1', graph, isHouseOfficial, { blocked: true }),
    ).toBe(false);
  });
});

// Letters from verified high-profile accounts used to be silently dropped. Add the exemption to gate level five
// (blocklist -> type exemption -> graph -> joined-House official -> external standing), rather than bypassing the gate.
describe('外站认证大 V 豁免', () => {
  const emptyGraph = { following: () => [] };
  const THRESHOLD = 100_000;

  it('图谱外的陌生人，只要外站分量够，来信就该报', () => {
    expect(
      passesRelativeValueGate('dm', 'BIGNAME', emptyGraph, undefined, {
        blocked: false,
        verifiedFollowerCount: 250_000,
      }, THRESHOLD),
    ).toBe(true);
  });

  it('分量不够照旧静默', () => {
    expect(
      passesRelativeValueGate('dm', 'SMALL', emptyGraph, undefined, {
        blocked: false,
        verifiedFollowerCount: 900,
      }, THRESHOLD),
    ).toBe(false);
  });

  it('拉黑仍是一票否决，分量再大也压不过', () => {
    expect(
      passesRelativeValueGate('dm', 'BLOCKED_VIP', emptyGraph, undefined, {
        blocked: true,
        verifiedFollowerCount: 10_000_000,
      }, THRESHOLD),
    ).toBe(false);
  });

  it('阈值为 0 = 主人关掉了这条豁免', () => {
    expect(
      passesRelativeValueGate('dm', 'BIGNAME', emptyGraph, undefined, {
        blocked: false,
        verifiedFollowerCount: 250_000,
      }, 0),
    ).toBe(false);
  });

  it('不传阈值 = 老行为，一个字节都不差', () => {
    expect(
      passesRelativeValueGate('dm', 'BIGNAME', emptyGraph, undefined, {
        blocked: false,
        verifiedFollowerCount: 250_000,
      }),
    ).toBe(false);
  });
});
