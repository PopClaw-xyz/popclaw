/**
 * The gateway's runtime types. No runtime imports: command wiring must be
 * able to use this contract without loading the host SDK or assembly.
 * Gateway-specific slots stay out of the contract shared by all roots.
 */
import type { createOpenClawWorldExecution } from '../host/openclaw-world-execution.js';
import type { createWorldOwnerApproval } from '../host/openclaw-owner-approval.js';
import type { OwnerSession } from '../notifier/owner-session.js';
import type { OwnerNotifier, RuntimeOwnerNotifier } from '../notifier/owner-notifier.js';
import type { NotifyHereAddress } from '../commands/notify-target.js';
import type { AssembledRuntime } from './assembly/index.js';
import type { RuntimePorts } from './assembly/ports.js';
import type { PluginRuntime } from './plugin-runtime.js';

/** The gateway's owner-lane slots on the bag (row 8). */
export interface GatewayWorldSlots {
  readonly nativeWorldExecution: ReturnType<typeof createOpenClawWorldExecution>;
  readonly worldOwnerApproval: ReturnType<typeof createWorldOwnerApproval>;
}

/** The gateway's push-leg slots (rows 9/17/18), supplied once by the host. */
export interface GatewayPushSlots {
  /** Owner session captured by commands for background L1 delivery. */
  readonly ownerSession: OwnerSession;
  readonly ownerNotifier: RuntimeOwnerNotifier;
  /** #236: retry first, then read the remaining backlog. */
  readonly drainNotifications: () => Promise<void>;
  readonly retryDmNotifications: () => Promise<void>;
  readonly notifyBacklog: () => { count: number; lastFailureAt?: number; lastFailureReason?: string };
}

/** Host services start/stop the resident loops, including the follower poll. */
export type GatewayRuntimePorts = RuntimePorts<GatewayWorldSlots, GatewayPushSlots, 'host-services'>;

type GatewayAssembly = AssembledRuntime<GatewayWorldSlots, GatewayPushSlots, 'host-services'>;

/**
 * Preserve the existing command/tool view of the notification queue: its
 * interface and optional retry helpers come from the shared contract. The
 * host still has to supply every required push slot through its ports.
 */
type SharedNotificationView = Pick<PluginRuntime,
  'notifier' | 'drainNotifications' | 'retryDmNotifications' | 'notifyBacklog'> & {
    readonly ownerNotifier: Pick<GatewayPushSlots['ownerNotifier'], keyof OwnerNotifier>;
  };

/**
 * The gateway bag follows the assembly's slots and lifecycle mode. Retain
 * the consumer contract's readonly shutdown handle and notification interfaces;
 * pendingFollows comes from PluginRuntime, followerSync from host-services.
 */
export type OpenClawPluginRuntime =
  Omit<GatewayAssembly, keyof SharedNotificationView | 'shutdown'> &
  SharedNotificationView & Readonly<Pick<GatewayAssembly, 'shutdown'>> & {
    /** Full routable address of the most recent command; updated per command. */
    lastCommandAddress?: NotifyHereAddress;
  };
