import { houseBindingBlocked } from '../../world/house-recovery-fence.js';
import { HouseRecovery, type HouseRecoveryPort } from '../../world/house-recovery.js';
import { projectWorldAgentContext, type WorldAgentContextQuery, type WorldAgentContextResult } from '../../world/world-agent-context.js';
import { storageDatabasePathAllowed, readStorageControl, assertStorageBootstrap, type RecoveryPath } from '../../host/storage-maintenance.js';
/** One composition seam for OpenClaw, MCP and the standalone daemon/CLI. */
import { popclaw } from '@popclaw/contracts';
import type { Signer } from '../../identity/signer.js';
import { executionDbFor, type HouseStore } from '../../ingress/world-feed-store.js';
import { hostDbSlug } from '../../ingress/host-slug.js';
import { MultiHouseEgress } from '../../egress/multi-house-egress.js';
import { ServerPushEgress } from '../../egress/server-push-egress.js';
import { INBOX_TOKEN_HEADER } from '../../identity/read-credential.js';
import type { InboxReadCredential } from '../../messaging/inbox-stream-client.js';
import type { ReadAuthority, ReadCredentialOutcome } from '../../identity/read-authority.js';
import type { ConfiguredHousePinningStrategy } from './configured-first-pin.js';
import { entryDigest, cancelInitialSetup } from './participation-journal.js';
import { guideBindingDigest, readHouseGuideContext, markHouseGuideDelivered, type HouseGuideContext } from '../../world/house-guide-context.js';
import { findParticipationReceipt } from './participation-journal.js';
import type { HouseParticipationReceiptQuery, HouseParticipationReceiptResult } from './participation-admission.js';
import { HouseLifecycleManager, type HouseGate, type ManagerOptions } from './manager.js';
import { ResidentLifecycle } from './resident.js';
import { HouseCommandBus, type HouseCommandPort, type PushOperation, type CommandPushResult } from './command-bus.js';
import { resolveInstallationId } from './installation.js';
import { fetchSessionManifest, normalizeHouseOrigin, newRequestId } from './control-client.js';
import { readParticipation, type ParticipationRow, type RemoteStatus } from './participation-store.js';
import { renderCopy } from '../../lexicon/index.js';
import { ownerLang } from '../../lexicon/owner-language.js';
import { createHouseStreamFactory, type HouseResourceOptions } from './resource-set.js';
import { actionFetch, assertActionActive, assertHouseActionActive, withHouseActions, type ActionGate } from './action-context.js';
import { createHostAsyncScope } from '../../host/local-host-adapter.js';
import { captureHousePushEffect, type HousePushEffectReference, type HousePushEffectResolver } from './push-effect.js';
import { makeWorldManifestPreparer, revokeHouseCapabilityView } from '../../world/world-capabilities.js';
import { houseKeyFromAckHex } from '../../world/house-binding.js';
import { makeRelationBindingPreparer } from '../../social-graph/relation-binding.js';
import { declarationFingerprint, readVerifiedDeclaration, sessionReadSelected } from '../../world/house-read-declaration.js';
import { pinnedBinding } from '../../world/house-binding-pin.js';
import { isLoopbackOrigin } from '../../social-graph/relation-host.js';
import { isPrivateAddressHost, isPrivateAddressOrigin } from './private-address.js';
import type { PublicDisplayCapture } from '../../ingress/public-feed-display.js';
import type { ExecutionCatalogRow } from '../../host/execution-store.js';
import { PUBLIC_JOURNAL_TABLES, ACTION_RECEIPT_FEATURE_TABLES, NATIVE_ACTION_FEATURE_TABLES } from '../../host/execution-store-schema.js';
import { readHouseCapabilityView } from '../../world/world-capabilities.js';
import { normalizeAckKeyHex } from './control-client.js';
import { captureLegacyTrust } from './legacy-trust.js';
import type { HouseReadFailureCode } from './read-failure.js';
import { publicProducerPolicy } from './public-read-resources.js';
import type { ExecutionStoreCatalog } from '../../host/execution-store.js';
import { PublicReadResources, inactivePublicReadStatus, type PublicReadStatus } from './public-read-resources.js';

/**
 * `HOUSE_SESSION_CONTEXT_UNAVAILABLE` (`captureSessionCommandContext` below)
 * is thrown from two different truths: no session was ever captured, or one
 * was captured but is no longer live. Neither one says WHY on its own, and a
 * house acceptance round found the bare code unactionable for the single most
 * common cause — a house that simply never offers a session control plane
 * (`house_session: null`, true of every official Rust LoreHouse on launch
 * day). `remote_status = 'unsupported'` (participation-store.ts) is the same
 * durable verdict `house.login.unsupported` already reads for that exact
 * case, so re-reading it here — fresh, at the moment of the throw, never the
 * value captured earlier in the call — keeps the extra sentence honest for
 * both throw sites without guessing which one fired. Any other reason keeps
 * the bare code: this file has no way to tell "lease just expired" from
 * "briefly reconnecting" from "misconfigured", and a guess would be worse
 * than silence for anyone reading past the code alone.
 */
function sessionUnavailableError(origin: string, remoteStatus: RemoteStatus | undefined): Error {
  const code = 'HOUSE_SESSION_CONTEXT_UNAVAILABLE';
  if (remoteStatus !== 'unsupported') return new Error(code);
  return new Error(`${code}: ${renderCopy(ownerLang(), 'house.session.unsupported', { origin })}`);
}

/**
 * Headers the PUBLIC read lane (`HouseRuntime.houseReadFetch`) refuses to
 * send. That lane exists BECAUSE the request identifies nobody; a caller that
 * attaches one of these has left the lane it asked for, and is told so rather
 * than quietly having the header stripped. `Headers.has` is case-insensitive,
 * so the wire casing of `INBOX_TOKEN_HEADER` does not matter here.
 */
const PUBLIC_READ_FORBIDDEN_HEADERS: readonly string[] = ['authorization', 'cookie', INBOX_TOKEN_HEADER];

/** An absent or refused receipt must never look like a successful send to
 * legacy callers that only await egress and then record their social log. */
export class HousePushError extends Error {
  constructor(readonly result: CommandPushResult) {
    super(result.detail ?? `operation ${result.operationId}: HTTP ${result.status}`);
    this.name = 'HousePushError';
  }
}

export interface HouseRuntimeOptions extends Omit<ManagerOptions, 'installationId' | 'signer' | 'configuredPinningMode'> {
  signer: Signer;
  onJoined?: (origin:string) => Promise<void>;
  /**
   * How reads at one house prove who is asking. Required: the inbox lane
   * below chooses between this and a remembered session token, and a runtime
   * that could not ask would have to guess.
   */
  readAuthorityFor: (origin: string) => ReadAuthority;
  origins: readonly string[];
  log?: (message: string) => void;
  intentPollMs?: number;
  commandTimeoutMs?: number;
  commandPollMs?: number;
  publicV1Mode?: boolean;
  executionStores?: ExecutionStoreCatalog;
}
export interface HouseSessionCommandContext {
  readonly gate: HouseGate;
  readonly sessionId: string;
  /** The verified server revision; the local operation sequence is separate. */
  readonly fence: string;
  readonly leaseExpiresAt: number;
  readonly installationId: string;
}
/** Issued only for one locally known request. It grants no business authority. */
export interface KnownActionReadGate {
  readonly origin: string;
  readonly signal: AbortSignal;
  isActive(): boolean;
}
type ResourceConfiguration = Omit<HouseResourceOptions, 'signer' | 'storeFor' | 'readToken'> & {
  stores: readonly HouseStore[];
  openStore(origin: string): Promise<HouseStore>;
  onStore?(store: HouseStore): void;
};

/**
 * Which credential this house's inbox stream carries.
 *
 * Both lanes are selected POSITIVELY, from something the house said and this
 * machine verified. Neither is reached by a failure.
 *
 *  - first, the house-issued session lane, when the house's VERIFIED manifest carried
 *    a `house_session` board (`sessionLaneDeclared`) and there is a live
 *    session with a token. The reference Ranger Map reads DMs this way and
 *    goes on doing so, even when it also declares identity reads;
 *  - only when no session lane was selected, the identity lane, when the
 *    resolver granted a credential.
 *
 * What a refusal may never do is pick the other lane. `READ_AUTH_NOT_DECLARED`,
 * `READ_AUTH_SCHEME_UNSUPPORTED` and a missing or blocked pin are each this
 * client deciding it must not read — and a client that answers its own refusal
 * by reaching for a different credential has overridden its own decision. The
 * previous rule did exactly that: any leftover `session_id` rerouted every
 * refusal, including a BLOCKED pin, onto the session token.
 *
 * The session lane keeps its own rule unchanged: chosen and unable to produce
 * a token, it FAILS. It does not quietly become a self-signed one, because
 * that is precisely how a revoked session goes on reading.
 *
 * There is no third lane. A house with neither is refused by name, so the
 * reason reaches whoever is looking instead of becoming a silent inbox.
 */
