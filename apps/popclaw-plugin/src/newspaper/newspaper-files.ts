/**
 * The newspaper's owner-tunable files, seeded into `<newspaperDir>`:
 *   - `content.md`        — the editorial voice (faithful, person-first)
 *   - `style.json`        — the layout knobs (v0.2; see `./newspaper-style.ts`)
 *   - `style.README.md`   — what each knob does, because JSON has no comments
 *
 * `layout.md` used to be the third of these. v0.2 moved the layout into code, so
 * it is no longer read; `retiredLayoutRules()` reports an owner-edited leftover,
 * and the file itself is left on disk untouched (P-006).
 *
 * Seeded **in the owner's language** (`ownerLang()`; the en codex is written,
 * not translated — see `./newspaper-files-en.ts`) on first read so they can see + edit them
 * ("content: …" appends to content.md, "layout: …" appends to layout.md). The HARD
 * core (fidelity iron rule / person-first / clickable links) lives in
 * build-newspaper-prompt.ts and is NOT tunable away — these files only refine.
 */
// Same exemption the two node:* imports below already run on: this module IS
// the newspaper's file layer. Precedent for crypto specifically: recommend/
// score-cache.ts, quest/scrape-content-handler.ts.
// eslint-disable-next-line no-restricted-imports
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { DEFAULT_CONTENT_EN } from './newspaper-files-en.js';
import { DEFAULT_STYLE, defaultStyleJson, resolveStyle, type NewspaperStyle } from './newspaper-style.js';

/** The knobs file and its companion README, both seeded into `<data>/newspaper/`. */
const STYLE_FILE = 'style.json';
const STYLE_README = 'style.README.md';

const DEFAULT_CONTENT = `# 报纸内容要求（content）

> 版面由 popclaw 排,你只写字。这份文件管的是**文字的分寸**:忠实、以人为主角、密度、笔法。
> 链接、头像、图片、计数、栏目、账目一律不归你 —— 素材里也不会给你。

## 一、忠实(铁律,不可让渡)

- 对每条素材只做**忠实的总结 / 转写 / 翻译**(英文→中文)。**严禁扩写、严禁添加素材没有的数字 / 事实 / 细节 / 因果 / 推断**。宁可短、宁可平淡。**句数是上限不是任务:原文不够长就到此为止,绝不凑句。**
- **绝不编造**作者、地点、时间、渠道、灯坊名。素材没给的字段整个省略。
- **引语原样**:直接引语逐字照引,第一人称不许改成第三人称;转述正文一律中性直述(「把曲线做成了对比笔记」),作者本人是主语时不得写「他说/他认为」。
- **矛盾并陈可点破**:素材内明显互相矛盾的两处(如同一诗会一作「明天」一作「下周」)可以并陈并点破(「两说并存,本报不代为裁断」),但不得裁决、不得合并。
- **字段纪律**:一条素材的字句只用于这一条,绝不串到别条。
- 翻译:外语正文译成自然现代中文;关键术语首次出现可括注原文(每条 ≤1 处);不音译人名,@handle 与名号原样。

## 二、以人为主角

- 每条都是「**某人说了什么 / 做了什么**」,人在前事在后:标题与摘要都从人写起。
- 有备注名就用备注名。无署名的条目照写内容,**绝不编一个作者出来**。
- 同一个人当天多条,各写各的;不要在摘要里替他总结「他今天一直在说 X」—— 那是推断。

## 三、三档密度(决定你写多长)

| 档 | 素材上的标记 | 写多长 | 一期几个 |
|---|---|---|---|
| 头版要闻 | 你自己选进 \`leads\` 的 | 忠实标题 + 5–8 句,分 2–3 短段 | 3 |
| 人物卡 | 标了「人物卡」 | 标题 + 3–6 句 | 约 12 |
| 简讯 | 标了「简讯」 | 一两句、≤60 字,必须含实质信息 | 其余全部 |

\`leads\` 挑当日最有分量的。**第一依据是主人自己**:先看这条是不是为他的口味或他认识的人挑进来的(挑的时候你把它归进了 \`taste\` / \`bond\`),再看交情档位——至交 / 密友当天至少一条进头版,也必进 teaser;最后才看配图与计数。

**\`topics\` 不是可选项**:简讯有几十条,不分栏就是一堵墙。把它们按主题归成 **4–6 栏**、每栏 2–6 词的栏名(如「太空」「AI 与工具」「人间事」),同一主题的放一起。**这是简讯那一大片好不好读的唯一决定因素。**

## 四、新人小传(\`newbies\`)

每人 2–3 句,**人物笔法,不是统计行**:来路(平台 + 粉丝,数字本地化「8.2 万」)→ 本机首见天数与今日行为 → 与主人的关系接口(「你关注的杜工部今天在浣花溪遇见了她」)。每一句都要在素材里可核。「本机首见第 N 天」**原词照抄** —— 我们只知本机所见,不许改成「入江湖」。

## 五、按语与标题

- \`deckNotes\` 每叠至多一句(≤25 字),点到即止,事实全部出自素材。
- 标题忠实概括,不标题党。
- **无虚假人气(宪法级)**:今日只有 N 条就不许有一个字暗示更多;不写「很热闹」「你的小家伙想你了」这类催促或渲染。

## 六、teaser

开场钩子(今日收编 N 条 + 3–5 个风向词)→ 约 7 条,每条以 \`名号#印信\` 开头 → 收尾一句「更多在全文里」。同样忠实,不扩写。`;

