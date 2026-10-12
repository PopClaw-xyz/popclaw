import { describe, it, expect } from 'vitest';
import {
  buildArrivalBriefing,
  buildPassportBriefing,
  buildLanternBriefing,
  buildAttuneBriefing,
  buildErrandBriefing,
  buildCadenceBriefing,
  buildGraduationBriefing,
  renderBriefingForAgent,
  renderBriefingForUser,
  type StageBriefing,
} from '../../../src/onboarding/briefing.js';

const VERBATIM = 'Read canvas links and item numbers out exactly as given — not one character changed.';

const ALL: StageBriefing[] = [
  buildArrivalBriefing({ candidates: ['白驹'], blind: false }),
  buildPassportBriefing({
    nickname: '白驹',
    sigil: 'ABCD1234',
    profileUrl: 'https://popclaw.me/%E7%99%BD%E9%A9%B9/ABCD1234',
    stamps: [{ houseName: '灯坊甲', ok: true }],
    canvasUrl: 'https://canvas.example/p/1',
  }),
  buildLanternBriefing({
    houseLines: ['灯坊甲'],
    entryLines: ['1. [某人] 一句话'],
    canvasUrl: 'https://canvas.example/p/2',
    quiet: false,
  }),
  buildAttuneBriefing({}),
  buildErrandBriefing({}),
  buildCadenceBriefing(),
];

describe('六幕 briefing 的共同硬规矩', () => {
  it('每一幕的 voice 都挂着「原样念出」那一句（spec §6）', () => {
    for (const b of ALL) expect(b.voice.endsWith(VERBATIM)).toBe(true);
  });

  it('毕业简报同样挂着它', () => {
    const g = buildGraduationBriefing({
      nickname: '白驹', sigil: 'ABCD1234',
      profileUrl: 'https://popclaw.me/x/ABCD1234',
      done: [], gaps: [], phrasebook: [], houseGuides: [],
    });
    expect(g.voice.endsWith(VERBATIM)).toBe(true);
  });

  it('没有一幕泄露 /popclaw next|skip 导航语法', () => {
    for (const b of ALL) {
      const all = `${b.intent}\n${b.material ?? ''}\n${b.voice}`;
      expect(all).not.toContain('/popclaw next');
      expect(all).not.toContain('/popclaw skip');
    }
  });

  it('stage 标识与幕对得上', () => {
    expect(ALL.map((b) => b.stage)).toEqual([
      'arrival', 'passport', 'lantern', 'attune', 'errand', 'cadence',
    ]);
  });
});

describe('buildArrivalBriefing', () => {
  it('一句定位讲清"agent 替你社交 + 数据在你自己机器上"，且不讲灯坊概念', () => {
    const b = buildArrivalBriefing({ candidates: ['白驹', '拾光客'], blind: false });
    expect(b.intent).toContain('does the socializing');
    expect(b.intent).toContain("on the owner's own machine");
    expect(b.intent).not.toContain('lore-house');
  });

  it('候选带编号进 material', () => {
    const b = buildArrivalBriefing({ candidates: ['白驹', '拾光客'], blind: false });
    expect(b.material).toContain('1. 白驹');
    expect(b.material).toContain('2. 拾光客');
  });

  it('无材料 → 如实说不了解主人（诚实基因）', () => {
    const b = buildArrivalBriefing({ candidates: ['夜行客'], blind: true });
    expect(b.intent).toContain("I don't know you well yet");
  });
});