export function chooseInboxReadToken(
  row: { readonly session_id: string; readonly inbox_read_token: string },
  credential: ReadCredentialOutcome,
  sessionLaneDeclared: boolean,
): string {
  if (sessionLaneDeclared && row.session_id) {
    return sessionInboxReadToken(row);
  }
  if (credential.ok) return credential.headers[INBOX_TOKEN_HEADER]!;
  throw new Error(`${credential.refusal}: ${credential.message}`);
}

function sessionInboxReadToken(row: { readonly inbox_read_token: string }): string {
  if (!row.inbox_read_token) throw new Error('HOUSE_SESSION_READ_TOKEN_MISSING');
  return row.inbox_read_token;
}

export class HouseRuntime {
  readonly manager: HouseLifecycleManager;
  readonly resident: ResidentLifecycle;
  readonly commands: HouseCommandPort;
  readonly recovery: HouseRecoveryPort;
  readonly configuredHousePinning: ConfiguredHousePinningStrategy;
  private readonly allParticipationObservers = new Set<(origin: string) => void>();
  private readonly participationObservers = new Map<string, Set<() => void>>();
  readonly egress: MultiHouseEgress;
  private readonly bus: HouseCommandBus;
  private readonly stores = new Map<string, HouseStore>();
  private readonly opening = new Map<string, Promise<HouseStore>>();
  private resources: ResourceConfiguration | null = null;
  private stopped = false;
  private stopTask: Promise<void> | null = null;
  private readonly terminal = new AbortController();
  private readonly pushEffects = createHostAsyncScope<{origin: string; ref: HousePushEffectReference}>();
  private pushEffectResolver: HousePushEffectResolver | undefined;
  private readonly targets = new Map<string, string>();
  private readonly commandTasks = new Set<Promise<unknown>>();
  private readonly actionReadTasks = new Set<Promise<Uint8Array>>();
  private readonly actionReadGates = new WeakMap<KnownActionReadGate, {origin: string; requestId: string}>();
  private publicResources: PublicReadResources | null = null;

  constructor(private readonly opts: HouseRuntimeOptions) {
    this.manager = new HouseLifecycleManager({ ...opts, configuredPinningMode: opts.publicV1Mode === true ? 'public-v1' : 'static', legacyRecoveryConfigured: origin => opts.origins.some(input => normalizeHouseOrigin(input) === origin), installationId: resolveInstallationId(opts.db),
      revokeTrustedManifest: opts.revokeTrustedManifest ?? revokeHouseCapabilityView,
      prepareTrustedManifest: opts.prepareTrustedManifest ?? makeWorldManifestPreparer({ fetch: opts.fetch }),
      // Every root gets this, including the ones that do not RECEIVE
      // relations. Deciding what a house is trusted to be is not consumption
      // — it is idempotent after the first time, and an owner who runs
      // `popclaw login` from an MCP host should end up with the same binding
      // they would get from the gateway. Only reading the stream needs to be
      // elected to a single process.
      prepareRelationBinding: opts.prepareRelationBinding ?? makeRelationBindingPreparer({
        db: opts.db,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        // The operator's pin is stored as ACK hex and a relation is scoped to
        // the base58 form of the SAME 32 bytes. One helper does that
        // conversion everywhere; a bad pin throws here rather than quietly
        // becoming "no pin configured", which would turn a stated
        // restriction into a first-contact TOFU.
        configuredKeyFor: (origin) => {
          const hex = opts.configuredPinFor?.(origin);
          return hex ? houseKeyFromAckHex(hex) : undefined;
        },
        // This machine, stated as such — for a local test house or a dev
        // lore-house. Not inferred from the scheme: "it said http" is not a
        // reason to accept http.
        allowInsecureOrigin: isLoopbackOrigin,
      }),
      onRelationBindingRefused: opts.onRelationBindingRefused
        ?? ((origin, reason) => opts.log?.(`popclaw: ${origin} is not trusted for relations — ${reason}`)) });
    this.configuredHousePinning = opts.publicV1Mode === true
      ? Object.freeze({ mode: 'public-v1' as const, proofPin: this.manager.configuredPublicPin })
      : Object.freeze({ mode: 'static' as const, firstPin: this.manager.configuredFirstPin });
    opts.db.execute('CREATE TABLE IF NOT EXISTS house_origin_bindings (slug TEXT PRIMARY KEY, origin TEXT NOT NULL UNIQUE)');
    // Validate all cache addresses before opening a single store or stream.
    const origins = [...new Set([...opts.origins.map(normalizeHouseOrigin), ...opts.db.queryAll<{house_origin: string}>(
      'SELECT house_origin FROM house_participation ORDER BY house_origin').map(row => row.house_origin)])];
    if (!origins.length) throw new Error('HouseRuntime needs a configured home house');
    opts.db.transaction(() => { for (const origin of origins) this.bindOrigin(origin); });
    this.resident = new ResidentLifecycle({ manager: this.manager, token: newRequestId(),
      intentPollMs: opts.intentPollMs, now: opts.clock, log: opts.log,
      publicStreams: { capture: origin => this.publicResources?.capture(origin) ?? null },
      seedConfiguredLegacy: !opts.participation && opts.publicV1Mode !== true,
      onParticipationObserved: origin => {
        for (const changed of [...this.allParticipationObservers]) {
          try { changed(origin); } catch (error) { opts.log?.(`participation observer failed: ${String(error)}`); }
        }
        for (const changed of [...this.participationObservers.get(origin) ?? []]) {
          try { changed(); } catch (error) { opts.log?.(`participation observer failed: ${String(error)}`); }
        }
      },
      streams: { open: gate => {
        if (!this.resources) throw new Error('House resources have not been configured');
        return createHouseStreamFactory({ ...this.resources, publicV1Mode: opts.publicV1Mode === true, signer: opts.signer,
          storeFor: origin => this.storeFor(origin), readToken: captured => this.readToken(captured) }).open(gate);
      } } });
    this.resident.configureOrigins(opts.origins);
    if (opts.publicV1Mode && opts.executionStores) {
      const catalog = opts.executionStores;
      if (catalog.options.db !== opts.db) throw new Error('PUBLIC_CATALOG_DATABASE_MISMATCH');
      this.publicResources = new PublicReadResources({ db: opts.db, catalog,
        authority: this.resident.authority, selected: () => !this.stopped && opts.publicV1Mode === true,
        pinFor: origin => opts.configuredPinFor?.(origin) || readParticipation(opts.db, origin)?.ack_key_hex || '',
        consumersAllowed: () => storageDatabasePathAllowed(opts.db, 'consumers', catalog.options.paths), storeFor: origin => this.storeFor(origin),
        fetch: opts.fetch, log: opts.log });
    }
    const recovery = new HouseRecovery({db:opts.db,fetch:opts.fetch,configuredPinFor:opts.configuredPinFor,
      enqueue: (id,origin) => this.bus.reconfirmHouse(id,origin),
      isOwnerCurrent: () => false,
      quiesce: async (origin,id) => {
        await this.resident.coordinator.quiesceHouse(origin);
        // Legacy cursors lack an incarnation namespace. Archive their exact
        // rows before resetting the live cache cursor; committed rows stay.
        if (this.resources) {
          const store = await this.storeFor(origin);
          for (const db of new Set([store.db, executionDbFor(store)])) {
            const rows: Record<string, unknown> = {};
            for (const table of ['world_feed_cursor','world_stream_cursor']) {
              if (db.queryOne("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",[table])) rows[table] = db.queryAll(`SELECT * FROM ${table}`);
            }
            const fence = opts.db.queryOne<{decision_id:string}>('SELECT decision_id FROM house_recovery_fences_v1 WHERE origin=?',[origin]);
            if (fence?.decision_id !== id) throw new Error('HOUSE_RECOVERY_DECISION_STALE');
            opts.db.execute('CREATE TABLE IF NOT EXISTS house_recovery_cursor_evidence_v1 (decision_id TEXT NOT NULL, store_lane TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(decision_id,store_lane))');
            opts.db.execute('INSERT OR IGNORE INTO house_recovery_cursor_evidence_v1 VALUES(?,?,?)',[fence!.decision_id,db === store.db ? 'cache':'execution',JSON.stringify(rows)]);
            db.transaction(tx => { for (const table of Object.keys(rows)) tx.execute(`UPDATE ${table} SET seq=0`); });
          }
        }
      }});
    this.recovery = recovery;
    const coordinator: HouseCommandPort = {
      loginHouse: (origin, authority) => { this.bindOrigin(origin); return this.resident.coordinator.loginHouse(origin, authority); },
      logoutHouse: origin => this.resident.coordinator.logoutHouse(origin),
      getHouseStatus: origin => this.resident.coordinator.getHouseStatus(origin),
      knownHouseOrigins: () => this.resident.coordinator.knownHouseOrigins(),
      reconfirmHouse: id => { const epoch = this.resident.authority.captureEpoch(); return recovery.apply(id,
        () => !this.stopped && epoch !== null && this.resident.authority.isEpochCurrent(epoch)); },
    };
    this.bus = new HouseCommandBus({
      whenReady: () => this.resident.whenReady(),
      captureLogin: origin => opts.participation?.capture({reason:'explicit_owner_join',origin,actorId:opts.actorId!,installationId:resolveInstallationId(opts.db)}), db: opts.db, coordinator, authority: this.resident.authority,
      pollMs: opts.commandPollMs, timeoutMs: opts.commandTimeoutMs, log: opts.log,
      executePush: async (origin, bytes, context) => {
        context.authorizeSend();
        // The resolver sees a separate copy. It cannot alter the original
        // signed payload that this owner sends through the existing channel.
        const payload = new Uint8Array(bytes);
        let check: (() => void) | undefined;
        if (context.effectReference) {
          if (!this.pushEffectResolver) throw new Error('HOUSE_PUSH_EFFECT_RESOLVER_UNAVAILABLE');
          check = await this.pushEffectResolver(Object.freeze({origin, bytes: new Uint8Array(payload), ref: context.effectReference, context}));
          context.authorizeSend();
          if (typeof check !== 'function') throw new Error('HOUSE_PUSH_EFFECT_CHECK_INVALID');
        }
        const gate = {signal: context.signal, isActive: () => {
          context.authorizeSend();
          if (check) {
            const result: unknown = check();
            if (result !== undefined) {
              // A mistaken async checker cannot race the actual send, and its
              // late rejection must not become an unhandled process error.
              void Promise.resolve(result).catch(() => {});
              throw new Error('HOUSE_PUSH_EFFECT_CHECK_ASYNC');
            }
          }
          context.authorizeSend();
          return true;
        }};
        return new ServerPushEgress({baseUrl: origin, gate,
          timeoutMs: Math.max(1, context.deadlineAt - Date.now())}).push(payload);
      } });
    this.egress = new MultiHouseEgress(origins.map(origin => this.egressFor(origin)), {warn: opts.log});
    this.commands = {
      loginHouse: input => { const origin = this.bindOrigin(input); return this.bus.loginHouse(input).then(async result => {
        if (result.admission === 'configured' || result.status === 'connected') await opts.onJoined?.(origin);
        return result; }); },
      logoutHouse: input => { this.bindOrigin(input);
        if (opts.participation && normalizeHouseOrigin(input) === 'https://house.popclaw.me') opts.db.transaction(tx => cancelInitialSetup(tx,opts.actorId!,resolveInstallationId(opts.db)));
        return this.bus.logoutHouse(input); },
      getHouseStatus: input => this.bus.getHouseStatus(input),
      knownHouseOrigins: () => this.bus.knownHouseOrigins(),
    };
  }

