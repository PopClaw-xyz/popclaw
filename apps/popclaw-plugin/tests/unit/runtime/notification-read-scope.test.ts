import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { runtimeToolNoticeContext } from '../../../src/notifier/tool-notice.js';
import { makeNotificationsTool } from '../../../src/notifier/mcp-notice.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { publishStorageJson, registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { PendingInvitesStore, checkInviteOnce } from '../../../src/invite/pending-invites.js';
import { inviteWiring } from '../../../src/runtime/assembly/notifications.js';
import { MCP_DRIFT_PINS } from '../../../src/host/mcp-runtime-ports.js';
import type { Signer } from '../../../src/identity/signer.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';

const origin = 'https://notification.example';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-reader-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new LocalHostDb(join(root, 'social.db')); cleanups.push(() => db.close());
  runMigrations(db, fileURLToPath(new URL('../../../migrations', import.meta.url)));
  const paths = new PopclawPaths(root);
  publishStorageJson(paths.storageControlFile(), { version: 1, epoch: 'initial', mode: 'normal', reason: 'fixture', held: [], releases: {} });
  cleanups.push(registerStorageRuntime(db, paths));
  let now = 1_780_000_000_000;
  let pin = 'ab'.repeat(32);
  const houses = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer: {} as Signer, origins: [origin], clock: () => now, configuredPinFor: () => pin });
  cleanups.push(() => houses.stop());
  db.execute(`INSERT INTO house_participation(house_origin, installation_id, op_seq, desired, phase,
    session_id, house_revision, lease_expires_at, ack_key_hex)
    VALUES (?, 'installation', 3, 'enabled', 'connected', 'session', 17, ?, ?)`, [origin, now / 1000 + 90, pin]);
  const notifier = new SqliteNotifier(db, () => 1700000000);
  const rt = { notifier, inboxStore: new InboxStore(db), houseRuntime: houses };
  const enqueue = () => notifier.enqueue({ level: 'L2', kind: 'reply', payload: { body: 'PRIVATE-BODY', houseOrigin: origin } });
  const context = () => runtimeToolNoticeContext(rt, 'mcp:reader');
  const tool = () => makeNotificationsTool(async () => notifier, undefined, undefined, { id: 'mcp:reader', store: async () => notifier, context: async () => context() });
  const read = async () => JSON.parse((await tool().execute('test', {}) as { text: string }).text);
  return { db, paths, houses, notifier, enqueue, context, read, advance: () => { now += 100_000; }, changePin: () => { pin = 'cd'.repeat(32); }, restorePin: () => { pin = 'ab'.repeat(32); }, renew: () => { db.execute('UPDATE house_participation SET lease_expires_at=? WHERE house_origin=?', [now / 1000 + 90, origin]); } };
}

it('delivers pending local and House content from a reader without acquiring the stream lease', async () => {
  const f = fixture(); f.enqueue();
  f.notifier.enqueue({ level: 'L2', kind: 'system_notice', payload: {} });
  expect(f.houses.resident.authority.captureEpoch()).toBeNull();
  expect(f.houses.captureGate(origin).isActive()).toBe(false);
  expect((await f.read()).notifications).toHaveLength(2);
  expect(f.houses.resident.authority.captureEpoch()).toBeNull();
});

it.each([
  ['desired', 'disabled'], ['phase', 'connecting'], ['op_seq', 4], ['session_id', 'new'],
  ['house_revision', 18], ['installation_id', 'other'], ['ack_key_hex', 'cd'.repeat(32)],
] as const)('a captured notification read stays invalid after %s changes', (column, value) => {
  const f = fixture(); f.enqueue(); const context = f.context();
  f.db.execute(`UPDATE house_participation SET ${column}=? WHERE house_origin=?`, [value, origin]);
  expect(f.notifier.peekFor(context.consumerId, undefined, 50, context)).toEqual([]);
  expect(f.notifier.acknowledgeFor(context.consumerId, [1])).toEqual([]);
});

it.each(['expiry', 'pin', 'stop', 'storage'] as const)('keeps the existing %s boundary for pending delivery', async change => {
  const f = fixture(); f.enqueue(); const context = f.context();
  if (change === 'expiry') f.advance();
  if (change === 'pin') f.changePin();
  if (change === 'stop') await f.houses.stop();
  if (change === 'storage') publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'held', mode: 'recovery', reason: 'fixture', held: ['notifications'], releases: {} });
  expect(f.notifier.peekFor(context.consumerId, undefined, 50, context)).toEqual([]);
  expect(f.notifier.acknowledgeFor(context.consumerId, [1])).toEqual([]);
  expect(f.notifier.peekFor('explicit-history')).toHaveLength(1);
});