describe('buildPassportBriefing', () => {
  it('讲"私钥签出、坊只盖章"，不提认证', () => {
    const b = ALL[1]!;
    expect(b.intent).toContain('private key on');
    expect(b.intent).toContain('all they did was recognize it');
    // Verification never appears in this scene; it moved to errand, triggered by an actual consequence.
    expect(b.voice).toContain('Do not bring up verification');
    expect(b.intent).not.toContain('verif');
  });

  it('落章逐坊；失败照实说', () => {
    const b = buildPassportBriefing({
      nickname: '白驹', sigil: 'ABCD1234',
      profileUrl: 'https://popclaw.me/x/ABCD1234',
      stamps: [{ houseName: '灯坊甲', ok: true }, { houseName: '灯坊乙', ok: false }],
    });
    expect(b.material).toContain('灯坊甲 ✓ stamped');
    expect(b.material).toContain("灯坊乙 ✗ couldn't reach it");
  });

  it('画布够不着 → 只少链接行，文字一字不减', () => {
    const withUrl = ALL[1]!;
    const without = buildPassportBriefing({
      nickname: '白驹', sigil: 'ABCD1234',
      profileUrl: 'https://popclaw.me/x/ABCD1234',
      stamps: [{ houseName: '灯坊甲', ok: true }],
      canvasUrl: null,
    });
    expect(withUrl.material).toContain('Passport page: https://canvas.example/p/1');
    expect(without.material).not.toContain('Passport page');
    expect(without.material).toContain('白驹#ABCD1234');
    expect(without.material).toContain('Home page:');
  });
});

describe('buildLanternBriefing', () => {
  it('点透"一座灯坊是一盏灯"，并请主人报编号/标一下/无感', () => {
    const b = ALL[2]!;
    expect(b.intent).toContain('a lore-house is one lamp, not the whole world');
    expect(b.intent).toContain('a number to open one');
    expect(b.intent).toContain('"mark it"');
    expect(b.intent).toContain('"not for me"');
  });

  it('人少如实说，绝不"精选/热门"包装', () => {
    const b = buildLanternBriefing({
      houseLines: ['灯坊甲'], entryLines: [], canvasUrl: null, quiet: true,
    });
    expect(b.intent).toContain("It's pretty quiet here right now");
    expect(b.intent).toContain("That's what early days look like");
    // Curated/popular wording appears only as a prohibition, never as permission for agent promotion.
    expect(b.intent).toContain("Don't dress up an empty room");
  });

  it('空栏目整段省略', () => {
    const b = buildLanternBriefing({
      houseLines: [], entryLines: [], canvasUrl: null, quiet: true,
    });
    expect(b.material ?? '').not.toContain('Well known here');
    expect(b.material ?? '').not.toContain('Most talked about');
    expect(b.material ?? '').not.toContain('mirror accounts');
  });
});

describe('buildAttuneBriefing', () => {
  it('问的那一版：一句话 + 只进本机 + 不追问', () => {
    const b = buildAttuneBriefing({});
    expect(b.intent).toContain('what are you into lately');
    expect(b.intent).toContain('nothing leaves');
    expect(b.intent).toContain('let it go');
  });

  it('答后那一版：原第 N 条标注 + 热度≠关心 + 可随时「调内容」', () => {
    const b = buildAttuneBriefing({
      tasteText: '常看 AI 论文',
      rerankedLines: ['1. （原第 2 条）[alix] …'],
    });
    expect(b.intent).toContain('(was #N)');
    expect(b.intent).toContain('loud is not the same');
    expect(b.intent).toContain('change what you bring me');
    expect(b.material).toContain('常看 AI 论文');
    expect(b.material).toContain('原第 2 条');
  });
});

describe('buildErrandBriefing', () => {
  it('邀请说人话，且明说不要二次确认', () => {
    const b = buildErrandBriefing({ peopleLines: ['1. mrbeast'] });
    expect(b.intent).toContain("anyone above they'd like to follow");
    expect(b.intent).toContain('or just a number');
    expect(b.voice).toContain('do not ask them to confirm twice');
    expect(b.material).toContain('1. mrbeast');
  });
});

