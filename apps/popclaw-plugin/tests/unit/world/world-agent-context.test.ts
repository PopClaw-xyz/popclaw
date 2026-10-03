import { runWorldCapabilitiesCommand, type WorldCommandContext } from '../../../src/commands/popclaw-world.js';
import { runHouseLoginCommand, type HouseCommandContext } from '../../../src/commands/popclaw-house.js';
import { structuredToolResult } from '../../../src/tools/mcp-adapter.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boundWorldAgentContext, projectWorldAgentContext, worldContextTextCost } from '../../../src/world/world-agent-context.js';
import type { HouseCapabilityView } from '../../../src/world/world-capabilities.js';
// Neutral test-only server-asset fixtures with the fixed server's served
// shapes (see tests/fixtures/world/server-assets/README.md for provenance
// SHAs and the external real-sample verification boundary). Official server
// content is not shipped in this tree.
const realGuide = readFileSync(new URL('../../fixtures/world/server-assets/guide.md', import.meta.url), 'utf8');
const realManifest = JSON.parse(readFileSync(new URL('../../fixtures/world/server-assets/manifest.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder(), actor = '11111111111111111111111111111111';
function fixture(guide = 'The server says: annotate a passage.', padding = 0) {
  const guideBytes = encoder.encode(guide);
  const params = {type: 'object', ...(padding ? {description: 'x'.repeat(padding)} : {}), properties: { passage: {type: 'string'} }, required: ['passage'], additionalProperties: false};
  const manifestBytes = encoder.encode(JSON.stringify({world_interaction: {version: 1,
    actions: {status_endpoint: '/v1/world-actions/status', result_authority_pubkey: actor, kinds: ['reading.annotate'], attachments: []},
    guide: {path: '/v1/guide.md', sha256: cidFromCanonical(guideBytes), revision: 'guide_1'}},
    intent_kinds: [{kind: 'reading.annotate', description: 'Annotate a passage', schema_version: 1, transport: 'typed', signer: 'user',
      params_schema: params, result_schema: {type: 'object'}, result_attachments: {allowed: [], required_on_success: []}, consistency: 'none'},
      {kind: 'ignored.unselected', params_schema: {type: 'object'}}]}));
  const state = {validation: 'valid', support: 'unsupported', ready: false, detail: ''} as const;
  const view: HouseCapabilityView = {verified: {house: {origin: 'https://house.invalid', houseKey: actor, incarnation: 'inc_1'},
    capabilityRevision: cidFromCanonical(manifestBytes), manifestBytes, guideBytes, proofBytes: new Uint8Array([1]), pinProvenance: 'configured_pin'},
    guide: state, actions: {...state, kinds: {'reading.annotate': state}}, publicStream: state, privateMessages: {...state, kinds: {}}, executionClosure: state};
  return {view, params};
}
describe('server-authored agent context projection', () => {
  it('returns bound server guide and exact selected schemas without promoting authority or support', () => {
    const {view, params} = fixture();
    const result = projectWorldAgentContext(view, actor, {});
    expect(result).toMatchObject({status: 'available', trust: 'external_data_not_authority', capability_revision: view.verified.capabilityRevision,
      pin_provenance: 'configured_pin', guide: {text: 'The server says: annotate a passage.', next_offset: null},
      actions: [{kind: 'reading.annotate', params_schema: params, result_schema: {type: 'object'}}]});
    expect(JSON.stringify(result)).not.toContain('ignored.unselected');
    expect(view.actions.support).toBe('unsupported');
  });
  it('paginates full Unicode without splitting code points and exposes hashes for every page', () => {
    const text = '😀'.repeat(8193), {view} = fixture(text);
    let offset = 0, joined = '', sha256: string | undefined;
    do {
      const result = projectWorldAgentContext(view, actor, {guide_offset: offset});
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(7000);
      expect(result.guide!.offset).toBe(offset);
      sha256 ??= result.guide!.sha256;
      expect(result.guide!.sha256).toBe(sha256);
      joined += result.guide!.text;
      if (result.guide!.next_offset === null) break;
      expect(result.guide!.next_offset).toBeGreaterThan(offset);
      offset = result.guide!.next_offset;
    } while (offset < 32768);
    expect(joined).toBe(text);
  });
  it('preserves a UTF-8 BOM so guide reconstruction matches the original byte digest', () => {
    const text = '\ufeff' + 'Server guide. '.repeat(1000), {view} = fixture(text);
    let reconstructed = '', offset = 0, digest = '';
    do {
      const result = projectWorldAgentContext(view, actor, {guide_offset: offset});
      const chunk = result.guide!;
      digest ||= chunk.sha256;
      expect(chunk.sha256).toBe(digest);
      reconstructed += chunk.text;
      if (chunk.next_offset === null) break;
      offset = chunk.next_offset;
    } while (offset < 32768);
    expect(encoder.encode(reconstructed)).toEqual(view.verified.guideBytes);
    expect(cidFromCanonical(encoder.encode(reconstructed))).toBe(digest);
  });
  it('omits a large schema as a whole and makes the exact schema available on demand', () => {
    const {view, params} = fixture('Server instructions', 14000);
    const summary = projectWorldAgentContext(view, actor, {});
    expect(summary.actions?.[0]).toMatchObject({schemas_included: false});
    expect(summary.actions?.[0]).not.toHaveProperty('params_schema');
    let text = '', offset = 0, hash = '';
    do {
      const result = projectWorldAgentContext(view, actor, {kind: 'reading.annotate', schema: 'params', schema_offset: offset});
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(7000);
      const chunk = result.schema_page!;
      hash ||= chunk.sha256;
      expect(chunk.sha256).toBe(hash);
      text += chunk.text;
      if (chunk.next_offset === null) break;
      offset = chunk.next_offset;
    } while (offset < 32768);
    expect(cidFromCanonical(encoder.encode(text))).toBe(hash);
    expect(JSON.parse(text)).toEqual(params);
  });
  it('refuses mixed-revision continuation, modified bytes, and unselected schema requests', () => {
    const {view} = fixture();
    expect(projectWorldAgentContext(view, actor, {expected_capability_revision: 'b'.repeat(64)})).toMatchObject({status: 'unavailable', code: 'CAPABILITY_REVISION_CHANGED'});
    expect(projectWorldAgentContext(view, actor, {kind: 'ignored.unselected'})).toMatchObject({status: 'unavailable', code: 'ACTION_KIND_UNAVAILABLE'});
    view.verified.guideBytes!.fill(0);
    expect(projectWorldAgentContext(view, actor, {})).toMatchObject({status: 'unavailable', code: 'ACTION_EVIDENCE_CHANGED'});
  });
});


it('budgets the full native response and uses a narrow same-context page when a catalog is large', async () => {
  const {view} = fixture('𠀀'.repeat(10000));
  const document = JSON.parse(new TextDecoder().decode(view.verified.manifestBytes));
  const template = document.intent_kinds[0];
  const kinds = Array.from({length: 32}, (_, i) => 'a'.repeat(20) + '.' + 'b'.repeat(20) + '.' + String(i).padStart(2, '0') + 'x'.repeat(18));
  document.intent_kinds = kinds.map(kind => ({...template, kind}));
  document.world_interaction.actions.kinds = kinds;
  const bytes = encoder.encode(JSON.stringify(document));
  const value = {...view, verified: {...view.verified, manifestBytes: bytes, capabilityRevision: cidFromCanonical(bytes)},
    actions: {...view.actions, kinds: Object.fromEntries(kinds.map(kind => [kind, view.actions.kinds['reading.annotate']!]))}};
  const context: WorldCommandContext = {client: () => {throw new Error('READ_ONLY');}, readCapabilities: () => value, readAgentContext: input => ({...projectWorldAgentContext(value, actor, input),
    session_id: 's'.repeat(128), session_revision: '123'})};
  const summary = await runWorldCapabilitiesCommand(context, {house: value.verified.house.origin});
  expect(summary.agent_context).toMatchObject({code: 'WORLD_CONTEXT_READ_REQUIRED'});
  expect(Object.keys((summary.blocks as any).actions.kinds)).toEqual(kinds);
  const args = (summary.agent_context as any).read.arguments;
  expect(args.expected_session_id).toBe('s'.repeat(128));
  const page = await runWorldCapabilitiesCommand(context, args);
  expect(page).toMatchObject({view: 'agent_context', context_complete: false, code: 'WORLD_LOCAL_UNSUPPORTED', agent_context: {status: 'available'}});
  expect(page).not.toHaveProperty('blocks');
  expect(page.agent_context).not.toHaveProperty('actions');
  for (const result of [summary, page]) {
    const native = structuredToolResult(result).content[0]!;
    expect(native.type).toBe('text');
    if (native.type !== 'text') throw new Error('EXPECTED_TEXT');
    expect(worldContextTextCost(native.text)).toBeLessThanOrEqual(14000);
    expect(JSON.parse(native.text)).toEqual(result);
  }
});

describe('onboarding first screen and on-demand event explanations', () => {
  const noticeBody = {type: 'object', properties: {text: {type: 'string'}, lang: {type: 'string'}}, required: ['text'], additionalProperties: false};
  /** Real built-in house identity + event declarations, real guide bytes, one synthetic interpreted event. */
  function onboardFixture(guide: string = realGuide, house: Record<string, unknown> = realManifest.house, extraEventRows: unknown[] = []) {
    const guideBytes = encoder.encode(guide);
    const manifestBytes = encoder.encode(JSON.stringify({house,
      world_interaction: {version: 1,
        actions: {status_endpoint: '/v1/world-actions/status', result_authority_pubkey: actor, kinds: ['reading.annotate'], attachments: []},
        private_messages: {version: 1, kinds: ['world.notice'], participation: false},
        guide: {path: '/v1/guide.md', sha256: cidFromCanonical(guideBytes), revision: 'guide_1'}},
      intent_kinds: [{kind: 'reading.annotate', description: 'Annotate a passage', schema_version: 1, transport: 'typed', signer: 'user',
        params_schema: {type: 'object'}, result_schema: {type: 'object'}, result_attachments: {allowed: [], required_on_success: []}, consistency: 'none'}],
      event_kinds: [...realManifest.event_kinds.filter((row: {kind?: string}) => ['me.post', 'me.reply'].includes(row.kind ?? '')),
        {kind: 'world.notice', transport: 'house', schema_version: 2, signer: 'official', description: 'Official notice from the house',
          body_schema: noticeBody, public_scope_declaration: 'manifest_scopes_only'}, ...extraEventRows]}));
    const state = {validation: 'valid', support: 'unsupported', ready: false, detail: ''} as const;
    const view: HouseCapabilityView = {verified: {house: {origin: 'https://house.invalid', houseKey: actor, incarnation: 'inc_1'},
      capabilityRevision: cidFromCanonical(manifestBytes), manifestBytes, guideBytes, proofBytes: new Uint8Array([1]), pinProvenance: 'configured_pin'},
      guide: state, actions: {...state, kinds: {'reading.annotate': state}},
      privateMessages: {...state, kinds: {'world.notice': state}}, publicStream: state, executionClosure: state};
    return {view, guideBytes};
  }
  it('projects the real built-in guide first screen with source-backed House identity', () => {
    const {view, guideBytes} = onboardFixture();
    const result = projectWorldAgentContext(view, actor, {});
    expect(result.status).toBe('available');
    // House identity comes from the verified manifest block, never the hostname.
    expect(result.house).toMatchObject({origin: 'https://house.invalid', name: realManifest.house.name,
      description: realManifest.house.description, name_truncated: false, description_truncated: false});
    // First-step context is grounded in the guide's own frontmatter declaration.
    expect(result.guide_intro).toMatchObject({world: 'fixture.example', kind: 'social-plaza',
      entry: {headline: 'A neutral plaza where one name carries every voice',
        first_move: 'show me what the square is saying', headline_en: 'A neutral plaza where one name carries every voice', first_move_en: 'show me what the square is saying'}});
    // The raw guide page stays exact: offset zero is the original byte start (frontmatter included), digest bound.
    expect(result.guide!.text.startsWith('---\nworld: fixture.example')).toBe(true);
    expect(result.guide!.offset).toBe(0);
    expect(result.guide!.sha256).toBe(cidFromCanonical(guideBytes));
    expect(result.event_kinds).toEqual(['me.post', 'me.reply', 'world.notice']);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(7000);
  });
  it('bounds a hostile House identity honestly and omits undeclared identity fields', () => {
    const hostile = onboardFixture(realGuide, {name: '房'.repeat(400), slug: 'me', description: 'x'.repeat(600)});
    const bounded = projectWorldAgentContext(hostile.view, actor, {});
    expect(bounded.status).toBe('available');
    expect(Array.from(bounded.house.name!).length).toBeLessThanOrEqual(64);
    // Moderate pressure still fits: both fields stay with honest bounds/flags.
    // Whole-field shedding under heavier pressure is covered by the review follow-up tests.
    expect(bounded.house).toMatchObject({name_truncated: true, description_truncated: true});
    expect(Array.from(bounded.house.description!).length).toBeLessThanOrEqual(192);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(7000);
    const silent = onboardFixture(realGuide, {slug: 'me'});
    const result = projectWorldAgentContext(silent.view, actor, {});
    expect(result.status).toBe('available');
    expect(result.house).not.toHaveProperty('name');
    expect(result.house).not.toHaveProperty('description');
  });
  it('explains legacy typed events from verified declarations without inventing a schema', () => {
    const {view} = onboardFixture();
    const row = realManifest.event_kinds.find((item: {kind: string}) => item.kind === 'me.post');
    const result = projectWorldAgentContext(view, actor, {event_kind: 'me.post'});
    expect(result.status).toBe('available');
    expect(result.event).toMatchObject({kind: 'me.post', transport: 'typed', signer: 'user', proto: 'Post',
      description: row.description, description_truncated: false, schema_status: 'proto', local_validation: 'absent'});
    expect(result.event).not.toHaveProperty('body_schema');
    expect(result.event).not.toHaveProperty('proto_truncated');
    // A typed proto shape is not a JSON schema: the read says so instead of paging anything.
    expect(projectWorldAgentContext(view, actor, {event_kind: 'me.post', schema: 'body'}))
      .toMatchObject({status: 'unavailable', code: 'EVENT_SCHEMA_UNAVAILABLE'});
  });
  it('pages an interpreted event body schema as the exact declared JSON with a bound hash', () => {
    const {view} = onboardFixture();
    const explanation = projectWorldAgentContext(view, actor, {event_kind: 'world.notice'});
    expect(explanation.event).toMatchObject({kind: 'world.notice', transport: 'house', signer: 'official',
      schema_version: 2, schema_status: 'body_schema_validated', local_validation: 'valid'});
    expect(explanation.read!.arguments).toMatchObject({event_kind: 'world.notice', schema: 'body', schema_offset: 0});
    let text = '', offset = 0, hash = '';
    do {
      const result = projectWorldAgentContext(view, actor, {event_kind: 'world.notice', schema: 'body', schema_offset: offset});
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(7000);
      const chunk = result.schema_page!;
      expect(chunk.schema).toBe('body');
      hash ||= chunk.sha256;
      expect(chunk.sha256).toBe(hash);
      text += chunk.text;
      if (chunk.next_offset === null) break;
      offset = chunk.next_offset;
    } while (offset < 32768);
    expect(text).toBe(JSON.stringify(noticeBody));
    expect(cidFromCanonical(encoder.encode(text))).toBe(hash);
  });
  it('rejects unknown, ambiguous and conflicting event selectors', () => {
    const {view} = onboardFixture();
    expect(projectWorldAgentContext(view, actor, {event_kind: 'me.absent'})).toMatchObject({status: 'unavailable', code: 'EVENT_KIND_UNAVAILABLE'});
    const duplicated = onboardFixture(realGuide, realManifest.house, [realManifest.event_kinds.find((item: {kind: string}) => item.kind === 'me.reply')]);
    expect(projectWorldAgentContext(duplicated.view, actor, {event_kind: 'me.reply'})).toMatchObject({status: 'unavailable', code: 'EVENT_KIND_AMBIGUOUS'});
    expect(projectWorldAgentContext(view, actor, {kind: 'reading.annotate', event_kind: 'me.post'}))
      .toMatchObject({status: 'unavailable', code: 'EVENT_SELECTOR_CONFLICT'});
    expect(projectWorldAgentContext(view, actor, {event_kind: 'me.post', guide_offset: 0}))
      .toMatchObject({status: 'unavailable', code: 'EVENT_SELECTOR_CONFLICT'});
  });
  it('keeps the shared event read under the final budget with heavy Unicode and a long session id', async () => {
    const fatGuide = ('.servers say 印信「名号」江湖。'.repeat(400)), session = '𠀀'.repeat(256);
    const {view} = onboardFixture(fatGuide);
    const context: WorldCommandContext = {client: () => {throw new Error('READ_ONLY');},
      readCapabilities: () => view, readAgentContext: input => {
        const material = projectWorldAgentContext(view, actor, input);
        for (const ref of [material.read, material.action_read]) if (ref) ref.arguments.expected_session_id = session;
        return {...material, session_id: session, session_revision: '123'};
      }};
    const base = {house: view.verified.house.origin, expected_session_id: session, expected_capability_revision: view.verified.capabilityRevision};
    for (const input of [{...base, event_kind: 'me.post'}, {...base, event_kind: 'world.notice', schema: 'body', schema_offset: 0}]) {
      const response = await runWorldCapabilitiesCommand(context, input);
      expect(response).toMatchObject({view: 'agent_context', agent_context: {status: 'available', session_id: session}});
      expect(response.agent_context).not.toHaveProperty('guide');
      expectBoundedResponse(response);
    }
    const explanation = await runWorldCapabilitiesCommand(context, {...base, event_kind: 'me.post'});
    expect(explanation).toMatchObject({selected_event: null});
    expect((explanation.agent_context as any).read.arguments).toMatchObject({event_kind: 'me.post', expected_session_id: session});
  });
  it('serves a fresh login first screen against the real built-in guide', async () => {
    const {view} = onboardFixture(), session = 'a'.repeat(64);
    const ctx: HouseCommandContext = {
      coordinator: () => ({loginHouse: async () => ({status: 'connected', scope: 'full', sessionId: session})}) as unknown as ReturnType<HouseCommandContext['coordinator']>,
      readAgentContext: () => {
        const material = projectWorldAgentContext(view, actor, {});
        for (const ref of [material.read, material.action_read]) if (ref) ref.arguments.expected_session_id = session;
        return {...material, session_id: session, session_revision: '123'};
      }};
    const text = await runHouseLoginCommand(ctx, view.verified.house.origin);
    expect(worldContextTextCost(text)).toBeLessThanOrEqual(14000);
    const response = JSON.parse(text.slice(text.indexOf('\n') + 1));
    expect(response).toMatchObject({login_status: 'connected', agent_context: {status: 'available',
      house: {name: realManifest.house.name}, guide_intro: {entry: {first_move: 'show me what the square is saying'}}}});
  });
});

describe('optional display metadata never blocks requested material (review follow-up)', () => {
  /** Review counterexample shape: maximal legal identity prose against a session of maximal supplementary ideographs. */
  function adverseFixture(guide: string, extraEventRows: unknown[] = []) {
    const guideBytes = encoder.encode(guide);
    const manifestBytes = encoder.encode(JSON.stringify({house: {name: '房'.repeat(64), slug: 'me', description: '述'.repeat(192)},
      world_interaction: {version: 1,
        actions: {status_endpoint: '/v1/world-actions/status', result_authority_pubkey: actor, kinds: ['reading.annotate'], attachments: []},
        private_messages: {version: 1, kinds: ['world.notice'], participation: false},
        guide: {path: '/v1/guide.md', sha256: cidFromCanonical(guideBytes), revision: 'guide_1'}},
      intent_kinds: [{kind: 'reading.annotate', description: 'Annotate', schema_version: 1, transport: 'typed', signer: 'user',
        params_schema: {type: 'object'}, result_schema: {type: 'object'}, result_attachments: {allowed: [], required_on_success: []}, consistency: 'none'}],
      event_kinds: [{kind: 'me.post', transport: 'typed', signer: 'user', proto: 'Post', description: '字'.repeat(128)},
        {kind: 'world.notice', transport: 'house', schema_version: 1, signer: 'official', description: 'notice',
          body_schema: {type: 'object'}, public_scope_declaration: 'manifest_scopes_only'}, ...extraEventRows]}));
    const state = {validation: 'valid', support: 'unsupported', ready: false, detail: ''} as const;
    const view: HouseCapabilityView = {verified: {house: {origin: 'https://house.invalid', houseKey: actor, incarnation: 'inc_1'},
      capabilityRevision: cidFromCanonical(manifestBytes), manifestBytes, guideBytes, proofBytes: new Uint8Array([1]), pinProvenance: 'configured_pin'},
      guide: state, actions: {...state, kinds: {'reading.annotate': state}},
      privateMessages: {...state, kinds: {'world.notice': state}}, publicStream: state, executionClosure: state};
    return {view};
  }
  function adverseContext(view: HouseCapabilityView, session: string): WorldCommandContext {
    return {client: () => {throw new Error('READ_ONLY');},
      readCapabilities: () => view, readAgentContext: input => {
        const material = projectWorldAgentContext(view, actor, input);
        for (const ref of [material.read, material.action_read]) if (ref) ref.arguments.expected_session_id = session;
        return {...material, session_id: session, session_revision: '123'};
      }};
  }
  it('keeps guide, action, schema and event reads available by shedding optional identity first', async () => {
    const {view} = adverseFixture('x'.repeat(3490)), session = '𠀀'.repeat(256);
    const context = adverseContext(view, session);
    const base = {house: view.verified.house.origin, expected_session_id: session, expected_capability_revision: view.verified.capabilityRevision};
    // The raw guide page stays a progressing, session-pinned read; identity prose gave way whole.
    const guideView = await runWorldCapabilitiesCommand(context, {...base, guide_offset: 0});
    const guideMaterial = guideView.agent_context as any;
    expect(guideMaterial).toMatchObject({status: 'available', session_id: session});
    expect(guideMaterial.guide.text.length).toBeGreaterThan(0);
    expect(guideMaterial.guide.next_offset).toBeGreaterThan(0);
    expect(guideMaterial.read.arguments).toMatchObject({guide_offset: guideMaterial.guide.next_offset, expected_session_id: session});
    expect(guideMaterial.house).not.toHaveProperty('description');
    expectBoundedResponse(guideView);
    // Action summary, exact schema page and both event reads stay available under the same budget.
    for (const input of [{...base, kind: 'reading.annotate'},
      {...base, kind: 'reading.annotate', schema: 'params', schema_offset: 0},
      {...base, event_kind: 'world.notice', schema: 'body', schema_offset: 0}]) {
      const response = await runWorldCapabilitiesCommand(context, input);
      expect(response.agent_context).toMatchObject({status: 'available', session_id: session});
      expectBoundedResponse(response);
    }
    const legacy = await runWorldCapabilitiesCommand(context, {...base, event_kind: 'me.post'});
    expect((legacy.agent_context as any).event).toMatchObject({kind: 'me.post', schema_status: 'proto'});
    expect((legacy.agent_context as any).read.arguments).toMatchObject({event_kind: 'me.post', expected_session_id: session});
    expectBoundedResponse(legacy);
  });
  it('preserves a progressing first guide page when identity and event-list pressure is high', () => {
    const extra = Array.from({length: 16}, (_, i) => ({kind: `namespace.${'b'.repeat(24)}.event${i}`,
      transport: 'typed', signer: 'user', proto: 'Post', description: 'post'}));
    const {view} = adverseFixture(realGuide, extra);
    const result = projectWorldAgentContext(view, actor, {});
    expect(result.status).toBe('available');
    expect(result.guide!.text.length).toBeGreaterThan(0);
    expect(result.guide!.offset).toBe(0);
    expect(result.guide!.next_offset).toBeGreaterThan(0);
    expect(result.guide!.sha256).toBe(cidFromCanonical(encoder.encode(realGuide)));
    // The optional identity prose gives way before the raw first page; the intro survives when it fits.
    expect(result.house).not.toHaveProperty('description');
    expect(result.guide_intro).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(7000);
  });
  it('reports actual guide intro clipping and omits an overlength entry URL', () => {
    const clippedGuide = ['---', `world: ${'w'.repeat(80)}`, 'entry:',
      `  home: https://house.invalid/${'p'.repeat(80)}`, `  headline: ${'题'.repeat(100)}`, '  first_move: 看看广场', '---', '', '# Guide body'].join('\n');
    const {view} = fixture(clippedGuide);
    const intro = projectWorldAgentContext(view, actor, {}).guide_intro!;
    expect(intro.truncated).toBe(true);
    expect(intro.world).toBe('w'.repeat(64));
    expect(intro.entry).toMatchObject({headline: '题'.repeat(64), first_move: '看看广场'});
    // A clipped URL is not a complete address: omit it rather than present a wrong locator.
    expect(intro.entry).not.toHaveProperty('home');
    const intact = fixture(['---', 'world: popclaw.me', 'entry:', '  home: https://popclaw.me/feed', '  first_move: look', '---', '', 'Body'].join('\n'));
    expect(projectWorldAgentContext(intact.view, actor, {}).guide_intro)
      .toMatchObject({truncated: false, world: 'popclaw.me', entry: {home: 'https://popclaw.me/feed', first_move: 'look'}});
  });
});


function sessionContext(view: HouseCapabilityView, sessionId: string): WorldCommandContext {
  return {client: () => {throw new Error('READ_ONLY');},
    readCapabilities: () => view, readAgentContext: input => {
      if (input.expected_session_id && input.expected_session_id !== sessionId) return {status: 'unavailable', code: 'HOUSE_SESSION_CHANGED'};
      const material = projectWorldAgentContext(view, actor, input);
      for (const ref of [material.read, material.action_read]) if (ref) ref.arguments.expected_session_id = sessionId;
      return {...material, session_id: sessionId, session_revision: '123'};
    }};
}
function expectBoundedResponse(result: Record<string, unknown>) {
  const native = structuredToolResult(result).content[0]!;
  if (native.type !== 'text') throw new Error('EXPECTED_TEXT');
  expect(worldContextTextCost(native.text)).toBeLessThanOrEqual(14000);
  expect(JSON.parse(native.text)).toEqual(result);
}
it('retains the session in an oversized catalog fallback and rejects continuation after session change', async () => {
  const {view} = fixture('Guide data. '.repeat(1000));
  const document = JSON.parse(new TextDecoder().decode(view.verified.manifestBytes));
  const kinds = Array.from({length: 32}, (_, i) => 'a'.repeat(20) + '.' + 'b'.repeat(20) + '.' + String(i).padStart(2, '0') + 'x'.repeat(18));
  document.intent_kinds = kinds.map(kind => ({...document.intent_kinds[0], kind}));
  document.world_interaction.actions.kinds = kinds;
  const bytes = encoder.encode(JSON.stringify(document));
  const states = Object.fromEntries(kinds.map(kind => [kind, view.actions.kinds['reading.annotate']!]));
  const value = {...view, verified: {...view.verified, manifestBytes: bytes, capabilityRevision: cidFromCanonical(bytes)},
    actions: {...view.actions, kinds: states}, privateMessages: {...view.privateMessages, kinds: states}};
  for (const session of ['pinned-session', '𠀀'.repeat(256)]) {
    const response = await runWorldCapabilitiesCommand(sessionContext(value, session), {house: value.verified.house.origin});
    expect(response.code).toBe('CAPABILITY_SUMMARY_TOO_LARGE');
    const args = (response.agent_context as any).read.arguments;
    expect(args.expected_session_id).toBe(session);
    expect(args.expected_capability_revision).toBe(value.verified.capabilityRevision);
    expectBoundedResponse(response);
    const changed = await runWorldCapabilitiesCommand(sessionContext(value, 'replacement-session'), args);
    expect(changed.agent_context).toMatchObject({status: 'unavailable', code: 'HOUSE_SESSION_CHANGED'});
  }
});
it('bounds final guide, kind and schema views after runtime session references without losing page bytes', async () => {
  const guide = 'x'.repeat(3490), {view, params} = fixture(guide, 14000), session = '𠀀'.repeat(256);
  const context = sessionContext(view, session), base = {house: view.verified.house.origin, expected_session_id: session,
    expected_capability_revision: view.verified.capabilityRevision};
  const selected = await runWorldCapabilitiesCommand(context, {...base, kind: 'reading.annotate'});
  expectBoundedResponse(selected);
  for (const schema of [undefined, 'params'] as const) {
    let offset = 0, text = '', digest = '';
    do {
      const response = await runWorldCapabilitiesCommand(context, {...base, ...(schema ? {kind: 'reading.annotate', schema, schema_offset: offset} : {guide_offset: offset})});
      expectBoundedResponse(response);
      const material = response.agent_context as any;
      expect(material.status).toBe('available');
      expect(material.session_id).toBe(session);
      expect(material.read.arguments.expected_session_id).toBe(session);
      const chunk = schema ? material.schema_page : material.guide;
      expect(chunk.offset).toBe(offset);
      digest ||= chunk.sha256;
      expect(chunk.sha256).toBe(digest);
      text += chunk.text;
      if (chunk.next_offset === null) break;
      expect(chunk.next_offset).toBeGreaterThan(offset);
      expect(material.read.arguments[schema ? 'schema_offset' : 'guide_offset']).toBe(chunk.next_offset);
      offset = chunk.next_offset;
    } while (offset < 32768);
    expect(text).toBe(schema ? JSON.stringify(params) : guide);
    expect(cidFromCanonical(encoder.encode(text))).toBe(digest);
  }
});
it('applies the same final budget to login material while preserving connected status', async () => {
  const {view} = fixture('x'.repeat(3490)), session = '𠀀'.repeat(256);
  const ctx: HouseCommandContext = {
    coordinator: () => ({loginHouse: async () => ({status: 'connected', scope: 'full', sessionId: session})}) as unknown as ReturnType<HouseCommandContext['coordinator']>,
    readAgentContext: () => sessionContext(view, session).readAgentContext!({house: view.verified.house.origin}),
  };
  const text = await runHouseLoginCommand(ctx, view.verified.house.origin);
  expect(worldContextTextCost(text)).toBeLessThanOrEqual(14000);
  const response = JSON.parse(text.slice(text.indexOf('\n') + 1));
  expect(response).toMatchObject({login_status: 'connected', agent_context: {status: 'available', session_id: session}});
  const material = response.agent_context;
  expect(material.read.arguments.expected_session_id).toBe(session);
  expect(material.guide.next_offset).toBe(Array.from(material.guide.text).length);
});
it('reports a material limit with the original unread offset when only bound metadata fits', async () => {
  const {view} = fixture('x'.repeat(3490)), session = '𠀀'.repeat(256);
  const original = await sessionContext(view, session).readAgentContext!({house: view.verified.house.origin, guide_offset: 10});
  const before = JSON.stringify(original);
  const render = (material: unknown) => JSON.stringify({padding: 'x'.repeat(4000), agent_context: material});
  const result = boundWorldAgentContext(original, render);
  expect(worldContextTextCost(render(result))).toBeLessThanOrEqual(14000);
  expect(result).toMatchObject({status: 'unavailable', code: 'WORLD_CONTEXT_SIZE_LIMIT', session_id: session,
    read: {arguments: {guide_offset: 10, expected_session_id: session, expected_capability_revision: view.verified.capabilityRevision}}});
  expect(JSON.stringify(original)).toBe(before);
});
