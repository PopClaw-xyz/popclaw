import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import type { Gap } from '../../../src/onboarding/settling-gaps.js';
import {
  pickNudge,
  composeTail,
  isExcludedFromNudge,
  readNudgeLedger,
  recordNudgeSent,
  muteNudge,
  GAP_LINE_KEYS,
  type NudgeLedger,
  type NudgeCtx,
} from '../../../src/onboarding/nudge.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang, setOwnerLang } from '../../../src/lexicon/owner-language.js';

afterEach(() => setOwnerLang(undefined));

const NOW = 1_800_000_000;
const GRADUATED_OLD_ENOUGH = NOW - 25 * 3600; // ≥24h ago
const EMPTY_LEDGER: NudgeLedger = { lifetime: 0, strikes: {}, muted: [] };
const CTX_OK: NudgeCtx = { stage: 'completed', graduatedAt: GRADUATED_OLD_ENOUGH };

const GAP_NO_FOLLOWS: Gap = { key: 'no_follows' };
const GAP_NO_TASTE: Gap = { key: 'no_taste' };
const GAP_HOUSE: Gap = {
  key: 'house:house-a:first_move',
  houseName: '灯坊甲',
  houseHeadline: '捏一个你自己的公仔，它替你去旅行',
  houseFirstMove: '带我进世界',
};

describe('pickNudge — 8 道触发闸', () => {
  it('闸①：stage 不是 completed → null', () => {
    expect(pickNudge([GAP_NO_FOLLOWS], EMPTY_LEDGER, NOW, { ...CTX_OK, stage: 'errand' })).toBeNull();
  });

  it('闸②：距毕业不足 24h → null；≥24h → 可以', () => {
    const tooSoon: NudgeCtx = { stage: 'completed', graduatedAt: NOW - 3600 };
    expect(pickNudge([GAP_NO_FOLLOWS], EMPTY_LEDGER, NOW, tooSoon)).toBeNull();
    expect(pickNudge([GAP_NO_FOLLOWS], EMPTY_LEDGER, NOW, CTX_OK)).not.toBeNull();
  });

  it('闸②：graduatedAt 查不到（null）→ null', () => {
    expect(pickNudge([GAP_NO_FOLLOWS], EMPTY_LEDGER, NOW, { stage: 'completed', graduatedAt: null })).toBeNull();
  });

  it('闸③：距上条顺一句不足 72h → null；≥72h → 可以', () => {
    const recentLedger: NudgeLedger = { ...EMPTY_LEDGER, last_at: NOW - 71 * 3600 };
    expect(pickNudge([GAP_NO_FOLLOWS], recentLedger, NOW, CTX_OK)).toBeNull();
    const oldLedger: NudgeLedger = { ...EMPTY_LEDGER, last_at: NOW - 73 * 3600 };
    expect(pickNudge([GAP_NO_FOLLOWS], oldLedger, NOW, CTX_OK)).not.toBeNull();
  });

  it('闸④：终身条数 ≥6 → null；<6 → 可以', () => {
    expect(pickNudge([GAP_NO_FOLLOWS], { ...EMPTY_LEDGER, lifetime: 6 }, NOW, CTX_OK)).toBeNull();
    expect(pickNudge([GAP_NO_FOLLOWS], { ...EMPTY_LEDGER, lifetime: 5 }, NOW, CTX_OK)).not.toBeNull();
  });

  it('闸⑧：该 gap strike ≥2 → 跳过，挑下一条；strike<2 → 可以', () => {
    const ledger: NudgeLedger = { ...EMPTY_LEDGER, strikes: { no_follows: 2 } };
    const pick = pickNudge([GAP_NO_FOLLOWS, GAP_NO_TASTE], ledger, NOW, CTX_OK);
    expect(pick?.key).toBe('no_taste');
  });

  it('闸⑧：muted 单个 key → 跳过该条', () => {
    const ledger: NudgeLedger = { ...EMPTY_LEDGER, muted: ['no_follows'] };
    const pick = pickNudge([GAP_NO_FOLLOWS, GAP_NO_TASTE], ledger, NOW, CTX_OK);
    expect(pick?.key).toBe('no_taste');
  });

  it('闸⑧：muted ["*"] → 全灭', () => {
    const ledger: NudgeLedger = { ...EMPTY_LEDGER, muted: ['*'] };
    expect(pickNudge([GAP_NO_FOLLOWS, GAP_NO_TASTE], ledger, NOW, CTX_OK)).toBeNull();
  });

  it('gaps 全部被 strike/muted 封死 → null（不是随便挑一条兜底）', () => {
    const ledger: NudgeLedger = { ...EMPTY_LEDGER, strikes: { no_follows: 2, no_taste: 2 } };
    expect(pickNudge([GAP_NO_FOLLOWS, GAP_NO_TASTE], ledger, NOW, CTX_OK)).toBeNull();
  });

  it('挑 gaps 数组里第一条还站得住的（顺序即优先级）', () => {
    const pick = pickNudge([GAP_NO_FOLLOWS, GAP_NO_TASTE], EMPTY_LEDGER, NOW, CTX_OK);
    expect(pick?.key).toBe('no_follows');
  });
});