  /** Trusted root-only normal installation activation. Read/list paths never call it. */
  async activateInitialMe(): Promise<import('./manager.js').LoginResult | undefined> {
    const origin = normalizeHouseOrigin('https://house.popclaw.me');
    if (this.opts.db.queryOne<{state:string}>(`SELECT state FROM house_initial_setup WHERE actor_id=? AND installation_id=?`,[this.opts.actorId!,resolveInstallationId(this.opts.db)])?.state !== undefined
      && this.opts.db.queryOne<{state:string}>(`SELECT state FROM house_initial_setup WHERE actor_id=? AND installation_id=?`,[this.opts.actorId!,resolveInstallationId(this.opts.db)])?.state !== 'pending') return undefined;
    const source = this.opts.participation?.capture({reason:'initial_me_setup',origin,actorId:this.opts.actorId!,installationId:resolveInstallationId(this.opts.db)});
    if (!source) return undefined;
    this.bindOrigin(origin);
    return this.bus.loginHouse(origin,{requestId:source.originalOperationRef,participationSource:source});
  }
  async readHouseGuide(input: string) {
    const origin = normalizeHouseOrigin(input), gate = this.publicReadGate(origin);
    // Existing joined Houses may predate the journal. Refresh their verified
    // declared pointer without creating a join or first trust.
    if (gate.isActive() && !this.opts.db.queryOne('SELECT origin FROM house_guide_context WHERE origin=?',[origin])) {
      const row = readParticipation(this.opts.db,origin), binding = pinnedBinding(this.opts.db,origin);
      if (row && binding) try {
        const manifest = await fetchSessionManifest(origin,this.opts.fetch ?? globalThis.fetch,gate.signal);
        const prepared = await makeRelationBindingPreparer({db:this.opts.db,
          configuredKeyFor: origin => this.opts.configuredPinFor?.(origin),
          allowInsecureOrigin: origin => isPrivateAddressOrigin(origin)})({origin,rawBytes:manifest.rawBytes,proofHeader:manifest.proofHeader,signal:gate.signal});
        this.opts.db.transaction(tx => {
          if (!gate.isActive() || JSON.stringify(readParticipation(tx,origin)) !== JSON.stringify(row)) throw new Error('HOUSE_GUIDE_CONTEXT_STALE');
          const refusal = prepared.commit(tx);
          if (refusal) return;
          const doc = JSON.parse(new TextDecoder().decode(manifest.rawBytes));
          const url = typeof doc.guide_url === 'string' ? new URL(doc.guide_url,origin) : undefined;
          tx.execute(`INSERT INTO house_guide_context(origin,binding_digest,op_seq,guide_url,manifest_digest) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`,
            [origin,guideBindingDigest(tx,origin),row.op_seq,url && ['https:','http:'].includes(url.protocol) ? url.href : '',entryDigest(Buffer.from(manifest.rawBytes).toString('base64'))]);
        });
      } catch { /* Joined status remains separate from guide availability. */ }
    }
    return readHouseGuideContext(this.opts.db,origin,this.documentFetch(origin,{...gate,origin,generation:readParticipation(this.opts.db,origin)?.op_seq ?? 0}),() => !this.stopped && gate.isActive());
  }
  async pendingHouseGuides(): Promise<HouseGuideContext[]> {
    const result: HouseGuideContext[] = [];
    for (const {origin} of this.opts.db.queryAll<{origin:string}>(`SELECT origin FROM house_guide_context WHERE delivered_digest IS NULL OR delivered_digest!=guide_digest`)) {
      const context = await this.readHouseGuide(origin);
      if (context.status === 'available' && !context.delivered) result.push(context);
    }
    return result;
  }
  /** Actual host output/LLM-input observer; never claim a prepared or truncated body was delivered. */
  markGuidesInAgentInput(serialized: string): void {
    const rows = this.opts.db.queryAll<{origin:string;guide_body:string;guide_digest:string;binding_digest:string;op_seq:number}>(
      `SELECT * FROM house_guide_context WHERE guide_body IS NOT NULL AND (delivered_digest IS NULL OR delivered_digest!=guide_digest)`);
    // MCP serializes JSON context inside a text result; native history wraps
    // the same text in messages. Inspect those actual emitted values.
    const inspect = (value: unknown, depth: number): void => {
      if (depth > 8) return;
      if (typeof value === 'string') {
        for (const text of [value, ...value.split('\n')]) {
          if (!text.startsWith('{') && !text.startsWith('[')) continue;
          try { inspect(JSON.parse(text), depth + 1); } catch { /* Ordinary reply text. */ }
        }
      } else if (value && typeof value === 'object') {
        const context = value as Record<string, unknown>;
        for (const row of rows) {
          if (context.status !== 'available' || context.origin !== row.origin || context.opSeq !== row.op_seq
            || context.guide !== row.guide_body || context.guideDigest !== row.guide_digest
            || context.bindingDigest !== row.binding_digest) continue;
          this.markHouseGuideDelivered({status:'available',origin:row.origin,bindingDigest:row.binding_digest,opSeq:row.op_seq,
            guideUrl:'',guideDigest:row.guide_digest,guide:row.guide_body,delivered:false});
        }
        for (const child of Object.values(context)) inspect(child, depth + 1);
      }
    };
    inspect(serialized, 0);
  }

