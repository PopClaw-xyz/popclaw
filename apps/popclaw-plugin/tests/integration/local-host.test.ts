import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostAdapter } from '../../src/host/local-host-adapter.js';
import { InMemoryLogger } from '../../src/host/host-adapter.in-memory.js';
import { Keystore } from '../../src/identity/keystore.js';
import { bootstrapPlugin } from '../../src/runtime/plugin-bootstrap.js';

const scratch: string[] = [];
const hosts: LocalHostAdapter[] = [];
function localHost(options: ConstructorParameters<typeof LocalHostAdapter>[0]): LocalHostAdapter {
  const host = new LocalHostAdapter(options); hosts.push(host); return host;
}
afterEach(() => {
  for (const host of hosts.splice(0)) host.db.close();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function mkRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'popclaw-plugin-'));
  scratch.push(dir);
  return dir;
}

describe('LocalHostAdapter', () => {
  it('storage.write creates nested dirs and read round-trips', async () => {
    const root = mkRoot();
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    await h.storage.write('identity', 'master.key', new Uint8Array([9, 9, 9]));
    expect(await h.storage.read('identity', 'master.key')).toEqual(new Uint8Array([9, 9, 9]));
  });

  it('opens the social-assets DB at <dataRoot>/vault/social/my-social-assets.db (P-005)', () => {
    const root = mkRoot();
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    // a migration ran on construction → file exists under vault/social, not the old flat path
    expect(existsSync(join(root, 'vault', 'social', 'my-social-assets.db'))).toBe(true);
    expect(existsSync(join(root, 'my-social-assets.db'))).toBe(false);
    expect(existsSync(join(root, 'vault', 'social', 'popclaw.db'))).toBe(false);
    expect(h.db.queryOne('SELECT 1 AS one')).toEqual({ one: 1 });
  });

  it('storage.read returns null on ENOENT', async () => {
    const root = mkRoot();
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    expect(await h.storage.read('identity', 'missing')).toBeNull();
  });

  it('config.loadJson parses JSON from <root>/config/<name>.json', async () => {
    const root = mkRoot();
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'plugin.json'), JSON.stringify({ lore_houses: ['http://x'] }));
    const cfg = (await h.config.loadJson('plugin')) as { lore_houses: string[] };
    expect(cfg.lore_houses).toEqual(['http://x']);
  });

  it('config.saveJson → loadJson roundtrip is consistent', async () => {
    const root = mkRoot();
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    await h.config.saveJson('plugin', { lore_house_url: 'http://localhost:8080', ranger_profile: { nickname: '侠客' } });
    const loaded = (await h.config.loadJson('plugin')) as Record<string, unknown>;
    expect(loaded).toEqual({ lore_house_url: 'http://localhost:8080', ranger_profile: { nickname: '侠客' } });
  });

  it('config.saveJson auto-creates config dir when it does not exist', async () => {
    const root = mkRoot();
    // dataRoot exists but config/ subdir has NOT been created yet
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    // saveJson must mkdir -p the config dir, not throw
    await expect(h.config.saveJson('plugin', { test: true })).resolves.toBeUndefined();
    expect(await h.config.loadJson('plugin')).toEqual({ test: true });
  });

  it('storage.write honours an explicit mode and creates the leaf dir at 0700', async () => {
    const root = mkRoot();
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    await h.storage.write('identity', 'secret', new Uint8Array([1]), { mode: 0o600 });
    const p = join(root, 'vault', 'social', 'identity', 'secret');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'vault', 'social', 'identity')).mode & 0o777).toBe(0o700);
    // Only the LEAF is ours: LocalHostDb's constructor already mkdir'd
    // <root>/vault/social at the default mode before storage ever runs, and
    // mkdir({mode}) does not touch directories that already exist. Tightening
    // the whole vault is a separate decision, tracked separately.
    expect(statSync(join(root, 'vault', 'social')).mode & 0o077).not.toBe(0);
  });

  it('storage.write without a mode keeps the previous default behaviour', async () => {
    const root = mkRoot();
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    await h.storage.write('cache', 'x', new Uint8Array([1]));
    expect(await h.storage.read('cache', 'x')).toEqual(new Uint8Array([1]));
  });

  it('config.saveJson writes file ending with \\n', async () => {
    const root = mkRoot();
    const { readFile } = await import('node:fs/promises');
    const { join: pathJoin } = await import('node:path');
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    await h.config.saveJson('plugin', { x: 1 });
    const raw = await readFile(pathJoin(root, 'config', 'plugin.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('Keystore on a real filesystem', () => {
  const keyPath = (root: string) => join(root, 'vault', 'social', 'identity', 'master.key');

  it('generates master.key at 0600', async () => {
    const root = mkRoot();
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    await new Keystore(h).loadOrGenerate();
    expect(statSync(keyPath(root)).mode & 0o777).toBe(0o600);
  });

  it('self-heals an existing world-readable key on load and warns', async () => {
    const root = mkRoot();
    const logger = new InMemoryLogger();
    const h = localHost({ dataRoot: root, logger });
    const generated = await new Keystore(h).loadOrGenerate();
    // simulate every install shipped before this fix
    chmodSync(keyPath(root), 0o644);
    logger.records.length = 0;

    const loaded = await new Keystore(h).load();

    expect(loaded!.popclawId).toBe(generated.popclawId); // still boots, same identity
    expect(statSync(keyPath(root)).mode & 0o777).toBe(0o600);
    const warns = logger.records.filter((r) => r.level === 'warn' && /permission/i.test(r.msg));
    expect(warns).toHaveLength(1);
    expect(String(warns[0]!.obj.path)).toBe(keyPath(root));
    expect(/compromised/i.test(warns[0]!.msg)).toBe(true); // 0644: group/other really could read it
  });

  it('tightens a 0700 key silently — no exposure claim, nobody else could read it', async () => {
    const root = mkRoot();
    const logger = new InMemoryLogger();
    const h = localHost({ dataRoot: root, logger });
    await new Keystore(h).loadOrGenerate();
    chmodSync(keyPath(root), 0o700);
    logger.records.length = 0;

    await new Keystore(h).load();

    expect(statSync(keyPath(root)).mode & 0o777).toBe(0o600);
    // group/other never had a bit → must not cry "compromised"
    expect(logger.records.some((r) => /compromised|could have read/i.test(r.msg))).toBe(false);
  });

  it('does not warn when the key is already 0600', async () => {
    const root = mkRoot();
    const logger = new InMemoryLogger();
    const h = localHost({ dataRoot: root, logger });
    await new Keystore(h).loadOrGenerate();
    logger.records.length = 0;
    await new Keystore(h).load();
    expect(logger.records.filter((r) => r.level === 'warn')).toHaveLength(0);
  });

  it('a missing/unstattable key does not block boot', async () => {
    const root = mkRoot();
    const h = localHost({ dataRoot: root, logger: new InMemoryLogger() });
    // read returns null → load short-circuits before any stat/chmod
    expect(await new Keystore(h).load()).toBeNull();
  });
});

it('concurrent config writers each atomically publish a complete document', async () => {
  const root = mkRoot();
  const a = localHost({dataRoot: root, logger: new InMemoryLogger()});
  await bootstrapPlugin(a);
  const b = localHost({dataRoot: root, logger: new InMemoryLogger()});
  const docs = Array.from({length: 12}, (_, index) => ({index, body: String(index).repeat(10000)}));
  try {
    const results = await Promise.allSettled(docs.map((doc, index) => (index % 2 ? a : b).config.saveJson('plugin', doc)));
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(docs).toContainEqual(await a.config.loadJson('plugin'));
  } finally { a.db.close(); b.db.close(); }
});
