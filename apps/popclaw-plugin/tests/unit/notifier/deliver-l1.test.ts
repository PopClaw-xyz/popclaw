import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import {
  notifyOwnerNow,
  renderL1,
  mediaUrlsOf,
  RuntimeOwnerNotifier,
  type OwnerNotifier,
} from '../../../src/notifier/owner-notifier.js';
import { ReplyPingsStore } from '../../../src/pings/reply-pings.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { makeDmNotificationPolicy } from '../../../src/runtime/dm-notification-policy.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

// S6 L1 push lexicon: renderL1 now pre-renders in `ownerLang()`. Every
// assertion in this file below predates that lexicon and encodes the
// pre-migration zh production strings — pin the process register to zh-CN
// for the whole file so they keep proving zero regression unchanged. The
// dedicated en-lane parity block near the end passes `'en'` explicitly.
beforeAll(() => setOwnerLang('zh-CN', 'config'));
afterAll(() => setOwnerLang(undefined));

describe('RuntimeOwnerNotifier', () => {
  function fakeSend(result: { status: string; error?: unknown } = { status: 'sent' }) {
    const calls: Array<Record<string, unknown>> = [];
    const send = async (params: Record<string, unknown>) => { calls.push(params); return result; };
    return { send, calls };
  }
  const CFG = { discord: { token: 'x' } };

  it('delivers to the pinned channel via a single sendDurableMessageBatch call', async () => {
    const { send, calls } = fakeSend({ status: 'sent' });
    const dc = { channel: 'discord', to: '123', accountId: 'a', threadId: 7 };
    const info = vi.fn();
    const notifier = new RuntimeOwnerNotifier(send, CFG, async () => ({ sessionKey: 's', deliveryContext: dc }), { info, warn() {} });

    await expect(notifier.deliverNow('📨 hi')).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cfg: CFG,
      channel: 'discord',
      to: '123',
      accountId: 'a',
      threadId: 7,
      payloads: [{ text: '📨 hi' }],
      // exactly-once: skip the write-ahead queue so the crash-recovery sweep
      // can't blindly re-send a lost-ack row (OpenClaw PR #40646 / #40545).
      skipQueue: true,
    });
    expect(info.mock.calls.flat().join(' ')).toContain('discord');
  });

  it('strips a slash-command surface prefix from `to` (Discord wants the bare channel id)', async () => {
    const { send, calls } = fakeSend({ status: 'sent' });
    const notifier = new RuntimeOwnerNotifier(
      send,
      CFG,
      async () => ({ sessionKey: 's', deliveryContext: { channel: 'discord', to: 'slash:1475889907825119534' } }),
      { info() {}, warn() {} },
    );

    await notifier.deliverNow('📨 hi');

    expect(calls[0]).toMatchObject({ to: '1475889907825119534' });
  });

  it('reports failure (false) instead of swallowing a failed send status', async () => {
    const { send } = fakeSend({ status: 'failed', error: new Error('boom') });
    const warn = vi.fn();
    const notifier = new RuntimeOwnerNotifier(send, CFG, async () => ({ sessionKey: 's', deliveryContext: { channel: 'discord', to: '1' } }), { info() {}, warn });

    await expect(notifier.deliverNow('📨 hi')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/boom/);
  });

  // Real host, 2026-07-28 to 29: every image notice returned partial_failed although all three Telegram
  // images logged outbound send ok and reached the owner's phone. Treating this as failure requeued the whole batch,
  // so each new DM repeated all old ones. Partial means it crossed the outbound boundary: never requeue.
  it('treats partial_failed as delivered — it already went out', async () => {
    const { send } = fakeSend({ status: 'partial_failed', error: new Error('half') });
    const warn = vi.fn();
    const notifier = new RuntimeOwnerNotifier(send, CFG, async () => ({ sessionKey: 's', deliveryContext: { channel: 'telegram', to: '1' } }), { info() {}, warn });

    await expect(notifier.deliverNow('📨 hi')).resolves.toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('partial_failed');
  });

  // This log is the only diagnostic for the host's partial_failed: its error is not necessarily an Error,
  // and bare String() turns objects into [object Object], silencing the diagnostic.
  it('日志里的宿主错误不许打成 [object Object]', async () => {
    const { send } = fakeSend({ status: 'partial_failed', error: { stage: 'media', code: 402 } });
    const warn = vi.fn();
    const notifier = new RuntimeOwnerNotifier(send, CFG, async () => ({ sessionKey: 's', deliveryContext: { channel: 'telegram', to: '1' } }), { info() {}, warn });

    await notifier.deliverNow('📨 hi');

    const line = warn.mock.calls.flat().join(' ');
    expect(line).not.toContain('[object Object]');
    expect(line).toContain('402');
  });

  it('reports failure (false) when no target resolves', async () => {
    const { send, calls } = fakeSend();
    const warn = vi.fn();
    const notifier = new RuntimeOwnerNotifier(send, CFG, async () => null, { info() {}, warn });

    await expect(notifier.deliverNow('📨 hi')).resolves.toBe(false);

    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports failure (false) when the target has a channel but no routable `to`', async () => {
    const { send, calls } = fakeSend();
    const warn = vi.fn();
    const notifier = new RuntimeOwnerNotifier(send, CFG, async () => ({ sessionKey: 's', deliveryContext: { channel: 'discord' } }), { info() {}, warn });

    await expect(notifier.deliverNow('📨 hi')).resolves.toBe(false);

    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  // #231: the image actually reaches the owner's IM; the channel adapter uploads the local path.
  it('passes mediaUrls straight into payloads', async () => {
    const { send, calls } = fakeSend({ status: 'sent' });
    const notifier = new RuntimeOwnerNotifier(
      send, CFG,
      async () => ({ sessionKey: 's', deliveryContext: { channel: 'discord', to: '1' } }),
      { info() {}, warn() {} },
    );
    await notifier.deliverNow('📨 hi', ['/data/dm-media/1-abcdefgh.png']);
    expect(calls[0]!.payloads).toEqual([
      { text: '📨 hi', mediaUrls: ['/data/dm-media/1-abcdefgh.png'] },
    ]);
  });

  it('omits the mediaUrls key entirely when there is no picture', async () => {
    const { send, calls } = fakeSend({ status: 'sent' });
    const notifier = new RuntimeOwnerNotifier(
      send, CFG,
      async () => ({ sessionKey: 's', deliveryContext: { channel: 'discord', to: '1' } }),
      { info() {}, warn() {} },
    );
    await notifier.deliverNow('📨 hi', []);
    expect(calls[0]!.payloads).toEqual([{ text: '📨 hi' }]);
  });
});

