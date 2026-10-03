import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  newspaperRulesOutdated,
  readNewspaperContentRules,
  readNewspaperStyle,
  retiredLayoutRules,
} from '../../../src/newspaper/newspaper-files.js';
import { DEFAULT_CONTENT_EN } from '../../../src/newspaper/newspaper-files-en.js';
import { DEFAULT_STYLE, fontLinks } from '../../../src/newspaper/newspaper-style.js';
import { FONT_STYLESHEETS } from '../../../src/newspaper/font-stylesheets.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

const VERSION = 'v11';

let dir: string;
const content = (): string => join(dir, 'content.md');
const seed = (): Record<string, { lang: string; templateVersion: string; sha256: string }> =>
  JSON.parse(readFileSync(join(dir, '.seed'), 'utf-8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-newspaper-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setOwnerLang(undefined); // process-wide singleton — leave it as we found it
});

describe('seeding by owner language', () => {
  it('seeds the English codex for an English owner', () => {
    setOwnerLang('en-US');
    expect(readNewspaperContentRules(dir)).toBe(DEFAULT_CONTENT_EN);
    expect(readFileSync(content(), 'utf-8')).toBe(DEFAULT_CONTENT_EN);
    expect(seed()['content.md']!.lang).toBe('en');
  });

  it('seeds the Chinese codex for a Chinese owner', () => {
    setOwnerLang('zh-CN');
    const zh = readNewspaperContentRules(dir);
    expect(zh).not.toBe(DEFAULT_CONTENT_EN);
    expect(zh).toContain('忠实');
    expect(seed()['content.md']!.lang).toBe('zh-CN');
  });

  it('never overwrites a file that was already on disk before stamps existed', () => {
    writeFileSync(content(), 'my own rules', 'utf-8'); // pre-stamp install
    setOwnerLang('en-US');
    expect(readNewspaperContentRules(dir)).toBe('my own rules');
    expect(readFileSync(content(), 'utf-8')).toBe('my own rules');
    expect(newspaperRulesOutdated(dir)).toEqual([]); // no stamp ⇒ nothing to say
  });
});

describe('seed stamp — the three branches', () => {
  it('unedited + language changed → silently reseeds', () => {
    setOwnerLang('zh-CN');
    readNewspaperContentRules(dir);
    setOwnerLang(undefined);
    setOwnerLang('en-US');
    expect(readNewspaperContentRules(dir)).toBe(DEFAULT_CONTENT_EN);
    expect(readFileSync(content(), 'utf-8')).toBe(DEFAULT_CONTENT_EN);
    expect(seed()['content.md']!.lang).toBe('en');
    expect(newspaperRulesOutdated(dir)).toEqual([]);
  });

  it('edited + language changed → leaves it alone and reports it', () => {
    setOwnerLang('zh-CN');
    readNewspaperContentRules(dir);
    writeFileSync(content(), 'the owner rewrote this', 'utf-8');
    setOwnerLang(undefined);
    setOwnerLang('en-US');
    expect(readNewspaperContentRules(dir)).toBe('the owner rewrote this');
    expect(newspaperRulesOutdated(dir)).toEqual(['content.md']);
  });

  it('unedited + nothing changed → leaves it alone, says nothing', () => {
    setOwnerLang('en-US');
    readNewspaperContentRules(dir);
    const before = seed();
    expect(readNewspaperContentRules(dir)).toBe(DEFAULT_CONTENT_EN);
    expect(seed()).toEqual(before);
    expect(newspaperRulesOutdated(dir)).toEqual([]);
  });

  it('edited but nothing changed → says nothing (an edit alone is not drift)', () => {
    setOwnerLang('en-US');
    readNewspaperContentRules(dir);
    writeFileSync(content(), 'tweaked', 'utf-8');
    expect(newspaperRulesOutdated(dir)).toEqual([]);
  });
});

/**
 * 印章机制上线（v5）之前装的机器盘上没有 `.seed`，模板却是我们自己种的 —— 认不出来
 * 就会被当成「主人写的」永久冻住（真机：host-c 2026-07-30 那一版）。指纹表就是为了
 * 认出自家发过的种子。两份 fixture 是从 git 历史里逐字取出来的真种子，别手改。
 */
