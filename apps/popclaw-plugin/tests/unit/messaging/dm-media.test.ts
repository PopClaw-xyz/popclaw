/**
 * #231 第 2 刀 — 私信带图的磁盘那一端（读本地图 / 收到的图落盘）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import { MAX_DM_MEDIA_BYTES } from '../../../src/messaging/dm-crypto.js';
import { loadDmAttachment, saveDmMedia, receiveDmMedia, dmMediaFileName } from '../../../src/messaging/dm-media.js';
import { setOwnerTz } from '../../../src/time/time-context.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S13 slice: loadDmAttachment's error text now renders in `ownerLang()`
// (default en-US) instead of hardcoded zh — pin zh-CN so the assertions below
// stay meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

function makeSigner(seedByte: number): MasterKeySigner {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i + seedByte) & 0xff;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = {
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  };
  return new MasterKeySigner(key);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'popclaw-dm-media-'));
}

describe('loadDmAttachment — 发送侧的闸', () => {
  it('maps the four allowed extensions to their mime (case-insensitive)', () => {
    const dir = tmp();
    const cases: Array<[string, string]> = [
      ['a.jpg', 'image/jpeg'],
      ['a.JPEG', 'image/jpeg'],
      ['a.png', 'image/png'],
      ['a.gif', 'image/gif'],
      ['a.webp', 'image/webp'],
    ];
    for (const [name, mime] of cases) {
      const p = join(dir, name);
      writeFileSync(p, Buffer.from([1, 2, 3]));
      const r = loadDmAttachment(p);
      expect(r.ok && r.mime).toBe(mime);
      expect(r.ok && r.name).toBe(name);
    }
  });

  it('rejects an unrecognised extension without reading the file', () => {
    const dir = tmp();
    const p = join(dir, 'shot.heic');
    writeFileSync(p, Buffer.from([1]));
    const r = loadDmAttachment(p);
    expect(r.ok).toBe(false);
    // heic 仍然不收 —— 放开的是语音/文本，不是「什么都收」；文案要把认的列出来。
    expect(!r.ok && r.text).toMatch(/jpg\/png\/gif\/webp/);
  });

  it('rejects an extensionless path', () => {
    const r = loadDmAttachment('/tmp/no-extension-here');
    expect(r.ok).toBe(false);
  });

  it('rejects a file over MAX_DM_MEDIA_BYTES with the real numbers', () => {
    const dir = tmp();
    const p = join(dir, 'huge.png');
    writeFileSync(p, Buffer.alloc(MAX_DM_MEDIA_BYTES + 1));
    const r = loadDmAttachment(p);
    expect(r.ok).toBe(false);
    // 诚实文案：多大、上限多少、下一步怎么办。
    expect(!r.ok && r.text).toContain('1024.0 KB'); // the cap
    expect(!r.ok && r.text).toMatch(/压/);
  });

  it('accepts a file exactly at the cap', () => {
    const dir = tmp();
    const p = join(dir, 'edge.png');
    writeFileSync(p, Buffer.alloc(MAX_DM_MEDIA_BYTES));
    expect(loadDmAttachment(p).ok).toBe(true);
  });

  it('reports an unreadable path instead of throwing', () => {
    const r = loadDmAttachment('/definitely/not/here.png');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.text).toMatch(/读不到/);
  });

  it('rejects an empty file', () => {
    const dir = tmp();
    const p = join(dir, 'empty.png');
    writeFileSync(p, Buffer.alloc(0));
    expect(loadDmAttachment(p).ok).toBe(false);
  });
});

describe('saveDmMedia — 收信侧落盘', () => {
  it('writes the exact bytes under a readable name (see dmMediaFileName)', () => {
    const dir = join(tmp(), 'dm-media'); // not created yet — mkdir -p is ours
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const path = saveDmMedia(dir, { ts: 1700000000, fromPopclawId: 'ABCDEFGHIJKL' }, {
      mime: 'image/png',
      bytes,
    });
    expect(path).toContain(dmMediaFileName(1700000000, 'ABCDEFGHIJKL', 'png', { sigilOf: deriveSigil }).replace('.png', '-'));
    expect(path).toMatch(/-[a-f0-9]{64}\.png$/);
    expect(new Uint8Array(readFileSync(path!))).toEqual(bytes);
  });

  it('is idempotent across an SSE replay — same bytes reuse the immutable file', () => {
    const dir = tmp();
    const dm = { ts: 42, fromPopclawId: 'zzzzzzzzzz' };
    const media = { mime: 'image/gif', bytes: new Uint8Array([1]) };
    const first = saveDmMedia(dir, dm, media);
    expect(saveDmMedia(dir, dm, media)).toBe(first);
    // 时间与印信两段不变 → 重放仍写同一个路径（名号会变的那一小撮见 dmMediaFileName 注释）
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('returns null (never throws) when the write fails', () => {
    const onError = vi.fn();
    // A path under a regular file can't be a directory → mkdir fails.
    const file = join(tmp(), 'a-file');
    writeFileSync(file, 'x');
    expect(saveDmMedia(join(file, 'nope'), { ts: 1, fromPopclawId: 'a' }, {
      mime: 'image/png',
      bytes: new Uint8Array([1]),
    }, onError)).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('receiveDmMedia — 解密 + 落盘的那一行', () => {
  const alice = makeSigner(1);
  const bob = makeSigner(99);

  async function sealedDm(bytes: Uint8Array, mime = 'image/png') {
    const bobId = await bob.popclawId();
    const sealed = alice.sealDmMedia(bytes, mime, bobId);
    return {
      fromPopclawId: await alice.popclawId(),
      toPopclawId: bobId,
      body: 'x',
      ts: 1700000123,
      mediaCiphertext: sealed.ciphertext,
      mediaNonce: sealed.nonce,
    };
  }

  it('round-trips the original bytes onto disk', async () => {
    const dir = tmp();
    const original = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x42]);
    const warn = vi.fn();
    const path = receiveDmMedia(await sealedDm(original), bob, dir, 1700000123, warn);
    expect(path).toBeTruthy();
    expect(new Uint8Array(readFileSync(path!))).toEqual(original);
    expect(warn).not.toHaveBeenCalled();
  });

  it('picks the extension from the sealed mime, not the sender', async () => {
    const dir = tmp();
    const path = receiveDmMedia(await sealedDm(new Uint8Array([1]), 'image/webp'), bob, dir, 7, vi.fn());
    expect(path).toMatch(/\.webp$/);
  });

  it('returns null + warns (no file, no throw) when the picture is corrupt', async () => {
    const dir = tmp();
    const dm = await sealedDm(new Uint8Array([1, 2, 3]));
    dm.mediaCiphertext[0]! ^= 0xff; // tamper → Poly1305 fails
    const warn = vi.fn();
    expect(receiveDmMedia(dm, bob, dir, 1, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, '1-' + (await alice.popclawId()).slice(0, 8) + '.png'))).toBe(false);
  });

  it('returns null silently for a DM with no picture at all', async () => {
    const warn = vi.fn();
    const dm = { fromPopclawId: await alice.popclawId(), toPopclawId: await bob.popclawId(), body: 'hi', ts: 1 };
    expect(receiveDmMedia(dm, bob, tmp(), 1, warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

// 放开格式（2026-07-31）：语音与 agent 读得懂的文本。zip / 可执行文件仍然不收。
describe('loadDmAttachment — 语音与文本', () => {
  function write(name: string, bytes = 16): string {
    const p = join(mkdtempSync(join(tmpdir(), 'popclaw-att-')), name);
    writeFileSync(p, Buffer.alloc(bytes, 7));
    return p;
  }

  it.each([
    ['voice.ogg', 'audio/ogg'],
    ['voice.opus', 'audio/ogg'],
    ['voice.m4a', 'audio/mp4'],
    ['note.mp3', 'audio/mpeg'],
    ['spec.md', 'text/markdown'],
    ['data.csv', 'text/csv'],
    ['payload.json', 'application/json'],
  ])('%s → %s', (name, mime) => {
    const r = loadDmAttachment(write(name));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mime).toBe(mime);
  });

  it.each(['payload.zip', 'run.sh', 'a.exe', 'lib.so'])('%s 一律拒（不是"什么都收"）', (name) => {
    const r = loadDmAttachment(write(name));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text).toContain('发不了');
  });

  // mime 是发信方写进盒子的：落盘扩展名若跟着他走，他就能决定文件在你磁盘上叫什么。
  it('认不出的 mime 落成 .bin，绝不让发信人挑扩展名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'popclaw-save-'));
    const p = saveDmMedia(dir, { ts: 1, fromPopclawId: 'ABCDEFGH' }, {
      mime: 'application/x-sh',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(p).toMatch(/\.bin$/); // 认不出的 mime → .bin，发信人挑不了扩展名
  });
});

// 主人原话（2026-07-31）：`1785481431-5E7DAm6B.ogg` 这种"一串英文数字"可读性太差，
// 收多了会搞混。三样材料分工：时间给顺序、名号给可读、印信兜底且伪造不了。
describe('dmMediaFileName — 落盘名要人看得懂', () => {
  // 名字里带主人本地日期 → **每条用例都必须钉住时区**，否则本地 +08 过、CI 跑 UTC 挂
  // （2026-07-31 真机就这么挂过一次）。
  beforeEach(() => setOwnerTz('Asia/Shanghai'));
  afterEach(() => setOwnerTz(null));

  const SIG = '9b2y5d3f';
  const naming = { sigilOf: () => SIG, nameOf: () => '素问小待诏' };
  const TS = 1785481431; // 2026-07-31 15:03:51 +08

  it('日期_时分_名号-印信.扩展名', () => {
    expect(dmMediaFileName(TS, 'X', 'ogg', naming)).toBe(`2026-07-31_1503_素问小待诏-${SIG}.ogg`);
  });

  it('主人本地时区说了算（同一封信在不同时区落成不同的名）', () => {
    setOwnerTz('America/New_York');
    expect(dmMediaFileName(TS, 'X', 'ogg', naming)).toContain('2026-07-31_03');
  });

  // 名号是**发信方自报的** —— 绝不能原样进路径。
  it.each([
    ['../../evil', 'evil'],
    ['a/b', 'ab'],
    ['苍梧<script>', '苍梧script'],
  ])('名号 %s 消毒成 %s，路径分隔符一个不留', (raw, cleaned) => {
    const out = dmMediaFileName(TS, 'X', 'ogg', { sigilOf: () => SIG, nameOf: () => raw });
    expect(out).toContain(cleaned);
    expect(out).not.toContain('/');
    expect(out).not.toContain('..');
  });

  it('超长名号截断（不许拿文件名撑爆路径）', () => {
    const out = dmMediaFileName(TS, 'X', 'ogg', { sigilOf: () => SIG, nameOf: () => '龙'.repeat(200) });
    expect(out.length).toBeLessThan(60);
  });

  it('名号消毒后为空（纯 emoji/符号）→ 只留印信，不比今天更差', () => {
    const out = dmMediaFileName(TS, 'X', 'ogg', { sigilOf: () => SIG, nameOf: () => '🎉✨' });
    expect(out).toBe(`2026-07-31_1503_${SIG}.ogg`);
  });

  it('没有名号来源时也能起名（印信永远在）', () => {
    expect(dmMediaFileName(TS, 'X', 'ogg', { sigilOf: () => SIG })).toBe(`2026-07-31_1503_${SIG}.ogg`);
  });
});