// ---------------------------------------------------------------------------
// notifyOwnerNow: first reply no longer depends on waking an agent; write directly to the channel (the only verified route) and return its outcome.
// ---------------------------------------------------------------------------

describe('notifyOwnerNow', () => {
  const DC = { channel: 'discord', to: '123', accountId: 'a' };

  function bed(opts: { target?: unknown } = {}) {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const notifier = new SqliteNotifier(db, () => 100);
    const pings = new ReplyPingsStore(db, () => 100);
    const sent: string[] = [];
    const logs: string[] = [];
    const owner: OwnerNotifier = { deliverNow: async (t) => { sent.push(t); return true; } };
    const deps = {
      notifier,
      owner,
      resolveTarget: async () =>
        'target' in opts ? (opts.target as null) : { sessionKey: 'sk-1', deliveryContext: DC },
      logger: {
        info: (m: string) => { logs.push(m); },
        warn: (m: string) => { logs.push(m); },
      },
      stageMedia: undefined as undefined | ((p: string) => string | null),
    };
    return { db, notifier, pings, deps, sent, logs, owner };
  }

  it.each(['zh-CN', 'en'] as const)('preserves the complete mixed L1 batch in %s', async lang => {
    const { db, notifier, deps } = bed();
    setOwnerLang(lang, 'config');
    const delivered: Array<{ text: string; mediaUrls: string[] }> = [];
    const staged: string[] = [];
    deps.owner = { deliverNow: async (text, urls) => { delivered.push({ text, mediaUrls: urls ?? [] }); return true; } };
    deps.stageMedia = path => { staged.push(path); return path.endsWith('lost.png') ? null : `/staged${path}`; };
    const entries = [
      { kind: 'reply' as const, payload: { fromPopclawId: 'alice', fromName: 'Alice', body: 'First reply', targetPreview: 'T'.repeat(41), bondLine: 'Met last week' } },
      { kind: 'dm' as const, payload: { fromPopclawId: 'alice', fromName: 'Alice', body: '[homeletter/v1] kind=postcard place=Kyoto view=https://hidden.test/header.jpg\n' + 'L'.repeat(257) + '\nhttps://images.test/a.jpg\nhttps://images.test/b.png\nhttps://images.test/c.gif', mediaPath: '/local/photo.png', messageId: 42 } },
      { kind: 'reply' as const, payload: { fromPopclawId: 'bob', body: 'Second reply', mediaPath: '/local/photo.png' } },
      { kind: 'dm' as const, payload: { fromPopclawId: 'bob', fromName: 'Bob', body: 'https://images.test/b.png\nhttps://images.test/d.webp', mediaPath: '/local/lost.png', messageId: 'legacy-id', bondLine: 'Old friend' } },
      { kind: 'dm' as const, payload: { fromPopclawId: 'bob', fromName: 'Bob', body: '[homeletter/v1] kind=voice', mediaPath: '/local/voice.ogg', messageId: 43 } },
      { kind: 'dm' as const, payload: { fromPopclawId: 'bob', body: 'B'.repeat(256) } },
      { kind: 'ranger_verify_done' as const, payload: { platform: 'x', handle: '@alice', followerCount: 30000, profileUrl: 'https://profile.test/%E4%B8%AD' } },
      { kind: 'ranger_verify_fail' as const, payload: { platform: 'x', handle: '@bob', reason: 'Proof unavailable' } },
    ];
    try {
      const inbox = new InboxStore(db);
      for (const entry of entries) {
        if (typeof entry.payload.messageId === 'number') {
          entry.payload.messageId = inbox.recordReceived({ ts: 100, fromPopclawId: 'alice', toPopclawId: 'owner', body: entry.payload.body ?? '', houseSlug: 'A', receivedAtMs: 100 }).item.id;
        }
        notifier.enqueue({ level: 'L1', ...entry });
      }
      const rawMedia = mediaUrlsOf(notifier.peekFor('batch-evidence', 'L1'));
      const outcome = await notifyOwnerNow(deps);
      expect({ outcome, delivered, rawMedia, staged, pending: notifier.count('L1') }).toMatchSnapshot();
    } finally {
      setOwnerLang('zh-CN', 'config');
      db.close();
    }
  });

  /** An in-memory stand-in for the on-disk note (#236). */
  function fakeFailureStore() {
    let cur: { at: number; reason: string } | null = null;
    return {
      store: {
        get: () => cur,
        set: (f: { at: number; reason: string }) => { cur = f; },
        clear: () => { cur = null; },
      },
      read: () => cur,
    };
  }

  function enqueueFirstPing(notifier: SqliteNotifier, pings: ReplyPingsStore, n = 1) {
    pings.claimArrival(`evt-${n}`, 'mine');
    notifier.enqueue({
      level: 'L1',
      kind: 'reply',
      payload: {
        replyEventId: `evt-${n}`,
        fromPopclawId: 'laozhangPid',
        fromName: '老张',
        body: '这条说得好',
        targetPostId: 'mine',
        targetPreview: '我那条讲武功的帖',
      },
    });
  }

  // #231: when combining items into one message, union their images. After failed delivery and requeue, mediaPath remains
  // because payload_json carries it naturally.
  it('unions the mediaPaths of the drained batch and survives a requeue', async () => {
    const { notifier, deps } = bed();
    const got: string[][] = [];
    let ok = false;
    deps.owner = {
      deliverNow: async (_t: string, urls?: string[]) => { got.push(urls ?? []); return ok; },
    };
    for (const p of ['/m/a.png', undefined, '/m/b.png']) {
      notifier.enqueue({
        level: 'L1',
        kind: 'dm',
        payload: { fromPopclawId: 'sender', body: 'hi', ...(p ? { mediaPath: p } : {}) },
      });
    }

    // First attempt: channel rejection returns all three unchanged to the queue.
    await expect(notifyOwnerNow(deps)).resolves.toBe('queued');
    expect(got[0]).toEqual(['/m/a.png', '/m/b.png']);
    expect(notifier.count('L1')).toBe(3);

    // Second attempt: the requeued items retain every mediaPath.
    ok = true;
    await expect(notifyOwnerNow(deps)).resolves.toBe('channel');
    expect(got[1]).toEqual(['/m/a.png', '/m/b.png']);
  });

  it('delivers straight to the channel and consumes the L1 row', async () => {
    const { notifier, pings, deps, sent, logs } = bed();
    enqueueFirstPing(notifier, pings);

    await expect(notifyOwnerNow(deps)).resolves.toBe('channel');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('老张');
    expect(sent[0]).toContain('我那条讲武功的帖');
    expect(notifier.count('L1')).toBe(0); // This interruption already happened.
    expect(logs.join(' ')).toContain('level=channel');
    expect(logs.join(' ')).not.toContain('heartbeat');
  });

  it('一行事实 + 一句下钻邀请', async () => {
    const { notifier, pings, deps, sent } = bed();
    enqueueFirstPing(notifier, pings);

    await notifyOwnerNow(deps);

    const [fact, invite, ...rest] = sent[0]!.split('\n');
    expect(fact).toBe(
      `💬 老张#${deriveSigil('laozhangPid')} 回了你那条「我那条讲武功的帖」：这条说得好`,
    );
    expect(invite).toContain('想看全部回复');
    expect(rest).toEqual([]);
  });

  it('多条时每条一行，只发一次', async () => {
    const { notifier, pings, deps, sent } = bed();
    enqueueFirstPing(notifier, pings, 1);
    enqueueFirstPing(notifier, pings, 2);

    await notifyOwnerNow(deps);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.split('\n')).toHaveLength(3); // 2 facts + 1 invite
  });

  it('delivery failure puts every drained item back in the queue', async () => {
    const { notifier, pings, deps, logs } = bed();
    enqueueFirstPing(notifier, pings);
    deps.owner.deliverNow = async () => false;

    await expect(notifyOwnerNow(deps)).resolves.toBe('queued');

    expect(notifier.count('L1')).toBe(1); // Leave it for the owner's next turn (channel B).
    expect(logs.join(' ')).toContain('level=queued');
    expect(logs.join(' ')).toContain('delivery-failed');
  });

  it('a throwing channel also requeues rather than losing the ping', async () => {
    const { notifier, pings, deps } = bed();
    enqueueFirstPing(notifier, pings);
    deps.owner.deliverNow = async () => { throw new Error('channel down'); };

    await expect(notifyOwnerNow(deps)).resolves.toBe('queued');

    expect(notifier.count('L1')).toBe(1);
  });

  it('no routable target → nothing drained, the ping waits for the owner to speak', async () => {
    const { notifier, pings, deps, sent, logs } = bed({ target: null });
    enqueueFirstPing(notifier, pings);

    await expect(notifyOwnerNow(deps)).resolves.toBe('no-target');

    expect(sent).toEqual([]);
    expect(notifier.count('L1')).toBe(1);
    expect(logs.join(' ')).toContain('level=queued');
    expect(logs.join(' ')).toContain('no-target');
  });

  it('never advances the unread cursor — only popclaw_show_pings does that', async () => {
    const { notifier, pings, deps } = bed();
    enqueueFirstPing(notifier, pings);

    await notifyOwnerNow(deps);

    expect(pings.unreadCount()).toBe(1); // The owner has not actually seen the content yet.
  });

  it('draining on notify means a later DM does not re-say the same reply', async () => {
    const { notifier, pings, deps, sent } = bed();
    enqueueFirstPing(notifier, pings);

    await notifyOwnerNow(deps);
    // Then a DM arrives through the same delivery path.
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { fromPopclawId: 'f', body: '在吗' } });
    await notifyOwnerNow(deps);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('在吗');
    expect(sent[1]).not.toContain('老张');
    expect(sent[1]).not.toContain('想看全部回复'); // The DM carries no reply invitation.
  });

  // Real host, 2026-07-31: a notice written directly to the channel has no agent turn, so the agent cannot see the DM,
  // and the body is cut to 140 characters. Asking what the DM says yielded a failure to identify it. The drill-down invitation
  // reconnects half the missing link; the other half is the popclaw_show_inbox description.
  it('正文被截断的私信带一条下钻邀请', async () => {
    const { notifier, deps, sent } = bed();
    notifier.enqueue({
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'f', fromName: '苍梧', body: '子'.repeat(300) },
    });

    await notifyOwnerNow(deps);

    expect(sent[0]).toContain('全文');
  });

  it('正文没截断就不邀请（全文已在眼前，不说废话）', async () => {
    const { notifier, deps, sent } = bed();
    notifier.enqueue({
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'f', fromName: '苍梧', body: '在吗' },
    });

    await notifyOwnerNow(deps);

    expect(sent[0]).toContain('在吗');
    expect(sent[0]).not.toContain('全文');
  });

  it('does nothing when the L1 queue is already empty', async () => {
    const { deps, sent } = bed();

    await expect(notifyOwnerNow(deps)).resolves.toBe('nothing');

    expect(sent).toEqual([]);
  });

  // Preserve the DM path: it is the only verified channel, and a signature change must not change its behavior.
  it('DM path: renders the DM line and consumes the queue', async () => {
    const { notifier, deps, sent } = bed();
    notifier.enqueue({
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'friend1', fromName: '老友', body: 'hi there' },
    });

    await expect(notifyOwnerNow(deps)).resolves.toBe('channel');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`老友#${deriveSigil('friend1')}`);
    expect(sent[0]).toContain('hi there');
    expect(notifier.count('L1')).toBe(0);
  });

  // Real-host failure, 2026-07-28: a decrypted image outside the workspace caused FsSafeError, marking the batch
  // failed and endlessly requeuing it. Copy images into a host-approved outbound directory before sending.
  it('图先过 staging，mediaUrls 用的是 staging 路径', async () => {
    const { notifier, deps } = bed();
    const got: string[][] = [];
    deps.owner = { deliverNow: async (_t: string, urls?: string[]) => { got.push(urls ?? []); return true; } };
    deps.stageMedia = (p: string) => `/state/media/popclaw-dm/${p.split('/').pop()}`;
    notifier.enqueue({
      level: 'L1', kind: 'dm',
      payload: { fromPopclawId: 'f', body: '看这个', mediaPath: '/popclaw/data/dm-media/1-abc.png' },
    });

    await expect(notifyOwnerNow(deps)).resolves.toBe('channel');

    expect(got[0]).toEqual(['/state/media/popclaw-dm/1-abc.png']);
  });

  // The letter's image is a remote URL, which local-file staging cannot copy. Staging it would discard it as unavailable,
  // leaving the owner unable to see the postcard again.
  it('信里的远端图链接不过 staging，原样交给 channel', async () => {
    const { notifier, deps } = bed();
    const got: string[][] = [];
    deps.owner = { deliverNow: async (_t: string, urls?: string[]) => { got.push(urls ?? []); return true; } };
    deps.stageMedia = () => null; // Local images are dropped; remote images must not pass through this path.
    notifier.enqueue({
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'f', body: '📮 寄来一张明信片\nhttps://img.example.com/gen/abc.jpg' },
    });

    await expect(notifyOwnerNow(deps)).resolves.toBe('channel');

    expect(got[0]).toEqual(['https://img.example.com/gen/abc.jpg']);
  });

  it('staging 失败只丢图，文字照发（不因图拦投递）', async () => {
    const { notifier, deps } = bed();
    const got: Array<{ text: string; urls: string[] }> = [];
    deps.owner = {
      deliverNow: async (text: string, urls?: string[]) => { got.push({ text, urls: urls ?? [] }); return true; },
    };
    deps.stageMedia = () => null;
    notifier.enqueue({
      level: 'L1', kind: 'dm',
      payload: { fromPopclawId: 'f', body: '看这个', mediaPath: '/popclaw/data/dm-media/1-abc.png' },
    });

    await expect(notifyOwnerNow(deps)).resolves.toBe('channel');

    expect(got[0]!.urls).toEqual([]);
    expect(got[0]!.text).toContain('看这个');
    expect(got[0]!.text).toContain('📎 附件暂不可用'); // Still tell the owner that an image exists.
    expect(notifier.count('L1')).toBe(0); // Losing the image does not count as delivery failure.
  });

  // ---------------------------------------------------------------------
  // Guard against infinite requeue: stop after three failures, or every new notice resends old failed items.
  // ---------------------------------------------------------------------

  it('前两次失败照样重排（attempts 计数带着走）', async () => {
    const { notifier, deps } = bed();
    deps.owner.deliverNow = async () => false;
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { fromPopclawId: 'f', body: '在吗' } });

    await expect(notifyOwnerNow(deps)).resolves.toBe('queued');
    expect(notifier.count('L1')).toBe(1);
    await expect(notifyOwnerNow(deps)).resolves.toBe('queued');
    expect(notifier.count('L1')).toBe(1);
  });

  it('第三次失败停止重排 + 一行响亮的 warn（带 kind 与摘要）', async () => {
    const { notifier, deps, logs } = bed();
    deps.owner.deliverNow = async () => false;
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { fromPopclawId: 'f', body: '在吗' } });

    await notifyOwnerNow(deps);
    await notifyOwnerNow(deps);
    await notifyOwnerNow(deps);

    expect(notifier.count('L1')).toBe(0); // The failed item is cleared and no longer blocks new notices.
    const dropped = logs.filter((l) => l.includes('DROPPED'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('kind=dm');
    expect(dropped[0]).toContain('在吗');
  });

  it('投递成功的条目不带 attempts 负担（已送达行为不变）', async () => {
    const { notifier, deps, sent } = bed();
    deps.owner.deliverNow = async () => false;
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { fromPopclawId: 'f', body: '在吗' } });
    await notifyOwnerNow(deps);

    deps.owner.deliverNow = async (t: string) => { sent.push(t); return true; };
    await expect(notifyOwnerNow(deps)).resolves.toBe('channel');
    expect(sent[0]).toContain('在吗');
    expect(notifier.count('L1')).toBe(0);
  });

  it('DM path: a failed send no longer loses the DM (it goes back to the queue)', async () => {
    const { notifier, deps } = bed();
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { fromPopclawId: 'friend1', body: 'hi there' } });
    deps.owner.deliverNow = async () => false;

    await notifyOwnerNow(deps);

    expect(notifier.count('L1')).toBe(1);
  });

  // #236: the owner felt "nothing is happening" for two days and had nowhere to
  // look — the channel's reason went only into a log under /tmp.
  it('writes down WHY the channel refused, in the channel\'s own words', async () => {
    const { deps, notifier, pings } = bed();
    enqueueFirstPing(notifier, pings);
    const f = fakeFailureStore();
    const owner: OwnerNotifier = {
      deliverNow: async () => {
        throw new Error('sendMessage ret=-2 errmsg=prepare failed');
      },
    };
    const out = await notifyOwnerNow({ ...deps, owner, failureStore: f.store, now: () => 1753711800 });
    expect(out).toBe('queued');
    expect(f.read()!.reason).toContain('prepare failed');
    expect(f.read()!.at).toBe(1753711800);
  });

  it('clears the note once the channel comes back — no stale worry in status', async () => {
    const { deps, notifier, pings } = bed();
    enqueueFirstPing(notifier, pings);
    const f = fakeFailureStore();
    f.store.set({ at: 1, reason: 'old trouble' });
    const out = await notifyOwnerNow({ ...deps, failureStore: f.store });
    expect(out).toBe('channel');
    expect(f.read()).toBeNull();
  });

});

