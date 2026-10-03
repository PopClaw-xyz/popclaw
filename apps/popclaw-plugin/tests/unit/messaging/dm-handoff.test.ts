import { spawnSync } from 'node:child_process';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { popclaw } from '@popclaw/contracts';
import { readInboxMessage } from '../../../src/host/inbox-content.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { makeNotificationsTool } from '../../../src/notifier/mcp-notice.js';
import { notifyOwnerNow } from '../../../src/notifier/owner-notifier.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { saveDmMedia } from '../../../src/messaging/dm-media.js';
import { SqliteNotifier, DM_DELIVERY_LEASE_SECONDS } from '../../../src/notifier/sqlite-notifier.js';
import { makeDmNotificationPolicy } from '../../../src/runtime/dm-notification-policy.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function setup() {
  const db = new InMemoryHostDb();
  cleanup.push(() => db.close());
  runMigrations(db, resolve('migrations'));
  const inbox = new InboxStore(db);
  const notifier = new SqliteNotifier(db, () => 123);
  const received = inbox.recordReceived({ ts: 10, fromPopclawId: 'alice', toPopclawId: 'bob', body: 'fix the button', receivedAtMs: 100 });
  return { db, inbox, notifier, received };
}

describe('durable DM handoff', () => {
  it('two different pictures from the same sender in a minute cannot overwrite', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'popclaw-media-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const meta = { ts: 100, fromPopclawId: 'alice' };
    const naming = { sigilOf: () => 'alice' };
    const a = saveDmMedia(dir, meta, { mime: 'image/png', bytes: new Uint8Array([1, 2]) }, undefined, naming)!;
    const b = saveDmMedia(dir, meta, { mime: 'image/png', bytes: new Uint8Array([3, 4]) }, undefined, naming)!;
    expect(b).not.toBe(a);
    expect([...readFileSync(a)]).toEqual([1, 2]);
    expect(saveDmMedia(dir, meta, { mime: 'image/png', bytes: new Uint8Array([1, 2]) }, undefined, naming)).toBe(a);
  });

  it('recovers an inbox insert before policy, queues once across consumers', async () => {
    const { inbox, notifier, received } = setup();
    const push = vi.fn();
    const policy = makeDmNotificationPolicy({ inbox, notifier, graph: { following: () => [{ popclawId: 'alice' }] }, verdictOf: () => ({ blocked: false }), vipThreshold: 0, nameOf: (id) => id, onQueued: push });
    await policy.recover();
    await policy.handle(received.item);
    expect(notifier.count('L1')).toBe(1);
    expect(push).toHaveBeenCalledOnce();
    expect(inbox.get(received.item.id)?.notificationState).toBe('queued');
  });

  it('first external-standing lookup queues with bond context; a block during lookup vetoes', async () => {
    const { inbox, notifier, received } = setup();
    let followers: number | undefined;
    let blocked = false;
    let release!: () => void;
    const refresh = vi.fn(async () => { await new Promise<void>((r) => { release = r; }); followers = 500; });
    const policy = makeDmNotificationPolicy({ inbox, notifier, graph: { following: () => [] }, verdictOf: () => ({ blocked, verifiedFollowerCount: followers }), vipThreshold: 100, refresh, nameOf: (id) => id, bondContext: () => 'we met yesterday' });
    const first = policy.handle(received.item);
    blocked = true; release(); await first;
    expect(notifier.count()).toBe(0);
    const next = inbox.recordReceived({ ...received.item, ts: 11, body: 'another message' });
    blocked = false; followers = undefined;
    const second = policy.handle(next.item); release(); await second;
    expect(notifier.drain()[0]?.payload.bondLine).toBe('we met yesterday');
  });

  it('a logout and re-login during profile lookup cannot enqueue the old generation', async () => {
    const { inbox, notifier, received } = setup();
    let generation = 1;
    let release!: () => void;
    let followers: number | undefined;
    const refresh = vi.fn(async () => { await new Promise<void>(r => { release = r; }); followers = 500; });
    const controller = new AbortController();
    const policy = makeDmNotificationPolicy({
      inbox, notifier, graph: { following: () => [] }, vipThreshold: 100, nameOf: id => id,
      verdictOf: () => ({ blocked: false, verifiedFollowerCount: followers }), refresh,
      gateForHouse: () => { const captured = generation; return { signal: controller.signal, isActive: () => captured === generation }; },
    });
    const pending = policy.handle(received.item);
    generation = 3;
    release();
    await pending;
    expect(notifier.count()).toBe(0);
    expect(inbox.get(received.item.id)?.notificationState).toBe('pending');
  });

  it('disabled house recovery makes no profile request or notification', async () => {
    const { inbox, notifier } = setup();
    const refresh = vi.fn();
    const policy = makeDmNotificationPolicy({
      inbox, notifier, graph: { following: () => [] }, vipThreshold: 100, nameOf: id => id,
      verdictOf: () => ({ blocked: false }), refresh,
      gateForHouse: () => ({ signal: new AbortController().signal, isActive: () => false }),
    });
    await policy.recover();
    expect(refresh).not.toHaveBeenCalled();
    expect(notifier.count()).toBe(0);
  });

  it('transport reads stay pending until this consumer acknowledges, other hosts cannot erase them', async () => {
    const { notifier } = setup();
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { messageId: 1 } });
    notifier.bindConsumer('codex:project-A');
    const a = notifier.peekFor('claude:project-A');
    expect(notifier.peekFor('claude:project-A')).toEqual(a);
    notifier.drain('L1');
    expect(notifier.peekFor('codex:project-A')).toHaveLength(1);
    notifier.acknowledgeFor('claude:project-A', a.map((n) => n.id));
    expect(notifier.peekFor('claude:project-A')).toHaveLength(0);
    expect(notifier.peekFor('codex:project-A')).toHaveLength(1);
  });
  it('native delivery observes a queue admitted by MCP, independently of the winner', async () => {
    const { inbox, notifier } = setup();
    const policy = makeDmNotificationPolicy({ inbox, notifier, graph: { following: () => [{ popclawId: 'alice' }] }, verdictOf: () => ({ blocked: false }), vipThreshold: 0, nameOf: (id) => id });
    await policy.recover();
    notifier.bindConsumer('codex:A');
    const deliverNow = vi.fn(async () => true);
    const tick = () => notifyOwnerNow({ notifier, owner: { deliverNow }, resolveTarget: async () => ({ sessionKey: 'test', deliveryContext: { channel: 'test', to: 'owner' } }), logger: { info() {}, warn() {} } });
    expect(await tick()).toBe('channel');
    expect(await tick()).toBe('nothing');
    expect(deliverNow).toHaveBeenCalledOnce();
    expect(notifier.peekFor('codex:A')).toHaveLength(1);
  });

  it('stale proposal pages cannot hide a later actionable DM', async () => {
    const { notifier } = setup();
    for (let i = 0; i < 100; i++) notifier.enqueue({ level: 'L2', kind: 'bond_proposal', payload: { popclawId: 'alice', toTier: 'friend' } });
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { messageId: 1, body: 'ACTIONABLE' } });
    const tool = makeNotificationsTool(async () => notifier, undefined, async () => ({ hasPendingFor: () => false }), { id: 'codex:A', store: async () => notifier });
    const result = await tool.execute('test', {}) as { text: string };
    expect(result.text).toContain('ACTIONABLE');
    expect(notifier.countFor('codex:A')).toBe(1);
    expect(notifier.count()).toBe(101); // Other host delivery is independent.
  });

  it('binding alone cannot acknowledge unseen notifications', () => {
    const { notifier } = setup();
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { messageId: 1 } });
    notifier.bindConsumer('codex:A');
    expect(notifier.acknowledgeFor('codex:A', [1, 999])).toEqual([]);
    expect(notifier.countFor('codex:A')).toBe(1);
    expect(notifier.peekFor('codex:A')).toHaveLength(1);
    expect(notifier.acknowledgeFor('codex:A', [1, 999])).toEqual([1]);
  });

  it('replay repairs an old collision-prone screenshot pointer on the same event', () => {
    const { db, inbox, received } = setup();
    const root = mkdtempSync(resolve(tmpdir(), 'popclaw-upgrade-media-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const paths = new PopclawPaths(root); mkdirSync(paths.dmMediaDir(), { recursive: true });
    const old = resolve(paths.dmMediaDir(), 'legacy-minute.png'); writeFileSync(old, 'wrong screenshot');
    const envelopeBytes = popclaw.event.EventEnvelope.encode({ eventId: 'SAME-EVENT' }).finish();
    db.execute('UPDATE inbox SET media_path = ?, envelope = ?, notification_state = ? WHERE id = ?', [old, envelopeBytes, 'legacy', received.item.id]);
    const bytes = new Uint8Array([1, 2, 3]);
    const mediaPath = saveDmMedia(paths.dmMediaDir(), { ts: 10, fromPopclawId: 'alice' }, { mime: 'image/png', bytes })!;
    const replay = inbox.recordReceived({ ...received.item, envelopeBytes, mediaPath });
    expect(replay.wasNew).toBe(false);
    expect(replay.item.id).toBe(received.item.id);
    expect(replay.item.notificationState).toBe('legacy');
    expect(inbox.page(100)).toHaveLength(1);
    expect(readInboxMessage(inbox, paths, received.item.id).images[0]?.data).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('failed attachments stay diagnosable and cannot turn into arbitrary file reads', () => {
    const { inbox, received } = setup();
    const root = mkdtempSync(resolve(tmpdir(), 'popclaw-unavailable-media-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const paths = new PopclawPaths(root); mkdirSync(paths.dmMediaDir(), { recursive: true });
    const item = inbox.recordReceived({ ...received.item, body: 'readable body', mediaCiphertext: new Uint8Array([9]) }).item;
    expect(JSON.parse(readInboxMessage(inbox, paths, item.id).text)).toMatchObject({ body: 'readable body', attachment: { status: 'unavailable' } });
    const outside = resolve(root, 'outside.png'); writeFileSync(outside, 'private file');
    inbox.recordReceived({ ...item, mediaCiphertext: new Uint8Array([9]), mediaPath: outside });
    const result = readInboxMessage(inbox, paths, item.id);
    expect(result.images).toEqual([]);
    expect(JSON.parse(result.text).attachment.status).toBe('unavailable');
  });

  it('durable native DM retries survive three failures with backoff and preserve MCP receipts', async () => {
    const { db } = setup();
    let now = 1000;
    const notifier = new SqliteNotifier(db, () => now);
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { messageId: 1, body: 'recover after network outage' } });
    notifier.enqueue({ level: 'L1', kind: 'reply', payload: { body: 'unrelated legacy delivery' } });
    notifier.bindConsumer('codex:A');
    const queue = notifier.dmDeliveryView();
    const deliverNow = vi.fn(async () => false);
    const tick = () => notifyOwnerNow({ notifier: queue, owner: { deliverNow }, now: () => now, resolveTarget: async () => ({ sessionKey: 'test', deliveryContext: { channel: 'test', to: 'owner' } }), logger: { info() {}, warn() {} } });
    for (const delay of [30, 60, 120]) {
      expect(await tick()).toBe('queued');
      expect(queue.count()).toBe(0);
      now += delay - 1;
      expect(await tick()).toBe('nothing');
      now++;
      expect(queue.count()).toBe(1);
    }
    expect(deliverNow).toHaveBeenCalledTimes(3);
    expect(notifier.count('L1')).toBe(2);
    deliverNow.mockResolvedValue(true);
    expect(await tick()).toBe('channel');
    expect(queue.count()).toBe(0);
    expect(notifier.count('L1')).toBe(1); // Legacy notification was not touched.
    expect(notifier.peekFor('codex:A')).toHaveLength(2);
  });

  it.each([false, true])('recovers a killed native claimant, including lost channel acknowledgement (%s)', (channelAccepted) => {
    const root = mkdtempSync(resolve(tmpdir(), 'popclaw-native-crash-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const file = resolve(root, 'social.db');
    const db = new LocalHostDb(file); cleanup.push(() => db.close()); runMigrations(db, resolve('migrations'));
    const inbox = new InboxStore(db);
    const item = inbox.recordReceived({ ts: 1, fromPopclawId: 'alice', toPopclawId: 'bob', body: 'survive a killed gateway', receivedAtMs: 1 }).item;
    let now = 1000;
    const notifier = new SqliteNotifier(db, () => now);
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { messageId: item.id, body: item.body } });
    notifier.bindConsumer('codex:still-unread');
    const marker = resolve(root, 'channel-accepted');
    const script = `
      import { writeFileSync, writeSync } from 'node:fs';
      import { LocalHostDb } from ${JSON.stringify(resolve('src/host/local-host-db.ts'))};
      import { SqliteNotifier } from ${JSON.stringify(resolve('src/notifier/sqlite-notifier.ts'))};
      const db = new LocalHostDb(process.argv[1]);
      const claim = new SqliteNotifier(db, () => 1000).drain('L1');
      writeSync(1, JSON.stringify(claim));
      if (${channelAccepted}) writeFileSync(process.argv[2], 'accepted but not confirmed locally');
      process.kill(process.pid, 'SIGKILL');
    `;
    const killed = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', script, file, marker], { encoding: 'utf8' });
    expect(killed.signal).toBe('SIGKILL');
    const abandoned = JSON.parse(killed.stdout);
    expect(abandoned).toHaveLength(1);
    expect(notifier.drain('L1')).toEqual([]); // A live claim excludes concurrent receivers.
    expect(notifier.count('L1')).toBe(1); // Claim was not recorded as channel delivery.
    now += DM_DELIVERY_LEASE_SECONDS;
    const recovered = notifier.drain('L1');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe(abandoned[0].id);
    expect(recovered[0]?.deliveryLeaseToken).not.toBe(abandoned[0].deliveryLeaseToken);
    notifier.confirmDelivery(abandoned); // Delayed response from an old claimant cannot settle the new claim.
    expect(notifier.retryDelivery(abandoned[0], { attempts: 999 })).toBe(false);
    expect(notifier.count('L1')).toBe(1);
    notifier.confirmDelivery(recovered);
    expect(notifier.count('L1')).toBe(0);
    expect(notifier.peekFor('codex:still-unread')).toHaveLength(1);
    expect(inbox.get(item.id)?.resolvedAtMs).toBeUndefined();
    if (channelAccepted) expect(readFileSync(marker, 'utf8')).toContain('accepted');
  });

});
