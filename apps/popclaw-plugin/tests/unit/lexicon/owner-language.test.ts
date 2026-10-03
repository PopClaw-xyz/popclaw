import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_OWNER_LANGUAGE,
  failureText,
  guessLangFromText,
  langOf,
  normalizeLocale,
  observeOwnerText,
  ownerLang,
  ownerLangSource,
  ownerLangTag,
  reportOwnerLang,
  setOwnerLang,
  stripEnvelope,
  useOwnerLangFile,
  useOwnerLangSignals,
} from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';

afterEach(() => setOwnerLang(undefined));

/** A throwaway `data/owner-language.json`, plus a "restart" that re-reads it. */
function langFile(): { file: string; reboot: () => void } {
  const file = join(mkdtempSync(join(tmpdir(), 'ownerlang-')), 'data', 'owner-language.json');
  return {
    file,
    reboot: () => {
      setOwnerLang(undefined);
      useOwnerLangFile(file);
    },
  };
}

describe('langOf', () => {
  it('maps every zh variant onto the zh-CN lane', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh_HK', 'ZH-cn', ' zh-CN ']) {
      expect(langOf(tag)).toBe('zh-CN');
    }
  });

  it('maps everything else onto the en lane', () => {
    for (const tag of ['en-US', 'en', 'ja-JP', 'ko-KR', 'de', '', 'zhuang']) {
      expect(langOf(tag)).toBe('en');
    }
  });
});

describe('owner language register', () => {
  it('defaults to en-US when nothing is set', () => {
    expect(ownerLangTag()).toBe(DEFAULT_OWNER_LANGUAGE);
    expect(ownerLang()).toBe('en');
    expect(ownerLangSource()).toBeUndefined();
  });

  it('explicit config always wins — a guess never overwrites it', () => {
    expect(setOwnerLang('en-US', 'config')).toBe(true);
    expect(setOwnerLang('zh-CN', 'guess')).toBe(false);
    expect(setOwnerLang('zh-CN', 'agent')).toBe(false);
    expect(ownerLangTag()).toBe('en-US');
    expect(ownerLangSource()).toBe('config');
  });

  it('lets the newest observation win, whichever lane it came from', () => {
    expect(setOwnerLang('ja-JP', 'guess')).toBe(true);
    expect(setOwnerLang('zh-CN', 'agent')).toBe(true);
    expect(ownerLang()).toBe('zh-CN');
    // The 2026-07-31 live bug: an old agent report used to outrank every later
    // guess, so an owner who switched languages could never switch back.
    expect(setOwnerLang('ko-KR', 'guess')).toBe(true);
    expect(ownerLangTag()).toBe('ko-KR');
    expect(setOwnerLang('en-US', 'config')).toBe(true);
    expect(ownerLangTag()).toBe('en-US');
  });

  it('a same-rank report overwrites (the owner switched languages mid-session)', () => {
    setOwnerLang('en-US', 'agent');
    expect(setOwnerLang('zh-CN', 'agent')).toBe(true);
    expect(ownerLang()).toBe('zh-CN');
  });

  it('an empty tag clears the register (tests / boot with no explicit config)', () => {
    setOwnerLang('zh-CN', 'config');
    expect(setOwnerLang('   ')).toBe(false);
    expect(ownerLangTag()).toBe(DEFAULT_OWNER_LANGUAGE);
  });
});

describe('guessLangFromText', () => {
  it('recognises Han, Kana and Hangul', () => {
    expect(guessLangFromText('我叫青鸾')).toBe('zh-CN');
    expect(guessLangFromText('こんにちは')).toBe('ja-JP');
    expect(guessLangFromText('안녕하세요')).toBe('ko-KR');
  });

  it('calls kanji-bearing Japanese Japanese, not Chinese', () => {
    expect(guessLangFromText('私の名前は月影です')).toBe('ja-JP');
  });

  it('returns undefined for Latin script instead of guessing en', () => {
    expect(guessLangFromText('call me Kuroha')).toBeUndefined();
    expect(guessLangFromText('')).toBeUndefined();
  });
});

