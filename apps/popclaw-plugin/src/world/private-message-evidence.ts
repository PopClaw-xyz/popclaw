import { decodeEnvelope, canonicalizeEnvelope, L_ENVELOPE_MAX_BYTES } from '../protocol/public-envelope.js';
/** First-release private message evidence and shared classification.
 *
 * The current live path selects its evidence from a captured HouseCapabilityView
 * (readHouseCapabilityView shape): the selected `private_messages` board block
 * declares `version/kinds/participation`, the guide is exact verified bytes, and
 * the capability revision is the manifest CID. The retired
 * `features.structured_private_messages` flag and the historical
 * TrustedWorldCapabilities object are NOT evidence here.
 *
 * Nothing in this module touches a database, grants participation, merges a
 * descriptor, or calls a host callback. Classification is pure: bytes plus
 * evidence in, one of {dropped, plain, structured} out. */
import { popclaw } from '@popclaw/contracts';
import wrapperSchema from '@popclaw/contracts/world-interaction/private-message.schema.json';
import { cidFromCanonical } from '@popclaw/algorithms';
import Ajv2020 from 'ajv/dist/2020.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { Signer } from '../identity/signer.js';
import { jsonObject, parseWorldJson, parseWorldManifest, selectDeclaredRow } from './json-profile.js';
import { validateWorldPayload } from './schema-validator.js';
import type { HouseCapabilityView } from './world-capabilities.js';

const MAX_ENVELOPE = L_ENVELOPE_MAX_BYTES;
const MAX_MESSAGE = 65536;
const MAX_GUIDE = 524288;
const validateWrapper = new Ajv2020({ strict: false, validateSchema: false, allErrors: false }).compile(wrapperSchema);
const utf8 = new TextEncoder();

export const FIRST_RELEASE_PRIVATE_PROFILE = 'first-release-private-v1' as const;
export type PrivateMessageDeliveryClass = 'conversation' | 'receipt' | 'state';

export interface FirstReleasePrivateKindEvidence {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly signer: 'user' | 'official';
  readonly bodySchema: Record<string, unknown>;
}
export interface FirstReleasePrivateEvidence {
  readonly profile: typeof FIRST_RELEASE_PRIVATE_PROFILE;
  readonly house: Readonly<{ origin: string; houseKey: string; incarnation: string }>;
  readonly recipientId: string;
  readonly capabilityRevision: string;
  readonly manifestBytes: Uint8Array;
  readonly guideBytes: Uint8Array;
  readonly guideDigest: string;
  /** Board advertisement recorded for diagnostics; always false in a selected
   * M1 evidence — an advertising board is rejected as unavailable. */
  readonly participationAdvertised: boolean;
  readonly officialActorIds: readonly string[];
  /** Selected, currently valid private kinds (board kinds ∩ valid view kinds). */
  readonly kinds: ReadonlyMap<string, FirstReleasePrivateKindEvidence>;
}
export type FirstReleasePrivateSelection =
  | { readonly available: true; readonly evidence: FirstReleasePrivateEvidence }
  | { readonly available: false; readonly reason: string };

function fail(code: string): never { throw new Error(code); }
function unavailable(reason: string): FirstReleasePrivateSelection { return { available: false, reason }; }
function publicKeyId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) fail(code);
  const bytes = bs58.decode(value);
  if (bytes.length !== 32 || bs58.encode(bytes) !== value) fail(code);
  return value;
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    Object.values(value).forEach(freezeJson); Object.freeze(value);
  }
  return value;
}

/** Select current structured-private evidence from one captured capability view.
 * An unavailable selection still permits ordinary DM fallback downstream; it
 * never permits structured interpretation. */
