/** Shared fixtures for the v0.2 newspaper tests: one issue, one item, both minimal and overridable. */
import type { IssueData, PulseItem } from '../../../src/newspaper/issue.js';

export function item(over: Partial<PulseItem> = {}): PulseItem {
  return {
    author: 'levelsio',
    handle: 'levelsio',
    sigil: '65v29fn1',
    avatarUrl: 'https://unavatar.io/twitter/levelsio',
    profileUrl: 'https://popclaw.me/levelsio/65v29fn1',
    followerCount: 0,
    verified: false,
    text: 'the booster landed on the pad.',
    platform: 'x',
    url: 'https://x.com/levelsio/status/1',
    postPageUrl: 'https://popclaw.me/post/abc1234567',
    media: [],
    eventId: 'abc1234567',
    authorPopclawId: 'pid-levelsio',
    markCount: 0,
    replyCount: 0,
    isFollowing: false,
    houseSlug: 'house-me',
    kind: '',
    tier: 'brief',
    ...over,
  };
}

export function issue(over: Partial<IssueData> = {}): IssueData {
  const pulse = over.pulse ?? [item()];
  return {
    language: 'zh-CN',
    dateLabel: '2026年8月25日',
    windowLabel: 'today',
    ownerNickname: '云舟',
    primaryHouseSlug: 'house-me',
    totalCount: pulse.length,
    pings: [],
    byHouse: { 'house-me': pulse.length },
    ...over,
    pulse,
  };
}

/**
 * Every URL the stored issue carries. Before v0.2 these tests asserted against
 * the F2 allowlist ("is this link one the agent may cite"); the agent never sees
 * a link now, so the fact worth protecting is the same one stated directly —
 * **the material carried this url through to the page**.
 */
export function urlsOf(i: IssueData): Set<string> {
  const out = new Set<string>();
  const add = (u?: string): void => {
    if (u) out.add(u);
  };
  for (const p of i.pulse) {
    add(p.url);
    add(p.postPageUrl);
    add(p.profileUrl);
    add(p.platformProfileUrl);
    p.media.forEach(add);
    for (const v of Object.values(p.houseFields ?? {})) if (/^https?:\/\//i.test(v)) add(v);
  }
  for (const p of i.pings) (p.links ?? []).forEach(add);
  for (const l of i.houseLetters ?? []) {
    (l.links ?? []).forEach(add);
    (l.imageLinks ?? []).forEach(add);
  }
  for (const m of i.mantles ?? []) add(m.url);
  for (const s of i.homeSections ?? [])
    for (const h of s.homes) {
      add(h.visitUrl);
      add(h.coverImg);
    }
  return out;
}
