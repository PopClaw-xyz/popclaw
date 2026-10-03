import { decodeEnvelope } from '../protocol/public-envelope.js';
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import type { Signer } from '../identity/signer.js';
import { ScopedWorldStreamClient } from '../ingress/scoped-world-stream-client.js';
import { WorldActionClient, type WorldActionClientOptions } from '../world/action-client.js';
import { createWorldActionResultDelivery } from '../world/action-result-delivery.js';
import { PrivateWorldMessages } from '../world/private-world-messages.js';
import { createPrivateWorldDelivery, type PrivateWorldDeliveryOptions } from '../world/private-world-delivery.js';
import { WorldReadiness } from '../world/world-readiness.js';
import { WorldPolicyRegistry, createWorldResultConsumers } from '../world/world-interaction-consumers.js';
import { WorldReadStateAuthorityStore } from '../world/world-action-authority.js';
import { WorldOwnerActionAuthorityStore } from '../world/world-owner-action-authority.js';
import type { TrustedWorldCapabilities } from '../world/world-capabilities.js';
import type { HouseGate } from './house-lifecycle/manager.js';
import type { HouseInboxConsumer } from './house-lifecycle/resource-set.js';
import { withResourceAction } from './house-lifecycle/action-context.js';

export interface WorldPlainInboxMessage {
  readonly dm: popclaw.event.IDirectMessage;
  readonly envelopeBytes: Uint8Array;
  readonly nickname: string;
  readonly originalText: string;
}
export interface WorldResourceOptions {
  db: HostDb; gate: HouseGate; signer: Signer; actorId: string;
  capabilities: TrustedWorldCapabilities;
  currentCapabilities(): TrustedWorldCapabilities | null;
  isOfficialActor(actorId: string): boolean;
  actions: Pick<WorldActionClientOptions, 'captureSession' | 'push' | 'controlRead' | 'readStatus' | 'now'>;
  onContent?(item: popclaw.event.IWorldFeedItem): void | Promise<void>;
  onPlain(message: WorldPlainInboxMessage): void | Promise<void>;
  onConversation: PrivateWorldDeliveryOptions['onConversation'];
  onReceipt?: PrivateWorldDeliveryOptions['onReceipt'];
  onState?: PrivateWorldDeliveryOptions['onState'];
  onError?(error: unknown): void;
  fetch?: typeof globalThis.fetch;
  retryMs?: number;
}
export interface WorldResource {
  readonly receiver: ScopedWorldStreamClient;
  readonly inbox: HouseInboxConsumer;
  readonly privateMessages: PrivateWorldMessages;
  readonly registry: WorldPolicyRegistry;
  readonly readiness: WorldReadiness;
  readonly readState: WorldReadStateAuthorityStore;
  /** Internal operator seam; never put this store in model-facing tool context. */
  readonly ownerActions: WorldOwnerActionAuthorityStore;
  client(): WorldActionClient;
  /** Route pending notifications from a second client sharing this DB handle. */
  wakeResults(): Promise<void>;
}

/** Compose the opt-in scoped world lane for one actual HouseResourceSet.
 * The root selects the lane and supplies durable private consumers. This factory
 * creates no owner grant, background model job, second receiver or session. */