describe('observeOwnerText — the live per-turn signal', () => {
  it('reproduces the live regression: an installed owner typing Chinese now flips', () => {
    // No explicit cadence, onboarding long since done → before this fix the
    // register stayed empty and every bilingual surface spoke en-US.
    expect(ownerLang()).toBe('en');
    observeOwnerText('帮我看看今天江湖上有什么新鲜事');
    expect(ownerLangTag()).toBe('zh-CN');
    expect(ownerLangSource()).toBe('guess');
  });

  // #376, real machine 2026-07-31, five consecutive turns: the owner switched
  // to Chinese on turn 2, then attached a file on turn 4 — and the register
  // flipped straight back to en-US. Nobody spoke those Latin letters; they were
  // a filename.
  //
  // The path length matters and is not decoration: the back-flip rule needs
  // ≥12 Latin letters at ≤10% CJK. A short name like `voice_1205.ogg` (8 Latin)
  // never reaches it — a first draft of this test used one and passed with the
  // fix reverted, which is worth nothing. A real inbound media path is ~58
  // Latin characters, which puts 「这个发给他」 at 7.9% and flips the register.
  const MEDIA_PATH =
    '/Users/owner/Library/Application Support/openclaw/inbound/voice_20260731_120544.ogg';

  it('an attachment turn does not flip a Chinese owner to English', () => {
    setOwnerLang(undefined);
    observeOwnerText('帮我看看今天江湖上有什么新鲜事');
    expect(ownerLangTag()).toBe('zh-CN');

    observeOwnerText(`这个发给他 ${MEDIA_PATH}`);
    expect(ownerLangTag()).toBe('zh-CN');
  });

  it('holds the register rather than guessing when the path was all there was', () => {
    // Strip the machinery and too few letters are left to judge. `undefined`
    // (hold) is the designed answer for "cannot tell" — trace #5 of the real
    // machine shows it already working.
    setOwnerLang(undefined);
    observeOwnerText('帮我看看今天江湖上有什么新鲜事');
    expect(ownerLangTag()).toBe('zh-CN');
    expect(observeOwnerText(MEDIA_PATH).detected).toBeNull();
    expect(ownerLangTag()).toBe('zh-CN');
  });

  it('never eats the owner\'s own words to do it — a slash between Chinese is not a path', () => {
    // A greedy "token containing a slash" would have taken 「这个/那个」 with
    // it. Stripping real CJK is the one way this fix could make things worse.
    setOwnerLang(undefined);
    observeOwnerText('这个/那个都可以');
    expect(ownerLangTag()).toBe('zh-CN');
  });

  it('an English owner sending a file is still read as English', () => {
    // The strip must not make the en direction unreachable: real English
    // speech survives it.
    setOwnerLang('zh-CN', 'guess');
    observeOwnerText(`please forward this recording to him ${MEDIA_PATH}`);
    expect(ownerLangTag()).toBe('en-US');
  });

  it('catches the two-character openers a Chinese owner actually starts with', () => {
    // MIN_CJK was 3, which threw away exactly the most common first sentence.
    for (const greeting of ['你好', '谢谢', '在吗', '好的', '收到']) {
      setOwnerLang(undefined);
      observeOwnerText(`[Telegram Alice id:1 2026-07-31T09:12] Alice: ${greeting}`);
      expect(ownerLangTag(), greeting).toBe('zh-CN');
    }
  });

  it('still ignores two CJK characters carried by an English sentence', () => {
    // The ratio gate, not the character floor, is what protects this: 2 CJK
    // against ~12 Latin letters is ~14%, nowhere near the 50% majority.
    observeOwnerText('what does 你好 mean?');
    expect(ownerLangSource()).toBeUndefined();
  });

  it('does not flip on a single character — too little to bet a switch on', () => {
    observeOwnerText('嗯');
    expect(ownerLangSource()).toBeUndefined();
    observeOwnerText('好');
    expect(ownerLangSource()).toBeUndefined();
  });

  it('does not flip on a stray CJK name inside an English sentence', () => {
    observeOwnerText(
      'I ran into 青鸾 at the meetup yesterday and we talked about the feed ranking for a while',
    );
    expect(ownerLangSource()).toBeUndefined();
  });

  it('does not flip on a long foreign quotation the owner pasted', () => {
    setOwnerLang('zh-CN', 'guess');
    observeOwnerText(
      '他说："the quick brown fox jumps over the lazy dog, and then it keeps ' +
        'running until the whole sentence is unmistakably English prose"',
    );
    expect(ownerLangTag()).toBe('zh-CN');
  });

  it('follows the owner from Chinese to English and back again', () => {
    observeOwnerText('今天有什么好看的');
    expect(ownerLangTag()).toBe('zh-CN');
    observeOwnerText('actually let us keep talking in english from now on please');
    expect(ownerLangTag()).toBe('en-US');
    observeOwnerText('算了，还是说中文吧');
    expect(ownerLangTag()).toBe('zh-CN');
  });

  it('never overrides an explicit configuration', () => {
    setOwnerLang('zh-CN', 'config');
    observeOwnerText('let us switch to english for a moment, just this one message');
    expect(ownerLangTag()).toBe('zh-CN');

    setOwnerLang('en-US', 'config');
    observeOwnerText('今天有什么好看的，给我说说');
    expect(ownerLangTag()).toBe('en-US');
  });

  it('ignores code fences and URLs — those are not the owner speaking', () => {
    observeOwnerText('看下这个\n```\nconst answer = fortyTwo(everything);\n```');
    expect(ownerLangTag()).toBe('zh-CN');
    observeOwnerText('看看 https://example.com/some/very/long/english/path/here');
    expect(ownerLangTag()).toBe('zh-CN');
  });

  it('leaves an exotic Latin tag alone — Latin script cannot tell en from de', () => {
    setOwnerLang('de-DE', 'agent');
    observeOwnerText('good morning, could you show me what happened in the world today');
    expect(ownerLangTag()).toBe('de-DE');
  });
});

