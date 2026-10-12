/**
 * Spec B, slice 1: lore_houses now means connect all; [0] is the primary House.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory';
import { bootstrapPlugin } from '../../../src/runtime/plugin-bootstrap';
import { PopclawPaths } from '../../../src/host/popclaw-paths';

const boot = (lore_houses: string[]) =>
  bootstrapPlugin(new InMemoryHostAdapter({ config: { plugin: { lore_houses } } }));

describe('bootstrapPlugin — lore_houses', () => {
  it('单坊（现网存量配置）：主坊 = 唯一那座，全量列表就是它自己', async () => {
    const b = await boot(['http://localhost:8080']);
    expect(b.loreHouseUrl).toBe('http://localhost:8080');
    expect(b.loreHouseUrls).toEqual(['http://localhost:8080']);
  });

  it('多坊：全部保留、保序，[0] 仍是主坊（写侧继续用 loreHouseUrl）', async () => {
    const b = await boot(['https://house.popclaw.me', 'https://house.popclaw.world']);
    expect(b.loreHouseUrl).toBe('https://house.popclaw.me');
    expect(b.loreHouseUrls).toEqual(['https://house.popclaw.me', 'https://house.popclaw.world']);
  });

  it('同一座坊写重复（配置手滑）按 slug 去重 —— 否则两条 SSE 抢同一个 <slug>.db', async () => {
    const b = await boot([
      'https://house.popclaw.me',
      'https://house.popclaw.me/',
      'https://house.popclaw.world',
    ]);
    expect(b.loreHouseUrls).toEqual(['https://house.popclaw.me', 'https://house.popclaw.world']);
  });

  it('空数组照旧失败（至少要有一座坊可推）', async () => {
    await expect(boot([])).rejects.toThrow();
  });
});

describe('bootstrapPlugin — identityGenerated', () => {
  it('首次开机铸新身份 → true；同一 host 重启 → false', async () => {
    const host = new InMemoryHostAdapter({ config: { plugin: { lore_houses: ['http://x'] } } });
    expect((await bootstrapPlugin(host)).identityGenerated).toBe(true);
    expect((await bootstrapPlugin(host)).identityGenerated).toBe(false);
  });
});

describe('bootstrapPlugin — 同机第二份身份', () => {
  const made: string[] = [];
  const before = process.env.POPCLAW_DATA_ROOT;
  afterEach(() => {
    if (before === undefined) delete process.env.POPCLAW_DATA_ROOT;
    else process.env.POPCLAW_DATA_ROOT = before;
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A state dir whose `<stateDir>/popclaw` root does or doesn't already hold a master.key. */
  function stateDir(withIdentity: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'popclaw-root-'));
    made.push(dir);
    if (withIdentity) {
      const identity = new PopclawPaths(join(dir, 'popclaw')).identityDir();
      mkdirSync(identity, { recursive: true });
      writeFileSync(join(identity, 'master.key'), '{}');
    }
    return dir;
  }

  const notices = (host: InMemoryHostAdapter) =>
    host.logger.records.filter((r) => /another popclaw identity/.test(r.msg));

  const hostWith = () => new InMemoryHostAdapter({ config: { plugin: { lore_houses: ['http://x'] } } });

  it('names the other identity when POPCLAW_DATA_ROOT shadows a root that has one', async () => {
    const dir = stateDir(true);
    process.env.POPCLAW_DATA_ROOT = join(dir, 'elsewhere');
    const host = hostWith();
    await bootstrapPlugin(host, dir);
    expect(notices(host)).toHaveLength(1);
    // Never a warning: two roots is legal. The danger is only in not knowing.
    expect(notices(host)[0]!.level).toBe('info');
    expect(String(notices(host)[0]!.obj.other)).toContain('popclaw');
  });

  it('stays quiet when the shadowed root is just an empty directory — a maybe is worse than silence', async () => {
    const dir = stateDir(false);
    process.env.POPCLAW_DATA_ROOT = join(dir, 'elsewhere');
    const host = hostWith();
    await bootstrapPlugin(host, dir);
    expect(notices(host)).toEqual([]);
  });

  it('stays quiet with no override at all — there is no second candidate to name', async () => {
    const dir = stateDir(true);
    delete process.env.POPCLAW_DATA_ROOT;
    const host = hostWith();
    await bootstrapPlugin(host, dir);
    expect(notices(host)).toEqual([]);
  });
});

it('rejects distinct origins that would share one house cache slug', async () => {
  await expect(boot(['http://localhost:8080', 'https://localhost:8080'])).rejects.toThrow('HOUSE_ORIGIN_SLUG_COLLISION');
});

/**
 * The publisher is an owner-level setting, and "off" has to be sayable.
 * `canvas_base_url` (plugin config) → `POPCLAW_CANVAS_BASE_URL` (env) →
 * the public default; an EXPLICIT empty value anywhere in that chain means
 * "there is no publisher" and boots with `canvasBaseUrl: null`.
 */
describe('bootstrapPlugin — canvasBaseUrl (the publisher switch)', () => {
  const before = process.env.POPCLAW_CANVAS_BASE_URL;
  afterEach(() => {
    if (before === undefined) delete process.env.POPCLAW_CANVAS_BASE_URL;
    else process.env.POPCLAW_CANVAS_BASE_URL = before;
  });

  const bootWith = (plugin: Record<string, unknown>) =>
    bootstrapPlugin(
      new InMemoryHostAdapter({ config: { plugin: { lore_houses: ['http://localhost:8080'], ...plugin } } }),
    );

  it('unset config and unset env → the public default', async () => {
    delete process.env.POPCLAW_CANVAS_BASE_URL;
    expect((await bootWith({})).canvasBaseUrl).toBe('https://canvas.popclaw.me');
  });

  it('a config URL is the publisher', async () => {
    delete process.env.POPCLAW_CANVAS_BASE_URL;
    expect((await bootWith({ canvas_base_url: 'http://192.0.2.6:8788' })).canvasBaseUrl).toBe('http://192.0.2.6:8788');
  });

  it('canvas_base_url: "" → no publisher at all (null), even with the env var pointing somewhere', async () => {
    process.env.POPCLAW_CANVAS_BASE_URL = 'http://env:9';
    expect((await bootWith({ canvas_base_url: '' })).canvasBaseUrl).toBeNull();
  });

  it('an empty POPCLAW_CANVAS_BASE_URL → no publisher (it must not fall through to the default)', async () => {
    process.env.POPCLAW_CANVAS_BASE_URL = '';
    expect((await bootWith({})).canvasBaseUrl).toBeNull();
  });
});
