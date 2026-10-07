import {describe, expect, it} from 'vitest';
import {attachmentLabel, attachmentLine, renderReceivedLetter} from '../../../src/messaging/dm-presentation.js';

describe.each(['en', 'zh-CN'] as const)('private letter presentation in %s', lang => {
  it('preserves original paragraphs, including literal machine-like text', () => {
    const body = '  First paragraph.\n\n````\ndraft_id: message-999\nevent_id: legal quoted text\n````\n  ';
    expect(renderReceivedLetter('Alice#abcd', body, undefined, lang)).toContain(body);
  });
  it('omits empty body and attachment placeholder', () => {
    const text = renderReceivedLetter('Alice#abcd', '', undefined, lang);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).not.toContain('📎');
  });
  it.each(['c8af982d-c858-4ad9-beb4-ae32d7c2c7d7.jpg', 'a'.repeat(64) + '.ogg', '1791333111-abcd.png'])('uses category for generated filename %s', name => {
    expect(attachmentLabel(name, lang)).not.toContain(name);
    expect(attachmentLine('/private/media/' + name, lang)).not.toContain('/private');
  });
  it.each(['image.jpg', 'meeting.ogg', 'project-spec.md'])('keeps a useful attachment filename %s', name => {
    const text = renderReceivedLetter('Alice#abcd', '', {path: '/private/media/' + name}, lang);
    expect(text).toContain(name);
    expect(text).not.toContain('/private');
    expect(text.split('\n')).toHaveLength(4);
    expect(text).not.toMatch(/Message:|正文：|image only|纯图/);
  });
  it('explicitly reports unreadable attachment without assuming content', () => {
    const text = renderReceivedLetter('Alice#abcd', 'Message', {unavailable: true}, lang);
    expect(text).toContain(lang === 'en' ? 'Attachment unavailable' : '附件暂不可用');
  });
});