const STYLE_README_ZH = `# style.json —— 报纸版式旋钮

改这个文件，下一期报纸**必然**照做。它由插件直接读取，模型完全看不见，
所以不存在「写了模型不照做」。改完不用重启，下一期生效。

| 键 | 是什么 | 取值 |
|---|---|---|
| \`fontScale\` | 全报字号倍率。嫌小就调大 | 0.7 – 1.6，1 = 主人当初认可的那一版 |
| \`bodyFont\` | 正文用哪一款字 | \`huiwen\` 汇文明朝（默认）/ \`lxgw\` 霞鹜文楷 / \`garamond\` 只用西文衬线 / \`system\` 系统宋体（弱网最快） |
| \`accent\` | 报纸主色，也是 me 叠的颜色 | \`"#9b1c1c"\` 这样的六位色值 |
| \`houseAccents\` | 各灯坊单独指定颜色 | 灯坊 slug → 色值。没列到的坊按内置色环依次取 |
| \`deckOrder\` | 叠的先后 | 灯坊 slug 数组；\`[]\` = 按条数从多到少 |
| \`sections\` | 每叠印哪些栏、什么顺序 | slug → 栏名数组。栏名：\`mantle\` 门楣 / \`leads\` 要闻 / \`letters\` 世界来信 / \`postcards\` 明信片 / \`chron\` 江湖人情 / \`cards\` 人物卡 / \`homes\` 值得一逛的家 / \`briefs\` 简讯 / \`misc\` 附记。**每一栏都是素材给了才出**，列上不会凭空多一栏；没列到的坊用内置顺序 |
| \`figMax\` | 配图最高多少像素（要闻卡是它的 1.35 倍）。嫌图太占地方就调小 | 80 – 2000，默认 420 |
| \`leadMax\` | 头版要闻最多几条 | 0 – 6；0 = 不要头版 |
| \`cardMax\` | 每叠人物卡的**硬上限**。实际张数还受密度差约束（约占该叠三成），因为报纸好看就来自「要闻／人物卡／简讯」的疏密对比 | 0 – 200 |
| \`briefs\` \`roster\` \`newbieBoard\` \`index\` | 简讯栏 / 今日名录 / 新人热榜 / 锚点索引条，要不要 | \`true\` / \`false\` |

**写错了不会整份作废**：写错的那个键回落默认值，并在发布回执里点名告诉你哪一行错了。
多写的键会被忽略，同样在回执里说一声——省得你以为改了却没生效。

> 2026-08-25 起，\`layout.md\` 不再起作用：版面已经归代码，能调的都在这张表里。
> 你以前在 \`layout.md\` 上的改动仍留在磁盘上，但报纸不再读它。
`;