describe('renderL1', () => {
  it('truncates a long body to 256 chars and names the sender by 印信', () => {
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'abcdefghijklmnop', body: 'x'.repeat(500) },
      enqueuedAt: 100,
    });
    expect(line).toContain(`#${deriveSigil('abcdefghijklmnop')}`);
    expect(line.length).toBeLessThan(290);
  });

  // Real-host incident, 2026-07-31: a 424-character official reply was silently cut to 140. Both owner and agent assumed
  // the preview was complete, and the agent sent back questions already answered in the letter. Truncation is appropriate
  // for long IM bodies; failing to disclose it is the problem.
  it('dm: 正文超长 → 明说被切了、并指回信箱', () => {
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'abcdefghijklmnop', body: `${'x'.repeat(256)}这里才是要做的事` },
      enqueuedAt: 100,
    });
    expect(line).toContain('…（全文见信箱）');
    expect(line.endsWith('…（全文见信箱）')).toBe(true);
  });

  it('dm: 正文不超长 → 一个字节都不变（老通知长什么样还长什么样）', () => {
    const from = 'Demo1234xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const atCap = 'x'.repeat(256); // Exactly at the limit: the boundary does not count as truncation.
    for (const body of ['在吗', atCap]) {
      const line = renderL1({
        id: 1,
        level: 'L1',
        kind: 'dm',
        payload: { fromPopclawId: from, fromName: '苍梧小居士', body },
        enqueuedAt: 100,
      });
      expect(line).toBe(`📨 收到信件\n来自：苍梧小居士#${deriveSigil(from)}\n\n${body}`);
      expect(line).not.toContain('全文见信箱');
    }
  });

  // reply uses the same body preview; fix both paths, not just dm.
  it('reply: 正文超长同样明说；被回的原话切了给省略号', () => {
    const from = 'Demo1234xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'reply',
      payload: { fromPopclawId: from, body: 'y'.repeat(300), targetPreview: 'z'.repeat(60) },
      enqueuedAt: 100,
    });
    expect(line).toContain('…（全文见信箱）');
    expect(line).toContain(`「${'z'.repeat(40)}…」`);
  });

  // Owner-reported display problem: `📨 @Demo1234 给你发了私信` showed the first eight characters of a 44-character
  // base58 ID, which did not identify the sender to the owner.
  it('dm: 有名号 → 名号#印信；一个字的裸 id 前缀都不出现', () => {
    const from = 'Demo1234xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: from, fromName: '苍梧小居士', body: '在吗' },
      enqueuedAt: 100,
    });
    expect(line).toBe(`📨 收到信件\n来自：苍梧小居士#${deriveSigil(from)}\n\n在吗`);
    expect(line).not.toContain(from.slice(0, 8));
  });

  it('dm: 名册查无 → 只报 #印信，绝不退回 id 前缀', () => {
    const from = 'Demo1234xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: from, body: '在吗' },
      enqueuedAt: 100,
    });
    expect(line).toBe(`📨 收到信件\n来自：#${deriveSigil(from)}\n\n在吗`);
    expect(line).not.toContain(from.slice(0, 8));
  });

  // ---------------------------------------------------------------------
  // House letters (postcards / return letters): real host-c, 2026-07-31.
  // ---------------------------------------------------------------------

  /**
   * Exact real-host shape: machine header on the first line, then body, then a postcard image URL on
   * its own line.
   */
  const POSTCARD =
    '[homeletter/v1] kind=postcard place=乱星海·紫潮崖 view=https://popclaw.world/h/9b2y5d3f\n' +
    '📮「乱星海·紫潮崖」寄来一张明信片\n' +
    '主人要是也在，这蟹该先夹他还是先夹我呢……算了，墨痕未干呢，不争这个先后。\n' +
    'https://img.example.com/gen/abc123.jpg';

  it('家书：机器标头首行不念给主人（guide §3，L1 没有 agent 替它剥）', () => {
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'houseofficial', fromName: 'popclaw.world', body: POSTCARD },
      enqueuedAt: 100,
    });
    expect(line).not.toContain('homeletter/v1');
    expect(line).not.toContain('kind=postcard');
    expect(line).toContain('寄来一张明信片');
  });

  it('家书：信里那张明信片图跟着通知一起出线（不必等主人开口要全文）', () => {
    expect(
      mediaUrlsOf([
        { id: 1, level: 'L1', kind: 'dm', payload: { fromPopclawId: 'h', body: POSTCARD }, enqueuedAt: 1 },
      ]),
    ).toEqual(['https://img.example.com/gen/abc123.jpg']);
  });

  it('正文里的非图链接不当图发（门牌页发成图 = 宿主报错，整批判失败）', () => {
    expect(
      mediaUrlsOf([
        {
          id: 1,
          level: 'L1',
          kind: 'dm',
          payload: { fromPopclawId: 'h', body: '看这个 https://popclaw.world/p/cms5use0t' },
          enqueuedAt: 1,
        },
      ]),
    ).toEqual([]);
  });

  // ADR-0040 acts 2/3: without these branches both kinds rendered as
  // 「给你发了私信」, which is how the real-machine test found this hole.
  it('ranger_verify_done: 通过 + 确数关注者 + 名帖链接 + 下一步', () => {
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'ranger_verify_done',
      payload: {
        platform: 'x',
        handle: 'blackfeather_ai',
        followerCount: 30281,
        profileUrl: 'https://popclaw.me/blackfeather_ai/abcd1234',
      },
      enqueuedAt: 100,
    });
    expect(line).toContain('账号认证成功');
    expect(line).toContain('@blackfeather_ai');
    expect(line).toContain('30281');
    expect(line).toContain('https://popclaw.me/blackfeather_ai/abcd1234');
    expect(line).not.toContain('私信');
  });

  it('ranger_verify_done with 0 followers: 数字整句省略（0 位关注者不是好消息）', () => {
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'ranger_verify_done',
      payload: { platform: 'x', handle: 'blackfeather_ai', followerCount: 0, profileUrl: '' },
      enqueuedAt: 100,
    });
    expect(line).toContain('账号认证成功');
    expect(line).not.toContain('关注者');
    expect(line).not.toContain('分享给朋友');
  });

  it('ranger_verify_fail: 原因 + 立刻可行动（被拒没有等待期）', () => {
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'ranger_verify_fail',
      payload: { platform: 'x', handle: 'blackfeather_ai', reason: '游侠没在你的帖子里找到那串「名字#印信」' },
      enqueuedAt: 100,
    });
    expect(line).toContain('没核验通过');
    expect(line).toContain('x:blackfeather_ai');
    expect(line).toContain('找到那串');
    expect(line).toContain('没有等待期');
    expect(line).not.toContain('私信');
  });

  // -------------------------------------------------------------------------
  // #231 DM images: actually deliver the image to the owner's IM instead of merely giving a local path.
  // -------------------------------------------------------------------------

  it('renderL1 dm 带图时标一声 📎 附图', () => {
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'abcdefghij', body: '看这个', mediaPath: '/x/1.png' },
      enqueuedAt: 100,
    });
    expect(line).toContain('📎 附件：1.png');
    expect(line).not.toContain('/x/1.png'); // Keep paths out of text; send images through mediaUrls.
  });

  // Image-only message: the tail must not leave an empty "sent you a DM:" prefix.
  it('renderL1 dm 纯图无正文 → 「给你发了一张图 📎」，且文字非空（宿主不收空 text）', () => {
    const from = 'Demo1234xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const line = renderL1({
      id: 1,
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: from, fromName: '苍梧小居士', body: '', mediaPath: '/x/1.png' },
      enqueuedAt: 100,
    });
    expect(line).toBe(`📨 收到信件\n来自：苍梧小居士#${deriveSigil(from)}\n\n📎 附件：1.png`);
    expect(line).not.toContain('/x/1.png'); // Keep paths out of text; send images through mediaUrls.
    expect(line.trim().length).toBeGreaterThan(0);
  });

  it('mediaUrlsOf 取并集、去重、保序', () => {
    const item = (mediaPath?: string) => ({
      id: 1,
      level: 'L1' as const,
      kind: 'dm' as const,
      payload: mediaPath ? { mediaPath } : {},
      enqueuedAt: 1,
    });
    expect(mediaUrlsOf([item('/a.png'), item(), item('/b.png'), item('/a.png')])).toEqual([
      '/a.png',
      '/b.png',
    ]);
    expect(mediaUrlsOf([item(), item()])).toEqual([]);
  });
});

