/** Bounded UTF-8 JSON with duplicate-key rejection before schema validation. */
export function parseWorldJson(bytes: Uint8Array, maxBytes: number, maxDepth = 8, onValue?: (path: string[], raw: string) => void): unknown {
  if (bytes.length > maxBytes) throw new Error('JSON_SIZE_LIMIT');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) throw new Error('JSON_BOM_REJECTED');
  let offset = 0;
  const whitespace = () => { while (offset < text.length && ' \t\r\n'.includes(text[offset]!)) offset++; };
  function string(): string {
    if (text[offset] !== '"') throw new Error('JSON_STRING_REQUIRED');
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '\\') { offset++; continue; }
      if (char === '"') {
        const decoded: string = JSON.parse(text.slice(start, offset));
        for (const point of decoded) {
          const code = point.codePointAt(0)!;
          if (code >= 0xd800 && code <= 0xdfff) throw new Error('JSON_SURROGATE_INVALID');
        }
        return decoded;
      }
    }
    throw new Error('JSON_STRING_UNTERMINATED');
  }
  function value(depth: number, path: string[] = []): unknown {
    whitespace();
    const start = offset;
    const result = readValue(depth, path);
    onValue?.(path, text.slice(start, offset));
    return result;
  }
  function readValue(depth: number, path: string[]): unknown {
    if (depth > maxDepth) throw new Error('JSON_DEPTH_LIMIT');
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === '{') {
      offset++; whitespace();
      const result: Record<string, unknown> = Object.create(null);
      if (text[offset] === '}') { offset++; return result; }
      while (true) {
        whitespace(); const key = string();
        if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(result, key)) throw new Error('JSON_DUPLICATE_OR_DANGEROUS_KEY');
        whitespace(); if (text[offset++] !== ':') throw new Error('JSON_COLON_REQUIRED');
        result[key] = value(depth + 1, [...path, key]); whitespace();
        const next = text[offset++];
        if (next === '}') return result;
        if (next !== ',') throw new Error('JSON_OBJECT_INVALID');
      }
    }
    if (char === '[') {
      offset++; whitespace(); const result: unknown[] = [];
      if (text[offset] === ']') { offset++; return result; }
      while (true) {
        result.push(value(depth + 1, [...path, String(result.length)])); whitespace();
        const next = text[offset++];
        if (next === ']') return result;
        if (next !== ',') throw new Error('JSON_ARRAY_INVALID');
      }
    }
    for (const [word, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, offset)) { offset += word.length; return result; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(offset));
    if (!number) throw new Error('JSON_VALUE_INVALID');
    offset += number[0].length;
    const result = Number(number[0]);
    if (!Number.isSafeInteger(result)) throw new Error('JSON_INTEGER_REQUIRED');
    return result;
  }
  const result = value(1); whitespace();
  if (offset !== text.length) throw new Error('JSON_TRAILING_CONTENT');
  return result;
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

/** The top-level declaration arrays a `world_interaction` board can select
 * from: `actions.kinds` selects `intent_kinds`, `private_messages.kinds`
 * selects `event_kinds`. */
export type SelectableProperty = 'intent_kinds' | 'event_kinds';
const SELECTABLE_PROPERTIES: readonly SelectableProperty[] = ['intent_kinds', 'event_kinds'];
/** The member names the public action-kind and interpreted-event-kind schemas
 * define for a selected row's embedded schema. There is no `schema` alias: a
 * row carrying its payload under another name is an invalid selected row, never
 * a row to be renamed into shape before validation. */
export const SELECTED_SCHEMA_MEMBERS: Readonly<Record<SelectableProperty, readonly string[]>> = Object.freeze({
  intent_kinds: Object.freeze(['params_schema', 'result_schema']),
  event_kinds: Object.freeze(['body_schema']),
});

