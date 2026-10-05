import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  withNativeToolNotice,
  makeToolCollector,
  toMcpToolResult,
} from '../../../src/tools/mcp-adapter.js';
import {
  offerToolNotice,
  type ToolNoticeContext,
} from '../../../src/notifier/tool-notice.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { registerNotificationTools } from '../../../src/tools/notification-tools.js';
const migrations = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);
describe('native notice adapter through pinned OpenClaw registration', () => {
  it('registers object/factory/array with the actual pinned SDK registrar and keeps JSON/image content', async () => {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve('openclaw/plugin-sdk/plugin-entry');
    const dist = dirname(dirname(sdkEntry));
    const pkg = JSON.parse(readFileSync(join(dist, '../package.json'), 'utf8'));
    expect(pkg.version).toBe('2026.9.8');
    const source = readdirSync(dist).find(
      (name) =>
        name.startsWith('loader-runtime-load-') && name.endsWith('.mjs'),
    )!;
    const fixture = join(dist, `notice-fixture-${process.pid}.mjs`);
    writeFileSync(
      fixture,
      readFileSync(join(dist, source), 'utf8') +
        '\nexport {createToolHookRegistrars as noticeFixtureRegistrar};\n',
    );
    const db = new InMemoryHostDb();
    runMigrations(db, migrations);
    let now = 1700000000;
    const store = new SqliteNotifier(db, () => now);
    const context: ToolNoticeContext = {
      store,
      consumerId: 'native:test',
      eligible: () => true,
      active: () => true,
      lang: 'en',
    };
    try {
      const { noticeFixtureRegistrar } = await import(
        pathToFileURL(fixture).href
      );
      const registry = { tools: [], typedHooks: [], hooks: [] };
      const errors: string[] = [];
      const registrar = noticeFixtureRegistrar({
        registry,
        registryParams: {},
        pluginsWithChannelRegistrationConflict: new Set(),
        createRegistration: (_record: unknown, entry: unknown) => entry,
        reportRegistrationError: (_record: unknown, error: string) =>
          errors.push(error),
        reportRegistrationWarning: () => {},
      });
      const record = {
        id: 'popclaw',
        origin: 'workspace',
        toolNames: [],
        contracts: { tools: ['object', 'factory', 'array'] },
      };
      const api = withNativeToolNotice(
        {
          registerTool: (tool, opts) =>
            registrar.registerTool(record, tool, opts),
        },
        async () => context,
      );
      const business = {
        content: [
          { type: 'text', text: '{"ok":true}' },
          { type: 'image', data: 'AA==', mimeType: 'image/png' },
        ],
        structuredContent: { ok: true },
        details: { receipt: 'kept' },
      };
      const def = (name: string) => ({
        name,
        label: name,
        description: name,
        parameters: { type: 'object', properties: {} },
        execute: async () => business,
      });
      api.registerTool(def('object'));
      api.registerTool(() => def('factory'), { name: 'factory' });
      api.registerTool(() => [def('array')], { name: 'array' });
      expect(errors).toEqual([]);
      expect(registry.tools).toHaveLength(3);
      for (const registration of registry.tools as any[]) {
        store.enqueue({ level: 'L2', kind: 'followed_you', payload: {} });
        const resolved = registration.factory({ sessionKey: 'host:actual' });
        const tool = Array.isArray(resolved) ? resolved[0] : resolved;
        const result = await tool.execute('call', {});
        expect(result.content.slice(0, -1)).toEqual(business.content);
        expect(result.structuredContent).toBe(business.structuredContent);
        expect(result.details).toBe(business.details);
        now += 60;
      }
    } finally {
      db.close();
      unlinkSync(fixture);
    }
  });
  it('reuses explicit native notification/ack tools and does not auto-ack an offer', async () => {
    const db = new InMemoryHostDb();
    runMigrations(db, migrations);
    const store = new SqliteNotifier(db, () => 1700000000);
    const notice: ToolNoticeContext = {
      store,
      consumerId: 'native:test',
      eligible: () => true,
      active: () => true,
    };
    const collector = makeToolCollector();
    registerNotificationTools({
      api: collector.api,
      runtime: async () =>
        ({
          notifier: store,
          nameOf: undefined,
          proposalsStore: undefined,
        }) as any,
      deps: { getToolNoticeContext: async () => notice } as any,
      total: 0,
    });
    store.enqueue({ level: 'L2', kind: 'followed_you', payload: {} });
    expect(offerToolNotice(notice).text).toBeTruthy();
    expect(store.countFor('native:test')).toBe(1);
    const fetched = toMcpToolResult(
      await collector.tools[0]!.execute('explicit', {}),
    );
    expect(fetched.content[0]).toMatchObject({ type: 'text' });
    expect(store.countFor('native:test')).toBe(1);
    const ack = (await collector.tools[1]!.execute('explicit-ack', {
      notification_ids: [1],
    })) as { text: string };
    expect(JSON.parse(ack.text).acknowledged).toEqual([1]);
    expect(store.countFor('native:test')).toBe(0);
    db.close();
  });
});
