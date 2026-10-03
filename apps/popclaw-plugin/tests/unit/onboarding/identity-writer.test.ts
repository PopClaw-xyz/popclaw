import { describe, it, expect } from 'vitest';
import { InMemoryHostAdapter, InMemoryConfig } from '../../../src/host/host-adapter.in-memory.js';
import { persistNickname, isPlaceholderNickname, readNameSource } from '../../../src/onboarding/identity-writer.js';

describe('persistNickname', () => {
  it('roundtrips: saves nickname and loadJson reflects it', async () => {
    const host = new InMemoryHostAdapter();
    await persistNickname(host, '江湖浪人');
    const loaded = (await host.config.loadJson('plugin')) as Record<string, unknown>;
    expect((loaded.ranger_profile as Record<string, unknown>).nickname).toBe('江湖浪人');
  });

  it('trims whitespace from nickname', async () => {
    const host = new InMemoryHostAdapter();
    await persistNickname(host, '  ranger-name  ');
    const loaded = (await host.config.loadJson('plugin')) as Record<string, unknown>;
    expect((loaded.ranger_profile as Record<string, unknown>).nickname).toBe('ranger-name');
  });

  it('preserves unrelated fields in plugin config', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_house_url: 'http://localhost:8080', ranger_profile: { nickname: 'old' } } },
    });
    await persistNickname(host, 'new-name');
    const loaded = (await host.config.loadJson('plugin')) as Record<string, unknown>;
    expect(loaded.lore_house_url).toBe('http://localhost:8080');
    expect((loaded.ranger_profile as Record<string, unknown>).nickname).toBe('new-name');
  });

  it('preserves other fields in ranger_profile when updating nickname', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { ranger_profile: { nickname: 'old', some_other_field: 42 } } },
    });
    await persistNickname(host, 'new-name');
    const loaded = (await host.config.loadJson('plugin')) as Record<string, unknown>;
    const profile = loaded.ranger_profile as Record<string, unknown>;
    expect(profile.nickname).toBe('new-name');
    expect(profile.some_other_field).toBe(42);
  });

  it('works when plugin config does not yet exist', async () => {
    const host = new InMemoryHostAdapter();
    // no initial config → plugin key absent
    await persistNickname(host, 'fresh-name');
    const loaded = (await host.config.loadJson('plugin')) as Record<string, unknown>;
    expect((loaded.ranger_profile as Record<string, unknown>).nickname).toBe('fresh-name');
  });

  it('throws on empty nickname', async () => {
    const host = new InMemoryHostAdapter();
    await expect(persistNickname(host, '')).rejects.toThrow('persistNickname: nickname must be non-empty');
  });

  it('throws on whitespace-only nickname', async () => {
    const host = new InMemoryHostAdapter();
    await expect(persistNickname(host, '   ')).rejects.toThrow('persistNickname: nickname must be non-empty');
  });

  // M4: guard against corrupt config (e.g. config was serialised as an array)
  it('treats array-valued config as empty object — does not throw or corrupt', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: [] as unknown },
    });
    await persistNickname(host, '侠客');
    const loaded = (await host.config.loadJson('plugin')) as Record<string, unknown>;
    // Array is discarded; result is a clean object with only ranger_profile
    expect(typeof loaded).toBe('object');
    expect(Array.isArray(loaded)).toBe(false);
    expect((loaded.ranger_profile as Record<string, unknown>).nickname).toBe('侠客');
  });
});

describe('isPlaceholderNickname', () => {
  // C1: popclaw_id = bs58.encode(publicKey) — default name uses base58 chars, not hex.
  it('recognises ranger-<6 base58 chars> as placeholder (real form)', () => {
    expect(isPlaceholderNickname('ranger-7gXkQz')).toBe(true);  // typical base58 output
    expect(isPlaceholderNickname('ranger-AbCdEf')).toBe(true);  // mixed case, valid base58
  });

  it('recognises ranger-<6hex subset> still as placeholder (a1b2c3 is valid base58)', () => {
    // hex chars a-f, 1-9 are all valid base58 chars — must still be caught
    expect(isPlaceholderNickname('ranger-a1b2c3')).toBe(true);
  });

  it('trims surrounding whitespace before checking', () => {
    expect(isPlaceholderNickname('  ranger-7gXkQz  ')).toBe(true);
  });

  it('rejects names containing base58-illegal chars (0, O, I, l)', () => {
    // These chars are NOT in the base58 alphabet so can never come from a real popclaw_id
    expect(isPlaceholderNickname('ranger-0OIl11')).toBe(false); // contains 0, O, I, l
    expect(isPlaceholderNickname('ranger-000000')).toBe(false); // '0' not in base58
    expect(isPlaceholderNickname('ranger-lllOOO')).toBe(false); // 'l', 'O' not in base58
  });

  it('rejects non-placeholder names', () => {
    expect(isPlaceholderNickname('江湖浪人')).toBe(false);
    expect(isPlaceholderNickname('ranger-abc')).toBe(false);    // too short (3 chars)
    expect(isPlaceholderNickname('ranger-a1b2c3d4')).toBe(false); // too long (8 chars)
    expect(isPlaceholderNickname('')).toBe(false);
  });
});

describe('name_source', () => {
  it("persistNickname defaults source to 'owner' and readNameSource reflects it", async () => {
    const host = new InMemoryHostAdapter();
    await persistNickname(host, '青鸾');
    expect(await readNameSource(host)).toBe('owner');
  });

  it("persistNickname records explicit 'auto' source", async () => {
    const host = new InMemoryHostAdapter();
    await persistNickname(host, '夜行客', 'auto');
    const loaded = (await host.config.loadJson('plugin')) as Record<string, unknown>;
    expect((loaded.ranger_profile as Record<string, unknown>).name_source).toBe('auto');
    expect(await readNameSource(host)).toBe('auto');
  });

  it('readNameSource returns null when never set (legacy config)', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { ranger_profile: { nickname: 'legacy' } } },
    });
    expect(await readNameSource(host)).toBeNull();
  });

  it('updating nickname overwrites name_source', async () => {
    const host = new InMemoryHostAdapter();
    await persistNickname(host, '夜行客', 'auto');
    await persistNickname(host, '青鸾', 'owner');
    expect(await readNameSource(host)).toBe('owner');
  });
});

describe('InMemoryConfig saveJson', () => {
  it('saveJson → loadJson roundtrip', async () => {
    const cfg = new InMemoryConfig({});
    await cfg.saveJson('plugin', { foo: 'bar' });
    expect(await cfg.loadJson('plugin')).toEqual({ foo: 'bar' });
  });

  it('saveJson overwrites existing value for same name', async () => {
    const cfg = new InMemoryConfig({ plugin: { old: 1 } });
    await cfg.saveJson('plugin', { new: 2 });
    expect(await cfg.loadJson('plugin')).toEqual({ new: 2 });
  });

  it('saveJson for one key does not affect other keys', async () => {
    const cfg = new InMemoryConfig({ other: { x: 10 } });
    await cfg.saveJson('plugin', { y: 20 });
    expect(await cfg.loadJson('other')).toEqual({ x: 10 });
  });
});
