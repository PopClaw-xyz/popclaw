/**
 * S3 of #227 — encryption wired into the real DM send path and decryption into
 * the real receive path.
 *
 * The harness below drives the REAL consumer the three composition roots wire
 * (`runtime/inbox-consumer.ts#makeInboxOnMessage`): readDmBody → receiveDmMedia
 * → InboxStore.record → the `wasNew` gate → social log → plain-DM notice
 * → plain-DM handling. It used to re-type that sequence by hand; since the knife
 * that gave the three roots one shared copy, this file exercises that copy
 * directly, so every assertion below is a statement about production code.
 *
 * The load-bearing assertion of the whole file is 「一封解不开的信毒不死循环」:
 * that loop has a history of 3×/9× duplicate-delivery bugs, and a decryption
 * step is a brand-new way to throw inside it.
 */
import { describe, it, expect, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import type { Signer } from '../../../src/identity/signer.js';
import {
  signDirectMessage,
  DM_ENCRYPTED_BODY_PLACEHOLDER,
} from '../../../src/messaging/sign-message.js';
import { makeInboxOnMessage } from '../../../src/runtime/inbox-consumer.js';
import {
  openHouseInboxStreams,
  type AnyEventSource,
} from '../../../src/messaging/inbox-stream-client.js';
import { grantingReadAuthorityFor } from '../../helpers/read-authority.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOME = 'http://home.test';

/** A real signer whose popclaw_id IS base58(its own Ed25519 public key). */
function makeSigner(seedByte: number): MasterKeySigner {
  const seed = new Uint8Array(32).fill(seedByte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = {
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  };
  return new MasterKeySigner(key);
}

const alice = makeSigner(0xa1); // sender
const me = makeSigner(0x0e); // recipient
const mallory = makeSigner(0x33); // third party
const ALICE = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0xa1)).publicKey);
const ME = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x0e)).publicKey);

/** Sign a DM the way the command surface does, then hand back the wire DM the
 *  lore-house would relay (it rebuilds a bare DirectMessage from the envelope). */
async function sentDm(
  from: Signer,
  toPopclawId: string,
  body: string,
  ts = 1000,
): Promise<popclaw.event.IDirectMessage> {
  const signed = await signDirectMessage(from, { toPopclawId, body, nickname: 'Alice', ts });
  const sp = popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes);
  const env = popclaw.event.EventEnvelope.decode(sp.payload);
  return env.directMessage!;
}

function frame(dm: popclaw.event.IDirectMessage): string {
  // P0-A: the inbox stream now relays the full EventEnvelope, not a bare DM.
  const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0xa1));
  const env = { actor: { popclawId: ALICE }, directMessage: dm };
  const canonical = canonicalizeEnvelope(env);
  const bytes = popclaw.event.EventEnvelope.encode({ ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, key.secretKey) }).finish();
  return Buffer.from(bytes).toString('base64');
}

