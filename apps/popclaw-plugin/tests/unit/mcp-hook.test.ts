import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { runMigrations } from '../../src/host/migrations.js';
import { PopclawPaths } from '../../src/host/popclaw-paths.js';
import { SqliteNotifier } from '../../src/notifier/sqlite-notifier.js';
import { InboxStore } from '../../src/messaging/inbox-store.js';
import { HouseRuntime } from '../../src/runtime/house-lifecycle/house-runtime.js';
import type { Signer } from '../../src/identity/signer.js';
import { refusingReadAuthorityFor } from '../helpers/read-authority.js';
import { publishStorageJson } from '../../src/host/storage-maintenance.js';

const pkg = fileURLToPath(new URL('../..', import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-hook-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root); mkdirSync(dirname(paths.socialDb()), { recursive: true });
  const db = new LocalHostDb(paths.socialDb()); cleanups.push(() => db.close());
  runMigrations(db, join(pkg, 'migrations'));
  const origin = 'https://notification.example';
  const houses = new HouseRuntime({ db, signer: {} as Signer, origins: [origin], readAuthorityFor: refusingReadAuthorityFor });
  cleanups.push(() => houses.stop());
  db.execute(`INSERT INTO house_participation(house_origin, installation_id, desired, phase, session_id, lease_expires_at)
    VALUES (?, 'installation', 'enabled', 'connected', 'session', ?)`, [origin, Date.now() / 1000 + 90]);
  const notifier = new SqliteNotifier(db); notifier.bindConsumer('mcp:hook');
  const inbox = new InboxStore(db);
  const hook = () => JSON.parse(execFileSync(process.execPath, ['--import', join(pkg, 'node_modules/tsx/dist/loader.mjs'), join(pkg, 'src/mcp-hook.ts'), 'PostToolUse'],
    { env: { ...process.env, POPCLAW_DATA_ROOT: root, POPCLAW_NOTIFICATION_CONSUMER: 'mcp:hook' } }).toString());
  return { paths, db, origin, notifier, inbox, hook };
}

it.each(['unattributed', 'disabled', 'expired', 'resolved', 'sender-mismatch', 'missing-inbox'] as const)('keeps the hook quiet for %s content without consuming it', state => {
  const f = fixture();
  const message = f.inbox.recordReceived({ fromPopclawId: 'alice', toPopclawId: 'owner', body: 'PRIVATE-CONTENT', ts: 1, receivedAtMs: 1 }).item;
  f.db.execute("UPDATE inbox SET notification_state='queued' WHERE id=?", [message.id]);
  f.notifier.enqueue({ level: 'L1', kind: 'dm', payload: { body: message.body, messageId: message.id,
    fromPopclawId: state === 'sender-mismatch' ? 'mallory' : 'alice', ...(state === 'unattributed' ? {} : { houseOrigin: f.origin }) } });
  if (state === 'missing-inbox') f.db.execute("UPDATE notification_queue SET source_message_id=NULL, payload_json=json_set(payload_json, '$.messageId', 99999)");
  if (state === 'disabled') f.db.execute("UPDATE house_participation SET desired='disabled'");
  if (state === 'expired') f.db.execute('UPDATE house_participation SET lease_expires_at=1');
  if (state === 'resolved') f.db.execute('UPDATE inbox SET resolved_at_ms=2');
  expect(f.hook()).toEqual({}); expect(f.hook()).toEqual({});
  expect(f.notifier.countFor('mcp:hook')).toBe(1);
  expect(f.notifier.acknowledgeFor('mcp:hook', [1])).toEqual([]);
});

it('counts eligible content without including its body, and respects acknowledgement and storage holds', () => {
  const f = fixture();
  f.notifier.enqueue({ level: 'L2', kind: 'reply', payload: { houseOrigin: f.origin, body: 'PRIVATE-CONTENT' } });
  expect(f.hook().hookSpecificOutput.additionalContext).toContain('1 pending notifications');
  expect(JSON.stringify(f.hook())).not.toContain('PRIVATE-CONTENT');
  publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'held', mode: 'recovery', reason: 'fixture', held: ['notifications'], releases: {} });
  expect(f.hook()).toEqual({});
  publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'restored', mode: 'normal', reason: 'fixture', held: [], releases: {} });
  const items = f.notifier.peekFor('mcp:hook'); f.notifier.acknowledgeFor('mcp:hook', items.map(item => item.id));
  expect(f.hook()).toEqual({});
});


it('projects only routing metadata while preserving absent, null and non-string values', () => {
  const f = fixture();
  for (const payload of [{ body: 'SECRET', attachment: '/private/image.png' }, { body: 'SECRET', houseOrigin: null }, { body: 'SECRET', houseOrigin: { invalid: true }, messageId: true }])
    f.notifier.enqueue({ level: 'L2', kind: 'system_notice', payload });
  const seen: Array<Record<string, unknown>> = [];
  expect(f.notifier.countMetadataFor('mcp:hook', item => { seen.push(item.payload); return true; })).toBe(3);
  expect(seen).toEqual([{}, { houseOrigin: null }, { houseOrigin: { invalid: true }, messageId: true }]);
  expect(f.hook().hookSpecificOutput.additionalContext).toContain('1 pending notifications');
});

it('retains the existing sessionless lane and stops after participation is disabled', () => {
  const f = fixture();
  f.db.execute("UPDATE house_participation SET session_id='',lease_expires_at=0");
  f.notifier.enqueue({ level: 'L2', kind: 'reply', payload: { houseOrigin: f.origin, body: 'PRIVATE-CONTENT' } });
  expect(f.hook().hookSpecificOutput.additionalContext).toContain('1 pending notifications');
  f.db.execute("UPDATE house_participation SET desired='disabled'");
  expect(f.hook()).toEqual({});
});
