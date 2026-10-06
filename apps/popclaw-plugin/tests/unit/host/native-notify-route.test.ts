import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalHostAdapter } from '../../../src/host/local-host-adapter.js';
import { OwnerNotifyTargetStore } from '../../../src/notifier/owner-notify-target.js';
import { OwnerSession } from '../../../src/notifier/owner-session.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { notifyOwnerNow, RuntimeOwnerNotifier, type SendDurableMessageBatch } from '../../../src/notifier/owner-notifier.js';
import { withOpenClawNotifyRoute } from '../../../src/host/openclaw-notify-route.js';
import { ensureBundle } from '../../helpers/ensure-bundle.js';

const pkg = resolve('.'), bundle = join(pkg, 'dist/bundled/index.js');
const memo = '__popclaw_singleton__runtime';
const globals = globalThis as unknown as Record<string, unknown>;
const cleanups: Array<() => void> = [];
let entry: { register(api: unknown): void };
beforeAll(async () => {
  await ensureBundle(pkg, bundle);
  entry = (await import(pathToFileURL(bundle).href)).default;
}, 300_000);
afterEach(() => { delete globals[memo]; for (const clean of cleanups.splice(0)) clean(); });

async function setup(ctxOverrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-notify-route-'));
  const host = new LocalHostAdapter({ dataRoot: root, migrationsDir: resolve('migrations'),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never });
  cleanups.push(() => { host.db.close(); rmSync(root, { recursive: true, force: true }); });
  const ownerSession = new OwnerSession(), store = new OwnerNotifyTargetStore(host.storage);
  const rt = { houseRuntime: { runCommand: (work: () => unknown) => work() }, host, boot: { popclawId: 'synthetic-owner' }, ownerSession, ownerNotifyTargetStore: store };
  globals[memo] = Promise.resolve(rt);
  const warnings: string[] = [], registrations: unknown[] = [];
  const api = {
    registrationMode: 'full', pluginConfig: {}, config: {},
    logger: { info: (text: string) => warnings.push(text), warn: (text: string) => warnings.push(text), error: () => {}, debug: () => {} },
    runtime: { state: { resolveStateDir: () => root } },
    registerCommand: () => {}, registerService: () => {}, registerInteractiveHandler: () => {},
    registerTool: (tool: unknown) => registrations.push(tool), on: () => {},
  };
  entry.register(api);
  const ctx = { sessionKey: 'agent:main:whatsapp:direct:synthetic-owner', sessionId: 'synthetic-turn',
    senderIsOwner: true, deliveryContext: { channel: 'whatsapp', to: 'synthetic-owner', accountId: 'synthetic-account', threadId: 9 },
    assertInvocationCurrent: vi.fn(), ...ctxOverrides };
  const tools = registrations.flatMap((tool: any) => {
    const resolved = typeof tool === 'function' ? tool(ctx) : tool?.contextVersion === 2 ? tool.create(ctx) : tool;
    return Array.isArray(resolved) ? resolved : [resolved];
  });
  const selected = tools.find(tool => tool?.name === 'popclaw_show_namecard');
  expect(selected).toBeDefined();
  expect(existsSync(join(root, 'config/notify-target.json'))).toBe(false);
  const execute = () => selected.execute('synthetic-call', { person: '', deliveryContext: { channel: 'attacker', to: 'attacker' } });
  return { host, root, ownerSession, store, ctx, execute, warnings };
}

it('captures a normal owner tool route without a slash command and delivers the original queued DM', async () => {
  const s = await setup();
  const inbox = new InboxStore(s.host.db), notifier = new SqliteNotifier(s.host.db);
  const received = inbox.recordReceived({ ts: 1234, fromPopclawId: 'synthetic-sender', toPopclawId: 'synthetic-owner',
    body: 'Synthetic existing DM', receivedAtMs: 1234000, houseSlug: 'synthetic-house' });
  notifier.enqueue({ level: 'L1', kind: 'dm', payload: { messageId: received.item.id, houseSlug: 'synthetic-house', body: 'Synthetic existing DM' } });
  const queueId = s.host.db.queryOne<{id:number}>('SELECT id FROM notification_queue')!.id;
  const target = () => s.store.get();
  const logger = { info: () => {}, warn: () => {} }, send = vi.fn(async (_params: Parameters<SendDurableMessageBatch>[0]) => ({ status: 'sent' }));
  const owner = new RuntimeOwnerNotifier(send, {}, target, logger);
  const deliver = () => notifyOwnerNow({ owner, resolveTarget: target, logger,
    notifier: notifier.deliveryView(() => ({ key: 'synthetic-house', isActive: () => true }), { dmOnly: true }) });
  expect(await deliver()).toBe('no-target');
  expect(send).not.toHaveBeenCalled();
  await s.execute();
  const captured = { sessionKey: s.ctx.sessionKey, deliveryContext: s.ctx.deliveryContext };
  expect(await s.store.get()).toEqual({ ...captured, source: 'auto' });
  expect(s.ownerSession.get()).toEqual(captured);
  expect(await new OwnerNotifyTargetStore(s.host.storage).get()).toEqual({ ...captured, source: 'auto' });
  expect(await deliver()).toBe('channel');
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[0]).toMatchObject({ channel: 'whatsapp', to: 'synthetic-owner', accountId: 'synthetic-account', threadId: 9 });
  expect(s.host.db.queryOne('SELECT id, delivered_at IS NOT NULL AS delivered FROM notification_queue')).toEqual({ id: queueId, delivered: 1 });
  expect(inbox.get(received.item.id)?.retrievedAtMs).toBeUndefined();
});

