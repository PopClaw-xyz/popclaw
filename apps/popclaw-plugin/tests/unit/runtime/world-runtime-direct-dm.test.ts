import { expect, it, vi } from 'vitest';
import { WorldRuntime } from '../../../src/runtime/world-runtime.js';
import type { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { HousePushEffectResolver } from '../../../src/runtime/house-lifecycle/push-effect.js';
import { firstReleaseView } from '../../fixtures/world/first-release-view.js';

// Prior automatic-C adapter cases remain evidence at be5c40b1. The new
// first-release runtime has no private receipt consumer or direct-DM adapter.
it.each([false, true])('refuses direct-message composition even with host support=%s', async supported => {
  const origin = 'https://world.invalid', actorId = '11111111111111111111111111111111';
  let resolver!: HousePushEffectResolver;
  const storeForCommand = vi.fn(), resolveRecipient = vi.fn(), verifyRecipient = vi.fn();
  const houses = { configurePushEffectResolver: vi.fn(value => { resolver = value; }), storeForCommand } as unknown as HouseRuntime;
  const worlds = new WorldRuntime({ houses, signer: {} as Signer, actorId, readCapabilities: () => firstReleaseView(origin, actorId),
    supportsBackgroundTurns: () => supported, directMessages: { nickname: 'Test', resolveRecipient, verifyRecipient },
    selectScopedLane: () => true, onPlain: vi.fn(), onConversation: vi.fn() });
  await expect(worlds.directMessage(origin, 'part_1')).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
  const authorizeSend = vi.fn();
  await expect(resolver({ origin, ref: { kind: 'world_direct_dm' }, bytes: new Uint8Array([1]), context: { authorizeSend } } as any)).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
  expect(storeForCommand).not.toHaveBeenCalled(); expect(resolveRecipient).not.toHaveBeenCalled();
  expect(verifyRecipient).not.toHaveBeenCalled(); expect(authorizeSend).not.toHaveBeenCalled();
  worlds.stop(); await worlds.whenIdle();
  await expect(worlds.directMessage(origin, 'part_1')).rejects.toThrow('WORLD_RUNTIME_STOPPED');
});
