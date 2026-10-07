import { afterEach, expect, it } from 'vitest';
import { renderL1, renderL1Batch } from '../../../src/notifier/l1-content.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import type { NotificationItem } from '../../../src/notifier/types.js';

const item = (kind: NotificationItem['kind'], payload: NotificationItem['payload']): NotificationItem =>
  ({ id: 1, level: 'L1', kind, payload, enqueuedAt: 100 });
afterEach(() => setOwnerLang(undefined));

it('returns complete mixed text and raw ordered media with one invitation per kind', () => {
  setOwnerLang('en', 'config');
  const items = [
    item('reply', { fromPopclawId: 'alice', fromName: 'Alice', body: 'Hello', bondLine: 'Met last week', mediaPath: '/local/photo.png' }),
    item('dm', { fromPopclawId: 'bob', body: '[homeletter/v1] kind=postcard view=https://hidden.test/a.png\n' + 'L'.repeat(257) + '\nhttps://images.test/a.jpg\nhttps://images.test/b.png\nhttps://images.test/c.gif', mediaPath: '/local/photo.png', messageId: 7 }),
    item('reply', { fromPopclawId: 'bob', body: 'Again' }),
    item('dm', { fromPopclawId: 'alice', body: 'https://images.test/b.png\nhttps://images.test/d.webp', mediaPath: '/local/voice.ogg' }),
  ] as const;
  expect(renderL1Batch(items)).toEqual({
    text: `💬 Alice#5fc0djbz replied to you: Hello\nMet last week\n\n📨 Letter received\nFrom: #g6v3fp7w\n\n${'L'.repeat(256)}… (full text in the inbox)\n\n📎 Attachment: photo.png\n\n💬 #g6v3fp7w replied to you: Again\n\n📨 Letter received\nFrom: #5fc0djbz\n\nhttps://images.test/b.png\nhttps://images.test/d.webp\n\n📎 Attachment: voice.ogg\n\n Want to see all the replies? Just say so\n\n Want the full letter? Just say so`,
    mediaUrls: ['/local/photo.png', 'https://images.test/a.jpg', 'https://images.test/b.png', '/local/voice.ogg', 'https://images.test/d.webp'],
  });
});

it('reads default language for each item and invitation at its own call site', () => {
  setOwnerLang('en', 'config');
  const items = [
    item('reply', { fromPopclawId: 'alice', get body() { setOwnerLang('zh-CN', 'config'); return 'First'; } }),
    item('reply', { fromPopclawId: 'bob', get body() { setOwnerLang('en', 'config'); return 'Second'; } }),
  ];
  expect(renderL1Batch(items)).toEqual({
    text: '💬 #5fc0djbz replied to you: First\n💬 #g6v3fp7w 回了你的发言：Second\n Want to see all the replies? Just say so',
    mediaUrls: [],
  });
});

it('keeps explicit language overrides and rereads the default for later calls', () => {
  const reply = item('reply', { fromPopclawId: 'alice', body: 'Hello' });
  setOwnerLang('zh-CN', 'config');
  expect(renderL1(reply, 'en')).toBe('💬 #5fc0djbz replied to you: Hello');
  expect(renderL1(reply)).toBe('💬 #5fc0djbz 回了你的发言：Hello');
  setOwnerLang('en', 'config');
  expect(renderL1(reply)).toBe('💬 #5fc0djbz replied to you: Hello');
  expect(renderL1Batch([])).toEqual({ text: '', mediaUrls: [] });
});


it('lays out a received letter vertically without machine references', () => {
  const notice = renderL1(item('dm', { fromPopclawId: 'alice', fromName: 'Alice', messageId: 5550, body: 'First paragraph.\n\nSecond paragraph.' }), 'en');
  expect(notice).toBe('📨 Letter received\nFrom: Alice#5fc0djbz\n\nFirst paragraph.\n\nSecond paragraph.');
  expect(notice).not.toContain('5550');
});
