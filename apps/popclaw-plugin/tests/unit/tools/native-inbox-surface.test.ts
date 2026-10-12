import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { makeToolCollector, toMcpToolResult } from '../../../src/tools/mcp-adapter.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { MIGRATIONS_DIR } from '../../helpers/register-tools-fixture.js';

// Exercise the installed SDK against the actual registered business tool, including
// both native wrappers. Never call a model, change host config, or send a message.
describe('native inbox content through OpenClaw CodeMode', () => {
  it('keeps image blocks in outer model input while CodeMode remains enabled', async () => {
    const require = createRequire(import.meta.url);
    const dist = dirname(dirname(require.resolve('openclaw/plugin-sdk/plugin-entry')));
    const bridge = readdirSync(dist).find(n => n.startsWith('tool-surface-bridge-') && n.endsWith('.mjs'))!;
    const { t: createSurface } = await import(pathToFileURL(join(dist, bridge)).href);
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const root = mkdtempSync(join(tmpdir(), 'native-inbox-surface-'));
    const paths = new PopclawPaths(root);
    const inboxStore = new InboxStore(db);
    mkdirSync(paths.dmMediaDir(), { recursive: true });
    const imagePath = join(paths.dmMediaDir(), 'photo.png');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDTsAAAAASUVORK5CYII=', 'base64');
    writeFileSync(imagePath, image);
    inboxStore.record({ ts: Math.floor(Date.now() / 1000), receivedAtMs: Date.now(), fromPopclawId: 'sender', toPopclawId: 'owner', body: 'photo', mediaPath: imagePath });
    const imageId = inboxStore.recent(1)[0]!.id;
    inboxStore.record({ ts: Math.floor(Date.now() / 1000) + 1, receivedAtMs: Date.now(), fromPopclawId: 'sender', toPopclawId: 'owner', body: 'plain letter' });
    const textId = inboxStore.recent(1)[0]!.id;
    const runtime = async () => ({ inboxStore, paths }) as unknown as Awaited<ReturnType<Parameters<typeof registerPopclawTools>[0]['runtime']>>;
    const collector = makeToolCollector();
    registerPopclawTools({ api: collector.api, runtime, nativeToolNotices: true,
      getToolNoticeContext: async () => ({ store: new SqliteNotifier(db), consumerId: 'native:image-test', active: () => true, eligible: () => true, lang: 'en' }),
    });
    const inbox = collector.tools.find(t => t.name === 'popclaw_show_inbox')!;
    const surface = createSurface({ config: { tools: { codeMode: true } }, agentId: 'image-test', sessionId: 'image-test', sessionKey: 'agent:image-test:main', runId: 'image-test', modelToolsEnabled: true,
      model: { id: 'deepseek-flash', provider: 'deepseek', input: ['text', 'image'], contextWindow: 1000000 }, modelProvider: 'deepseek', modelId: 'deepseek-flash',
      executeTool: async (request: { input: unknown }) => inbox.execute('sdk-image-test', request.input),
    });
    try {
      const raw = toMcpToolResult(await inbox.execute('raw-image', {message_id: imageId}));
      expect(raw.content.map(c => c.type)).toEqual(['text', 'image']);
      const compact = surface.compactTools([inbox]);
      const direct = compact.tools.find((t: {name: string}) => t.name === inbox.name);
      const result = direct ? await direct.execute('image', { message_id: imageId })
        : await compact.tools.find((t: {name: string}) => t.name === 'exec').execute('image', {title: 'Read photo', code: `return await popclaw_show_inbox({message_id:${imageId}});`});
      expect(result.content[0].text).toContain('photo');
      if (!direct) expect(result.content[0].text).toContain('image/png');
      expect(result.content.map((c: {type: string}) => c.type)).toContain('image');
      expect(result.content.find((c: {type: string}) => c.type === 'image')).toMatchObject({data: image.toString('base64'), mimeType: 'image/png'});
      expect(compact.tools.map((t: {name: string}) => t.name)).toEqual(expect.arrayContaining(['exec', 'wait', 'popclaw_show_inbox']));
      expect(inbox).toHaveProperty('catalogMode', 'direct-only');
      for (const args of [{message_id: textId}, {}]) {
        const text = await direct.execute('plain', args);
        expect(text.content.map((c: {type: string}) => c.type)).toEqual(['text']);
        expect(text.content[0].text).toContain('plain letter');
      }
      const mcp = makeToolCollector();
      registerPopclawTools({api: mcp.api, runtime});
      const mcpInbox = mcp.tools.find(t => t.name === inbox.name)!;
      expect(mcpInbox).not.toHaveProperty('catalogMode');
      expect(toMcpToolResult(await mcpInbox.execute('mcp-image', {message_id: imageId})).content.map(c => c.type)).toEqual(['text', 'image']);
    } finally {
      surface.cleanup();
      db.close();
      rmSync(root, {recursive: true, force: true});
    }
  });
});
