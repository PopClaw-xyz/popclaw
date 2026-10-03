import descriptor from '@popclaw/contracts/descriptor';

interface Field { type: string; rule?: string }
interface Message { fields?: Record<string, Field>; values?: Record<string, number> }
const messages: Record<string, Message> = descriptor.nested.popclaw.nested.world.nested;
const snake = (key: string) => key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());

function integer(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('WORLD_JSON_UNSAFE_INTEGER');
  const text = String(value);
  if (!/^(0|-?[1-9][0-9]*)$/.test(text)) throw new Error('WORLD_JSON_INTEGER_INVALID');
  return text;
}
function timestamp(value: unknown): string {
  const seconds = BigInt(integer(value));
  if (seconds < -62167219200n || seconds > 253402300799n) throw new Error('WORLD_JSON_TIME_INVALID');
  return new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');
}

/** Render authenticated protobuf facts at the tool boundary. Field types come
 * from the generated shared contract, including nested attachments; bytes stay
 * base64 and never become prose instructions. No authority is created here. */
export function worldActionJson(typeName: 'ActionResult' | 'SubscriptionObservation', value: object): Record<string, unknown> {
  function convert(name: string, input: object, depth: number): Record<string, unknown> {
    const fields = messages[name]?.fields;
    if (!fields || !input || typeof input !== 'object' || Array.isArray(input) || depth > 32) throw new Error('WORLD_JSON_MESSAGE_INVALID');
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) throw new Error('WORLD_JSON_UNKNOWN_FIELD');
    for (const [key, field] of Object.entries(fields)) {
      let raw = (input as Record<string, unknown>)[key];
      if (raw === undefined || raw === null) {
        if (field.rule === 'repeated') raw = [];
        else if (messages[field.type]?.fields) continue;
        else if (field.type === 'string') raw = '';
        else if (field.type === 'bytes') raw = new Uint8Array();
        else if (field.type === 'bool') raw = false;
        else raw = 0;
      }
      if ((key === 'channels' && Array.isArray(raw) && raw.length === 0)
        || ((key === 'dmResponseSlotKey' || key === 'sourceEventId') && raw === '')) continue;
      const scalar = (item: unknown): unknown => {
        if (messages[field.type]?.fields) return convert(field.type, item as object, depth + 1);
        if (field.type === 'uint64') {
          const text = integer(item);
          if (!/^(0|[1-9][0-9]{0,19})$/.test(text) || BigInt(text) > 18446744073709551615n) throw new Error('WORLD_JSON_UINT64_INVALID');
          return text;
        }
        if (field.type === 'int64') return timestamp(item);
        if (field.type === 'bytes') {
          if (!(item instanceof Uint8Array)) throw new Error('WORLD_JSON_BYTES_INVALID');
          return Buffer.from(item).toString('base64');
        }
        if (field.type === 'uint32' || field.type === 'int32' || messages[field.type]?.values) {
          const min = field.type === 'uint32' ? 0 : -2147483648;
          const max = field.type === 'uint32' ? 4294967295 : 2147483647;
          if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < min || item > max) throw new Error('WORLD_JSON_COUNTER_INVALID');
          return item;
        }
        if (field.type === 'string' && typeof item === 'string') return item;
        if (field.type === 'bool' && typeof item === 'boolean') return item;
        throw new Error('WORLD_JSON_SCALAR_INVALID');
      };
      if (field.rule === 'repeated') {
        if (!Array.isArray(raw)) throw new Error('WORLD_JSON_REPEATED_INVALID');
        result[snake(key)] = raw.map(scalar);
      } else result[snake(key)] = scalar(raw);
    }
    // The frozen JSON participation schema groups the proto window fields.
    // Epoch zero and bounded budget counters retain their defined defaults.
    const inputFields = input as Record<string, unknown>;
    if (name === 'ParticipationDescriptor') {
      result.revision ??= '0';
      result.window = { id: inputFields.windowId ?? '', opens_at: timestamp(inputFields.windowOpensAt ?? 0),
        closes_at: timestamp(inputFields.windowClosesAt ?? 0) };
      delete result.window_id; delete result.window_opens_at; delete result.window_closes_at;
      result.action_groups ??= []; result.opportunities ??= []; result.budgets ??= [];
    }
    if (name === 'Budget') result.suggested_limit ??= 0;
    if (name === 'Opportunity') {
      result.not_before ??= timestamp(inputFields.notBefore ?? 0);
      result.expires_at ??= timestamp(inputFields.expiresAt ?? 0);
    }
    return result;
  }
  return convert(typeName, value, 0);
}

/** What an unresolved outcome means for the model that has to decide what to do
 * next. Every confirmation mints a fresh nonce and a fresh job, so calling
 * `popclaw_world_invoke` again is a second business action rather than an
 * idempotent retry of this one, and this release resends nothing across calls.
 * The only way to learn what became of THIS request is to query it by its id. */
export function unresolvedActionNextStep(requestId: string, code?: string): string {
  // `unknown` covers two different situations and they read differently: no
  // result has arrived, or a result arrived that this client cannot read. In
  // the second the house may well have acted, so "the outcome is unknown" would
  // understate it.
  const opening = code === 'ACTION_CONTEXT_UNSUPPORTED'
    ? `request ${requestId} has a result this client cannot read (${code}), so what the house did with it is not`
      + ' established here and may already have happened'
    : `the outcome of request ${requestId} is unknown`;
  return `${opening}; query this same request with popclaw_world_action_status`
    + ' (house plus this request_id) to find out what happened. Do not call popclaw_world_invoke again unless the owner'
    + ' means to create a NEW action: a second call is a second action that may duplicate this one, never a retry of it.';
}

/** Keep House outcome, durable evidence, accounting and installation separate. */
export function worldActionViewJson(view: import('./action-client.js').WorldActionView): Record<string, unknown> {
  return { request_id: view.request_id, status: view.status, code: view.code,
    ...(view.status === 'unknown' ? { next_step: unresolvedActionNextStep(view.request_id, view.code) } : {}),
    house_status: view.house_status ?? view.status, receipt_durable: view.receipt_durable ?? false,
    attachment_contract: view.attachment_contract ?? { outcome:'unsupported',reason:'NO_VERIFIED_RECEIPT' },
    base_accounting: view.base_accounting ?? { state:'blocked',reason:'NO_VERIFIED_RECEIPT',executionReference:null },
    attachments: view.attachments ?? [], installed_readiness:false,
    ...(view.result ? {result:worldActionJson('ActionResult',view.result)} : {}),
    ...(view.progress ? {progress:worldActionJson('SubscriptionObservation',view.progress)} : {}) };
}
