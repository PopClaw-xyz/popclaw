/** Anonymous raw reception, owned by the existing resident and never a business gate. */
import { initializePublicStreamJournal } from '../../host/execution-store-migration.js';
import bs58 from 'bs58';
import type { HostDb } from '../../host/host-db.js';
import type { ExecutionStoreCatalog, ExecutionCatalogRow, ExecutionPartition } from '../../host/execution-store.js';
import { PUBLIC_JOURNAL_TABLES } from '../../host/execution-store-schema.js';
import { executionDbFor, type HouseStore } from '../../ingress/world-feed-store.js';
import { PublicV1Receiver } from '../../ingress/public-world-stream-client.js';
import { EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST, verifyPublicStreamJournalSchema } from '../../world/scoped-stream-journal.js';
import { readHouseCapabilityView, type HouseCapabilityView } from '../../world/world-capabilities.js';
import { parseWorldManifest } from '../../world/json-profile.js';
import { normalizeAckKeyHex } from './control-client.js';
import { readParticipation } from './participation-store.js';
import type { OwnerAuthority } from './manager.js';
import type { PublicResourceFactory, PublicResourceSelection } from './coordinator.js';

export interface PublicReadStatus {
  readonly mode: 'public-v1' | 'unselected';
  readonly support: 'supported' | 'unsupported';
  readonly transport: 'inactive' | 'starting' | 'active' | 'unavailable';
  readonly detail: string;
  readonly receive?: ReturnType<PublicV1Receiver['receiveStatus']>;
  readonly consumers: { readonly cache: 'unsupported'; readonly notifications: 'unsupported'; readonly ranger: 'unsupported' };
}
const unsupportedConsumers = Object.freeze({ cache: 'unsupported', notifications: 'unsupported', ranger: 'unsupported' } as const);
function hasPublicReservation(row: ExecutionCatalogRow): boolean {
  const required: unknown = JSON.parse(row.required_tables ?? '[]');
  return Array.isArray(required) && required.every(name => typeof name === 'string')
    && PUBLIC_JOURNAL_TABLES.every(name => required.includes(name));
}
export function inactivePublicReadStatus(selected: boolean, detail = ''): PublicReadStatus {
  return { mode: selected ? 'public-v1' : 'unselected', support: 'unsupported', transport: 'inactive', detail, consumers: unsupportedConsumers };
}

/** Missing official_ids is a proven empty policy; malformed IDs are not. */
export function publicProducerPolicy(view: HouseCapabilityView) {
  const manifest = parseWorldManifest(view.verified.manifestBytes, new Map());
  const ids = manifest.official_ids === undefined ? [] : manifest.official_ids;
  if (!Array.isArray(ids) || ids.some(id => {
    if (typeof id !== 'string') return true;
    try { const bytes = bs58.decode(id); return bytes.length !== 32 || bs58.encode(bytes) !== id; }
    catch { return true; }
  })) throw new Error('PUBLIC_PRODUCER_POLICY_INVALID');
  return Object.freeze({ house: view.verified.house, capabilityRevision: view.verified.capabilityRevision,
    officialActorIds: Object.freeze([...new Set(ids as string[])].sort()) });
}

export interface PublicReadResourceOptions {
  readonly db: HostDb;
  readonly catalog: ExecutionStoreCatalog;
  readonly authority: OwnerAuthority;
  selected(): boolean;
  pinFor(origin: string): string;
  consumersAllowed(): boolean;
  storeFor(origin: string): Promise<HouseStore>;
  readonly fetch?: typeof globalThis.fetch;
  log?(message: string): void;
}

export class PublicReadResources implements PublicResourceFactory {
  private readonly resources = new Map<string, PublicReadResource>();
  private readonly refused = new Map<string, string>();
  constructor(private readonly options: PublicReadResourceOptions) {}

