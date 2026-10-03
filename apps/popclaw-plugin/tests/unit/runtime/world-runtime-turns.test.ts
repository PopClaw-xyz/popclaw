import { expect, it, vi } from 'vitest';
import { WorldRuntime } from '../../../src/runtime/world-runtime.js';
import type { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { HostWorldTurnHost } from '../../../src/runtime/host-world-turn.js';
import { firstReleaseView } from '../../fixtures/world/first-release-view.js';

// Real coordinator/authority tests remain in their unchanged low-level suites.
// The prior automatic-C root integration is fixed historical evidence only.
it.each(['commands', 'resident'] as const)('never starts model or budget work from a %s first-release observation', async mode => {
  const origin = 'https://world.invalid', actorId = '11111111111111111111111111111111';
  const storeForCommand = vi.fn(), run = vi.fn(), isAvailable = vi.fn(), onConversation = vi.fn(), onPlain = vi.fn();
  const houses = { configurePushEffectResolver: vi.fn(), storeForCommand } as unknown as HouseRuntime;
  const worlds = new WorldRuntime({ houses, signer: {} as Signer, actorId,
    readCapabilities: () => firstReleaseView(origin, actorId), supportsBackgroundTurns: () => true,
    turns: { host: { run, isAvailable } as unknown as HostWorldTurnHost },
    ...(mode === 'commands' ? { mode } : { mode, selectScopedLane: () => true, onConversation, onPlain }) });
  await expect(worlds.client(origin).invoke({ house: origin, kind: 'example.reply', params: {}, expected_capability_revision: 'a'.repeat(64) }, {} as any)).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
  expect(storeForCommand).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  expect(isAvailable).not.toHaveBeenCalled(); expect(onConversation).not.toHaveBeenCalled(); expect(onPlain).not.toHaveBeenCalled();
  worlds.stop(); await worlds.whenIdle();
});