describe('stripEnvelope — the host wraps every prompt before we see it', () => {
  it('strips the header and the sender prefix a direct chat adds', () => {
    expect(stripEnvelope('[Telegram Alice id:1 2026-07-31T09:12] Alice: 你好啊')).toBe('你好啊');
  });

  it('strips the group-chat form (header + sender label)', () => {
    expect(
      stripEnvelope('[Telegram Dev Group id:-100 2026-07-31T09:12] 青鸾: 今天有什么好看的'),
    ).toBe('今天有什么好看的');
    expect(stripEnvelope('[Telegram Alice id:1 2026-07-31T09:12] (self): 你好啊')).toBe('你好啊');
  });

  it('leaves un-enveloped text alone (the slash path passes ctx.args)', () => {
    expect(stripEnvelope('你好啊')).toBe('你好啊');
    expect(stripEnvelope('status --verbose')).toBe('status --verbose');
    // No header, so the colon rule never fires — this is the owner's own text.
    expect(stripEnvelope('TODO: 把报纸改一下')).toBe('TODO: 把报纸改一下');
  });

  it('keeps colons inside the body — only the sender label is a prefix', () => {
    expect(stripEnvelope('[Telegram Alice id:1 ts] Alice: 你好啊，A: B')).toBe('你好啊，A: B');
  });

  it('degrades to the original string on malformed input', () => {
    expect(stripEnvelope('[unterminated 你好啊')).toBe('[unterminated 你好啊');
    expect(stripEnvelope('[Telegram Alice id:1 ts] Alice: ')).toBe('[Telegram Alice id:1 ts] Alice: ');
    expect(stripEnvelope('')).toBe('');
  });

  it('sniffs a short Chinese sentence through the envelope (the live bug)', () => {
    // Un-stripped this scores 3 CJK / 28 letters ≈ 11% and never fires.
    observeOwnerText('[Telegram Alice id:12345 2026-07-31T09:12] Alice: 你好啊');
    expect(ownerLangTag()).toBe('zh-CN');
    expect(ownerLangSource()).toBe('guess');
  });

  it('does not mistake a long display name for the owner writing English', () => {
    // The regression that made this worse than useless: header Latin alone
    // pushed CJK under 10%, flipping a Chinese owner to en-US.
    setOwnerLang('zh-CN', 'guess');
    observeOwnerText(
      '[Telegram Alexander Montgomery-Fitzgerald id:987654321 2026-07-31T09:12] ' +
        'Alexander Montgomery-Fitzgerald: 你好啊',
    );
    expect(ownerLangTag()).toBe('zh-CN');
  });
});

describe('normalizeLocale', () => {
  it('turns POSIX locales into BCP-47', () => {
    expect(normalizeLocale('zh_CN.UTF-8')).toBe('zh-CN');
    expect(normalizeLocale('en_US.UTF-8')).toBe('en-US');
    expect(normalizeLocale('en_US@euro')).toBe('en-US');
    expect(normalizeLocale(' ja-JP ')).toBe('ja-JP');
  });

  it('rejects the "no locale" values and junk', () => {
    for (const raw of ['C', 'POSIX', '', undefined, 'C.UTF-8', 'not a locale']) {
      expect(normalizeLocale(raw)).toBeUndefined();
    }
  });
});

