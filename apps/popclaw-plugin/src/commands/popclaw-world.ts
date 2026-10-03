/** The frozen world command surface shared by native tools, MCP and CLI roots. */
import Ajv from 'ajv';
import { boundWorldAgentContext, worldContextTextCost, type WorldAgentContextQuery, type WorldAgentContextResult } from '../world/world-agent-context.js';
import type { WorldActionAuthority, WorldActionClient, WorldInvokeInput } from '../world/action-client.js';
import type { HouseCapabilityView } from '../world/world-capabilities.js';
import type { PublicReadStatus } from '../runtime/house-lifecycle/public-read-resources.js';
import { worldActionViewJson } from '../world/action-json.js';
import { jsonObject, parseWorldJson } from '../world/json-profile.js';

type MaybePromise<T> = T | Promise<T>;
export interface WorldHouseInput { house: string }
export interface WorldCapabilitiesInput extends WorldHouseInput, WorldAgentContextQuery {}
export interface WorldPrivateMessagesInput extends WorldHouseInput {
  limit?: number;
  cursor?: string;
  message_id?: string;
  state_ref?: string;
  expected_capability_revision?: string;
  expected_session_id?: string;
}
export interface WorldActionStatusInput extends WorldHouseInput { request_id: string }
export interface WorldCommandContext {
  /** Read only the already verified local cache. Never fetch a guide or manifest here. */
  readCapabilities(house: string): MaybePromise<HouseCapabilityView | null>;
  readAgentContext?(input: WorldCapabilitiesInput): MaybePromise<WorldAgentContextResult>;
  /** Read authenticated private material from the current local session; never consumes or grants authority. */
  readPrivateMessages?(input: WorldPrivateMessagesInput): MaybePromise<unknown>;
  readPublicStatus?(house: string): MaybePromise<PublicReadStatus>;
  client(house: string): MaybePromise<Pick<WorldActionClient, 'invoke' | 'status'>>;
  /** Trusted non-JSON authority injection; request IDs and host metadata grant nothing. */
  actionAuthority?(input: Readonly<WorldInvokeInput>): MaybePromise<WorldActionAuthority>;
  now?(): string;
}

export const WORLD_COMMAND_HELP = [
  'popclaw world capabilities <house-origin> [--kind <intent-kind>] [--event-kind <event-kind>] [--guide-offset <characters>] [--expected-capability-revision <hex64>] [--expected-session-id <id>] [--schema params|result|body] [--schema-offset <characters>]',
  'popclaw world private-messages <house-origin> [--limit <1..100>] [--cursor <cursor> | --message-id <id> | --state-ref <ref>] [--expected-capability-revision <hex64>] [--expected-session-id <id>]',
  'popclaw world invoke <house-origin> <intent-kind> --params-json <file|-> --expected-capability-revision <hex64>',
  'popclaw world action-status <house-origin> <request-id>',
].join('\n');

/** sdk-contract.md §11: protocol constants, never inferred from house prose. */
export const WORLD_PROTOCOL_LIMITS = Object.freeze({
  L_MANIFEST_MAX_BYTES: 262144, L_GUIDE_MAX_BYTES: 524288, L_SCHEMA_DOC_MAX_BYTES: 32768,
  L_MANIFEST_MAX_SCHEMAS: 64, L_PARAMS_MAX_BYTES: 16384, L_RESULT_BODY_MAX_BYTES: 32768,
  L_SNAPSHOT_BODY_MAX_BYTES: 65536, L_ENVELOPE_MAX_BYTES: 1572864, L_JSON_MAX_DEPTH: 8,
  L_SCOPES_MAX: 32, L_INITIAL_SCOPES_MAX: 8, L_SCOPE_ID_MAX_CHARS: 64,
  L_ACTION_GROUPS_MAX: 16, L_OPPORTUNITIES_MAX: 64, L_BUDGETS_MAX: 16,
  L_DESCRIPTOR_MAX_BYTES: 65536, L_PRIVATE_MESSAGE_MAX_BYTES: 65536, L_SUMMARY_MAX_CHARS: 280,
  L_DEDUPE_KEY_MAX_CHARS: 128, L_CLAIM_BATCH_MAX: 16, L_COMPLETE_BATCH_MAX: 16,
  L_PUBLICATION_STATUS_BATCH_MAX: 64, L_PENDING_ACTIONS_PER_SESSION_MAX: 64,
  L_STATUS_QUERY_TTL_MAX_SECONDS: 300, L_CLOSURE_RECORDS_PAGE_MAX: 128, L_BARRIER_MEMBERS_MAX: 256,
  L_STREAM_PAGE_MAX_EVENTS: Object.freeze({ client_request: 512, server_page: 256 }), L_BUDGET_SUGGESTED_LIMIT_MAX: 1000,
});