  markHouseGuideDelivered(context: HouseGuideContext): boolean { return markHouseGuideDelivered(this.opts.db,context); }
  findParticipationReceipt(query: HouseParticipationReceiptQuery): HouseParticipationReceiptResult {
    return findParticipationReceipt(this.opts.db,query);
  }
  /** A recovery confirms trust, never the old standing execution policy. */
  nativeRecoveryDecisionId(origin: string): string | undefined {
    return this.opts.db.queryOne<{decision_id:string}>("SELECT decision_id FROM house_recovery_fences_v1 WHERE origin=? AND state='complete'",[origin])?.decision_id;
  }

  /** Root-only reconstruction of current durable authority at actual send. */
  configurePushEffectResolver(resolver: HousePushEffectResolver): void {
    if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
    if (this.pushEffectResolver) throw new Error('HOUSE_PUSH_EFFECT_RESOLVER_ALREADY_CONFIGURED');
    if (typeof resolver !== 'function') throw new Error('HOUSE_PUSH_EFFECT_RESOLVER_INVALID');
    this.pushEffectResolver = resolver;
  }

  /** Carries an exact durable effect reference through the existing egress. */
  withPushEffect<T>(input: string, reference: HousePushEffectReference, work: () => T): T {
    if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
    const origin = normalizeHouseOrigin(input);
    const ref = captureHousePushEffect(reference);
    const parent = this.pushEffects.getStore();
    if (parent && (parent.origin !== origin || JSON.stringify(parent.ref) !== JSON.stringify(ref))) {
      throw new Error('HOUSE_PUSH_EFFECT_SCOPE_MISMATCH');
    }
    return this.pushEffects.run({origin, ref}, work);
  }

  configureResources(resources: ResourceConfiguration): void {
    if (this.resources) throw new Error('House resources already configured');
    if (this.stopped) throw new Error('House runtime stopped');
    this.resources = resources;
    for (const store of resources.stores) {
      const origin = this.bindOrigin(store.baseUrl);
      if (store.slug !== hostDbSlug(origin)) throw new Error('HOUSE_STORE_BINDING_MISMATCH');
      this.stores.set(origin, store);
    }
  }

  /** Subscribe to the existing resident sync, never an authorization grant. */
  observeParticipation(input: string, changed: () => void): () => void {
    if (this.stopped) return () => {};
    const origin = normalizeHouseOrigin(input);
    const observers = this.participationObservers.get(origin) ?? new Set<() => void>();
    observers.add(changed); this.participationObservers.set(origin, observers);
    return () => {
      observers.delete(changed);
      if (observers.size === 0) this.participationObservers.delete(origin);
    };
  }

  /** Observe the resident's existing tuple changes, including newly joined houses.
   * A notification grants no authority; consumers capture their own current gate.
   */
  observeParticipationChanges(changed: (origin: string) => void): () => void {
    if (this.stopped) return () => {};
    this.allParticipationObservers.add(changed);
    return () => { this.allParticipationObservers.delete(changed); };
  }

  participationChanged(): void { if (!this.stopped) this.resident.participationChanged(); }

  storageAllows(path: RecoveryPath): boolean { return storageDatabasePathAllowed(this.opts.db, path); }
  publicReadStatus(input: string): PublicReadStatus {
    const origin = normalizeHouseOrigin(input);
    return this.publicResources?.status(origin) ?? inactivePublicReadStatus(this.opts.publicV1Mode === true,
      this.opts.publicV1Mode ? 'Public execution catalog unavailable' : 'Public-v1 mode is not selected');
  }

  /** Local display borrows an already mounted protected handle, without an
   * owner/session gate. Retained public history survives ordinary logout. */
  capturePublicDisplay(house: HouseStore): PublicDisplayCapture {
    const catalog = this.opts.executionStores, origin = normalizeHouseOrigin(house.baseUrl);
    if (!catalog || !this.opts.publicV1Mode || this.stopped || !house.executionDb
      || this.stores.get(origin) !== house || house.slug !== hostDbSlug(origin)) throw new Error('PUBLIC_DISPLAY_STORE_UNAVAILABLE');
    const snapshot = () => {
      if (this.stopped || this.originForSlug(house.slug) !== origin) throw new Error('PUBLIC_DISPLAY_BINDING_CHANGED');
      assertStorageBootstrap(catalog.options.paths);
      const control = readStorageControl(catalog.options.paths);
      if (!control && this.opts.db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_control_required_v1'")) throw new Error('PUBLIC_DISPLAY_CONTROL_MISSING');
      const view = readHouseCapabilityView(this.opts.db, origin), capability = view?.publicStreamCapability;
      if (!view || view.publicStream.validation !== 'valid' || !capability) throw new Error('PUBLIC_DISPLAY_TRUST_UNAVAILABLE');
      const participation = readParticipation(this.opts.db, origin);
      const pin = normalizeAckKeyHex(this.opts.configuredPinFor?.(origin) || participation?.ack_key_hex || '');
      if (!pin || pin !== normalizeAckKeyHex(capability.house.houseKey)) throw new Error('PUBLIC_DISPLAY_PIN_MISMATCH');
      const row = this.opts.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
      const required: unknown = JSON.parse(row?.required_tables ?? '[]');
      if (!row || row.actor_id !== catalog.options.actorId || !Array.isArray(required)
        || !PUBLIC_JOURNAL_TABLES.every(name => required.includes(name))) throw new Error('PUBLIC_DISPLAY_JOURNAL_UNAVAILABLE');
      return { capability, producerPolicy: publicProducerPolicy(view), control, row,
        history: participation?.desired !== 'enabled' || this.publicReadStatus(origin).transport !== 'active' };
    };
    const captured = snapshot();
    // Root store mounting already selected this catalog handle. Its existing
    // reservation is checked above before calling the catalog's cached path.
    const partition = catalog.open(origin);
    if (partition.db !== house.executionDb) throw new Error('PUBLIC_DISPLAY_HANDLE_MISMATCH');
    catalog.verifySelected(origin, partition);
    const assertCurrent = () => {
      if (JSON.stringify(snapshot()) !== JSON.stringify(captured) || this.stores.get(origin) !== house
        || !catalog.isPublicJournalCurrent(origin, partition)) throw new Error('PUBLIC_DISPLAY_CAPTURE_CHANGED');
    };
    assertCurrent();
    return { executionDb: partition.db, capability: captured.capability, producerPolicy: captured.producerPolicy,
      history: captured.history || !!captured.control?.held.length, assertCurrent };
  }

  /**
   * Readiness WITH its reason. A local ledger that was never prepared, a house
   * that declares nothing, a logged-out participation and a held storage path
   * are four different answers, and a bare `false` told whoever was looking
   * none of them: `ACTION_RECEIPT_PROTECTION_INCOMPLETE` was swallowed by an
   * empty catch on every fresh install, so the capability view showed
   * `ready:false` with an empty detail and no log line anywhere. The reason is
   * now named, logged once, and available to the capability view's renderer.
   */
  actionExecutionAvailability(input: string, actorId: string, mode: 'receipt' | 'native'): { ready: boolean; reason: string | null } {
    try {
      const origin = normalizeHouseOrigin(input), store = this.stores.get(origin);
      if (!store) return this.executionRefusal(input, 'ACTION_EXECUTION_HOUSE_NOT_RESIDENT');
      (mode === 'native' ? this.captureNativeActionExecutionStore(store, actorId) : this.captureActionExecutionStore(store, actorId)).readSelected();
      if (!this.captureSessionCommandContext(origin).gate.isActive()) return this.executionRefusal(origin, 'ACTION_EXECUTION_SESSION_INACTIVE');
      return { ready: true, reason: null };
    } catch (error) { return this.executionRefusal(input, error instanceof Error ? error.message.slice(0, 256) : 'ACTION_EXECUTION_UNAVAILABLE'); }
  }
  private executionRefusal(origin: string, reason: string): { ready: false; reason: string } {
    this.opts.log?.(`world execution unavailable (${origin}): ${reason}`);
    return { ready: false, reason };
  }

  /** Reason for the capability view; null while nothing is refusing. */
  actionExecutionReason(input: string, actorId: string, mode: 'receipt' | 'native'): string | null {
    return this.actionExecutionAvailability(input, actorId, mode).reason;
  }

  actionExecutionAvailable(input: string, actorId: string): boolean {
    return this.actionExecutionAvailability(input, actorId, 'receipt').ready;
  }

  nativeActionExecutionAvailable(input: string, actorId: string): boolean {
    return this.actionExecutionAvailability(input, actorId, 'native').ready;
  }

  captureNativeActionExecutionStore(house: HouseStore, actorId: string) {
    const capture = this.captureActionExecutionStore(house, actorId);
    const assertCurrent = () => {
      capture.assertCurrent();
      const row = this.opts.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [house.baseUrl]);
      const required: unknown = JSON.parse(row?.required_tables ?? '[]');
      if (!Array.isArray(required) || !NATIVE_ACTION_FEATURE_TABLES.every(name => required.includes(name))) throw new Error('NATIVE_ACTION_PROTECTION_INCOMPLETE');
    };
    assertCurrent();
    return { ...capture, assertCurrent,
      assertAccounting: () => { assertCurrent(); capture.assertAccounting(); },
      readSelected: () => { assertCurrent(); return capture.readSelected(); } };
  }

