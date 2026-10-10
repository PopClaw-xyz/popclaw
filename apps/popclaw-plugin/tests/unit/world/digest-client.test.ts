import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import {
  parseDigest,
  readCachedDigest,
  refreshHouseDigest,
  readHouseDigestUrl,
} from '../../../src/world/digest-client.js';

/** Real popclaw.world response fetched by host-a on 2026-07-31, retained verbatim as a regression baseline. */
const LIVE = JSON.stringify({
  as_of: '2026-07-31T07:04:00.117Z',
  ranking_basis: '按小屋落成时间倒序（世界刚开张，到访数尚无区分度，不以其排序）',
  me: {
    figures: [
      { figure: '蒂法', state: 'home', city: null, visit_url: 'https://popclaw.world/h/7t4k2n9q' },
    ],
  },
  homes: [
    {
      name: '伊芙',
      visit_url: 'https://popclaw.world/h/3m8v5x1p',
      cover_img: 'https://cdn.example/room.jpg',
      voice: '一间宽敞开阔的圆弧形宇宙飞船舱内卧室…',
      built_at: '2026-07-29T07:41:07.280Z',
      visits_today: 0,
      owner: { nickname: null, sigil: '3m8v5x1p', display: '3m8v5x1p' },
    },
  ],
});

let root: string;
let paths: PopclawPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'popclaw-digest-'));
  paths = new PopclawPaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseDigest', () => {
  it('解真机响应：时间是 ISO 字符串、me 是 figures 数组、owner 无 popclaw_id', () => {
    const d = parseDigest(LIVE);
    expect(d).not.toBeNull();
    expect(d!.as_of).toBe('2026-07-31T07:04:00.117Z');
    expect(d!.ranking_basis).toContain('落成时间倒序');
    expect(d!.figures).toHaveLength(1);
    expect(d!.figures[0]).toEqual({
      figure: '蒂法',
      state: 'home',
      visit_url: 'https://popclaw.world/h/7t4k2n9q',
    });
    expect(d!.homes[0]!.owner).toEqual({ sigil: '3m8v5x1p', display: '3m8v5x1p' });
    expect(d!.homes[0]!.visits_today).toBe(0);
    expect(d!.homes[0]!.built_at).toBe('2026-07-29T07:41:07.280Z');
  });

  it('away 一程按 world 侧源码的真实字段名解（day / postcards_sent / postcards_total / return_at）', () => {
    const d = parseDigest(
      JSON.stringify({
        as_of: '2026-07-31T07:04:00.117Z',
        me: {
          figures: [
            {
              figure: '小蓝',
              state: 'away',
              city: '苏州',
              day: 2,
              postcards_sent: 2,
              postcards_total: 4,
              return_at: '2026-08-01T02:00:00.000Z',
              visit_url: 'https://popclaw.world/h/abc',
            },
          ],
        },
        homes: [],
      }),
    );
    expect(d!.figures[0]).toMatchObject({
      state: 'away',
      city: '苏州',
      day: 2,
      postcards_sent: 2,
      postcards_total: 4,
      return_at: '2026-08-01T02:00:00.000Z',
    });
  });

  it('坏 JSON / 缺 as_of / 非对象 → null（宁可没有，绝不半信）', () => {
    expect(parseDigest('not json')).toBeNull();
    expect(parseDigest('[]')).toBeNull();
    expect(parseDigest(JSON.stringify({ homes: [] }))).toBeNull();
  });

  it('缺必需字段的家整卡丢弃（name / visit_url），其余照排', () => {
    const d = parseDigest(
      JSON.stringify({
        as_of: 'x',
        homes: [
          { name: '', visit_url: 'https://a/1' },
          { name: '有名无门', visit_url: '' },
          { name: '好家', visit_url: 'https://a/2' },
        ],
      }),
    );
    expect(d!.homes.map((h) => h.name)).toEqual(['好家']);
  });

  it('owner.popclaw_id（2026-07-31T07:32 上线）解出来；缺失/空仍不带该字段', () => {
    const d = parseDigest(
      JSON.stringify({
        as_of: 'x',
        homes: [
          {
            name: '伊芙',
            visit_url: 'https://popclaw.world/h/3m8v5x1p',
            owner: {
              nickname: null,
              sigil: '3m8v5x1p',
              popclaw_id: 'Demo12347Yz3knd6xwGcvvpGPZCSXB4DcTzzov9AAAA',
              display: '3m8v5x1p',
            },
          },
          {
            name: '老坊',
            visit_url: 'https://popclaw.world/h/old',
            owner: { sigil: 'oldsigil1', display: 'oldsigil1', popclaw_id: '' },
          },
        ],
      }),
    );
    expect(d!.homes[0]!.owner).toEqual({
      sigil: '3m8v5x1p',
      popclaw_id: 'Demo12347Yz3knd6xwGcvvpGPZCSXB4DcTzzov9AAAA',
      display: '3m8v5x1p',
    });
    expect(d!.homes[1]!.owner).toEqual({ sigil: 'oldsigil1', display: 'oldsigil1' });
    expect('popclaw_id' in d!.homes[1]!.owner).toBe(false);
  });

  it('未知字段忽略，不炸（加法超集）', () => {
    const d = parseDigest(
      JSON.stringify({ as_of: 'x', hot_places: [{ name: 'z' }], brand_new_key: 1, homes: [] }),
    );
    expect(d).not.toBeNull();
    expect(d!.homes).toEqual([]);
  });
});