const houseSchema = { type: 'string', minLength: 1, maxLength: 253, pattern: '^https?://[^/?#@\\s]+$' };
const opaqueSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_./:-]{1,128}$' };
const kindSchema = { type: 'string', maxLength: 64, pattern: '^[a-z0-9]{1,24}(\\.[a-z0-9_]{1,24}){1,2}$' };
const digestSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** These exact objects drive both runtime validation and every host's inputSchema. */
export const WORLD_COMMAND_SCHEMAS = freeze({
  capabilities: { type: 'object', properties: { house: houseSchema, kind: kindSchema, event_kind: kindSchema,
    guide_offset: {type: 'integer', minimum: 0, maximum: 524288}, expected_capability_revision: digestSchema,
    expected_session_id: {type: 'string', minLength: 1, maxLength: 256},
    schema: {enum: ['params', 'result', 'body']}, schema_offset: {type: 'integer', minimum: 0, maximum: 32768} }, required: ['house'], additionalProperties: false, dependencies: {schema_offset: ['schema']},
    allOf: [
      // params/result pages select an action kind; a body page selects a declared event kind.
      { if: { properties: { schema: { enum: ['params', 'result'] } }, required: ['schema'] }, then: { required: ['kind'] } },
      { if: { properties: { schema: { const: 'body' } }, required: ['schema'] }, then: { required: ['event_kind'] } },
      // An event explanation is its own narrow read: never mix action or guide selectors.
      { if: { required: ['event_kind'] }, then: { not: { anyOf: [{ required: ['kind'] }, { required: ['guide_offset'] }] } } },
    ] },
  private_messages: { type: 'object', additionalProperties: false, required: ['house'],
    properties: { house: houseSchema, limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', minLength: 1, maxLength: 4096 }, message_id: opaqueSchema, state_ref: opaqueSchema,
      expected_capability_revision: digestSchema, expected_session_id: { type: 'string', minLength: 1, maxLength: 256 } },
    allOf: [
      { not: { anyOf: [ { required: ['cursor', 'message_id'] }, { required: ['cursor', 'state_ref'] }, { required: ['message_id', 'state_ref'] } ] } },
      { if: { anyOf: [ { required: ['cursor'] }, { required: ['message_id'] }, { required: ['state_ref'] } ] },
        then: { required: ['expected_capability_revision', 'expected_session_id'] } },
    ] },
  invoke: { type: 'object', properties: { house: houseSchema, kind: kindSchema,
    params: { type: 'object', additionalProperties: true }, expected_capability_revision: digestSchema },
    required: ['house', 'kind', 'params', 'expected_capability_revision'], additionalProperties: false },
  action_status: { type: 'object', properties: { house: houseSchema, request_id: digestSchema }, required: ['house', 'request_id'], additionalProperties: false },
});
type WorldInputs = { capabilities: WorldCapabilitiesInput; private_messages: WorldPrivateMessagesInput; invoke: WorldInvokeInput; action_status: WorldActionStatusInput };
export type WorldCommandName = keyof WorldInputs;
const ajv = new Ajv({ strict: false });
const validators = Object.fromEntries(Object.entries(WORLD_COMMAND_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]));

