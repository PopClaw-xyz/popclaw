import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { popclaw } from '@popclaw/contracts';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { InboxStore } from '../../src/messaging/inbox-store.js';
import { signDirectMessage } from '../../src/messaging/sign-message.js';
import { connectMcp, seedIdentity, startTestRelay, pluginRoot } from '../helpers/mcp-handoff-harness.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanups.reverse()) await f(); cleanups.length = 0; });
const text = (r: unknown): string => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')?.text ?? '');
async function until<T>(read: () => T, accepts: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 150; i++) { const v = read(); if (accepts(v)) return v; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('Timed out waiting for real MCP ingress');
}

it('two MCP processes: encrypted screenshot → durable handoff → full image → pinned confirmed reply', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'popclaw-handoff-')); cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const relay = await startTestRelay(); cleanups.push(() => relay.close());
  const alice = await seedIdentity(join(tmp, 'alice'), relay.url, 'Test Reporter');
  const bob = await seedIdentity(join(tmp, 'bob'), relay.url, 'Test Developer');
  relay.identities.add(alice.id); relay.identities.add(bob.id);
  const a = await connectMcp(alice.root, 'claude:reporter'); cleanups.push(() => a.close());
  // Bob's client answers the root's owner-approval dialog; the reply below is
  // sent because of that answer and for no other reason.
  const b = await connectMcp(bob.root, 'codex:developer', { answerApprovals: 'approve' }); cleanups.push(() => b.close());
  const secondHost = await connectMcp(bob.root, 'claude:developer'); cleanups.push(() => secondHost.close());
  await b.call('popclaw_show_inbox'); await a.call('popclaw_show_inbox');
  await secondHost.call('popclaw_show_inbox');
  const db = new LocalHostDb(join(bob.root, 'vault/social/my-social-assets.db')); cleanups.push(() => db.close());
  const inbox = new InboxStore(db);
  const image = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(40_000)]);
  const signed = await signDirectMessage(alice.signer, { toPopclawId: bob.id, nickname: 'Test Reporter', body: 'CASE-IMG-1: the Save button overlaps the warning.', ts: 100, media: { bytes: image, mime: 'image/png' } });
  relay.emit(popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes).payload);
  const item = (await until(() => inbox.page(10), (rows) => rows[0]?.notificationState === 'queued'))[0]!;
  relay.emit(popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes).payload); // SSE replay cannot produce another notice.
  const notices = text(await b.call('popclaw_notifications'));
  expect(notices).toContain('CASE-IMG-1');
  expect(text(await b.call('popclaw_notifications'))).toBe(notices);
  const read = await b.call('popclaw_show_inbox', { message_id: item.id });
  expect(text(read)).toContain('Save button overlaps');
  expect((read.content as Array<{ type: string; data?: string }>).find((c) => c.type === 'image')?.data).toBe(image.toString('base64'));
  expect(readFileSync(item.mediaPath!)).toEqual(image);
  expect(inbox.get(item.id)?.resolvedAtMs).toBeUndefined();
  const hook = execFileSync(process.execPath, ['--import', join(pluginRoot, 'node_modules/tsx/dist/loader.mjs'), join(pluginRoot, 'src/mcp-hook.ts'), 'UserPromptSubmit'], { env: { ...process.env, POPCLAW_DATA_ROOT: bob.root, POPCLAW_NOTIFICATION_CONSUMER: 'codex:developer' } }).toString();
  expect(hook).toContain('pending notifications');
  const before = relay.frames.size;
  const draft = text(await b.call('popclaw_draft_message', { reply_to_message_id: item.id, body: 'CASE-IMG-1: fixed the Save spacing; please verify.' }));
  const token = /draft_id: (\S+)/.exec(draft)?.[1]; expect(token).toBeTruthy();
  expect(relay.frames.size).toBe(before); // Draft has not sent.
  const dialogsBefore = b.dialogs.length;
  const sent = text(await b.call('popclaw_send_draft', { draft_id: token! }));
  expect(sent).toContain('event_id:');
  // The owner was shown this exact letter and said yes once.
  expect(b.dialogs.length).toBe(dialogsBefore + 1);
  expect(b.dialogs.at(-1)!.shown).toContain('CASE-IMG-1');
  const reply = [...relay.frames.values()].map((v) => popclaw.event.EventEnvelope.decode(v)).find((e) => e.actor?.popclawId === bob.id)!;
  expect(reply.directMessage?.toPopclawId).toBe(alice.id);
  expect(reply.prevEventId).toBe(signed.eventId);
  expect(alice.signer.openDm(reply.directMessage!, bob.id)).toMatchObject({ ok: true, plaintext: 'CASE-IMG-1: fixed the Save spacing; please verify.' });
  const metadata = JSON.parse(notices.split('\n').at(-1)!);
  await b.call('popclaw_acknowledge_notifications', { notification_ids: metadata.notifications.map((n: { notification_id: number }) => n.notification_id) });
  expect(text(await secondHost.call('popclaw_notifications'))).toContain('CASE-IMG-1');
  expect(execFileSync(process.execPath, ['--import', join(pluginRoot, 'node_modules/tsx/dist/loader.mjs'), join(pluginRoot, 'src/mcp-hook.ts')], { env: { ...process.env, POPCLAW_DATA_ROOT: bob.root, POPCLAW_NOTIFICATION_CONSUMER: 'codex:developer' } }).toString().trim()).toBe('{}');
  expect(inbox.get(item.id)?.resolvedAtMs).toBeUndefined();
  await b.call('popclaw_show_inbox', { resolve_message_id: item.id }); expect(inbox.get(item.id)?.resolvedAtMs).toBeTypeOf('number');
  // A hook pointed at a missing root cannot mint an identity or a database.
  const missing = join(tmp, 'absent'); mkdirSync(missing);
  execFileSync(process.execPath, ['--import', join(pluginRoot, 'node_modules/tsx/dist/loader.mjs'), join(pluginRoot, 'src/mcp-hook.ts')], { env: { ...process.env, POPCLAW_DATA_ROOT: missing, POPCLAW_NOTIFICATION_CONSUMER: 'none' } });
  expect(readdirSync(missing)).toEqual([]);
}, 60_000);

