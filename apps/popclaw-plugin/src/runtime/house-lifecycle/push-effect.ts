/** Durable references locate original authority; they never grant it. */
import type { PushExecutionContext } from './command-bus.js';

export type WorldExecutionReference =
  | Readonly<{kind: 'owner_action'; reservationId: string}>
  | Readonly<{kind: 'native_policy'; reservationId: string}>
  | Readonly<{kind: 'read_state'; reservationId: string; participationId: string}>
  | Readonly<{kind: 'participation'; reservationId: string; participationId: string; jobId: string}>;
export type HousePushEffectReference =
  | Readonly<{version: 1; kind: 'world_direct_dm'; requestId: string; participationId: string; reservationId: string; jobId: string}>
  | Readonly<{version: 1; kind: 'world_intent'; requestId: string; executionReference: WorldExecutionReference}>;
export type HousePushEffectResolver = (input: Readonly<{
  origin: string; bytes: Uint8Array; ref: HousePushEffectReference; context: PushExecutionContext;
}>) => (() => void) | Promise<() => void>;

const MAX_REFERENCE_BYTES = 32_768;
function invalid(): never { throw new Error('HOUSE_PUSH_EFFECT_INVALID'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid();
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!property.enumerable || !Object.hasOwn(property, 'value')) invalid();
    result[key] = property.value;
  }
  return result;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid();
  // JSON must round-trip exact Unicode, including after the SQLite boundary.
  for (let i=0; i<value.length; i++) {
    const code=value.charCodeAt(i);
    if (code<=0x1f || code===0x7f) invalid();
    if (code>=0xd800 && code<=0xdbff) {
      const next=value.charCodeAt(++i); if (!(next>=0xdc00 && next<=0xdfff)) invalid();
    } else if (code>=0xdc00 && code<=0xdfff) invalid();
  }
  return value;
}
function execution(value: unknown): WorldExecutionReference {
  const input=record(value);
  const reservationId=text(input.reservationId,8192);
  switch (input.kind) {
    case 'native_policy':
      exact(input,['kind','reservationId']);
      if (!/^[a-f0-9]{64}$/.test(reservationId)) invalid();
      return Object.freeze({kind:input.kind,reservationId});
    case 'owner_action':
      exact(input,['kind','reservationId']); return Object.freeze({kind:input.kind,reservationId});
    case 'read_state':
      exact(input,['kind','reservationId','participationId']);
      return Object.freeze({kind:input.kind,reservationId,participationId:text(input.participationId)});
    case 'participation':
      exact(input,['kind','reservationId','participationId','jobId']);
      return Object.freeze({kind:input.kind,reservationId,participationId:text(input.participationId),jobId:text(input.jobId)});
    default: return invalid();
  }
}
/** Snapshot without invoking accessors or toJSON. Canonical property order also
 * makes nested scopes comparable without dropping an enclosing constraint. */
export function captureHousePushEffect(value: unknown): HousePushEffectReference {
  const input=record(value);
  if (input.version !== 1 || typeof input.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(input.requestId)) invalid();
  let ref: HousePushEffectReference;
  if (input.kind === 'world_direct_dm') {
    exact(input,['version','kind','requestId','participationId','reservationId','jobId']);
    ref=Object.freeze({version:1,kind:input.kind,requestId:input.requestId,participationId:text(input.participationId),reservationId:text(input.reservationId,8192),jobId:text(input.jobId)});
  } else if (input.kind === 'world_intent') {
    exact(input,['version','kind','requestId','executionReference']);
    ref=Object.freeze({version:1,kind:input.kind,requestId:input.requestId,executionReference:execution(input.executionReference)});
  } else return invalid();
  if (new TextEncoder().encode(JSON.stringify(ref)).byteLength > MAX_REFERENCE_BYTES) invalid();
  return ref;
}
export function parseHousePushEffect(value: string): HousePushEffectReference {
  if (typeof value !== 'string' || value.length > MAX_REFERENCE_BYTES) invalid();
  const ref=captureHousePushEffect(JSON.parse(value));
  // The writer always persists this exact serialization. Reject damaged or
  // ambiguous durable rows, including duplicate JSON keys.
  if (JSON.stringify(ref) !== value) invalid();
  return ref;
}