  privateMessageExecutionAvailable(origin: string, actorId: string): boolean {
    try {
      if (!this.captureSessionCommandContext(origin).gate.isActive()) return false;
      const capture = this.capturePrivateMessageRead(origin, actorId);
      try { capture.readSelected(); return true; } finally { capture.close(); }
    } catch { return false; }
  }

  /** Local commands borrow an existing read-only partition, never a cache/store opener. */
  capturePrivateMessageRead(input: string, actorId: string) {
    const origin = normalizeHouseOrigin(input), catalog = this.opts.executionStores;
    if (this.stopped || !catalog || actorId !== catalog.options.actorId) throw new Error('PRIVATE_EXECUTION_STORE_UNAVAILABLE');
    if (this.originForSlug(hostDbSlug(origin)) !== origin) throw new Error('PRIVATE_EXECUTION_HANDLE_CHANGED');
    const capture = catalog.capturePrivateMessageRead(origin);
    const assertCurrent = () => {
      if (this.stopped || this.originForSlug(hostDbSlug(origin)) !== origin) throw new Error('PRIVATE_EXECUTION_HANDLE_CHANGED');
      capture.assertCurrent();
      if (!storageDatabasePathAllowed(this.opts.db, 'execution', catalog.options.paths)
        || !storageDatabasePathAllowed(this.opts.db, 'consumers', catalog.options.paths)) throw new Error('PRIVATE_MESSAGE_STORAGE_HELD');
    };
    const readSelected = () => { assertCurrent(); return this.readPrivateSelected(origin); };
    try { assertCurrent(); return { ...capture, assertCurrent, readSelected }; }
    catch (error) { capture.close(); throw error; }
  }

  private readPrivateSelected(origin: string) {
    const view = readHouseCapabilityView(this.opts.db, origin), participation = readParticipation(this.opts.db, origin);
    const pin = normalizeAckKeyHex(this.opts.configuredPinFor?.(origin) || participation?.ack_key_hex || '');
    if (!view || !pin || pin !== normalizeAckKeyHex(view.verified.house.houseKey)) throw new Error('PRIVATE_SELECTION_PIN_MISMATCH');
    return view;
  }

  /** Private material is tied to a certified partition, current pin and both recovery paths. */
  capturePrivateMessageExecutionStore(house: HouseStore, actorId: string) {
    const catalog = this.opts.executionStores, origin = normalizeHouseOrigin(house.baseUrl);
    if (!catalog) throw new Error('PRIVATE_MESSAGE_NOT_PREPARED');
    if (actorId !== catalog.options.actorId || this.stopped || !house.executionDb
      || this.stores.get(origin) !== house || house.slug !== hostDbSlug(origin)) throw new Error('PRIVATE_EXECUTION_STORE_UNAVAILABLE');
    const row = this.opts.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
    if (!row || row.private_message_feature == null) throw new Error('PRIVATE_MESSAGE_NOT_PREPARED');
    const partition = catalog.open(origin);
    const assertCurrent = () => {
      if (this.stopped || this.stores.get(origin) !== house || house.executionDb !== partition.db
        || this.originForSlug(house.slug) !== origin) throw new Error('PRIVATE_EXECUTION_HANDLE_CHANGED');
      if (!catalog.isPrivateMessageJournalCurrent(origin, partition)) throw new Error('PRIVATE_MESSAGE_PROTECTION_INCOMPLETE');
      if (!storageDatabasePathAllowed(this.opts.db, 'execution', catalog.options.paths)
        || !storageDatabasePathAllowed(this.opts.db, 'consumers', catalog.options.paths)) throw new Error('PRIVATE_MESSAGE_STORAGE_HELD');
    };
    const readSelected = () => { assertCurrent(); return this.readPrivateSelected(origin); };
    assertCurrent(); return { executionDb: partition.db, assertCurrent, readSelected, close: () => {} };
  }

  /** Shared action handle capture. Original receipt accounting has no login or grant check. */
  captureActionExecutionStore(house: HouseStore, actorId: string) {
    const catalog = this.opts.executionStores, origin = normalizeHouseOrigin(house.baseUrl);
    if (!catalog || actorId !== catalog.options.actorId || this.stopped || !house.executionDb
      || this.stores.get(origin) !== house || house.slug !== hostDbSlug(origin)) throw new Error('ACTION_EXECUTION_STORE_UNAVAILABLE');
    const partition = catalog.open(origin);
    const assertCurrent = () => {
      if (this.stopped || this.stores.get(origin) !== house || house.executionDb !== partition.db
        || this.originForSlug(house.slug) !== origin) throw new Error('ACTION_EXECUTION_HANDLE_CHANGED');
      catalog.verifySelected(origin, partition);
      const row = this.opts.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
      const required: unknown = JSON.parse(row?.required_tables ?? '[]');
      if (!Array.isArray(required) || !ACTION_RECEIPT_FEATURE_TABLES.every(name => required.includes(name)))
        throw new Error('ACTION_RECEIPT_PROTECTION_INCOMPLETE');
    };
    const assertAccounting = () => {
      assertCurrent();
      if (!storageDatabasePathAllowed(this.opts.db, 'execution', catalog.options.paths)
        || !storageDatabasePathAllowed(this.opts.db, 'consumers', catalog.options.paths)) throw new Error('ACTION_ACCOUNTING_HELD');
    };
    const readSelected = () => {
      assertAccounting();
      const view = readHouseCapabilityView(this.opts.db, origin);
      const participation = readParticipation(this.opts.db, origin);
      const pin = normalizeAckKeyHex(this.opts.configuredPinFor?.(origin) || participation?.ack_key_hex || '');
      if (!view || !pin || pin !== normalizeAckKeyHex(view.verified.house.houseKey)) throw new Error('ACTION_SELECTION_PIN_MISMATCH');
      return view;
    };
    assertCurrent();
    return { executionDb: partition.db, expectedPartition: { origin, actorId, storeId: partition.storeId, layoutVersion: 1 as const },
      assertCurrent, assertAccounting, readSelected };
  }

  start(): void {
    if (this.stopped) return;
    if (!this.resources) throw new Error('House resources have not been configured');
    this.resident.start(); this.bus.start();
  }

  /** A one-shot only enqueues work; it never competes for stream ownership. */
  startReader(): void { if (!this.stopped) this.bus.start(); }

  originForSlug(slug: string): string {
    if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
    const row = this.opts.db.queryOne<{origin: string}>('SELECT origin FROM house_origin_bindings WHERE slug = ?', [slug]);
    if (!row) throw new Error(`INVALID_HOUSE: ${slug}`);
    return row.origin;
  }

  captureGate(input: string): HouseGate {
    const origin = normalizeHouseOrigin(input);
    if (this.stopped) return {origin, generation: -1, signal: this.terminal.signal, isActive: () => false};
    const gate = this.resident.captureGate(origin);
    return {...gate, isActive: () => { try { return this.storageAllows('execution') && gate.isActive(); } catch { return false; } },
      inactiveReason: () => { try { return this.storageAllows('execution') ? gate.inactiveReason?.() ?? 'HOUSE_ACTION_STALE' : 'HOUSE_STORAGE_UNAVAILABLE'; } catch { return 'HOUSE_STORAGE_UNAVAILABLE'; } }};
  }

  gateForSlug(slug: string): HouseGate {
    try { return this.captureGate(this.originForSlug(slug)); }
    catch { return {origin: '', generation: -1, signal: this.terminal.signal, isActive: () => false}; }
  }