describe('buildCadenceBriefing / buildGraduationBriefing', () => {
  it('cadence 只问一次，两个选项', () => {
    const b = buildCadenceBriefing();
    expect(b.intent).toContain('1 yes');
    expect(b.intent).toContain('2 no');
  });

  // The question must give a specific time (the current time or 08:00),
  // not a vague tomorrow morning, so the owner can accept or change it.
  it('问句报出具体时刻，并明说可以改成别的点', () => {
    const b = buildCadenceBriefing('en', 21);
    expect(b.intent).toContain('21:00');
    expect(b.intent.toLowerCase()).toContain('another time');
  });

  // After agreement, graduation copy must pass that time to the agent, which schedules cron.
  // If the time does not reach it, the owner's choice has no effect.
  it('毕业指示把选定时刻带进排 cron 的那句话', () => {
    const g = buildGraduationBriefing({
      nickname: '白驹', sigil: 'ABCD1234',
      profileUrl: 'u', newspaper: 'daily', newspaperHour: 21,
      done: [], gaps: [], phrasebook: [], houseGuides: [],
    });
    expect(g.intent).toContain('21:00');
    expect(g.intent).toContain('popclaw-newspaper');
  });

  it('答 1 → 指示 agent 自己排 cron，具名任务且关投递', () => {
    const g = buildGraduationBriefing({
      nickname: '白驹', sigil: 'ABCD1234',
      profileUrl: 'u', newspaper: 'daily',
      done: [], gaps: [], phrasebook: [], houseGuides: [],
    });
    expect(g.intent).toContain('popclaw-newspaper');
    expect(g.intent).toContain('switch off result delivery');
    // Scheduling it is only half — the agent must also
    // hand the owner the taste loop and the on-demand escape hatch.
    expect(g.intent).toContain('the better the paper fits them');
    expect(g.intent).toContain('ask any time');
  });

  it('答 2 → 明确拒绝，以后不再轻推晨报', () => {
    const g = buildGraduationBriefing({
      nickname: '白驹', sigil: 'ABCD1234',
      profileUrl: 'u', newspaper: 'declined',
      done: [], gaps: [], phrasebook: [], houseGuides: [],
    });
    expect(g.intent).toContain("don't nudge the morning paper again");
  });

  it('攻略：指令是渲 HTML + popclaw_canvas(72h)，四块框架 + 只列真做过的', () => {
    const g = buildGraduationBriefing({
      nickname: '白驹', sigil: 'ABCD1234',
      profileUrl: 'https://popclaw.me/x/ABCD1234',
      tasteText: '常看 AI 论文',
      done: ['关注了 mrbeast#AAAA1111'],
      gaps: ['还没认证'],
      phrasebook: ['"what is going on out there today" → I go and look'],
      houseGuides: [{ houseName: '灯坊甲', excerpt: 'how it works here' }],
    });
    expect(g.intent).toContain('popclaw_canvas');
    expect(g.intent).toContain('ttl_hours 72');
    expect(g.intent).toContain('only what actually happened this run');
    expect(g.intent).toContain("Lore-houses they're not on get zero words");
    // material itself is a directly readable list: fallback requires the list outside the 72h link too.
    expect(g.material).toContain('关注了 mrbeast#AAAA1111');
    expect(g.material).toContain('还没认证');
    expect(g.material).toContain('常看 AI 论文');
    expect(g.material).toContain('How 灯坊甲 works');
  });

  it('攻略：五块框架，第⑤块是备份叮嘱——丢了没人能找回', () => {
    const g = buildGraduationBriefing({
      nickname: '白驹', sigil: 'ABCD1234',
      profileUrl: 'https://popclaw.me/x/ABCD1234',
      done: [], gaps: [], phrasebook: [], houseGuides: [],
    });
    expect(g.intent).toContain('⑤');
    expect(g.intent).toContain('backup warning');
    expect(g.intent).toContain('is never optional');
    expect(g.material).toContain('vault/');
    expect(g.material).toContain('Back up the whole vault/ folder');
  });
});

