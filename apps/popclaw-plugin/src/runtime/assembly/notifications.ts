/**
 * Notifications of the runtime assembly: the queue and how it is consumed,
 * the reply-ping and invitation ledgers, and the wiring that enqueues into
 * them. Private to `runtime/assembly`; the public interface is `assembleRuntime`.
 */
import type { HostAdapter } from '../../host/host-adapter.js';
import { SqliteNotifier } from '../../notifier/sqlite-notifier.js';
import { ReplyPingsStore, routeReplyPing } from '../../pings/reply-pings.js';
import { PendingInvitesStore, type InviteNotifyWiring } from '../../invite/pending-invites.js';
import { notifierForOrigin } from '../house-lifecycle/notification-scope.js';
import { deriveSigil } from '../../invite/sigil.js';
import { profileUrl } from '../../lshow/sources/web-fallback.js';
import type { SocialLogRecorder } from '../../social-log/social-log.js';
import type { BondContext } from '../../bonds/bond-context.js';
import type { HouseRuntime } from '../house-lifecycle/house-runtime.js';
import type { Boot } from './core.js';
import type { AnyRuntimePorts } from './ports.js';

type ResourceConfig = Parameters<HouseRuntime['configureResources']>[0];
export type ReplyPingRoute = NonNullable<ResourceConfig['onContent']>;

export function buildQueues(host: HostAdapter, ports: AnyRuntimePorts) {
  const notifier = new SqliteNotifier(host.db);
  const delivery = ports.delivery;
  if (delivery.kind === 'pull') notifier.bindConsumer(delivery.consumerId());
  const replyPings = new ReplyPingsStore(host.db);
  const pendingInvites = new PendingInvitesStore(host.db);
  return { notifier, replyPings, pendingInvites };
}

/**
 * The invitation outcome wiring both paths share (SSE approval / polling
 * rejection). `pushToOwner` is the push leg's delivery (push delivery); on a
 * pull root it is absent and nothing is pushed: the notice stays queued and
 * surfaces on the next tool call.
 */
export function inviteWiring(boot: Boot, ports: AnyRuntimePorts, pendingInvites: PendingInvitesStore,
  notifier: SqliteNotifier, pushToOwner: (() => void) | undefined): InviteNotifyWiring {
  return {
    ownerPopclawId: boot.popclawId,
    pending: pendingInvites,
    notifier: ports.drift.inviteNotifierUnattributed ? notifier : notifierForOrigin(notifier, boot.loreHouseUrl),
    notifyOwner: pushToOwner ?? (() => {}),
    profileUrl: () => profileUrl(boot.nickname, deriveSigil(boot.popclawId), boot.webBaseUrl),
  };
}

/**
 * Replies to the owner's content, routed into the queue attributed to the
 * house they landed in. On a push root a FIRST reply is pushed to the owner
 * (`pushOnFirstReply`, read per reply) and a root with `LogPort.replyPing`
 * logs every outcome that concerns the owner; a pull root does neither.
 */
export function replyPingRoute(input: {
  boot: Boot; ports: AnyRuntimePorts; replyPings: ReplyPingsStore; notifier: SqliteNotifier;
  socialLog: SocialLogRecorder; bondContext: BondContext; pushOnFirstReply: (() => void) | undefined;
}): ReplyPingRoute {
  const { boot, ports, replyPings, notifier, socialLog, bondContext, pushOnFirstReply } = input;
  return (house, item) => {
    try {
      const outcome = routeReplyPing({ownerPopclawId: boot.popclawId, cache: house.cache, pings: replyPings, notifier: notifierForOrigin(notifier, house.baseUrl), socialLog,
        ...(ports.drift.replyPingBondContextAbsent ? {} : { bondContext })}, item);
      if (ports.log.replyPing && outcome !== 'not-mine' && outcome !== 'self') ports.log.replyPing(`reply-ping ${outcome} [${house.slug}]`);
      if (outcome === 'first') pushOnFirstReply?.();
    } catch (error) { ports.log.warn(`reply-ping routing failed: ${String(error)}`); }
  };
}
