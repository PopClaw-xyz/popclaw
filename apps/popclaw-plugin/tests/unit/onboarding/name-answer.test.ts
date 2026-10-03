import { describe, it, expect } from 'vitest';
import { parseNameAnswer } from '../../../src/onboarding/name-answer.js';
import { NICKNAME_MAX_LENGTH, nicknameProblem, persistNickname } from '../../../src/onboarding/identity-writer.js';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { PluginConfig } from '../../../src/config/schema.js';

const ZWSP = String.fromCodePoint(0x200b);
const ZWJ = String.fromCodePoint(0x200d);
const FOX = String.fromCodePoint(0x1f98a);
const confirm = (name: string) => ({ kind: 'confirm', name });
const sentence = { kind: 'unclear', reason: 'sentence' };

describe('parseNameAnswer: free text is never a name, only a confirmation', () => {
  // The safety property with zero phrase tables: none of these match any
  // phrasing, and all of them still go to the card rather than being adopted.
  const bare = [
    'Kuroba',
    '新人0926',
    '夜行白驹',
    'Night drifter',
    'Keep Walking Wanderer',
    'Ana María López García',
    'me llamo Ana',
    "je m'appelle Marie",
    'ich heiße Max',
    '제 이름은 민수',
    'x'.repeat(NICKNAME_MAX_LENGTH),
    `${FOX}Fox`,
    '天下第一',
    'First Light',
    '不二',
    '不羁',
    'Not Today',
    // X3: bare ordinal words are not picks — they may be the name he wants.
    'Number One',
    'One',
    'First',
    'The Second',
    '二号',
    '1号',
    '第一',
    // X4: question words inside names are harmless.
    'Doctor Who',
    'What If',
    'Which Way',
    'How To Train',
    '呢喃',
    '吗啡',
    '谁家少年',
    '#1 fan',
  ];
  for (const text of bare) {
    it(`${JSON.stringify(text)} → confirm itself`, () => {
      expect(parseNameAnswer(text)).toEqual(confirm(text));
    });
  }
});

describe('parseNameAnswer: a stated name is cut out for the card', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    // zh
    ['我叫小明', '小明'],
    ['我的名字叫 新人0926', '新人0926'],
    ['我的名字是：夜行白驹。', '夜行白驹'],
    ['叫我 黑羽 吧', '黑羽'],
    ['名字叫「拾光客」', '拾光客'],
    ['我想叫 白驹呗', '白驹'],
    ['就叫青鸾吧', '青鸾'],
    ['叫小明吧', '小明'],
    ['那就小明吧', '小明'],
    ['我要叫小明', '小明'],
    ['我是凤栖梧！', '凤栖梧'],
    ['我叫不二', '不二'],
    ['我是不二', '不二'],
    ['你好！我叫小明，请多关照', '小明'],
    ['我叫张三，大家叫我小张', '张三'],
    ['我叫小明\n请多关照', '小明'],
    // en
    ['my name is Kuroba', 'Kuroba'],
    ['My name is Kuroba.', 'Kuroba'],
    ["my name's Night drifter", 'Night drifter'],
    ['call me: Bob', 'Bob'],
    ['Call me "Kuroba"', 'Kuroba'],
    ['name me Kuroba', 'Kuroba'],
    ["let's go with Night drifter", 'Night drifter'],
    ["I'll be Kuroba?", 'Kuroba'],
    ["I'm Kuroba", 'Kuroba'],
    ['I want Bob', 'Bob'],
    ['This is Bob', 'Bob'],
    ['I am Bob, call me later', 'Bob'],
    ['Hi there, my name is Kuroba, nice to meet you', 'Kuroba'],
    // ja
    ['名前は黒羽です', '黒羽'],
    ['私は黒羽です。', '黒羽'],
    ['黒羽と呼んで', '黒羽'],
    ['黒羽にして', '黒羽'],
  ];
  for (const [input, name] of cases) {
    it(`${JSON.stringify(input)} → confirm ${JSON.stringify(name)}`, () => {
      expect(parseNameAnswer(input)).toEqual(confirm(name));
    });
  }
});

