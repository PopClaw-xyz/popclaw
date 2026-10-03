import { expect, it, vi } from 'vitest';
import { WorldRuntime } from '../../../src/runtime/world-runtime.js';
import type { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { HousePushEffectResolver } from '../../../src/runtime/house-lifecycle/push-effect.js';
import { firstReleaseView } from '../../fixtures/world/first-release-view.js';

it('owner replacement cannot replay historical participation intent or DM effects', async () => {
  const origin = 'https://world.invalid', actorId = '11111111111111111111111111111111';
  const resolvers: HousePushEffectResolver[] = [], storeForCommand = vi.fn(), authorizeSend = vi.fn();
  const houses = { configurePushEffectResolver: (resolver: HousePushEffectResolver) => resolvers.push(resolver), storeForCommand } as unknown as HouseRuntime;
  const options = { mode: 'commands' as const, houses, signer: {} as Signer, actorId, readCapabilities: () => firstReleaseView(origin, actorId) };
  const original = new WorldRuntime(options); original.stop();
  const replacement = new WorldRuntime(options);
  for (const kind of ['world_intent', 'world_direct_dm']) {
    const input = { origin, ref: { kind, executionReference: { kind: 'participation' } }, bytes: new Uint8Array([1]), context: { authorizeSend } } as any;
    await expect(resolvers[0]!(input)).rejects.toThrow('WORLD_RUNTIME_STOPPED');
    await expect(resolvers[1]!(input)).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
  }
  expect(storeForCommand).not.toHaveBeenCalled(); expect(authorizeSend).not.toHaveBeenCalled();
  replacement.stop(); await Promise.all([original.whenIdle(), replacement.whenIdle()]);
});
