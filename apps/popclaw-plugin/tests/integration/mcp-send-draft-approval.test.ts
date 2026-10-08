/** Ordinary sends use the client's normal chat confirmation, not elicitation.
 * This process test verifies dispatch and relay behavior, not human consent. */
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {connectMcp, seedIdentity, startTestRelay} from '../helpers/mcp-handoff-harness.js';
import {popclaw} from '@popclaw/contracts';
import {PopclawPaths} from '../../src/host/popclaw-paths.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {for (const f of cleanups.reverse()) await f(); cleanups.length = 0;});
const text = (r: unknown) => ((r as {content: Array<{type: string; text?: string}>}).content.find(c => c.type === 'text')?.text ?? '');
describe('ordinary local MCP send without an extra approval surface', () => {
  it('retains the reviewed manuscript/attachment across pressure and a real stdio restart; keeps consumer isolation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'popclaw-chat-retained-')); cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
    const relay = await startTestRelay(); cleanups.push(() => relay.close());
    const alice = await seedIdentity(join(dir, 'alice'), relay.url, 'Sender'), bob = await seedIdentity(join(dir, 'bob'), relay.url, 'Recipient');
    relay.identities.add(alice.id); relay.identities.add(bob.id);
    const manuscript = 'Retained actual full manuscript.\n'.repeat(25), attachment = join(dir, 'approved.txt');
    writeFileSync(attachment, 'Actual approved file bytes');
    const original = await connectMcp(alice.root, 'retained-chat');
    await original.call('popclaw_show_inbox');
    const before = relay.frames.size;
    const draft = text(await original.call('popclaw_draft_message', {recipient: bob.id, house: relay.url, body: manuscript, attachment_path: attachment}));
    const parsed = JSON.parse(draft);
    expect(parsed.owner_text).toContain(manuscript);
    expect(parsed.recipient_popclaw_id).toBe(bob.id);
    const id = parsed.draft_id; expect(id).toBeTypeOf('string');
    for (let n = 0; n < 20; n++) await original.call('popclaw_draft_message', {recipient: bob.id, body: `Pressure ${n}`, house: relay.url});
    expect(relay.frames.size).toBe(before); await original.close();
    writeFileSync(attachment, 'Changed path bytes');
    // Construction of the review-file holder used to erase copies older than
    // 30min. A new process must retain, then validate this same original copy.
    const review = new PopclawPaths(alice.root).draftReviewDir();
    for (const name of readdirSync(review)) utimesSync(join(review, name), new Date(0), new Date(0));
    const wrong = await connectMcp(alice.root, 'another-trusted-client');
    expect(text(await wrong.call('popclaw_send_draft', {draft_id: id}))).toContain('different conversation');
    expect(relay.frames.size).toBe(before); await wrong.close();
    const fresh = await connectMcp(alice.root, 'retained-chat'); cleanups.push(() => fresh.close());
    expect(JSON.parse(text(await fresh.call('popclaw_send_draft', {draft_id: id}))).event_id).toBeTypeOf('string');
    expect(fresh.dialogs).toHaveLength(0); expect(relay.frames.size).toBe(before + 1);
    const env = popclaw.event.EventEnvelope.decode([...relay.frames.values()].at(-1)!);
    expect(bob.signer.openDm(env.directMessage!, alice.id)).toMatchObject({ok: true, plaintext: manuscript});
    const dm = env.directMessage!;
    const media = bob.signer.openDmMedia({ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce}, alice.id);
    expect(media.ok && new TextDecoder().decode(media.bytes)).toBe('Actual approved file bytes');
    await fresh.call('popclaw_send_draft', {draft_id: id}); expect(relay.frames.size).toBe(before + 1);
  }, 60000);
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
    expect(JSON.parse(draft).owner_text).toContain(manuscript); expect(relay.frames.size).toBe(before);
    const id = JSON.parse(draft).draft_id;
    expect(JSON.parse(text(await client.call('popclaw_send_draft', {draft_id: id}))).event_id).toBeTypeOf('string');
    expect(client.dialogs).toHaveLength(0); expect(relay.frames.size).toBe(before + 1);
    await client.call('popclaw_send_draft', {draft_id: id});
    expect(relay.frames.size).toBe(before + 1);
  }, 30000);
});
