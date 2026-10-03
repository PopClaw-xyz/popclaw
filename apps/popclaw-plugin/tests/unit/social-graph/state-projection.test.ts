import { describe, it, expect } from 'vitest';
import {
  projectState,
  followsInHouse,
  type DeclaredEvent,
} from '../../../src/social-graph/state-projection';

describe('projectState', () => {
  it('empty inputs → empty state', () => {
    const state = projectState('me', []);
    expect(state.popclawId).toBe('me');
    expect(state.following).toEqual([]);
  });

  it('FollowDeclared adds to following', () => {
    const declared: DeclaredEvent[] = [
      { type: 'FollowDeclared', followee: 'B', followType: 'PUBLIC',
        tasteSubscribed: false, timestamp: 100, signature: 'sig1' },
    ];
    const state = projectState('A', declared);
    expect(state.following).toHaveLength(1);
    expect(state.following[0]!).toMatchObject({
      popclawId: 'B', followType: 'PUBLIC', tasteSubscribed: false, since: 100,
    });
  });

  it('FollowRevoked removes from following (most recent event wins)', () => {
    const declared: DeclaredEvent[] = [
      { type: 'FollowDeclared', followee: 'B', followType: 'PUBLIC',
        tasteSubscribed: false, timestamp: 100, signature: 's1' },
      { type: 'FollowRevoked', followee: 'B', followType: 'PUBLIC',
        timestamp: 200, signature: 's2' },
    ];
    expect(projectState('A', declared).following).toEqual([]);
  });

  it('Re-follow after revoke shows up in following again', () => {
    const declared: DeclaredEvent[] = [
      { type: 'FollowDeclared', followee: 'B', followType: 'PUBLIC',
        tasteSubscribed: false, timestamp: 100, signature: 's1' },
      { type: 'FollowRevoked', followee: 'B', followType: 'PUBLIC',
        timestamp: 200, signature: 's2' },
      { type: 'FollowDeclared', followee: 'B', followType: 'PUBLIC',
        tasteSubscribed: true, timestamp: 300, signature: 's3' },
    ];
    const state = projectState('A', declared);
    expect(state.following).toHaveLength(1);
    expect(state.following[0]!).toMatchObject({
      popclawId: 'B', tasteSubscribed: true, since: 300,
    });
  });
});

/**
 * ADR-0037 —— 投影键必须是 `(followee, house_slug)`。单键 followee 的旧投影里，
 * 任一坊的 FollowRevoked 会把这个人从**所有**坊抹掉（feed 加权、DM 闸、status
 * 集体失明，而坊侧还记着）。
 */
describe('projectState — 双键（followee, house_slug）', () => {
  const declaredIn = (house: string, followee: string, ts: number): DeclaredEvent => ({
    type: 'FollowDeclared', followee, followType: 'PUBLIC',
    tasteSubscribed: false, timestamp: ts, signature: `d${ts}`, houseSlug: house,
  });
  const revokedIn = (house: string, followee: string, ts: number): DeclaredEvent => ({
    type: 'FollowRevoked', followee, followType: 'PUBLIC',
    timestamp: ts, signature: `r${ts}`, houseSlug: house,
  });

  it('在 world 坊取关，不动 me 坊的那条（必修硬伤）', () => {
    const state = projectState('A', [
      declaredIn('me', 'B', 100),
      declaredIn('world', 'B', 110),
      revokedIn('world', 'B', 200),
    ]);
    expect(state.followingByHouse.get('me')?.map((e) => e.popclawId)).toEqual(['B']);
    expect(state.followingByHouse.get('world') ?? []).toEqual([]);
    // 人级并集仍认识他 —— 私信亲疏看人不看坊。
    expect(state.following.map((e) => e.popclawId)).toEqual(['B']);
  });

  it('人级并集一人一条（同一人在两坊关注不重复计数）', () => {
    const state = projectState('A', [declaredIn('me', 'B', 100), declaredIn('world', 'B', 300)]);
    expect(state.following).toHaveLength(1);
    // 并集条目取最近一次宣告（「最近关注」的展示口径）。
    expect(state.following[0]!.since).toBe(300);
  });

  it('两坊全取关 → 并集里也没有了', () => {
    const state = projectState('A', [
      declaredIn('me', 'B', 100), declaredIn('world', 'B', 110),
      revokedIn('me', 'B', 200), revokedIn('world', 'B', 210),
    ]);
    expect(state.following).toEqual([]);
  });

  it('followsInHouse：坊级判定只认那座坊', () => {
    const state = projectState('A', [declaredIn('me', 'B', 100)]);
    expect(followsInHouse(state, 'B', 'me')).toBe(true);
    expect(followsInHouse(state, 'B', 'world')).toBe(false);
  });

  it('空 house_slug 的行严格按空键存放 —— 归一成主坊是 SocialGraph 入口的事，投影本身不猜', () => {
    const state = projectState('A', [
      { type: 'FollowDeclared', followee: 'B', followType: 'PUBLIC',
        tasteSubscribed: false, timestamp: 100, signature: 's' },
    ]);
    // 不放宽成「对任何坊都算数」：那会让 me 坊的关注在 world 坊也拿到加权，
    // 正是 ADR-0037 要消除的串坊噪音。
    expect(followsInHouse(state, 'B', 'world')).toBe(false);
    expect(state.followingByHouse.get('')?.map((e) => e.popclawId)).toEqual(['B']);
  });
});
