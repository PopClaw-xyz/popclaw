/**
 * Onboarding Canvas 模板页单测（spec 2026-07-29 Plan C §3、§8）。
 * 硬规则先测：viewport / 零外链 / ≤2MB / 朱红只属护照 / 用户内容转义。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  renderPassportPage,
  renderLanternPage,
  uploadOnboardingPage,
  type PassportPageInput,
  type LanternPageInput,
  type OnboardingCanvasDeps,
} from '../../../src/onboarding/canvas-pages.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S5: both pages are plugin-rendered in the owner's language. The bulk of this
// file is the zh-CN lane (the wording these assertions were written against);
// the English lane gets its own block at the end. Structural rules (escaping,
// no external assets, caps) are language-agnostic and hold in either.
setOwnerLang('zh-CN', 'config');
beforeEach(() => setOwnerLang('zh-CN', 'config'));
afterAll(() => setOwnerLang(undefined));

const PASSPORT: PassportPageInput = {
  nickname: '青衫客',
  sigil: 'K7M2QX4B',
  profileUrl: 'https://popclaw.me/青衫客/K7M2QX4B',
  issuedDate: '2026 年 7 月 29 日',
  stamps: [
    { houseName: 'popclaw.me', ok: true },
    { houseName: 'popclaw.world', ok: false },
  ],
  verifiedHandles: [{ platform: 'x', handle: 'qingshan' }],
  doors: [
    {
      houseName: '灯坊甲',
      knowsYou: true,
      blurb: '自由说话的巨型社交广场',
      headline: '看世界流、认几个人、发第一条',
      homeUrl: 'https://house-a.test/feed',
      firstMove: '帮我找几个人关注',
    },
    { houseName: '灯坊乙', knowsYou: false, blurb: '走出去看看的地方' },
  ],
};

const LANTERN: LanternPageInput = {
  statLine: '江湖：56 位身份 · 8 个认证账号 · 原生帖 7',
  notables: Array.from({ length: 6 }, (_, i) => ({
    name: `名人${i + 1}`,
    story: `来历第 ${i + 1} 行`,
  })),
  posts: Array.from({ length: 9 }, (_, i) => ({
    n: i + 1,
    author: `作者${i + 1}`,
    preview: `正文预览 ${i + 1}`,
    replyCount: i,
    sourceUrl: 'https://popclaw.me/post/abcdef1234',
  })),
  mirrors: Array.from({ length: 4 }, (_, i) => ({
    name: `镜像${i + 1}`,
    note: '活跃于 X/IG',
    sourceUrl: 'https://x.com/somebody/status/1',
  })),
};

const PAGES = {
  passport: renderPassportPage(PASSPORT),
  lantern: renderLanternPage(LANTERN),
};

describe('通用硬规则（spec §3 / §8 三断言）', () => {
  for (const [name, html] of Object.entries(PAGES)) {
    it(`${name}：带 viewport meta`, () => {
      expect(html).toContain('<meta name="viewport"');
      expect(html).toContain('width=device-width');
    });

    it(`${name}：无外部 script / link / iframe / 表单`, () => {
      expect(html).not.toContain('<script src="http');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<link');
      expect(html).not.toContain('<iframe');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<input');
    });

    it(`${name}：字节数 < 2MB`, () => {
      expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(2 * 1024 * 1024);
    });

    it(`${name}：页脚说清这页会过期、能重出`, () => {
      expect(html).toContain('过期跟我说一声我重出');
    });
  }

  it('护照页不再说"当日有效"（TTL 72h，R1 spec §2）', () => {
    expect(PAGES.passport).not.toContain('当日有效');
    expect(PAGES.passport).toContain('想给谁看，发主页链接（永久有效）');
  });

  it('江湖一瞥仍是当日有效（它说的是"现在"）', () => {
    expect(PAGES.lantern).toContain('这页当日有效，过期跟我说一声我重出');
  });
});

describe('朱红专属护照（spec §3.1 / §3.2）', () => {
  it('护照页有朱红方印，印信 8 字符在里面', () => {
    expect(PAGES.passport).toContain('#D7301F');
    expect(PAGES.passport).toContain('class="seal"');
    expect(PAGES.passport).toContain('K7M2QX4B');
  });

  it('江湖一瞥零朱红，用琥珀', () => {
    expect(PAGES.lantern.toUpperCase()).not.toContain('D7301F');
    expect(PAGES.lantern).toContain('#BA7114');
  });
});

describe('转义（名号与预览是用户内容）', () => {
  it('注入 <script> 的名号被转义，不产生真标签', () => {
    const html = renderPassportPage({
      ...PASSPORT,
      nickname: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('帖子预览里的尖括号与引号被转义', () => {
    const html = renderLanternPage({
      ...LANTERN,
      posts: [{ n: 1, author: '"><img>', preview: '<b>bold</b>', replyCount: 0 }],
    });
    expect(html).not.toContain('<img>');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('非 http(s) 的源链接不渲染成 <a>', () => {
    const html = renderLanternPage({
      ...LANTERN,
      posts: [{ n: 1, author: 'a', preview: 'p', replyCount: 0, sourceUrl: 'javascript:alert(1)' }],
      mirrors: [],
    });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('查看原文');
    expect(html).not.toContain('view original');
  });
});

describe('renderPassportPage', () => {
  it('逐坊落章：成功 ✓ / 失败 ✗ 如实报', () => {
    expect(PAGES.passport).toContain('popclaw.me');
    expect(PAGES.passport).toContain('已盖章 ✓');
    expect(PAGES.passport).toContain('popclaw.world');
    expect(PAGES.passport).toContain('✗');
  });

  it('私钥断言 + 主页 URL 可点', () => {
    expect(PAGES.passport).toContain('本机的私钥签出来的');
    expect(PAGES.passport).toContain('href="https://popclaw.me/');
  });

  it('单坊 → 降级文案；多坊 → 不出现', () => {
    const solo = renderPassportPage({ ...PASSPORT, stamps: [{ houseName: 'popclaw.me', ok: true }] });
    expect(solo).toContain('以后你每挂一座灯坊，它就自动送一份过去');
    expect(PAGES.passport).not.toContain('以后你每挂一座灯坊');
  });

  it('不放进度元素 / 未认证字样', () => {
    expect(PAGES.passport).not.toContain('未认证');
    expect(PAGES.passport).not.toContain('完成度');
  });

  it('无认证账号 → 整段隐藏', () => {
    const html = renderPassportPage({ ...PASSPORT, verifiedHandles: [] });
    expect(html).not.toContain('认 证 账 号');
  });

  it('印信小课 2 行（R1 spec §2：3→2）', () => {
    expect(PAGES.passport.match(/class="lesson"/g) ?? []).toHaveLength(2);
  });
});

describe('renderPassportPage — 你能去哪（R1 spec §2）', () => {
  it('有 entry 的坊：自述 + ▸headline + 门按钮 + 第一件事', () => {
    expect(PAGES.passport).toContain('你 能 去 哪');
    expect(PAGES.passport).toContain('▸ 看世界流、认几个人、发第一条');
    expect(PAGES.passport).toContain('进 灯坊甲 →');
    expect(PAGES.passport).toContain('第一件事：对我说「帮我找几个人关注」');
  });

  it('门按钮是 target=_blank rel="noopener noreferrer" 的 <a>', () => {
    expect(PAGES.passport).toContain(
      '<a href="https://house-a.test/feed" target="_blank" rel="noopener noreferrer">进 灯坊甲 →</a>',
    );
  });

  it('零声明的坊只渲前两行——没有 ▸ / 没有门 / 没有第一件事', () => {
    const html = renderPassportPage({
      ...PASSPORT,
      doors: [{ houseName: '灯坊乙', knowsYou: false, blurb: '走出去看看的地方' }],
    });
    expect(html).toContain('灯坊乙');
    expect(html).toContain('走出去看看的地方');
    expect(html).not.toContain('▸');
    expect(html).not.toContain('进 灯坊乙 →');
    expect(html).not.toContain('第一件事');
  });

  it('非 http(s) 的门丢弃，不渲成链接', () => {
    const html = renderPassportPage({
      ...PASSPORT,
      doors: [{ houseName: '灯坊丙', knowsYou: true, homeUrl: 'javascript:alert(1)' }],
    });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('进 灯坊丙 →');
  });

  it('坊名与 headline 是坊给的字，一律转义', () => {
    const html = renderPassportPage({
      ...PASSPORT,
      doors: [
        {
          houseName: '<img src=x>',
          knowsYou: true,
          headline: '<b>标题</b>',
          firstMove: '"><script>',
          homeUrl: 'https://h.test/',
        },
      ],
    });
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<b>标题</b>');
    expect(html).toContain('&lt;img src=x&gt;');
  });

  it('没门卡 → 整节隐藏（护照页其余部分一字不变）', () => {
    expect(renderPassportPage({ ...PASSPORT, doors: [] })).not.toContain('你 能 去 哪');
  });
});

describe('renderLanternPage', () => {
  it('坊卡节已删（搬去护照页「你能去哪」，R1 spec §2）', () => {
    expect(PAGES.lantern).not.toContain('有你的名帖 ✓');
    expect(PAGES.lantern).not.toContain('class="house"');
    // 一句话点透还在：它讲的是江湖有多大，不是某座坊的介绍。
    expect(PAGES.lantern).toContain('一座灯坊是一盏灯，不是整个江湖。');
  });

  it('真实统计行照抄，绝不包装成"精选/热门"', () => {
    expect(PAGES.lantern).toContain('江湖：56 位身份 · 8 个认证账号 · 原生帖 7');
    expect(PAGES.lantern).not.toContain('精选');
    expect(PAGES.lantern).not.toContain('热门');
  });

  it('大名鼎鼎 ≤5、精华 ≤8、镜像号 ≤3', () => {
    expect(PAGES.lantern).toContain('名人5');
    expect(PAGES.lantern).not.toContain('名人6');
    expect(PAGES.lantern).toContain('作者8');
    expect(PAGES.lantern).not.toContain('作者9');
    expect(PAGES.lantern).toContain('镜像3');
    expect(PAGES.lantern).not.toContain('镜像4');
  });

  it('帖子行只有 ⟨N 回⟩，永远没有 ♡ ↻ ⭐', () => {
    expect(PAGES.lantern).toContain('⟨0 回⟩');
    expect(PAGES.lantern).toContain('⟨7 回⟩');
    for (const glyph of ['♡', '↻', '⭐']) expect(PAGES.lantern).not.toContain(glyph);
  });

  it('编号原样渲染（与聊天框严格一致）', () => {
    const html = renderLanternPage({
      ...LANTERN,
      posts: [{ n: 5, author: 'a', preview: 'p', replyCount: 1 }],
    });
    expect(html).toContain('>5<');
  });

  it('空栏目整块隐藏', () => {
    const html = renderLanternPage({});
    expect(html).not.toContain('大 名 鼎 鼎');
    expect(html).not.toContain('精 华');
    expect(html).not.toContain('镜 像 号');
    expect(html).toContain('江湖一瞥');
  });
});

describe('uploadOnboardingPage', () => {
  const deps = (
    uploadCanvas: OnboardingCanvasDeps['uploadCanvas'],
    logger?: OnboardingCanvasDeps['logger'],
  ): OnboardingCanvasDeps => ({
    uploadCanvas,
    canvasBaseUrl: 'https://canvas.popclaw.me',
    signer: {} as OnboardingCanvasDeps['signer'],
    nickname: '青衫客',
    ...(logger ? { logger } : {}),
  });

  it('成功 → 返回 url，ttlHours 透传', async () => {
    const upload = vi.fn().mockResolvedValue({ url: 'https://canvas.popclaw.me/c/abc' });
    const url = await uploadOnboardingPage(deps(upload), '名帖', PAGES.passport, 24);
    expect(url).toBe('https://canvas.popclaw.me/c/abc');
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ title: '名帖', ttlHours: 24 });
  });

  it('上传抛错 → null，绝不外抛', async () => {
    const warn = vi.fn();
    const upload = vi.fn().mockRejectedValue(new Error('canvas down'));
    await expect(
      uploadOnboardingPage(deps(upload, { warn }), '名帖', PAGES.passport),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('没配发布服务 → null（和画布挂了同形：卡片正文照旧，只少一行链接）', async () => {
    const warn = vi.fn();
    const upload = vi.fn();
    expect(
      await uploadOnboardingPage(
        { ...deps(upload, { warn }), canvasBaseUrl: null },
        '名帖',
        PAGES.passport,
      ),
    ).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('空 HTML → null，不发注定失败的请求', async () => {
    const upload = vi.fn();
    expect(await uploadOnboardingPage(deps(upload), '名帖', '   ')).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('en 车道（源语言）', () => {
  const en = (): { passport: string; lantern: string } => {
    setOwnerLang('en-US', 'config');
    return { passport: renderPassportPage(PASSPORT), lantern: renderLanternPage(LANTERN) };
  };

  it('护照页：落章 / 私钥断言 / 门 / 印信小课全出英文', () => {
    const { passport } = en();
    expect(passport).toContain('stamped ✓');
    expect(passport).toContain('signed by the private key');
    expect(passport).toContain('WHERE YOU CAN GO');
    expect(passport).toContain('Enter 灯坊甲 →');
    expect(passport).toContain('First thing: say &quot;帮我找几个人关注&quot; to me');
    expect(passport).toContain('ABOUT YOUR SIGIL');
  });

  it('江湖一瞥：段标题 / 回应数 / 查看原文 / 页脚全出英文', () => {
    const { lantern } = en();
    expect(lantern).toContain('A look around');
    expect(lantern).toContain('A lore-house is one lamp, not the whole world.');
    expect(lantern).toContain('WELL KNOWN HERE');
    expect(lantern).toContain('⟨7 replies⟩');
    expect(lantern).toContain('↗ view original');
    expect(lantern).toContain('when it expires, say the word');
  });

  it('lang 属性跟着主人走，不再写死 zh-CN', () => {
    const { passport } = en();
    expect(passport).toContain('<html lang="en">');
    setOwnerLang('zh-CN', 'config');
    expect(renderPassportPage(PASSPORT)).toContain('<html lang="zh-CN">');
  });

  it('英文页不夹一个中文字（坊自报的数据除外）', () => {
    const { lantern } = en();
    const chrome = lantern
      .replace(/江湖：56 位身份 · 8 个认证账号 · 原生帖 7/g, '')
      .replace(/名人\d|作者\d|镜像\d|来历第 \d 行|正文预览 \d|活跃于 X\/IG/g, '');
    expect(chrome).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
