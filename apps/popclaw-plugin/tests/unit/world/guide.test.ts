/**
 * T2: parseGuideFrontmatter unit tests.
 *
 * One end-to-end case reads a sanitized guide.md fixture; the rest use synthetic inputs.
 * The fixture is a sanitized LoreHouse guide.md copy, so plugin tests do not depend on
 * apps/lore-house, which is excluded from the public repository. In the private monorepo,
 * an additional skipIf case checks the real guide.md for cross-package contract alignment,
 * asserting structural facts only, not sanitized real values.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGuideFrontmatter, summaryDeclaration } from '../../../src/world/guide.js';
import type { WorldDescriptor } from '../../../src/world/guide.js';
import { invalidSummaryDeclarations } from '../../helpers/summary-declaration-cases.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const realGuidePath = resolve(__dirname, '../../../../lore-house/assets/guide.md');

describe('raw summary capability without changing the tolerant display parser', () => {
  it.each(invalidSummaryDeclarations)('classifies %s as unknown', (_name, guide) => {
    expect(summaryDeclaration(guide)).toBe('unknown');
  });
  it.each(['', '    transport: http\n', '    transport: rest\n'])('accepts the fixed path and valid transport %s', transport => {
    const guide = `---\nstreams:\n  - name: summary\n    endpoint: /v1/world-summary\n${transport}---\n# House`;
    expect(summaryDeclaration(guide)).toBe('supported');
    expect(summaryDeclaration(guide.replaceAll('\n', '\r\n'))).toBe('supported');
  });
  it('does not make another incomplete stream into a summary or rewrite general parser behavior', () => {
    const guide = '---\nstreams:\n  - name: latest\n  - endpoint: /v1/world-summary\n    name: summary\n---\n# House';
    expect(summaryDeclaration(guide)).toBe('supported');
    expect(parseGuideFrontmatter(guide).frontmatter?.streams).toEqual([{ name: 'summary', endpoint: '/v1/world-summary' }]);
    const duplicate = invalidSummaryDeclarations[1][1];
    expect(parseGuideFrontmatter(duplicate).frontmatter?.streams).toEqual([{ name: 'summary', endpoint: '/v1/world-summary' }]);
  });
  it('does not promote an indented streams-like field inside another guide block', () => {
    const guide = '---\nentry:\n  streams:\n    - name: summary\n      endpoint: /v1/world-summary\n---\n# House';
    expect(parseGuideFrontmatter(guide).frontmatter?.streams).toEqual([]);
    expect(summaryDeclaration(guide)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: read the sanitized guide.md fixture.
// ---------------------------------------------------------------------------
describe('parseGuideFrontmatter — guide.md fixture', () => {
  it('parses the fixture guide.md and returns 2 streams', () => {
    const guidePath = resolve(
      __dirname,
      '../../fixtures/world/guide.md',
    );
    const md = readFileSync(guidePath, 'utf-8');
    const result = parseGuideFrontmatter(md);

    expect(result.frontmatter).not.toBeNull();
    const fm = result.frontmatter as WorldDescriptor;
    expect(fm.world).toBe('popclaw.me');
    expect(fm.kind).toBe('social-plaza');
    expect(fm.voice).toBe('自由说话的巨型社交广场');
    expect(fm.streams).toHaveLength(2);

    const summary = fm.streams[0]!;
    expect(summary.name).toBe('summary');
    expect(summary.endpoint).toBe('/v1/world-summary');
    expect(summary.transport).toBeUndefined();
    expect(summary.note).toBe('精华——回应、引用与新近度的混合排序，附江湖状态与认证名人');

    const latest = fm.streams[1]!;
    expect(latest.name).toBe('latest');
    expect(latest.endpoint).toBe('/v1/discovery');
    expect(latest.transport).toBe('sse');
    expect(latest.note).toBe('全量时间线，可按 payload_type/actor/platform 过滤');

    // body must start after the --- fence
    expect(result.body.trimStart()).toMatch(/^# 欢迎来到 popclaw\.me/);
  });

  it('parses the fixture guide.md feedback contact', () => {
    const guidePath = resolve(__dirname, '../../fixtures/world/guide.md');
    const md = readFileSync(guidePath, 'utf-8');
    const fm = parseGuideFrontmatter(md).frontmatter as WorldDescriptor;
    expect(fm.feedback?.contact).toBe('Scout');
    expect(fm.feedback?.popclawId).toBe('FixtureGuideFeedbackPopclawId00000000000');
  });

  // monorepo-only: guards the parser ↔ live lore-house guide.md contract.
  // Skipped when apps/lore-house isn't present (e.g. the public export).
  // Only structural facts are asserted — never the real contact/id values.
  describe.skipIf(!existsSync(realGuidePath))('real lore-house guide.md (monorepo contract check)', () => {
    it('parses without throwing and keeps the shape the parser promises', () => {
      const md = readFileSync(realGuidePath, 'utf-8');
      const result = parseGuideFrontmatter(md);
      expect(result.frontmatter).not.toBeNull();
      const fm = result.frontmatter as WorldDescriptor;
      expect(fm.streams).toHaveLength(2);
      expect(typeof fm.feedback?.contact).toBe('string');
      expect(fm.feedback?.contact).not.toHaveLength(0);
      expect(fm.entry?.home).toMatch(/^https?:\/\//);
    });

    /**
     * Release gate: English incantations, headlines, and noticeboards must fit plugin limits.
     * Overflow is not cosmetic: handshake drops the whole line (first_move >20 leaves the
     * door card blank) or truncates it. Keep these limits aligned with FIRST_MOVE_MAX /
     * HEADLINE_MAX in house-handshake.ts and VOICE_MAX in gather-materials.ts; update together.
     */
    it('本坊自己声明的 _en 值全部卡在插件上限之内（自吃狗粮）', () => {
      const fm = parseGuideFrontmatter(readFileSync(realGuidePath, 'utf-8'))
        .frontmatter as WorldDescriptor;
      expect(fm.entry?.firstMoveEn).toBeDefined();
      expect(fm.entry?.firstMoveEn!.length).toBeLessThanOrEqual(20); // Overflow removes the entire door-card line.
      expect(fm.entry?.headlineEn).toBeDefined();
      expect(fm.entry?.headlineEn!.length).toBeLessThanOrEqual(40); // Overflow truncates mid-text.
      expect(fm.voiceEn).toBeDefined();
      expect(fm.voiceEn!.length).toBeLessThanOrEqual(40); // Newspaper noticeboard VOICE_MAX.
      // The Chinese half is unchanged.
      expect(fm.entry?.firstMove).toBe('带我看看江湖上在说什么');
    });
  });
});

