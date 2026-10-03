import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';

/**
 * `registerPopclawTools` returns a COUNT computed up front from which lazy deps
 * were provided (`popclaw_feedback`'s doctor report needs it before a single
 * tool is registered). That makes it a hand-maintained number sitting next to a
 * pile of conditional `api.registerTool` calls, and it drifted: a fully-wired
 * gateway logged "popclaw: registered 51 typed tools with OpenClaw main agent"
 * while 50 were registered and `contracts.tools` declared 50. The log and
 * `/popclaw doctor`'s verdict table are what a host operator compares against
 * the manifest, so a wrong count reads as a real sync bug.
 *
 * register-tools.test.ts already pins the NAME sets (registered ⇔
 * contracts.tools, and OPTIONAL_TOOLS ⇔ toolMetadata.optional). This file pins
 * the number, under every combination of the lazy gates, plus the fact that the
 * two MCP-surface-only notification tools stay out of the manifest.
 */

const MANIFEST_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../openclaw.plugin.json');

function readManifest(): { contracts: { tools: string[] } } {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as { contracts: { tools: string[] } };
}

/** Collects every tool actually handed to `api.registerTool`, and the count
 *  `registerPopclawTools` reported for the same call. */
function register(deps: Partial<Parameters<typeof registerPopclawTools>[0]>) {
  const names: string[] = [];
  const push = (tool: unknown) => {
    const t = tool as { name?: string; execute?: unknown } | null;
    if (t?.name && typeof t.execute === 'function') names.push(t.name);
  };
  const api = {
    registerTool: (tool: unknown) => {
      // Same two shapes register-tools.test.ts handles: plain object, or a
      // factory `(toolCtx) => toolDef` (the newspaper tools).
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({ agentId: 'main-agent', config: {} }) : tool;
      if (Array.isArray(resolved)) resolved.forEach(push);
      else push(resolved);
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  const reported = registerPopclawTools({
    api,
    runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    ...deps,
  });
  return { names, reported };
}

const ALL_GATES = {
  inboundMediaDirs: [tmpdir()],
  getOrchestrator: (async () => ({})) as unknown as Parameters<typeof registerPopclawTools>[0]['getOrchestrator'],
  getWorldDeps: (async () => ({})) as unknown as Parameters<typeof registerPopclawTools>[0]['getWorldDeps'],
  getHouseCommandContext: (async () => { throw new Error('REGISTRATION_MUST_NOT_BOOT'); }) as unknown as Parameters<typeof registerPopclawTools>[0]['getHouseCommandContext'],
  getWorldCommandContext: (async () => { throw new Error('REGISTRATION_MUST_NOT_BOOT'); }) as unknown as Parameters<typeof registerPopclawTools>[0]['getWorldCommandContext'],
};

describe('registerPopclawTools reported count', () => {
  it('matches the number of tools actually registered, for every lazy-gate combination', () => {
    const gateNames = Object.keys(ALL_GATES) as Array<keyof typeof ALL_GATES>;
    const mismatches: string[] = [];
    for (let mask = 0; mask < 1 << gateNames.length; mask++) {
      const deps: Record<string, unknown> = {};
      const on: string[] = [];
      gateNames.forEach((g, i) => {
        if (mask & (1 << i)) {
          deps[g] = ALL_GATES[g];
          on.push(g);
        }
      });
      const { names, reported } = register(deps);
      if (reported !== names.length) {
        mismatches.push(`[${on.join(',') || 'none'}] reported ${reported}, registered ${names.length}`);
      }
    }
    expect(mismatches, `registerPopclawTools' up-front count disagrees with reality:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('the fully-wired count equals contracts.tools length (what the model actually sees)', () => {
    const { names, reported } = register(ALL_GATES);
    const declared = readManifest().contracts.tools;
    expect(names.length).toBe(declared.length);
    expect(reported).toBe(declared.length);
  });

  it('the MCP-surface-only notification tools are neither registered nor declared', () => {
    // They exist only in src/mcp.ts: inside an MCP host PopClaw cannot push, so
    // the agent has to pull. On the OpenClaw surface the plugin delivers notices
    // itself, so adding them to contracts.tools would declare two tools that no
    // registration backs. See the comment above makeNotificationsTool in mcp.ts.
    const mcpOnly = ['popclaw_notifications', 'popclaw_acknowledge_notifications'];
    const { names } = register(ALL_GATES);
    const declared = readManifest().contracts.tools;
    for (const name of mcpOnly) {
      expect(names, `${name} must not be registered on the OpenClaw surface`).not.toContain(name);
      expect(declared, `${name} is MCP-only and must not be in contracts.tools`).not.toContain(name);
    }
  });
});
