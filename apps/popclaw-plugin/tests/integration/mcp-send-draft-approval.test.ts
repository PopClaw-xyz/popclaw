/**
 * Over MCP, `popclaw_send_draft` sends only when the owner answered the root's
 * approval dialog — and the negative halves of that sentence, which are the
 * ones worth a real process.
 *
 * The positive case lives in `mcp-dm-handoff.test.ts` and
 * `mcp-attachment-capabilities.test.ts`, where the letter has somewhere to go.
 * Here nothing should reach the relay at all, so the relay's own frame count
 * is the whole assertion: "no error was thrown" would prove nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connectMcp, seedIdentity, startTestRelay, type ElicitationAnswer } from '../helpers/mcp-handoff-harness.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanups.reverse()) await f(); cleanups.length = 0; });
const text = (r: unknown): string => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')?.text ?? '');

async function drafted(answer?: ElicitationAnswer, body = 'APPROVAL-CANARY', extra: Record<string, unknown> = {},
  beforeConnect?: (root: string) => void) {
  const tmp = mkdtempSync(join(tmpdir(), 'popclaw-send-approval-')); cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const relay = await startTestRelay(); cleanups.push(() => relay.close());
  const alice = await seedIdentity(join(tmp, 'alice'), relay.url, 'Approval Sender');
  const bob = await seedIdentity(join(tmp, 'bob'), relay.url, 'Approval Recipient');
  relay.identities.add(alice.id); relay.identities.add(bob.id);
  beforeConnect?.(alice.root);
  const sender = await connectMcp(alice.root, 'audit:approval', answer === undefined ? {} : { answerApprovals: answer });
  cleanups.push(() => sender.close());
  await sender.call('popclaw_show_inbox');
  const draft = text(await sender.call('popclaw_draft_message', { recipient: bob.id, house:relay.url, body, ...extra }));
  const token = /draft_id: (\S+)/.exec(draft)?.[1];
  expect(token, 'the draft must carry a draft_id').toBeTruthy();
  const framesBefore = relay.frames.size;
  return { sender, relay, token: token!, framesBefore, bob, alice, draft };
}

describe('popclaw_send_draft over MCP without an owner answer', () => {
  it('a client that declares no form elicitation cannot be asked, and nothing is sent', async () => {
    const { sender, relay, token, framesBefore } = await drafted();

    const sent = text(await sender.call('popclaw_send_draft', { draft_id: token }));

    expect(relay.frames.size).toBe(framesBefore);
    // APPROVAL_SURFACE_ABSENT, in the sentence that reason family owns.
    expect(sent).toContain('no way to ask the owner');
    expect(sender.dialogs).toHaveLength(0);
    // The draft survives: the owner may still approve it inside its TTL.
    expect(text(await sender.call('popclaw_send_draft', { draft_id: token }))).toContain('no way to ask the owner');
  });

  it.each(['decline', 'cancel'] as const)('an owner who answers %s sends nothing and keeps the draft', async (answer) => {
    const { sender, relay, token, framesBefore } = await drafted(answer);

    const sent = text(await sender.call('popclaw_send_draft', { draft_id: token }));

    expect(relay.frames.size).toBe(framesBefore);
    expect(sender.dialogs).toHaveLength(1);
    // `decline` is a person saying no; `cancel` is the dialog going away.
    expect(sent).toContain(answer === 'decline' ? 'the owner did not approve it' : 'the approval dialog was closed without an answer');
    // Still there — and the proof is that the SAME owner approving the SAME
    // draft a moment later does send it. Nothing was consumed by saying no.
    sender.answerApprovalsWith('approve');
    const second = text(await sender.call('popclaw_send_draft', { draft_id: token }));
    expect(second).toContain('event_id:');
    expect(relay.frames.size).toBe(framesBefore + 1);
  });
});

describe('a one-line letter over MCP', () => {
  // Short enough to show whole, so no pointer layout is involved: the draft
  // number must still be on the confirmation, and it must be the draft sent.
  it('names the draft being sent, and labels the one input as sending it', async () => {
    const { sender, relay, token, framesBefore } = await drafted('approve', 'Short and whole.');

    const sent = text(await sender.call('popclaw_send_draft', { draft_id: token }));

    expect(sender.dialogs).toHaveLength(1);
    expect(sender.dialogs[0]!.message).toContain('Short and whole.');
    expect(sender.dialogs[0]!.shown).toContain(token);
    expect(sender.dialogs[0]!.rows).toEqual([]);
    expect(sent).toContain('event_id:');
    expect(relay.frames.size).toBe(framesBefore + 1);
  });
});

describe('an ordinary multi-line reply over MCP', () => {
  /**
   * Four lines, eighty-seven characters. It was once refused on a real Claude
   * Code host because the dialog laid rows out as five form fields; later it
   * got a five-field pointer layout. Now every MCP host gets the whole-text
   * layout as the dialog's message, and one confirmation.
   */
  const REPLY = [
    'I checked your screenshot.',
    'Shipping was missing.',
    'The total is now 396.',
    'The test passes.',
  ].join('\n');

  it('is asked about once and sent once', async () => {
    const { sender, relay, token, framesBefore } = await drafted('approve', REPLY);

    const sent = text(await sender.call('popclaw_send_draft', { draft_id: token }));

    expect(sender.dialogs).toHaveLength(1);
    // No field but the confirmation, and the complete letter in the message.
    expect(sender.dialogs[0]!.rows).toEqual([]);
    for (const line of REPLY.split('\n')) expect(sender.dialogs[0]!.message).toContain(line);
    // The explicit draft number the owner checks the confirmation against
    // (09-21 ruling) — the one the draft tool printed as `draft_id:`.
    expect(sender.dialogs[0]!.shown).toContain(token);
    expect(sent).toContain('event_id:');
    expect(relay.frames.size).toBe(framesBefore + 1);
  });
});

