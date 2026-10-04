import { createPrivateMessageConsumer, adaptPrivateMessageConsumer } from '../world/private-message-consumer.js';
import { createPrivateMessageReader, type PrivateMessageReader } from '../world/private-message-reader.js';
import { selectFirstReleasePrivateEvidence } from '../world/private-message-evidence.js';
import type { WorldPrivateMessagesInput } from '../commands/popclaw-world.js';
/** Shared first-release observation and saved-record status for all three roots. */
import { cidFromCanonical } from '@popclaw/algorithms';
import { popclaw } from '@popclaw/contracts';
import type { Signer } from '../identity/signer.js';
import { executionDbFor, type HouseStore } from '../ingress/world-feed-store.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { WorldActionClient, encodeActionSelectionEvidence, decodeActionSelectionEvidence, type WorldInvokeInput, type WorldActionAuthority, type SelectedActionContext } from '../world/action-client.js';
import { selectActionEvidence, type HouseCapabilityView } from '../world/world-capabilities.js';
import { actionParameterRefusal } from '../world/action-declared-parameters.js';
import { WorldOwnerActionAuthorityStore, type WorldOwnerActionAuthority } from '../world/world-owner-action-authority.js';
import { WorldNativeActionAuthorityStore } from '../world/world-native-action-authority.js';
import type { NativeActionReadiness, NativeWorldExecutionPermit } from '../host/openclaw-world-execution.js';
import type { DuplicateActionLookup, McpOwnerAuthorization, OwnerConfirmation, OwnerGrant } from '../host/mcp-owner-authorization.js';
import type { WorldCapabilitiesInput, WorldCommandContext } from '../commands/popclaw-world.js';
import { canonicalActionJson } from '../world/action-receipt-journal.js';
import type { HouseRuntime } from './house-lifecycle/house-runtime.js';
import type { HouseInboxConsumer, HouseInboxConsumerInput, PublicHouseReceiverInput } from './house-lifecycle/resource-set.js';
import { normalizeHouseOrigin } from './house-lifecycle/control-client.js';
import { createWorldActionIo } from './world-action-io.js';
import type { createWorldDirectDm, WorldDirectDmOptions } from './world-direct-dm.js';
import type { HousePushEffectResolver } from './house-lifecycle/push-effect.js';
import type { WorldResourceOptions, WorldPlainInboxMessage } from './world-resource.js';
import type { HostWorldTurnHost } from './host-world-turn.js';

interface WorldRuntimeBaseOptions {
  houses: HouseRuntime;
  signer: Signer;
  actorId: string;
  readCapabilities(origin: string): HouseCapabilityView | null;
  onError?(error: unknown): void;
  supportsBackgroundTurns?(): boolean;
  directMessages?: Pick<WorldDirectDmOptions, 'nickname' | 'resolveRecipient' | 'verifyRecipient'>;
  turns?: { host: HostWorldTurnHost };
  fetch?: typeof globalThis.fetch;
  now?(): number;
  /** Integration-only independent permission source; installed roots never supply this. */
  fixtureOwnerAuthorization?: {
    authorize(input: Readonly<WorldInvokeInput>): Promise<{ jobId: string; expiresAt: number; assertCurrent(): void }>;
  };
  /** Presence flag for the production owner lane (MCP elicitation), never a
   *  source of grants: `assertActive()` throws when the adapter is stopped or
   *  the connected client cannot render a confirmation form. The grant itself
   *  arrives per call through `ownerCommandContext(ask)`. */
  ownerAuthorization?: { assertActive(): void };
  /** Genuine out-of-band native permits, issued only by the host adapter.
   *  `actionReadiness` is the read-only half: it reads the same active
   *  configuration the permit gate reads and never issues anything, so a
   *  kind nothing authorizes can be reported not-ready before a person
   *  picks it. It cannot grant — `ready: true` is the absence of a provable
   *  refusal, and `assertPermit` still decides every actual call. */
  nativeAuthorization?: {
    assertPermit(permit: NativeWorldExecutionPermit): void;
    actionReadiness(input: { house: string; kind: string; recoveryDecisionId?: string }): NativeActionReadiness;
  };
}
export type WorldRuntimeOptions = WorldRuntimeBaseOptions & ({ mode: 'commands' } | {
  mode?: 'resident';
  selectScopedLane(capabilities: HouseCapabilityView): boolean;
  onPlain(house: HouseStore, message: WorldPlainInboxMessage): void | Promise<void>;
  onConversation(house: HouseStore, message: Parameters<WorldResourceOptions['onConversation']>[0]): void | Promise<void>;
});
const key = (house: popclaw.world.IHouseBinding, actor: string) => JSON.stringify([house.origin, house.houseKey, house.incarnation, actor]);