const STYLE_README_EN = `# style.json — the paper's layout knobs

Edit this file and the next issue **will** follow it. The plugin reads these
values directly and the model never sees them, so there is no "I asked and it
ignored me". No restart needed; the next issue picks it up.

| Key | What it does | Values |
|---|---|---|
| \`fontScale\` | Multiplies every type size on the page | 0.7 – 1.6; 1 = the sizes signed off on |
| \`bodyFont\` | The body face (Chinese only; English is always EB Garamond) | \`huiwen\` (default) / \`lxgw\` / \`garamond\` / \`system\` |
| \`accent\` | The paper's accent, and the \`me\` stack's | a six-digit colour like \`"#9b1c1c"\` |
| \`houseAccents\` | Per-lore-house accents | slug → colour. A slug not listed takes the next colour off the built-in cycle |
| \`deckOrder\` | Stack order | a list of lore-house slugs; \`[]\` = by item count, descending |
| \`sections\` | Which columns each stack prints, in order | slug → column names: \`mantle\` / \`leads\` / \`letters\` / \`postcards\` / \`chron\` / \`cards\` / \`homes\` / \`briefs\` / \`misc\`. **Every column prints only when it has material**, so listing one never conjures it. A slug not listed uses the built-in order |
| \`figMax\` | How tall a picture may stand, in px (a headline card gets 1.35x). Turn it down if pictures crowd the page | 80 – 2000, default 420 |
| \`leadMax\` | Front-page headline cards | 0 – 6; 0 = no front page |
| \`cardMax\` | **Hard ceiling** on person cards per stack. The actual number is also held to roughly a third of the stack — the paper's whole look comes from the density difference between headline, card and brief | 0 – 200 |
| \`briefs\` \`roster\` \`newbieBoard\` \`index\` | Print the brief column / today's cast / the new-faces board / the anchor index | \`true\` / \`false\` |

**A bad value never voids the file**: that one key falls back to its default and
the publish receipt names it. An unknown key is ignored and reported too — so a
typo never reads as a knob that does not work.

> From 2026-08-25 \`layout.md\` no longer has any effect: the layout is code now,
> and everything tunable is in the table above. Whatever you wrote in
> \`layout.md\` is still on disk; the paper no longer reads it.
`;

export const TEMPLATE_VERSION = 'v11';

/**
 * **sha256 of every seed version we have ever shipped** (zh/en × content/layout, version by version).
 *
 * Why this table exists: the stamping mechanism (`.seed`) only shipped at v5.
 * Machines installed before that had a template we ourselves had seeded, which
 * the owner never touched a character of, but with no stamp on disk —
 * `readOrSeed` couldn't recognize it and, per P-006, had to treat it as
 * "hand-written by the owner" and never overwrite it, so every subsequent
 * template improvement failed to reach it (real machine: the template seeded
 * on host-c on 2026-07-30 was permanently frozen). Comparing a character-exact
 * fingerprint lets us recognize "this is one of our own seeds", so we can
 * confidently reseed it and add the stamp; anything unrecognized really is the owner's own writing, and stays untouched forever.
 *
 * 📌 **Historical only, and it only grows**: the text of these versions is gone
 * from the tree, so these hashes cannot be recomputed — they are data, and they
 * are never deleted. Every time the template body changes (i.e. every time
 * `TEMPLATE_VERSION` bumps), the fingerprint of the **previous** version's
 * constants must be appended here, or the batch of machines still on the
 * previous version gets frozen into a new orphaned batch. Nobody has to compute
 * it: `tests/unit/newspaper/newspaper-seed-discipline.test.ts` pins the current
 * fingerprints, so the moment a constant moves it fails with the exact line to
 * paste (the outgoing hash) — the ritual is a red test, not a memory exercise.
 *
 * The **current** version's four fingerprints are not in here — they don't need
 * to be data — but they ARE part of the runtime set: `SHIPPED_SEEDS` below
 * unions them in, so a file whose bytes are exactly the seed this build ships,
 * with no stamp beside it, is recognised as ours and reseeded (current
 * owner-language default) instead of waiting a release for the hash to be
 * recorded here. Adopted after independent review; two reasons it is safe and
 * wanted: the guard is an exact sha256 match, so nothing the owner actually
 * wrote can collide with it; and `writeSeed` is a non-atomic read-modify-write
 * of `.seed`, so two hosts sharing a data root can strand a current-bytes file
 * with its stamp lost — without this, that file is frozen as "the owner's" for
 * good. (No locking here: out of scope, 0.1.1 if ever.)
 *
 * The comment on each entry = that fingerprint's provenance (constant name · TEMPLATE_VERSION at the time · the commit it first appeared in).
 */