describe('渲染', () => {
  it('agent 版带叙述框架 + 素材 + 语气', () => {
    const out = renderBriefingForAgent(ALL[2]!);
    expect(out).toContain('[settling-in · lantern]');
    expect(out).toContain('Intent: ');
    expect(out).toContain('Material:');
    expect(out).toContain('Voice: ');
  });

  it('user 版只有 intent + material（voice 丢掉）—— 这里是 en 车道的主人', () => {
    const out = renderBriefingForUser(ALL[2]!);
    expect(out).toContain('a lore-house is one lamp');
    expect(out).toContain('1. [某人] 一句话');
    expect(out).not.toContain(VERBATIM);
  });

  it('没有 material 时 user 版就是 intent 本身', () => {
    const b = buildAttuneBriefing({});
    expect(renderBriefingForUser(b)).toBe(b.intent);
  });
});

/**
 * S5: the same act, two readers. `renderBriefingForAgent` gets the English
 * source (the agent translates via `languageDirective`); `briefingCard` gets
 * the owner's own lane and goes straight to them, no agent in between. The
 * zh values are the text that was on the wire before S5 (af525e74) — restored
 * byte for byte, not re-translated.
 */
describe('两个读者，两条车道', () => {
  const zh = (b: StageBriefing): string => renderBriefingForUser(b);

  it('zh 车道：主人读到的就是上过线的中文原文', () => {
    const arrival = buildArrivalBriefing(
      { candidates: ['白驹'], blind: false },
      'zh-CN',
    );
    expect(zh(arrival)).toContain('先用一句话说清这里是什么');
    expect(zh(arrival)).toContain('名号候选：');
    expect(zh(arrival)).not.toContain('does the socializing');
  });

  it('en 车道：一字不差还是英文源', () => {
    const arrival = buildArrivalBriefing(
      { candidates: ['白驹'], blind: false },
      'en',
    );
    expect(zh(arrival)).toContain('does the socializing');
    expect(zh(arrival)).toContain('Name candidates:');
  });

  it('条件片段跟着车道走，不会一半中文一半英文', () => {
    const b = buildPassportBriefing(
      {
        nickname: '白驹',
        sigil: 'ABCD1234',
        profileUrl: 'https://popclaw.me/x/ABCD1234',
        stamps: [{ houseName: '灯坊甲', ok: true }, { houseName: '灯坊乙', ok: false }],
        canvasUrl: 'https://canvas.example/p/1',
        doorLines: ['灯坊甲 · 说话', '灯坊乙 · 旅行'],
      },
      'zh-CN',
    );
    const all = `${b.intent}\n${b.material ?? ''}`;
    expect(all).toContain('把护照页的链接给主人。'); // canvasUrl branch.
    expect(all).toContain('两扇门'); // Say this only with two doors.
    expect(all).toContain('灯坊甲 ✓ 已盖章');
    expect(all).toContain('灯坊乙 ✗ 网络不通');
    expect(all).toContain('护照页：');
    expect(all).not.toMatch(/stamped|Passport page|two doors/);
  });

  it('毕业幕素材整份跟着车道走（报纸那一句也是）', () => {
    const g = buildGraduationBriefing(
      {
        nickname: '白驹', sigil: 'ABCD1234',
        profileUrl: 'u', newspaper: 'daily',
        done: ['定了名号「白驹」'], gaps: ['还没认证'], phrasebook: ['「标一下」→ 记进口味档案'],
        houseGuides: [{ houseName: '灯坊甲', excerpt: '说人话就行' }],
      },
      'zh-CN',
    );
    expect(g.intent).toContain('给主人一句毕业词');
    expect(g.intent).toContain('报纸：每天 08:00 送');
    expect(g.material).toContain('这一趟真做过的：');
    expect(g.material).toContain('灯坊甲 怎么玩：');
    expect(g.material).toContain('身份文件：'); // Never omit the backup reminder.
    expect(g.material).not.toContain('Actually done on this run');
  });

  it('语气只给 agent：中文车道下也不进主人那一面', () => {
    const b = buildCadenceBriefing('zh-CN');
    expect(b.voice.endsWith(VERBATIM)).toBe(true);
    expect(renderBriefingForUser(b)).not.toContain(VERBATIM);
  });
});
