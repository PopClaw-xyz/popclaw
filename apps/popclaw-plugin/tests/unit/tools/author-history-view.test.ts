import { afterEach, describe, expect, it } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { renderAuthorHistory, type AuthorHistoryInput, type AuthorHistoryItem } from '../../../src/tools/author-history-view.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { setOwnerTz } from '../../../src/time/time-context.js';

const encodePost = (text: string): Uint8Array => popclaw.event.EventEnvelope.encode({ post: { blocks: [{ blockType: 0, content: text }] } }).finish();
const instant = Date.parse('2025-01-01T23:30:00Z') / 1000;
const mixed: readonly AuthorHistoryItem[] = [
  { platform: 'popclaw', platformPostId: 'abcd123456' + 'a'.repeat(54), textPreview: ' native preview ', envelope: encodePost(' full native body '), platformPostCreatedAt: instant },
  { platform: 'x', platformPostId: 'fedc654321' + 'b'.repeat(54), originalUrl: 'https://x.com/test/status/1', textPreview: ' mirror preview ', envelope: encodePost(' full mirror body '), platformPostCreatedAt: instant },
  { platform: 'youtube', platformPostId: 'missing-source', originalUrl: null, textPreview: ' missing link preview ', platformPostCreatedAt: 0 },
];
const input: AuthorHistoryInput = { author: { nickname: 'Alias', platforms: ['popclaw', 'x'] }, items: mixed, requestedCount: 6, webBaseUrl: 'https://history.example', lang: 'en' };
const EXPECTED_HISTORY = {
  "short-zh-CN": "[Alias]（popclaw/X）最新 3 条发声：\n\n1. 📜 popclaw\nnative preview\n链接：https://history.example/post/abcd123456\n\n2. 🐦 X\nmirror preview\n源平台原文：https://x.com/test/status/1\n\n3. ▶️ YT\nmissing link preview\n（源链接缺失）",
  "long-zh-CN": "[Alias]（popclaw/X）灯坊收录的最近 3 条发声（共请求 6 条，灯坊只收录了这些）：\n\n[2025-01-02] 📜 popclaw\nfull native body\n链接：https://history.example/post/abcd123456\n\n[2025-01-02] 🐦 X\nfull mirror body\n源平台原文：https://x.com/test/status/1\n\n[日期未知] ▶️ YT\nmissing link preview\n（源链接缺失）\n\n（素材完毕。请据此在本轮给主人一份对这个人的总结：主要话题、立场与口吻、时间线上的变化；并如实注明总结基于灯坊收录的 3 条帖子，不代表其全部历史。主人若决定关注，调 popclaw_follow。）",
  "short-en": "[Alias]（popclaw/X） latest 3 posts:\n\n1. 📜 popclaw\nnative preview\nLink: https://history.example/post/abcd123456\n\n2. 🐦 X\nmirror preview\nSource: https://x.com/test/status/1\n\n3. ▶️ YT\nmissing link preview\n(source link missing)",
  "long-en": "[Alias]（popclaw/X） the lore-house has the latest 3 posts (you asked for 6; this is all the lore-house has):\n\n[2025-01-02] 📜 popclaw\nfull native body\nLink: https://history.example/post/abcd123456\n\n[2025-01-02] 🐦 X\nfull mirror body\nSource: https://x.com/test/status/1\n\n[date unknown] ▶️ YT\nmissing link preview\n(source link missing)\n\n(End of material. This turn, sum this person up for the owner: what they write about, where they stand, how they sound, what changed over time. Say plainly that it rests on the 3 posts the lore-house has, not their whole history. If the owner wants to follow them, call popclaw_follow.)"
} as const;