export class WorldRuntime {
  private readonly readers = new Map<string, WorldActionClient>();
  private readonly privateResources = new Set<PrivateMessageReader | HouseInboxConsumer>();
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;
  private readonly authorizations = new Map<string, () => void>();
  private readonly issuedAuthorities = new WeakSet<WorldActionAuthority>();
  private readonly owners = new Map<string, WorldOwnerActionAuthorityStore>();
  private readonly natives = new Map<string, WorldNativeActionAuthorityStore>();
  private readonly nativeAuthorities = new Map<string, WorldActionAuthority>();
  constructor(private readonly options: WorldRuntimeOptions) {
    options.houses.configurePushEffectResolver(this.preparePushEffect);
  }
  /** Historical queued effects never gain permission from a new observation. */
  private preparePushEffect: HousePushEffectResolver = async ({ origin, bytes, ref, context }) => {
    this.check();
    if (ref.kind !== 'world_intent'
      || (ref.executionReference.kind === 'owner_action' ? !this.ownerLaneActive()
        : ref.executionReference.kind === 'native_policy' ? !this.options.nativeAuthorization : true))
      throw new Error('WORLD_LOCAL_UNSUPPORTED');
    const store = await this.store(origin), binding = this.knownBinding(store, ref.requestId);
    const capture = this.options.houses.captureActionExecutionStore(store, this.options.actorId);
    const scope = key(binding, this.options.actorId);
    const row = capture.executionDb.queryOne<{request_bytes: Uint8Array; request_digest: string; execution_reference: string; original_context: Uint8Array; valid_until: number}>(
      'SELECT * FROM world_action_client_requests WHERE binding=? AND request_id=?', [scope, ref.requestId]);
    if (!row || !row.original_context || cidFromCanonical(bytes) !== row.request_digest
      || !Buffer.from(bytes).equals(Buffer.from(row.request_bytes))
      || JSON.stringify(JSON.parse(row.execution_reference)) !== JSON.stringify(ref.executionReference)) throw new Error('ACTION_EXECUTION_REFERENCE_MISMATCH');
    const saved = decodeActionSelectionEvidence(row.original_context);
    const authorizationKey = JSON.stringify([scope, ref.executionReference.reservationId]);
    const authority = ref.executionReference.kind === 'native_policy' ? this.nativeAuthorities.get(authorizationKey)
      : this.ownerLaneActive() ? this.owner(store, binding).authority(ref.executionReference.reservationId) : undefined;
    const permission = this.authorizations.get(authorizationKey);
    if (!permission || !authority) throw new Error('ACTION_AUTHORITY_REQUIRED');
    const assertCurrent = () => {
      this.check(); capture.assertAccounting(); permission(); context.authorizeSend();
      authority.check({ kind: saved.kind, requestId: ref.requestId, validUntil: row.valid_until });
    };
    assertCurrent(); return assertCurrent;
  };
  private check(): void { if (this.stopped) throw new Error('WORLD_RUNTIME_STOPPED'); }
  /** One owner lane, two sources: the integration fixture's injected permission
   *  source, or a live per-call host adapter. A present-but-unusable adapter is
   *  not a lane, so an action kind never reports ready on a host that cannot ask. */
  private ownerLaneActive(): boolean {
    if (this.options.fixtureOwnerAuthorization) return true;
    const adapter = this.options.ownerAuthorization;
    if (!adapter) return false;
    try { adapter.assertActive(); return true; } catch { return false; }
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task); void task.finally(() => this.pending.delete(task)).catch(() => {}); return task;
  }
  private origin(input: string): string {
    this.check();
    const origin = normalizeHouseOrigin(input);
    if (origin !== input) throw new Error('WORLD_ORIGIN_INVALID');
    return origin;
  }
  readCapabilities = (input: string): HouseCapabilityView | null => {
    const origin = this.origin(input), view = this.options.readCapabilities(origin);
    if (view && view.verified.house.origin !== origin) throw new Error('CAPABILITY_HOUSE_MISMATCH');
    if (!view) return null;
    const projected = { ...structuredClone(view) };
    const privateSelection = selectFirstReleasePrivateEvidence(view, this.options.actorId);
    if (privateSelection.available) {
      const ready = this.options.houses.privateMessageExecutionAvailable(origin, this.options.actorId);
      projected.privateMessages = { ...projected.privateMessages, support: 'supported', ready,
        kinds: Object.fromEntries(Object.entries(projected.privateMessages.kinds).map(([kind, state]) => {
          const supported = privateSelection.evidence.kinds.has(kind);
          return [kind, { ...state, support: supported ? 'supported' as const : 'unsupported' as const, ready: supported && ready }];
        })) };
    }
    if (this.ownerLaneActive() || this.options.nativeAuthorization) {
      const native = this.options.nativeAuthorization;
      const availability = this.options.houses.actionExecutionAvailability(origin, this.options.actorId, native ? 'native' : 'receipt');
      const kinds = Object.fromEntries(Object.entries(projected.actions.kinds).map(([kind, state]) => {
        const selected = selectActionEvidence(view, this.options.actorId, kind);
        const supported = selected.available && selected.evidence.allowed.length === 0
          && selected.evidence.requiredOnSuccess.length === 0 && selected.evidence.consistency === 'none';
        // Storage readiness and authorization are two different questions, and
        // `actionExecutionAvailability` only ever answered the first: it reads
        // the house residency, the execution store and the session gate, never
        // the native policy. So a root with no native authorization at all
        // still advertised every kind as ready, and the only way to find out
        // otherwise was to pick one, confirm it, and be refused. The second
        // question is asked here, of the adapter that already holds the active
        // configuration, and it can only ever subtract readiness.
        //
        // A native policy is not the only authorization any more: a root whose
        // host can ask the owner per call has an answer available for a kind
        // no policy covers, so the policy probe must not veto it. That is the
        // same rule the MCP root has always had (no `nativeAuthorization` at
        // all, so nothing subtracts) rather than a new one — and it does not
        // widen what EXECUTES: a call still has to arrive with a real answer
        // or a real policy, and is refused by name if it has neither.
        const owner = this.ownerLaneActive();
        const authorization = supported && native && !owner ? native.actionReadiness({ house: origin, kind, recoveryDecisionId:this.options.houses.nativeRecoveryDecisionId(origin) }) : null;
        const ready = supported && availability.ready && (authorization?.ready ?? true);
        // A kind that is otherwise supported but blocked by the storage layer
        // carries that reason forward; an unsupported kind keeps whatever
        // manifest-level detail it already had.
        const detail = !supported ? state.detail
          : !availability.ready ? (availability.reason ?? state.detail)
          : authorization && !authorization.ready ? (authorization.reason ?? state.detail) : state.detail;
        return [kind, { ...state, detail, support: supported ? 'supported' as const : 'unsupported' as const, ready }];
      }));
      return { ...projected, actions: { ...projected.actions, kinds } };
    }
    return projected;
  };
  readAgentContext = (input: WorldCapabilitiesInput) => this.options.houses.readAgentContext(this.origin(input.house), this.options.actorId, input);
  readPublicStatus = (input: string) => this.options.houses.publicReadStatus(this.origin(input));
  /** Unit B owns explicit public-v1 composition. There is no old-C factory. */
  createPublicReceiver = (input: PublicHouseReceiverInput): undefined => {
    const origin = this.origin(input.gate.origin);
    if (input.house.baseUrl !== origin || input.house.slug !== hostDbSlug(origin)) throw new Error('HOUSE_STORE_BINDING_MISMATCH');
    this.readCapabilities(origin); return undefined;
  };
  private capturePrivate(store: HouseStore | string, gate?: HouseInboxConsumerInput['gate']) {
    this.check();
    const origin = typeof store === 'string' ? store : store.baseUrl;
    const session = this.options.houses.captureSessionCommandContext(origin);
    const capture = typeof store === 'string' ? this.options.houses.capturePrivateMessageRead(origin, this.options.actorId)
      : this.options.houses.capturePrivateMessageExecutionStore(store, this.options.actorId);
    try {
      const view = capture.readSelected(), fingerprint = JSON.stringify(view);
      const selected = selectFirstReleasePrivateEvidence(view, this.options.actorId);
      if (!selected.available) throw new Error(selected.reason);
      const assertCurrent = () => {
        this.check(); capture.assertCurrent();
        if (!session.gate.isActive() || (gate && !gate.isActive())) throw new Error('PRIVATE_SESSION_CHANGED');
        if (JSON.stringify(capture.readSelected()) !== fingerprint) throw new Error('PRIVATE_SELECTION_CHANGED');
      };
      assertCurrent();
      return { executionDb: capture.executionDb, gate: gate ?? session.gate, assertCurrent, close: capture.close,
        view: () => { assertCurrent(); return capture.readSelected(); }, recipientId: this.options.actorId,
        recipient: this.options.signer, isOfficialActor: (id: string) => selected.evidence.officialActorIds.includes(id),
        evidence: selected.evidence, sessionId: session.sessionId };
    } catch (error) { capture.close(); throw error; }
  }
  createInboxConsumer = (input: HouseInboxConsumerInput): HouseInboxConsumer | undefined => {
    this.check();
    const selected = selectFirstReleasePrivateEvidence(this.readCapabilities(input.gate.origin), this.options.actorId);
    if (!selected.available) return undefined;
    let capture: ReturnType<WorldRuntime['capturePrivate']>;
    try { capture = this.capturePrivate(input.house, input.gate); }
    catch (error) {
      if (error instanceof Error && error.message === 'PRIVATE_MESSAGE_NOT_PREPARED') { input.onError(error); return undefined; }
      throw error;
    }
    const consumer = createPrivateMessageConsumer({ ...capture, onError: input.onError,
      isOfficialActor: id => capture.isOfficialActor(id) && (input.isOfficialActor?.(id) ?? true) });
    const adapter = adaptPrivateMessageConsumer(consumer, { onError: input.onError, route: fallback => {
      capture.assertCurrent();
      if (!input.onPlain) throw new Error('PRIVATE_FALLBACK_UNAVAILABLE');
      return input.onPlain(fallback.dm, fallback.envelope, fallback.nickname, { originalText: fallback.originalText });
    } });
    this.privateResources.add(adapter);
    return { ...adapter, stop: () => { adapter.stop(); void adapter.whenIdle().then(() => this.privateResources.delete(adapter)); } };
  };
  readPrivateMessages = (input: WorldPrivateMessagesInput): Promise<unknown> => this.track((async () => {
    const fixed = structuredClone(input), capture = this.capturePrivate(this.origin(fixed.house));
    let reader: PrivateMessageReader | undefined;
    try {
      if ((fixed.cursor || fixed.message_id || fixed.state_ref) && (!fixed.expected_session_id || !fixed.expected_capability_revision))
        throw new Error('PRIVATE_REFERENCE_REQUIRED');
      if ((fixed.expected_session_id && fixed.expected_session_id !== capture.sessionId)
        || (fixed.expected_capability_revision && fixed.expected_capability_revision !== capture.evidence.capabilityRevision)) throw new Error('PRIVATE_REFERENCE_CHANGED');
      reader = createPrivateMessageReader(capture); this.privateResources.add(reader);
      const binding = { house: capture.evidence.house, actor_id: this.options.actorId,
        capability_revision: capture.evidence.capabilityRevision, session_id: capture.sessionId };
      let result: Record<string, unknown>;
      if (fixed.message_id) {
        const read = await reader.readMessage(fixed.message_id);
        result = read.status === 'ok' ? { status: 'ok', item: read.message.item } : read;
      } else if (fixed.state_ref) result = await reader.readState(fixed.state_ref);
      else result = await reader.list({ limit: fixed.limit, cursor: fixed.cursor, maxPageBytes: Math.max(1, 6000 - Buffer.byteLength(JSON.stringify(binding))) });
      capture.assertCurrent();
      if (result.status === 'item_over_budget') return { status: 'unavailable', code: 'SIZE_LIMIT', ...binding };
      const output = { ...result, ...binding };
      if (Buffer.byteLength(JSON.stringify(output)) > 16000) return { status: 'unavailable', code: 'SIZE_LIMIT' };
      return output;
    } finally {
      try {
        if (reader) { reader.stop(); await reader.whenIdle(); this.privateResources.delete(reader); }
        // Cleanup itself awaits: authorization must still hold at the actual exposure boundary.
        capture.assertCurrent();
      } finally { capture.close(); }
    }
  })());
  directMessage = async (input: string, _participationId: string): Promise<ReturnType<typeof createWorldDirectDm>> => {
    this.origin(input); throw new Error('WORLD_LOCAL_UNSUPPORTED');
  };
  private async store(origin: string): Promise<HouseStore> {
    this.check();
    const house = await this.options.houses.storeForCommand(origin);
    this.check();
    if (house.baseUrl !== origin || house.slug !== hostDbSlug(origin)) throw new Error('HOUSE_STORE_BINDING_MISMATCH');
    return house;
  }
  private captureSelected(store: HouseStore, kind: string): SelectedActionContext {
    this.check();
    const capture = this.options.houses.captureActionExecutionStore(store, this.options.actorId);
    const session = this.options.houses.captureSessionCommandContext(store.baseUrl);
    const selected = selectActionEvidence(capture.readSelected(), this.options.actorId, kind);
    if (!selected.available) throw new Error(selected.reason);
    const original = encodeActionSelectionEvidence(selected.evidence);
    const assertCurrent = () => {
      this.check(); capture.assertAccounting();
      if (!session.gate.isActive()) throw new Error('ACTION_SELECTION_GENERATION_CHANGED');
      const current = selectActionEvidence(capture.readSelected(), this.options.actorId, kind);
      if (!current.available || !Buffer.from(encodeActionSelectionEvidence(current.evidence)).equals(Buffer.from(original)))
        throw new Error('ACTION_SELECTION_CHANGED');
    };
    assertCurrent(); return { evidence: selected.evidence, assertCurrent };
  }
  /**
   * THE SAME REFUSAL THE OWNER'S DIALOG MAKES, ON THE PATH THAT ACTUALLY ACTS.
   *
   * A parameter key the house never declared paints a row in the approval
   * dialog that an owner cannot tell apart from a genuine one — a key of
   * `" house"` sorts first and sits directly under the real `house:` line with
   * a value the model wrote (review's PROBE-8c). The dialog refuses to draw
   * it. If only the dialog refused, the same call would still run whenever the
   * owner was not the one asked — a refused prompt falls through to the
   * configured policy lane — and "what the owner saw" and "what ran" would be
   * two different things again, which is the defect this whole lane exists to
   * prevent. So BOTH lanes refuse here, by the SAME name, BEFORE anything is
   * reserved and long before anything is pushed.
   *
   * Reached through the evidence the capability layer already verified, so
   * there is no second source of truth about what the house declared.
   */
  private assertDeclaredParameters(selected: SelectedActionContext, input: Readonly<WorldInvokeInput>): void {
    const refusal = actionParameterRefusal(selected.evidence.paramsSchema, input.params);
    if (refusal) throw new Error(refusal);
  }
  private owner(store: HouseStore, binding: popclaw.world.IHouseBinding): WorldOwnerActionAuthorityStore {
    const capture = this.options.houses.captureActionExecutionStore(store, this.options.actorId);
    const id = key(binding, this.options.actorId), old = this.owners.get(id);
    if (old) { old.assertBinding(capture.executionDb, binding, this.options.actorId); return old; }
    const owner = new WorldOwnerActionAuthorityStore({ db: capture.executionDb, house: binding, actorId: this.options.actorId,
      expectedPartition: capture.expectedPartition, captureSelectedActionContext: kind => this.captureSelected(store, kind),
      now: this.options.now ?? (() => Math.floor(Date.now() / 1000)) });
    this.owners.set(id, owner); return owner;
  }
  private native(store: HouseStore, binding: popclaw.world.IHouseBinding): WorldNativeActionAuthorityStore {
    const capture = this.options.houses.captureNativeActionExecutionStore(store, this.options.actorId);
    const id = key(binding, this.options.actorId), old = this.natives.get(id);
    if (old) { old.assertBinding(capture.executionDb, binding, this.options.actorId); return old; }
    const native = new WorldNativeActionAuthorityStore({ db: capture.executionDb, house: binding, actorId: this.options.actorId,
      expectedPartition: capture.expectedPartition, captureSelectedActionContext: kind => this.captureSelected(store, kind),
      assertPermit: permit => { if (!this.options.nativeAuthorization) throw new Error('ACTION_AUTHORITY_REQUIRED'); this.assertNativePermit(permit); },
      now: this.options.now ?? (() => Math.floor(Date.now() / 1000)) });
    this.natives.set(id, native); return native;
  }
  private assertNativePermit(permit: NativeWorldExecutionPermit): void {
    if (!this.options.nativeAuthorization) throw new Error('ACTION_AUTHORITY_REQUIRED');
    this.options.nativeAuthorization.assertPermit(permit);
    const decisionId = this.options.houses.nativeRecoveryDecisionId(permit.input.house);
    if (decisionId !== undefined && permit.policyScope.recoveryDecisionId !== decisionId) throw new Error('NATIVE_POLICY_RECONFIRMATION_REQUIRED');
  }
  /** Only the native factory scope supplies this permit; shared command JSON cannot do so. */
  nativeCommandContext(permit: NativeWorldExecutionPermit): WorldCommandContext {
    this.check();
    if (!this.options.nativeAuthorization) throw new Error('ACTION_AUTHORITY_REQUIRED');
    this.assertNativePermit(permit);
    return { readCapabilities: this.readCapabilities, readPublicStatus: this.readPublicStatus, readPrivateMessages: this.readPrivateMessages, client: this.client,
      actionAuthority: input => this.track((async () => {
        this.check(); this.assertNativePermit(permit);
        if (canonicalActionJson(input) !== canonicalActionJson(permit.input)) throw new Error('NATIVE_ACTION_INPUT_MISMATCH');
        const store = await this.store(this.origin(input.house)), selected = this.captureSelected(store, input.kind);
        this.assertDeclaredParameters(selected, input);
        const capture = this.options.houses.captureNativeActionExecutionStore(store, this.options.actorId);
        this.check(); capture.assertAccounting(); selected.assertCurrent(); this.assertNativePermit(permit);
        const authority = this.native(store, selected.evidence.house).reserve(permit);
        const id = JSON.stringify([key(selected.evidence.house, this.options.actorId), authority.reservationId]);
        this.authorizations.set(id, () => { this.check(); capture.assertAccounting(); selected.assertCurrent(); this.assertNativePermit(permit); });
        this.nativeAuthorities.set(id, authority); this.issuedAuthorities.add(authority); return authority;
      })()) };
  }
  /** The one owner-action sequence: capture first, ask second, re-check after the
   *  await, and only then occupy a durable request slot. Both owner lanes — the
   *  integration fixture option and the per-call host confirmation — run this. */
  private ownerAuthority(source: OwnerConfirmation, input: Readonly<WorldInvokeInput>): Promise<WorldOwnerActionAuthority> {
    return this.track((async () => {
      this.check();
      const fixed = structuredClone(input), store = await this.store(this.origin(input.house));
      const selected = this.captureSelected(store, input.kind);
      this.assertDeclaredParameters(selected, fixed);
      const permit: OwnerGrant = await source.authorize(structuredClone(fixed));
      this.check(); selected.assertCurrent(); permit.assertCurrent();
      const owner = this.owner(store, selected.evidence.house);
      const authority = owner.reserve({ jobId: permit.jobId, expiresAt: permit.expiresAt, input: fixed });
      this.authorizations.set(JSON.stringify([key(selected.evidence.house, this.options.actorId), authority.reservationId]), () => {
        this.check(); selected.assertCurrent(); permit.assertCurrent();
      });
      this.issuedAuthorities.add(authority); return authority;
    })());
  }
  /** What the owner confirmation dialog needs in order to tell a second ask
   *  apart from a retry: the requests for this house, action kind and
   *  parameters, by this actor, that have not reached a terminal result.
   *  Read-only — it reserves nothing, sends nothing, grants nothing — and
   *  deliberately not reachable from the adapter's own imports: the adapter is
   *  handed this the way it is handed the `Server` box. The actor is checked
   *  rather than used, because the only caller is bound to this runtime's own
   *  actor. Tracked like every other task here, so `whenIdle()` waits for it. */
  unresolvedOwnerRequests(actorId: string, input: Readonly<WorldInvokeInput>): Promise<readonly string[]> {
    return this.track((async () => {
      this.check();
      if (actorId !== this.options.actorId) throw new Error('OWNER_ACTION_BINDING_MISMATCH');
      const store = await this.store(this.origin(input.house));
      const selected = this.captureSelected(store, input.kind);
      return this.owner(store, selected.evidence.house).unresolvedRequests(structuredClone(input) as WorldInvokeInput);
    })());
  }
  /** One MCP tool call's confirmation lane. The model cannot construct this ask:
   *  it is handed in by the host adapter's `withInvocation`, and the returned
   *  context dies with that call. Peer of `nativeCommandContext(permit)`. */
  ownerCommandContext(ask: OwnerConfirmation): WorldCommandContext {
    this.check();
    if (!this.options.ownerAuthorization) throw new Error('OWNER_CONFIRMATION_UNAVAILABLE');
    return { readCapabilities: this.readCapabilities, readPublicStatus: this.readPublicStatus,
      readPrivateMessages: this.readPrivateMessages, client: this.client,
      actionAuthority: input => this.ownerAuthority(ask, input) };
  }
  /** The fixture explicitly injects this method into the unchanged shared command context. */
  actionAuthority = (input: Readonly<WorldInvokeInput>): Promise<WorldOwnerActionAuthority> => {
    this.check();
    const source = this.options.fixtureOwnerAuthorization;
    if (!source) throw new Error('ACTION_AUTHORITY_REQUIRED');
    return this.ownerAuthority(source, input);
  };

  /** No registry, onPending listener, recovery, drain, delivery or resend. */
  private statusReader(store: HouseStore, binding: popclaw.world.IHouseBinding): WorldActionClient {
    this.check();
    const capture = this.options.houses.captureActionExecutionStore(store, this.options.actorId);
    const id = key(binding, this.options.actorId), old = this.readers.get(id);
    if (old) return old;
    const io = createWorldActionIo({ runtime: this.options.houses, origin: store.baseUrl,
      knownRequest: request => { if (this.stopped) return false; try { return client.view(request).request_id === request; } catch { return false; } } });
    const client = new WorldActionClient({ db: executionDbFor(store), signer: this.options.signer, actorId: this.options.actorId, house: binding,
      expectedPartition: capture.expectedPartition,
      captureSelectedActionContext: kind => this.captureSelected(store, kind),
      accounting: { assertCurrent: () => { this.check(); capture.assertAccounting(); },
        settle: (tx, input) => { this.check(); capture.assertAccounting();
          return input.executionReference.kind === 'native_policy' ? this.native(store, binding).settleOriginal(tx, input)
            : this.owner(store, binding).settleOriginal(tx, input); } },
      ...io, now: this.options.now });
    this.readers.set(id, client); return client;
  }
  private knownBinding(store: HouseStore, requestId: string): popclaw.world.IHouseBinding {
    if (!/^[a-f0-9]{64}$/.test(requestId)) throw new Error('REQUEST_ID_INVALID');
    if (!executionDbFor(store).queryOne("SELECT 1 FROM sqlite_master WHERE type='table' AND name='world_action_client_requests'")) throw new Error('REQUEST_NOT_KNOWN');
    const rows = executionDbFor(store).queryAll<{ binding: string }>('SELECT binding FROM world_action_client_requests WHERE request_id=?', [requestId]);
    const matches = rows.map(row => JSON.parse(row.binding) as unknown).filter((value): value is string[] =>
      Array.isArray(value) && value.length === 4 && value.every(item => typeof item === 'string')
      && value[0] === store.baseUrl && value[3] === this.options.actorId);
    if (matches.length !== 1) throw new Error('REQUEST_NOT_KNOWN');
    const value = matches[0]!;
    return { origin: value[0], houseKey: value[1], incarnation: value[2] };
  }
  client = (input: string): Pick<WorldActionClient, 'invoke' | 'status'> => {
    const origin = this.origin(input);
    return {
      invoke: (value, authority) => {
        const task = (async () => {
          this.check();
          if (!this.ownerLaneActive() && !this.options.nativeAuthorization) throw new Error('WORLD_LOCAL_UNSUPPORTED');
          if (!authority || !this.issuedAuthorities.has(authority)) throw new Error('ACTION_AUTHORITY_REQUIRED');
          const store = await this.store(origin), selected = this.captureSelected(store, value.kind);
          const ownerAuthority = authority as WorldOwnerActionAuthority;
          ownerAuthority.assertBinding(executionDbFor(store), selected.evidence.house, this.options.actorId);
          ownerAuthority.assertInput(value);
          return this.statusReader(store, selected.evidence.house).invoke(value, authority);
        })();
        this.pending.add(task); void task.finally(() => this.pending.delete(task)).catch(() => {}); return task;
      },
      status: requestId => {
        const task = (async () => {
          this.check();
          const store = await this.store(origin), binding = this.knownBinding(store, requestId);
          return this.statusReader(store, binding).status(requestId);
        })();
        this.pending.add(task); void task.finally(() => this.pending.delete(task)).catch(() => {});
        return task;
      },
    };
  };
  stop(): void { this.stopped = true; for (const resource of this.privateResources) resource.stop(); this.readers.clear(); this.owners.clear(); this.natives.clear(); this.nativeAuthorities.clear(); this.authorizations.clear(); }
  async whenIdle(): Promise<void> { await Promise.allSettled([...this.pending, ...[...this.privateResources].map(resource => resource.whenIdle())]); }
}