/** The production consumer, wired the way every root wires it. */
async function wire(recipient: Signer) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const store = new InboxStore(db);
  const delivered: string[] = [];
  const skipped: string[] = [];
  const notices: string[] = [];
  const social: Array<{ kind: string; text?: string }> = [];

  const byUrl = new Map<string, AnyEventSource & { listeners: Record<string, (e: { data: string }) => void> }>();
  const Ctor = class {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    listeners: Record<string, (e: { data: string }) => void> = {};
    constructor(readonly url: string) {
      byUrl.set(url, this as unknown as AnyEventSource & { listeners: Record<string, (e: { data: string }) => void> });
    }
    addEventListener(type: string, listener: (e: { data: string }) => void): void {
      this.listeners[type] = listener;
    }
    close(): void {}
  } as unknown as new (url: string) => AnyEventSource;

  const streams = openHouseInboxStreams([HOME], {
    recipientPopclawId: ME,
    readAuthorityFor: grantingReadAuthorityFor,
    onMessage: makeInboxOnMessage({
      signer: recipient,
      inboxStore: store,
      socialLog: { record: (e) => social.push(e) },
      // No attachment rides any of these DMs, so receiveDmMedia never touches
      // the directory — an unwritable path keeps the harness filesystem-free.
      dmMediaDir: () => '/popclaw-test/never-written',
      // Both the no-spoiler ticket notice and the plain-DM arrival line land here.
      info: (m) => notices.push(m),
      // The consumer hands out a whole line; these tests care about the reason
      // readDmBody reported, so pull it back out (and pin the line's shape).
      warn: (m) => {
        const reason = /\(([a-z_]+)\) — skipped$/.exec(m);
        if (reason) skipped.push(reason[1]!);
      },
      onPlainDm: ({ body, item }) => {
        if (store.settleNotification(item.id, 'queued')) delivered.push(body);
      },
    }),
    onError: (_slug, err) => skipped.push(String(err).replace('Error: ', '')),
    eventSourceCtor: Ctor,
  });
  for (const s of streams) s.client.start();
  // signer is required now (#227 close-out): start() goes through the async
  // buildInboxToken().then(open) path, so the fake EventSource isn't
  // constructed synchronously anymore — wait for it before handing back feed.
  await vi.waitFor(() => expect(byUrl.has(`${HOME}/inbox/${encodeURIComponent(ME)}/stream`)).toBe(true));

  return {
    store,
    delivered,
    skipped,
    notices,
    social,
    feed: (dm: popclaw.event.IDirectMessage) =>
      byUrl.get(`${HOME}/inbox/${encodeURIComponent(ME)}/stream`)!.listeners.envelope!({
        data: frame(dm),
      }),
  };
}

describe('DM 写路径 · signDirectMessage 加密', () => {
  it('正文进密文，field 4 只留 base64 占位串（老灯坊拒空正文）', async () => {
    const dm = await sentDm(alice, ME, 'are you free for a chat?');
    expect(dm.body).toBe(DM_ENCRYPTED_BODY_PLACEHOLDER);
    expect(dm.body).not.toBe('');
    expect(dm.ciphertext!.length).toBeGreaterThan(0);
    expect(dm.nonce!.length).toBe(24);
    // 明文不得以任何形式留在线上字节里
    const wire = Buffer.from(popclaw.event.DirectMessage.encode(dm).finish()).toString('utf8');
    expect(wire).not.toContain('are you free');
  });

  it('每封信一个新 nonce（同样的正文两次，密文不同）', async () => {
    const a = await sentDm(alice, ME, 'same text', 100);
    const b = await sentDm(alice, ME, 'same text', 100);
    expect(Buffer.from(a.nonce!).equals(Buffer.from(b.nonce!))).toBe(false);
    expect(Buffer.from(a.ciphertext!).equals(Buffer.from(b.ciphertext!))).toBe(false);
  });

  it('收件人 id 不是可用公钥 → 发信侧响亮失败（绝不悄悄降级成明文）', async () => {
    await expect(
      signDirectMessage(alice, { toPopclawId: 'Bob', body: 'hi', nickname: 'Alice' }),
    ).rejects.toThrow(/recipient popclaw_id/);
  });
});