describe('an answer that arrives for a dialog the root no longer waits for', () => {
  /**
   * THROUGH THE REAL ROOT'S WIRING. The SDK hands an orphaned response to the
   * server's `onerror` and to nothing else; without `src/mcp.ts` assigning it,
   * a late approval vanished without a trace. The window cannot be shortened
   * below six minutes from outside, so this sends the orphan directly — the
   * same bytes a host sends when the owner answers after the window closed —
   * and reads the root's own log.
   */
  it('is logged by the root, content-free, and sends nothing', async () => {
    const { sender, relay, framesBefore } = await drafted('approve');
    const stderr: string[] = [];
    sender.transport.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk.toString('utf8')); });
    await sender.transport.send({
      jsonrpc: '2.0', id: 987_654,
      result: { action: 'accept', content: { confirm: true, secret: 'LATE-ANSWER-CANARY' } },
    } as never);
    const deadline = Date.now() + 5_000;
    while (!stderr.join('').includes('OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    const log = stderr.join('');
    expect(log).toContain('OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT');
    expect(log).not.toContain('LATE-ANSWER-CANARY');
    expect(relay.frames.size).toBe(framesBefore);
  });
});

describe('a long letter over the real MCP root: review copy, then a compact dialog (F1, 2026-09-28)', () => {
  /**
   * The 975-character DM a Codex desktop owner could not read in the dialog
   * (it opened at paragraph three). Through the real root: the draft tool
   * writes a read-only review copy under the data root and hands the agent a
   * link line to post; the dialog is compact and names that copy by digest
   * and path; approval sends the frozen snapshot once.
   */
  const fixture = (name: string): string =>
    fileURLToPath(new URL(`../fixtures/send-draft/${name}`, import.meta.url));
  const LETTER = ['CODEX-MAC-D2-0-34E8281-20260927-R2',
    ...readFileSync(fixture('r06-long-letter.txt'), 'utf8').split('\n').slice(1)].join('\n').trimEnd();
  const ATTACHMENT = fixture('R06-ATTACHMENT.txt');

  function reviewOf(draft: string, root: string, token: string): string {
    const m = /\[Review draft (\S+) — full text\]\((\/[^)\s]+)\)/.exec(draft);
    expect(m, 'no review link line in the draft tool result').not.toBeNull();
    expect(m![1]).toBe(token);
    expect(m![2]!.startsWith(join(root, 'data', 'review') + '/')).toBe(true);
    return m![2]!;
  }

  it('writes the copy, links it, asks compactly, and sends the snapshot once on approval', async () => {
    expect([...LETTER]).toHaveLength(975);
    const { sender, relay, token, framesBefore, bob, alice, draft } = await drafted('approve', LETTER);
    const path = reviewOf(draft, alice.root, token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(alice.root, 'data', 'review')).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, 'utf8')).toContain(LETTER);

    const sent = text(await sender.call('popclaw_send_draft', { draft_id: token }));

    expect(sender.dialogs).toHaveLength(1);
    const { message } = sender.dialogs[0]!;
    expect(message.split('\n')[0]).toMatch(/^To: /);
    expect(message.split('\n')[0]).toContain(bob.id.slice(0, 8));
    expect(message).toContain(`draft: ${token}`);
    expect(message.replace(/\n↪ /g, '')).toContain(path);
    expect(message).not.toContain(LETTER.split('\n').at(-1));
    expect(message).not.toContain('ctrl+o');
    expect(sent).toContain('event_id:');
    expect(relay.frames.size).toBe(framesBefore + 1);
    // Sent: its review copy is gone.
    expect(existsSync(path)).toBe(false);
  });

  it('declined with an attachment: nothing sent, the copy kept', async () => {
    const { sender, relay, token, framesBefore, alice, draft } = await drafted('decline', LETTER, { attachment_path: ATTACHMENT });
    const path = reviewOf(draft, alice.root, token);

    const sent = text(await sender.call('popclaw_send_draft', { draft_id: token }));

    const { message } = sender.dialogs[0]!;
    expect(message).toContain('R06-ATTACHMENT.txt (0.2 KB)');
    expect(sent).toContain('the owner did not approve it');
    expect(relay.frames.size).toBe(framesBefore);
    expect(existsSync(path)).toBe(true);
  });

  it('refuses an approval when the copy was edited, and sends nothing', async () => {
    const { sender, relay, token, framesBefore, alice, draft } = await drafted('approve', LETTER);
    const path = reviewOf(draft, alice.root, token);
    writeFileSync(path, readFileSync(path, 'utf8').replace('R2', 'R9'));

    const sent = text(await sender.call('popclaw_send_draft', { draft_id: token }));

    expect(sent).toContain('REVIEW_COPY_CHANGED_OR_MISSING');
    // Refused before the owner was asked.
    expect(sender.dialogs).toHaveLength(0);
    expect(relay.frames.size).toBe(framesBefore);
  });

  /** The root's own fallback: a review directory it cannot create leaves it
   *  without review copies, not stopped. A long draft then gets no link and
   *  the whole-text dialog, as before this path existed. */
  it('falls back to the whole-text dialog when the review directory cannot be created', async () => {
    const { sender, relay, token, framesBefore, draft } = await drafted('approve', LETTER, {}, (root) => {
      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(join(root, 'data', 'review'), 'a file where the directory would go');
    });
    expect(draft).not.toContain('Review draft');

    const sent = text(await sender.call('popclaw_send_draft', { draft_id: token }));

    expect(sender.dialogs).toHaveLength(1);
    expect(sender.dialogs[0]!.message).toContain('in full:');
    expect(sender.dialogs[0]!.message).toContain(LETTER.split('\n').at(-1)!);
    expect(sent).toContain('event_id:');
    expect(relay.frames.size).toBe(framesBefore + 1);
  });
});