/**
 * Bond-context tail (2026-07-29). Owner feedback: a sender name alone does not explain who a DM is
 * from; an agent receiving mail should also explain who the person is and their previous interactions
 * with the owner.
 */
describe('renderL1 · 交情上下文尾行', () => {
  const FROM = 'Demo1234xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const item = (kind: 'dm' | 'reply', payload: Record<string, unknown>) => ({
    id: 1,
    level: 'L1' as const,
    kind,
    payload,
    enqueuedAt: 100,
  });

  function bedForBondTail() {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const notifier = new SqliteNotifier(db, () => 100);
    const sent: string[] = [];
    const deps = {
      notifier,
      owner: { deliverNow: async (t: string) => { sent.push(t); return true; } } as OwnerNotifier,
      resolveTarget: async () => ({ deliveryContext: { channel: 'discord', to: '1' } }),
      logger: { info: () => {}, warn: () => {} },
    };
    return { notifier, deps, sent };
  }

  it('dm: 有尾行 → 第二行挂在正文下面', () => {
    const line = renderL1(
      item('dm', {
        fromPopclawId: FROM,
        fromName: 'Blackfeather',
        body: '谢谢了兄弟',
        bondLine: '　 ↳ 密友 · 昨天他给你来过信 · 爱烧脑科幻',
      }),
    );
    expect(line).toBe(
      `📨 收到信件\n来自：Blackfeather#${deriveSigil(FROM)}\n\n谢谢了兄弟\n` +
        '　 ↳ 密友 · 昨天他给你来过信 · 爱烧脑科幻',
    );
  });

  it('dm: 没有尾行 → 单行，绝不留一行空的（陌生人不硬凑废话）', () => {
    const line = renderL1(item('dm', { fromPopclawId: FROM, fromName: '甲', body: '在吗' }));
    expect(line.split('\n')).toHaveLength(4);
    expect(line).not.toContain('↳');
  });

  it('dm: 空串尾行同样整行不出', () => {
    const line = renderL1(item('dm', { fromPopclawId: FROM, body: '在吗', bondLine: '' }));
    expect(line.split('\n')).toHaveLength(4);
  });

  it('dm 纯图无正文也带尾行', () => {
    const line = renderL1(
      item('dm', { fromPopclawId: FROM, body: '', mediaPath: '/x/1.png', bondLine: '　 ↳ 好友' }),
    );
    expect(line.endsWith('\n　 ↳ 好友')).toBe(true);
  });

  it('reply: 尾行同样挂上', () => {
    const line = renderL1(
      item('reply', {
        fromPopclawId: FROM,
        fromName: '老张',
        body: '这条说得好',
        targetPreview: '我那条讲武功的帖',
        bondLine: '　 ↳ 好友 · 3 天前他给你来过信',
      }),
    );
    expect(line).toContain('\n　 ↳ 好友 · 3 天前他给你来过信');
  });

  // Each batched item carries its own line and tail, preventing attribution to another person.
  it('多条合并成一条消息时，每条各自带自己的尾行', async () => {
    const { notifier, deps, sent } = bedForBondTail();
    notifier.enqueue({
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'aaa', fromName: '甲', body: '一', bondLine: '　 ↳ 好友' },
    });
    notifier.enqueue({
      level: 'L1',
      kind: 'dm',
      payload: { fromPopclawId: 'bbb', fromName: '乙', body: '二' },
    });
    await notifyOwnerNow(deps);
    const lines = sent[0]!.split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[4]).toBe('　 ↳ 好友');
    expect(lines[7]).toContain('乙');
  });

  // requeue uses `{...item.payload, attempts}`; bondLine lives in payload and is naturally retained.
  it('投递失败重排后，尾行数据仍在（payload 富化的意义）', async () => {
    const { notifier, deps, sent } = bedForBondTail();
    let ok = false;
    deps.owner = { deliverNow: async (t: string) => { sent.push(t); return ok; } };
    notifier.enqueue({
      level: 'L1',
      kind: 'dm',
      payload: {
        fromPopclawId: 'aaa',
        fromName: '甲',
        body: '一',
        bondLine: '　 ↳ 密友 · 昨天他给你来过信',
      },
    });
    expect(await notifyOwnerNow(deps)).toBe('queued');
    ok = true;
    expect(await notifyOwnerNow(deps)).toBe('channel');
    expect(sent[1]).toContain('　 ↳ 密友 · 昨天他给你来过信');
  });
});