describe('pickNudge — 文案纪律', () => {
  // S5：前缀与行长上限都跟着主人的语种走，所以断言走同一条渲染路径，
  // 不再写死中文常量（一个汉字约抵两个拉丁字母，英文档上限是两倍）。
  const prefix = (): string => renderCopy(ownerLang(), 'onboarding.nudge.prefix');
  const cap = (): number => (ownerLang() === 'zh-CN' ? 60 : 120);

  for (const tag of ['zh-CN', 'en-US']) {
    it(`统一前缀、三段式、无 emoji/感叹号，不超行长上限（${tag}）`, () => {
      setOwnerLang(tag, 'config');
      const pick = pickNudge([GAP_NO_FOLLOWS], EMPTY_LEDGER, NOW, CTX_OK);
      expect(pick?.line.startsWith(prefix())).toBe(true);
      const body = pick!.line.replace(prefix(), '');
      expect([...body].length).toBeLessThanOrEqual(cap());
      expect(body).not.toMatch(/!|！/);
      expect(body).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // emoji ranges
    });
  }

  it('毙用词：别人/社区/N人/还剩X步/完成度/你确定不/尽快 一个都不出现（跑全部固定文案）', () => {
    setOwnerLang('zh-CN', 'config');
    // Derived from GAP_LINE_KEYS rather than hardcoded — that table is the
    // single source of truth for "which GapKey has a line" (see its comment).
    const keys = (Object.keys(GAP_LINE_KEYS) as (keyof typeof GAP_LINE_KEYS)[]).filter(
      (key) => GAP_LINE_KEYS[key] !== null,
    );
    // Deriving `keys` from the table (rather than hardcoding the GapKey list)
    // means the loop below silently shrinks if a table entry goes missing —
    // pin the count so that regresses loudly instead.
    expect(keys).toHaveLength(6);
    for (const key of keys) {
      const pick = pickNudge([{ key }], EMPTY_LEDGER, NOW, CTX_OK);
      expect(pick, key).not.toBeNull();
      const body = pick!.line;
      expect(body).not.toContain('别人');
      expect(body).not.toContain('社区');
      expect(body).not.toMatch(/\d+\s*人/); // "N人"（"几个人"不含数字，放行）
      expect(body).not.toMatch(/还剩\d+步/);
      expect(body).not.toContain('完成度');
      expect(body).not.toContain('你确定不');
      expect(body).not.toContain('尽快');
    }
  });

  it('house 缺口：坊名/headline/first_move 全来自 Gap 数据，零写死坊名', () => {
    const pick = pickNudge([GAP_HOUSE], EMPTY_LEDGER, NOW, CTX_OK);
    expect(pick?.key).toBe('house:house-a:first_move');
    expect(pick?.line).toContain('灯坊甲');
    expect(pick?.line).toContain('带我进世界');
  });

  for (const tag of ['zh-CN', 'en-US']) {
    it(`house 缺口：超长 headline 也不会把整行撑破行长上限（${tag}）`, () => {
      setOwnerLang(tag, 'config');
      const longHeadline = '捏一个你自己的公仔它替你去旅行看世界结交朋友发第一条帖子认识陌生人'; // far over budget
      const gap: Gap = {
        key: 'house:house-b:first_move',
        houseName: '灯坊乙',
        houseHeadline: longHeadline,
        houseFirstMove: '带我进世界看看吧',
      };
      const pick = pickNudge([gap], EMPTY_LEDGER, NOW, CTX_OK);
      const body = pick!.line.replace(prefix(), '');
      expect([...body].length).toBeLessThanOrEqual(cap());
    });
  }

  it('house 缺口缺 first_move（不该发生，防御性）→ 该条不出，跳过', () => {
    const gap: Gap = { key: 'house:house-c:first_move', houseName: '灯坊丙' };
    expect(pickNudge([gap], EMPTY_LEDGER, NOW, CTX_OK)).toBeNull();
  });

  it('no_house_card：在 GAP_LINE_KEYS 里显式登记为 null（结构性不可达，非回归——见该常量注释），故不产生顺一句', () => {
    expect(GAP_LINE_KEYS.no_house_card).toBeNull();
    expect(pickNudge([{ key: 'no_house_card' }], EMPTY_LEDGER, NOW, CTX_OK)).toBeNull();
  });
});

