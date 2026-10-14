import { describe, expect, it } from 'vitest';
import { registerNotificationTools } from '../../../src/tools/notification-tools.js';
import { makeNotificationsTool } from '../../../src/notifier/mcp-notice.js';

describe('notification tool host parity', () => {
  it('gives native and MCP hosts the same private-content scope and handoff instructions', () => {
    const tools: Array<{ name: string; description: string }> = [];
    registerNotificationTools({
      deps: {},
      api: { registerTool: (tool: { name: string; description: string }) => tools.push(tool) },
      runtime: async () => { throw new Error('registration must not start the runtime'); },
    } as unknown as Parameters<typeof registerNotificationTools>[0]);
    const native = tools.find(tool => tool.name === 'popclaw_notifications')!;
    const mcp = makeNotificationsTool(async () => { throw new Error('description only'); });
    expect(native.description).toBe(mcp.description);
    expect(native.description).toContain('Results can include private message bodies.');
    expect(native.description).toContain('Only call for an owner request or notification delivery already authorized for this conversation.');
    expect(native.description).toContain('no separate approval is needed');
  });
});