describe('历史种子指纹：认得出自家发的，就敢重种', () => {
  const fixture = (name: string): string =>
    readFileSync(join(__dirname, '../../fixtures/newspaper-seeds', name), 'utf-8');

  it('zh：无印章 + 内容是 86eb70ef 那一版种子 → 自动重种 + 补印章', () => {
    writeFileSync(content(), fixture('zh-content-86eb70ef.md'), 'utf-8'); // host-c 的处境
    setOwnerLang('zh-CN');
    const got = readNewspaperContentRules(dir);
    expect(got).toContain('版面由 popclaw 排'); // v10 才有的开场白
    expect(readFileSync(content(), 'utf-8')).toBe(got);
    expect(seed()['content.md']).toMatchObject({ lang: 'zh-CN', templateVersion: VERSION });
    expect(newspaperRulesOutdated(dir)).toEqual([]);
  });

  it('en：无印章 + 内容是 37bfad65 那一版英文种子 → 重种成当前英文 codex', () => {
    writeFileSync(content(), fixture('en-content-37bfad65.md'), 'utf-8');
    setOwnerLang('en-US');
    expect(readNewspaperContentRules(dir)).toBe(DEFAULT_CONTENT_EN);
    expect(seed()['content.md']).toMatchObject({ lang: 'en', templateVersion: VERSION });
  });

  it('无印章 + 主人自己写的 → 一个字节不动', () => {
    writeFileSync(content(), '# 我自己的规矩\n\n只写这一行。', 'utf-8');
    setOwnerLang('zh-CN');
    expect(readNewspaperContentRules(dir)).toBe('# 我自己的规矩\n\n只写这一行。');
    expect(existsSync(join(dir, '.seed'))).toBe(false); // 没重种，也就没印章
  });

  it('印章对不上 + 内容是旧种子（被旧包盖回去） → 不报「待处理」，下次读自动修好', () => {
    setOwnerLang('zh-CN');
    readNewspaperContentRules(dir);
    writeFileSync(content(), fixture('zh-content-86eb70ef.md'), 'utf-8');
    setOwnerLang(undefined);
    setOwnerLang('en-US'); // 印章的语言也过期了 —— 旧逻辑到这里就会报「主人编辑过」
    expect(newspaperRulesOutdated(dir)).toEqual([]);
    expect(readNewspaperContentRules(dir)).toBe(DEFAULT_CONTENT_EN);
  });
});

/** v0.2：content.md 只管文字的分寸，版面归代码 —— 所以法典里不许再出现类名和 HTML。 */
describe('v0.2 的 content codex 只谈写作', () => {
  it('zh：忠实/以人为主角/三档密度/新人小传/teaser 都在，类名与 HTML 一个不留', () => {
    setOwnerLang('zh-CN');
    const c = readNewspaperContentRules(dir);
    for (const kept of ['忠实', '以人为主角', '三档密度', '新人小传', 'teaser', '无虚假人气', '本机首见第 N 天']) {
      expect(c).toContain(kept);
    }
    for (const gone of ['.mantle', '.doorplate', '<a', '类名', 'href', '--paper:']) {
      expect(c).not.toContain(gone);
    }
  });

  it('en: the same rules, in the English codex', () => {
    for (const kept of ['Faithful', 'Person first', 'Three densities', 'New faces', 'teaser', 'No manufactured liveliness']) {
      expect(DEFAULT_CONTENT_EN).toContain(kept);
    }
    for (const gone of ['.mantle', '.doorplate', '<a', 'class name', 'href', '--paper:']) {
      expect(DEFAULT_CONTENT_EN).not.toContain(gone);
    }
  });

  it('两套模板求值后都不带转义残渣（`\\``/`\\$`）', () => {
    setOwnerLang('zh-CN');
    for (const s of [readNewspaperContentRules(dir), DEFAULT_CONTENT_EN]) {
      expect(s).not.toContain('\\`');
      expect(s).not.toContain('\\$');
    }
  });
});

