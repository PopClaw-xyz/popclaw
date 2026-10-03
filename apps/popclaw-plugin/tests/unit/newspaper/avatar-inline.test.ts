/**
 * 把脸烤进页面（方案 A，主人 2026-08-26 拍板）。
 *
 * 铁律只有一条：**最坏情况必须等于旧行为**。取不到、不是图、单张太大、超出本页
 * 预算 —— 一律保留远端 url，那本来就是今天的做法。任何一条走成「没有头像」都是回退。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inlineAvatars, type FetchedImage } from '../../../src/newspaper/avatar-inline.js';
import { monogramDataUri } from '../../../src/newspaper/author-block.js';

const png = (n = 64): FetchedImage => ({ bytes: new Uint8Array(n).fill(7), type: 'image/png' });
const A = 'https://unavatar.io/twitter/levelsio';
const B = 'https://unavatar.io/twitter/NASA';
const page = (...urls: string[]): string =>
  `<body>${urls.map((u) => `<img src="${u}" loading="lazy">`).join('')}</body>`;
/** The tag the renderer really emits: the remote face, with its own drawn stand-in beside it. */
const MONO = monogramDataUri('L', 'levelsio');
const withMono = (u: string): string =>
  `<body><img src="${u}" data-mono="${MONO}" referrerpolicy="no-referrer" loading="lazy"></body>`;
/** Every `src` on the page, in order. */
const srcs = (html: string): string[] => [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-avatars-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('inlineAvatars', () => {
  it('把脸烤进页面,读者一次第三方请求都不发', async () => {
    const asked: string[] = [];
    const { html, notes } = await inlineAvatars(page(A, B), {
      fetchImage: async (u) => (asked.push(u), png()),
    });
    expect(asked.sort()).toEqual([B, A].sort());
    expect(html).not.toContain('unavatar.io');
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(2);
    expect(notes).toEqual([]);
  });

  it('同一张脸出现多次只取一次,页面里每一处都换掉', async () => {
    let calls = 0;
    const { html } = await inlineAvatars(page(A, A, A), {
      fetchImage: async () => (calls += 1, png()),
    });
    expect(calls).toBe(1);
    expect(html).not.toContain('unavatar.io');
    expect(html.match(/data:image/g)).toHaveLength(3);
  });

  it('只认头像那个来源 —— 新闻配图照旧走远端(它们太大,烤进去会撑爆画布)', async () => {
    const html0 = page(A) + '<img src="https://pbs.twimg.com/media/x.jpg">';
    const { html } = await inlineAvatars(html0, { fetchImage: async () => png() });
    expect(html).toContain('https://pbs.twimg.com/media/x.jpg');
    expect(html).not.toContain('unavatar.io');
  });

  // Zero dependency (owner ruling 2026-09-12): what a miss falls back to is the
  // monogram the renderer already drew for that face, never the remote url. A
  // saved page that still reaches unavatar tells a third party who the owner
  // reads, which is the whole thing the baking exists to stop — and a page the
  // reader opens offline would show a gap where a face should be.
  it('a face we could not get falls back to the drawn monogram, never to the remote url', async () => {
    const { html, notes } = await inlineAvatars(withMono(A) + withMono(B), {
      fetchImage: async (u) => (u === A ? png() : null),
    });
    expect(html).not.toContain('unavatar.io');
    expect(srcs(html)).toEqual([expect.stringContaining('data:image/png;base64,'), MONO]);
    expect(notes.join()).toContain('1');
  });

  it('draws a monogram itself when the page has none to fall back to', async () => {
    const { html } = await inlineAvatars(page(A), { fetchImage: async () => null });
    expect(html).not.toContain('unavatar.io');
    expect(srcs(html)[0]).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('回来的不是图就不要 —— 挡住把一张错误页当头像拼进 src', async () => {
    const { html } = await inlineAvatars(withMono(A), {
      fetchImage: async () => ({ bytes: new Uint8Array(10).fill(1), type: 'text/html' }),
    });
    expect(html).not.toContain('data:text/html');
    expect(srcs(html)).toEqual([MONO]); // the stand-in, not a gap and not the remote url
  });

  it('单张太大不烤(一张病态的原图不许吃掉整页预算)', async () => {
    const { html, notes } = await inlineAvatars(withMono(A), {
      fetchImage: async () => png(200 * 1024),
    });
    expect(srcs(html)).toEqual([MONO]);
    expect(html).not.toContain('unavatar.io');
    expect(notes.join()).toContain('1');
  });

  it('预算用完就停,而且先花在出现次数最多的那张脸上', async () => {
    // A 出现三次、B 一次；预算只够一张。
    const one = `data:image/png;base64,${Buffer.alloc(300).toString('base64')}`.length;
    const { html, notes } = await inlineAvatars(withMono(A) + withMono(A) + withMono(A) + withMono(B), {
      fetchImage: async () => png(300),
      budget: one + 10,
    });
    expect(html).not.toContain(`src="${A}"`); // 出现最多的那张进了页面
    expect(html).not.toContain('unavatar.io'); // 另一张退回自画的字母头像,不是远端
    expect(srcs(html).filter((u) => u === MONO)).toHaveLength(1);
    expect(notes.join()).toContain("past this page's budget");
  });

  it('缓存:今天取过,明天一次都不用取', async () => {
    let calls = 0;
    const fetchImage = async (): Promise<FetchedImage> => (calls += 1, png());
    await inlineAvatars(page(A), { cacheDir: dir, fetchImage });
    const second = await inlineAvatars(page(A), { cacheDir: dir, fetchImage });
    expect(calls).toBe(1);
    expect(second.html).toContain('data:image/png');
  });

  it('缓存过期(28 天)就重新取', async () => {
    let calls = 0;
    const fetchImage = async (): Promise<FetchedImage> => (calls += 1, png());
    await inlineAvatars(page(A), { cacheDir: dir, fetchImage });
    const old = (Date.now() - 40 * 24 * 3600_000) / 1000;
    for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old);
    await inlineAvatars(page(A), { cacheDir: dir, fetchImage });
    expect(calls).toBe(2);
  });

  it('缓存文件坏了当作没缓存,绝不抛', async () => {
    await inlineAvatars(page(A), { cacheDir: dir, fetchImage: async () => png() });
    for (const f of readdirSync(dir)) writeFileSync(join(dir, f), 'not a data uri');
    const { html } = await inlineAvatars(page(A), { cacheDir: dir, fetchImage: async () => png() });
    expect(html).toContain('data:image/png');
  });

  it('页面上没有头像时什么都不做,一次都不取', async () => {
    let calls = 0;
    const { html, notes } = await inlineAvatars('<body><p>hi</p></body>', {
      fetchImage: async () => (calls += 1, png()),
    });
    expect([calls, notes.length]).toEqual([0, 0]);
    expect(html).toBe('<body><p>hi</p></body>');
  });

  // `newspaper.avatars: "off"` — the owner's opt-out. Nothing is asked of anyone.
  it('asks for nothing at all on "off", and still leaves a face on every row', async () => {
    let calls = 0;
    const { html, notes } = await inlineAvatars(withMono(A) + withMono(B), {
      mode: 'off',
      fetchImage: async () => (calls += 1, png()),
    });
    expect(calls).toBe(0);
    expect(html).not.toContain('unavatar.io');
    expect(srcs(html)).toEqual([MONO, MONO]);
    expect(notes).toEqual([]);
  });

  it('不给缓存目录也能跑(未接线的装配照旧出报)', async () => {
    const { html } = await inlineAvatars(page(A), { fetchImage: async () => png() });
    expect(html).toContain('data:image/png');
  });
});
