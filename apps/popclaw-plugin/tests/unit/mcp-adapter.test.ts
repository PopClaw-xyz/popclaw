import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import { tmpdir } from 'node:os';
import { dispatchMcpCall, makeToolCollector, toInputSchema, toMcpContent, structuredToolResult, toMcpToolListing, toMcpToolResult } from '../../src/tools/mcp-adapter.js';
import { registerPopclawTools } from '../../src/tools/register-tools.js';

describe('mcp tool collector', () => {
  it('records registered tools and ignores non-tools', () => {
    const c = makeToolCollector();
    c.api.registerTool({ name: 'a', execute: async () => ({ text: 'x' }) });
    c.api.registerTool({ name: 'no-execute' });
    c.api.registerTool(null);
    expect(c.tools.map((t) => t.name)).toEqual(['a']);
  });

  it('exports the whole popclaw tool surface with no OpenClaw host', () => {
    const c = makeToolCollector();
    registerPopclawTools({
      api: c.api,
      runtime: async () => ({}) as never,
      getOrchestrator: async () => ({}) as never,
      getWorldDeps: async () => ({}) as never,
    });
    // The bridge's entire value proposition: one collector, the same tools.
    expect(c.tools.length).toBeGreaterThan(30);
    expect(c.tools.map((t) => t.name)).toContain('popclaw_check_status');
    // Every tool must be MCP-listable: unique name + JSON-Schema input.
    const names = c.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of c.tools) {
      expect(toInputSchema(t.parameters).type).toBe('object');
      expect(() => JSON.stringify(toInputSchema(t.parameters))).not.toThrow();
    }
  });
});

describe('toMcpToolListing', () => {
  /** Every lazy gate on, the way the MCP root wires them. */
  function mcpSurface() {
    const c = makeToolCollector();
    registerPopclawTools({
      api: c.api,
      runtime: async () => ({}) as never,
      inboundMediaDirs: [tmpdir()],
      getOrchestrator: async () => ({}) as never,
      getWorldDeps: async () => ({}) as never,
      getHouseCommandContext: async () => ({}) as never,
      getWorldCommandContext: async () => ({}) as never,
      bindMcpWorldInvoke: () => async () => undefined as never,
    } as unknown as Parameters<typeof registerPopclawTools>[0]);
    return c.tools;
  }

  it('lists every shared tool with its annotations, and the shared count stays 50', () => {
    const listed = mcpSurface().map(toMcpToolListing);
    expect(listed).toHaveLength(50);
    for (const t of listed) {
      expect(t.annotations, t.name).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
    }
    const byName = new Map(listed.map((t) => [t.name, t]));
    expect(byName.get('popclaw_send_draft')?.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    });
    expect(byName.get('popclaw_check_status')?.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    });
    expect(byName.get('popclaw_draft_reply')?.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
    });
  });

  it('omits annotations for a tool the table does not know rather than guessing', () => {
    const listed = toMcpToolListing({ name: 'x' });
    expect(listed).toEqual({ name: 'x', description: '', inputSchema: { type: 'object', properties: {} } });
    expect('annotations' in listed).toBe(false);
  });

  it('hands out a copy, so a host-side mutation cannot rewrite the table', () => {
    const [first] = mcpSurface().filter((t) => t.name === 'popclaw_check_status').map(toMcpToolListing);
    (first!.annotations as { readOnlyHint: boolean }).readOnlyHint = true;
    const [again] = mcpSurface().filter((t) => t.name === 'popclaw_check_status').map(toMcpToolListing);
    expect(again!.annotations?.readOnlyHint).toBe(false);
  });
});