/** v0.2 的版式旋钮：种下去、读得回、改了必然生效。 */
describe('style.json —— 主人手里那把旋钮', () => {
  it('第一次读就把 style.json 与它的说明书一起种下，值是发布默认值', () => {
    setOwnerLang('zh-CN');
    const { style, notes } = readNewspaperStyle(dir);
    expect(style).toEqual(DEFAULT_STYLE);
    expect(notes).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'style.json'), 'utf-8'))).toEqual(DEFAULT_STYLE);
    expect(readFileSync(join(dir, 'style.README.md'), 'utf-8')).toContain('必然');
    expect(seed()['style.json']).toMatchObject({ templateVersion: VERSION });
  });

  it('主人改过的值照他的来 —— 这就是「改了必然生效」', () => {
    setOwnerLang('zh-CN');
    readNewspaperStyle(dir);
    writeFileSync(join(dir, 'style.json'), JSON.stringify({ fontScale: 1.3, leadMax: 1, roster: false }), 'utf-8');
    const { style, notes } = readNewspaperStyle(dir);
    expect([style.fontScale, style.leadMax, style.roster]).toEqual([1.3, 1, false]);
    expect(style.accent).toBe(DEFAULT_STYLE.accent); // 没写的键照旧
    expect(notes).toEqual([]);
  });

  it('写坏一个键 → 那一个键回落默认值,并且在回执里点名(绝不整份作废)', () => {
    setOwnerLang('zh-CN');
    readNewspaperStyle(dir);
    writeFileSync(
      join(dir, 'style.json'),
      JSON.stringify({ fontScale: 9, accent: 'red', bodyFont: 'comic', leadMax: 2, wat: 1 }),
      'utf-8',
    );
    const { style, notes } = readNewspaperStyle(dir);
    expect(style.leadMax).toBe(2); // 好的那个照样生效
    expect([style.fontScale, style.accent, style.bodyFont]).toEqual([
      DEFAULT_STYLE.fontScale,
      DEFAULT_STYLE.accent,
      DEFAULT_STYLE.bodyFont,
    ]);
    expect(notes.join('\n')).toContain('fontScale');
    expect(notes.join('\n')).toContain('accent');
    expect(notes.join('\n')).toContain('bodyFont');
    expect(notes.join('\n')).toContain('wat'); // 拼错的键也说一声,省得以为旋钮坏了
  });

  it('JSON 整个坏掉 → 用发布默认值出报纸,但一定说出来', () => {
    setOwnerLang('zh-CN');
    readNewspaperStyle(dir);
    writeFileSync(join(dir, 'style.json'), '{ not json', 'utf-8');
    const { style, notes } = readNewspaperStyle(dir);
    expect(style).toEqual(DEFAULT_STYLE);
    expect(notes.join('\n')).toContain('style.json');
  });
});

/** layout.md 在 v0.2 退休：我们种的那份不吭声，主人改过的那份必须告诉他。 */
describe('layout.md 退休', () => {
  const layout = (): string => join(dir, 'layout.md');
  const fixture = (name: string): string =>
    readFileSync(join(__dirname, '../../fixtures/newspaper-seeds', name), 'utf-8');

  it('盘上没有 layout.md → 什么都不用说', () => {
    expect(retiredLayoutRules(dir)).toBe(false);
  });

  it('盘上那份是我们自己种的 → 不吭声(他从没写过它)', () => {
    writeFileSync(layout(), fixture('zh-layout-v9.md'), 'utf-8');
    expect(retiredLayoutRules(dir)).toBe(false);
  });

  it('主人自己改过 → 必须报出来:那些改动从今天起不再生效', () => {
    writeFileSync(layout(), '# 我自己调的版式\n\n卡片再宽一点。', 'utf-8');
    expect(retiredLayoutRules(dir)).toBe(true);
    // 但它仍旧躺在盘上,一个字节不动(P-006:主人的东西不销毁)
    expect(readFileSync(layout(), 'utf-8')).toContain('我自己调的版式');
  });

  it('不再混进「模板过期」那张单子 —— 那张单子是给还在用的文件的', () => {
    setOwnerLang('zh-CN');
    readNewspaperContentRules(dir);
    writeFileSync(layout(), '# 我自己调的版式', 'utf-8');
    expect(newspaperRulesOutdated(dir)).toEqual([]);
  });
});

/**
 * Both codices interpolate `FONT_STYLESHEETS` and F2's allowlist is computed
 * from the same table, so the three cannot drift by hand any more. What is left
 * to guard is a *new* link typed straight into a codex, and the URL values
 * themselves — a typo in the table silently loses a font on every machine.
 */
describe('字体单表：URL 只此一份', () => {
  it('页面链的每一条都出自这张表(报头那条按报名裁剪,不是常量)', () => {
    const links = fontLinks('zh-CN', DEFAULT_STYLE, '云舟江湖报');
    const known = new Set(Object.values(FONT_STYLESHEETS));
    for (const l of links) {
      expect(known.has(l as never) || l.includes('&text=')).toBe(true);
    }
    expect(links).toContain(FONT_STYLESHEETS.kingHwaOldSong);
  });

  it('正文换成系统字就不再拉汇文明朝 —— 页面不设的字不该占一次往返', () => {
    const off = fontLinks('zh-CN', { ...DEFAULT_STYLE, bodyFont: 'system' }, 'x');
    expect(off).not.toContain(FONT_STYLESHEETS.huiwenMincho);
    expect(fontLinks('zh-CN', DEFAULT_STYLE, 'x')).toContain(FONT_STYLESHEETS.huiwenMincho);
  });
});