  /** Read only the bytes validated by login. A failed projection cannot undo login. */
  readAgentContext(input: string, actorId: string, query: WorldAgentContextQuery = {}, expectedSessionId?: string): WorldAgentContextResult {
    try {
      const origin = normalizeHouseOrigin(input), session = this.captureSessionCommandContext(origin);
      if ((expectedSessionId ?? query.expected_session_id) !== undefined && session.sessionId !== (expectedSessionId ?? query.expected_session_id))
        return {status: 'unavailable', code: 'HOUSE_SESSION_CHANGED'};
      const view = readHouseCapabilityView(this.opts.db, origin), participation = readParticipation(this.opts.db, origin);
      const pin = normalizeAckKeyHex(this.opts.configuredPinFor?.(origin) || participation?.ack_key_hex || '');
      if (!view) return {status: 'unavailable', code: 'CAPABILITY_CONTEXT_INCOMPLETE'};
      if (view.verified.house.origin !== origin || !pin || pin !== normalizeAckKeyHex(view.verified.house.houseKey))
        return {status: 'unavailable', code: 'CAPABILITY_HOUSE_MISMATCH'};
      const material = projectWorldAgentContext(view, actorId, query);
      if (!session.gate.isActive()) return {status: 'unavailable', code: 'HOUSE_SESSION_CHANGED'};
      if (material.read) material.read.arguments.expected_session_id = session.sessionId;
      if (material.action_read) material.action_read.arguments.expected_session_id = session.sessionId;
      return {...material, session_id: session.sessionId, session_revision: session.fence};
    } catch { return {status: 'unavailable', code: 'HOUSE_CONTEXT_UNAVAILABLE'}; }
  }

  /** A reader may prepare a session-bound command; only the bus owner sends it.
   * Capture all signing inputs together and never replace them after an await. */
  captureSessionCommandContext(input: string): HouseSessionCommandContext {
    if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
    const origin = normalizeHouseOrigin(input);
    assertHouseActionActive(origin);
    const captured = readParticipation(this.opts.db, origin);
    if (!captured || !captured.session_id || !captured.installation_id
      || !/^[0-9a-f]{64}$/i.test(captured.ack_key_hex)
      || !Number.isSafeInteger(captured.house_revision) || captured.house_revision < 1
      || !Number.isSafeInteger(captured.op_seq) || captured.op_seq < 1
      || !Number.isSafeInteger(captured.lease_expires_at)) throw sessionUnavailableError(origin, captured?.remote_status);
    const gate: HouseGate = { origin, generation: captured.op_seq, signal: this.terminal.signal,
      isActive: () => {
        if (this.stopped || !this.storageAllows('execution') || houseBindingBlocked(this.opts.db,origin)) return false;
        const current = readParticipation(this.opts.db, origin);
        return !!current && current.desired === 'enabled' && current.phase === 'connected'
          && current.op_seq === captured.op_seq && current.session_id === captured.session_id
          && current.house_revision === captured.house_revision
          && current.installation_id === captured.installation_id && current.ack_key_hex === captured.ack_key_hex
          && Number.isSafeInteger(current.lease_expires_at)
          && current.lease_expires_at > Math.floor((this.opts.clock?.() ?? Date.now()) / 1000);
      } };
    if (!gate.isActive()) throw sessionUnavailableError(origin, readParticipation(this.opts.db, origin)?.remote_status);
    return { gate, sessionId: captured.session_id, fence: String(captured.house_revision),
      leaseExpiresAt: captured.lease_expires_at, installationId: captured.installation_id };
  }

  /** This local-known-request capability intentionally ignores participation's
   * desired state and business AsyncLocalStorage. It cannot enter or send. */
  captureKnownActionReadGate(input: string, requestId: string, knownRequest: (id: string) => boolean): KnownActionReadGate {
    if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
    const origin = normalizeHouseOrigin(input);
    if (!/^[a-f0-9]{64}$/.test(requestId)) throw new Error('REQUEST_ID_INVALID');
    const slug = hostDbSlug(origin);
    const gate: KnownActionReadGate = Object.freeze({origin, signal: this.terminal.signal, isActive: () => {
      if (this.stopped || this.terminal.signal.aborted) return false;
      const bound = this.opts.db.queryOne<{origin: string}>('SELECT origin FROM house_origin_bindings WHERE slug = ?', [slug]);
      return bound?.origin === origin && knownRequest(requestId) === true;
    }});
    if (!gate.isActive()) throw new Error('HOUSE_ACTION_READ_NOT_AUTHORIZED');
    this.actionReadGates.set(gate, {origin, requestId});
    return gate;
  }

