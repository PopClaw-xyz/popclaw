/** Ordinary sends use the client's normal chat confirmation, not elicitation.
 * This process test verifies dispatch and relay behavior, not human consent. */
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {connectMcp, seedIdentity, startTestRelay} from '../helpers/mcp-handoff-harness.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {for (const f of cleanups.reverse()) await f(); cleanups.length = 0;});
const text = (r: unknown) => ((r as {content: Array<{type: string; text?: string}>}).content.find(c => c.type === 'text')?.text ?? '');
describe('ordinary local MCP send without an extra approval surface', () => {
  it('starts without form elicitation, drafts without sending, then sends once without a dialog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'popclaw-chat-confirm-')); cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
    const relay = await startTestRelay(); cleanups.push(() => relay.close());
    const alice = await seedIdentity(join(dir, 'alice'), relay.url, 'Sender'), bob = await seedIdentity(join(dir, 'bob'), relay.url, 'Recipient');
    relay.identities.add(alice.id); relay.identities.add(bob.id);
    const client = await connectMcp(alice.root, 'ordinary-chat'); cleanups.push(() => client.close());
    await client.call('popclaw_show_inbox');
    const before = relay.frames.size;
    const manuscript = 'Actual full manuscript.\nSecond paragraph.';
    const draft = text(await client.call('popclaw_draft_message', {recipient: bob.id, house: relay.url, body: manuscript}));
    expect(draft).toContain(manuscript); expect(relay.frames.size).toBe(before);
    const id = /draft_id: (\S+)/.exec(draft)![1]!;
    expect(text(await client.call('popclaw_send_draft', {draft_id: id}))).toContain('event_id:');
    expect(client.dialogs).toHaveLength(0); expect(relay.frames.size).toBe(before + 1);
    await client.call('popclaw_send_draft', {draft_id: id});
    expect(relay.frames.size).toBe(before + 1);
  }, 30000);
});
