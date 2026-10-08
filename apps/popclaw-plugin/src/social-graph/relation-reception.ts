/**
 * Relation reception, assembled once for every root.
 *
 * A follow only becomes a fact on the followee's machine, and it arrives on
 * that house's personal stream — the same connection its mail rides. Until
 * now nothing on this side listened: the reception chain existed, complete
 * and careful, in an assembly no root called, and a relation original that
 * reached a running plugin was dropped with a single line on stderr.
 *
 * `HouseResourceSet` is the personal stream's owner — one connection per
 * house, gated there, reconnected there — and it already offered everything
 * needed to hand a frame somewhere. This is the other half of that offer:
 * the chain, opened with no transport of its own, and the hooks that let the
 * resource set reach it.
 *
 * Assembling it three times would mean three chances to differ, and the way
 * that failure presents is the worst kind — following works on the gateway
 * and silently does not on an MCP host, with nothing anywhere saying why.
 * One factory, three callers, exactly like the producer side.
 *
 * DM keeps its existing path here. Routing mail onto the relation chain's
 * commit boundary is a real improvement and a separate decision: it changes
 * how every message is handled, and it is not needed to make a follow land.
 */
import type { HouseStore } from '../ingress/world-feed-store.js';
import type { HouseResourceOptions } from '../runtime/house-lifecycle/resource-set.js';
import { openRelationAwareInbox, type OpenedRelationHost, type RelationHostDeps } from './relation-host.js';

/** The subset of `configureResources` this wiring fills in. */
export type RelationResourceHooks = Pick<
  HouseResourceOptions,
  'attachRelations' | 'onFrame' | 'resumeFrom' | 'onCursorReset' | 'onTransport'
>;

export interface RelationReception {
  /** The chain itself, for roots that route more into it (leave, departures). */
  readonly host: OpenedRelationHost;
  /** Spread into `configureResources`. */
  readonly hooks: RelationResourceHooks;
  /** Stop the drain schedule. The transports belong to the resource sets. */
  stop(): void;
  /** After stop(), wait for this chain's already-started drain work. */
  whenIdle(): Promise<void>;
}

export async function openRelationReception(
  deps: Omit<RelationHostDeps, 'currentConnectionSerialOf'>,
): Promise<RelationReception> {
  // Whoever owns a house's transport, by slug. The chain asks this to tell a
  // cursor reset from the live connection apart from one that arrived on a
  // connection since replaced — a distinction delivery-time trust checks
  // cannot make, because both are trusted; only the era differs.
  const transports = new Map<string, { currentConnectionSerial(): number }>();

  // No urls: this assembly opens nothing. Every connection belongs to a
  // resource set, and houses arrive through `attachRelations` as their gates
  // open — which is also the only ordering that works, since a house whose
  // gate never opens has no stream to attach to.
  const host = await openRelationAwareInbox(
    { ...deps, currentConnectionSerialOf: (slug) => transports.get(slug)?.currentConnectionSerial() },
    [],
  );

  const hooks: RelationResourceHooks = {
    attachRelations: (house: HouseStore) => host.attach(house.baseUrl, house.slug),
    onFrame: (house, _gate, envelope, position) => host.reception.onFrame(envelope, house.slug, position),
    resumeFrom: (house) => host.reception.resumePosition(house.slug),
    onCursorReset: (house, _gate, reset, serial) => host.reception.onCursorReset(house.slug, reset, serial),
    onTransport: (house, transport) => { transports.set(house.slug, transport); },
  };

  return {
    host,
    hooks,
    stop() {
      host.stop();
      transports.clear();
    },
    whenIdle: () => host.whenIdle(),
  };
}