/** Bounded RAW parse of the whole manifest, and nothing else: total bytes, raw
 * depth, strict UTF-8 and duplicate-key rejection. The business profile is NOT
 * applied here, because at this layer nothing is known about which declarations
 * the `world_interaction` board selects — and an unselected row is outside that
 * jurisdiction, neither converted, interpreted, nor counted against any quota.
 * A manifest with no board, or with rows this contract does not interpret, is an
 * ordinary House and parses.
 *
 * `schemaSizes` only RECORDS each declared schema member's original byte length,
 * insignificant whitespace included, keyed `<property>/<index>/<member>`. The
 * recording is inert; the bound is enforced by `selectDeclaredRow`, against the
 * rows a board actually selects. Pass the same map to both. */
export function parseWorldManifest(bytes: Uint8Array, schemaSizes?: Map<string, number>): Record<string, unknown> {
  return jsonObject(parseWorldJson(bytes, 262144, 64, (path, raw) => {
    if (schemaSizes && path.length === 3 && SELECTABLE_PROPERTIES.includes(path[0] as SelectableProperty)
      && SELECTED_SCHEMA_MEMBERS[path[0] as SelectableProperty].includes(path[2]!))
      schemaSizes.set(path.join('/'), new TextEncoder().encode(raw).length);
  }));
}

export interface SelectedDeclaration {
  readonly property: SelectableProperty;
  readonly kind: string;
  readonly index: number;
  readonly row: Record<string, unknown>;
}

/** Select first, then profile — the layering the manifest jurisdiction rule
 * asks for, in one place so every caller applies the same selection relation.
 *
 * The one row a board selection names is resolved by `.kind` equality over the
 * already raw-parsed document; only that row then pays the business profile:
 * depth eight over its own members, and the 32,768-byte bound on each declared
 * schema member's ORIGINAL bytes as recorded by `parseWorldManifest`. Rows the
 * board does not select are never reached here, so they neither pay nor escape
 * a quota, and they confer no exemption on a selected row.
 *
 * Returns null when the selection is not unique, so each caller keeps its own
 * refusal vocabulary. The codes it throws describe THIS row only; callers
 * degrade them to the row, its capability and its dependents rather than to the
 * manifest, whose raw format, identity and proof were settled before this. */
export function selectDeclaredRow(document: Record<string, unknown>, property: SelectableProperty, kind: string,
  schemaSizes: ReadonlyMap<string, number>): SelectedDeclaration | null {
  const entries = Array.isArray(document[property]) ? document[property] as unknown[] : [];
  const matches = entries.map((row, index) => ({ row, index })).filter(({ row }) =>
    !!row && typeof row === 'object' && !Array.isArray(row) && (row as Record<string, unknown>).kind === kind);
  if (matches.length !== 1) return null;
  const { row: value, index } = matches[0]!;
  const row = jsonObject(value);
  const members = SELECTED_SCHEMA_MEMBERS[property];
  // Depth is counted from the manifest root — document 1, the array 2, the row
  // 3 — so a selected row's budget is exactly what it always was. An embedded
  // schema keeps its own budget and is checked by the profile validator.
  function walk(nested: unknown, depth: number, top: boolean): void {
    if (depth > 8) throw new Error('JSON_DEPTH_LIMIT');
    if (!nested || typeof nested !== 'object') return;
    for (const [key, child] of Object.entries(nested)) {
      if (top && members.includes(key)) continue;
      walk(child, depth + 1, false);
    }
  }
  walk(row, 3, true);
  // A member the row does not declare is the validator's business, not a size
  // failure; an unmeasured one that IS declared cannot be admitted unmeasured.
  for (const member of members)
    if (row[member] !== undefined && (schemaSizes.get(`${property}/${index}/${member}`) ?? Infinity) > 32768) throw new Error('SCHEMA_SIZE_LIMIT');
  return { property, kind, index, row };
}

