import { describe, it, expect } from 'vitest';
import { runNotifyHereCommand, runNotifyOffCommand } from '../../../src/commands/notify-target.js';
import type { OwnerNotifyTargetStore } from '../../../src/notifier/owner-notify-target.js';
import type { OwnerNotifyTarget } from '../../../src/notifier/owner-notify-target.js';

function fakeStore() {
  let v: OwnerNotifyTarget | null = null;
  return {
    get: async () => v,
    set: async (t: OwnerNotifyTarget) => { v = t; },
    clear: async () => { v = null; },
  } as unknown as OwnerNotifyTargetStore;
}

describe('notify-here / notify-off', () => {
  it('pins the current channel address', async () => {
    const store = fakeStore();
    const res = await runNotifyHereCommand(
      { sessionKey: 'sess-1', channel: 'discord', to: '123', accountId: 'a', threadId: 7 },
      store,
    );
    expect(res.text).toMatch(/discord/);
    expect(await store.get()).toEqual({
      sessionKey: 'sess-1',
      deliveryContext: { channel: 'discord', to: '123', accountId: 'a', threadId: 7 },
      source: 'owner',
    });
  });

  it('overrides an auto-captured target (explicit always wins)', async () => {
    const store = fakeStore();
    await store.set({ deliveryContext: { channel: 'wechat', to: '1' }, source: 'auto' });
    await runNotifyHereCommand({ sessionKey: 's', channel: 'discord', to: '123' }, store);
    expect(await store.get()).toEqual({
      sessionKey: 's',
      deliveryContext: { channel: 'discord', to: '123', accountId: undefined, threadId: undefined },
      source: 'owner',
    });
  });

  it('refuses to pin a channel with no routable address (browser/TUI)', async () => {
    const store = fakeStore();
    const res = await runNotifyHereCommand({ sessionKey: 'sess-1', channel: undefined, to: undefined }, store);
    expect(res.text).toContain('✗');
    expect(await store.get()).toBeNull();
  });

  it('notify-off clears the pin', async () => {
    const store = fakeStore();
    await runNotifyHereCommand({ sessionKey: 's', channel: 'discord', to: '1' }, store);
    const res = await runNotifyOffCommand(store);
    expect(res.text).toMatch(/off|关闭/i);
    expect(await store.get()).toBeNull();
  });
});