  /** The sole disabled-house HTTP exception: a signed status query for the
   * exact request named by a capability this runtime issued. Never a generic
   * control fetch, and never a source of invoke/stream authority. */
  async readKnownActionStatus(input: string, requestId: string, bytes: Uint8Array,
    gate: KnownActionReadGate, timeoutMs = 10_000): Promise<Uint8Array> {
    const body = new Uint8Array(bytes); // Snapshot before the first await.
    const origin = normalizeHouseOrigin(input);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('ACTION_STATUS_TIMEOUT_INVALID');
    const check = () => {
      if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
      const issued = this.actionReadGates.get(gate);
      if (!issued || issued.origin !== origin || issued.requestId !== requestId || gate.origin !== origin
        || gate.signal.aborted || !gate.isActive()) throw new Error('HOUSE_ACTION_READ_NOT_AUTHORIZED');
    };
    check();
    const query = popclaw.world.ActionStatusRequest.decode(body);
    if (query.requestId !== requestId || query.house?.origin !== origin) throw new Error('HOUSE_ACTION_READ_BINDING_MISMATCH');
    const target = `${origin}/v1/world-actions/status`;
    const timeout = new AbortController();
    const signal = AbortSignal.any([gate.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(new Error('HOUSE_ACTION_STATUS_TIMEOUT')), timeoutMs);
    timer.unref?.();
    const current = () => { check(); signal.throwIfAborted(); };
    const task = (async () => {
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let cancelling: Promise<void> | undefined;
      const cancelBody = () => {
        if (!cancelling && (reader || response?.body)) {
          cancelling = (reader ? reader.cancel() : response!.body!.cancel()).catch(() => {});
        }
      };
      signal.addEventListener('abort', cancelBody, {once: true});
      try {
        current();
        response = await (this.opts.fetch ?? globalThis.fetch)(target, {method: 'POST', body,
          headers: {'Content-Type': 'application/x-protobuf'}, credentials: 'omit', redirect: 'error', signal});
        current();
        if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('HOUSE_ACTION_STATUS_REDIRECT');
        if (response.url && response.url !== target) throw new Error('HOUSE_AUDIENCE_MISMATCH');
        if (response.status !== 200) throw Object.assign(new Error(`HOUSE_ACTION_STATUS_HTTP_${response.status}`), {status: response.status});
        if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/x-protobuf') {
          throw new Error('HOUSE_ACTION_STATUS_CONTENT_TYPE');
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 1_048_576)) throw new Error('ACTION_STATUS_SIZE_LIMIT');
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (response.body) {
          reader = response.body.getReader();
          while (true) {
            const chunk = await reader.read();
            current();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 1_048_576) throw new Error('ACTION_STATUS_SIZE_LIMIT');
            chunks.push(new Uint8Array(chunk.value));
          }
        }
        current();
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
        return result;
      } finally {
        try { cancelBody(); await cancelling; }
        finally { signal.removeEventListener('abort', cancelBody); reader?.releaseLock(); clearTimeout(timer); }
      }
    })();
    this.actionReadTasks.add(task);
    void task.then(() => this.actionReadTasks.delete(task), () => this.actionReadTasks.delete(task));
    // Release the caller on timeout/stop even if an injected fetch settles
    // late. Keep the actual I/O task above tracked until cleanup really ends.
    return new Promise<Uint8Array>((resolve, reject) => {
      const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
      task.then(value => {
        signal.removeEventListener('abort', aborted);
        try { current(); resolve(value); } catch (error) { reject(error); }
      },
        error => { signal.removeEventListener('abort', aborted); reject(error); });
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, {once: true});
    });
  }

  /** Business commands are readers of captured participation; only the bus
   * owner may send. Local-only commands still work when a house is disabled. */
  runCommand<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('HOUSE_RUNTIME_STOPPED'));
    const gates = new Map<string, ActionGate>();
    for (const {origin} of this.opts.db.queryAll<{origin: string}>('SELECT origin FROM house_origin_bindings')) {
      gates.set(origin, this.participationGate(origin));
    }
    const task = Promise.resolve().then(() => {
      if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
      return withHouseActions(gates, work);
    });
    this.commandTasks.add(task);
    void task.then(() => this.commandTasks.delete(task), () => this.commandTasks.delete(task));
    return task;
  }

  /**
   * "Is this machine joined to this house, right now?" — captured once and
   * re-read on every check, so a login, logout or re-login in ANOTHER process
   * on the same data root invalidates the handle immediately. Extracted from
   * `runCommand` so the public-read lane below asks the identical question;
   * the two must never drift into slightly different answers.
   */
  private participationGate(origin: string): ActionGate {
    let captured: ParticipationRow | null = null;
    try { captured = readParticipation(this.opts.db, origin); } catch { /* Unreadable authority remains closed. */ }
    const trust = captured?.session_id === '' ? captureLegacyTrust(this.opts.db, origin) : undefined;
    const configuredTrustRequired = this.manager.isConfiguredParticipation(origin);
    const reason = (): HouseReadFailureCode => {
      try {
        const current = readParticipation(this.opts.db, origin);
        if (current?.desired === 'disabled') return 'HOUSE_DISABLED';
        if (!this.storageAllows('execution')) return 'HOUSE_STORAGE_UNAVAILABLE';
        if (!current || current.phase !== 'connected') return current?.remote_status === 'unsupported' ? 'HOUSE_LIFECYCLE_UNSUPPORTED' : 'HOUSE_CONNECTING';
        if (captured?.session_id === '' && !this.manager.legacyParticipationTrustCurrent(origin, trust, configuredTrustRequired)) return 'HOUSE_TRUST_REVOKED';
        return 'HOUSE_ACTION_STALE';
      } catch { return 'HOUSE_TRUST_REVOKED'; }
    };
    return {origin, signal: this.terminal.signal, inactiveReason: reason, isActive: () => {
      try {
      if (this.stopped || !this.storageAllows('execution') || houseBindingBlocked(this.opts.db,origin) || !captured || captured.desired !== 'enabled' || captured.phase !== 'connected') return false;
      const current = readParticipation(this.opts.db, origin);
      return !!current && current.desired === 'enabled' && current.phase === 'connected'
        && current.op_seq === captured.op_seq && current.session_id === captured.session_id
        && current.house_revision === captured.house_revision
        && current.installation_id === captured.installation_id && current.ack_key_hex === captured.ack_key_hex
        && (current.session_id === '' || current.lease_expires_at > Math.floor((this.opts.clock?.() ?? Date.now()) / 1000))
        && (captured.session_id !== '' || this.manager.legacyParticipationTrustCurrent(origin, trust, configuredTrustRequired));
      } catch { return false; }
    }};
  }

  /**
   * The PUBLIC read lane — the one house call a process that does not own the
   * lifecycle may still make.
   *
   * `houseFetch` below gates every house call on `captureGate`, which carries
   * the resident OWNER epoch (resident.ts): in a second process on the same
   * data root — the MCP host beside a running OpenClaw gateway, the story
   * docs/hosts.md promises — that gate is permanently inactive, so even an
   * unauthenticated `GET /world-feed` died with `ActionInactiveError`. Writes
   * had a cross-process path already (the command bus forwards them to the
   * owner); only this read lane stayed coupled to ownership.
   *
   * Ownership is the right gate for what it was built to protect: stream
   * sets, renewal, session attach, egress, anything signed. A public GET is
   * none of those, so this lane refuses to be any of those — method, headers
   * and audience are checked here rather than trusted to the caller:
   *  - GET/HEAD only, so it can never become a write or a push;
   *  - no `authorization`, no `cookie`, no inbox token in EITHER the init or
   *    a `Request` object's own header list (a review found that a Request
   *    carrying one alongside a non-nullish `init.headers` was silently
   *    stripped by the platform instead of refused — true in effect, and the
   *    exact opposite of what this comment promised), and `credentials`
   *    forced to `omit`, so it can never carry material `houseFetch` would
   *    not have carried either;
   *  - same audience, no user-info, `redirect: 'error'` — unchanged.
   * All of that is about HEADERS. The lane does not inspect the query string:
   * no caller puts a secret there (limit/author/platform/window/q/sigil are
   * public, and the owner lane already sent them verbatim), but a future one
   * must not assume this lane would catch it.
   *
   * Everything the gate protects that a read CAN still violate is kept:
   * `assertHouseActionActive` holds the enclosing command's own captured
   * participation, `participationGate` refuses a house this machine has left
   * or never joined (a leave written by the OTHER process included) and
   * expires with the session lease, the storage hold still closes it, the
   * terminal signal still kills it at host stop, and the pin-conflict wall
   * (manager.gateFor) is re-applied below so a house whose durable binding
   * disagrees with the operator's configured pin stays unreadable.
   *
   * The one thing it deliberately no longer aborts on is ownership CHANGING
   * mid-flight: an in-flight public GET on an ex-owner now runs to
   * completion instead of throwing. It opens nothing, signs nothing, attaches
   * no session and advances no cursor — the resume cursor is written only by
   * `recordInsertCursor` off the SSE stream (world-feed-cache.ts), which a
   * non-owner never opens.
   *
   * It is NOT true, though, that nothing durable is written. Three local
   * writes become reachable from a non-owner for the first time, and all are
   * deliberate:
   *  - `world_feed` cache rows — WorldFeedCatalog.fetchSnapshot records every
   *    envelope-verified item it just read (world-feed-catalog.ts), an
   *    INSERT OR REPLACE of exactly the rows the owner would have written;
   *  - the BOND BOOK — popclaw_show_namecard resolves through the re-routed
   *    ResolveClient, and person-resolver's `learn` fills a house-supplied
   *    nickname into an empty slot (tools/person-sources.ts, person-resolver.ts).
   *    Fill-empty-only, never an overwrite, and the bond book is a cache by
   *    design — but it is durable and it survives a leave;
   *  - the house's TRUST ROWS — popclaw_house_entry_link re-checks a "no
   *    browser entrance" projection by fetching the manifest through this
   *    lane into `confirmHouseTrust` (browser-entry-authority.ts). Its commit
   *    refreshes the pin's confirmed_at and the read-declaration projection,
   *    or blocks the pin on a key/incarnation disagreement — all from bytes
   *    verified against the key already pinned here; it never pins a new one.
   */
  publicReadFailure(input: string): HouseReadFailureCode | undefined {
    const gate = this.publicReadGate(normalizeHouseOrigin(input));
    return gate.isActive() ? undefined : gate.inactiveReason?.() ?? 'HOUSE_ACTION_STALE';
  }

  houseReadFetch(input: string): typeof globalThis.fetch {
    const origin = normalizeHouseOrigin(input);
    return async (url, init) => {
      assertHouseActionActive(origin);
      const request = url instanceof Request ? url : null;
      const gate = this.publicReadGate(origin);
      assertActionActive(gate);
      const target = new URL(request ? request.url : String(url));
      if (target.origin !== origin || target.username || target.password) throw new Error('HOUSE_AUDIENCE_MISMATCH');
      const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') throw new Error('HOUSE_READ_METHOD_NOT_ALLOWED');
      // BOTH header lists, not `init ?? request`: a Request object carrying a
      // credential alongside a non-nullish `init.headers` would otherwise be
      // accepted here and silently stripped by the platform. Stripping is not
      // refusing, and a caller that asked to send one must be told it cannot.
      for (const source of [request?.headers, init?.headers]) {
        if (source === undefined || source === null) continue;
        const headers = new Headers(source);
        for (const name of PUBLIC_READ_FORBIDDEN_HEADERS) if (headers.has(name)) throw new Error('HOUSE_READ_CREDENTIAL_REFUSED');
      }
      return actionFetch(gate, this.opts.fetch ?? globalThis.fetch)(url, {...init, method, redirect: 'error', credentials: 'omit'});
    };
  }

  /** Joined here AND not in pin conflict — see `houseReadFetch` above. The
   * pin comparison is the OWNER lane's own, called here rather than restated,
   * so this lane can never end up the more permissive of the two. */
  publicReadGate(origin: string): ActionGate {
    const joined = this.participationGate(origin);
    const agrees = () => {
      try {
        const row = readParticipation(this.opts.db, origin);
        return !!row && HouseLifecycleManager.pinAgreesWithBinding(row, this.opts.configuredPinFor?.(origin) ?? '');
      } catch { return false; }
    };
    return {origin, signal: joined.signal,
      inactiveReason: () => !joined.isActive() ? joined.inactiveReason?.() ?? 'HOUSE_ACTION_STALE' : 'HOUSE_TRUST_REVOKED',
      isActive: () => joined.isActive() && agrees()};
  }

  /** House HTTP never follows a redirect or sends a credential to another origin. */
  houseFetch(input: string, captured?: HouseGate): typeof globalThis.fetch {
    const origin = normalizeHouseOrigin(input);
    return async (url, init) => {
      assertHouseActionActive(origin);
      const gate = captured ?? this.captureGate(origin);
      assertActionActive(gate);
      const target = new URL(url instanceof Request ? url.url : String(url));
      if (target.origin !== origin || target.username || target.password) throw new Error('HOUSE_AUDIENCE_MISMATCH');
      return actionFetch(gate, this.opts.fetch ?? globalThis.fetch)(url, {...init, redirect: 'error'});
    };
  }

  /**
   * A public document the house DECLARED, wherever it lives (ADR-0041: a
   * declared `guide_url` is relative or absolute http(s), so the world house
   * at one origin may publish its guide on another). `houseFetch` refuses any
   * other origin, which is right for house HTTP and wrong for this one read.
   *
   * Everything else `houseFetch` protects is kept: the enclosing command's
   * participation and the captured gate (a paused or left house fetches
   * nothing), no user-info, `redirect: 'error'`, the same `actionFetch`.
   * On top of that, because the target is not the house: http(s) only, GET or
   * HEAD only, no `authorization` / `cookie` / inbox token in either header
   * list, and `credentials: 'omit'`. It is a plain GET of a public document;
   * nothing derived from the house rides along.
   *
   * And no private address: a literal loopback / private / link-local / CGNAT
   * / unspecified host (IPv4, IPv6, IPv4-mapped) or a `localhost` name is
   * refused (`HOUSE_DOCUMENT_ADDRESS_REFUSED`), unless the house itself is on
   * such an address (dev and test houses). DNS names that resolve to a
   * private address, and DNS rebinding, are NOT covered: nothing is resolved.
   */
  documentFetch(input: string, captured?: HouseGate): typeof globalThis.fetch {
    const origin = normalizeHouseOrigin(input);
    const privateHouse = isPrivateAddressOrigin(origin);
    return async (url, init) => {
      assertHouseActionActive(origin);
      const gate = captured ?? this.captureGate(origin);
      assertActionActive(gate);
      const request = url instanceof Request ? url : null;
      const target = new URL(request ? request.url : String(url));
      if ((target.protocol !== 'https:' && target.protocol !== 'http:') || target.username || target.password) {
        throw new Error('HOUSE_DOCUMENT_URL_REFUSED');
      }
      // Origin equality used to keep a hostile declaration off this machine and
      // its LAN; this lane must refuse that explicitly. A house that is itself
      // on a private address (a dev or test house) is exempt.
      if (!privateHouse && isPrivateAddressHost(target.hostname)) throw new Error('HOUSE_DOCUMENT_ADDRESS_REFUSED');
      const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') throw new Error('HOUSE_READ_METHOD_NOT_ALLOWED');
      for (const source of [request?.headers, init?.headers]) {
        if (source === undefined || source === null) continue;
        const headers = new Headers(source);
        for (const name of PUBLIC_READ_FORBIDDEN_HEADERS) if (headers.has(name)) throw new Error('HOUSE_READ_CREDENTIAL_REFUSED');
      }
      return actionFetch(gate, this.opts.fetch ?? globalThis.fetch)(url, {...init, method, redirect: 'error', credentials: 'omit'});
    };
  }

  readonly fetchHouse: typeof globalThis.fetch = (input, init) => {
    const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
    return this.houseFetch(origin)(input, init);
  };

  private bindOrigin(input: string): string {
    if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
    const origin = normalizeHouseOrigin(input); const slug = hostDbSlug(origin);
    this.opts.db.transaction(tx => {
      tx.execute('INSERT OR IGNORE INTO house_origin_bindings (slug, origin) VALUES (?, ?)', [slug, origin]);
      if (tx.queryOne<{origin: string}>('SELECT origin FROM house_origin_bindings WHERE slug = ?', [slug])?.origin !== origin) {
        throw new Error(`HOUSE_SLUG_COLLISION: ${slug}`);
      }
    });
    if (!this.targets.has(origin)) {
      this.targets.set(origin, slug);
      this.egress?.mount(this.egressFor(origin));
    }
    return origin;
  }

  private egressFor(origin: string) {
    return {slug: hostDbSlug(origin), origin, egress: {push: async (bytes: Uint8Array) => {
      assertHouseActionActive(origin);
      const effect = this.pushEffects.getStore();
      if (effect && effect.origin !== origin) throw new Error('HOUSE_PUSH_EFFECT_ORIGIN_MISMATCH');
      const result = await this.bus.push(origin, bytes, effect?.ref);
      if (result.status < 200 || result.status >= 300) throw new HousePushError(result);
      return result;
    }} };
  }

  /** Recover an uncertain send by its original operation; querying never sends. */
  getPushOperation(operationId: string): PushOperation | null {
    return this.bus.getPushOperation(operationId);
  }

  /** The lane decision, applied under this house's live gate. */
  private async readToken(gate: HouseGate): Promise<InboxReadCredential> {
    assertActionActive(gate);
    const row = readParticipation(this.opts.db, gate.origin);
    if (!row) throw new Error('HOUSE_DISABLED');
    const pin = pinnedBinding(this.opts.db, gate.origin);
    if (!pin || pin.blockedReason !== undefined) throw new Error('READ_AUTH_HOUSE_NOT_TRUSTED');
    const declaration = declarationFingerprint(readVerifiedDeclaration(this.opts.db, pin));
    const sessionLane = !!row.session_id && sessionReadSelected(this.opts.db, gate.origin);
    const assertCurrent = (): void => {
      assertActionActive(gate);
      const current = readParticipation(this.opts.db, gate.origin);
      const after = pinnedBinding(this.opts.db, gate.origin);
      if (!current || current.op_seq !== row.op_seq || current.session_id !== row.session_id ||
        !after || after.blockedReason !== undefined || after.houseKey !== pin.houseKey || after.revision !== pin.revision ||
        declarationFingerprint(readVerifiedDeclaration(this.opts.db, after)) !== declaration ||
        (!!current.session_id && sessionReadSelected(this.opts.db, gate.origin)) !== sessionLane ||
        (sessionLane && current.inbox_read_token !== row.inbox_read_token)) {
        throw new Error('READ_AUTH_HOUSE_NOT_TRUSTED');
      }
    };
    // Positive selection happens BEFORE any identity signing. This ACK token
    // belongs to the current gate's session; failure never selects identity.
    if (sessionLane) {
      assertCurrent();
      return { token: sessionInboxReadToken(row), assertCurrent };
    }
    const credential = await this.opts.readAuthorityFor(gate.origin)('inbox-stream');
    // Re-checked after the await: signing is not instant, and a logout that
    // landed while it ran must not get one more connection out of the door.
    assertCurrent();
    // The identity selection cannot turn into a different lane after an await.
    return { token: chooseInboxReadToken(row, credential, false), assertCurrent };
  }

  /** Reader commands share the root's existing house DB handle. Only a known
   * binding may open a store; this does not login or start resident resources. */
  async storeForCommand(input: string): Promise<HouseStore> {
    if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
    const origin = normalizeHouseOrigin(input);
    if (this.originForSlug(hostDbSlug(origin)) !== origin) throw new Error('HOUSE_AUDIENCE_MISMATCH');
    const store = await this.storeFor(origin);
    if (this.stopped) throw new Error('HOUSE_RUNTIME_STOPPED');
    return store;
  }

  private storeFor(input: string): Promise<HouseStore> {
    const origin = this.bindOrigin(input);
    const existing = this.stores.get(origin);
    if (existing) return Promise.resolve(existing);
    const pending = this.opening.get(origin);
    if (pending) return pending;
    if (!this.resources) throw new Error('House resources have not been configured');
    const resources = this.resources;
    const task = resources.openStore(origin).then(store => {
      if (normalizeHouseOrigin(store.baseUrl) !== origin || store.slug !== hostDbSlug(origin)) {
        store.db.close(); throw new Error('HOUSE_STORE_BINDING_MISMATCH');
      }
      this.stores.set(origin, store);
      resources.onStore?.(store);
      return store;
    }).finally(() => { this.opening.delete(origin); });
    this.opening.set(origin, task);
    return task;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.participationObservers.clear();
    this.allParticipationObservers.clear();
    this.terminal.abort();
    const resident = this.resident.stop();
    const bus = this.bus.stop();
    this.stopTask = (async () => {
      await Promise.all([resident, bus]);
      while (this.opening.size || this.commandTasks.size || this.actionReadTasks.size) {
        await Promise.allSettled([...this.opening.values(), ...this.commandTasks, ...this.actionReadTasks]);
      }
    })();
    return this.stopTask;
  }
}
