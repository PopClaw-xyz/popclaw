/**
 * The ordered-relation producer, assembled once for every root.
 *
 * `index.ts` (the gateway), `mcp.ts` (the MCP bridge) and `main.ts` (the CLI)
 * all have to hand `SocialGraph` the same producer. Assembling it three times
 * would mean three chances to differ, and the way that failure presents is
 * the worst kind: a capability wired into the gateway and invisible on an MCP
 * host, where the agent simply finds that following does not work and nothing
 * anywhere says why. One factory, three callers.
 *
 * There is no fallback in here. A root that cannot build a producer does not
 * get a degraded one — `SocialGraph` refuses relation writes outright, which
 * is the honest state while something is missing. This is a first release:
 * the older wire shape is not written at all, so there is nothing to fall
 * back TO.
 */
import type { PushResult } from '../egress/event-egress.js';
import type { HostDb } from '../host/host-db.js';
import type { Signer } from '../identity/signer.js';
import { createRelationProducer, type RelationProducer } from './relation-producer.js';
import { makeRelationScopeResolver } from './relation-scope.js';
import { makeRelationPush } from './relation-push.js';
import { relationSigningReadiness } from './relation-wiring.js';
import { RelationPendingIntentStore } from './relation-pending-intent-store.js';

export interface RelationProducerAssembly {
  readonly db: HostDb;
  readonly signer: Signer;
  /** Configured houses, in configured order; the first is home. */
  readonly houses: readonly { readonly slug: string; readonly origin: string }[];
  /**
   * Which house a person has been seen in, for routing a NEW follow. Absent
   * (the CLI, which holds no world-feed cache) routes to the home house —
   * the same answer the resolver gives when nobody has been seen anywhere.
   */
  readonly houseOf?: (popclawId: string) => string | undefined;
  /**
   * The verified push seam: the same egress the rest of the root uses.
   *
   * It must return the REAL receipt. The producer reads `status`/`eventId`
   * off it verbatim, so a wrapper that swallowed the result would turn every
   * successful push into 'unacknowledged' and leave every original queued
   * for a resend it does not need.
   */
  readonly pushTo: (houseSlug: string, bytes: Uint8Array) => Promise<PushResult>;
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

export function makeRelationProducer(deps: RelationProducerAssembly): RelationProducer {
  const houses = [...deps.houses];
  return createRelationProducer({
    db: deps.db,
    signer: deps.signer,
    // Pin-aware, and it decides the house — the producer never picks one.
    resolveScope: makeRelationScopeResolver({
      db: deps.db,
      houses,
      ...(deps.houseOf ? { houseOf: deps.houseOf } : {}),
    }),
    signingReadiness: relationSigningReadiness(deps.db),
    // Refuses an unknown house rather than falling back to home: a receipt
    // from a house that never owned the edge would close a todo the real
    // house never acknowledged.
    push: makeRelationPush({
      db: deps.db,
      houses,
      pushVerified: (slug, bytes) => deps.pushTo(slug, bytes),
    }),
    // A refusal is journalled even when the caller drops the outcome, so a
    // relation that did not happen can still be seen.
    recordPendingIntent: (intent) => new RelationPendingIntentStore(deps.db).append(intent),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
