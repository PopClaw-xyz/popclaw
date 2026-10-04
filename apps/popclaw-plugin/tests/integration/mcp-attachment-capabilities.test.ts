/** Capability audit: byte transport is deliberately separate from format parsing. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectMcp, seedIdentity, startTestRelay } from '../helpers/mcp-handoff-harness.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.reverse()) await f(); cleanup.length = 0; });
function text(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')?.text ?? '';
}

it('document/audio byte delivery is supported, but MCP returns only a local path; Word is rejected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-attachment-audit-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const relay = await startTestRelay(); cleanup.push(() => relay.close());
  const alice = await seedIdentity(join(root, 'alice'), relay.url, 'Attachment Reporter');
  const bob = await seedIdentity(join(root, 'bob'), relay.url, 'Attachment Developer');
  relay.identities.add(alice.id); relay.identities.add(bob.id);
  // The letter is only sent because the owner answered the root's approval
  // dialog — the same dialog a real Claude Code / Codex client renders.
  const sender = await connectMcp(alice.root, 'audit:sender', { answerApprovals: 'approve' }); cleanup.push(() => sender.close());
  const receiver = await connectMcp(bob.root, 'audit:receiver'); cleanup.push(() => receiver.close());
  await sender.call('popclaw_show_inbox'); await receiver.call('popclaw_show_inbox');
  // These are opaque synthetic transport fixtures, not evidence of document
  // parsing, playable audio, speech transcription or model comprehension.
  for (const ext of ['md', 'pdf', 'ogg', 'mp3', 'wav', 'm4a', 'amr']) {
    const bytes = Buffer.from(`ATTACHMENT-ONLY-CANARY-${ext}\n# transport fixture\n`);
    const path = join(root, `fixture.${ext}`); writeFileSync(path, bytes);
    const draft = text(await sender.call('popclaw_draft_message', { recipient: bob.id, house:relay.url, body: `AUDIT-${ext}`, attachment_path: path }));
    const token = /draft_id: (\S+)/.exec(draft)?.[1]; expect(token).toBeTruthy();
    const dialogsBefore = sender.dialogs.length;
    expect(text(await sender.call('popclaw_send_draft', { draft_id: token }))).toContain('event_id:');
    // Green because an owner answer exists, never because anything was skipped.
    expect(sender.dialogs.length).toBe(dialogsBefore + 1);
    expect(sender.dialogs.at(-1)!.shown).toContain(`AUDIT-${ext}`);
    let id: number | undefined;
    for (let i = 0; i < 100; i++) {
      const list = JSON.parse(text(await receiver.call('popclaw_show_inbox', { limit: 100 })));
      id = list.messages.find((m: { preview: string }) => m.preview === `AUDIT-${ext}`)?.message_id;
      if (id) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(id).toBeTypeOf('number');
    const read = await receiver.call('popclaw_show_inbox', { message_id: id });
    const metadata = JSON.parse(text(read));
    expect(metadata.attachment.status).toBe('local_file');
    expect(readFileSync(metadata.attachment.path)).toEqual(bytes);
    expect(metadata.attachment.path).toMatch(new RegExp(`\\.${ext}$`));
    expect((read.content as Array<{ type: string }>).every((c) => c.type === 'text')).toBe(true);
    expect(text(read)).not.toContain(`ATTACHMENT-ONLY-CANARY-${ext}`);
  }
  const before = relay.frames.size;
  for (const ext of ['doc', 'docx']) {
    const path = join(root, `unsupported.${ext}`); writeFileSync(path, 'extension rejection fixture');
    expect(text(await sender.call('popclaw_draft_message', { recipient: bob.id, house:relay.url, body: 'unsupported Word test', attachment_path: path }))).not.toContain('draft_id:');
  }
  expect(relay.frames.size).toBe(before);
}, 60_000);