/** Reject non-JSON values before stringify can silently drop/coerce them. */
function snapshot(value: unknown): Record<string, unknown> {
  let nodes = 0;
  function check(item: unknown, depth: number): void {
    if (++nodes > 65536 || depth > 10) throw new Error('WORLD_COMMAND_JSON_LIMIT');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isSafeInteger(item)) return;
    if (!item || typeof item !== 'object' || Object.getOwnPropertySymbols(item).length) throw new Error('WORLD_COMMAND_JSON_INVALID');
    if (Array.isArray(item)) {
      const entries = Object.entries(Object.getOwnPropertyDescriptors(item)).filter(([key]) => key !== 'length');
      if (entries.length !== item.length) throw new Error('WORLD_COMMAND_JSON_INVALID');
      for (const [key, descriptor] of entries) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length || !descriptor.enumerable || !('value' in descriptor)) throw new Error('WORLD_COMMAND_JSON_INVALID');
        check(descriptor.value, depth + 1);
      }
      return;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('WORLD_COMMAND_JSON_INVALID');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('WORLD_COMMAND_JSON_INVALID');
      check(descriptor.value, depth + 1);
    }
  }
  check(value, 1);
  return jsonObject(parseWorldJson(new TextEncoder().encode(JSON.stringify(value)), 65536, 10));
}
export function captureWorldCommandInput<K extends WorldCommandName>(name: K, value: unknown): WorldInputs[K] {
  const input = snapshot(value);
  if (!validators[name]!(input)) throw new Error('WORLD_COMMAND_INPUT_INVALID');
  const origin = new URL(input.house as string);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== input.house || origin.username || origin.password) throw new Error('HOUSE_ORIGIN_INVALID');
  if (name === 'private_messages' && typeof input.cursor === 'string' && new TextEncoder().encode(input.cursor).length > 4096) throw new Error('WORLD_COMMAND_INPUT_INVALID');
  if (name === 'invoke') jsonObject(parseWorldJson(new TextEncoder().encode(JSON.stringify(input.params)), WORLD_PROTOCOL_LIMITS.L_PARAMS_MAX_BYTES));
  return input as unknown as WorldInputs[K];
}
function plainObject(value: object): Record<string, unknown> { return JSON.parse(JSON.stringify(value)) as Record<string, unknown>; }

export async function runWorldCapabilitiesCommand(ctx: WorldCommandContext, value: unknown): Promise<Record<string, unknown>> {
  const finish = (body: Record<string, unknown>): Record<string, unknown> => {
    const result = plainObject(body);
    if (result.agent_context) result.agent_context = boundWorldAgentContext(result.agent_context as WorldAgentContextResult,
      material => JSON.stringify({...result, agent_context: material}));
    if (worldContextTextCost(JSON.stringify(result)) > 14000) throw new Error('WORLD_CONTEXT_SIZE_LIMIT');
    return result;
  };
  const input = captureWorldCommandInput('capabilities', value);
  const caps = await ctx.readCapabilities(input.house);
  const publicReception = await ctx.readPublicStatus?.(input.house);
  if (!caps) return finish({ house: { origin: input.house }, capability_revision: null, context_complete: false, guide_bound: false,
    code: 'CAPABILITY_CONTEXT_INCOMPLETE', intent_kinds: [], event_kinds: [], initial_public_scopes: [],
    ...(publicReception ? { public_reception: plainObject(publicReception) } : {}), limits: plainObject(WORLD_PROTOCOL_LIMITS) });
  const agentContext = await ctx.readAgentContext?.({...input, expected_capability_revision: input.expected_capability_revision ?? caps.verified.capabilityRevision});
  const verified = caps.verified;
  if (verified.house.origin !== input.house) throw new Error('CAPABILITY_CONTEXT_INCOMPLETE');
  const header = {house: {origin: verified.house.origin, house_key: verified.house.houseKey, incarnation: verified.house.incarnation},
    capability_revision: verified.capabilityRevision, context_complete: false, guide_bound: caps.guide.validation === 'valid', code: 'WORLD_LOCAL_UNSUPPORTED'};
  // New material selectors are narrow read views, not a repeated whole catalog.
  if (input.kind !== undefined || input.event_kind !== undefined || input.guide_offset !== undefined || input.schema !== undefined) {
    return finish({...header, view: 'agent_context',
      ...(agentContext ? {agent_context: agentContext} : {}),
      ...(input.kind ? {selected_action: caps.actions.kinds[input.kind] ?? null} : {}),
      ...(input.event_kind !== undefined ? {selected_event: caps.privateMessages.kinds[input.event_kind] ?? null} : {})});
  }
  const result = plainObject({ house: { origin: verified.house.origin, house_key: verified.house.houseKey, incarnation: verified.house.incarnation },
    ...(agentContext ? {agent_context: agentContext} : {}),
    capability_revision: verified.capabilityRevision, context_complete: false, guide_bound: caps.guide.validation === 'valid', code: 'WORLD_LOCAL_UNSUPPORTED',
    blocks: { public_stream: publicReception?.mode === 'public-v1'
      ? { ...caps.publicStream, support: publicReception.support, ready: publicReception.transport === 'active' && publicReception.receive?.caughtUp === true }
      : caps.publicStream, actions: caps.actions, private_messages: caps.privateMessages, execution_closure: caps.executionClosure, guide: caps.guide },
    ...(publicReception ? { public_reception: publicReception } : {}),
    intent_kinds: Object.keys(caps.actions.kinds), event_kinds: Object.keys(caps.privateMessages.kinds),
    initial_public_scopes: caps.publicStreamCapability?.publicStream.initial_public_scopes ?? [], limits: WORLD_PROTOCOL_LIMITS });
  const deferredContext = {status: 'unavailable', code: 'WORLD_CONTEXT_READ_REQUIRED', read: {
    tool: 'popclaw_world_capabilities', arguments: {house: input.house, guide_offset: 0,
      expected_capability_revision: verified.capabilityRevision,
      ...(agentContext && 'session_id' in agentContext ? {expected_session_id: agentContext.session_id} : {})}}};
  // Preserve the original house-only catalog. When adding material would overflow
  // the smallest supported live-result tier, defer ONLY that addition to a narrow
  // same-context read. Never truncate a schema or pretend the omitted text arrived.
  if (worldContextTextCost(JSON.stringify(result)) > 14000 && agentContext?.status === 'available') {
    result.agent_context = deferredContext;
  }
  if (worldContextTextCost(JSON.stringify(result)) <= 14000) return finish(result);
  // An oversized pre-existing catalog is an explicit limit, not a silently cut
  // success. The optional kind/page read remains available without that catalog.
  return finish({...header, code: 'CAPABILITY_SUMMARY_TOO_LARGE', intent_kinds: Object.keys(caps.actions.kinds),
    event_kinds: Object.keys(caps.privateMessages.kinds), agent_context: deferredContext});

}

