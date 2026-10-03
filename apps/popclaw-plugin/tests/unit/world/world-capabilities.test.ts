import { readFileSync } from 'node:fs';
import { cidFromCanonical } from '@popclaw/algorithms';
import { describe, expect, it } from 'vitest';
import { selectActionEvidence, validateWorldSchema, type HouseCapabilityView } from '../../../src/world/world-capabilities.js';
import { parseWorldJson, parseWorldManifest, selectDeclaredRow } from '../../../src/world/json-profile.js';
const encoder = new TextEncoder();

/** popclaw-world `feat/fast-instance` f818bd5 `protocol/manifest.json`, byte
 * for byte: 11,230 bytes, no `world_interaction` block, every `event_kinds`
 * row carrying its JSON Schema under the legacy member name `schema` and
 * nesting to raw depth nine. A running House's real word, not a sample. */
const realWorldManifest = new Uint8Array(readFileSync(new URL('../../fixtures/world/fast-instance-manifest.json', import.meta.url)));
/** The same manifest with a board bolted on, so a row that is merely CARRIED
 * today becomes a genuinely SELECTED one. Nothing is renamed on the way in. */
function withBoard(edit: (document: any) => void): Uint8Array {
  const document = JSON.parse(new TextDecoder().decode(realWorldManifest));
  document.world_interaction = { version: 1, private_messages: { version: 1, participation: false, kinds: [] } };
  edit(document);
  return encoder.encode(JSON.stringify(document));
}

// These unchanged profile rules apply to both saved and first-release schemas.
// Historical whole-board activation assertions remain fixed at be5c40b1.
describe('shared bounded schema profile', () => {
  it.each(['^\\x41$', '^\\u0041$', '^\\u{1f600}$', '^\\uD83D\\uDE00$', '^.$'])('accepts shared scalar regex %s', pattern => {
    expect(() => validateWorldSchema({ type: 'string', pattern })).not.toThrow();
  });
  it.each(['^[]$', '^[^]$', '^\\uD800$', '^\\u{D800}$', '(?=evil)'])('rejects unsupported regex %s', pattern => {
    expect(() => validateWorldSchema({ type: 'string', pattern })).toThrow('SCHEMA_PATTERN_UNSUPPORTED');
  });
  it('rejects non-consuming cycles but accepts recursive object consumption', () => {
    expect(() => validateWorldSchema({ $ref: '#/$defs/node', $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } } })).not.toThrow();
    expect(() => validateWorldSchema({ $ref: '#/$defs/node', $defs: { node: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'string' }] } } })).toThrow('SCHEMA_NONCONSUMING_CYCLE');
  });
  it('rejects unpinned schema features, unresolved refs and excessive document size', () => {
    for (const schema of [{ type: 'string', format: 'email' }, { $ref: '#/$defs/missing' }, { description: 'x'.repeat(32768) }]) expect(() => validateWorldSchema(schema)).toThrow();
  });
});

describe('bounded JSON parsing', () => {
  it('counts original selected schema bytes including insignificant whitespace', () => {
    // Rewritten from a fixture that carried no board at all: an unselected row
    // is not a quota object, so the count has to be proven on a SELECTED one.
    const padded = '{' + ' '.repeat(32768) + '"type":"string"}';
    const raw = '{"world_interaction":{"version":1,"actions":{"status_endpoint":"/v1/world-actions/status",'
      + '"result_authority_pubkey":"x","attachments":[],"kinds":["reading.annotate","reading.small"]}},'
      + '"intent_kinds":[{"kind":"reading.annotate","params_schema":' + padded + '},'
      + '{"kind":"legacy.unselected","params_schema":' + padded + '},'
      + '{"kind":"reading.small","params_schema":{"type":"string"}}]}';
    const sizes = new Map<string, number>();
    const document = parseWorldManifest(encoder.encode(raw), sizes);
    expect(sizes.get('intent_kinds/0/params_schema')).toBe(padded.length);
    expect(() => selectDeclaredRow(document, 'intent_kinds', 'reading.annotate', sizes)).toThrow('SCHEMA_SIZE_LIMIT');
    // The unselected sibling carries a byte-identical oversized schema. It is
    // recorded and never charged, and it does not reach the selected sibling.
    expect(sizes.get('intent_kinds/1/params_schema')).toBe(padded.length);
    expect(selectDeclaredRow(document, 'intent_kinds', 'reading.small', sizes)).toMatchObject({ index: 2, kind: 'reading.small' });
  });
  it('holds the whole manifest to the raw bound and nothing else', () => {
    const nest = (count: number) => '{"x":' + '['.repeat(count) + '1' + ']'.repeat(count) + '}';
    expect(() => parseWorldManifest(encoder.encode(nest(63)))).toThrow('JSON_DEPTH_LIMIT');
    expect(() => parseWorldManifest(encoder.encode(nest(62)))).not.toThrow();
    expect(() => parseWorldManifest(encoder.encode('{"x":1,"x":2}'))).toThrow('JSON_DUPLICATE_OR_DANGEROUS_KEY');
  });
  it('accepts the real world manifest whose unselected declarations nest past the business depth', () => {
    const sizes = new Map<string, number>();
    const document = parseWorldManifest(realWorldManifest, sizes);
    expect(realWorldManifest.length).toBe(11230);
    expect(document.world_interaction).toBeUndefined();
    // Non-vacuity: the carried rows really are deeper than the business bound
    // and really do use the member name no selected schema defines.
    const row = (document.event_kinds as Record<string, unknown>[])[0]!;
    expect(row.kind).toBe('world.embodiment');
    expect(Object.keys(row)).toContain('schema');
    expect(Object.keys(row)).not.toContain('body_schema');
    expect((row.schema as any).$defs.figure.properties.figure_ref.type).toBe('string');
    expect(() => parseWorldJson(realWorldManifest, 262144, 64)).not.toThrow();
  });
  it('refuses a selected legacy row locally and never renames its schema member', () => {
    const sizes = new Map<string, number>();
    const document = parseWorldManifest(withBoard(document => {
      document.world_interaction.private_messages.kinds = ['world.embodiment', 'legal.notice'];
      document.event_kinds.push({ kind: 'legal.notice', schema_version: 1, transport: 'house', signer: 'official',
        description: 'Notice', body_schema: { type: 'object' } });
    }), sizes);
    expect(() => selectDeclaredRow(document, 'event_kinds', 'world.embodiment', sizes)).toThrow('JSON_DEPTH_LIMIT');
    const row = (document.event_kinds as Record<string, unknown>[])[0]!;
    expect(row.body_schema).toBeUndefined();
    expect(row.schema).toBeDefined();
    // Refusing one selected row is not refusing the board: the legal sibling
    // the same board selects resolves untouched.
    expect(selectDeclaredRow(document, 'event_kinds', 'legal.notice', sizes)).toMatchObject({ kind: 'legal.notice', property: 'event_kinds' });
  });
  it.each(['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"__proto__":{}}', '{"x":9007199254740993}', '{"x":0.5}', '{"x":"\\ud800"}', '\ufeff{}', '{}{}'])('rejects unsafe JSON: %s', value => {
    expect(() => parseWorldJson(encoder.encode(value), 1024)).toThrow();
  });
  it('accepts integer decimal strings without precision loss', () => {
    expect((parseWorldJson(encoder.encode('{"seq":"18446744073709551615"}'), 1024) as any).seq).toBe('18446744073709551615');
  });
  it('counts scalar leaves in the depth-eight bound', () => {
    expect(() => parseWorldJson(encoder.encode('['.repeat(7) + '1' + ']'.repeat(7)), 1024)).not.toThrow();
    expect(() => parseWorldJson(encoder.encode('['.repeat(8) + '1' + ']'.repeat(8)), 1024)).toThrow('JSON_DEPTH_LIMIT');
  });
});