const HISTORICAL_SEEDS: readonly string[] = [
  // DEFAULT_CONTENT · v10 · c65a31fc (2026-08-27, last version before the v0.3 selection ladder)
  'f25ef944c3e0badbcadd34758b89b60fea5dacd1f954cf94999b26fe21e71e72',
  // DEFAULT_CONTENT_EN · v10 · c65a31fc (2026-08-27)
  'e2d0d0f4ab3c833c7f6e52e61e560ddb2c7b5ac501b41f7609053f41d30b9e9a',
  // DEFAULT_CONTENT · pre-stamp · 768e650a (2026-06-17)
  'b9ec952d9f865ff30cf7776d49d91aa8f41c3f16b0ef2bec3c5b9512c7823cd0',
  // DEFAULT_LAYOUT · pre-stamp · 768e650a (2026-06-17)
  '9a46105f4babae5ddcdf773d4b162ae15042c35e5fa606deae114af2fe6e6d7f',
  // DEFAULT_CONTENT · pre-stamp · cbe5b963 (2026-06-20)
  'c3e39b03e6b6573f328b4d9e21d296d8b857be4c4bb697f9eb4b5abd0cfb6c62',
  // DEFAULT_LAYOUT · pre-stamp · cbe5b963 (2026-06-20)
  '80259001806b75892745849ab84dea1fc1b5411b436194fe2e0e79993d5a9cd6',
  // DEFAULT_CONTENT · pre-stamp · 68fbc447 (2026-07-07)
  '2a2cdc548dad1e7f0712cc556f5a1100765ef061ea254398fffdf70e29249b95',
  // DEFAULT_LAYOUT · pre-stamp · 68fbc447 (2026-07-07)
  'f89c42b1a67ac9f1ec7457fcb2b1d19874a4d4195111f3863726665b139d61c6',
  // DEFAULT_LAYOUT · pre-stamp · ed9129de (2026-07-23)
  '26005974415ed6250683b20aeb8a57a26c3b3ab160fbe7396fa1e2fd07f3b81f',
  // DEFAULT_LAYOUT · pre-stamp · 4908637a (2026-07-24)
  '12f123fd7e5703947889a10ea4721131d9107eecfbbb79952a0387d92c60bab0',
  // DEFAULT_CONTENT · pre-stamp · beb74066 (2026-07-29, slice A)
  'ddae79484a5696886044a3e3556efdbddfaa7dbb0ed4c20bdb01e37e7d74e56b',
  // DEFAULT_LAYOUT · pre-stamp · beb74066 (2026-07-29, slice A)
  '886b481f5bdede9b3fe769a938642bfac2cae89c25a58e25b7faa663e5307e26',
  // DEFAULT_CONTENT · pre-stamp · b82f0e9c (2026-07-29, slice D)
  '6c2267a9905c7a32e566f60c4edc0c3ed01302df1344ab78b9ed5c208ba98b4b',
  // DEFAULT_LAYOUT · pre-stamp · b82f0e9c (2026-07-29, slice D)
  '4b438bc44fa294616c4c97c467f92d2dd9df3840b4dc99a2800d5595f9e96178',
  // DEFAULT_LAYOUT · pre-stamp · d353b598 (2026-07-29, F2 hardening)
  '58883a7dba6bc4a79a7ef6f664d8d60bc6527ee9a691cc5148c155d5433244b5',
  // DEFAULT_CONTENT · pre-stamp / v5 · 86eb70ef (2026-07-30, slice E) — this is the version frozen on host-c
  '3cba10a8e1c56d7d9b351924d51bbbc56000c9f1e1d7a99e407e0fd72ab87110',
  // DEFAULT_LAYOUT · pre-stamp / v5 · 86eb70ef (2026-07-30, slice E)
  '4596b91a1d67e5053daebfa53ee507e2c6d86aed8dfad136204c18c37ad279fe',
  // DEFAULT_CONTENT_EN · v5 · 37bfad65 (2026-07-30, English codex first release)
  'e5e096367df3d29962d5cc76451736cafc69dff7be70260dfaf7060ca5cfb331',
  // DEFAULT_LAYOUT_EN · v5 · 37bfad65 (2026-07-30, English codex first release)
  '818b6a6e6283692f72e7d28b943fab775314549d974740ec86f4cd7c1d7ef8dc',
  // DEFAULT_CONTENT_EN · v5 · 1f385480 (2026-07-30, English codex review rewrite)
  'd633caae1b52b95197f4f8bcf4da26158dc3bc41f977b2c066d57051aa6b093e',
  // DEFAULT_LAYOUT_EN · v5 · 1f385480 (2026-07-30, English codex review rewrite)
  '37ebeb96db48f47cb62c013df942c7ad40af96743865af2efa23c4bbd6b9a8d2',
  // DEFAULT_CONTENT · v6 · 65773a3b (2026-07-31, slice F)
  'c79a002b043dc4f67d232bb893db7603a6d65c549070a8f3b59954379fe74bb4',
  // DEFAULT_LAYOUT · v6 · 65773a3b (2026-07-31, slice F)
  '84f8d90321a5a2ef2a45dbdea3195ffa5b879c2366fccd1aaf8270fcac434639',
  // DEFAULT_CONTENT_EN · v6 · 65773a3b (2026-07-31, slice F)
  '67289d5390defab0e00294952e8d6f392b11c5ff8a1f0238f58ec47488c86974',
  // DEFAULT_LAYOUT_EN · v6 · 65773a3b (2026-07-31, slice F)
  '7ca5ec511b64f326943913782d2010197625426855b5fa56912894aa33370d0a',
  // DEFAULT_CONTENT · v7 · a2566578 (2026-07-31, slice G) — v8 reuses the same body
  '0d2c5ddfdf75a1f2a27dcc9f24a83894e7e3b3812c462aaf5544f33bd3612f81',
  // DEFAULT_LAYOUT · v7 · a2566578 (2026-07-31, slice G)
  '9681a4a1b7e94270fafd0f493056a95ad1a8197bb27347df4d4e01467d84ef32',
  // DEFAULT_CONTENT_EN · v7 · a2566578 (2026-07-31, slice G) — v8 reuses the same body
  'c038792ac44f87f0f63226e70358b98cc4a02ca3362c308d1347e25a4f7c6dc5',
  // DEFAULT_LAYOUT_EN · v7 · a2566578 (2026-07-31, slice G)
  '5a085de4daa7d3b64fca48b31b6118a519ff3adf8ecb6757f2638326a41d83e9',
  // DEFAULT_LAYOUT · v8 · 8a6cf0cf (2026-07-31, slice I: CSS moved out of the template)
  '55192489b2e8ffe1503f51e082020542156b3087225ee6ea67cecb52ee886336',
  // DEFAULT_LAYOUT_EN · v8 · 8a6cf0cf (2026-07-31, slice I: CSS moved out of the template)
  '8209f635464d3c9fc7557b5ba00967534a3998f32da3e7f7b7548b41c06b9b51',
  // v9 — the last version that had a layout.md at all. Recorded at the v10 cut so
  // a machine still carrying our v9 seed is recognised as ours and reseeded,
  // rather than mistaken for the owner's own writing and frozen forever.
  // DEFAULT_CONTENT · v9 · f0fef7e9 (2026-08-25)
  'cc905f3fdd34cee41b4b67be749b6958a190ef15cd8e463129e31a815f08a4a3',
  // DEFAULT_LAYOUT · v9 · f0fef7e9 (2026-08-25)
  'dd6a9f351872303d81609f42b91c0e04eb08b719f8e0fea7845988bce38c7794',
  // DEFAULT_CONTENT_EN · v9 · f0fef7e9 (2026-08-25)
  '78640b4fb6f59c36a8cc74a242380df88a5d5feee5394e739462e3324f5c1ba0',
  // DEFAULT_LAYOUT_EN · v9 · f0fef7e9 (2026-08-25)
  '28b4324b81e407361f2a340ca1d136cc3d2d3d2af0ebb59c43bd739cb72e6868',
];

