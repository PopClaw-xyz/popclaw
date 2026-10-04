import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { InMemoryHostAdapter } from '../../src/host/host-adapter.in-memory.js';
import { loadPluginConfig } from '../../src/config/loader.js';
import { WorldExecutionConfig } from '../../src/config/schema.js';

describe('host world execution configuration', () => {
  const policy = { agentId: 'main', actorId: bs58.encode(new Uint8Array(32).fill(91)), house: 'http://127.0.0.1:48180', kinds: ['train.join', 'train.status'],
    authorizedAt: '2026-09-08T10:00:00Z', expiresAt: '2026-09-09T10:00:00Z' };
  it('accepts the maximum explicit interval and an empty revocation policy list', () => {
    expect(WorldExecutionConfig.parse({ policies: [policy] }).policies).toEqual([policy]);
    expect(WorldExecutionConfig.parse({ policies: [] }).policies).toEqual([]);
  });
  it('rejects ambiguous origins, wildcards, duplicates and unbounded or invalid times', () => {
    for (const change of [{ house: 'http://127.0.0.1:48180/' }, { house: 'https://WORLD.invalid' }, { agentId: '*' }, { actorId: 'a'.repeat(64) }, { houseKey: 'b'.repeat(64) },
      { kinds: ['train.*'] }, { kinds: ['train.join', 'train.join'] }, { expiresAt: '2026-09-09T10:00:01Z' },
      { expiresAt: policy.authorizedAt }, { authorizedAt: '2026-02-30T10:00:00Z' }, { expiresAt: '2026-09-09T10:00:00+00:00' }]) {
      expect(WorldExecutionConfig.safeParse({ policies: [{ ...policy, ...change }] }).success).toBe(false);
    }
  });
  it('does not load host execution authority from the PopClaw data configuration', async () => {
    const host = new InMemoryHostAdapter({ config: { plugin: { lore_houses: ['https://house.invalid'], worldExecution: { policies: [policy] } } } });
    expect(await loadPluginConfig(host)).not.toHaveProperty('worldExecution');
  });
});

describe('PluginConfig loader', () => {
  it('applies defaults when only lore_houses is set', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_houses: ['http://localhost:8080'] } },
    });
    const cfg = await loadPluginConfig(host);
    expect(cfg.lore_houses).toEqual(['http://localhost:8080']);
    expect(cfg.scraper.interval_ms).toBe(5000);
    expect(cfg.scraper.dir).toBe('events');
    expect(cfg.ranger_mode).toBe(false);
  });

  it('rejects missing lore_houses', async () => {
    const host = new InMemoryHostAdapter({ config: { plugin: {} } });
    await expect(loadPluginConfig(host)).rejects.toThrow();
  });

  it('accepts canvas_base_url and surfaces it (lives in popclaw config, not host env)', async () => {
    const host = new InMemoryHostAdapter({
      config: {
        plugin: {
          lore_houses: ['http://localhost:8080'],
          canvas_base_url: 'http://192.0.2.6:8788',
        },
      },
    });
    const cfg = await loadPluginConfig(host);
    expect(cfg.canvas_base_url).toBe('http://192.0.2.6:8788');
  });

  /**
   * The owner's explicit "no publisher": the schema has to let the empty
   * string through, or "turn the paper's publisher off" would be unsayable in
   * the one file where it belongs.
   */
  it('accepts an empty canvas_base_url — that is the owner switching the publisher off', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_houses: ['http://localhost:8080'], canvas_base_url: '' } },
    });
    const cfg = await loadPluginConfig(host);
    expect(cfg.canvas_base_url).toBe('');
  });

  it('rejects a malformed canvas_base_url', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_houses: ['http://localhost:8080'], canvas_base_url: 'not-a-url' } },
    });
    await expect(loadPluginConfig(host)).rejects.toThrow();
  });

  it('accepts web_base_url and surfaces it (lives in popclaw config, not client env)', async () => {
    const host = new InMemoryHostAdapter({
      config: {
        plugin: {
          lore_houses: ['http://localhost:8080'],
          web_base_url: 'http://192.0.2.6:3000',
        },
      },
    });
    const cfg = await loadPluginConfig(host);
    expect(cfg.web_base_url).toBe('http://192.0.2.6:3000');
  });

  it('rejects a malformed web_base_url', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_houses: ['http://localhost:8080'], web_base_url: 'not-a-url' } },
    });
    await expect(loadPluginConfig(host)).rejects.toThrow();
  });

  it('accepts newspaper.model and surfaces it (the workshop writes on its own profile)', async () => {
    const host = new InMemoryHostAdapter({
      config: {
        plugin: {
          lore_houses: ['http://localhost:8080'],
          newspaper: { model: 'glm-4.6' },
        },
      },
    });
    const cfg = await loadPluginConfig(host);
    expect(cfg.newspaper?.model).toBe('glm-4.6');
  });

  it('newspaper absent → undefined: the workshop follows the host default model', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_houses: ['http://localhost:8080'] } },
    });
    const cfg = await loadPluginConfig(host);
    expect(cfg.newspaper).toBeUndefined();
  });

  it('an empty newspaper.model parses (empty = host default; the dispatch treats it as unset)', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_houses: ['http://localhost:8080'], newspaper: { model: '' } } },
    });
    const cfg = await loadPluginConfig(host);
    expect(cfg.newspaper?.model).toBe('');
  });

  it('rejects a non-string newspaper.model rather than guessing', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_houses: ['http://localhost:8080'], newspaper: { model: 46 } } },
    });
    await expect(loadPluginConfig(host)).rejects.toThrow();
  });

  it('defaults to me only when config file is absent (zero-config first boot)', async () => {
    const host = new InMemoryHostAdapter();
    const cfg = await loadPluginConfig(host);
    // World is an optional normal join.
    expect(cfg.lore_houses).toEqual(['https://house.popclaw.me']);
  });

  it('persists the generated default so the owner can find and edit it', async () => {
    const host = new InMemoryHostAdapter();
    await loadPluginConfig(host);
    expect(await host.config.loadJson('plugin')).toEqual({
      lore_houses: ['https://house.popclaw.me'],
    });
  });

  it('never rewrites an existing config file, even a broken one', async () => {
    const host = new InMemoryHostAdapter({ config: { plugin: {} } });
    await expect(loadPluginConfig(host)).rejects.toThrow();
    expect(await host.config.loadJson('plugin')).toEqual({});
  });
});
