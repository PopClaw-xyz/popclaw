import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { registerNotificationTools } from '../../../src/tools/notification-tools.js';
import { runtimeToolNoticeContext } from '../../../src/notifier/tool-notice.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import type { PluginRuntime } from '../../../src/runtime/plugin-runtime.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-notification-scope-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new LocalHostDb(join(root, 'social.db')); cleanups.push(() => db.close());
  runMigrations(db, fileURLToPath(new URL('../../../migrations', import.meta.url)));
  const store = new SqliteNotifier(db, () => 1700000000);
  const inbox = new InboxStore(db);
  const live = 'https://live.example'; const revoked = 'https://revoked.example';
  let storage = true; let owner = true; let generation = 1;
  const rt = { notifier: store, inboxStore: inbox, boot: { popclawId: 'owner' },
    houseRuntime: {
      commands: { knownHouseOrigins: () => [live, revoked] },
      storageAllows: () => storage,
      resident: { authority: { captureEpoch: () => generation, isEpochCurrent: (epoch: number) => owner && epoch === generation } },
      originForSlug: (slug: string) => slug === 'live' ? live : revoked,
      captureGate: (origin: string) => { const epoch = generation; return { origin, isActive: () => owner && epoch === generation && origin === live }; },
    },
  } as unknown as PluginRuntime;
  const tools: Array<{ name: string; execute: (id: string, args: unknown) => Promise<unknown> }> = [];
  registerNotificationTools({ deps: {}, api: { registerTool: (tool: typeof tools[number]) => tools.push(tool) }, runtime: async () => rt } as unknown as ToolsCtx);
  const tool = tools.find(t => t.name === 'popclaw_notifications')!;
  const call = async () => JSON.parse((await tool.execute('test', {}) as { text: string }).text);
  const enqueue = (body: string, houseOrigin: string | undefined = live) => store.enqueue({ level: 'L2', kind: 'reply', payload: { body, fromPopclawId: '1'.repeat(32), ...(houseOrigin ? { houseOrigin } : {}) } });
  return { db, store, inbox, rt, call, enqueue, live, revoked, setStorage: (value: boolean) => { storage = value; }, revokeOwner: () => { owner = false; }, newGeneration: () => { generation++; } };
}

it('filters unavailable House and unattributed rows before offering, without hiding a later live item or consuming history', async () => {
  const f = setup();
  for (let i = 0; i < 55; i++) f.enqueue(`REVOKED-${i}`, f.revoked);
  f.store.enqueue({ level: 'L2', kind: 'reply', payload: { body: 'LEGACY' } });
  f.enqueue('LIVE-CONTENT');
  const result = await f.call();
  expect(result.owner_text).toContain('LIVE-CONTENT');
  expect(result.owner_text).not.toContain('REVOKED-');
  expect(result.owner_text).not.toContain('LEGACY');
  expect(result.notifications).toHaveLength(1);
  expect(f.store.acknowledgeFor('native:owner', [1])).toEqual([]);
  expect(f.store.peekFor('explicit-history', undefined, 100)).toHaveLength(57);
});

it('retains existing storage, owner and source generation boundaries for automatic delivery', async () => {
  const f = setup(); f.enqueue('PRIVATE');
  f.setStorage(false);
  await expect(f.call()).rejects.toThrow('NOTIFICATIONS_INACTIVE');
  f.setStorage(true); f.revokeOwner();
  expect((await f.call()).notifications).toEqual([]);
  expect(f.store.acknowledgeFor('native:owner', [1])).toEqual([]);
});

it('does not present resolved or mismatched DM payloads, while explicit inbox history remains available', async () => {
  const f = setup();
  const message = f.inbox.recordReceived({ fromPopclawId: 'alice', toPopclawId: 'owner', body: 'FULL-HISTORY', ts: 1, receivedAtMs: 1 }).item;
  f.db.execute("UPDATE inbox SET notification_state = 'queued', resolved_at_ms = 2 WHERE id = ?", [message.id]);
  f.store.enqueue({ level: 'L1', kind: 'dm', payload: { houseOrigin: f.live, fromPopclawId: 'alice', messageId: message.id, body: message.body } });
  expect((await f.call()).notifications).toEqual([]);
  expect(f.inbox.get(message.id)?.body).toBe('FULL-HISTORY');
  f.db.execute('UPDATE inbox SET resolved_at_ms = NULL WHERE id = ?', [message.id]);
  expect((await f.call()).owner_text).toContain('FULL-HISTORY');
  f.store.enqueue({ level: 'L1', kind: 'dm', payload: { houseOrigin: f.live, fromPopclawId: 'mallory', messageId: message.id, body: 'MISMATCHED' } });
  expect((await f.call()).notifications).toEqual([]);
});

it('keeps captured authority invalid after an identity generation changes', () => {
  const f = setup(); f.enqueue('PRIVATE');
  const scope = runtimeToolNoticeContext(f.rt, 'native:test', undefined, true);
  const [item] = f.store.peekFor('test-history');
  expect(scope.eligible(item!)).toBe(true);
  f.newGeneration();
  expect(scope.eligible(item!)).toBe(false);
});

it('does not re-offer native delivery already completed by the existing push path', async () => {
  const f = setup(); f.enqueue('ALREADY-DELIVERED');
  f.store.drain('L2');
  expect((await f.call()).notifications).toEqual([]);
});