/**
 * The fingerprints of the seeds this build ships, derived from the live
 * constants — the half of the table that never needed to be data. Exported so
 * the discipline test pins exactly what the runtime computes, without anyone
 * having to compute a hash by hand.
 */
export const CURRENT_SEED_FINGERPRINTS: Readonly<Record<string, string>> = {
  DEFAULT_CONTENT: sha256(DEFAULT_CONTENT),
  DEFAULT_CONTENT_EN: sha256(DEFAULT_CONTENT_EN),
};

/** Every seed we have ever shipped: the historical record + this build's four. */
const SHIPPED_SEEDS = new Set<string>([
  ...HISTORICAL_SEEDS,
  ...Object.values(CURRENT_SEED_FINGERPRINTS),
]);

/** Per-file seed record, keyed by file basename in `<newspaperDir>/.seed`. */
interface SeedStamp {
  lang: Lang;
  templateVersion: string;
  /** sha256 of exactly what we wrote. Still equal ⇒ the owner never edited it. */
  sha256: string;
}

const SEED_FILE = '.seed';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function readStamps(newspaperDir: string): Record<string, SeedStamp> {
  try {
    const raw: unknown = JSON.parse(readFileSync(resolve(newspaperDir, SEED_FILE), 'utf-8'));
    return raw !== null && typeof raw === 'object' ? (raw as Record<string, SeedStamp>) : {};
  } catch {
    return {}; // absent or corrupt — same meaning: we know nothing about these files
  }
}

