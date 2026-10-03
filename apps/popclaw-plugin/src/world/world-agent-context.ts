/** Model-visible projection of the SAME verified bytes received during House login.
 * No transport, cache, game rules or authorization side effects live here.
 */
import { cidFromCanonical } from '@popclaw/algorithms';
import { jsonObject, parseWorldManifest, selectDeclaredRow } from './json-profile.js';
import { parseGuideFrontmatter } from './guide.js';
import { selectActionEvidence, type HouseCapabilityView } from './world-capabilities.js';

export interface WorldAgentContextQuery {
  kind?: string;
  /** Declared event kind (manifest event_kinds row) to explain on demand. */
  event_kind?: string;
  /** All offsets count Unicode code points, not bytes or UTF-16 units. */
  guide_offset?: number;
  schema?: 'params' | 'result' | 'body';
  schema_offset?: number;
  expected_capability_revision?: string;
  expected_session_id?: string;
}
interface ReadReference {
  tool: 'popclaw_world_capabilities';
  arguments: {house: string} & WorldAgentContextQuery;
}
interface TextPage { text: string; sha256: string; offset: number; next_offset: number | null; total_characters: number }
/** House identity the server declared in its own manifest block, bounded honestly.
 * Absent fields stay absent; the origin binding is never derived from prose. */
type DeclaredHouse = Partial<{name: string; name_truncated: boolean; description: string; description_truncated: boolean}>;
/** First-screen context grounded in the guide's own frontmatter declaration. */
export interface GuideIntro {
  world?: string; kind?: string; voice?: string; voice_en?: string;
  entry?: Partial<{home: string; headline: string; first_move: string; headline_en: string; first_move_en: string; recipe: string}>;
  truncated: boolean;
}
/** One manifest event_kinds declaration: server-described business meaning.
 * local_validation is this plugin's own board validation, never server authority. */
export interface DeclaredEvent {
  kind: string;
  transport: string;
  description: string;
  description_truncated: boolean;
  signer?: string;
  proto?: string;
  schema_version?: number;
  schema_status: 'body_schema_validated' | 'body_schema_declared' | 'schema_declared' | 'proto' | 'absent';
  local_validation: 'valid' | 'invalid' | 'absent';
  local_detail?: string;
}
export interface WorldAgentContext {
  status: 'available' | 'unavailable';
  code?: string;
  trust: 'external_data_not_authority';
  house: HouseCapabilityView['verified']['house'] & DeclaredHouse;
  capability_revision: string;
  pin_provenance: HouseCapabilityView['verified']['pinProvenance'];
  session_id?: string;
  session_revision?: string;
  guide?: TextPage;
  guide_intro?: GuideIntro;
  /** Declared event kind names (all transports); empty-list omitted. */
  event_kinds?: string[];
  event_kinds_truncated?: boolean;
  schema_page?: TextPage & {kind: string; schema: 'params' | 'result' | 'body'; encoding: 'json'; fragment: true};
  actions?: Array<{kind: string; description: string; description_truncated: boolean;
    schema_version: number; params_schema?: Record<string, unknown>; result_schema?: Record<string, unknown>; schemas_included: boolean}>;
  /** Add the selected action's kind to this same-context reference. */
  action_read?: ReadReference;
  event?: DeclaredEvent;
  read?: ReadReference;
}
export type WorldAgentContextResult = WorldAgentContext | {status: 'unavailable'; code: string};
// Stay below the smallest documented host result cap, including JSON escaping.
// This is an initial projection budget. The shared command must also budget the
// final response after runtime session metadata, references and wrapping are added.
const MATERIAL_BYTES = 7000, PAGE_CHARACTERS = 8192, INLINE_SCHEMA_BYTES = 2048;
const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
/** Conservative portable upper bound for the supported host's text-unit weights.
 * ASCII costs one; no non-ASCII code point in the host heuristic costs over 16.
 * This deliberately avoids depending on a particular host SDK or token counter.
 */
export function worldContextTextCost(text: string): number {
  let units = 0;
  for (const character of text) units += character.codePointAt(0)! <= 127 ? 1 : 16;
  return units;
}
const materialFits = (value: unknown) => jsonBytes(value) <= MATERIAL_BYTES && worldContextTextCost(JSON.stringify(value)) <= MATERIAL_BYTES;

