import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPopclawInboxCommand } from '../../../src/commands/popclaw-inbox';
import { InboxStore } from '../../../src/messaging/inbox-store';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db';
import { runMigrations } from '../../../src/host/migrations';
import { deriveSigil } from '../../../src/invite/sigil';
import { setOwnerLang } from '../../../src/lexicon/owner-language';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

// S3 rollout slice 2: the 📎 media label now renders in `ownerLang()` (S1
// process-wide singleton). Pin zh-CN so this file's pre-lexicon assertions
// stay byte-for-byte unchanged (same fix as status.test.ts / popclaw-feed.test.ts).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

describe('runPopclawInboxCommand', () => {
  let store: InboxStore;

  beforeEach(() => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    store = new InboxStore(db);
  });

  it('returns empty-state message when inbox is empty', async () => {
    const out = await runPopclawInboxCommand({ positional: [], flags: {} }, { store });
    expect(out.text).toMatch(/empty|no.*DM/i);
  });

  it('lists inbox items newest first', async () => {
    store.record({ ts: 100, fromPopclawId: 'Alice', toPopclawId: 'me', body: 'old', receivedAtMs: 0 });
    store.record({ ts: 200, fromPopclawId: 'Bob', toPopclawId: 'me', body: 'new', receivedAtMs: 0 });
    const out = await runPopclawInboxCommand({ positional: [], flags: {} }, { store });
    const lines = out.text.split('\n');
    const newIdx = lines.findIndex((l) => l.includes('new'));
    const oldIdx = lines.findIndex((l) => l.includes('old'));
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(newIdx);  // newest comes first
  });

  it('honours --limit flag', async () => {
    for (let i = 1; i <= 5; i++) {
      store.record({ ts: i, fromPopclawId: 'Sender', toPopclawId: 'me', body: `msg-${i}`, receivedAtMs: 0 });
    }
    const out = await runPopclawInboxCommand({ positional: [], flags: { limit: '2' } }, { store });
    expect(out.text).toMatch(/2 DMs/);
  });

  it('uses the name chain when it resolves a sender', async () => {
    store.record({ ts: 100, fromPopclawId: 'Alice123', toPopclawId: 'me', body: 'hi', receivedAtMs: 0 });
    const out = await runPopclawInboxCommand(
      { positional: [], flags: {} },
      { store, nameOf: (id: string) => (id === 'Alice123' ? 'alice_h' : '') },
    );
    expect(out.text).toContain(`alice_h#${deriveSigil('Alice123')}`);
  });

  // When the directory has no match, show only the sigil: a raw ID's first-six/last-four abbreviation is noise to the owner (ADR-0032).
  it('falls back to the sigil (never a bare popclaw_id prefix) when no handle', async () => {
    const id = 'AbcDefGhiJklMnoPqrStu';
    store.record({ ts: 100, fromPopclawId: id, toPopclawId: 'me', body: 'hi', receivedAtMs: 0 });
    const out = await runPopclawInboxCommand({ positional: [], flags: {} }, { store });
    expect(out.text).toContain(`#${deriveSigil(id)}`);
    expect(out.text).not.toContain('AbcDef');
  });

  it('shows reply-to marker for DMs anchored to a post', async () => {
    store.record({
      ts: 100,
      fromPopclawId: 'Bob',
      toPopclawId: 'me',
      body: 'about your post',
      inReplyToPlatform: 'x',
      inReplyToPostId: '999',
      receivedAtMs: 0,
    });
    const out = await runPopclawInboxCommand({ positional: [], flags: {} }, { store });
    expect(out.text).toMatch(/re:.*999|re:.*x:999/);
  });

  // #231: expose the saved image path so the agent/owner can use it directly; add nothing for entries without images.
  it('shows 📎 图片 with the local path for DMs that carried a picture', async () => {
    store.record({
      ts: 100, fromPopclawId: 'Bob', toPopclawId: 'me', body: '看这个',
      receivedAtMs: 0, mediaPath: '/root/data/dm-media/100-Bob.png',
    });
    store.record({ ts: 99, fromPopclawId: 'Bob', toPopclawId: 'me', body: '没图', receivedAtMs: 0 });
    const out = await runPopclawInboxCommand({ positional: [], flags: {} }, { store });
    expect(out.text).toContain('📎 图片: /root/data/dm-media/100-Bob.png');
    expect(out.text.match(/📎/g)).toHaveLength(1);
  });

  // An image-only message must not leave an indented, blank body line.
  it('纯图无正文的条目只列图，不留空正文行', async () => {
    store.record({
      ts: 100, fromPopclawId: 'Bob', toPopclawId: 'me', body: '',
      receivedAtMs: 0, mediaPath: '/root/data/dm-media/100-Bob.png',
    });
    const out = await runPopclawInboxCommand({ positional: [], flags: {} }, { store });
    expect(out.text).toContain('📎 图片: /root/data/dm-media/100-Bob.png');
    // The body line was six spaces plus body; omit the entire line when body is empty.
    expect(out.text.split('\n').some((l) => /^\s+$/.test(l))).toBe(false);
  });

  // S3 rollout slice 2 — en lane for the 📎 media label.
  it('media label: en lane', async () => {
    store.record({
      ts: 100, fromPopclawId: 'Bob', toPopclawId: 'me', body: '',
      receivedAtMs: 0, mediaPath: '/root/data/dm-media/100-Bob.png',
    });
    const out = await runPopclawInboxCommand({ positional: [], flags: {} }, { store, lang: 'en' });
    expect(out.text).toContain('📎 image: /root/data/dm-media/100-Bob.png');
  });
});