/** Seed `file` with `def` and record the stamp. Best-effort: a read-only data
 *  dir must not break the newspaper, it just loses the reseed capability. */
function writeSeed(newspaperDir: string, file: string, def: string, lang: Lang): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, def, 'utf-8');
    const stamps = readStamps(newspaperDir);
    stamps[basename(file)] = { lang, templateVersion: TEMPLATE_VERSION, sha256: sha256(def) };
    writeFileSync(resolve(newspaperDir, SEED_FILE), JSON.stringify(stamps, null, 2), 'utf-8');
  } catch {
    /* best-effort */
  }
}

/**
 * Three branches, and only one of them writes (P-006: an owner's edits are core
 * assets and are never overwritten):
 *
 *  1. no file yet            → seed in the owner's language, stamp it.
 *  2. we wrote what's there  → nobody edited it. If the language or the template
 *     version has moved on (or there's no stamp at all — a pre-stamp install we
 *     recognised by fingerprint), silently reseed and stamp it; otherwise return
 *     it untouched.
 *  3. we don't recognise it  → the owner owns it now. Never touch it.
 *     `newspaperRulesOutdated()` surfaces the drift as a status to-do instead.
 */
function readOrSeed(newspaperDir: string, name: string, lang: Lang): string {
  const file = resolve(newspaperDir, name);
  const def = defaultFor(name, lang);
  if (!existsSync(file)) {
    writeSeed(newspaperDir, file, def, lang);
    return def;
  }
  const current = readFileSync(file, 'utf-8');
  const hash = sha256(current);
  const stamp = readStamps(newspaperDir)[name];
  const stamped = stamp?.sha256 === hash;
  // Neither our stamp nor any seed we ever shipped ⇒ the owner's words. Hands off.
  if (!stamped && !SHIPPED_SEEDS.has(hash)) return current;
  if (stamped && stamp.lang === lang && stamp.templateVersion === TEMPLATE_VERSION) return current;
  writeSeed(newspaperDir, file, def, lang);
  return def;
}