// ---------------------------------------------------------------------------
// Synthetic cases.
// ---------------------------------------------------------------------------
describe('parseGuideFrontmatter — synthetic cases', () => {
  it('returns {frontmatter: null, body: original} when no frontmatter', () => {
    const md = '# 普通 markdown\n没有 frontmatter。';
    const result = parseGuideFrontmatter(md);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(md);
  });

  it('handles empty streams list gracefully', () => {
    const md = ['---', 'world: test.me', 'streams:', '---', '', '正文。'].join('\n');
    const result = parseGuideFrontmatter(md);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.streams).toEqual([]);
    expect(result.body.trim()).toBe('正文。');
  });

  it('tolerates CRLF line endings', () => {
    const md =
      '---\r\nworld: crlf.me\r\nkind: test\r\nstreams:\r\n  - name: foo\r\n    endpoint: /foo\r\n---\r\n正文。';
    const result = parseGuideFrontmatter(md);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.world).toBe('crlf.me');
    expect(result.frontmatter!.streams).toHaveLength(1);
    expect(result.frontmatter!.streams[0]!.name).toBe('foo');
    expect(result.frontmatter!.streams[0]!.endpoint).toBe('/foo');
  });

  it('ignores unknown top-level keys', () => {
    const md = [
      '---',
      'world: test.me',
      'unknownKey: something',
      'anotherUnknown: 42',
      'streams:',
      '---',
      'body text',
    ].join('\n');
    const result = parseGuideFrontmatter(md);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.world).toBe('test.me');
    // unknown keys do not appear on the typed result
    expect((result.frontmatter as unknown as Record<string, unknown>)['unknownKey']).toBeUndefined();
  });

  it('ignores unknown stream-item keys without throwing', () => {
    const md = [
      '---',
      'world: test.me',
      'streams:',
      '  - name: mystream',
      '    endpoint: /v1/foo',
      '    unknownStreamKey: ignored',
      '    transport: sse',
      '---',
      'body',
    ].join('\n');
    const result = parseGuideFrontmatter(md);
    expect(result.frontmatter).not.toBeNull();
    const s = result.frontmatter!.streams[0]!;
    expect(s.name).toBe('mystream');
    expect(s.endpoint).toBe('/v1/foo');
    expect(s.transport).toBe('sse');
    expect((s as unknown as Record<string, unknown>)['unknownStreamKey']).toBeUndefined();
  });

  it('handles single stream with all optional fields', () => {
    const md = [
      '---',
      'world: demo.me',
      'streams:',
      '  - name: events',
      '    endpoint: /v1/events',
      '    transport: sse',
      '    note: live events stream',
      '---',
    ].join('\n');
    const result = parseGuideFrontmatter(md);
    expect(result.frontmatter!.streams).toHaveLength(1);
    const s = result.frontmatter!.streams[0]!;
    expect(s.transport).toBe('sse');
    expect(s.note).toBe('live events stream');
    expect(result.body.trim()).toBe('');
  });

  // --- feedback: block (2026-07-29, /popclaw feedback) ---

  it('parses a feedback block that follows the streams list', () => {
    const md = [
      '---',
      'world: test.me',
      'streams:',
      '  - name: latest',
      '    endpoint: /v1/discovery',
      'feedback:',
      '  contact: host-b',
      '  popclaw_id: ABC123',
      '---',
      'body',
    ].join('\n');
    const fm = parseGuideFrontmatter(md).frontmatter!;
    expect(fm.streams).toHaveLength(1);
    expect(fm.feedback).toEqual({ contact: 'host-b', popclawId: 'ABC123' });
  });

  it('parses a feedback block that precedes the streams list (CRLF)', () => {
    const md =
      '---\r\nfeedback:\r\n  contact: host-a\r\n  popclaw_id: XYZ\r\nstreams:\r\n  - name: latest\r\n    endpoint: /e\r\n---\r\nbody';
    const fm = parseGuideFrontmatter(md).frontmatter!;
    expect(fm.feedback).toEqual({ contact: 'host-a', popclawId: 'XYZ' });
    expect(fm.streams).toHaveLength(1);
  });

  it('leaves feedback undefined when the block is absent', () => {
    const md = ['---', 'world: test.me', 'streams:', '---', 'body'].join('\n');
    expect(parseGuideFrontmatter(md).frontmatter!.feedback).toBeUndefined();
  });

  it('keeps a malformed feedback block partial instead of throwing', () => {
    const md = [
      '---',
      'feedback:',
      '  contact: host-b',
      '  this line has no colon',
      '  unknown_key: whatever',
      '---',
      'body',
    ].join('\n');
    const fm = parseGuideFrontmatter(md).frontmatter!;
    expect(fm.feedback).toEqual({ contact: 'host-b' });
    expect(fm.feedback?.popclawId).toBeUndefined();
  });

  // --- entry: block (2026-07-30, onboarding R1 §1) ---

  it('parses an entry block alongside feedback + streams', () => {
    const md = [
      '---',
      'world: test.world',
      'streams:',
      '  - name: latest',
      '    endpoint: /e',
      'entry:',
      '  home: https://test.world/',
      '  headline: 捏一个你自己的公仔',
      '  first_move: 带我进世界',
      '  recipe: 回家链接',
      'feedback:',
      '  contact: host-a',
      '---',
      'body',
    ].join('\n');
    const fm = parseGuideFrontmatter(md).frontmatter!;
    expect(fm.entry).toEqual({
      home: 'https://test.world/',
      headline: '捏一个你自己的公仔',
      firstMove: '带我进世界',
      recipe: '回家链接',
    });
    expect(fm.feedback).toEqual({ contact: 'host-a' });
    expect(fm.streams).toHaveLength(1);
  });

  it('entry 全字段可选，未知 key 忽略，坏行不抛', () => {
    const md = ['---', 'entry:', '  headline: 只有这一句', '  nonsense', '  future_key: x', '---', 'b'].join('\n');
    expect(parseGuideFrontmatter(md).frontmatter!.entry).toEqual({ headline: '只有这一句' });
  });

  it('没声明 entry → undefined（零声明，各表面维持现状）', () => {
    const md = ['---', 'world: test.me', 'streams:', '---', 'body'].join('\n');
    expect(parseGuideFrontmatter(md).frontmatter!.entry).toBeUndefined();
  });

  it('parses the fixture guide.md entry declaration（自吃狗粮）', () => {
    const guidePath = resolve(__dirname, '../../fixtures/world/guide.md');
    const fm = parseGuideFrontmatter(readFileSync(guidePath, 'utf-8')).frontmatter!;
    expect(fm.entry?.home).toBe('https://popclaw.me/feed');
    expect(fm.entry?.firstMove).toBe('带我看看江湖上在说什么');
  });

  it('frontmatter with no body yields empty body string', () => {
    const md = '---\nworld: x.me\nstreams:\n---';
    const result = parseGuideFrontmatter(md);
    expect(result.body.trim()).toBe('');
  });
});