it.each([
  { senderIsOwner: false }, { senderIsOwner: undefined },
  { deliveryContext: { channel: 'whatsapp' } }, { sessionKey: '' },
  { assertInvocationCurrent: () => { throw new Error('synthetic expired turn'); } }, { assertInvocationCurrent: undefined },
])('does not capture an untrusted or unroutable tool context %j', async overrides => {
  const s = await setup(overrides);
  await s.execute();
  expect(await s.store.get()).toBeNull();
  expect(s.ownerSession.get()).toBeUndefined();
});

it.each(['owner', 'auto', undefined])('keeps an existing %s pin while recording the current owner session', async source => {
  const s = await setup();
  const existing = { deliveryContext: { channel: 'telegram', to: 'synthetic-pinned' }, ...(source ? { source: source as 'owner' | 'auto' } : {}) };
  await s.store.set(existing);
  await s.execute();
  expect(await s.store.get()).toEqual(existing);
  expect(s.ownerSession.get()?.deliveryContext).toEqual(s.ctx.deliveryContext);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

it('does not publish a route when the SDK invocation expires during the stored-target read', async () => {
  let active = true;
  const s = await setup({ assertInvocationCurrent: () => { if (!active) throw new Error('synthetic expired turn'); } });
  const entered = deferred(), release = deferred(), read = s.host.storage.read.bind(s.host.storage);
  const spy = vi.spyOn(s.host.storage, 'read').mockImplementation(async (ns, key) => {
    const value = await read(ns, key);
    if (key === 'notify-target.json') { entered.resolve(); await release.promise; }
    return value;
  });
  const call = s.execute();
  await entered.promise;
  active = false; release.resolve();
  await call; spy.mockRestore();
  expect(await s.store.get()).toBeNull();
  expect(s.ownerSession.get()).toBeUndefined();
  expect(s.warnings.some(line => line.includes('synthetic expired turn'))).toBe(true);
});

it('a concurrent explicit owner pin wins over a route read that had observed no target', async () => {
  const s = await setup(), entered = deferred(), release = deferred(), read = s.host.storage.read.bind(s.host.storage);
  const spy = vi.spyOn(s.host.storage, 'read').mockImplementation(async (ns, key) => {
    const value = await read(ns, key);
    if (key === 'notify-target.json') { entered.resolve(); await release.promise; }
    return value;
  });
  const call = s.execute();
  await entered.promise;
  const explicit = { source: 'owner' as const, deliveryContext: { channel: 'telegram', to: 'synthetic-owner-choice' } };
  await s.store.set(explicit);
  release.resolve(); await call; spy.mockRestore();
  expect(await s.store.get()).toEqual(explicit);
  expect(s.ownerSession.get()?.deliveryContext).toEqual(s.ctx.deliveryContext);
});

it('reports route storage failure while preserving the original tool result', async () => {
  const s = await setup();
  vi.spyOn(s.store, 'captureIfUnset').mockRejectedValue(new Error('synthetic storage failure'));
  expect(await s.execute()).toMatchObject({ content: [{ type: 'text' }] });
  expect(s.warnings.some(line => line.includes('notify target capture failed: synthetic storage failure'))).toBe(true);
  expect(await s.store.get()).toBeNull();
});

it.each(['object', 'v1', 'v2', 'array'])('keeps %s registration lazy and snapshots original parameters before route IO', async shape => {
  const s = await setup();
  let resume!: (rt: { ownerSession: OwnerSession; ownerNotifyTargetStore: OwnerNotifyTargetStore }) => void;
  const ready = new Promise<{ ownerSession: OwnerSession; ownerNotifyTargetStore: OwnerNotifyTargetStore }>(r => { resume = r; });
  const runtime = vi.fn(() => ready);
  let registered: any, hints: unknown;
  const api = withOpenClawNotifyRoute({ registerTool: (tool, opts) => { registered = tool; hints = opts; } }, runtime, () => {});
  const original = { name: 'synthetic-tool', execute: (_id: string, params: { body: string }) => {
    const body = params.body;
    return Promise.resolve(body);
  } };
  api.registerTool(shape === 'object' ? original : shape === 'v2' ? { contextVersion: 2, create: () => original }
    : () => shape === 'array' ? [original] : original);
  const resolved = typeof registered === 'function' ? registered(s.ctx) : registered.create(s.ctx);
  expect(runtime).not.toHaveBeenCalled();
  if (shape === 'object') expect(hints).toEqual({ name: 'synthetic-tool' });
  if (shape === 'v2') expect(registered.contextVersion).toBe(2);
  const selected = Array.isArray(resolved) ? resolved[0] : resolved;
  const params = { body: 'original manuscript' };
  const call = selected.execute('synthetic-call', params);
  params.body = 'mutated later';
  resume({ ownerSession: s.ownerSession, ownerNotifyTargetStore: s.store });
  expect(await call).toBe('original manuscript');
  expect(await s.store.get()).toMatchObject({ deliveryContext: s.ctx.deliveryContext });
});

it('rechecks SDK currentness at file publication after asynchronous storage preparation', async () => {
  let active = true;
  const s = await setup({ assertInvocationCurrent: () => { if (!active) throw new Error('synthetic expired during storage'); } });
  const entered = deferred(), release = deferred(), write = s.host.storage.write.bind(s.host.storage);
  const spy = vi.spyOn(s.host.storage, 'write').mockImplementation(async (...args) => {
    if (args[1] === 'notify-target.json') { entered.resolve(); await release.promise; }
    return write(...args);
  });
  const call = s.execute(); await entered.promise;
  active = false; release.resolve(); await call; spy.mockRestore();
  expect(await s.store.get()).toBeNull();
  expect(existsSync(join(s.root, 'config/notify-target.json'))).toBe(false);
});
