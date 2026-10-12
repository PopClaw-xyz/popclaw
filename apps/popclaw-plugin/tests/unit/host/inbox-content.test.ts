/**
 * #613-follow-up: a real acceptance run showed a received picture reaching only the
 * MODEL (as MCP image content) with no local path — a terminal renders no images, so
 * the HUMAN at the keyboard had no way to open it. A received document already carries
 * a path (`status: 'local_file'`); this file pins that an image now carries both the
 * image content AND a path inside dm-media, and that documents stay unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { InboxStore, type InboxItem } from '../../../src/messaging/inbox-store.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { stageMediaForSend, dmMediaStagingDir } from '../../../src/notifier/media-staging.js';
import { readInboxMessage } from '../../../src/host/inbox-content.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  ts: 100, fromPopclawId: 'alice', toPopclawId: 'me', body: 'hello',
  receivedAtMs: 1000, ...over,
});

describe('readInboxMessage — attachment shape', () => {
  let db: InMemoryHostDb;
  let store: InboxStore;
  let root: string;
  let paths: PopclawPaths;
  let mediaDir: string;

  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    store = new InboxStore(db);
    root = mkdtempSync(join(tmpdir(), 'popclaw-inbox-content-'));
    paths = new PopclawPaths(root);
    mediaDir = paths.dmMediaDir();
    mkdirSync(mediaDir, { recursive: true });
  });

  // Real host (abc3177): the counterpart had renamed; the L1 notice said
  // `CanaryPeer-26e2` (name chain), but reading the message returned the
  // `ranger-3cwnCm` their envelope was stamped with. One person, one name.
  it('sender_nickname is the name the notice used (name chain), not the envelope stamp', () => {
    store.record(item({ fromPopclawId: 'peer', senderNickname: 'ranger-3cwnCm' }));
    const stored = store.recent(1)[0]!;
    const nameOf = (id: string, server?: string) => (id === 'peer' ? 'CanaryPeer-26e2' : server ?? '');
    const parsed = JSON.parse(readInboxMessage(store, paths, stored.id, nameOf).text);
    expect(parsed.sender_nickname).toBe('CanaryPeer-26e2');
  });

  it('sender_nickname falls back to the envelope stamp when the chain knows nothing', () => {
    store.record(item({ fromPopclawId: 'stranger', senderNickname: 'Wanderer' }));
    const stored = store.recent(1)[0]!;
    const parsed = JSON.parse(readInboxMessage(store, paths, stored.id, () => '').text);
    expect(parsed.sender_nickname).toBe('Wanderer');
  });

  it('a received image carries mimeType AND a path inside dm-media, plus the image content', () => {
    const mediaPath = join(mediaDir, 'picture.png');
    writeFileSync(mediaPath, Buffer.from([1, 2, 3, 4]));
    store.record(item({ mediaPath }));
    const stored = store.recent(1)[0]!;
    const result = readInboxMessage(store, paths, stored.id);
    const parsed = JSON.parse(result.text);
    expect(parsed.attachment).toEqual({
      kind: 'image',
      status: 'image_content_returned',
      mimeType: 'image/png',
      path: realpathSync(mediaPath),
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.mimeType).toBe('image/png');
    expect(result.images[0]!.data).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  it('native reading stages the verified image under the host media root and retains original bytes', () => {
    const original = join(mediaDir, 'received.jpg');
    const bytes = Buffer.from([255, 216, 255, 224, 1, 2]);
    writeFileSync(original, bytes);
    store.record(item({ mediaPath: original }));
    const id = store.recent(1)[0]!.id;
    const dir = dmMediaStagingDir(join(root, 'openclaw-state'));
    const result = readInboxMessage(store, paths, id, undefined, p => stageMediaForSend(p, dir));
    const parsed = JSON.parse(result.text);
    expect(parsed.attachment.path).toBe(join(dir, 'received.jpg'));
    expect(readFileSync(parsed.attachment.path)).toEqual(bytes);
    expect(readFileSync(original)).toEqual(bytes);
    expect(store.get(id)!.mediaPath).toBe(original);
    expect(result.images[0]!.data).toBe(bytes.toString('base64'));
  });

  it('a staging failure retains image content but exposes no unusable outbound path', () => {
    const original = join(mediaDir, 'received.jpg');
    writeFileSync(original, Buffer.from([255, 216, 255]));
    store.record(item({ mediaPath: original }));
    const result = readInboxMessage(store, paths, store.recent(1)[0]!.id, undefined, () => null);
    const parsed = JSON.parse(result.text);
    expect(parsed.attachment.path).toBeUndefined();
    expect(parsed.attachment.delivery_status).toBe('unavailable');
    expect(result.images).toHaveLength(1);
  });

  it('never stages a file outside the inbox even when the host supports media', () => {
    const outside = join(root, 'outside.jpg');
    writeFileSync(outside, Buffer.from([255, 216, 255]));
    store.record(item({ mediaPath: outside }));
    let calls = 0;
    const result = readInboxMessage(store, paths, store.recent(1)[0]!.id, undefined, p => { calls++; return p; });
    expect(calls).toBe(0);
    expect(JSON.parse(result.text).attachment.status).toBe('unavailable');
  });

  it('a received document is unchanged: local_file status + path, no image content', () => {
    const mediaPath = join(mediaDir, 'spec.md');
    writeFileSync(mediaPath, 'a spec document');
    store.record(item({ mediaPath }));
    const stored = store.recent(1)[0]!;
    const result = readInboxMessage(store, paths, stored.id);
    const parsed = JSON.parse(result.text);
    expect(parsed.attachment).toEqual({ status: 'local_file', path: realpathSync(mediaPath), kind: 'doc' });
    expect(result.images).toHaveLength(0);
  });

  it('the instruction tells the agent to proactively offer to open the image (owner cannot see it at a terminal)', () => {
    const mediaPath = join(mediaDir, 'picture.jpg');
    writeFileSync(mediaPath, Buffer.from([5, 6, 7]));
    store.record(item({ mediaPath }));
    const stored = store.recent(1)[0]!;
    const result = readInboxMessage(store, paths, stored.id);
    const parsed = JSON.parse(result.text);
    expect(parsed.instruction).toContain('cannot see');
    expect(parsed.instruction).toContain('offer to open it');
    expect(parsed.instruction).toMatch(/xdg-open/);
  });
  it('preserves exact body and machine references while displaying only the letter', () => {
    const body = '  First\n\nSecond\ndraft_id: message-999  ';
    store.record(item({body, houseSlug: 'house-internal', senderNickname: 'Alice'}));
    const stored = store.recent(1)[0]!;
    // Seed the read projection; wire validation is covered by ingress tests.
    db.execute('UPDATE inbox SET event_id = ? WHERE id = ?', ['a'.repeat(64), stored.id]);
    const result = JSON.parse(readInboxMessage(store, paths, stored.id).text);
    expect(result.body).toBe(body);
    expect(result.event_id).toBe('a'.repeat(64));
    expect(result.owner_text).toContain(body);
    expect(result.owner_text).not.toContain(result.event_id);
    expect(result.owner_text).not.toContain('house-internal');
    expect(result.owner_text).not.toContain('📎');
    expect(result.instruction).toContain('Display only owner_text');
  });

  it('reports failed attachment loading honestly while retaining its internal failure reason', () => {
    store.record(item({body: '', mediaPath: join(mediaDir, 'missing.png')}));
    const stored = store.recent(1)[0]!;
    const result = readInboxMessage(store, paths, stored.id);
    const data = JSON.parse(result.text);
    expect(data.attachment.status).toBe('unavailable');
    expect(data.attachment.reason).toBeTruthy();
    expect(data.owner_text).toMatch(/Attachment unavailable|附件暂不可用/);
    expect(data.owner_text).not.toContain(mediaDir);
    expect(result.images).toEqual([]);
  });
});