  status(origin: string): PublicReadStatus {
    const refused = this.refused.get(origin);
    if (refused) return inactivePublicReadStatus(this.options.selected(), refused);
    return this.resources.get(origin)?.status()
      ?? inactivePublicReadStatus(this.options.selected(), this.refused.get(origin) ?? 'No active resident public receiver');
  }

  capture(origin: string): PublicResourceSelection | null {
    const opts = this.options;
    try {
      if (!opts.selected()) return null;
      const epoch = opts.authority.captureEpoch(), row = readParticipation(opts.db, origin);
      if (epoch === null || !row || row.desired !== 'enabled') throw new Error('PUBLIC_OWNER_OR_INTENT_INACTIVE');
      if (!opts.consumersAllowed()) throw new Error('PUBLIC_CONSUMERS_HELD');
      const view = readHouseCapabilityView(opts.db, origin), capability = view?.publicStreamCapability;
      if (!view || view.publicStream.validation !== 'valid' || !capability) throw new Error('PUBLIC_CAPABILITY_UNAVAILABLE');
      const pin = normalizeAckKeyHex(opts.pinFor(origin));
      if (!pin || pin !== normalizeAckKeyHex(capability.house.houseKey)) throw new Error('PUBLIC_PIN_MISMATCH');
      const producerPolicy = publicProducerPolicy(view);
      const selection = Object.freeze({ fullPublic: true, scopes: Object.freeze([...capability.publicStream.initial_public_scopes].sort()) });
      const catalogRow = opts.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
      if (!catalogRow || catalogRow.actor_id !== opts.catalog.options.actorId) throw new Error('PUBLIC_EXECUTION_BINDING_UNAVAILABLE');
      if (!hasPublicReservation(catalogRow)) {
        throw new Error('PUBLIC_JOURNAL_INITIALIZATION_REQUIRED');
      }
      const key = JSON.stringify([origin, catalogRow.actor_id, catalogRow.store_id, epoch, row.op_seq, pin, capability, selection]);
      // Every use consults durable owner/intent/pin/view again. An AbortSignal
      // alone cannot fence cross-process logout or a takeover between polls.
      const active = () => {
        if (!opts.selected() || !opts.authority.isEpochCurrent(epoch) || !opts.consumersAllowed()) return false;
        const current = readParticipation(opts.db, origin);
        if (current?.desired !== 'enabled' || current.op_seq !== row.op_seq || normalizeAckKeyHex(opts.pinFor(origin)) !== pin) return false;
        const latest = readHouseCapabilityView(opts.db, origin);
        if (latest?.publicStream.validation !== 'valid' || JSON.stringify(latest.publicStreamCapability) !== JSON.stringify(capability)) return false;
        const selected = opts.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
        return selected?.actor_id === catalogRow.actor_id && selected.store_id === catalogRow.store_id
          && selected.layout_version === catalogRow.layout_version
          && hasPublicReservation(selected);
      };
      this.refused.delete(origin);
      return { key, open: () => {
        const resource = new PublicReadResource(opts, origin, active, async current => {
          const house = await opts.storeFor(origin);
          if (!current()) return null;
          if (house.baseUrl !== origin) throw new Error('HOUSE_STORE_BINDING_MISMATCH');
          const partition = opts.catalog.open(origin);
          if (partition.storeId !== catalogRow.store_id || executionDbFor(house) !== partition.db) throw new Error('PUBLIC_EXECUTION_HANDLE_MISMATCH');
          opts.catalog.verifySelected(origin, partition);
          verifyPublicStreamJournalSchema(partition.db);
          if (!current()) return null;
          // An empty selected journal is not proof of freshness. The initializer
          // requires a real factory credential and consumes it atomically with
          // the verified binding/profile/cursors before any receiver is built.
          if (!partition.db.queryOne('SELECT 1 FROM world_public_bindings_v1 LIMIT 1')) {
            initializePublicStreamJournal({catalog:opts.catalog, origin, configuredPin:pin,
              activation:{partition, assertCurrent:() => {
                if (!current()) throw new Error('PUBLIC_PREPARATION_CAPTURE_CHANGED');
              }}});
          }
          if (!current()) return null;
          return { partition, capability, producerPolicy, selection };
        });
        this.resources.set(origin, resource);
        return resource;
      } };
    } catch (error) {
      this.refused.set(origin, String(error));
      return null;
    }
  }
}

