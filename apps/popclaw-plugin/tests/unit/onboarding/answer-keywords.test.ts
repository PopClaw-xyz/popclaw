import { describe, it, expect } from 'vitest';
import {
  readCadenceHour,
  isProceedKeyword,
  isYouDecide,
  isBailKeyword,
  isRenameRequest,
  isNotSelfDescription,
  isPassportReissueRequest,
} from '../../../src/onboarding/answer-keywords.js';

describe('isPassportReissueRequest（R1 §6：随时重渲）', () => {
  it('认"再来一张/过期了"这类要求', () => {
    for (const w of ['再给我一张护照', '护照重出一张', '名帖过期了', '护照链接打不开了', '重新给我一张名帖']) {
      expect(isPassportReissueRequest(w)).toBe(true);
    }
  });
  it('只是提到护照、或明确不要 → 不算要求', () => {
    for (const w of ['这护照真好看', '我不要护照', '护照是什么', '换个名字']) {
      expect(isPassportReissueRequest(w)).toBe(false);
    }
  });
});

describe('isProceedKeyword', () => {
  it('认推进词', () => {
    for (const w of ['继续', '好', 'OK', '用这个', '进江湖吧']) {
      expect(isProceedKeyword(w)).toBe(true);
    }
  });
  it('裸「1」不再当推进——arrival 里它是"选第一个候选"', () => {
    expect(isProceedKeyword('1')).toBe(false);
  });
  it('名号里带这些字不被吞', () => {
    for (const name of ['好剑', '继续行者', '可以客']) {
      expect(isProceedKeyword(name)).toBe(false);
    }
  });
});

describe('isYouDecide', () => {
  it('认「你定」类', () => {
    for (const w of ['你定', '你决定', '都行', '随便']) expect(isYouDecide(w)).toBe(true);
  });
  /**
   * #422（2026-08-24 真机）：中文主人在 arrival 说「你来挑吧」，这张表里没有，
   * 于是四个字被当成他亲手取的名号永久签进身份、还盖了双坊章——一张比 en 车道
   * 窄的表，偏偏漏在代价最高的那一幕。「挑」这一支和各条的「…吧」口语尾巴补齐。
   */
  it('#422：「你来挑吧」这类口语变体也认', () => {
    for (const w of ['你来挑吧', '你来挑', '你挑吧', '你挑', '你来定吧', '你定吧', '你选吧', '你看着办吧']) {
      expect(isYouDecide(w)).toBe(true);
    }
  });
  it('整句匹配，不吞名号', () => {
    expect(isYouDecide('你定风波')).toBe(false);
    expect(isYouDecide('你挑灯看剑')).toBe(false);
  });
});

describe('isBailKeyword', () => {
  it('认「先这样 / 先看看」', () => {
    for (const w of ['先这样', '先看看', '先看看再说', '以后再说']) {
      expect(isBailKeyword(w)).toBe(true);
    }
  });
  it('不是跳过当前步的词', () => {
    for (const w of ['跳过', 'skip', '下一步']) expect(isBailKeyword(w)).toBe(false);
  });
  it('整句匹配，不吞自述', () => {
    expect(isBailKeyword('我关心先这样后那样的工程哲学')).toBe(false);
  });
});

describe('isRenameRequest', () => {
  it('认改名意图', () => {
    for (const w of ['换个名字', '改名', '我想换个名号']) expect(isRenameRequest(w)).toBe(true);
  });
  it('普通回话不算', () => {
    expect(isRenameRequest('挺好的')).toBe(false);
  });
});

describe('isNotSelfDescription', () => {
  it('裸数字与跳过类词不许写进主权层', () => {
    for (const w of ['1', '2', '跳过', 'skip', '没有']) {
      expect(isNotSelfDescription(w)).toBe(true);
    }
  });
  it('真自述放行（子串不误伤）', () => {
    expect(isNotSelfDescription('我关心开源治理，跳过热闹')).toBe(false);
  });
});

// 主人可以直接报一个点，而不是只在 1/2 里选。
// 主人的原话是逐字递进来的（onboarding_continue 传 verbatim），所以解析在这儿。
describe('readCadenceHour', () => {
  it('读得出主人报的点（中英、几种常见写法）', () => {
    expect(readCadenceHour('9')).toBe(9);
    expect(readCadenceHour('9点')).toBe(9);
    expect(readCadenceHour('早上7点')).toBe(7);
    expect(readCadenceHour('07:00')).toBe(7);
    expect(readCadenceHour('9am')).toBe(9);
    expect(readCadenceHour('9 pm')).toBe(21);
    expect(readCadenceHour('18')).toBe(18);
    expect(readCadenceHour('6pm')).toBe(18);
  });

  it('1 和 2 是选项不是时刻，绝不当成凌晨一点、两点', () => {
    expect(readCadenceHour('1')).toBeUndefined();
    expect(readCadenceHour('2')).toBeUndefined();
  });

  // 误读的代价不对等：漏读 = 回落到提议时刻，主人一眼看见再改；
  // 误读 = 给他定了个凌晨两点的闹钟。所以裸数字必须挨着时刻标记，或者整句就是那个数。
  it('答应里夹带的数字不是时刻（「行，我有2个问题」≠ 凌晨两点）', () => {
    expect(readCadenceHour('行，我有2个问题')).toBeUndefined();
    expect(readCadenceHour('yes, and I have 3 questions')).toBeUndefined();
    expect(readCadenceHour('好啊')).toBeUndefined();
  });

  it('读不出就闭嘴，绝不替主人瞎定一个点', () => {
    expect(readCadenceHour('行')).toBeUndefined();
    expect(readCadenceHour('yes')).toBeUndefined();
    expect(readCadenceHour('25点')).toBeUndefined();
    expect(readCadenceHour('')).toBeUndefined();
  });
});

// 主人用中文语音输入，ASR 把口说的时刻转成汉字（「晚上九点」而不是「21:00」）。
// 只认阿拉伯数字 = 这个功能对他整个不成立。
describe('readCadenceHour · 汉字时刻', () => {
  it('认得汉字点数与时段前缀', () => {
    expect(readCadenceHour('九点')).toBe(9);
    expect(readCadenceHour('晚上九点')).toBe(21);
    expect(readCadenceHour('下午三点')).toBe(15);
    expect(readCadenceHour('早上七点')).toBe(7);
    expect(readCadenceHour('凌晨一点')).toBe(1);
    expect(readCadenceHour('十一点')).toBe(11);
    expect(readCadenceHour('二十一点')).toBe(21);
    expect(readCadenceHour('十点')).toBe(10);
  });

  it('时段前缀对阿拉伯数字同样生效', () => {
    expect(readCadenceHour('晚上9点')).toBe(21);
    expect(readCadenceHour('下午6点')).toBe(18);
  });

  it('不是时刻的汉字不硬凑', () => {
    expect(readCadenceHour('三个问题')).toBeUndefined();
    expect(readCadenceHour('二十四点')).toBeUndefined();
  });
});
