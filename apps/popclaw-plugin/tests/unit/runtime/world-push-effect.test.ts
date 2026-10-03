import { expect, it, vi } from 'vitest';
import { WorldRuntime } from '../../../src/runtime/world-runtime.js';
import type { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { HousePushEffectResolver } from '../../../src/runtime/house-lifecycle/push-effect.js';
import type { Signer } from '../../../src/identity/signer.js';
import { firstReleaseView } from '../../fixtures/world/first-release-view.js';
import { prepareWorldIntentPushEffect, type WorldIntentPushEffectOptions } from '../../../src/runtime/world-push-effect.js';

it('keeps the old helper unable to reconstruct native policy authority from a durable reference', () => {
  const queryOne = vi.fn(), authorizeSend = vi.fn(), capabilities = vi.fn();
  expect(() => prepareWorldIntentPushEffect({ db: { queryOne }, house: { origin: 'https://world.invalid' }, actorId: 'unused',
    bytes: new Uint8Array(), ref: { version: 1, kind: 'world_intent', requestId: 'a'.repeat(64),
      executionReference: { kind: 'native_policy', reservationId: 'b'.repeat(64) } },
    context: { authorizeSend }, capabilities } as unknown as WorldIntentPushEffectOptions)).toThrow('WORLD_LOCAL_UNSUPPORTED');
  expect(queryOne).not.toHaveBeenCalled(); expect(authorizeSend).not.toHaveBeenCalled(); expect(capabilities).not.toHaveBeenCalled();
});

// The prior reader/owner actual-send cases were for the old candidate only.
// No current first-release result consumer is installed in Unit A.
it.each(['owner_action', 'native_policy', 'participation'])('rejects %s effects before local authorization, store access or send', async reference => {
  const origin = 'https://world.invalid', actorId = '11111111111111111111111111111111';
  let resolver!: HousePushEffectResolver;
  const storeForCommand = vi.fn(), fetch = vi.fn(), authorizeSend = vi.fn();
  const houses = { configurePushEffectResolver: (value: HousePushEffectResolver) => { resolver = value; }, storeForCommand } as unknown as HouseRuntime;
  const worlds = new WorldRuntime({ mode: 'commands', houses, signer: {} as Signer, actorId, fetch,
    readCapabilities: () => firstReleaseView(origin, actorId) });
  await expect(resolver({ origin, ref: { kind: 'world_intent', executionReference: { kind: reference } }, bytes: new Uint8Array([1]), context: { authorizeSend } } as any)).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
  expect(storeForCommand).not.toHaveBeenCalled(); expect(authorizeSend).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  worlds.stop(); await worlds.whenIdle();
});
