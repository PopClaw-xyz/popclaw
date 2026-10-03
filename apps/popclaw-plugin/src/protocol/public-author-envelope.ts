/**
 * Author DTO boundary for the immutable public wire schema. This is deliberately
 * not a protobuf fromObject conversion: unknown fields and coercions must fail
 * before an encoder can silently discard them. Callers supply plain message
 * records, not decoded protobuf instances. Bytes and 64-bit Long values are
 * copied as scalar data; no caller-owned object reaches an async signing step.
 */
import descriptor from '../../../../protocol/packages/contracts/ts/contracts/src/generated/descriptor.js';

interface Field { type: string; rule?: string; keyType?: string }
interface Schema {
  nested?: Record<string, Schema>;
  fields?: Record<string, Field>;
  oneofs?: Record<string, { oneof: string[] }>;
  values?: Record<string, number>;
}
interface MessageType { name: string; schema: Schema }
const types = new Map<string, Schema>();
function indexSchema(node: Schema, name: string): void {
  types.set(name, node);
  for (const [key, child] of Object.entries(node.nested ?? {})) {
    indexSchema(child, name ? `${name}.${key}` : key);
  }
}
indexSchema(descriptor as Schema, '');
const ENVELOPE = 'popclaw.event.EventEnvelope';
const MAX_DEPTH = 64;
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

function reject(path: string, reason: string): never {
  throw new Error(`PUBLIC_AUTHOR_INVALID ${path}: ${reason}`);
}
function resolveType(name: string, containing: string): MessageType | undefined {
  if (name.startsWith('.')) {
    const schema = types.get(name.slice(1));
    return schema ? { name: name.slice(1), schema } : undefined;
  }
  let scope = containing;
  for (;;) {
    const full = scope ? `${scope}.${name}` : name;
    const schema = types.get(full);
    if (schema) return { name: full, schema };
    if (!scope) return undefined;
    scope = scope.includes('.') ? scope.slice(0, scope.lastIndexOf('.')) : '';
  }
}

/** Own data descriptors only: accessors are never evaluated. */
function dataProperties(value: object, path: string): Record<string, PropertyDescriptor> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') reject(path, 'symbol property');
    const property = descriptors[key]!;
    if (!own(property, 'value')) reject(`${path}.${key}`, 'accessor property');
  }
  return descriptors;
}
function plain(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(path, 'expected plain message/map');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) reject(path, 'non-plain message/map prototype');
}

/**
 * Long is accepted only at a 64-bit scalar position. Its prototype/methods are
 * never trusted or copied. Decimal strings are converted losslessly, while
 * unsafe numbers and bigint (unsupported by the pinned encoder) are rejected.
 */