/**
 * S6 L1 push lexicon — en lane parity. Same branches as the zh assertions
 * above (renderL1 truncates/dm/reply/verify done/verify fail), each rendered
 * with `renderL1(item, 'en')` and checked against the English `copy` source
 * in src/lexicon/en.ts, one assertion per branch.
 */
describe('renderL1 · en lane (S6 lexicon parity)', () => {
  it('dm: name#sigil, English sentence', () => {
    const from = 'Demo1234xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const line = renderL1(
      { id: 1, level: 'L1', kind: 'dm', payload: { fromPopclawId: from, fromName: 'Cangwu', body: 'you there' }, enqueuedAt: 100 },
      'en',
    );
    expect(line).toBe(`📨 Letter received\nFrom: Cangwu#${deriveSigil(from)}\n\nyou there`);
  });

  it('dm: media-only, no dangling colon', () => {
    const from = 'Demo1234xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const line = renderL1(
      { id: 1, level: 'L1', kind: 'dm', payload: { fromPopclawId: from, body: '', mediaPath: '/x/1.png' }, enqueuedAt: 100 },
      'en',
    );
    expect(line).toBe(`📨 Letter received\nFrom: #${deriveSigil(from)}\n\n📎 Attachment: 1.png`);
  });

  it('dm: pic tail appended when there is both body and media', () => {
    const line = renderL1(
      { id: 1, level: 'L1', kind: 'dm', payload: { fromPopclawId: 'abcdefghij', body: 'look at this', mediaPath: '/x/1.png' }, enqueuedAt: 100 },
      'en',
    );
    expect(line).toContain('📎 Attachment: 1.png');
    expect(line).not.toContain('/x/1.png');
  });

  it('reply: with target quotes it, mirrors the zh withTarget branch', () => {
    const line = renderL1(
      {
        id: 1,
        level: 'L1',
        kind: 'reply',
        payload: { fromPopclawId: 'laozhangPid', fromName: 'Zhang', body: 'well said', targetPreview: 'my martial-arts post' },
        enqueuedAt: 100,
      },
      'en',
    );
    expect(line).toBe(`💬 Zhang#${deriveSigil('laozhangPid')} replied to your "my martial-arts post": well said`);
  });

  it('reply: no target falls back to the plain sentence', () => {
    const line = renderL1(
      { id: 1, level: 'L1', kind: 'reply', payload: { fromPopclawId: 'p', fromName: 'A', body: 'hi' }, enqueuedAt: 100 },
      'en',
    );
    expect(line).toBe(`💬 A#${deriveSigil('p')} replied to you: hi`);
  });

  it('ranger_verify_done: verified + follower count + share link', () => {
    const line = renderL1(
      {
        id: 1,
        level: 'L1',
        kind: 'ranger_verify_done',
        payload: { platform: 'x', handle: 'blackfeather_ai', followerCount: 30281, profileUrl: 'https://popclaw.me/blackfeather_ai/abcd1234' },
        enqueuedAt: 100,
      },
      'en',
    );
    expect(line).toContain('account is verified on PopClaw.');
    expect(line).toContain('@blackfeather_ai');
    expect(line).toContain('30281');
    expect(line).toContain('https://popclaw.me/blackfeather_ai/abcd1234');
  });

  it('ranger_verify_done: 0 followers omits the follower clause', () => {
    const line = renderL1(
      { id: 1, level: 'L1', kind: 'ranger_verify_done', payload: { platform: 'x', handle: 'blackfeather_ai', followerCount: 0, profileUrl: '' }, enqueuedAt: 100 },
      'en',
    );
    expect(line).toContain('account is verified on PopClaw.');
    expect(line).not.toContain('followers');
    expect(line).not.toContain('Share it');
  });

  it('ranger_verify_fail: reason + no-waiting-period line', () => {
    const line = renderL1(
      { id: 1, level: 'L1', kind: 'ranger_verify_fail', payload: { platform: 'x', handle: 'blackfeather_ai', reason: 'no name#sigil found in the post' }, enqueuedAt: 100 },
      'en',
    );
    expect(line).toContain("Couldn't verify");
    expect(line).toContain('x:blackfeather_ai');
    expect(line).toContain('no name#sigil found in the post');
    expect(line).toContain('no cooldown');
  });

  it('bond tail is language-independent (raw payload string, not templated)', () => {
    const line = renderL1(
      {
        id: 1,
        level: 'L1',
        kind: 'dm',
        payload: { fromPopclawId: 'p', body: 'hi', bondLine: '　 ↳ 密友 · 昨天他给你来过信' },
        enqueuedAt: 100,
      },
      'en',
    );
    expect(line.endsWith('\n　 ↳ 密友 · 昨天他给你来过信')).toBe(true);
  });
});