/* --------------------------------------------------------------------------
 * The MCP root's two wiring joints.
 *
 * Both are one expression each, and both were closures inside `src/mcp.ts`,
 * which no test imports: a wrong slice in the first, or a wrong input passed to
 * the second — which answers "no twin" SILENTLY — was caught by nothing. They
 * live here, exported and tested, and `src/mcp.ts` calls them.
 * ----------------------------------------------------------------------- */

/**
 * THE HOUSE'S OWN DECLARATION OF WHAT ONE ACTION CARRIES, for the dialog that
 * has to decide which parameter rows it may draw.
 *
 * Read from the verified capability view this runtime already holds, so the
 * dialog and the execution path cite the SAME declaration and cannot disagree
 * about it. Read-only, synchronous, and total: it reserves nothing, sends
 * nothing and never throws — a house this root cannot see answers `null`,
 * which refuses, because an unknown schema is not an empty constraint.
 *
 * Here rather than in either composition root because `src/mcp.ts` is imported
 * by no test, and both roots need the identical answer.
 */
export function worldDeclaredActionParameters(
  worlds: Pick<WorldRuntime, 'readCapabilities'>, actorId: string,
): (house: string, kind: string) => unknown {
  return (house, kind) => {
    try {
      const selected = selectActionEvidence(worlds.readCapabilities(house), actorId, kind);
      return selected.available ? selected.evidence.paramsSchema : null;
    } catch { return null; }
  };
}