export function selectFirstReleasePrivateEvidence(view: HouseCapabilityView | null, recipientId: string): FirstReleasePrivateSelection {
  try {
    const recipient = publicKeyId(recipientId, 'PRIVATE_RECIPIENT_INVALID');
    if (!view || view.privateMessages.validation !== 'valid') return unavailable('PRIVATE_BOARD_UNAVAILABLE');
    if (view.guide.validation !== 'valid') return unavailable('GUIDE_REQUIRED');
    const verified = view.verified, binding = verified.house;
    const houseKey = publicKeyId(binding.houseKey, 'PRIVATE_HOUSE_INVALID');
    const origin = binding.origin, incarnation = binding.incarnation;
    if (typeof origin !== 'string' || !/^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(origin)
      || typeof incarnation !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(incarnation)) return unavailable('PRIVATE_HOUSE_INVALID');
    const sourceGuide = verified.guideBytes;
    if (!sourceGuide || !sourceGuide.length || sourceGuide.length > MAX_GUIDE) return unavailable('GUIDE_REQUIRED');
    const guideBytes = new Uint8Array(sourceGuide);
    const manifestBytes = new Uint8Array(verified.manifestBytes);
    if (!manifestBytes.length || manifestBytes.length > MAX_ENVELOPE) return unavailable('PRIVATE_EVIDENCE_CHANGED');
    const capabilityRevision = verified.capabilityRevision;
    if (!/^[0-9a-f]{64}$/.test(capabilityRevision) || cidFromCanonical(manifestBytes) !== capabilityRevision)
      return unavailable('PRIVATE_EVIDENCE_CHANGED');
    const sizes = new Map<string, number>();
    const document = parseWorldManifest(manifestBytes, sizes);
    const board = jsonObject(document.world_interaction);
    const declared = jsonObject(board.private_messages);
    if (declared.version !== 1 || typeof declared.participation !== 'boolean' || !Array.isArray(declared.kinds))
      return unavailable('PRIVATE_BOARD_UNAVAILABLE');
    // M1: a board advertising participation is not a supported private board.
    // Nothing short of a contract change may treat it as structured evidence.
    if (declared.participation === true) return unavailable('PRIVATE_PARTICIPATION_UNSUPPORTED');
    if (jsonObject(board.guide).sha256 !== cidFromCanonical(guideBytes)) return unavailable('PRIVATE_EVIDENCE_CHANGED');
    if (!Array.isArray(document.official_ids) || !document.official_ids.length) return unavailable('PRIVATE_OFFICIAL_INVALID');
    const officialActorIds = Object.freeze([...new Set((document.official_ids as unknown[]).map(id => publicKeyId(id, 'PRIVATE_OFFICIAL_INVALID')))]);
    const kinds = new Map<string, FirstReleasePrivateKindEvidence>();
    for (const name of declared.kinds) {
      if (typeof name !== 'string') return unavailable('PRIVATE_BOARD_UNAVAILABLE');
      if (view.privateMessages.kinds[name]?.validation !== 'valid') continue;
      const selected = selectDeclaredRow(document, 'event_kinds', name, sizes);
      if (!selected) return unavailable('CAPABILITY_KIND_AMBIGUOUS');
      const row = selected.row;
      const schemaVersion = row.schema_version;
      if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 4294967295) return unavailable('CAPABILITY_KIND_INVALID');
      const signer = row.signer === 'official' ? 'official' as const : row.signer === 'user' ? 'user' as const : fail('CAPABILITY_KIND_INVALID');
      kinds.set(name, freezeJson({ kind: name, schemaVersion, signer, bodySchema: structuredClone(jsonObject(row.body_schema)) }));
    }
    const evidence: FirstReleasePrivateEvidence = freezeJson({
      profile: FIRST_RELEASE_PRIVATE_PROFILE, house: { origin, houseKey, incarnation }, recipientId: recipient,
      capabilityRevision, manifestBytes, guideBytes, guideDigest: cidFromCanonical(guideBytes),
      participationAdvertised: declared.participation, officialActorIds, kinds,
    });
    return { available: true, evidence };
  } catch (error) {
    return unavailable(error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message) ? error.message : 'PRIVATE_EVIDENCE_INVALID');
  }
}

