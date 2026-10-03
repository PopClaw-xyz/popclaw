/**
 * 规格 B 切片④：一坊一条私信流 + 来信记来源坊 + exactly-once 跨坊仍成立。
 *
 * 判据来自规格的验收清单：
 *   - 双坊各来一条不同 DM → 都收到，各带对的坊标签；
 *   - 同一封 DM 两坊重复到达 → 只处理一次（consume 只跑一遍）；
 *   - 某坊不可达（onerror）只报它自己的 slug，不拖垮其余；
 *   - 单坊配置行为逐位不变。
 */
import { describe, it, expect, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
const fixtureKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
const fixtureActor = bs58.encode(fixtureKey.publicKey);
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import {
  openHouseInboxStreams,
  type AnyEventSource,
} from '../../../src/messaging/inbox-stream-client.js';
import { grantingReadAuthorityFor } from '../../helpers/read-authority.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOME = 'http://home.test';
const WORLD = 'http://world.test';

type FakeES = AnyEventSource & { listeners: Record<string, (e: { data: string }) => void> };

/** 每座坊一个可手动喂帧的假 EventSource。 */
function fakeSources() {
  const byUrl = new Map<string, FakeES>();
  const Ctor = class {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    listeners: Record<string, (e: { data: string }) => void> = {};
    constructor(readonly url: string) {
      byUrl.set(url, this as unknown as FakeES);
    }
    addEventListener(type: string, listener: (e: { data: string }) => void): void {
      this.listeners[type] = listener;
    }
    close(): void {}
  } as unknown as new (url: string) => AnyEventSource;
  return { Ctor, byUrl };
}

function dmFrame(over: Partial<popclaw.event.IDirectMessage> = {}): string {
  // P0-A: the inbox stream now relays the full EventEnvelope, not a bare DM.
  const dm = { fromPopclawId: 'alice', toPopclawId: 'me', body: 'hello', ts: 100, ...over };
  dm.fromPopclawId = fixtureActor;
  const env = { actor: { popclawId: fixtureActor }, directMessage: dm };
  const canonical = canonicalizeEnvelope(env);
  const bytes = popclaw.event.EventEnvelope.encode({ ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, fixtureKey.secretKey) }).finish();
  return Buffer.from(bytes).toString('base64');
}

async function wire(urls: string[]) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const store = new InboxStore(db);
  const { Ctor, byUrl } = fakeSources();
  const consumed: string[] = [];
  const onError = vi.fn();
  const streams = openHouseInboxStreams(urls, {
    recipientPopclawId: 'me',
    readAuthorityFor: grantingReadAuthorityFor,
    onMessage: (dm, houseSlug, envelopeBytes) => {
      const wasNew = store.record({
        ts: Number(dm.ts ?? 0),
        fromPopclawId: dm.fromPopclawId ?? '',
        toPopclawId: dm.toPopclawId ?? '',
        body: dm.body ?? '',
        receivedAtMs: Date.now(),
        houseSlug,
        ...(envelopeBytes.length > 0 ? { envelopeBytes } : {}),
      });
      if (!wasNew) return; // 与 index.ts / main.ts 同一道闸
      consumed.push(`${dm.body}@${houseSlug}`);
    },
    onError,
    eventSourceCtor: Ctor,
  });
  for (const s of streams) s.client.start();
  // signer is required now (#227 close-out): start() goes through the async
  // buildInboxToken().then(open) path, so the fake EventSource isn't
  // constructed synchronously anymore — wait for all of them before feeding.
  await vi.waitFor(() => expect(byUrl.size).toBe(urls.length));
  // 正常私信帧走具名 `envelope` 事件（加固 1）。
  const feed = (baseUrl: string, data: string) =>
    byUrl.get(`${baseUrl}/inbox/me/stream`)!.listeners.envelope!({ data });
  // 旧灯坊的裸帧走默认（无名）事件 —— 报警口。
  const feedDefault = (baseUrl: string, data: string) =>
    byUrl.get(`${baseUrl}/inbox/me/stream`)!.onmessage!({ data });
  const fail = (baseUrl: string, err: unknown) =>
    byUrl.get(`${baseUrl}/inbox/me/stream`)!.onerror!(err);
  return { store, streams, consumed, onError, feed, feedDefault, fail };
}