describe('composeTail', () => {
  it('未读优先（闸⑦）：有未读就不管顺一句', () => {
    const tail = composeTail({
      unreadLine: '📬 3 条待回',
      toolName: 'popclaw_show_marks',
      toolOk: true,
      nudgeLine: '— 顺一句：还没关注人…',
    });
    expect(tail).toBe('📬 3 条待回');
  });

  it('闸⑤：toolOk=false → 没有尾巴（即便有顺一句候选）', () => {
    const tail = composeTail({
      unreadLine: null,
      toolName: 'popclaw_show_marks',
      toolOk: false,
      nudgeLine: '— 顺一句：还没关注人…',
    });
    expect(tail).toBeNull();
  });

  it('闸⑥：排除名单里的工具 → 没有顺一句', () => {
    for (const name of ['popclaw_check_status', 'popclaw_notifications', 'popclaw_show_pings', 'popclaw_onboarding_status']) {
      expect(isExcludedFromNudge(name)).toBe(true);
      const tail = composeTail({ unreadLine: null, toolName: name, toolOk: true, nudgeLine: '— 顺一句：x' });
      expect(tail).toBeNull();
    }
  });

  it('未读没出、闸⑤⑥都过、有顺一句候选 → 顺一句出', () => {
    const tail = composeTail({
      unreadLine: null,
      toolName: 'popclaw_show_marks',
      toolOk: true,
      nudgeLine: '— 顺一句：还没关注人…',
    });
    expect(tail).toBe('— 顺一句：还没关注人…');
  });

  it('什么都没有 → null（不是空字符串）', () => {
    expect(composeTail({ unreadLine: null, toolName: 'popclaw_show_marks', toolOk: true, nudgeLine: null })).toBeNull();
  });
});

describe('账本读写（config onboarding.nudge）', () => {
  it('没写过 → 空账本', async () => {
    const host = new InMemoryHostAdapter();
    expect(await readNudgeLedger(host)).toEqual(EMPTY_LEDGER);
  });

  it('recordNudgeSent：strikes[key]+=1、last_at=now、lifetime+=1，其余字段保留', async () => {
    const host = new InMemoryHostAdapter();
    await recordNudgeSent(host, 'no_follows', NOW);
    let ledger = await readNudgeLedger(host);
    expect(ledger).toEqual({ last_at: NOW, lifetime: 1, strikes: { no_follows: 1 }, muted: [] });

    await recordNudgeSent(host, 'no_follows', NOW + 100);
    ledger = await readNudgeLedger(host);
    expect(ledger).toEqual({ last_at: NOW + 100, lifetime: 2, strikes: { no_follows: 2 }, muted: [] });

    await recordNudgeSent(host, 'no_taste', NOW + 200);
    ledger = await readNudgeLedger(host);
    expect(ledger.strikes).toEqual({ no_follows: 2, no_taste: 1 });
    expect(ledger.lifetime).toBe(3);
  });

  it('只在真输出时写：不调用 recordNudgeSent 就不落盘', async () => {
    const host = new InMemoryHostAdapter();
    // pickNudge 本身是纯函数，不接触 host —— 这里只是确认没有隐藏的副作用。
    pickNudge([GAP_NO_FOLLOWS], EMPTY_LEDGER, NOW, CTX_OK);
    expect(await readNudgeLedger(host)).toEqual(EMPTY_LEDGER);
  });

  it('终身 6 行：sixth send 之后 pickNudge 就不再挑了', async () => {
    const host = new InMemoryHostAdapter();
    for (let i = 0; i < 6; i++) {
      await recordNudgeSent(host, `gap${i}`, NOW - (6 - i) * 100 * 3600); // 保证距上条 ≥72h
    }
    const ledger = await readNudgeLedger(host);
    expect(ledger.lifetime).toBe(6);
    expect(pickNudge([GAP_NO_FOLLOWS], ledger, NOW, CTX_OK)).toBeNull();
  });

  it('muteNudge(scope="all") → muted:["*"]；单个 gap key → 只静默那一条', async () => {
    const host = new InMemoryHostAdapter();
    await muteNudge(host, 'no_follows');
    let ledger = await readNudgeLedger(host);
    expect(ledger.muted).toEqual(['no_follows']);

    await muteNudge(host, 'all');
    ledger = await readNudgeLedger(host);
    expect(ledger.muted).toEqual(['no_follows', '*']);
  });

  it('muteNudge 幂等：重复静默同一 key 不重复追加', async () => {
    const host = new InMemoryHostAdapter();
    await muteNudge(host, 'no_follows');
    await muteNudge(host, 'no_follows');
    const ledger = await readNudgeLedger(host);
    expect(ledger.muted).toEqual(['no_follows']);
  });

  it('保留其余顶层与 onboarding 字段（读-改-写纪律，与 bailed_at 同一份先例）', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_house_url: 'http://x', onboarding: { newspaper: 'daily', bailed_at: 42 } } },
    });
    await recordNudgeSent(host, 'no_follows', NOW);
    const cfg = (await host.config.loadJson('plugin')) as Record<string, unknown> & {
      onboarding: { newspaper: string; bailed_at: number; nudge: { lifetime: number } };
    };
    expect(cfg.lore_house_url).toBe('http://x');
    expect(cfg.onboarding.newspaper).toBe('daily');
    expect(cfg.onboarding.bailed_at).toBe(42);
    expect(cfg.onboarding.nudge.lifetime).toBe(1);
  });
});