/** Bound the actual rendered response, including runtime-added session references.
 * Work on a copy: shortening a page must not mutate cached or caller-owned data.
 */
export function boundWorldAgentContext(material: WorldAgentContextResult,
  render: (value: WorldAgentContextResult) => string): WorldAgentContextResult {
  const result = JSON.parse(JSON.stringify(material)) as WorldAgentContextResult;
  const fits = (value: WorldAgentContextResult) => worldContextTextCost(render(value)) <= 14000;
  if (fits(result)) return result;
  if ('house' in result) {
    for (const action of result.actions ?? []) {
      delete action.params_schema; delete action.result_schema; action.schemas_included = false;
      action.description_truncated ||= action.description.length > 0; action.description = '';
    }
    // Optional projected/display material goes whole, before any requested page
    // is shortened: display prose must never cost guide/action/schema/event
    // availability. Shed the largest, least load-bearing fields first — the
    // description duplicates guide prose, the intro is the useful first step,
    // the bounded name is the last display field to go.
    if (result.house.description) { delete result.house.description; delete result.house.description_truncated;
      if (fits(result)) return result; }
    if (result.guide_intro || result.event_kinds) {
      delete result.guide_intro; delete result.event_kinds; delete result.event_kinds_truncated;
      if (fits(result)) return result;
    }
    if (result.house.name) { delete result.house.name; delete result.house.name_truncated;
      if (fits(result)) return result; }
    // Always leave at least one code point so successful pages make progress.
    const chunk = result.schema_page ?? result.guide;
    while (!fits(result) && chunk && Array.from(chunk.text).length > 1) {
      const characters = Array.from(chunk.text);
      chunk.text = characters.slice(0, Math.floor(characters.length / 2)).join('');
      chunk.next_offset = chunk.offset + Array.from(chunk.text).length;
      if (result.read) {
        if (result.schema_page) result.read.arguments.schema_offset = chunk.next_offset;
        else result.read.arguments.guide_offset = chunk.next_offset;
      }
    }
    if (fits(result)) return result;
    // Metadata alone may consume the budget. An explicit limit retains the
    // session/revision and points at the unread offset, never past omitted text.
    // House binding (origin/key/incarnation) survives; the optional identity
    // prose was already shed above and stays out of the fallback.
    const read = result.read;
    if (read && chunk) {
      if (result.schema_page) read.arguments.schema_offset = chunk.offset;
      else read.arguments.guide_offset = chunk.offset;
    }
    const limited: WorldAgentContext = {status: 'unavailable', code: 'WORLD_CONTEXT_SIZE_LIMIT',
      trust: result.trust, house: result.house, capability_revision: result.capability_revision,
      pin_provenance: result.pin_provenance, session_id: result.session_id, session_revision: result.session_revision,
      ...(read ? {read} : {})};
    if (fits(limited)) return limited;
  }
  // Never issue an unbound continuation when even its metadata cannot fit.
  return {status: 'unavailable', code: 'WORLD_CONTEXT_SIZE_LIMIT'};
}

function page(text: string, offset: number, sha256: string): TextPage {
  const characters = Array.from(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > characters.length) throw new Error('CONTEXT_OFFSET_INVALID');
  let end = Math.min(offset + PAGE_CHARACTERS, characters.length);
  // Control characters and non-ASCII text can cost much more after JSON wrapping.
  while (end > offset && (jsonBytes(characters.slice(offset, end).join('')) > 3500 || worldContextTextCost(JSON.stringify(characters.slice(offset, end).join(''))) > 3500)) end = offset + Math.floor((end - offset) / 2);
  return {text: characters.slice(offset, end).join(''), sha256, offset,
    next_offset: end < characters.length ? end : null, total_characters: characters.length};
}
/** Honest bound for one declared string field; empty or absent stays absent. */
function bounded(value: unknown, limit: number): {text: string; truncated: boolean} | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const characters = Array.from(value);
  return {text: characters.slice(0, limit).join(''), truncated: characters.length > limit};
}
const declaredString = (value: unknown, limit: number): string | undefined => bounded(value, limit)?.text;
/** name/description the server declared in its manifest house block, bounded. */
function declaredHouseFrom(document: Record<string, unknown>): DeclaredHouse {
  const block = jsonObjectOrNone(document.house);
  if (!block) return {};
  const name = bounded(block.name, 64), description = bounded(block.description, 192);
  return {...(name ? {name: name.text, name_truncated: name.truncated} : {}),
    ...(description ? {description: description.text, description_truncated: description.truncated} : {})};
}
/** event_kinds rows whose declared kind matches exactly (duplicates stay distinguishable). */
function declaredEventRows(document: Record<string, unknown>, kind: string): Record<string, unknown>[] {
  return (Array.isArray(document.event_kinds) ? document.event_kinds as unknown[] : [])
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
    .filter(row => row.kind === kind);
}
/** First-screen projection grounded in the guide's own frontmatter, bounded.
 * Prose fields clip with an honest `truncated` flag. The entry home is a
 * locator, so an overlength URL is omitted whole — a clipped URL would present
 * a wrong address as a complete one. */