describe('规格 B 切片④ · inbox 按坊各订一条', () => {
  it('每座坊各开一条流，slug 从 base URL 派生', async () => {
    const w = await wire([HOME, WORLD]);
    expect(w.streams.map((s) => s.slug)).toEqual(['home-test', 'world-test']);
    expect(w.streams.map((s) => s.baseUrl)).toEqual([HOME, WORLD]);
  });

  // P0-A: the client decodes the full envelope frame → DM extracted correctly
  // AND the raw envelope bytes reach the precious store for v0.2 verification.
  it('信封帧被 decode 出 DM，且完整 envelope 字节落库', async () => {
    const w = await wire([HOME]);
    w.feed(HOME, dmFrame({ body: 'signed hi' }));
    expect(w.consumed).toEqual(['signed hi@home-test']);
    const row = w.store.recent(1)[0]!;
    expect(row.body).toBe('signed hi');
    // The stored envelope must decode back to the same DM (proves it's the
    // real envelope frame, not a bare DM or empty).
    const env = popclaw.event.EventEnvelope.decode(row.envelopeBytes!);
    expect(env.directMessage?.body).toBe('signed hi');
  });

  // 加固 1：新灯坊+旧插件反向 —— 旧灯坊发裸 DM 走默认（无名）事件时，绝不静默解码
  // 或跳过，而是响亮报错（版本不一致），且**不落库**（等升级重连后 backfill 补投）。
  it('无名默认事件 → 响亮报警而非静默解码/跳过', async () => {
    const w = await wire([HOME]);
    // 用一个能 decode 的裸 DM 字节喂默认事件 —— 证明即便"看起来能解"也不解，走报警。
    const bareDm = Buffer.from(
      popclaw.event.DirectMessage.encode({ fromPopclawId: 'alice', toPopclawId: 'me', body: 'x', ts: 1 }).finish(),
    ).toString('base64');
    w.feedDefault(HOME, bareDm);
    expect(w.consumed).toEqual([]); // 没被当私信消费
    expect(w.store.recent(10)).toHaveLength(0); // 没落库
    expect(w.onError).toHaveBeenCalledTimes(1);
    // 多坊 onError 签名是 (houseSlug, err) —— 报警 Error 是第二个参数。
    const [slug, err] = w.onError.mock.calls[0]!;
    expect(slug).toBe('home-test');
    const msg = String((err as Error).message);
    expect(msg).toContain('legacy-format lore-house frame');
    expect(msg).toContain('out of sync');
  });

  it('无名默认事件重复到达只报警一次（不刷屏）', async () => {
    const w = await wire([HOME]);
    w.feedDefault(HOME, 'garbage');
    w.feedDefault(HOME, 'garbage');
    expect(w.onError).toHaveBeenCalledTimes(1);
  });

  it('双坊各来一条不同 DM → 都收到，各带对的坊标签', async () => {
    const w = await wire([HOME, WORLD]);
    w.feed(HOME, dmFrame({ ts: 1, body: 'from home' }));
    w.feed(WORLD, dmFrame({ ts: 2, fromPopclawId: 'bob', body: 'from world' }));
    expect(w.consumed).toEqual(['from home@home-test', 'from world@world-test']);
    expect(w.store.recent(10).map((x) => [x.body, x.houseSlug])).toEqual([
      ['from world', 'world-test'],
      ['from home', 'home-test'],
    ]);
  });

  it('同一封 DM 两坊各中继一次 → 只处理一次（exactly-once 不因多坊破掉）', async () => {
    const w = await wire([HOME, WORLD]);
    w.feed(HOME, dmFrame());
    w.feed(WORLD, dmFrame()); // 同一封（同 from + ts + body）
    expect(w.consumed).toEqual(['hello@home-test']);
    expect(w.store.recent(10)).toHaveLength(1);
    expect(w.store.houseOf(fixtureActor)).toBe('home-test'); // 哪座坊先到记哪座
  });

  it('SSE 重连回补（同坊重复到达）依旧只处理一次', async () => {
    const w = await wire([HOME, WORLD]);
    w.feed(HOME, dmFrame());
    w.feed(HOME, dmFrame());
    expect(w.consumed).toEqual(['hello@home-test']);
  });

  it('某座坊出错只报它自己的 slug，其余照收', async () => {
    const w = await wire([HOME, WORLD]);
    w.fail(WORLD, new Error('boom'));
    expect(w.onError).toHaveBeenCalledTimes(1);
    expect(w.onError.mock.calls[0]![0]).toBe('world-test');
    w.feed(HOME, dmFrame());
    expect(w.consumed).toEqual(['hello@home-test']);
  });

  it('单坊配置：一条流、来信带唯一那座坊、行为逐位不变', async () => {
    const w = await wire([HOME]);
    expect(w.streams).toHaveLength(1);
    w.feed(HOME, dmFrame());
    w.feed(HOME, dmFrame());
    expect(w.consumed).toEqual(['hello@home-test']);
    expect(w.store.recent(10)).toHaveLength(1);
  });
});