/** Binding key shared with the historical v2 cache rows (recipient+House scoped). */
export function privateMessageBindingId(evidence: FirstReleasePrivateEvidence): string {
  return JSON.stringify([evidence.house.origin, evidence.house.houseKey, evidence.house.incarnation, evidence.recipientId]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function privateMessageWrapperDigest(wrapper: Record<string, unknown>): string {
  return cidFromCanonical(utf8.encode(canonicalJson(wrapper)));
}
/** State-anchor digest over the semantic content a state row replaces (same
 * fields the historical v2 cache digested; participation stays null here). */
export function privateMessageStateDigest(wrapper: Record<string, unknown>): string {
  return cidFromCanonical(utf8.encode(canonicalJson({ kind: wrapper.kind, schema_version: wrapper.schema_version,
    body: wrapper.body, participation: wrapper.participation ?? null })));
}

export interface PrivateEnvelopeBinding {
  readonly eventId: string;
  readonly senderId: string;
  readonly dm: popclaw.event.IDirectMessage;
  readonly envelopeBytes: Uint8Array;
}
/** Synchronous envelope authentication: size, shape, CID, signature and the
 * actor-only recipient binding. Never decrypts; never exposes foreign content. */
export function verifyPrivateEnvelopeBinding(originalEnvelope: Uint8Array, recipientId: string): PrivateEnvelopeBinding {
  if (!(originalEnvelope instanceof Uint8Array) || !originalEnvelope.length || originalEnvelope.length > MAX_ENVELOPE) fail('MESSAGE_ENVELOPE_SIZE_LIMIT');
  const raw = new Uint8Array(originalEnvelope);
  const envelope = decodeEnvelope(raw);
  const allowed = new Set(['eventId', 'actor', 'target', 'lorehouse', 'timestamp', 'signature', 'prevEventId', 'directMessage']);
  if (Object.keys(envelope).some(name => !allowed.has(name)) || envelope.body !== 'directMessage' || !envelope.directMessage) fail('MESSAGE_ENVELOPE_BODY_INVALID');
  const actor = envelope.actor?.popclawId;
  const actorKey = bs58.decode(publicKeyId(actor, 'MESSAGE_ENVELOPE_INVALID'));
  const canonical = canonicalizeEnvelope(envelope);
  if (!/^[0-9a-f]{64}$/.test(envelope.eventId) || envelope.signature.length !== 64
    || cidFromCanonical(canonical) !== envelope.eventId || !nacl.sign.detached.verify(canonical, envelope.signature, actorKey)) fail('MESSAGE_ENVELOPE_SIGNATURE_INVALID');
  const dm = envelope.directMessage;
  if (dm.fromPopclawId !== actor || dm.toPopclawId !== recipientId || envelope.target?.scope !== 1
    || envelope.target.targetIds?.length !== 1 || envelope.target.targetIds[0] !== recipientId || envelope.target.filterCriteria) fail('MESSAGE_RECIPIENT_MISMATCH');
  return { eventId: envelope.eventId, senderId: actor!, dm, envelopeBytes: raw };
}

export type PrivateMessageClassification =
  | { readonly kind: 'dropped'; readonly reason: string }
  | { readonly kind: 'plain'; readonly originalText: string; readonly reason: string }
  | {
    readonly kind: 'structured'; readonly originalText: string; readonly wrapper: Readonly<Record<string, unknown>>;
    readonly deliveryClass: PrivateMessageDeliveryClass; readonly wrapperDigest: string;
    readonly eventId: string; readonly senderId: string; readonly envelopeBytes: Uint8Array; readonly plaintextBytes: Uint8Array;
    readonly kindEvidence: FirstReleasePrivateKindEvidence;
  };
export interface PrivateClassifyContext {
  /** The one acceptable recipient; never caller-swappable per message. */
  readonly recipientId: string;
  readonly selection: FirstReleasePrivateSelection;
  readonly recipient: Pick<Signer, 'openDm'>;
  /** Trusted local handshake check, independent of manifest bytes. */
  readonly isOfficialActor: (actorId: string) => boolean;
  readonly signal?: AbortSignal;
  /** Called right after the schema-worker await (the only asynchronous step). */
  readonly onAsyncBoundary?: () => void;
}

/** Classify one inbox envelope under a current selection. Authentication
 * failures drop; metadata/content ineligibility preserves the authenticated
 * plaintext as an ordinary DM; only full official+schema acceptance is
 * structured. The single await is body-schema validation. */
export async function classifyPrivateMessage(originalEnvelope: Uint8Array, context: PrivateClassifyContext): Promise<PrivateMessageClassification> {
  let originalText: string | undefined;
  const plain = (text: string, reason: string): PrivateMessageClassification =>
    context.signal?.aborted ? { kind: 'dropped', reason: 'CAPABILITY_ABORTED' } : { kind: 'plain', originalText: text, reason };
  try {
    if (context.signal?.aborted) return { kind: 'dropped', reason: 'CAPABILITY_ABORTED' };
    const binding = verifyPrivateEnvelopeBinding(originalEnvelope, context.recipientId);
    const dm = binding.dm;
    if (!dm.ciphertext?.length) return plain(dm.body ?? '', 'MESSAGE_UNENCRYPTED');
    if (dm.ciphertext.length > MAX_ENVELOPE || dm.nonce?.length !== 24) return { kind: 'dropped', reason: 'MESSAGE_CIPHERTEXT_INVALID' };
    const decrypted = context.recipient.openDm(dm, binding.senderId);
    if (!decrypted.ok) return { kind: 'dropped', reason: 'MESSAGE_DECRYPT_FAILED' };
    originalText = decrypted.plaintext;
    const source = decrypted.plaintextBytes;
    if (!(source instanceof Uint8Array)) return plain(originalText, 'MESSAGE_STRICT_BYTES_UNAVAILABLE');
    if (source.length > MAX_MESSAGE) return plain(originalText, 'MESSAGE_SIZE_LIMIT');
    const plaintextBytes = new Uint8Array(source);
    originalText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintextBytes);
    if (originalText.length > MAX_MESSAGE) return plain(originalText, 'MESSAGE_SIZE_LIMIT');
    if (!context.selection.available) return plain(originalText, context.selection.reason);
    const evidence = context.selection.evidence;
    if (evidence.recipientId !== context.recipientId) fail('PRIVATE_EVIDENCE_MISMATCH');
    const official = () => evidence.officialActorIds.includes(binding.senderId) && context.isOfficialActor(binding.senderId);
    if (!official()) return plain(originalText, 'MESSAGE_SOURCE_UNPRIVILEGED');
    const wrapper = jsonObject(parseWorldJson(plaintextBytes, MAX_MESSAGE));
    if (!validateWrapper(wrapper)) return plain(originalText, 'MESSAGE_WRAPPER_INVALID');
    if (wrapper.capability_revision !== evidence.capabilityRevision) return plain(originalText, 'MESSAGE_REVISION_UNSUPPORTED');
    if (typeof wrapper.kind !== 'string') return plain(originalText, 'MESSAGE_KIND_UNSUPPORTED');
    const entry = evidence.kinds.get(wrapper.kind);
    if (!entry) return plain(originalText, 'MESSAGE_KIND_UNSUPPORTED');
    if (wrapper.schema_version !== entry.schemaVersion) return plain(originalText, 'MESSAGE_SCHEMA_VERSION_UNSUPPORTED');
    if (wrapper.house !== undefined) {
      const bound = jsonObject(wrapper.house);
      if (bound.origin !== evidence.house.origin || bound.house_key !== evidence.house.houseKey || bound.incarnation !== evidence.house.incarnation)
        return plain(originalText, 'MESSAGE_PARSE_PRESERVED');
    }
    if (wrapper.delivery_class === 'state' && (!wrapper.house || wrapper.state_ref === undefined || wrapper.state_revision === undefined))
      return plain(originalText, 'MESSAGE_PARSE_PRESERVED');
    if ((wrapper.state_ref === undefined) !== (wrapper.state_revision === undefined)) return plain(originalText, 'MESSAGE_PARSE_PRESERVED');
    if (wrapper.state_revision !== undefined && !/^(0|[1-9][0-9]{0,19})$/.test(String(wrapper.state_revision))) return plain(originalText, 'MESSAGE_PARSE_PRESERVED');
    // This increment installs no descriptor, whatever the board advertises.
    if (wrapper.participation !== undefined) return plain(originalText, 'MESSAGE_PARTICIPATION_UNSUPPORTED');
    await validateWorldPayload(entry.bodySchema, utf8.encode(JSON.stringify(wrapper.body)), { maxBytes: MAX_MESSAGE, signal: context.signal });
    context.onAsyncBoundary?.();
    if (context.signal?.aborted) return { kind: 'dropped', reason: 'CAPABILITY_ABORTED' };
    // Policies can change while the schema worker ran; official status is rechecked.
    if (!official()) return plain(originalText, 'MESSAGE_SOURCE_UNPRIVILEGED');
    return {
      kind: 'structured', originalText, wrapper, deliveryClass: wrapper.delivery_class as PrivateMessageDeliveryClass,
      wrapperDigest: privateMessageWrapperDigest(wrapper), eventId: binding.eventId, senderId: binding.senderId,
      envelopeBytes: binding.envelopeBytes, plaintextBytes, kindEvidence: entry,
    };
  } catch (error) {
    if (context.signal?.aborted) return { kind: 'dropped', reason: 'CAPABILITY_ABORTED' };
    if (originalText === undefined) return { kind: 'dropped', reason: error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message) ? error.message : 'MESSAGE_AUTHENTICATION_FAILED' };
    return plain(originalText, 'MESSAGE_PARSE_PRESERVED');
  }
}