function defaultFor(name: string, lang: Lang): string {
  if (name === STYLE_FILE) return defaultStyleJson();
  if (name === STYLE_README) return lang === 'en' ? STYLE_README_EN : STYLE_README_ZH;
  return lang === 'en' ? DEFAULT_CONTENT_EN : DEFAULT_CONTENT;
}

/**
 * Files the owner has edited whose seed language/version has since moved on —
 * the one case `readOrSeed` deliberately leaves alone. Returns the file names;
 * `[]` (the overwhelmingly common answer) means say nothing.
 */
export function newspaperRulesOutdated(newspaperDir: string, lang: Lang = ownerLang()): string[] {
  const stamps = readStamps(newspaperDir);
  return Object.entries(stamps)
    .filter(([name]) => name !== 'layout.md') // retired in v0.2; `retiredLayoutRules` reports it instead
    .filter(([name, stamp]) => {
      if (stamp.lang === lang && stamp.templateVersion === TEMPLATE_VERSION) return false;
      const file = resolve(newspaperDir, name);
      if (!existsSync(file)) return false;
      const hash = sha256(readFileSync(file, 'utf-8'));
      if (hash === stamp.sha256) return false; // unedited ⇒ next read reseeds it
      return !SHIPPED_SEEDS.has(hash); // a seed of ours ⇒ also reseeded, nothing to report
    })
    .map(([name]) => name);
}

export function readNewspaperContentRules(newspaperDir: string, lang: Lang = ownerLang()): string {
  return readOrSeed(newspaperDir, 'content.md', lang);
}

/**
 * The owner's layout knobs, plus whatever the file got wrong. Seeded on first
 * read alongside its README (JSON cannot carry comments, and a knob nobody can
 * see is not a knob). A file we cannot parse at all falls back to the shipped
 * defaults **and says so** — never a silent default.
 */
export function readNewspaperStyle(
  newspaperDir: string,
  lang: Lang = ownerLang(),
): { style: NewspaperStyle; notes: string[] } {
  readOrSeed(newspaperDir, STYLE_README, lang); // seeded for the owner to read; nothing consumes it
  const notes: string[] = [];
  const raw = readOrSeed(newspaperDir, STYLE_FILE, lang);
  try {
    return { style: resolveStyle(JSON.parse(raw), notes), notes };
  } catch (err) {
    notes.push(`style.json: not valid JSON (${String(err)}) — the whole file was ignored`);
    return { style: DEFAULT_STYLE, notes };
  }
}

/**
 * `layout.md` was retired on 2026-08-25 (v0.2 — the layout is code now). If the
 * owner had **edited** his copy, those edits stopped taking effect that day and
 * he has to be told, in the same place the rest of the newspaper-rules drift is
 * reported. A copy we seeded ourselves is not worth mentioning: he never wrote it.
 */
export function retiredLayoutRules(newspaperDir: string): boolean {
  const file = resolve(newspaperDir, 'layout.md');
  if (!existsSync(file)) return false;
  const hash = sha256(readFileSync(file, 'utf-8'));
  return !SHIPPED_SEEDS.has(hash) && readStamps(newspaperDir)['layout.md']?.sha256 !== hash;
}