describe('DM 读路径 · 单点解密', () => {
  it('端到端：真发真收，收件人拿到的是明文（含非 ASCII）', async () => {
    const w = await wire(me);
    return sentDm(alice, ME, '你好，江湖见 🏮').then((dm) => {
      w.feed(dm);
      expect(w.delivered).toEqual(['你好，江湖见 🏮']);
      // 本地存的是明文（下游消费者一行不改）
      expect(w.store.recent(10).map((x) => x.body)).toEqual(['你好，江湖见 🏮']);
    });
  });

  it('存量明文私信（无密文）照常投递 —— 永不迁移、永不回填', async () => {
    const w = await wire(me);
    w.feed({ fromPopclawId: ALICE, toPopclawId: ME, body: 'legacy plaintext', ts: 7 });
    expect(w.delivered).toEqual(['legacy plaintext']);
    expect(w.skipped).toEqual([]);
  });

  it('一封解不开的信只丢它自己，前后两封照常落地（循环绝不被毒死）', async () => {
    const w = await wire(me);
    const good1 = await sentDm(alice, ME, 'first', 1);
    const bad = await sentDm(alice, ME, 'poison', 2);
    bad.ciphertext = new Uint8Array([1, 2, 3, 4, 5]); // 损坏
    const good2 = await sentDm(alice, ME, 'third', 3);

    expect(() => {
      w.feed(good1);
      w.feed(bad);
      w.feed(good2);
    }).not.toThrow();

    expect(w.delivered).toEqual(['first', 'third']);
    expect(w.skipped).toEqual(['decrypt_failed']);
    expect(w.store.recent(10)).toHaveLength(2); // 坏的那封连库都没进
  });

  it('发给别人的密文（我不是收件人）→ 跳过，不落库', async () => {
    const w = await wire(me);
    const notForMe = await sentDm(alice, await mallory.popclawId(), 'not yours', 5);
    w.feed(notForMe);
    expect(w.delivered).toEqual([]);
    expect(w.skipped).toEqual(['RECIPIENT_MISMATCH']);
    expect(w.store.recent(10)).toHaveLength(0);
  });

  it('畸形密文的各种形状都只是跳过，永不抛：缺 nonce / nonce 长度错 / 发信人 id 不是公钥', async () => {
    const w = await wire(me);
    const noNonce = await sentDm(alice, ME, 'a', 11);
    delete (noNonce as { nonce?: unknown }).nonce;
    const shortNonce = await sentDm(alice, ME, 'b', 12);
    shortNonce.nonce = new Uint8Array(8);
    const badSender = await sentDm(alice, ME, 'c', 13);
    badSender.fromPopclawId = 'not-a-key';

    expect(() => {
      w.feed(noNonce);
      w.feed(shortNonce);
      w.feed(badSender);
    }).not.toThrow();
    expect(w.skipped).toEqual(['malformed_nonce', 'malformed_nonce', 'ACTOR_MISMATCH']);
    expect(w.delivered).toEqual([]);
  });

  it('连 Signer 自己抛异常都吞掉 —— 收口点对循环的承诺是 never-throw', async () => {
    const hostile: Signer = {
      publicKey: () => me.publicKey(),
      sign: (b) => me.sign(b),
      popclawId: () => me.popclawId(),
      sealDmMedia: (() => { throw new Error('not wired for this fake'); }) as never,
      openDmMedia: (() => ({ ok: false, reason: 'decrypt_failed' })) as never,
      sealDm: () => {
        throw new Error('nope');
      },
      openDm: () => {
        throw new Error('signer exploded');
      },
    };
    const w = await wire(hostile);
    const good = { fromPopclawId: ALICE, toPopclawId: ME, body: 'plain still fine', ts: 21 };
    const enc = await sentDm(alice, ME, 'never opened', 22);
    expect(() => {
      w.feed(enc);
      w.feed(good);
    }).not.toThrow();
    expect(w.skipped).toEqual(['decrypt_failed']);
    expect(w.delivered).toEqual(['plain still fine']);
  });
});

describe('社交日志 dm_received · 在 wasNew 闸之后只记一次', () => {
  it('回补重放同一封 → 库里一条，日志也只有一条', async () => {
    const w = await wire(me);
    const dm = await sentDm(alice, ME, 'logged once', 77);
    w.feed(dm);
    w.feed(dm);
    expect(w.social.filter((e) => e.kind === 'dm_received')).toHaveLength(1);
    expect(w.social[0]!.text).toBe('logged once');
  });
});

describe('DM 去重 · body_hash 在解密之后算', () => {
  it('SSE 回补重放同一封密文 → 只投递一次', async () => {
    const w = await wire(me);
    const dm = await sentDm(alice, ME, 'replayed', 42);
    w.feed(dm);
    w.feed(dm); // 逐字节相同的回补帧
    expect(w.delivered).toEqual(['replayed']);
    expect(w.store.recent(10)).toHaveLength(1);
  });

  it('distinct signed CIDs remain distinct messages even when plaintext and timestamp match', async () => {
    const w = await wire(me);
    w.feed(await sentDm(alice, ME, 'same body same ts', 99));
    w.feed(await sentDm(alice, ME, 'same body same ts', 99));
    expect(w.delivered).toEqual(['same body same ts', 'same body same ts']);
    expect(w.store.recent(10)).toHaveLength(2);
    expect(new Set(w.store.recent(10).map(item => item.eventId)).size).toBe(2);
  });
});

