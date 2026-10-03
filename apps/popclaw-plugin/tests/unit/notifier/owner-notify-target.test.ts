import { describe, it, expect } from 'vitest';
import { OwnerNotifyTargetStore } from '../../../src/notifier/owner-notify-target.js';
import type { HostStorage } from '../../../src/host/host-adapter.js';
import type { OwnerDeliveryContext } from '../../../src/notifier/owner-session.js';

// In-memory HostStorage stub (read/write/delete).
function fakeStorage(): HostStorage {
  const mem = new Map<string, Uint8Array>();
  return {
    async read(ns: string, key: string) { return mem.get(`${ns}/${key}`) ?? null; },
    async write(ns: string, key: string, bytes: Uint8Array) { mem.set(`${ns}/${key}`, bytes); },
    async delete(ns: string, key: string) { mem.delete(`${ns}/${key}`); },
  } as HostStorage;
}

const dc: OwnerDeliveryContext = { channel: 'discord', to: '123', accountId: 'acct', threadId: 9 };

describe('OwnerNotifyTargetStore', () => {
  it('returns null before anything is pinned', async () => {
    expect(await new OwnerNotifyTargetStore(fakeStorage()).get()).toBeNull();
  });

  it('round-trips a pinned target across a fresh store instance (survives restart)', async () => {
    const storage = fakeStorage();
    await new OwnerNotifyTargetStore(storage).set({ deliveryContext: dc, sessionKey: 'sess-1' });
    const reopened = new OwnerNotifyTargetStore(storage); // simulates a gateway restart
    expect(await reopened.get()).toEqual({ deliveryContext: dc, sessionKey: 'sess-1' });
  });

  it('clear() removes the pin', async () => {
    const storage = fakeStorage();
    const s = new OwnerNotifyTargetStore(storage);
    await s.set({ deliveryContext: dc, sessionKey: 'sess-1' });
    await s.clear();
    expect(await s.get()).toBeNull();
  });

  it('treats corrupt JSON as unset', async () => {
    const storage = fakeStorage();
    await storage.write('config', 'notify-target.json', new TextEncoder().encode('{not json'));
    expect(await new OwnerNotifyTargetStore(storage).get()).toBeNull();
  });
});

describe('OwnerNotifyTargetStore.captureIfUnset — zero-config default', () => {
  it('pins the first conversation channel it sees, marked source=auto', async () => {
    const s = new OwnerNotifyTargetStore(fakeStorage());
    expect(await s.captureIfUnset({ deliveryContext: dc, sessionKey: 'sess-1' })).toBe(true);
    expect(await s.get()).toEqual({ deliveryContext: dc, sessionKey: 'sess-1', source: 'auto' });
  });

  it('never replaces an owner-pinned target', async () => {
    const s = new OwnerNotifyTargetStore(fakeStorage());
    await s.set({ deliveryContext: dc, sessionKey: 'sess-1', source: 'owner' });
    const other = { channel: 'telegram', to: '999' };
    expect(await s.captureIfUnset({ deliveryContext: other, sessionKey: 'sess-2' })).toBe(false);
    expect((await s.get())?.deliveryContext).toEqual(dc);
  });

  it('never replaces a legacy target with no source field (missing = owner)', async () => {
    const storage = fakeStorage();
    await storage.write(
      'config',
      'notify-target.json',
      new TextEncoder().encode(JSON.stringify({ deliveryContext: dc, sessionKey: 'legacy' })),
    );
    const s = new OwnerNotifyTargetStore(storage);
    expect(await s.captureIfUnset({ deliveryContext: { channel: 'telegram', to: '999' } })).toBe(
      false,
    );
    expect(await s.get()).toEqual({ deliveryContext: dc, sessionKey: 'legacy' });
  });

  it('first auto capture wins — a later channel does not move the pin', async () => {
    const s = new OwnerNotifyTargetStore(fakeStorage());
    await s.captureIfUnset({ deliveryContext: dc });
    await s.captureIfUnset({ deliveryContext: { channel: 'telegram', to: '999' } });
    expect((await s.get())?.deliveryContext).toEqual(dc);
  });

  it('skips contexts with no routable address (browser/TUI: channel but no `to`)', async () => {
    const s = new OwnerNotifyTargetStore(fakeStorage());
    expect(await s.captureIfUnset({ deliveryContext: { channel: 'cli' } })).toBe(false);
    expect(await s.get()).toBeNull();
  });
});