describe('parseNameAnswer: a candidate named by ordinal resolves to that candidate', () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["let's go with the second one", 2],
    ['the second one', 2],
    ['就叫第一个吧', 1],
    ['就叫2吧', 2],
    ["let's go with 2", 2],
    ['就用第二个', 2],
    ['第二个', 2],
  ];
  for (const [text, index] of cases) {
    it(`${JSON.stringify(text)} → candidate ${index}`, () => {
      expect(parseNameAnswer(text)).toEqual({ kind: 'candidate', index });
    });
  }

  it('a candidate reference that cannot be resolved is a retry, never a card', () => {
    expect(parseNameAnswer('the second one please')).toEqual(sentence);
    expect(parseNameAnswer('我觉得第二个好')).toEqual(sentence);
  });
});

describe('parseNameAnswer: not-a-name answers are a retry, never a card', () => {
  const retries = [
    "I'm not sure",
    'I am thinking',
    "i don't know",
    '我是新来的',
    '我是谁',
    '我叫什么好呢',
    '不知道',
    '还没想好',
    'what should I pick?',
    'what should I pick',
    '你说呢',
    'who',
    'hmm, not sure yet',
    '这个嘛，让我想想',
    '好难选啊！',
    'Bob\nAlice',
    '我叫',
    'my name is 7',
  ];
  for (const s of retries) {
    it(`${JSON.stringify(s)} → sentence`, () => {
      expect(parseNameAnswer(s)).toEqual(sentence);
    });
  }

  it('over the 32-character cap → tooLong, never truncated', () => {
    expect(parseNameAnswer('x'.repeat(NICKNAME_MAX_LENGTH + 1))).toEqual({ kind: 'unclear', reason: 'tooLong' });
    expect(parseNameAnswer(`my name is ${'x'.repeat(NICKNAME_MAX_LENGTH + 1)}`)).toEqual({
      kind: 'unclear',
      reason: 'tooLong',
    });
  });

  it('a placeholder stated in a sentence → placeholder', () => {
    expect(parseNameAnswer('my name is ranger-7gXkQz')).toEqual({ kind: 'unclear', reason: 'placeholder' });
  });
});

describe('parseNameAnswer: input hygiene', () => {
  it('zero-width characters are removed; quotes and a closing period are cleaned', () => {
    expect(parseNameAnswer(`Bo${ZWSP}b`)).toEqual(confirm('Bob'));
    expect(parseNameAnswer('"Kuroba".')).toEqual(confirm('Kuroba'));
    expect(parseNameAnswer('「黒羽」')).toEqual(confirm('黒羽'));
  });
  it('the joiner inside an emoji sequence survives', () => {
    const family = `${FOX}${ZWJ}${FOX}`;
    expect(parseNameAnswer(family)).toEqual(confirm(family));
  });
  it('tabs and runs of spaces collapse to one space', () => {
    expect(parseNameAnswer('Night\t  drifter')).toEqual(confirm('Night drifter'));
  });
});

describe('nicknameProblem: the one set of nickname rules (identity.proto: 1..32 chars)', () => {
  it('counts UTF-16 units like the config schema: 16 emoji are legal, 17 are not', () => {
    expect(nicknameProblem(FOX.repeat(16))).toBeUndefined();
    expect(nicknameProblem(FOX.repeat(17))).toBe('tooLong');
  });

  it('every name it accepts survives the boot-time config parse (RangerProfile.nickname max 32)', async () => {
    const names = [
      FOX.repeat(16),
      FOX.repeat(17),
      FOX.repeat(20),
      'x'.repeat(NICKNAME_MAX_LENGTH),
      '长'.repeat(NICKNAME_MAX_LENGTH),
      `${'x'.repeat(NICKNAME_MAX_LENGTH - 1)}${FOX}`,
    ];
    let accepted = 0;
    for (const name of names) {
      if (nicknameProblem(name) !== undefined) continue;
      accepted += 1;
      const host = new InMemoryHostAdapter({
        config: { plugin: { lore_houses: ['https://house.test'] } },
        now: new Date(0),
      });
      await persistNickname(host, name, 'owner');
      const saved = await host.config.loadJson('plugin');
      expect(PluginConfig.parse(saved).ranger_profile?.nickname, name).toBe(name);
    }
    expect(accepted).toBe(3); // 16 emoji, 32 x, 32 Han
  });
  it('internal spaces and any script are legal', () => {
    for (const n of ['Night drifter', '제 이름', 'Ана', '新人0926']) expect(nicknameProblem(n)).toBeUndefined();
  });
  it('empty, placeholder and all-digit names are not', () => {
    expect(nicknameProblem('  ')).toBe('empty');
    expect(nicknameProblem('ranger-7gXkQz')).toBe('placeholder');
    expect(nicknameProblem('0926')).toBe('digits');
  });
});