describe('红包票据形状的私信按普通认证文本处理', () => {
  const ticketBody = JSON.stringify({
    kind: 'popclaw/redpacket-ticket@1',
    redPacketId: 'ab'.repeat(32),
    title: '恭喜发财',
    chain: 'eip155:31337',
    expiresAt: 1999999999,
    eligibilityProof: ['0x' + 'aa'.repeat(32)],
    amountsPack: [{ slotIndex: 0, amountMicro: '10000', proof: ['0x' + 'bb'.repeat(32)] }],
  });

  it('票据 JSON 加密发出、解密收到，按普通私信投递且可去重（不解析、不执行支付指令）', async () => {
    const w = await wire(me);
    const dm = await sentDm(alice, ME, ticketBody, 500);
    expect(dm.body).toBe(DM_ENCRYPTED_BODY_PLACEHOLDER); // 灯坊运营者读不到内容
    w.feed(dm);
    w.feed(dm); // SSE 回补重放同一封密文 → 只投递一次

    // 没有票据消费者：正文就是一封普通认证私信，原样送达、可去重恢复。
    expect(w.delivered).toEqual([ticketBody]);
    expect(w.store.recent(10)).toHaveLength(1);
    expect(w.notices[0]).toContain('inbox — DM from');
  });
});


describe('authenticated plain-message handoff', () => {
  it.each(['', '\uFEFFalready opened \uFFFD 🏮'])('preserves the authenticated text %j without decrypting it twice', async (text) => {
    const recipient = makeSigner(0x0e);
    const dm = await sentDm(alice, ME, text);
    const opened = recipient.openDm(dm, ALICE);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('test message failed to decrypt');
    const authenticatedText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(opened.plaintextBytes);
    expect(authenticatedText).toBe(text);
    const decrypt = vi.spyOn(recipient, 'openDm').mockImplementation(() => { throw new Error('second decrypt'); });
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const inboxStore = new InboxStore(db);
    const onPlainDm = vi.fn();
    const warn = vi.fn();
    const consumer = makeInboxOnMessage({ signer: recipient, inboxStore, socialLog: undefined,
      dmMediaDir: () => '/popclaw-test/never-written', info: vi.fn(), warn, onPlainDm });
    // The root's authenticated receiver supplies this exact decoded string.
    await consumer(dm, 'home', new Uint8Array(), 'Alice', { originalText: authenticatedText });
    expect(decrypt).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(onPlainDm).toHaveBeenCalledOnce();
    expect(onPlainDm.mock.calls[0]![0].body).toBe(authenticatedText);
    expect(onPlainDm.mock.calls[0]![0].item.body).toBe(authenticatedText);
  });

  it('still checks media independently when authenticated text is supplied', async () => {
    const recipient = makeSigner(0x0e);
    const dm = await sentDm(alice, ME, 'text survives');
    dm.mediaCiphertext = new Uint8Array(32).fill(7);
    dm.mediaNonce = new Uint8Array(24).fill(8);
    const decrypt = vi.spyOn(recipient, 'openDm');
    const media = vi.spyOn(recipient, 'openDmMedia');
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const onPlainDm = vi.fn();
    const consumer = makeInboxOnMessage({ signer: recipient, inboxStore: new InboxStore(db), socialLog: undefined,
      dmMediaDir: () => '/popclaw-test/never-written', info: vi.fn(), warn: vi.fn(), onPlainDm });
    await consumer(dm, 'home', new Uint8Array(), 'Alice', { originalText: 'text survives' });
    expect(decrypt).not.toHaveBeenCalled();
    expect(media).toHaveBeenCalledOnce();
    expect(onPlainDm).toHaveBeenCalledOnce();
    expect(onPlainDm.mock.calls[0]![0]).toMatchObject({ body: 'text survives', mediaPath: null });
  });
});