/** What `createMcpOwnerAuthorization` is handed as its duplicate check. The
 *  adapter owns no storage; this is the only thing that reaches the ledger, and
 *  it passes the captured invoke input through unchanged. */
export function worldDuplicateLookup(worlds: Pick<WorldRuntime, 'unresolvedOwnerRequests'>): DuplicateActionLookup {
  return { unresolved: query => worlds.unresolvedOwnerRequests(query.actorId, query.input) };
}

/** One host tool call: one owner confirmation, one per-call command context
 *  that dies with the call, and the reference the owner just read carried out
 *  to the work so the tool result can repeat it.
 *
 *  Both owner-confirming hosts arrive here — the MCP root through an
 *  `elicitation/create` form (`mcp-owner-authorization.ts`) and the OpenClaw
 *  native root through the Gateway's own per-call approval
 *  (`openclaw-owner-approval.ts`). They differ only in how the human was
 *  asked; what a grant is, and everything downstream of it — the reservation,
 *  the receipt journal, `popclaw_world_action_status` — is shared. */
export function ownerConfirmedWorldInvoke(
  authorization: Pick<McpOwnerAuthorization, 'withInvocation'>,
  worlds: Pick<WorldRuntime, 'ownerCommandContext'>,
) {
  return <T>(callId: string, input: Readonly<WorldInvokeInput>, signal: AbortSignal | undefined,
    work: (context: WorldCommandContext, ownerConfirmationRef?: string) => Promise<T>): Promise<T> =>
    authorization.withInvocation(callId, input, signal,
      ask => work(worlds.ownerCommandContext(ask), ask.reference));
}