// These expectations are complete strings from the pre-extraction tool, not
// snapshots regenerated from the new implementation.
describe('renderAuthorHistory', () => {
  afterEach(() => { setOwnerTz(undefined); setOwnerLang('zh-CN', 'config'); });

  for (const lang of ['zh-CN', 'en'] as const) {
    for (const [mode, requestedCount] of [['short', 5], ['long', 6]] as const) {
      it(`${mode} ${lang}: complete native/mirror/missing-link composition`, () => {
        setOwnerTz('Asia/Shanghai');
        // Explicit copy language is independent of the owner singleton.
        setOwnerLang(lang === 'en' ? 'zh-CN' : 'en', 'config');
        expect(renderAuthorHistory({ ...input, lang, requestedCount })).toBe(EXPECTED_HISTORY[`${mode}-${lang}`]);
      });
    }
  }

  it('reads the live owner-local calendar day and accepts protobuf timestamp shapes', () => {
    const items = mixed.map((it, i) => i === 0 ? { ...it, platformPostCreatedAt: String(instant) } : i === 1 ? { ...it, platformPostCreatedAt: { low: instant, high: 0, unsigned: true } } : it);
    setOwnerTz('Asia/Shanghai');
    expect(renderAuthorHistory({ ...input, items })).toBe(EXPECTED_HISTORY['long-en']);
    setOwnerTz('America/Los_Angeles');
    expect(renderAuthorHistory({ ...input, items })).toBe(EXPECTED_HISTORY['long-en'].replaceAll('2025-01-02', '2025-01-01'));
  });

  it.each([undefined, null, new Uint8Array(), encodePost('')])('falls back to preview for missing/empty envelope or empty decoded body (%s)', (envelope) => {
    setOwnerTz('Asia/Shanghai');
    const items = mixed.map((it, i) => i === 0 ? { ...it, envelope } : it);
    expect(renderAuthorHistory({ ...input, items })).toBe(EXPECTED_HISTORY['long-en'].replace('full native body', 'native preview'));
  });

  it('falls back when the post decoder returns empty text for whitespace-only blocks', () => {
    setOwnerTz('Asia/Shanghai');
    const items = mixed.map((it, i) => i === 0 ? { ...it, envelope: encodePost('   ') } : it);
    expect(renderAuthorHistory({ ...input, items })).toBe(EXPECTED_HISTORY['long-en'].replace('full native body', 'native preview'));
  });

  it('does not fall back after selecting a whitespace-only reply body', () => {
    setOwnerTz('Asia/Shanghai');
    const envelope = popclaw.event.EventEnvelope.encode({ reply: { body: '   ' } }).finish();
    const items = mixed.map((it, i) => i === 0 ? { ...it, envelope } : it);
    expect(renderAuthorHistory({ ...input, items })).toBe(EXPECTED_HISTORY['long-en'].replace('full native body\n', ''));
  });

  it('keeps 500 UTF-16 units exactly, including a split surrogate, then an ellipsis', () => {
    setOwnerTz('Asia/Shanghai');
    const items = mixed.map((it, i) => i === 0 ? { ...it, envelope: encodePost('z'.repeat(499) + '😀 tail') } : it);
    expect(renderAuthorHistory({ ...input, items })).toBe(EXPECTED_HISTORY['long-en'].replace('full native body', 'z'.repeat(499) + '\ud83d…'));
    const exactly = mixed.map((it, i) => i === 0 ? { ...it, envelope: encodePost('z'.repeat(500)) } : it);
    expect(renderAuthorHistory({ ...input, items: exactly })).toBe(EXPECTED_HISTORY['long-en'].replace('full native body', 'z'.repeat(500)));
  });

  it('short mode never decodes malformed evidence or truncates the preview', () => {
    const items = mixed.map((it, i) => i === 0 ? { ...it, envelope: new Uint8Array([128]), textPreview: 'v'.repeat(600) } : it);
    expect(renderAuthorHistory({ ...input, requestedCount: 5, items })).toBe(EXPECTED_HISTORY['short-en'].replace('native preview', 'v'.repeat(600)));
    expect(() => renderAuthorHistory({ ...input, items })).toThrow('WIRE_VARINT');
  });

  it('omits the suffix for unknown author platforms and defaults null item platforms to native', () => {
    const result = renderAuthorHistory({ ...input, requestedCount: 5, author: { nickname: 'Alias', platforms: [] }, items: mixed.map((it, i) => i === 0 ? { ...it, platform: null } : it) });
    expect(result).toBe(EXPECTED_HISTORY['short-en'].replace('（popclaw/X）', ''));
  });

  it('omits empty bodies and uses the same missing-source copy for an empty mirror URL', () => {
    const items = mixed.map((it, i) => i === 2 ? { ...it, textPreview: null, originalUrl: '' } : it);
    expect(renderAuthorHistory({ ...input, items, requestedCount: 5 })).toBe(EXPECTED_HISTORY['short-en'].replace('missing link preview\n', ''));
  });

  it('reports returned count and has no shortfall when all six requested items are present', () => {
    setOwnerTz('Asia/Shanghai');
    const result = renderAuthorHistory({ ...input, items: [...mixed, ...mixed] });
    const header = '[Alias]（popclaw/X） the lore-house has the latest 6 posts:';
    const blocks = EXPECTED_HISTORY['long-en'].split('\n\n');
    const footer = '(End of material. This turn, sum this person up for the owner: what they write about, where they stand, how they sound, what changed over time. Say plainly that it rests on the 6 posts the lore-house has, not their whole history. If the owner wants to follow them, call popclaw_follow.)';
    expect(result).toBe([header, ...blocks.slice(1, 4), ...blocks.slice(1, 4), footer].join('\n\n'));
  });
});