type Prepared = { partition: ExecutionPartition;
  capability: NonNullable<HouseCapabilityView['publicStreamCapability']>;
  producerPolicy: ReturnType<typeof publicProducerPolicy>;
  selection: Readonly<{ fullPublic: boolean; scopes: readonly string[] }> };
class PublicReadResource {
  private readonly abort = new AbortController();
  private receiver: PublicV1Receiver | null = null;
  private partition: ExecutionPartition | null = null;
  private stopped = false;
  private detail = '';
  private stopTask: Promise<void> | null = null;
  private readonly startup: Promise<void>;
  constructor(private readonly opts: PublicReadResourceOptions, private readonly origin: string,
    private readonly capturedActive: () => boolean, prepare: (current: () => boolean) => Promise<Prepared | null>) {
    this.startup = Promise.resolve().then(async () => {
      if (!this.isActive()) return;
      const prepared = await prepare(() => this.isActive());
      if (!prepared || !this.isActive()) return;
      this.partition = prepared.partition;
      const receiver = new PublicV1Receiver({ capability: prepared.capability, producerPolicy: prepared.producerPolicy,
        selection: prepared.selection, executionDb: prepared.partition.db,
        gate: { origin, signal: this.abort.signal, isActive: () => this.isActive() },
        consumers: [], approvedConsumerMappingDigest: EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST,
        fetch: opts.fetch, onError: (error: unknown) => { this.detail = String(error); opts.log?.(`public receiver (${origin}): ${String(error)}`); } });
      this.receiver = receiver;
      if (!this.isActive()) { this.requestStop(); return; }
      await receiver.start();
      if (!this.isActive()) this.requestStop();
    }).catch(error => {
      this.detail = String(error); opts.log?.(`public startup (${origin}): ${String(error)}`);
      this.requestStop();
    });
  }
  private isActive(): boolean {
    if (this.stopped || this.abort.signal.aborted) return false;
    try {
      if (!this.capturedActive()) return false;
      if (this.partition && !this.opts.catalog.isPublicJournalCurrent(this.origin, this.partition)) return false;
      return true;
    } catch (error) { this.detail = String(error); return false; }
  }
  private requestStop(): void {
    void this.stop().catch(error => { this.detail = String(error); this.opts.log?.(`public teardown (${this.origin}): ${String(error)}`); });
  }
  refresh(): void { if (!this.isActive()) this.requestStop(); }
  status(): PublicReadStatus {
    let active = this.isActive(), receive: ReturnType<PublicV1Receiver['receiveStatus']> | undefined;
    try { receive = this.receiver?.receiveStatus(); }
    catch (error) { this.detail = String(error); active = false; }
    return { mode: 'public-v1', support: this.receiver ? 'supported' : 'unsupported',
      transport: active ? (this.receiver?.isReceiving() ? 'active' : this.detail ? 'unavailable' : 'starting') : 'inactive',
      detail: this.detail, ...(receive ? { receive: { ...receive, connected: active && receive.connected,
        caughtUp: active && receive.caughtUp, phase: active ? receive.phase : 'unavailable' as const } } : {}), consumers: unsupportedConsumers };
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.stopTask = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.stopped = true; this.abort.abort();
    // Fence immediately; join in an outer continuation so a receiver callback
    // can request stop without awaiting its own startup or receive promise.
    const receiver = this.receiver;
    let stopped: Promise<void>;
    try { stopped = Promise.resolve(receiver?.stop()); } catch (error) { stopped = Promise.reject(error); }
    void Promise.allSettled([this.startup, stopped]).then(async results => {
      await receiver?.whenIdle();
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    }).then(resolve, reject);
    return this.stopTask;
  }
}
