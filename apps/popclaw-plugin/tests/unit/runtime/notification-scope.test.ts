import {expect, it, vi} from 'vitest';
import {captureNotificationScopes, notificationOrigin, notifierForOrigin} from '../../../src/runtime/house-lifecycle/notification-scope.js';
import type {NotificationItem} from '../../../src/notifier/types.js';
const a = 'https://a.invalid'; const b = 'https://b.invalid';
const item = (houseOrigin?: string): NotificationItem => ({id: 1, level: 'L1', kind: 'dm', payload: houseOrigin ? {houseOrigin} : {}, enqueuedAt: 1});
it('retains each original house and owner gate through a later login', () => {
  let generation = 1; let owner = true;
  const houses = {commands: {knownHouseOrigins: () => [a,b]} as never, resident: {authority: {captureEpoch: () => 1, isEpochCurrent: () => owner}} as never, originForSlug: (slug: string) => slug === 'a' ? a : b,
    captureGate: (origin: string) => { const captured = generation; return {origin, generation: captured, signal: new AbortController().signal,
      isActive: () => owner && (origin === b || generation === captured)}; }};
  const capture = captureNotificationScopes(houses);
  const first = capture(item(a))!; const second = capture(item(b))!;
  generation = 2;
  expect(first.isActive()).toBe(false); expect(second.isActive()).toBe(true);
  expect(capture(item(a))?.isActive()).toBe(false);
  expect(captureNotificationScopes(houses)(item(a))?.isActive()).toBe(true);
  owner = false; expect(second.isActive()).toBe(false);
});
it('keeps unattributed history out of automatic presentation and stamps new ingress', () => {
  const enqueue = vi.fn(); const queue = notifierForOrigin({enqueue}, a);
  queue.enqueue({level:'L1', kind:'reply', payload:{houseOrigin:b, body:'hello'}});
  expect(enqueue).toHaveBeenCalledWith({level:'L1', kind:'reply', payload:{houseOrigin:a, body:'hello'}});
  expect(notificationOrigin(item(), {originForSlug: () => a})).toBeNull();
});

it('holds restored local and House notifications independently of an otherwise current owner', () => {
  let allowed = false;
  const houses = {commands:{knownHouseOrigins:()=>[a]} as never,
    resident:{authority:{captureEpoch:()=>7,isEpochCurrent:()=>true}} as never,
    originForSlug:()=>a, storageAllows:()=>allowed,
    captureGate:(origin:string)=>({origin,generation:1,signal:new AbortController().signal,isActive:()=>true})};
  const capture=captureNotificationScopes(houses);
  expect(capture(item(a))?.isActive()).toBe(false);
  const local={...item(),kind:'system_notice' as const};
  expect(capture(local)?.isActive()).toBe(false);
  allowed=true;
  expect(capture(local)?.isActive()).toBe(false);
  expect(captureNotificationScopes(houses)(local)?.isActive()).toBe(true);
});
