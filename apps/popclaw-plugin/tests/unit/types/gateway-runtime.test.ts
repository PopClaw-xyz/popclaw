import { describe, expectTypeOf, it } from 'vitest';
import type { GatewayPushSlots, GatewayRuntimePorts, GatewayWorldSlots, OpenClawPluginRuntime } from '../../../src/runtime/gateway-runtime.js';
import type { GatewayRuntimePorts as HostPorts } from '../../../src/host/openclaw-runtime-ports.js';
import type { AssembledRuntime } from '../../../src/runtime/assembly/index.js';
import type { PluginRuntime } from '../../../src/runtime/plugin-runtime.js';
import type { OwnerNotifier, RuntimeOwnerNotifier } from '../../../src/notifier/owner-notifier.js';
import type { FollowerSyncService } from '../../../src/social-graph/follower-sync-service.js';
import type { NotifyHereAddress } from '../../../src/commands/notify-target.js';

// These checks run through package tsc as well as Vitest. No runtime bag is
// constructed, and neither the SDK-backed host nor assembly is loaded.
describe('gateway runtime consumer contract', () => {
  it('carries the world and push slots and the host-service follower poll', () => {
    expectTypeOf<Pick<OpenClawPluginRuntime, keyof GatewayWorldSlots>>().toEqualTypeOf<GatewayWorldSlots>();
    expectTypeOf<OpenClawPluginRuntime['ownerSession']>().toEqualTypeOf<GatewayPushSlots['ownerSession']>();
    expectTypeOf<OpenClawPluginRuntime['followerSync']>().toEqualTypeOf<FollowerSyncService>();
    expectTypeOf<OpenClawPluginRuntime['pendingFollows']>().toEqualTypeOf<PluginRuntime['pendingFollows']>();
    expectTypeOf<HostPorts>().toEqualTypeOf<GatewayRuntimePorts>();
    expectTypeOf<GatewayRuntimePorts['lifecycle']['loops']>().toEqualTypeOf<'host-services'>();
  });

  it('preserves the consumer notification interfaces and optional retry helpers', () => {
    type NotificationKeys = 'notifier' | 'drainNotifications' | 'retryDmNotifications' | 'notifyBacklog';
    expectTypeOf<Pick<OpenClawPluginRuntime, NotificationKeys>>().toEqualTypeOf<Pick<PluginRuntime, NotificationKeys>>();
    expectTypeOf<OpenClawPluginRuntime['ownerNotifier']>().toEqualTypeOf<OwnerNotifier>();
    expectTypeOf<GatewayPushSlots['ownerNotifier']>().toEqualTypeOf<RuntimeOwnerNotifier>();
    expectTypeOf<OpenClawPluginRuntime['shutdown']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<OpenClawPluginRuntime['lastCommandAddress']>().toEqualTypeOf<NotifyHereAddress | undefined>();
  });

  it('rejects a missing push slot and preserves readonly handles at compile time', () => {
    function check(rt: OpenClawPluginRuntime, replacement: OpenClawPluginRuntime, incomplete: Omit<GatewayPushSlots, 'retryDmNotifications'>) {
      rt.lastCommandAddress = undefined;
      // @ts-expect-error The host must supply the durable DM retry slot.
      const slots: GatewayPushSlots = incomplete;
      // @ts-expect-error Commands may not replace the shutdown handle.
      rt.shutdown = async () => {};
      // @ts-expect-error Commands may not replace the owner session.
      rt.ownerSession = slots.ownerSession;
      // @ts-expect-error Commands may not replace the host-service follower poll.
      rt.followerSync = replacement.followerSync;
      // @ts-expect-error Commands may not replace the shared pending-follow store.
      rt.pendingFollows = replacement.pendingFollows;
    }
    void check;
    // Inline roots have no host-service follower poll or gateway owner session.
    expectTypeOf<'followerSync'>().not.toMatchTypeOf<keyof AssembledRuntime<Record<never, never>>>();
    expectTypeOf<'ownerSession'>().not.toMatchTypeOf<keyof PluginRuntime>();
  });
});