/** The runtime owns authenticated projection; this boundary also caps its complete host-visible JSON. */
export async function runWorldPrivateMessagesCommand(ctx: WorldCommandContext, value: unknown): Promise<Record<string, unknown>> {
  const input = captureWorldCommandInput('private_messages', value);
  if (!ctx.readPrivateMessages) return { status: 'unavailable', code: 'WORLD_LOCAL_UNSUPPORTED' };
  const text = JSON.stringify(await ctx.readPrivateMessages(input));
  if (typeof text !== 'string') throw new Error('WORLD_PRIVATE_MESSAGES_RESULT_INVALID');
  if (new TextEncoder().encode(text).length > 16384) return { status: 'unavailable', code: 'SIZE_LIMIT' };
  return jsonObject(JSON.parse(text));
}

export async function runWorldInvokeCommand(ctx: WorldCommandContext, value: unknown): Promise<Record<string, unknown>> {
  const input = captureWorldCommandInput('invoke', value);
  const caps = await ctx.readCapabilities(input.house);
  const kind = caps?.actions.kinds[input.kind];
  if (!kind || kind.validation !== 'valid' || kind.support !== 'supported' || !kind.ready) throw new Error('WORLD_LOCAL_UNSUPPORTED');
  if (!ctx.actionAuthority) throw new Error('ACTION_AUTHORITY_REQUIRED');
  const authority = await ctx.actionAuthority(freeze(captureWorldCommandInput('invoke', input)));
  if (!authority || typeof authority.check !== 'function' || typeof authority.record !== 'function') throw new Error('ACTION_AUTHORITY_REQUIRED');
  const client = await ctx.client(input.house);
  const result = await client.invoke(input, authority);
  return worldActionViewJson(result);
}

export async function runWorldActionStatusCommand(ctx: WorldCommandContext, value: unknown): Promise<Record<string, unknown>> {
  const input = captureWorldCommandInput('action_status', value);
  const result = await (await ctx.client(input.house)).status(input.request_id);
  return worldActionViewJson(result);
}