describe('toInputSchema', () => {
  it('passes a typebox schema through as plain JSON Schema', () => {
    const s = toInputSchema(
      Type.Object({ q: Type.String({ description: 'query' }), n: Type.Optional(Type.Number()) }),
    );
    expect(s).toEqual({
      type: 'object',
      required: ['q'],
      properties: { q: { type: 'string', description: 'query' }, n: { type: 'number' } },
    });
    // No symbol keys survive (typebox tags schemas with [Kind]).
    expect(Object.getOwnPropertySymbols(s)).toHaveLength(0);
  });

  it('falls back to the empty object schema', () => {
    expect(toInputSchema(undefined)).toEqual({ type: 'object', properties: {} });
    expect(toInputSchema(Type.String())).toEqual({ type: 'object', properties: {} });
  });
});

describe('toMcpContent', () => {
  it('unwraps a text result', () => {
    expect(toMcpContent({ type: 'text', text: 'hi' })).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('JSON-serializes anything else', () => {
    expect(toMcpContent({ url: 'https://x' })).toEqual([
      { type: 'text', text: '{"url":"https://x"}' },
    ]);
    expect(toMcpContent(undefined)).toEqual([{ type: 'text', text: 'null' }]);
  });
});

describe('structured tool results', () => {
  it('preserves exact decimal revisions as structured JSON and matching readable content', () => {
    const data = { request_id: 'ab'.repeat(32), status: 'succeeded', result: { business_revision: '18446744073709551615' } };
    const toolResult = structuredToolResult(data);
    data.result.business_revision = '0';
    const response = toMcpToolResult(toolResult);
    expect(response.structuredContent).toEqual({ request_id: 'ab'.repeat(32), status: 'succeeded', result: { business_revision: '18446744073709551615' } });
    expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(response.structuredContent) }]);
    // MCP may append an unread notice without changing the structured payload.
    response.content.push({ type: 'text', text: 'unread notice' });
    expect(response.structuredContent?.result).toEqual({ business_revision: '18446744073709551615' });
    expect(toolResult.content).toHaveLength(1);
  });

  it('retains ordinary text/image output and leaves unmarked objects on the legacy lane', () => {
    const text = { type: 'text', text: 'hello', images: [{ data: 'AA==', mimeType: 'image/png' }] };
    expect(toMcpToolResult(text)).toEqual({ content: toMcpContent(text) });
    expect(toMcpToolResult({ result: { n: 1 } })).toEqual({ content: [{ type: 'text', text: '{"result":{"n":1}}' }] });
    expect(toMcpToolResult(undefined)).toEqual({ content: [{ type: 'text', text: 'null' }] });
  });

  it('does not silently round or stringify a non-JSON bigint', () => {
    expect(() => structuredToolResult({ revision: 18446744073709551615n })).toThrow();
    expect(structuredToolResult({})).toEqual({ content: [{ type: 'text', text: '{}' }], structuredContent: {} });
  });
});

describe('dispatchMcpCall', () => {
  const spy = () => { const seen: unknown[][] = []; return { seen, execute: async (...args: unknown[]) => { seen.push(args); return { text: 'ok' }; } }; };

  it('passes the request id through and forwards the arguments and the per-call signal', async () => {
    const tool = spy(), controller = new AbortController();
    await dispatchMcpCall(tool, { house: 'https://world.invalid' }, { requestId: 42, signal: controller.signal });
    expect(tool.seen).toEqual([['mcp_42', { house: 'https://world.invalid' }, controller.signal]]);
  });

  it('falls back to the clock for an id the owner-confirmation adapter would reject', async () => {
    // A JSON-RPC id is free-form text. Left raw, these would make every world
    // action on that host fail as OWNER_CONFIRMATION_INVOCATION_INVALID.
    for (const requestId of ['claude/code#7', 'req 7', 'a'.repeat(121), '']) {
      const tool = spy();
      await dispatchMcpCall(tool, undefined, { requestId });
      const [callId, args, signal] = tool.seen[0]!;
      expect(callId).toMatch(/^mcp_\d+$/);
      if (requestId) expect(callId).not.toContain(requestId);
      expect(args).toEqual({});
      expect(signal).toBeUndefined();
    }
  });
});
