import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostAdapter } from '../../src/host/local-host-adapter.js';
// REUSE the logger that tests/integration/local-host.test.ts imports — match it exactly.
import { InMemoryLogger } from '../../src/host/host-adapter.in-memory.js';

describe('data layout (config/data/vault)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'popclaw-layout-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('places identity + social DB under vault/social, config under config', async () => {
    const h = new LocalHostAdapter({ dataRoot: root, logger: new InMemoryLogger() });
    await h.storage.write('identity', 'master.key', new TextEncoder().encode('seed'));
    await h.config.saveJson('plugin', { lore_houses: ['http://x:8080'] });
    h.db.execute('CREATE TABLE t (a)');
    expect(existsSync(join(root, 'vault', 'social', 'identity', 'master.key'))).toBe(true);
    expect(existsSync(join(root, 'vault', 'social', 'my-social-assets.db'))).toBe(true);
    expect(existsSync(join(root, 'config', 'plugin.json'))).toBe(true);
    expect(existsSync(join(root, 'identity', 'master.key'))).toBe(false);
    expect(existsSync(join(root, 'my-social-assets.db'))).toBe(false);
  });

  it("storage namespace 'config' (notify-target) lands in config/, not data/config", async () => {
    const h = new LocalHostAdapter({ dataRoot: root, logger: new InMemoryLogger() });
    await h.storage.write('config', 'notify-target.json', new TextEncoder().encode('{"x":1}'));
    expect(existsSync(join(root, 'config', 'notify-target.json'))).toBe(true);
    expect(existsSync(join(root, 'data', 'config', 'notify-target.json'))).toBe(false);
    // round-trips through the same resolver
    const back = await h.storage.read('config', 'notify-target.json');
    expect(new TextDecoder().decode(back!)).toBe('{"x":1}');
  });

  it('re-boot preserves identity, db rows, and config (door-man / P-006)', async () => {
    const h1 = new LocalHostAdapter({ dataRoot: root, logger: new InMemoryLogger() });
    await h1.storage.write('identity', 'master.key', new TextEncoder().encode('SEED-1'));
    await h1.config.saveJson('plugin', { lore_houses: ['http://a:8080'] });
    h1.db.execute('CREATE TABLE t (a INTEGER)');
    h1.db.execute('INSERT INTO t (a) VALUES (1)');
    const h2 = new LocalHostAdapter({ dataRoot: root, logger: new InMemoryLogger() });
    const key = await h2.storage.read('identity', 'master.key');
    expect(new TextDecoder().decode(key!)).toBe('SEED-1');
    expect(await h2.config.loadJson('plugin')).toEqual({ lore_houses: ['http://a:8080'] });
    expect(h2.db.queryOne<{ a: number }>('SELECT a FROM t')?.a).toBe(1);
  });
});