function guideIntro(guideText: string): {guide_intro?: GuideIntro} {
  const frontmatter = parseGuideFrontmatter(guideText).frontmatter;
  if (!frontmatter) return {};
  let truncated = false;
  const prose = (value: string | undefined): string | undefined => {
    const bound = bounded(value, 64);
    if (!bound) return undefined;
    truncated ||= bound.truncated;
    return bound.text;
  };
  const locator = (value: string | undefined): string | undefined => {
    const bound = bounded(value, 64);
    return bound && !bound.truncated ? bound.text : undefined;
  };
  const entry = frontmatter.entry;
  const home = entry ? locator(entry.home) : undefined;
  const headline = entry ? prose(entry.headline) : undefined;
  const firstMove = entry ? prose(entry.firstMove) : undefined;
  const headlineEn = entry ? prose(entry.headlineEn) : undefined;
  const firstMoveEn = entry ? prose(entry.firstMoveEn) : undefined;
  const recipe = entry ? prose(entry.recipe) : undefined;
  const projectedEntry = {...(home ? {home} : {}), ...(headline ? {headline} : {}),
    ...(firstMove ? {first_move: firstMove} : {}), ...(headlineEn ? {headline_en: headlineEn} : {}),
    ...(firstMoveEn ? {first_move_en: firstMoveEn} : {}), ...(recipe ? {recipe} : {})};
  const world = prose(frontmatter.world), kind = prose(frontmatter.kind),
    voice = prose(frontmatter.voice), voiceEn = prose(frontmatter.voiceEn);
  const intro: GuideIntro = {...(world ? {world} : {}), ...(kind ? {kind} : {}),
    ...(voice ? {voice} : {}), ...(voiceEn ? {voice_en: voiceEn} : {}),
    ...(Object.keys(projectedEntry).length > 0 ? {entry: projectedEntry} : {}),
    truncated};
  return Object.keys(intro).length > 1 ? {guide_intro: intro} : {};
}
/** Bounded declared event kind name list (all transports), omitted when empty. */
function declaredEventKindList(names: string[]): {event_kinds?: string[]; event_kinds_truncated?: boolean} {
  if (names.length === 0) return {};
  return names.length > 64 ? {event_kinds: names.slice(0, 64), event_kinds_truncated: true} : {event_kinds: names};
}
const jsonObjectOrNone = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function projectWorldAgentContext(view: HouseCapabilityView, actorId: string, query: WorldAgentContextQuery): WorldAgentContext {
  const verified = view.verified;
  const base = {trust: 'external_data_not_authority' as const, house: {...verified.house},
    capability_revision: verified.capabilityRevision, pin_provenance: verified.pinProvenance};
  const unavailable = (code: string): WorldAgentContext => ({...base, status: 'unavailable', code});
  const reference = (extra: WorldAgentContextQuery = {}): ReadReference => ({tool: 'popclaw_world_capabilities', arguments: {
    house: verified.house.origin, expected_capability_revision: verified.capabilityRevision, ...extra}});
  if (query.expected_capability_revision && query.expected_capability_revision !== verified.capabilityRevision)
    return unavailable('CAPABILITY_REVISION_CHANGED');
  if (view.guide.validation !== 'valid' || !verified.guideBytes) return unavailable('GUIDE_REQUIRED');
  try {
    const bytes = new Uint8Array(verified.manifestBytes), guideBytes = new Uint8Array(verified.guideBytes);
    const sizes = new Map<string, number>();
    const document = parseWorldManifest(bytes, sizes);
    base.house = {...verified.house, ...declaredHouseFrom(document)};
    const guide = jsonObject(jsonObject(document.world_interaction).guide), sha256 = cidFromCanonical(guideBytes);
    if (cidFromCanonical(bytes) !== verified.capabilityRevision || sha256 !== guide.sha256) return unavailable('ACTION_EVIDENCE_CHANGED');
    if (query.event_kind !== undefined || query.schema === 'body') {
      if (query.event_kind === undefined) return unavailable('EVENT_KIND_UNAVAILABLE');
      if (query.kind !== undefined || query.guide_offset !== undefined || (query.schema !== undefined && query.schema !== 'body'))
        return unavailable('EVENT_SELECTOR_CONFLICT');
      const rows = declaredEventRows(document, query.event_kind);
      if (rows.length === 0) return unavailable('EVENT_KIND_UNAVAILABLE');
      if (rows.length > 1) return unavailable('EVENT_KIND_AMBIGUOUS');
      const row = rows[0]!;
      const local = view.privateMessages.validation === 'valid' ? view.privateMessages.kinds[query.event_kind] : undefined;
      const bodySchema = row.body_schema !== undefined && typeof row.body_schema === 'object' && !Array.isArray(row.body_schema);
      const schemaStatus = bodySchema && local?.validation === 'valid' ? 'body_schema_validated'
        : bodySchema ? 'body_schema_declared'
        : row.schema !== undefined && typeof row.schema === 'object' && !Array.isArray(row.schema) ? 'schema_declared'
        : typeof row.proto === 'string' && row.proto.length > 0 ? 'proto' : 'absent';
      if (query.schema === 'body') {
        // Only a locally validated declaration is paged; the text reconstructs
        // the exact declared JSON and the digest binds the whole schema.
        if (schemaStatus !== 'body_schema_validated') return unavailable('EVENT_SCHEMA_UNAVAILABLE');
        // Paging a declared schema is interpretation, so the same selection
        // relation decides it and the row pays the profile here too.
        if (!selectDeclaredRow(document, 'event_kinds', query.event_kind, sizes)) return unavailable('EVENT_KIND_AMBIGUOUS');
        const text = JSON.stringify(jsonObject(row.body_schema));
        const chunk = page(text, query.schema_offset ?? 0, cidFromCanonical(encoder.encode(text)));
        return {...base, status: 'available', schema_page: {...chunk, kind: query.event_kind, schema: 'body', encoding: 'json', fragment: true},
          read: reference({event_kind: query.event_kind, schema: 'body', schema_offset: chunk.next_offset ?? 0})};
      }
      const description = bounded(row.description, 128), signer = declaredString(row.signer, 32), proto = declaredString(row.proto, 64);
      const event: DeclaredEvent = {kind: query.event_kind, transport: declaredString(row.transport, 32) ?? 'unknown',
        description: description?.text ?? '', description_truncated: description?.truncated ?? false,
        schema_status: schemaStatus, local_validation: local?.validation ?? 'absent',
        ...(signer ? {signer} : {}), ...(proto ? {proto} : {}),
        ...(Number.isSafeInteger(row.schema_version) ? {schema_version: row.schema_version as number} : {}),
        ...(local?.validation === 'invalid' && local.detail ? {local_detail: declaredString(local.detail, 128) ?? ''} : {})};
      return {...base, status: 'available', event,
        read: reference({event_kind: query.event_kind,
          ...(schemaStatus === 'body_schema_validated' ? {schema: 'body' as const, schema_offset: 0} : {})})};
    }
    if (query.schema) {
      if (!query.kind) return unavailable('ACTION_KIND_UNAVAILABLE');
      const selected = selectActionEvidence(view, actorId, query.kind);
      if (!selected.available) return unavailable(selected.reason);
      const text = JSON.stringify(query.schema === 'params' ? selected.evidence.paramsSchema : selected.evidence.resultSchema);
      const chunk = page(text, query.schema_offset ?? 0, cidFromCanonical(encoder.encode(text)));
      return {...base, status: 'available', schema_page: {...chunk, kind: query.kind, schema: query.schema, encoding: 'json', fragment: true},
        read: reference({kind: query.kind, schema: query.schema, schema_offset: chunk.next_offset ?? 0})};
    }
    const guideText = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(guideBytes);
    const guidePage = page(guideText, query.guide_offset ?? 0, sha256);
    if (query.guide_offset !== undefined && query.kind === undefined) {
      return {...base, status: 'available', guide: guidePage, action_read: reference(),
        read: reference({guide_offset: guidePage.next_offset ?? 0})};
    }
    const kinds = query.kind ? [query.kind] : Object.keys(view.actions.kinds).filter(kind => view.actions.kinds[kind]?.validation === 'valid');
    const actions: NonNullable<WorldAgentContext['actions']> = [];
    let inlineBytes = 0;
    for (const kind of kinds) {
      const selected = selectActionEvidence(view, actorId, kind);
      if (!selected.available) { if (query.kind) return unavailable(selected.reason); continue; }
      const evidence = selected.evidence;
      const row = (document.intent_kinds as Record<string, unknown>[]).find(item => item.kind === kind)!;
      const description = typeof row.description === 'string' ? Array.from(row.description) : [];
      const schemas = {params_schema: evidence.paramsSchema, result_schema: evidence.resultSchema}, size = jsonBytes(schemas);
      const include = inlineBytes + size <= INLINE_SCHEMA_BYTES;
      if (include) inlineBytes += size;
      actions.push({kind, description: description.slice(0, 128).join(''), description_truncated: description.length > 128,
        schema_version: evidence.schemaVersion, schemas_included: include, ...(include ? schemas : {})});
    }
    const eventKindNames = [...new Set((Array.isArray(document.event_kinds) ? document.event_kinds as unknown[] : [])
      .map(row => declaredString(jsonObjectOrNone(row)?.kind, 64))
      .filter((kind): kind is string => kind !== undefined))];
    const result: WorldAgentContext = {...base, status: 'available', guide: guidePage, actions,
      ...(query.kind ? {} : {...guideIntro(guideText), ...declaredEventKindList(eventKindNames)}),
      action_read: reference(query.kind ? {kind: query.kind, schema: 'params', schema_offset: 0} : {}),
      read: reference({guide_offset: guidePage.next_offset ?? 0})};
    // Preserve every action name. Remove only whole optional schemas/descriptions,
    // then whole optional display/projection fields, and only then shorten the
    // guide page with an exact continuation; never cut a JSON schema. Dropping
    // optional content first means the halving below starts from the full page
    // and the first screen keeps a progressing page instead of an empty one.
    if (!materialFits(result)) for (const action of actions) {
      delete action.params_schema; delete action.result_schema; action.schemas_included = false;
      action.description_truncated ||= action.description.length > 0; action.description = '';
    }
    if (!materialFits(result) && result.house.description) {
      result.house = {...result.house}; delete result.house.description; delete result.house.description_truncated;
    }
    if (!materialFits(result) && result.event_kinds) { delete result.event_kinds; delete result.event_kinds_truncated; }
    if (!materialFits(result) && result.guide_intro) { delete result.guide_intro; }
    if (!materialFits(result) && result.house.name) {
      result.house = {...result.house}; delete result.house.name; delete result.house.name_truncated;
    }
    while (!materialFits(result) && guidePage.text.length > 0) {
      const chars = Array.from(guidePage.text); guidePage.text = chars.slice(0, Math.floor(chars.length / 2)).join('');
      guidePage.next_offset = guidePage.offset + Array.from(guidePage.text).length;
      result.read!.arguments.guide_offset = guidePage.next_offset;
    }
    if (!materialFits(result) || (guidePage.text.length === 0 && guidePage.next_offset === guidePage.offset && guidePage.total_characters > guidePage.offset))
      return {...unavailable('WORLD_CONTEXT_SIZE_LIMIT'), action_read: reference(), read: reference({guide_offset: query.guide_offset ?? 0})};
    return result;
  } catch (error) { return unavailable(error instanceof Error && error.message === 'CONTEXT_OFFSET_INVALID' ? 'CONTEXT_OFFSET_INVALID' : 'WORLD_CONTEXT_INVALID'); }
}