/**
 * Real host 2026-09-25 (build abc3177): the owner got `📨 收到信件\n来自：EngA#…\n\n…`,
 * asked six minutes later for "the message EngA sent at 22:57", and the agent
 * came back with two old ids and asked the owner for an id — while the new
 * letter (id 17) sat first in the inbox. The notice never showed an id, so
 * the owner had nothing to hand over. The inbox row id (`payload.messageId`,
 * the `message_id` popclaw_show_inbox returns) now rides on the line itself.
 */
describe('renderL1 · the DM notice names the inbox message id', () => {
  const from = 'Demo1234xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const dm = (payload: Record<string, unknown>) =>
    ({ id: 3, level: 'L1' as const, kind: 'dm' as const, payload: { fromPopclawId: from, fromName: 'EngA', ...payload }, enqueuedAt: 100 });

  it('zh: 「给你发了私信（#17）：…」', () => {
    expect(renderL1(dm({ messageId: 17, body: '在吗' }), 'zh-CN'))
      .toBe(`📨 收到信件\n来自：EngA#${deriveSigil(from)}\n\n在吗`);
  });

  it('en: "sent you a DM (#17): …"', () => {
    expect(renderL1(dm({ messageId: 17, body: 'you there' }), 'en'))
      .toBe(`📨 Letter received\nFrom: EngA#${deriveSigil(from)}\n\nyou there`);
  });

  it('media-only notice carries the id too, in both locales', () => {
    expect(renderL1(dm({ messageId: 17, body: '', mediaPath: '/x/1.png' }), 'zh-CN'))
      .toBe(`📨 收到信件\n来自：EngA#${deriveSigil(from)}\n\n📎 附件：1.png`);
    expect(renderL1(dm({ messageId: 17, body: '', mediaPath: '/x/1.png' }), 'en'))
      .toBe(`📨 Letter received\nFrom: EngA#${deriveSigil(from)}\n\n📎 Attachment: 1.png`);
  });

  it('the id is the inbox row id, not the notification queue id', () => {
    const line = renderL1(dm({ messageId: 17, body: 'hi' }), 'en');
    expect(line).not.toContain('(#17)');
    expect(line).not.toContain('(#3)');
  });

  it('an item queued without an id (older build) renders exactly as before', () => {
    expect(renderL1(dm({ body: '在吗' }), 'zh-CN')).toBe(`📨 收到信件\n来自：EngA#${deriveSigil(from)}\n\n在吗`);
    expect(renderL1(dm({ body: 'hi' }), 'en')).toBe(`📨 Letter received\nFrom: EngA#${deriveSigil(from)}\n\nhi`);
  });
});