export function createWorldResource(options: WorldResourceOptions): WorldResource {
  const { db, signer, actorId, gate } = options;
  const capabilities = structuredClone(options.capabilities), house = capabilities.house;
  let ready = false, stopped = false;
  const active = () => !stopped && !gate.signal.aborted && gate.isActive();
  const check = () => { if (!active()) throw new Error('WORLD_RESOURCE_NOT_STARTED'); };
  const resourceWork = <T>(work: () => T): T => { check(); return withResourceAction(gate, work); };
  const now = options.actions.now ?? (() => Math.floor(Date.now() / 1000));
  let consumers: ReturnType<typeof createWorldResultConsumers> | undefined = undefined;
  const receiver = new ScopedWorldStreamClient({ db, gate, capabilities, isOfficialActor: options.isOfficialActor,
    fetch: options.fetch, pendingRetryMs: options.retryMs, onError: options.onError,
    onContent: options.onContent && (item => resourceWork(() => options.onContent!(item))),
    onWorldEvent: event => resourceWork(() => {
      if (!consumers) throw new Error('WORLD_CONSUMERS_UNAVAILABLE');
      consumers.onWorldEvent(event);
    }),
    onState: state => { if (active() && consumers) resourceWork(() => consumers!.onStreamState(state)); },
  });
  const readiness = new WorldReadiness(db, house, actorId, receiver.journal);
  const registry = new WorldPolicyRegistry(db, house, actorId);
  const authorityOptions = { db, house, actorId, capabilities: options.currentCapabilities, readiness, now };
  const readState = new WorldReadStateAuthorityStore(authorityOptions);
  const ownerActions = new WorldOwnerActionAuthorityStore(authorityOptions);
  consumers = createWorldResultConsumers({ ...authorityOptions, registry, gate, readState, ownerActions,
    subscriptionReceiver: () => receiver });
  const client = new WorldActionClient({ ...options.actions, db, signer, actorId, house,
    capabilities: () => {
      const current = options.currentCapabilities();
      if (!current) throw new Error('CAPABILITY_CONTEXT_INCOMPLETE');
      return current;
    },
    onResult: result => resourceWork(() => consumers!.onResult(result)),
    onProgress: (bytes, query) => resourceWork(() => consumers!.onProgress(bytes, query)),
  });
  const resultDelivery = createWorldActionResultDelivery({ client, gate, retryMs: options.retryMs, onError: options.onError });
  const privateMessages = new PrivateWorldMessages({ db, gate, capabilities, recipientId: actorId,
    recipient: signer, isOfficialActor: options.isOfficialActor });
  const plain = (bytes: Uint8Array, originalText: string) => resourceWork(() => {
    // Both initial and recovery paths have already verified these exact bytes.
    // Do not trust a separately supplied DM/nickname or decrypt a second time.
    const envelopeBytes = new Uint8Array(bytes), envelope = decodeEnvelope(envelopeBytes);
    if (!envelope.directMessage) throw new Error('MESSAGE_ENVELOPE_BODY_INVALID');
    return options.onPlain({ dm: envelope.directMessage, envelopeBytes,
      nickname: (envelope.actor?.nickname ?? '').trim(), originalText });
  });
  const privateDelivery = createPrivateWorldDelivery({ db, gate, capabilities, actorId, readiness, cache: privateMessages,
    currentCapabilities: options.currentCapabilities, policyFor: id => registry.policy(id), participationIds: () => registry.participationIds(),
    now: () => new Date(now() * 1000).toISOString().replace('.000Z', 'Z'), retryMs: options.retryMs,
    onPlain: message => plain(message.envelopeBytes, message.originalText),
    onConversation: message => resourceWork(() => options.onConversation(message)),
    onReceipt: options.onReceipt && (message => resourceWork(() => options.onReceipt!(message))),
    onState: options.onState && (message => resourceWork(() => options.onState!(message))),
    onFailure: failure => options.onError?.(new Error(failure.reason)),
  });
  // data_version is connection-local and detects commits from other connections.
  // Capture before initial recovery: a concurrent commit during recovery must
  // still be visible to the first owner poll. Never persist this watermark.
  const version = (): number => {
    const value = db.queryOne<{ data_version: number }>('PRAGMA data_version')?.data_version;
    if (!Number.isSafeInteger(value)) throw new Error('WORLD_DATABASE_VERSION_UNAVAILABLE');
    return value!;
  };
  let dataVersion = version();
  let wakeRequested = false;
  const wakeResults = (): Promise<void> => {
    if (!active()) return Promise.resolve();
    // A same-handle reader can commit while startup is draining private work.
    // Keep that hint even though data_version does not change on this handle.
    wakeRequested = true;
    if (!ready) return Promise.resolve();
    wakeRequested = false;
    return resourceWork(() => resultDelivery.drain());
  };
  let recovering: Promise<void> | null = null;
  const inbox: HouseInboxConsumer = {
    drain: () => {
      if (!active()) return Promise.resolve();
      if (recovering) return recovering;
      recovering = Promise.resolve().then(async () => {
        await resourceWork(() => resultDelivery.drain()); check();
        await resourceWork(() => privateDelivery.drain()); check();
        ready = true;
        if (wakeRequested) void wakeResults();
        inbox.poll?.();
      }).finally(() => { recovering = null; });
      return recovering;
    },
    poll: () => {
      if (!ready || !active()) return;
      const current = version();
      if (current === dataVersion) return;
      const pending = client.hasPending();
      // Advance before the asynchronous pass, not after it: another connection
      // may commit during that pass and needs the next poll to observe it.
      dataVersion = current;
      if (pending) void wakeResults();
    },
    receive: async (_dm, bytes, _nickname) => {
      check();
      if (!ready) throw new Error('WORLD_RESOURCE_NOT_STARTED');
      // Capture before yielding so verified text and later metadata share one envelope.
      const envelope = new Uint8Array(bytes);
      const result = await resourceWork(() => privateDelivery.receive(envelope));
      // Durable structured failures retry in privateDelivery. A failed initial
      // cache write must remain a transport failure and never become plain.
      if (result.kind === 'storage_failed') throw new Error(result.reason);
      if (result.kind === 'plain') await plain(envelope, result.originalText);
    },
    stop: () => { stopped = true; ready = false; resultDelivery.stop(); privateDelivery.stop(); },
    whenIdle: async () => { await Promise.allSettled([recovering, resultDelivery.whenIdle(), privateDelivery.whenIdle()]); },
  };
  return { receiver, inbox, privateMessages, registry, readiness, readState, ownerActions, wakeResults,
    client: () => { check(); if (!ready) throw new Error('WORLD_RESOURCE_NOT_STARTED'); return client; } };
}
