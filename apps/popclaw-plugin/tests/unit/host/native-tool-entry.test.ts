import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Type } from 'typebox';
import { renderL1 } from '../../../src/routing/lexicon.js';

type Tool = {name: string; description: string; parameters: unknown; execute(id: string, args: unknown): Promise<unknown>};
type Surface = {compactTools(tools: Tool[]): {tools: Tool[]}; cleanup(): void};
const req = createRequire(import.meta.url);
const sdkUrl = pathToFileURL(req.resolve('openclaw/plugin-sdk/agent-harness-tool-runtime')).href;
const surfaces: Surface[] = [];
afterEach(() => {surfaces.splice(0).forEach(s => s.cleanup()); vi.restoreAllMocks();});

async function surface(enabled = true) {
  // Actual pinned SDK bridge, synthetic capability/owner context; no model, host or network.
  const sdk = await import(sdkUrl) as {createAgentHarnessToolSurfaceRuntime(params: unknown): Surface};
  const runtime = sdk.createAgentHarnessToolSurfaceRuntime({config: {tools: {codeMode: {enabled: true, executor: 'node'}}},
    forceCodeModeControls: true, agentId: 'synthetic-main', sessionKey: 'agent:synthetic-main:main',
    sessionId: 'synthetic-chat', runId: 'synthetic-entry', modelToolsEnabled: true});
  surfaces.push(runtime);
  const call = vi.fn(async () => ({content: [{type: 'text', text: 'Synthetic current identity'}], details: {identity: 'synthetic-owner'}}));
  const tool: Tool = {name: 'popclaw_check_status', description: 'Synthetic PopClaw status for current tool entry', parameters: Type.Object({}), execute: call};
  const compacted = runtime.compactTools(enabled ? [tool] : []).tools;
  expect(compacted.map(t => t.name)).toContain('exec');
  expect(compacted.map(t => t.name)).not.toContain('popclaw_check_status');
  return {exec: compacted.find(t => t.name === 'exec')!, call};
}
const statusExample = (text: string) => /```javascript\n([\s\S]*?)\n```/.exec(text)?.[1];
const skill = () => readFileSync(resolve('skills/popclaw-social/SKILL.md'), 'utf8');

describe('native tool entry through the current host surface', () => {
  it('standing routing preserves direct-only inbox discovery before catalog lookup', () => {
    const text = renderL1();
    expect(text).toContain('popclaw_show_inbox is direct-only on OpenClaw CodeMode');
    expect(text).toContain('does not appear in the exec catalog');
    expect(text).toContain('For capabilities not exposed as direct tools');
  });

  it('uses the actual SDK catalog to invoke a capability absent from flat tools', async () => {
    const s = await surface();
    const result = await s.exec.execute('synthetic-call', {title: 'Read synthetic PopClaw identity', code:
      'const matches = await catalog.search("popclaw_check_status", {limit: 5}); const tool = matches.find(t => t.toolName === "popclaw_check_status"); if (!tool) throw new Error("PopClaw status unavailable"); return await tool({});'});
    expect(result).toMatchObject({details: {status: 'completed', value: {identity: 'synthetic-owner'}}});
    expect(s.call).toHaveBeenCalledTimes(1);
  });
  it.each([['standing routing', renderL1], ['shipped skill', skill]] as const)('%s supplies an executable first-use discovery example', async (_name, material) => {
    const text = material();
    const code = statusExample(text); expect(code).toBeTruthy();
    const s = await surface();
    const result = await s.exec.execute('synthetic-call', {title: 'Read synthetic PopClaw identity', code});
    expect(result).toMatchObject({details: {status: 'completed', value: {identity: 'synthetic-owner'}}});
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(text).toContain('direct tools');
    expect(text).toContain('exec');
  });
  it('reports an absent catalog capability without invoking a guessed flat tool', async () => {
    const s = await surface(false);
    const result = await s.exec.execute('synthetic-call', {title: 'Find synthetic PopClaw tools', code:
      'const matches = await catalog.search("popclaw_check_status", {limit: 5}); const tool = matches.find(t => t.toolName === "popclaw_check_status"); if (!tool) return {unavailable: true}; return await tool({});'});
    expect(result).toMatchObject({details: {status: 'completed', value: {unavailable: true}}});
    expect(s.call).not.toHaveBeenCalled();
  });
});
