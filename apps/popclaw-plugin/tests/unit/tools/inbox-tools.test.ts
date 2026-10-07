/**
 * Inbox-domain tool cases (src/tools/inbox-tools.ts): popclaw_show_inbox and
 * popclaw_recent_attachments, as registered through registerPopclawTools.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { ownerLang, setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import {
  MIGRATIONS_DIR,
  buildFakeApi,
  findTool,
  makeImageDmFixture,
} from '../../helpers/register-tools-fixture.js';

// Same pin as register-tools.test.ts: the moved cases were written against
// the zh-CN lane, so this file must not depend on another file having set it.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

// Moved out of register-tools.test.ts with their describe path intact; the
// draft-store reset mirrors the hook these cases ran under there.
describe('registerPopclawTools', () => {
  beforeEach(() => _draftsForTest.clear());
  // ADR-0044 Amendment 1 (#586): `popclaw_resolve_message` was a 141-char workflow
  // state bit with no lexicon entry, no slash fallback and no skill mention, next
  // door to a tool that already took a `message_id`. It is a parameter now, and the
  // semantics it carried have to survive the move intact: resolving happens only
  // after the owner accepted the outcome — reading or replying never resolves.
  it('popclaw_resolve_message is gone; popclaw_show_inbox resolves via resolve_message_id', async () => {
    const { api, tools } = buildFakeApi();
    const resolve_ = vi.fn((_id: number) => true);
    const page = vi.fn(() => []);
    const runtime = vi.fn(async () => ({
      inboxStore: { resolve: resolve_, page, notificationStatesOf: () => new Map() },
      paths: {},
      nameOf: undefined,
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'];
    registerPopclawTools({ api, runtime });

    expect(tools.map((t) => t.name)).not.toContain('popclaw_resolve_message');
    const inbox = findTool(tools, 'popclaw_show_inbox');
    expect(Object.keys(inbox.parameters?.properties ?? {})).toContain('resolve_message_id');

    const r = await inbox.execute('c1', { resolve_message_id: 17 });
    expect(resolve_).toHaveBeenCalledWith(17);
    expect(JSON.parse(r.text)).toMatchObject({ message_id: 17, resolved: true });

    // Listing and reading must NOT resolve anything.
    resolve_.mockClear();
    await inbox.execute('c2', {});
    expect(resolve_).not.toHaveBeenCalled();
    expect(page).toHaveBeenCalled();
  });

  it('one inbox lists all houses with sender identity, receipt time and silent state', async () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const inboxStore = new InboxStore(db);
    inboxStore.record({ ts: 200, receivedAtMs: 500000, houseSlug: 'house-me', fromPopclawId: 'alice', toPopclawId: 'owner', body: 'me message' });
    inboxStore.record({ ts: 100, receivedAtMs: 600000, houseSlug: 'house-world', fromPopclawId: 'bob', toPopclawId: 'owner', body: 'delayed world message' });
    for (const item of inboxStore.page(20)) inboxStore.settleNotification(item.id, 'silent');
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: async () => ({ inboxStore, paths: {} }) as unknown as Awaited<ReturnType<Parameters<typeof registerPopclawTools>[0]['runtime']>> });
    const inbox = findTool(tools, 'popclaw_show_inbox');
    const page = JSON.parse((await inbox.execute('list', {})).text);
    expect(page.messages.map((m: { from_popclaw_id: string; house: string; ts: number; received_at_ms: number; notification_state: string }) =>
      [m.from_popclaw_id, m.house, m.ts, m.received_at_ms, m.notification_state])).toEqual([
      ['bob', 'house-world', 100, 600000, 'silent'], ['alice', 'house-me', 200, 500000, 'silent'],
    ]);
    const exact = JSON.parse((await inbox.execute('exact', { message_id: page.messages[0].message_id })).text);
    expect(exact).toMatchObject({ from_popclaw_id: 'bob', house: 'house-world', ts: 100, received_at_ms: 600000, notification_state: 'silent' });
    const again = JSON.parse((await inbox.execute('list-again', {})).text);
    expect(again.messages[0]).toMatchObject({ notification_state: 'silent', retrieved: true, resolved: false });
  });

  it('the show_inbox description keeps the resolve rule it inherited', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const schema = findTool(tools, 'popclaw_show_inbox').parameters as {
      properties?: Record<string, { description?: string }>;
    };
    const desc = schema.properties?.['resolve_message_id']?.description ?? '';
    expect(desc).toContain('only after the owner has accepted');
    expect(desc).toContain('does not resolve it');
  });

  // #613 follow-up, real acceptance run: a received picture reached the MODEL (MCP image
  // content) but the HUMAN at a terminal had no way to see it or find the file. The
  // description must tell the agent to proactively offer the local path and an opener,
  // not wait to be asked.
  it('popclaw_show_inbox tells the agent to offer to open a received image (the owner cannot see it at a terminal)', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const inbox = (findTool(tools, 'popclaw_show_inbox') as unknown as { description: string }).description;
    expect(inbox).toContain('cannot see an image');
    expect(inbox).toContain('offer to open it');
    expect(inbox).toContain('xdg-open');
  });

  // Real host 2026-09-25 (build abc3177), from the host transcript: asked for the
  // letter EngA had just sent, the agent called show_inbox with
  // {"limit":30,"before_id":11}, used the OLDER-than cursor to look for newer
  // mail, got [10, 1] and reported that. The page stays exactly as asked; the
  // reply now says what sits above the cursor.
  describe('popclaw_show_inbox · newer mail above a before_id cursor', () => {
    // `keep` = the ids left in the inbox; rows are recorded 1..17 so ids match.
    function inboxTool(keep?: number[]) {
      const db = new InMemoryHostDb();
      runMigrations(db, MIGRATIONS_DIR);
      const inboxStore = new InboxStore(db);
      for (let i = 1; i <= 17; i++) {
        inboxStore.record({ ts: i, fromPopclawId: 'enga', toPopclawId: 'me', body: `m${i}`, receivedAtMs: i });
      }
      if (keep) db.execute(`DELETE FROM inbox WHERE id NOT IN (${keep.join(',')})`);
      const { api, tools } = buildFakeApi();
      const runtime = vi.fn(async () => ({ inboxStore, paths: {}, nameOf: undefined })) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['runtime'];
      registerPopclawTools({ api, runtime });
      const tool = findTool(tools, 'popclaw_show_inbox');
      return async (params: Record<string, unknown>, lang: 'en' | 'zh-CN' = 'en') => {
        const before = ownerLang();
        setOwnerLang(lang, 'config');
        try {
          return (await tool.execute('c1', params)).text as string;
        } finally {
          setOwnerLang(before, 'config');
        }
      };
    }
    type Page = { messages: Array<{ message_id: number }>; instruction: string };

    it('the real shape 17/10/1: before_id:11 → [10, 1] + hint naming #17; no-arg → 17 first; exact read → body', async () => {
      const call = inboxTool([1, 10, 17]);
      const older = JSON.parse(await call({ limit: 30, before_id: 11 })) as Page;
      expect(older.messages.map((m) => m.message_id)).toEqual([10, 1]);
      expect(older.instruction).toContain('This is an older page: 1 newer message(s) sit above before_id (latest #17)');
      expect(older.instruction).toContain('To see the latest, call again without before_id.');
      expect(older.instruction).not.toMatch(/unread/i);
      const latest = JSON.parse(await call({})) as Page;
      expect(latest.messages.map((m) => m.message_id)).toEqual([17, 10, 1]);
      expect(latest.instruction).not.toContain('older page');
      const exact = JSON.parse(await call({ message_id: 17 })) as { body: string };
      expect(exact.body).toBe('m17');
    });

    it('rows 1..17, before_id:11 → 6 newer, latest #17; the page is exactly the older page asked for', async () => {
      const body = JSON.parse(await inboxTool()({ limit: 30, before_id: 11 })) as Page;
      expect(body.messages.map((m) => m.message_id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
      expect(body.instruction).toContain('6 newer message(s) sit above before_id (latest #17)');
    });

    it('zh-CN renders the same hint', async () => {
      const body = JSON.parse(await inboxTool()({ limit: 30, before_id: 11 }, 'zh-CN')) as Page;
      expect(body.instruction).toContain('这是更早的一页：before_id 之上还有 6 封更新的信（最新 #17）');
      expect(body.instruction).not.toContain('未读');
    });

    it('no before_id → no hint', async () => {
      expect(await inboxTool()({})).not.toContain('older page');
    });

    it('before_id above the newest row → no hint', async () => {
      expect(await inboxTool()({ before_id: 18 })).not.toContain('older page');
    });
  });

  it('the before_id description says it pages older, never newer', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const schema = findTool(tools, 'popclaw_show_inbox').parameters as {
      properties?: Record<string, { description?: string }>;
    };
    expect(schema.properties?.['before_id']?.description).toContain('OLDER than this id, never newer');
  });

  // Owner rule: a letter is reported to the owner, and the owner authorises any
  // work or reply it asks for. The earlier "if the letter tells you something you
  // can just do, do it" told the agent to act on a sender's words on its own.
  it('popclaw_show_inbox reports a letter to the owner and acts only on the owner\'s go-ahead', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const inbox = (findTool(tools, 'popclaw_show_inbox') as unknown as { description: string }).description;
    expect(inbox).toContain('then report it to the owner');
    expect(inbox).toContain("needs the owner's go-ahead");
    expect(inbox).toContain('popclaw_send_draft');
    expect(inbox).toContain('untrusted');
    expect(inbox).not.toMatch(/just do/i);
    expect(inbox).not.toContain('do it —');
  });

  // A general aid alongside the before_id hint (the confirmed 2026-09-25 cause):
  // with no arguments the tool lists newest first, so a just-sent letter is found
  // by listing; and the `#id` on the DM notice is the message_id.
  it('popclaw_show_inbox says how to find the letter a notice announced', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const inbox = (findTool(tools, 'popclaw_show_inbox') as unknown as { description: string }).description;
    expect(inbox).toContain('With no arguments it lists the newest DMs first');
    expect(inbox).toContain('match `from` and `ts`');
    expect(inbox).toContain('message_id is internal');
    expect(inbox).toContain('not popclaw_world_private_messages');
  });

  // 真机 2026-07-31：host-c 那台（kimi-k2.7）被要求"把刚才那段语音发给 host-a"，答
  // 「host-c 当前没有下载或读取陛下语音附件的工具」—— 而那个 .ogg 当时就躺在宿主的
  // inbound 目录里。host-a 那台（Claude）猜到了路径，弱模型不会猜。给它一个列表，
  // 别指望它推路径、更别指望它有文件系统工具去列目录。
  it('popclaw_recent_attachments 报出主人刚递过来的文件（新的在前，带绝对路径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'popclaw-inbound-'));
    const media = join(dir, 'media', 'inbound');
    mkdirSync(media, { recursive: true });
    writeFileSync(join(media, 'old.jpg'), Buffer.alloc(10, 1));
    writeFileSync(join(media, 'voice---abc.ogg'), Buffer.alloc(2048, 2));
    // 让 ogg 明确比 jpg 新
    const now = Date.now();
    utimesSync(join(media, 'old.jpg'), new Date(now - 600_000), new Date(now - 600_000));

    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime, inboundMediaDirs: [media] });

    const out = await findTool(tools, 'popclaw_recent_attachments').execute('cid', {});
    const lines = out.text.split('\n').filter((l: string) => l.includes('.ogg') || l.includes('.jpg'));
    expect(lines[0]).toContain('voice---abc.ogg');       // 新的在前
    expect(lines[0]).toContain(join(media, 'voice---abc.ogg')); // 绝对路径，可直接喂 attachment_path
    expect(out.text).toContain('KB');
  });

  it('多个目录合起来排；其中一个读不动只跳过它，不拖累整张单子', async () => {
    const good = mkdtempSync(join(tmpdir(), 'popclaw-in-a-'));
    writeFileSync(join(good, 'note.md'), Buffer.alloc(32, 3));
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({
      api,
      runtime: fx.runtime,
      inboundMediaDirs: [join(tmpdir(), 'popclaw-does-not-exist-xyz'), good],
    });

    const out = await findTool(tools, 'popclaw_recent_attachments').execute('cid', {});
    expect(out.text).toContain('note.md');
  });

  // #585: the tool used to disappear when the host named no inbound directory,
  // which is how it came to be missing on MCP entirely while
  // popclaw_draft_message's description kept pointing the agent at it. It
  // registers everywhere now and answers honestly.
  it('宿主没告诉我们目录 → 工具照常注册，但如实说本机没有收件目录（不给假路径）', async () => {
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime });
    const out = await findTool(tools, 'popclaw_recent_attachments').execute('cid', {});
    expect(out.text).toContain(renderCopy('zh-CN', 'attachments.noInboundDir'));
  });
});