function int64(value: unknown, signed: boolean, path: string): unknown {
  const lower = signed ? -(1n << 63n) : 0n;
  const upper = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
  let integer: bigint;
  let hasLongMethod = false;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) reject(path, 'expected safe 64-bit integer number');
    integer = BigInt(value);
    if (integer < lower || integer > upper) reject(path, '64-bit range');
    return value;
  }
  if (typeof value === 'string') {
    if (!/^-?(0|[1-9][0-9]*)$/.test(value) || value === '-0' || value.length > 21) reject(path, 'expected decimal 64-bit integer');
    integer = BigInt(value);
    if (integer < lower || integer > upper) reject(path, '64-bit range');
    // Preserve the canonicalizer's representation-sensitive zero rules.
    return value;
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = dataProperties(value, path);
    for (const key of Object.keys(properties)) {
      if (!['low', 'high', 'unsigned'].includes(key)) reject(`${path}.${key}`, 'unknown Long field');
      if (!properties[key]!.enumerable) reject(`${path}.${key}`, 'non-enumerable Long field');
    }
    const low = properties.low?.value as unknown;
    const high = properties.high?.value as unknown;
    const unsigned = properties.unsigned?.value as unknown;
    if (typeof low !== 'number' || !Number.isInteger(low) || low < -2147483648 || low > 2147483647 ||
        typeof high !== 'number' || !Number.isInteger(high) || high < -2147483648 || high > 2147483647 ||
        (unsigned !== undefined && typeof unsigned !== 'boolean')) reject(path, 'invalid Long words');
    const bits = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
    integer = unsigned === true ? bits : BigInt.asIntN(64, bits);
    let prototype = Object.getPrototypeOf(value);
    for (let depth = 0; prototype !== null; depth++) {
      if (depth > MAX_DEPTH) reject(path, 'Long prototype depth');
      const method = Object.getOwnPropertyDescriptor(prototype, 'toNumber');
      if (method) {
        if (!own(method, 'value')) reject(path, 'Long method accessor');
        hasLongMethod = typeof method.value === 'function';
        break;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  } else {
    reject(path, 'expected integer number, decimal string or Long words');
  }
  if (integer < lower || integer > upper) reject(path, '64-bit range');
  const bits = BigInt.asUintN(64, integer);
  // Preserve whether the author used Long or plain words: IntentContext has
  // representation-sensitive zero rules. If needed, supply only our own method.
  return Object.freeze({
    low: Number(BigInt.asIntN(32, bits)), high: Number(BigInt.asIntN(32, bits >> 32n)),
    unsigned: !signed, ...(hasLongMethod ? { toNumber: () => Number(integer) } : {}),
  });
}

/** Validate and detach all author data, without normalizing canonical presence. */
export function snapshotPublicAuthorEnvelope(envelope: unknown): Record<string, unknown> {
  const ancestors = new Set<object>();
  function enter(value: object, path: string, depth: number): void {
    if (depth > MAX_DEPTH) reject(path, 'maximum depth');
    if (ancestors.has(value)) reject(path, 'cyclic data');
    ancestors.add(value);
  }
  function scalar(value: unknown, field: Field, containing: string, path: string, depth: number): unknown {
    const resolved = resolveType(field.type, containing);
    if (resolved?.schema.fields) return message(value, resolved, path, depth);
    if (resolved?.schema.values) {
      // Proto3 enums remain open integers; unknown enum values are not silently
      // converted to zero and business admission remains with its existing gate.
      if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) reject(path, 'expected int32 enum');
      return value;
    }
    switch (field.type) {
      case 'string':
        if (typeof value !== 'string') reject(path, 'expected string');
        return value;
      case 'bool':
        if (typeof value !== 'boolean') reject(path, 'expected boolean');
        return value;
      case 'bytes': {
        if (!(value instanceof Uint8Array)) reject(path, 'expected Uint8Array bytes');
        // Proxies can pass instanceof without a typed-array internal slot.
        // Check the intrinsic brand before construction could call an iterator.
        const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
        let length: number;
        try { length = byteLength.call(value) as number; } catch { reject(path, 'expected genuine typed-array bytes'); }
        // A genuine Uint8Array owns exactly one non-removable indexed property
        // per byte. Count names instead of materializing a descriptor per byte
        // (DM attachments can be a megabyte); any extra name/symbol is invalid.
        if (Object.getOwnPropertyNames(value).length !== length || Object.getOwnPropertySymbols(value).length) reject(path, 'unknown bytes field');
        // Typed-array construction copies genuine bytes without invoking author
        // iterators or retaining Buffer views into caller-owned storage.
        return new Uint8Array(value);
      }
      case 'int64': case 'sint64': case 'sfixed64': return int64(value, true, path);
      case 'uint64': case 'fixed64': return int64(value, false, path);
      case 'int32': case 'sint32': case 'sfixed32':
      case 'uint32': case 'fixed32': {
        const signed = !['uint32', 'fixed32'].includes(field.type);
        if (typeof value !== 'number' || !Number.isInteger(value) ||
            value < (signed ? -2147483648 : 0) || value > (signed ? 2147483647 : 4294967295)) reject(path, '32-bit range');
        return value;
      }
      case 'double': case 'float':
        if (typeof value !== 'number' || !Number.isFinite(value) ||
            (field.type === 'float' && !Number.isFinite(Math.fround(value)))) reject(path, 'expected finite float');
        return value;
      default: return reject(path, `unsupported descriptor scalar ${field.type}`);
    }
  }
  function fieldValue(value: unknown, field: Field, containing: string, path: string, depth: number): unknown {
    if (field.keyType !== undefined) {
      plain(value, path);
      enter(value, path, depth);
      try {
        const result: Record<string, unknown> = Object.create(null);
        const properties = dataProperties(value, path);
        for (const [key, property] of Object.entries(properties)) {
          if (!property.enumerable) reject(`${path}.${key}`, 'non-enumerable map entry');
          // Keys are user data, not nested message field names. The pinned
          // envelope descriptor contains only string-keyed maps; fail closed
          // if a different map-key contract is introduced in a later baseline.
          if (field.keyType !== 'string') reject(path, 'unsupported descriptor map key');
          result[key] = scalar(property.value, field, containing, `${path}[${JSON.stringify(key)}]`, depth + 1);
        }
        return Object.freeze(result);
      } finally { ancestors.delete(value); }
    }
    if (field.rule === 'repeated') {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) reject(path, 'expected plain array');
      enter(value, path, depth);
      try {
        const properties = dataProperties(value, path);
        const length = properties.length!.value as number;
        for (const key of Object.keys(properties)) {
          if (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) reject(`${path}.${key}`, 'unknown array field');
        }
        const result: unknown[] = [];
        for (let i = 0; i < length; i++) {
          const property = properties[String(i)];
          if (!property?.enumerable) reject(`${path}[${i}]`, 'sparse or hidden array element');
          result.push(scalar(property.value, field, containing, `${path}[${i}]`, depth + 1));
        }
        return Object.freeze(result);
      } finally { ancestors.delete(value); }
    }
    return scalar(value, field, containing, path, depth);
  }
  function message(value: unknown, type: MessageType, path: string, depth: number): Record<string, unknown> {
    plain(value, path);
    enter(value, path, depth);
    try {
      const result: Record<string, unknown> = Object.create(null);
      const properties = dataProperties(value, path);
      const fields = type.schema.fields!;
      for (const [key, property] of Object.entries(properties)) {
        if (!own(fields, key)) reject(`${path}.${key}`, 'unknown field');
        if (!property.enumerable) reject(`${path}.${key}`, 'non-enumerable field');
        // Optional absent known fields keep their protobuf omission semantics.
        // Unknown fields were already rejected, including null/undefined ones.
        if (property.value === null || property.value === undefined) continue;
        result[key] = fieldValue(property.value, fields[key]!, type.name, `${path}.${key}`, depth + 1);
      }
      for (const [name, oneof] of Object.entries(type.schema.oneofs ?? {})) {
        const selected = oneof.oneof.filter(field => own(result, field));
        if (selected.length > 1) reject(path, `multiple oneof ${name}`);
      }
      return Object.freeze(result);
    } finally { ancestors.delete(value); }
  }
  return message(envelope, { name: ENVELOPE, schema: types.get(ENVELOPE)! }, 'envelope', 0);
}
