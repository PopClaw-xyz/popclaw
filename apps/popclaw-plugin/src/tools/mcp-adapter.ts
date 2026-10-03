/**
 * OpenClaw tool registrations → MCP. Pure translation, no I/O, no node:*, so
 * it is unit-testable without booting the server (importing `src/mcp.ts`
 * installs a process-wide stdout guard — never do that from a test).
 *
 * `registerPopclawTools` only needs a structural `{ registerTool, logger? }`,
 * which is exactly why one collector exports the entire tool surface to any
 * host without a second registration table to keep in sync.
 */

import { toolAnnotations, type PopclawToolAnnotations } from './tool-annotations.js';

export interface CollectedTool {
  readonly name: string;
  readonly description?: string;
  /** typebox TSchema — already JSON Schema. */
  readonly parameters?: unknown;
  /** The third argument exists for the hosts that have a per-call abort signal
   *  (MCP's `CallToolRequest` extra); tools that do not need it simply ignore it. */
  readonly execute: (callId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * One MCP `tools/call` dispatch — call id, arguments and the per-call abort
 * signal in one place, so all three are observable from a unit test instead of
 * living only inside `src/mcp.ts` (which no test may import).
 *
 * The id is sanitised because a JSON-RPC request id is free-form text: the
 * owner-confirmation adapter only accepts `[A-Za-z0-9_.:-]`, so a host whose
 * ids carry a space, `/` or `#` would have EVERY world action refused as
 * OWNER_CONFIRMATION_INVOCATION_INVALID. The clock fallback costs nothing —
 * the id only has to be stable within the one call it names.
 */
export function dispatchMcpCall(
  tool: Pick<CollectedTool, 'execute'>,
  args: unknown,
  extra: { readonly requestId?: string | number; readonly signal?: AbortSignal },
): Promise<unknown> {
  const id = String(extra.requestId ?? '');
  return tool.execute(`mcp_${/^[A-Za-z0-9_.:-]{1,120}$/.test(id) ? id : Date.now()}`, args ?? {}, extra.signal);
}

export interface ToolCollector {
  readonly api: {
    registerTool: (tool: unknown, opts?: unknown) => void;
    logger: { info: (m: string) => void };
  };
  readonly tools: CollectedTool[];
}

/** A `{ registerTool }` api that records instead of registering. */
export function makeToolCollector(log: (m: string) => void = () => {}): ToolCollector {
  const tools: CollectedTool[] = [];
  const push = (t: unknown): void => {
    const tool = t as Partial<CollectedTool> | null;
    if (typeof tool?.name === 'string' && typeof tool.execute === 'function') {
      tools.push(tool as CollectedTool);
    }
  };
  return {
    tools,
    api: {
      // Handles BOTH registration shapes. The factory form `(toolCtx) => toolDef`
      // is what the newspaper pair uses (it reads toolCtx.sessionKey to detect the
      // dedicated workshop session, 2026-09-03 cut 1). Under MCP there is no
      // sessionKey — resolved with an empty context, which the newspaper tools
      // read as "not a workshop session" and treat exactly as before.
      registerTool: (tool: unknown) => {
        const resolved =
          typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({}) : tool;
        if (Array.isArray(resolved)) resolved.forEach(push);
        else push(resolved);
      },
      logger: { info: log },
    },
  };
}

/**
 * typebox schema → MCP `inputSchema`. Mechanical only: the JSON round-trip
 * drops typebox's symbol keys (`[Kind]`) and `undefined`s. Anything that is not
 * an object schema becomes the empty object schema MCP requires (a tool with no
 * declared input must still advertise `{"type":"object"}`).
 */
export function toInputSchema(parameters: unknown): Record<string, unknown> & { type: 'object' } {
  const plain: unknown =
    parameters === undefined || parameters === null
      ? {}
      : (JSON.parse(JSON.stringify(parameters)) as unknown);
  if (typeof plain !== 'object' || plain === null || (plain as Record<string, unknown>)['type'] !== 'object') {
    return { type: 'object', properties: {} };
  }
  return { ...(plain as Record<string, unknown>), type: 'object' };
}

/** One `tools/list` entry. */
export interface McpToolListing {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown> & { type: 'object' };
  readonly annotations?: PopclawToolAnnotations;
}

/**
 * A collected tool → its `tools/list` entry, hints included. The hints come
 * from the one table in tool-annotations.ts; a name it does not know is listed
 * without them (the spec's cautious defaults) instead of with a guess. Each
 * entry carries its own copy, so nothing a host does to a response can reach
 * the table.
 */
export function toMcpToolListing(tool: Pick<CollectedTool, 'name' | 'description' | 'parameters'>): McpToolListing {
  const annotations = toolAnnotations(tool.name);
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: toInputSchema(tool.parameters),
    ...(annotations ? { annotations: { ...annotations } } : {}),
  };
}

/**
 * popclaw tool result → MCP content. Tools return `{ type:'text', text }`;
 * anything else is JSON-serialized rather than dropped (v1 rule).
 */
export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface StructuredToolResult {
  content: McpContent[];
  structuredContent: Record<string, unknown>;
}

/** Shared opt-in result for structured commands. Host-readable content and MCP
 * structured data derive from the same JSON snapshot. Protocol uint64 values
 * must already be decimal strings; native bigint serialization fails loudly. */
export function structuredToolResult(value: Record<string, unknown>): StructuredToolResult {
  const text = JSON.stringify(value);
  const snapshot: unknown = JSON.parse(text);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('STRUCTURED_RESULT_OBJECT_REQUIRED');
  return { content: [{ type: 'text', text }], structuredContent: snapshot as Record<string, unknown> };
}

/** Keep existing tool returns unchanged unless they explicitly use the shared
 * structured result shape. Callers may append content without mutating data. */
export function toMcpToolResult(result: unknown): { content: McpContent[]; structuredContent?: Record<string, unknown> } {
  const r = result as Partial<StructuredToolResult> | null | undefined;
  if (Array.isArray(r?.content) && r.structuredContent && typeof r.structuredContent === 'object' && !Array.isArray(r.structuredContent)) {
    return structuredToolResult(r.structuredContent);
  }
  return { content: toMcpContent(result) };
}

export function toMcpContent(result: unknown): McpContent[] {
  const r = result as { text?: unknown; images?: Array<{ data: string; mimeType: string }> } | null | undefined;
  const content: McpContent[] = [{ type: 'text', text: typeof r?.text === 'string' ? r.text : JSON.stringify(result ?? null) }];
  for (const img of r?.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  return content;
}
