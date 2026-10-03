/**
 * The paper as a file on disk (owner ruling 2026-09-12): **zero dependency, not
 * zero network**.
 *
 * A saved issue must stand on its own — it may reference no popclaw service at
 * all, and it must hand nobody a record of what the owner is reading. What it
 * may still do is pull the same third-party static assets the hosted page pulls
 * (web fonts, the pictures posts came with), so the local copy looks like the
 * one online. Offline that degrades to system faces and missing pictures; the
 * text and every face stay put, because the faces are baked in.
 *
 * These tests pin the four surfaces that promise holds on: the referrer policy,
 * the absence of any URL carrying the issue's own text, the two opt-outs
 * (`fonts` / `avatars`) and the doorbell gate.
 */
import { describe, it, expect } from 'vitest';
import { renderNewspaper, type NewspaperEdit } from '../../../src/newspaper/render-newspaper.js';
import { buildCss, DEFAULT_STYLE, fontLinks } from '../../../src/newspaper/newspaper-style.js';
import { doorbellScript } from '../../../src/newspaper/follow-chip.js';
import type { IssueData } from '../../../src/newspaper/issue.js';
import { issue, item } from './_issue-fixture.js';

const EDIT: NewspaperEdit = {
  masthead: '云舟江湖报',
  items: { '1': { h: '猎鹰落回了发射台', s: '第一段。' }, '2': { h: '次条', s: 'b' } },
};

type Opts = Parameters<typeof renderNewspaper>[4];

const render = (opts: Opts = {}, i: IssueData = issue()): string =>
  renderNewspaper(i, EDIT, DEFAULT_STYLE, 'zh-CN', opts).html;

/** Every tag of one kind on the page, whole. */
const tags = (html: string, name: string): string[] => html.match(new RegExp(`<${name}\\b[^>]*>`, 'g')) ?? [];

/**
 * An issue the way a local-only owner has it: no popclaw web app, so no profile
 * or post-page links, and a picture from the platform the post came from.
 */
const unpublished = (): IssueData =>
  issue({
    pulse: [
      item({
        tier: 'card',
        profileUrl: '',
        postPageUrl: '',
        platformProfileUrl: 'https://x.com/levelsio',
        media: ['https://pbs.twimg.com/media/x.jpg'],
      }),
      item({ author: 'b', handle: 'b', sigil: 'zz', profileUrl: '', postPageUrl: '', url: 'https://x.com/b/status/2' }),
    ],
  });

describe('the local page sends no referrer', () => {
  it('declares no-referrer in the head, which is what covers the font files the CSS goes for', () => {
    expect(render()).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('puts referrerpolicy on every img and every stylesheet link, element by element', () => {
    const html = render({}, unpublished());
    const emitted = [...tags(html, 'img'), ...tags(html, 'link')];
    expect(emitted.length).toBeGreaterThan(2);
    for (const t of emitted) expect(t).toContain('referrerpolicy="no-referrer"');
  });

  it('keeps the cards\' outbound links from handing the opener a window', () => {
    for (const t of tags(render({}, unpublished()), 'a')) {
      if (/href="https?:/.test(t)) expect(t).toMatch(/rel="noopener noreferrer"/);
    }
  });
});

describe('no URL carries the issue\'s own words', () => {
  it('asks for the masthead face by family, never by the characters of the masthead', () => {
    for (const l of fontLinks('zh-CN', DEFAULT_STYLE, '云舟江湖报')) expect(l).not.toContain('text=');
    for (const l of fontLinks('en', DEFAULT_STYLE, 'The Cloudboat Chronicle')) expect(l).not.toContain('text=');
  });

  it('emits no text= anywhere on the finished page, in either language', () => {
    expect(render()).not.toContain('text=');
    expect(renderNewspaper(issue({ language: 'en-US' }), EDIT, DEFAULT_STYLE, 'en').html).not.toContain('text=');
  });
});

describe('newspaper.fonts', () => {
  it('links the font stylesheets by default — the local page looks like the hosted one', () => {
    expect(tags(render(), 'link').length).toBeGreaterThan(0);
  });

  it('links nothing at all on "system"', () => {
    const html = render({ fonts: 'system' });
    expect(html).not.toContain('<link');
    expect(html).not.toContain('fonts.googleapis.com');
  });

  it('falls back to a CJK face and a serif Latin face, so a page with no fonts still sets', () => {
    const CJK = /PingFang SC|Noto Sans CJK|Microsoft YaHei|Songti SC|Noto Serif SC|Kaiti SC/;
    const LATIN = /Georgia|Times New Roman|serif/;
    for (const bodyFont of ['huiwen', 'lxgw', 'garamond', 'system'] as const) {
      const css = buildCss('zh-CN', { ...DEFAULT_STYLE, bodyFont });
      for (const stack of css.match(/--(?:serif|disp|kai|masthead):[^;\n]+/g) ?? []) {
        expect(stack).toMatch(CJK);
        expect(stack).toMatch(LATIN);
      }
    }
    expect(buildCss('en', DEFAULT_STYLE)).toMatch(/--serif:[^;\n]*(?:Georgia|serif)/);
  });
});

describe('newspaper.avatars', () => {
  it('leaves the remote face for publish to bake in, by default', () => {
    expect(render()).toContain('https://unavatar.io/');
  });

  it('draws every face itself on "off" — no fetch, no third party, no gap', () => {
    const html = render({ avatars: 'off' }, unpublished());
    expect(html).not.toContain('unavatar.io');
    for (const t of tags(html, 'img')) {
      if (/class="fig"/.test(t)) continue; // a post's own picture, not a face
      expect(t).toMatch(/src="data:image\/svg\+xml;base64,/);
    }
  });
});

describe('the doorbell gate', () => {
  it('rings by default — callers that say nothing keep the chips and the script', () => {
    const html = render();
    expect(html).toContain('<script');
    expect(html).toContain('follow-btn');
  });

  it('emits no script and no chip when the publisher is off', () => {
    const html = render({ doorbell: false }, unpublished());
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-followee');
    expect(html).not.toContain('follow-intent');
  });

  it('goes inert on a file:// page before it can throw or fetch', () => {
    const s = doorbellScript({
      cta: 'c', sent: 's', exists: 'e', fail: 'f', followed: 'd', pairFirst: 'p',
      stripOwner: 'o', stripGuest: 'g', loginPrompt: 'l', pairHint: 'h',
    });
    expect(s).toContain(`'null'`);
    const guard = s.indexOf('LOCAL_FILE');
    expect(guard).toBeGreaterThan(-1);
    // Before the first thing that could throw (a postMessage to a "null" target)
    // and before the first thing that could reach the network.
    expect(guard).toBeLessThan(s.indexOf('window.parent.postMessage('));
    expect(guard).toBeLessThan(s.indexOf('fetch(SELF'));
  });
});

describe('what a local file may still reach for', () => {
  it('names every host on the page, and no popclaw service is among them', () => {
    const html = render({ avatars: 'off', doorbell: false }, unpublished());
    const hosts = new Set([...html.matchAll(/https?:\/\/([^/"'\s<>]+)/g)].map((m) => m[1]!));
    expect([...hosts].sort()).toEqual([
      'cdn.jsdelivr.net',
      'fonts.googleapis.com',
      'fontsapi.zeoseven.com',
      'pbs.twimg.com',
      'x.com',
    ]);
    for (const forbidden of ['popclaw.me', 'canvas.popclaw.me', 'unavatar.io']) {
      expect(html).not.toContain(forbidden);
    }
  });
});