describe('POPCLAW_LANG — the S12 escape hatch', () => {
  afterEach(() => {
    delete process.env.POPCLAW_LANG;
  });

  it('outranks every lane, config included, so screenshots and issues can be pinned', () => {
    setOwnerLang('zh-CN', 'config');
    expect(ownerLang()).toBe('zh-CN');
    process.env.POPCLAW_LANG = 'en';
    expect(ownerLangTag()).toBe('en');
    expect(ownerLang()).toBe('en');
    // Reported as `config` so languageDirective names the forced tag rather
    // than falling back to "mirror the owner".
    expect(ownerLangSource()).toBe('config');
  });

  it('is read live, so unsetting it hands the owner their language straight back', () => {
    setOwnerLang('zh-CN', 'config');
    process.env.POPCLAW_LANG = 'en';
    expect(ownerLang()).toBe('en');
    delete process.env.POPCLAW_LANG;
    expect(ownerLangTag()).toBe('zh-CN');
  });

  it('ignores junk rather than forcing a bogus tag', () => {
    setOwnerLang('zh-CN', 'config');
    process.env.POPCLAW_LANG = 'not a locale';
    expect(ownerLangTag()).toBe('zh-CN');
  });
});

describe('useOwnerLangSignals — the host already knows some of this', () => {
  it('takes config.talk.speechLocale as an instruction, not a guess', () => {
    const { file } = langFile();
    useOwnerLangSignals({ speechLocale: 'zh-CN', file, env: {} });
    expect(ownerLangTag()).toBe('zh-CN');
    expect(ownerLangSource()).toBe('config');
    // config tier: the per-turn sniff cannot argue with it.
    observeOwnerText('let us switch to english for a moment, just this one message');
    expect(ownerLangTag()).toBe('zh-CN');
  });

  it('takes OPENCLAW_LOCALE the same way', () => {
    const { file } = langFile();
    useOwnerLangSignals({ file, env: { OPENCLAW_LOCALE: 'zh-CN' } });
    expect(ownerLangTag()).toBe('zh-CN');
    expect(ownerLangSource()).toBe('config');
  });

  it('takes LANG only to fill a blank, and any observation displaces it', () => {
    const { file } = langFile();
    useOwnerLangSignals({ file, env: { LANG: 'zh_CN.UTF-8' } });
    expect(ownerLangTag()).toBe('zh-CN');
    expect(ownerLangSource()).toBe('env');
    observeOwnerText('good morning, could you show me what happened in the world today');
    expect(ownerLangTag()).toBe('en-US');
  });

  it('prefers LC_ALL, then LC_MESSAGES, then LANG (the host order)', () => {
    const { file } = langFile();
    useOwnerLangSignals({ file, env: { LC_ALL: 'ja_JP.UTF-8', LC_MESSAGES: 'ko_KR', LANG: 'zh_CN' } });
    expect(ownerLangTag()).toBe('ja-JP');
    setOwnerLang(undefined);
    useOwnerLangSignals({ file, env: { LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'zh_CN' } });
    expect(ownerLangTag()).toBe('ko-KR');
  });

  it('treats a blank LC_ALL/LC_MESSAGES as absent for locale fallback', () => {
    // An MCP host can pass empty variables to its child. Our fallback treats
    // empty and whitespace-only values as blank without changing the environment.
    const { file } = langFile();
    for (const blank of ['', '   ']) {
      setOwnerLang(undefined);
      useOwnerLangSignals({ file, env: { LC_ALL: blank, LANG: 'zh_CN.UTF-8' } });
      expect(ownerLangTag(), `LC_ALL=${JSON.stringify(blank)}`).toBe('zh-CN');
      expect(ownerLangSource()).toBe('env');

      setOwnerLang(undefined);
      useOwnerLangSignals({ file, env: { LC_MESSAGES: blank, LANG: 'zh_CN.UTF-8' } });
      expect(ownerLangTag(), `LC_MESSAGES=${JSON.stringify(blank)}`).toBe('zh-CN');
      expect(ownerLangSource()).toBe('env');
    }
  });

  it('a nonblank C/POSIX/junk override still means "explicitly no locale" — it does not fall through to LANG', () => {
    // POSIX gives LC_ALL=C the power to override LANG; honoring that is a
    // feature, not the blank-value bug above. The chain stops there.
    const { file } = langFile();
    for (const explicit of ['C', 'POSIX', 'C.UTF-8', 'not a locale']) {
      setOwnerLang(undefined);
      useOwnerLangSignals({ file, env: { LC_ALL: explicit, LANG: 'zh_CN.UTF-8' } });
      expect(ownerLangSource(), `LC_ALL=${explicit}`).toBeUndefined();
      expect(ownerLangTag()).toBe(DEFAULT_OWNER_LANGUAGE);

      setOwnerLang(undefined);
      useOwnerLangSignals({ file, env: { LC_MESSAGES: explicit, LANG: 'zh_CN.UTF-8' } });
      expect(ownerLangSource(), `LC_MESSAGES=${explicit}`).toBeUndefined();
    }
  });

  it('orders the whole chain: cadence > speechLocale > remembered > LANG', () => {
    const { file } = langFile();
    const env = { OPENCLAW_LOCALE: 'ko-KR', LANG: 'ja_JP.UTF-8' };

    // LANG alone fills the blank.
    useOwnerLangSignals({ file, env: { LANG: 'ja_JP.UTF-8' } });
    expect(ownerLangTag()).toBe('ja-JP');

    // A remembered observation beats LANG.
    setOwnerLang(undefined);
    useOwnerLangFile(file);
    reportOwnerLang('zh-CN', 'guess');
    setOwnerLang(undefined);
    useOwnerLangSignals({ file, env: { LANG: 'ja_JP.UTF-8' } });
    expect(ownerLangTag()).toBe('zh-CN');

    // speechLocale / OPENCLAW_LOCALE beat the remembered observation.
    setOwnerLang(undefined);
    useOwnerLangSignals({ speechLocale: 'de-DE', file, env });
    expect(ownerLangTag()).toBe('de-DE');

    // An explicit cadence, registered first by the root, beats them all.
    setOwnerLang(undefined);
    setOwnerLang('en-US', 'config');
    useOwnerLangSignals({ speechLocale: 'de-DE', file, env });
    expect(ownerLangTag()).toBe('en-US');
  });
});