it('does not revive a captured local notice after storage recovery releases', () => {
  const f = fixture(); f.notifier.enqueue({ level: 'L2', kind: 'system_notice', payload: {} });
  const context = f.context();
  publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'restored', mode: 'normal', reason: 'fixture', held: [], releases: {} });
  expect(f.notifier.peekFor(context.consumerId, undefined, 50, context)).toEqual([]);
  expect(f.notifier.peekFor(context.consumerId, undefined, 50, f.context())).toHaveLength(1);
});

it('rechecks captured scope after asynchronous rendering inputs and does not offer revoked rows', async () => {
  const f = fixture(); f.enqueue();
  const tool = makeNotificationsTool(async () => f.notifier, async () => {
    f.db.execute("UPDATE house_participation SET desired='disabled', op_seq=4 WHERE house_origin=?", [origin]);
    return undefined;
  }, undefined, { id: 'mcp:reader', store: async () => f.notifier, context: async () => f.context() });
  const result = JSON.parse((await tool.execute('test', {}) as { text: string }).text);
  expect(result.notifications).toEqual([]);
  expect(f.notifier.acknowledgeFor('mcp:reader', [1])).toEqual([]);
});

it('keeps a failed local logout closed even when persistence still says connected', async () => {
  const f = fixture(); f.enqueue(); const context = f.context();
  const spy = vi.spyOn(f.db, 'transaction').mockImplementationOnce(() => { throw new Error('synthetic disk full'); });
  try { await expect(f.houses.manager.logoutHouse(origin)).rejects.toThrow('PERSISTENCE_FAILED'); }
  finally { spy.mockRestore(); }
  expect(f.db.queryOne<{ desired: string }>('SELECT desired FROM house_participation WHERE house_origin=?', [origin])?.desired).toBe('enabled');
  expect(f.notifier.peekFor(context.consumerId, undefined, 50, context)).toEqual([]);
  expect((await f.read()).notifications).toEqual([]);
  expect(f.notifier.acknowledgeFor(context.consumerId, [1])).toEqual([]);
});

it('reports unavailable delivery when the storage notification path is held', async () => {
  const f = fixture(); f.enqueue();
  publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'held', mode: 'recovery', reason: 'fixture', held: ['notifications'], releases: {} });
  await expect(f.read()).rejects.toThrow('NOTIFICATIONS_INACTIVE');
});


it.each(['expiry', 'pin'] as const)('never revives a read captured during %s failure', change => {
  const f = fixture(); f.enqueue();
  if (change === 'expiry') f.advance(); else f.changePin();
  const context = f.context();
  expect(f.notifier.peekFor(context.consumerId, undefined, 50, context)).toEqual([]);
  if (change === 'expiry') f.renew(); else f.restorePin();
  expect(f.notifier.peekFor(context.consumerId, undefined, 50, context)).toEqual([]);
  expect(f.notifier.acknowledgeFor(context.consumerId, [1])).toEqual([]);
  expect(f.notifier.peekFor(context.consumerId, undefined, 50, f.context())).toHaveLength(1);
});

it('does not offer content when an expired capture is renewed during an asynchronous lookup', async () => {
  const f = fixture(); f.enqueue(); f.advance();
  const tool = makeNotificationsTool(async () => f.notifier, async () => {
    f.renew(); return undefined;
  }, undefined, { id: 'mcp:reader', store: async () => f.notifier, context: async () => f.context() });
  const result = JSON.parse((await tool.execute('test', {}) as { text: string }).text);
  expect(result.notifications).toEqual([]);
  expect(f.notifier.acknowledgeFor('mcp:reader', [1])).toEqual([]);
  expect((await f.read()).notifications).toHaveLength(1);
});


it.each(['APPROVED', 'REJECTED'] as const)('delivers the actual MCP invite %s result with its House attribution', async state => {
  const f = fixture();
  const wiring = inviteWiring({ popclawId: '11111111111111111111111111111111', nickname: 'Owner', loreHouseUrl: origin, webBaseUrl: 'https://example.com' } as Parameters<typeof inviteWiring>[0],
    { drift: MCP_DRIFT_PINS } as Parameters<typeof inviteWiring>[1], new PendingInvitesStore(f.db), f.notifier, undefined);
  await checkInviteOnce({ ...wiring, loreHouseUrl: origin, fetch: async () => new Response(JSON.stringify({ state, platform: 'x', handle: 'owner', follower_count: 42 }), { status: 200 }) }, 'invite-fixture');
  const result = await f.read();
  expect(result.notifications).toHaveLength(1);
  const pending = f.notifier.peekFor('explicit-history');
  expect(pending[0]?.kind).toBe(state === 'APPROVED' ? 'ranger_verify_done' : 'ranger_verify_fail');
  expect(pending[0]?.payload.houseOrigin).toBe(origin);
});