// End to end: the id on the notice is the inbox row id of THAT letter, through
// the real inbox, the real DM notification policy and the real owner push.
describe('DM notice ids end to end (inbox → policy → owner push)', () => {
  it('two letters from two senders → one push, each line names its own id', async () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const inbox = new InboxStore(db);
    const notifier = new SqliteNotifier(db, () => 100);
    // Filler rows so the two letters get ids 17 and 18, like the real inbox.
    for (let i = 1; i <= 16; i++) {
      inbox.recordReceived({ ts: i, fromPopclawId: 'old', toPopclawId: 'me', body: `old ${i}`, receivedAtMs: i });
    }
    const a = inbox.recordReceived({ ts: 100, fromPopclawId: 'alice-id', toPopclawId: 'me', body: 'from alice', receivedAtMs: 100 }).item;
    const b = inbox.recordReceived({ ts: 101, fromPopclawId: 'bob-id', toPopclawId: 'me', body: 'from bob', receivedAtMs: 101 }).item;
    expect([a.id, b.id]).toEqual([17, 18]);

    const names: Record<string, string> = { 'alice-id': 'Alice', 'bob-id': 'Bob' };
    const policy = makeDmNotificationPolicy({
      inbox, notifier, graph: { following: () => [{ popclawId: 'alice-id' }, { popclawId: 'bob-id' }] },
      verdictOf: () => ({ blocked: false }), vipThreshold: 0, nameOf: (id) => names[id] ?? id,
    });
    await policy.handle(a);
    await policy.handle(b);

    const sent: string[] = [];
    await expect(notifyOwnerNow({
      notifier,
      owner: { deliverNow: async (t: string) => { sent.push(t); return true; } } as OwnerNotifier,
      resolveTarget: async () => ({ deliveryContext: { channel: 'whatsapp', to: '1' } }),
      logger: { info: () => {}, warn: () => {} },
    })).resolves.toBe('channel');

    expect(sent).toHaveLength(1); // merged into one interruption
    expect(sent[0]).toContain(`📨 收到信件\n来自：Alice#${deriveSigil('alice-id')}\n\nfrom alice`);
    expect(sent[0]).toContain(`📨 收到信件\n来自：Bob#${deriveSigil('bob-id')}\n\nfrom bob`);
  });
});