/** Supplement the profile meta-schema with its explicit ref/regex grammar. */
export function validateProfileGrammar(schema: Record<string, unknown>): void {
  function visit(node: Record<string, unknown>, depth: number): void {
    if (depth > 16) throw new Error('SCHEMA_DEPTH_LIMIT');
    if (typeof node.pattern === 'string') {
      validateSharedPattern(node.pattern);
      try { new RegExp(node.pattern, 'u'); } catch { throw new Error('SCHEMA_PATTERN_INVALID'); }
    }
    if (typeof node.$ref === 'string') {
      if (!/^#\/\$defs\/[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(node.$ref)) throw new Error('SCHEMA_REF_UNSUPPORTED');
      let target: unknown = schema;
      for (const part of node.$ref.slice(2).split('/')) target = jsonObject(target)[part];
      jsonObject(target);
    }
    for (const group of ['properties', '$defs']) {
      if (node[group] !== undefined) for (const child of Object.values(jsonObject(node[group]))) visit(jsonObject(child), depth + 1);
    }
    if (node.items !== undefined) visit(jsonObject(node.items), depth + 1);
    for (const group of ['allOf', 'anyOf', 'oneOf']) {
      if (node[group] !== undefined) for (const child of node[group] as unknown[]) visit(jsonObject(child), depth + 1);
    }
  }
  visit(schema, 0);
  const done = new Set<Record<string, unknown>>();
  function acyclic(node: Record<string, unknown>, active: Set<Record<string, unknown>>): void {
    if (active.has(node)) throw new Error('SCHEMA_NONCONSUMING_CYCLE');
    if (done.has(node)) return;
    active.add(node);
    if (typeof node.$ref === 'string') acyclic(jsonObject(jsonObject(schema.$defs)[node.$ref.slice(8)]), active);
    for (const key of ['allOf', 'anyOf', 'oneOf']) for (const child of (node[key] ?? []) as unknown[]) acyclic(jsonObject(child), active);
    active.delete(node); done.add(node);
    for (const key of ['properties', '$defs']) for (const child of Object.values((node[key] ?? {}) as object)) acyclic(jsonObject(child), new Set());
    if (node.items !== undefined) acyclic(jsonObject(node.items), new Set());
  }
  acyclic(schema, new Set());
}

function validateSharedPattern(pattern: string): void {
  if (/(\(\?[^:]|\\[0-9AbBzZRUpP]|\\k[<']|&&|--|~~)/.test(pattern)) throw new Error('SCHEMA_PATTERN_UNSUPPORTED');
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      const escaped = pattern[++i];
      if (!escaped || !'dDwWsStnrfvux\\^$.*+?()[]{}|/-'.includes(escaped) || (escaped === '-' && !inClass)) throw new Error('SCHEMA_PATTERN_UNSUPPORTED');
      if (escaped === 'x' || escaped === 'u') {
        const hex = (escaped === 'x' ? /^[0-9a-fA-F]{2}/ : /^(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/).exec(pattern.slice(i + 1));
        if (!hex) throw new Error('SCHEMA_PATTERN_UNSUPPORTED');
        i += hex[0].length;
        const scalar = parseInt(hex[0].replace(/[{}]/g, ''), 16);
        if (scalar > 0x10ffff) throw new Error('SCHEMA_PATTERN_UNSUPPORTED');
        if (scalar >= 0xd800 && scalar <= 0xdfff) {
          const low = /^\\u([0-9a-fA-F]{4})/.exec(pattern.slice(i + 1));
          if (hex[0].startsWith('{') || scalar > 0xdbff || !low || parseInt(low[1]!, 16) < 0xdc00 || parseInt(low[1]!, 16) > 0xdfff) throw new Error('SCHEMA_PATTERN_UNSUPPORTED');
          i += low[0].length;
        }
      }
      continue;
    }
    if (char === '[') { if (inClass || /^\[\^?\]/.test(pattern.slice(i))) throw new Error('SCHEMA_PATTERN_UNSUPPORTED'); inClass = true; }
    else if (char === ']') { if (!inClass) throw new Error('SCHEMA_PATTERN_UNSUPPORTED'); inClass = false; }
    else if (!inClass && char === '{') {
      const quantifier = /^\{[0-9]+(?:,[0-9]*)?\}/.exec(pattern.slice(i));
      if (!quantifier) throw new Error('SCHEMA_PATTERN_UNSUPPORTED');
      i += quantifier[0].length - 1;
    } else if (!inClass && char === '}') throw new Error('SCHEMA_PATTERN_UNSUPPORTED');
  }
  if (inClass) throw new Error('SCHEMA_PATTERN_UNSUPPORTED');
}

export async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('RESPONSE_SIZE_LIMIT');
      chunks.push(new Uint8Array(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
