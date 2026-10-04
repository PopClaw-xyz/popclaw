/** Normal tool registration with real read clients and synthetic transports only. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { makeToolCollector, dispatchMcpCall, toMcpToolError } from '../../../src/tools/mcp-adapter.js';
import { GuideClient } from '../../../src/world/guide-client.js';
import { WorldSummaryClient } from '../../../src/world/world-summary-client.js';
import { ActionInactiveError } from '../../../src/runtime/house-lifecycle/action-context.js';
import { failureText, setOwnerLang } from '../../../src/lexicon/owner-language.js';
import type { PluginRuntime } from '../../../src/runtime/plugin-runtime.js';
import { invalidSummaryDeclarations } from '../../helpers/summary-declaration-cases.js';

const origin = 'https://summary-firstuse.invalid';
// Exact static guide from REF65a; public-stream/actions declarations are NOT summary declarations.
const referenceGuide = readFileSync(new URL('../../fixtures/world/reference-house-guide-65a.md', import.meta.url), 'utf8');
const referenceBoard = { public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1' },
  actions: { status_endpoint: '/v1/world-actions/status', kinds: ['rangermap.check_in'] },
  guide: { path: '/v1/guide.md', revision: 'rangermap-guide-2' } };
const socialGuide = readFileSync(new URL('../../fixtures/world/guide.md', import.meta.url), 'utf8');
const summary = { window_hours: 1, generated_at_ms: 0, total_posts: 17, distinct_authors: 4,
  authors: {}, hot_posts: [] };

function setup(guide: string = referenceGuide, response: () => Promise<Response> = async () => Response.json(summary),
  guideResponse: () => Promise<Response> = async () => new Response(guide), mountedGuide?: string) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const transport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url) === `${origin}/v1/guide.md`) return guideResponse();
    if (String(url).startsWith(`${origin}/v1/world-summary`)) return response();
    throw new Error('Unexpected egress');
  });
  const snapshot = vi.fn(async () => []);
  const collector = makeToolCollector();
  registerPopclawTools({ api: collector.api, runtime: async () => ({} as PluginRuntime),
    getWorldDeps: async () => ({ guideClient: new GuideClient({ baseUrl: origin, fetch: transport }),
      summaryClient: new WorldSummaryClient({ baseUrl: origin, fetch: transport }),
      snapshotClient: { fetchSnapshot: snapshot }, resolveClient: { resolve: async () => [] }, webBaseUrl: origin,
      ...(mountedGuide ? { mountedGuides: () => [{ slug: 'other-house', houseName: 'Other House', guide: mountedGuide }] } : {}) }) });
  const tool = collector.tools.find(t => t.name === 'popclaw_world_summary')!;
  return { ...collector, tool, requests, snapshot };
}

describe('summary declaration at the real registered first-use tool', () => {
  it.each(invalidSummaryDeclarations)('refuses raw %s before summary/snapshot even if the display parser can repair it', async (_name, guide) => {
    const h = setup(guide);
    await expect(h.tool.execute('raw-declaration', {})).rejects.toThrow('WORLD_SUMMARY_AVAILABILITY_UNKNOWN');
    expect(h.requests.map(r => r.url)).toEqual([`${origin}/v1/guide.md`]);
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('REF65a guide + public/action board refuse unsupported without requesting summary or snapshot', async () => {
    setOwnerLang('en', 'config');
    expect(referenceBoard.public_stream).toBeDefined();
    const h = setup(referenceGuide, async () => new Response('not found', { status: 404 }));
    await expect(h.tool.execute('native-summary', { window_hours: 1 })).rejects.toThrow('WORLD_SUMMARY_UNSUPPORTED');
    expect(h.requests.map(r => r.url)).toEqual([`${origin}/v1/guide.md`]);
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it.each(['', 'http', 'rest'])('a declared social summary (%s transport) fetches real JSON at the fixed primary-House endpoint', async transport => {
    setOwnerLang('en', 'config');
    const guide = transport ? socialGuide.replace('    endpoint: /v1/world-summary', `    endpoint: /v1/world-summary\n    transport: ${transport}`) : socialGuide;
    const h = setup(guide);
    const result = await h.tool.execute('summary', { window_hours: 1 }) as { text: string };
    expect(result.text).toContain('17');
    expect(result.text).toContain('4');
    expect(h.requests.map(r => r.url)).toEqual([`${origin}/v1/guide.md`, `${origin}/v1/world-summary?window_hours=1`]);
    for (const r of h.requests) {
      expect(new Headers(r.init?.headers).has('authorization')).toBe(false);
      expect(new Headers(r.init?.headers).has('cookie')).toBe(false);
    }
  });

  it.each(['http', 'network', 'parse', 'local'] as const)('declared summary keeps %s failure, never an empty-world success', async kind => {
    const response = async () => {
      if (kind === 'network') throw new TypeError('secret-network-diagnostic');
      if (kind === 'local') throw new ActionInactiveError('HOUSE_TRUST_REVOKED', origin);
      return new Response(kind === 'parse' ? '<html>not summary</html>' : 'private response body', { status: kind === 'http' ? 404 : 200 });
    };
    const code = { http: 'HOUSE_REMOTE_HTTP', network: 'HOUSE_REMOTE_NETWORK', parse: 'HOUSE_REMOTE_PARSE', local: 'HOUSE_TRUST_REVOKED' }[kind];
    const h = setup(socialGuide, response);
    await expect(dispatchMcpCall(h.tool, { window_hours: 1 }, { requestId: 'summary' })).rejects.toThrow(code);
  });

  it.each(['http', 'network', 'local', 'empty', 'malformed', 'html'] as const)('guide %s is unknown, not an unsupported declaration', async kind => {
    const h = setup('', undefined, async () => {
      if (kind === 'network') throw new TypeError('guide network diagnostic');
      if (kind === 'local') throw new ActionInactiveError('HOUSE_TRUST_REVOKED', origin);
      return new Response(kind === 'malformed' ? '---\nstreams:\n' : kind === 'html' ? '<html>gateway error</html>' : '',
        { status: kind === 'http' ? 404 : 200 });
    });
    await expect(h.tool.execute('summary', {})).rejects.toThrow('WORLD_SUMMARY_AVAILABILITY_UNKNOWN');
    expect(h.requests.map(r => r.url)).toEqual([`${origin}/v1/guide.md`]);
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.invalid/v1/world-summary', '//attacker.invalid/v1/world-summary',
    'http://user:secret@attacker.invalid/v1/world-summary', 'file:///private/secret', '/v1/world-summary?token=secret',
    '/v1/../v1/world-summary', ''])('unsafe or incomplete summary declaration is refused: %s', async endpoint => {
    const h = setup(`---\nstreams:\n  - name: summary\n    endpoint: ${endpoint}\n---\n# House`);
    await expect(h.tool.execute('summary', {})).rejects.toThrow('WORLD_SUMMARY_AVAILABILITY_UNKNOWN');
    expect(h.requests.map(r => r.url)).toEqual([`${origin}/v1/guide.md`]);
  });

  it('a mounted non-primary summary declaration cannot enable the primary House', async () => {
    const h = setup(referenceGuide, undefined, undefined, socialGuide);
    const guide = h.tools.find(t => t.name === 'popclaw_world_guide')!;
    expect(guide.description).toContain('only');
    expect(h.tool.description).toContain('primary');
    expect((await guide.execute('guide', {}) as { text: string }).text).toContain('Other House');
    await expect(h.tool.execute('summary', {})).rejects.toThrow('WORLD_SUMMARY_UNSUPPORTED');
  });

  it.each(['    transport: sse', '  - name: summary\n    endpoint: /v1/world-summary'])('inconsistent summary metadata is unknown: %s', async extra => {
    const h = setup(`---\nstreams:\n  - name: summary\n    endpoint: /v1/world-summary\n${extra}\n---\n# House`);
    await expect(h.tool.execute('summary', {})).rejects.toThrow('WORLD_SUMMARY_AVAILABILITY_UNKNOWN');
    expect(h.requests.map(r => r.url)).toEqual([`${origin}/v1/guide.md`]);
  });

  it('the shipped recipe and registered descriptions agree on optional primary-House summary', () => {
    const skill = readFileSync(new URL('../../../skills/popclaw-social/SKILL.md', import.meta.url), 'utf8');
    const h = setup();
    expect(skill).toContain('only if the primary House guide declares a `summary` stream at `/v1/world-summary`');
    expect(skill).toContain('feed as a full summary or ranking');
    expect(h.tools.find(t => t.name === 'popclaw_world_guide')!.description).toContain('only when the PRIMARY House guide');
    expect(h.tool.description).toContain('only if its guide declares a summary stream');
  });

  it.each(['unsupported', 'unknown', 'http'] as const)('normal native rejection becomes an MCP isError result: %s', async kind => {
    const h = kind === 'http' ? setup(socialGuide, async () => new Response('secret body', { status: 404 }))
      : kind === 'unknown' ? setup('', undefined, async () => new Response('', { status: 503 })) : setup();
    const response = await dispatchMcpCall(h.tool, {}, { requestId: 'summary' })
      .then(() => { throw new Error('Unexpected successful business call'); }, error =>
        toMcpToolError(failureText(h.tool.name, error instanceof Error ? error.message : error)));
    expect(response.isError).toBe(true);
    const block = response.content[0]!;
    expect(block.type).toBe('text');
    if (block.type !== 'text') throw new Error('Expected text error content');
    const text = block.text;
    expect(text).toContain(kind === 'unsupported' ? 'WORLD_SUMMARY_UNSUPPORTED'
      : kind === 'unknown' ? 'WORLD_SUMMARY_AVAILABILITY_UNKNOWN' : 'HOUSE_REMOTE_HTTP');
    expect(text).not.toContain('secret body');
  });
});
