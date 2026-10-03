/** Manual host acceptance fixture. All identities/content are disposable. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { popclaw } from '@popclaw/contracts';
import { seedIdentity, startTestRelay, pluginRoot, connectMcp } from './mcp-handoff-harness.js';
import { signDirectMessage } from '../../src/messaging/sign-message.js';

const root = process.argv[2]!;
const relay = await startTestRelay();
const reporter = seedIdentity(join(root, 'reporter-root'), relay.url, 'QA Reporter');
const developer = seedIdentity(join(root, 'developer-root'), relay.url, 'QA Developer');
relay.identities.add(reporter.id); relay.identities.add(developer.id);
for (const host of ['claude', 'codex']) {
  const project = join(root, `popclaw-mcp-test-${host}`); mkdirSync(project, { recursive: true });
  const config = { mcpServers: { popclaw: { command: process.execPath,
    args: ['--import', join(pluginRoot, 'node_modules/tsx/dist/loader.mjs'), join(pluginRoot, 'src/mcp.ts')],
    env: { POPCLAW_DATA_ROOT: developer.root, POPCLAW_NOTIFICATION_CONSUMER: `${host}:test-project`, POPCLAW_RECEIVE_ON_START: '1' } } } };
  writeFileSync(join(project, 'mcp.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(project, 'README.md'), 'Disposable PopClaw MCP collaboration acceptance project. Only synthetic test requests are authorized.\n');
}
// Register both project consumers before arrival, so either can finish first.
const c = await connectMcp(developer.root, 'claude:test-project');
const d = await connectMcp(developer.root, 'codex:test-project');
await c.call('popclaw_show_inbox'); await d.call('popclaw_show_inbox');
const signed = await signDirectMessage(reporter.signer, { toPopclawId: developer.id, nickname: 'QA Reporter', body: 'QA-HOST-STORY-20260906: checkout button overlaps the warning. Inspect the screenshot, identify the amount and visual check code, then send me your diagnosis as a confirmed PopClaw reply.', media: { bytes: readFileSync(join(root, 'checkout-overlap.png')), mime: 'image/png' } });
relay.emit(popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes).payload);
await new Promise((r) => setTimeout(r, 1500));
await c.close(); await d.close();
writeFileSync(join(root, 'fixture.json'), JSON.stringify({ relay: relay.url, reporter: reporter.id, developer: developer.id, event_id: signed.eventId }, null, 2));
console.log(JSON.stringify({ ready: true, root, relay: relay.url, event_id: signed.eventId }));
const interval = setInterval(() => {
  const messages = [...relay.frames.values()].map((bytes) => {
    const e = popclaw.event.EventEnvelope.decode(bytes); const dm = e.directMessage!;
    const recipient = dm.toPopclawId === reporter.id ? reporter : developer;
    const opened = recipient.signer.openDm(dm, dm.fromPopclawId!);
    return { event_id: e.eventId, reply_to: e.prevEventId, from: dm.fromPopclawId, to: dm.toPopclawId, body: opened.ok ? opened.plaintext : null };
  });
  writeFileSync(join(root, 'relay-messages.json'), JSON.stringify(messages, null, 2));
}, 1000);
process.once('SIGTERM', () => { clearInterval(interval); void relay.close().then(() => process.exit(0)); });
