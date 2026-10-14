/** Run against an extracted package: node --import tsx ... <package-root> [packaged-node].
 * The harness keeps its development ABI; only packaged children use the optional Node. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { popclaw } from '@popclaw/contracts';
import { signDirectMessage } from '../../src/messaging/sign-message.js';
import { seedIdentity, startTestRelay } from './mcp-handoff-harness.js';

const packageRoot = resolve(process.argv[2]!);
const packagedNode = process.argv[3] ?? process.execPath;
const packagedNodeVersion = execFileSync(packagedNode, ['--version'], { encoding: 'utf8' }).trim();
const tmp = mkdtempSync(join(tmpdir(), 'popclaw-package-check-'));
const relay = await startTestRelay();
const sender = await seedIdentity(join(tmp, 'sender'), relay.url, 'Package Reporter');
const recipient = await seedIdentity(join(tmp, 'recipient'), relay.url, 'Package Developer');
relay.identities.add(sender.id); relay.identities.add(recipient.id);
const env = { ...process.env, POPCLAW_DATA_ROOT: recipient.root, POPCLAW_NOTIFICATION_CONSUMER: 'package-check', POPCLAW_RECEIVE_ON_START: '1' } as Record<string, string>;
const transport = new StdioClientTransport({ command: packagedNode, args: [join(packageRoot, 'dist/bundled/mcp.js')], cwd: tmp, env, stderr: 'pipe' });
const client = new Client({ name: 'package-check', version: '1' });
try {
  await client.connect(transport);
  const tools = await client.listTools(); assert(tools.tools.some((t) => t.name === 'popclaw_show_inbox'));
  await client.callTool({ name: 'popclaw_show_inbox', arguments: {} });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  const signed = await signDirectMessage(sender.signer, { toPopclawId: recipient.id, nickname: 'Package Reporter', body: 'PACKAGE-CHECK', media: { mime: 'image/png', bytes: png } });
  relay.emit(popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes).payload);
  let metadata: { notifications: Array<{ message_id: number }> } | undefined;
  for (let i = 0; i < 100; i++) {
    const result = await client.callTool({ name: 'popclaw_notifications', arguments: {} });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    metadata = JSON.parse(text.split('\n').at(-1)!);
    if (metadata?.notifications.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(metadata?.notifications.length, 1);
  const read = await client.callTool({ name: 'popclaw_show_inbox', arguments: { message_id: metadata!.notifications[0]!.message_id } });
  assert.equal((read.content as Array<{ type: string; data?: string }>).find((c) => c.type === 'image')?.data, png.toString('base64'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
    const hook = JSON.parse(execFileSync(packagedNode, [join(packageRoot, 'dist/bundled/mcp-hook.js'), event], { env, cwd: tmp }).toString());
    assert.equal(hook.hookSpecificOutput.hookEventName, event);
    assert.match(hook.hookSpecificOutput.additionalContext, /1 pending notifications/);
    assert.match(hook.hookSpecificOutput.additionalContext, /notification delivery already authorized for this conversation/);
    assert.match(hook.hookSpecificOutput.additionalContext, /Without that scope, mention only the pending count/);
    assert.doesNotMatch(hook.hookSpecificOutput.additionalContext, /Call popclaw_notifications, then read|PACKAGE-CHECK/);
  }
  console.log(JSON.stringify({ package: packageRoot, node: packagedNodeVersion, nodeExecutable: packagedNode, harnessNode: process.version, tools: tools.tools.length, runtime_boot: true, decrypted_image: true, packed_hook: true }));
} finally {
  await client.close(); await relay.close(); rmSync(tmp, { recursive: true, force: true });
}