describe('owner-language state file', () => {
  it('survives a restart, and is not cadence.json', () => {
    const { file, reboot } = langFile();
    useOwnerLangFile(file);
    observeOwnerText('今天有什么好看的');
    expect(existsSync(file)).toBe(true);
    expect(file.endsWith(join('data', 'owner-language.json'))).toBe(true);

    reboot();
    expect(ownerLangTag()).toBe('zh-CN');
    expect(ownerLangSource()).toBe('guess');
  });

  it('yields to an explicit configuration registered before it', () => {
    const { file } = langFile();
    useOwnerLangFile(file);
    reportOwnerLang('zh-CN');

    setOwnerLang(undefined);
    setOwnerLang('en-US', 'config'); // boot order: explicit cadence first…
    useOwnerLangFile(file); // …then the remembered observation
    expect(ownerLangTag()).toBe('en-US');
  });

  it('writes once per language, not once per turn', () => {
    const { file } = langFile();
    useOwnerLangFile(file);
    observeOwnerText('今天有什么好看的');
    const stamp = readFileSync(file, 'utf-8');
    writeFileSync(file, '{"tag":"sentinel"}');
    observeOwnerText('明天有什么好看的');
    expect(readFileSync(file, 'utf-8')).toBe('{"tag":"sentinel"}');
    expect(stamp).toContain('zh-CN');
  });

  it('treats a corrupt or missing file as "nothing observed yet"', () => {
    const { file } = langFile();
    useOwnerLangFile(file); // missing
    expect(ownerLangSource()).toBeUndefined();
  });
});

describe('failureText — the error passthrough trade-off (ledger #010)', () => {
  it('passes an error string it has never read through verbatim, unchanged', () => {
    // The header comment on failureText is explicit: translating an unread
    // error string would destroy the only lead the owner can forward. This
    // guards that trade-off survives the KNOWN-code enrichment added at the
    // HOUSE_SESSION_CONTEXT_UNAVAILABLE throw site (house-runtime.ts) — that
    // enrichment composes the Error's own message before it ever reaches
    // here, so failureText itself must keep doing nothing but String(err).
    const unread = 'ECONNRESET: some_upstream_detail 12345';
    expect(failureText('some_tool', unread)).toBe(`⚠️ some_tool failed: ${unread}`);
  });

  it('carries a known code plus its lexicon sentence through unchanged, exactly as composed at the throw site', () => {
    // house-runtime.ts composes "<code>: <rendered sentence>" into the
    // Error's own message before it reaches failureText — this is what the
    // owner actually sees for HOUSE_SESSION_CONTEXT_UNAVAILABLE on a house
    // whose remote_status confirms it has no session control plane.
    const origin = 'https://world.example';
    const composed = `HOUSE_SESSION_CONTEXT_UNAVAILABLE: ${renderCopy('en', 'house.session.unsupported', { origin })}`;
    const rendered = failureText('popclaw_world_private_messages', composed);
    expect(rendered).toContain('HOUSE_SESSION_CONTEXT_UNAVAILABLE');
    expect(rendered).toContain('does not offer the session control');
    expect(rendered).toBe(`⚠️ popclaw_world_private_messages failed: ${composed}`);
  });
});