describe('selected action interpretation evidence', () => {
  const actor = '11111111111111111111111111111111';
  function fixture(): HouseCapabilityView {
    const guideBytes = encoder.encode('Use reading.annotate to save a private annotation.');
    const manifestBytes = encoder.encode(JSON.stringify({
      world_interaction: { version: 1,
        actions: { status_endpoint: '/v1/world-actions/status', result_authority_pubkey: actor, kinds: ['reading.annotate'], attachments: [] },
        guide: { path: '/v1/guide.md', sha256: cidFromCanonical(guideBytes), revision: 'guide_1' } },
      intent_kinds: [{ kind: 'reading.annotate', schema_version: 1, transport: 'typed', signer: 'user', description: 'Save annotation',
        params_schema: { type: 'object' }, result_schema: { type: 'object' }, result_attachments: { allowed: [], required_on_success: [] }, consistency: 'none' },
        { kind: 'legacy.unselected' }],
    }));
    const valid = { validation: 'valid', detail: '', support: 'unsupported', ready: false } as const;
    return { verified: { house: { origin: 'https://house.example', houseKey: actor, incarnation: 'house_1' },
      capabilityRevision: cidFromCanonical(manifestBytes), manifestBytes, proofBytes: new Uint8Array([1, 2, 3]), guideBytes, pinProvenance: 'configured_pin' } as HouseCapabilityView['verified'],
      actions: { ...valid, kinds: { 'reading.annotate': valid } }, guide: valid, publicStream: valid,
      privateMessages: { ...valid, kinds: {} }, executionClosure: valid };
  }
  it('owns evidence without promoting support or using an unselected legacy row', () => {
    const view = fixture(), selected = selectActionEvidence(view, actor, 'reading.annotate');
    expect(selected.available).toBe(true);
    if (!selected.available) throw new Error(selected.reason);
    expect(selected.evidence.allowed).toEqual([]);
    expect(selected.evidence.resultAuthorityKey).toBe(actor);
    expect(Object.isFrozen(selected.evidence.paramsSchema)).toBe(true);
    selected.evidence.manifestBytes.fill(0); selected.evidence.guideBytes.fill(0);
    expect(selectActionEvidence(view, actor, 'reading.annotate').available).toBe(true);
    expect(selectActionEvidence(view, actor, 'legacy.unselected')).toEqual({ available: false, reason: 'ACTION_KIND_UNAVAILABLE' });
    expect(view.actions.support).toBe('unsupported'); expect(view.actions.ready).toBe(false);
  });
  it('requires the saved guide and rejects changed original bytes', () => {
    const view = fixture();
    expect(selectActionEvidence({ ...view, guide: { ...view.guide, validation: 'invalid' } }, actor, 'reading.annotate').available).toBe(false);
    view.verified.guideBytes!.fill(0);
    expect(selectActionEvidence(view, actor, 'reading.annotate')).toEqual({ available: false, reason: 'ACTION_EVIDENCE_CHANGED' });
  });
  it('does not infer selection when a matching intent row exists', () => {
    const view = fixture();
    expect(selectActionEvidence({ ...view, actions: { ...view.actions, kinds: {} } }, actor, 'reading.annotate').available).toBe(false);
    expect(selectActionEvidence(null, actor, 'reading.annotate').available).toBe(false);
  });
});