export interface StoredPrivateMessageFacts {
  readonly messageId: string; readonly eventId: string; readonly envelopeDigest: string;
  readonly plaintextDigest: string; readonly wrapperDigest: string;
}
export interface RevalidatedPrivateMessage {
  readonly facts: StoredPrivateMessageFacts;
  readonly wrapper: Readonly<Record<string, unknown>>;
  readonly originalText: string;
  readonly deliveryClass: PrivateMessageDeliveryClass;
  readonly senderId: string;
  readonly kindEvidence: FirstReleasePrivateKindEvidence;
  readonly envelopeBytes: Uint8Array;
  readonly plaintextBytes: Uint8Array;
}
export type PrivateMessageRevalidation =
  | { readonly ok: true; readonly message: RevalidatedPrivateMessage }
  | { readonly ok: false; readonly reason: string };

/** Stored-row revalidation for reads: envelope binding, decryption, digest
 * equality, current revision/kind/official selection AND an actual body-schema
 * validation run in the bounded worker (the single await — callers recheck
 * durable currentness through `onAsyncBoundary` and after the returned
 * promise). No digest-chain shortcut: a cache row never substitutes for the
 * pinned schema accepting these exact bytes under the current revision. */
export async function revalidateStoredPrivateMessage(input: {
  readonly envelopeBytes: Uint8Array; readonly plaintextBytes: Uint8Array;
  readonly stored: StoredPrivateMessageFacts;
  readonly selection: FirstReleasePrivateSelection;
  readonly recipient: Pick<Signer, 'openDm'>;
  readonly isOfficialActor: (actorId: string) => boolean;
  readonly signal?: AbortSignal;
  readonly onAsyncBoundary?: () => void;
}): Promise<PrivateMessageRevalidation> {
  try {
    if (input.signal?.aborted) return { ok: false, reason: 'CAPABILITY_ABORTED' };
    if (!input.selection.available) return { ok: false, reason: input.selection.reason };
    const evidence = input.selection.evidence;
    const binding = verifyPrivateEnvelopeBinding(input.envelopeBytes, evidence.recipientId);
    if (binding.eventId !== input.stored.eventId) return { ok: false, reason: 'PRIVATE_STORED_EVENT_MISMATCH' };
    const decrypted = input.recipient.openDm(binding.dm, binding.senderId);
    if (!decrypted.ok || !(decrypted.plaintextBytes instanceof Uint8Array)) return { ok: false, reason: 'MESSAGE_DECRYPT_FAILED' };
    const plaintextBytes = new Uint8Array(decrypted.plaintextBytes);
    if (input.plaintextBytes.length !== plaintextBytes.length || input.plaintextBytes.some((byte, index) => byte !== plaintextBytes[index]))
      return { ok: false, reason: 'PRIVATE_STORED_PLAINTEXT_MISMATCH' };
    if (cidFromCanonical(new Uint8Array(input.envelopeBytes)) !== input.stored.envelopeDigest
      || cidFromCanonical(plaintextBytes) !== input.stored.plaintextDigest) return { ok: false, reason: 'PRIVATE_STORED_DIGEST_MISMATCH' };
    const wrapper = jsonObject(parseWorldJson(plaintextBytes, MAX_MESSAGE));
    if (!validateWrapper(wrapper)) return { ok: false, reason: 'MESSAGE_WRAPPER_INVALID' };
    if (wrapper.message_id !== input.stored.messageId || privateMessageWrapperDigest(wrapper) !== input.stored.wrapperDigest)
      return { ok: false, reason: 'PRIVATE_STORED_WRAPPER_MISMATCH' };
    // Identical structural rules as receive: no stored digest attests them.
    if (wrapper.house !== undefined) {
      const bound = jsonObject(wrapper.house);
      if (bound.origin !== evidence.house.origin || bound.house_key !== evidence.house.houseKey || bound.incarnation !== evidence.house.incarnation)
        return { ok: false, reason: 'PRIVATE_WRAPPER_HOUSE_MISMATCH' };
    }
    if (wrapper.delivery_class === 'state' && (!wrapper.house || wrapper.state_ref === undefined || wrapper.state_revision === undefined))
      return { ok: false, reason: 'PRIVATE_STATE_ANCHOR_INVALID' };
    if ((wrapper.state_ref === undefined) !== (wrapper.state_revision === undefined))
      return { ok: false, reason: 'PRIVATE_STATE_ANCHOR_INVALID' };
    if (wrapper.participation !== undefined) return { ok: false, reason: 'MESSAGE_PARTICIPATION_UNSUPPORTED' };
    if (wrapper.capability_revision !== evidence.capabilityRevision) return { ok: false, reason: 'CAPABILITY_REVISION_SUPERSEDED' };
    if (typeof wrapper.kind !== 'string') return { ok: false, reason: 'MESSAGE_KIND_UNSUPPORTED' };
    const entry = evidence.kinds.get(wrapper.kind);
    if (!entry || wrapper.schema_version !== entry.schemaVersion) return { ok: false, reason: 'MESSAGE_KIND_UNSUPPORTED' };
    if (!evidence.officialActorIds.includes(binding.senderId) || !input.isOfficialActor(binding.senderId))
      return { ok: false, reason: 'MESSAGE_SOURCE_UNPRIVILEGED' };
    await validateWorldPayload(entry.bodySchema, utf8.encode(JSON.stringify(wrapper.body)), { maxBytes: MAX_MESSAGE, signal: input.signal });
    input.onAsyncBoundary?.();
    if (input.signal?.aborted) return { ok: false, reason: 'CAPABILITY_ABORTED' };
    // Durable facts can change while the schema worker ran; recheck official status.
    if (!evidence.officialActorIds.includes(binding.senderId) || !input.isOfficialActor(binding.senderId))
      return { ok: false, reason: 'MESSAGE_SOURCE_UNPRIVILEGED' };
    return {
      ok: true, message: {
        facts: input.stored, wrapper, originalText: decrypted.plaintext,
        deliveryClass: wrapper.delivery_class as PrivateMessageDeliveryClass, senderId: binding.senderId,
        kindEvidence: entry, envelopeBytes: new Uint8Array(input.envelopeBytes), plaintextBytes,
      },
    };
  } catch (error) {
    if (input.signal?.aborted) return { ok: false, reason: 'CAPABILITY_ABORTED' };
    return { ok: false, reason: error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message) ? error.message : 'PRIVATE_REVALIDATION_FAILED' };
  }
}
