import { decodeEnvelope, canonicalizeEnvelope } from '../protocol/public-envelope.js';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical, L_ENVELOPE_MAX_BYTES } from '@popclaw/algorithms';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { HostDb } from '../host/host-db.js';
import type { EnvelopeHandler, EventIngress } from './event-ingress.js';
import type { TrustedWorldCapabilities } from '../world/world-capabilities.js';
import { ScopedStreamJournal, type ScopedJournalStatus } from '../world/scoped-stream-journal.js';

/** Structural subset of the G0-owned captured HouseGate; no new lifecycle. */
export interface ScopedReceiverGate { readonly origin: string; readonly signal: AbortSignal; isActive(): boolean }
export interface ScopedWorldStreamOptions {
  readonly db: HostDb;
  readonly gate: ScopedReceiverGate;
  readonly capabilities: TrustedWorldCapabilities;
  readonly isOfficialActor: (actorId: string) => boolean;
  readonly onContent?: (item: popclaw.event.IWorldFeedItem) => void | Promise<void>;
  /** Generic world consumer, composed with the EventIngress handler if present. */
  readonly onWorldEvent?: EnvelopeHandler;
  readonly onError?: (error: unknown) => void;
  readonly onState?: (state: ScopedJournalStatus) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly reconnectMs?: number;
  /** Delay between failed durable-consumer passes; default 1000ms, range 1..60000ms. */
  readonly pendingRetryMs?: number;
}

function entry(caps: TrustedWorldCapabilities, kind: string): Record<string, unknown> {
  const rows = caps.manifest.event_kinds;
  if (!Array.isArray(rows)) throw new Error('WORLD_CAPABILITY_MISSING');
  const found = rows.find(row => row.kind === kind && row.transport === 'house');
  if (!found) throw new Error('WORLD_EVENT_KIND_UNKNOWN');
  return found as Record<string, unknown>;
}

export function verifyScopedEnvelope(raw: Uint8Array, caps: TrustedWorldCapabilities, isOfficialActor: (actor: string) => boolean): { eventId: string; publicScopes: readonly string[] } {
  if (!raw.length || raw.length > L_ENVELOPE_MAX_BYTES) throw new Error('WORLD_ENVELOPE_SIZE_LIMIT');
  const envelope = decodeEnvelope(raw);
  const allowedFields = new Set(['eventId', 'actor', 'target', 'lorehouse', 'timestamp', 'signature', 'prevEventId', 'houseEvent']);
  if (Object.keys(envelope).some(key => !allowedFields.has(key))) throw new Error('WORLD_SCOPED_BODY_INVALID');
  if (!/^[0-9a-f]{64}$/.test(envelope.eventId) || !envelope.actor?.popclawId || envelope.signature.length !== 64) throw new Error('WORLD_ENVELOPE_INVALID');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(envelope.actor.popclawId)) throw new Error('WORLD_ENVELOPE_INVALID');
  const actorKey = bs58.decode(envelope.actor.popclawId);
  const canonical = canonicalizeEnvelope(envelope);
  if (actorKey.length !== 32 || bs58.encode(actorKey) !== envelope.actor.popclawId || cidFromCanonical(canonical) !== envelope.eventId || !nacl.sign.detached.verify(canonical, envelope.signature, actorKey)) throw new Error('WORLD_ENVELOPE_SIGNATURE_INVALID');
  if (envelope.body !== 'houseEvent' || !envelope.houseEvent || (envelope.target?.scope ?? 0) !== 0) throw new Error('WORLD_SCOPED_BODY_INVALID');
  const event = envelope.houseEvent;
  const capability = entry(caps, event.kind ?? '');
  if (event.schemaVersion !== capability.schema_version) throw new Error('SCHEMA_VERSION_UNSUPPORTED');
  const officialIds = caps.manifest.official_ids;
  if (capability.signer === 'official' && (!Array.isArray(officialIds) || !officialIds.includes(envelope.actor.popclawId) || !isOfficialActor(envelope.actor.popclawId))) throw new Error('WORLD_OFFICIAL_REQUIRED');
  const selected = event.publicScopes ?? [];
  if (!selected.length || selected.length > 32 || new Set(selected).size !== selected.length || selected.some(scope => !/^[A-Za-z0-9_-]{4,64}$/.test(scope))) throw new Error('WORLD_SCOPE_INVALID');
  if (capability.public_scope_declaration === 'manifest_scopes_only') {
    const initial = (caps.manifest.world_interaction as Record<string, unknown>).initial_public_scopes;
    if (!Array.isArray(initial) || selected.some(scope => !initial.includes(scope))) throw new Error('WORLD_SCOPE_UNDECLARED');
  }
  return { eventId: envelope.eventId, publicScopes: [...selected] };
}

/** Retained source compatibility for old action/readiness composition. The old
 * scoped negotiation is retired; construction never creates storage or a socket. */
export class ScopedWorldStreamClient implements EventIngress {
  readonly journal!: ScopedStreamJournal;
  constructor(_options: ScopedWorldStreamOptions) { throw new Error('WORLD_SCOPED_TRANSPORT_UNSUPPORTED'); }
  installSubscription(_descriptor: popclaw.world.ISubscriptionDescriptor): never { throw new Error('WORLD_SCOPED_TRANSPORT_UNSUPPORTED'); }
  assertBinding(_db: HostDb, _house: popclaw.world.IHouseBinding): never { throw new Error('WORLD_SCOPED_TRANSPORT_UNSUPPORTED'); }
  async start(_handler?: EnvelopeHandler): Promise<void> { throw new Error('WORLD_SCOPED_TRANSPORT_UNSUPPORTED'); }
  isReceiving(): boolean { return false; }
  onConnected(_callback: () => void): void {}
  status(): ScopedJournalStatus { throw new Error('WORLD_SCOPED_TRANSPORT_UNSUPPORTED'); }
  async stop(): Promise<void> {}
  async whenIdle(): Promise<void> {}
}