it('restarts preserve offered receipts and catch up offline messages beyond the newest twenty', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'popclaw-restart-')); cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const relay = await startTestRelay(); cleanups.push(() => relay.close());
  const alice = await seedIdentity(join(tmp, 'alice'), relay.url, 'Restart Reporter');
  const bob = await seedIdentity(join(tmp, 'bob'), relay.url, 'Restart Developer');
  relay.identities.add(alice.id); relay.identities.add(bob.id);
  let host = await connectMcp(bob.root, 'codex:restart'); cleanups.push(() => host.close());
  await host.call('popclaw_show_inbox');
  const db = new LocalHostDb(join(bob.root, 'vault/social/my-social-assets.db')); cleanups.push(() => db.close());
  const inbox = new InboxStore(db);
  const send = async (body: string, ts: number) => {
    const signed = await signDirectMessage(alice.signer, { toPopclawId: bob.id, nickname: 'Restart Reporter', body, ts });
    relay.emit(popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes).payload);
  };
  await send('OLDEST: full context survives a restart. ' + 'evidence '.repeat(80), 200);
  const original = (await until(() => inbox.page(100), (rows) => rows[0]?.notificationState === 'queued'))[0]!;
  const offered = JSON.parse(text(await host.call('popclaw_notifications')).split('\n').at(-1)!);
  expect(offered.notifications).toHaveLength(1);
  await host.close(); // No receiver exists while the next messages arrive.
  for (let i = 0; i < 26; i++) await send(`OFFLINE-${i}`, 199 - i);
  host = await connectMcp(bob.root, 'codex:restart');
  await host.call('popclaw_show_inbox');
  await until(() => inbox.page(100), (rows) => rows.length === 27 && rows.every((r) => r.notificationState === 'queued'));
  const page1 = JSON.parse(text(await host.call('popclaw_show_inbox')));
  const page2 = JSON.parse(text(await host.call('popclaw_show_inbox', { before_id: page1.next_before_id })));
  expect(page1.messages).toHaveLength(20);
  expect(page2.messages).toHaveLength(7);
  const ids = [...page1.messages, ...page2.messages].map((m: { message_id: number }) => m.message_id);
  expect(new Set(ids).size).toBe(27);
  expect(page2.messages.some((m: { message_id: number }) => m.message_id === original.id)).toBe(true);
  const exact = JSON.parse(text(await host.call('popclaw_show_inbox', { message_id: original.id })));
  expect(exact.body).toBe(original.body); // No preview truncation or timestamp-cursor confusion.
  const recovered = JSON.parse(text(await host.call('popclaw_notifications')).split('\n').at(-1)!);
  expect(recovered.notifications).toHaveLength(27);
  expect(recovered.notifications).toContainEqual(offered.notifications[0]);
  await host.call('popclaw_acknowledge_notifications', { notification_ids: [offered.notifications[0].notification_id] });
  await host.close();
  host = await connectMcp(bob.root, 'codex:restart');
  const afterAck = JSON.parse(text(await host.call('popclaw_notifications')).split('\n').at(-1)!);
  expect(afterAck.notifications).toHaveLength(26);
  expect(afterAck.notifications).not.toContainEqual(offered.notifications[0]);
  expect(inbox.get(original.id)?.resolvedAtMs).toBeUndefined();
}, 60_000);