describe('refreshHouseDigest', () => {
  const url = 'https://popclaw.world/api/popclaw/digest?id=ID';

  it('200 → 落盘缓存 + 记 ETag，返回 digest', async () => {
    const fetchFn = (async () =>
      new Response(LIVE, { status: 200, headers: { etag: '"v1"' } })) as typeof fetch;
    const d = await refreshHouseDigest(url, { paths, slug: 'popclaw.world', fetch: fetchFn });
    expect(d!.figures[0]!.figure).toBe('蒂法');
    const raw = JSON.parse(readFileSync(paths.houseDigestFile('popclaw.world'), 'utf8'));
    expect(raw.etag).toBe('"v1"');
    expect(raw.digest.figures[0].figure).toBe('蒂法');
  });

  it('304 → 用缓存（带上 If-None-Match）', async () => {
    let sentEtag: string | undefined;
    const first = (async () =>
      new Response(LIVE, { status: 200, headers: { etag: '"v1"' } })) as typeof fetch;
    await refreshHouseDigest(url, { paths, slug: 'popclaw.world', fetch: first });
    const second = (async (_u: string, init?: RequestInit) => {
      sentEtag = (init?.headers as Record<string, string> | undefined)?.['if-none-match'];
      return new Response('', { status: 304 });
    }) as unknown as typeof fetch;
    const d = await refreshHouseDigest(url, { paths, slug: 'popclaw.world', fetch: second });
    expect(sentEtag).toBe('"v1"');
    expect(d!.figures[0]!.figure).toBe('蒂法');
  });

  it('网络失败 → 静默降级到落盘缓存', async () => {
    const ok = (async () => new Response(LIVE, { status: 200 })) as typeof fetch;
    await refreshHouseDigest(url, { paths, slug: 'popclaw.world', fetch: ok });
    const boom = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const d = await refreshHouseDigest(url, { paths, slug: 'popclaw.world', fetch: boom });
    expect(d!.homes[0]!.name).toBe('伊芙');
  });

  it('失败且无缓存 → undefined（当没有，绝不掀翻报纸）', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    expect(
      await refreshHouseDigest(url, { paths, slug: 'popclaw.world', fetch: boom }),
    ).toBeUndefined();
  });

  it('坏 JSON → 降级到缓存，不覆盖缓存', async () => {
    const ok = (async () => new Response(LIVE, { status: 200 })) as typeof fetch;
    await refreshHouseDigest(url, { paths, slug: 'popclaw.world', fetch: ok });
    const junk = (async () => new Response('<html>502</html>', { status: 200 })) as typeof fetch;
    const d = await refreshHouseDigest(url, { paths, slug: 'popclaw.world', fetch: junk });
    expect(d!.homes[0]!.name).toBe('伊芙');
    expect(readCachedDigest(paths, 'popclaw.world')!.homes[0]!.name).toBe('伊芙');
  });

  it('3 秒封顶：超时信号传给 fetch', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(LIVE, { status: 200 });
    }) as unknown as typeof fetch;
    await refreshHouseDigest(url, { paths, slug: 'popclaw.world', fetch: fetchFn });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('readHouseDigestUrl', () => {
  function seedGuide(md: string): void {
    mkdirSync(paths.lorehousesDir(), { recursive: true });
    writeFileSync(paths.houseGuideFile('popclaw.world'), md, 'utf8');
  }

  it('从落盘 guide frontmatter 取 digest_url 并替换 {popclaw_id}', () => {
    seedGuide(
      '---\nworld: popclaw.world\nnewspaper:\n  digest_url: https://popclaw.world/api/popclaw/digest?id={popclaw_id}\n---\n正文\n',
    );
    expect(readHouseDigestUrl(paths, 'popclaw.world', 'AUkP7')).toBe(
      'https://popclaw.world/api/popclaw/digest?id=AUkP7',
    );
  });

  it('坊没声明 / 没握过手 → undefined（绝不猜路径）', () => {
    expect(readHouseDigestUrl(paths, 'popclaw.world', 'AUkP7')).toBeUndefined();
    seedGuide('---\nworld: popclaw.world\n---\n');
    expect(readHouseDigestUrl(paths, 'popclaw.world', 'AUkP7')).toBeUndefined();
  });

  it('非 http(s) 一律拒（说明书是外部文档，不许变成本地文件读取口）', () => {
    seedGuide('---\nnewspaper:\n  digest_url: file:///etc/passwd\n---\n');
    expect(readHouseDigestUrl(paths, 'popclaw.world', 'AUkP7')).toBeUndefined();
  });

  it('主人还没有 popclaw_id → undefined（不发一条带空占位的请求）', () => {
    seedGuide('---\nnewspaper:\n  digest_url: https://a/d?id={popclaw_id}\n---\n');
    expect(readHouseDigestUrl(paths, 'popclaw.world', '')).toBeUndefined();
  });
});
