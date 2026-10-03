import type { Lang } from '../lexicon/index.js';
import { FONT_STYLESHEETS } from './font-stylesheets.js';
/**
 * The newspaper's style knobs — the one thing the owner gives up when the layout
 * moves into code, handed back as configuration that **actually takes effect**.
 *
 * Before v0.2 the owner tuned the paper by editing `layout.md`, which was read
 * aloud to the model. That was already only half a knob by 2026-07-31 (slice I
 * moved every font, size, colour and spacing into a CSS constant, and layout.md
 * itself said "the styles are injected for you, just use the class names"), and
 * the other half was a request the model might or might not honour. These values
 * are read by the renderer directly and the model never sees them, so editing
 * this file changes the next issue, always.
 *
 * Where it lives: `<data>/newspaper/style.json`, seeded and version-stamped by
 * the same `readOrSeed` machinery as `content.md` (P-006: once the owner edits
 * it, we never overwrite it). `style.README.md` sits beside it because JSON
 * cannot carry comments.
 */

/** A column of a lore-house stack, in the order the codex fixes them. */
export type SectionId =
  /** 0–N headline cards (the front page pulls from here too). */
  | 'leads'
  /** The person-card grid. */
  | 'cards'
  /** The brief-notes column. */
  | 'briefs'
  /** The mantel: one line, "how is my little one doing", four-rung degradation. */
  | 'mantle'
  /** Letters from the world (a lore-house's own official name). */
  | 'letters'
  /** Postcards — picture first, no person card head. */
  | 'postcards'
  /** Chance meetings / gifts / comings and goings, one line each. */
  | 'chron'
  /** Homes worth visiting (and busy places when a lore-house ever publishes them — same skeleton). */
  | 'homes'
  /** Events of a kind we do not recognise, in small print, verbatim. */
  | 'misc';

/**
 * Every column a stack can print, in the order the codex fixes them.
 *
 * ⚠️ This is **one list, not two**. It used to be a switch — a "plain" set and an
 * "embodied" set — chosen by whether the stack carried lore-house events. That
 * silently deleted content in both directions: the owner's own house acquires a
 * mantel the moment any lore-house letter or door card exists for it, which
 * flipped it to the embodied set and **dropped the entire day's posts**; and a
 * lore-house carrying only letters or only a homes list, with no events, stayed
 * on the plain set and printed neither. Every case below is already gated on its
 * own material being non-empty, so a single ordered list is both simpler and the
 * only shape that cannot lose a column.
 */
export const SECTION_ORDER: readonly SectionId[] = [
  'mantle',
  'leads',
  'letters',
  'postcards',
  'chron',
  'cards',
  'homes',
  'briefs',
  'misc',
];
const ALL_SECTIONS = new Set<string>(SECTION_ORDER);

/**
 * Stack accents after the two we name ourselves, in order, cycling when they run
 * out. Copied verbatim from the codex (layout §0.2) — the owner tuned these.
 */
export const ACCENT_CYCLE: readonly string[] = ['#3f5f3a', '#8a5a2b', '#5c3a5e', '#2a3a5c'];

export type BodyFont = 'huiwen' | 'lxgw' | 'garamond' | 'system';

/** A fully resolved style — every field present, every value already checked. */
export interface NewspaperStyle {
  /** Multiplies every type size on the page. 0.7–1.6; 1 = the sizes the owner signed off on. */
  fontScale: number;
  /** The face the body text is set in. Chinese only — English is always EB Garamond. */
  bodyFont: BodyFont;
  /** The paper's default accent, and the `me` stack's. `#rrggbb`. */
  accent: string;
  /** lore-house slug → its accent. A slug not listed takes the next colour off ACCENT_CYCLE. */
  houseAccents: Readonly<Record<string, string>>;
  /** Stack order by slug. Empty = by item count, descending (the old behaviour). */
  deckOrder: readonly string[];
  /** lore-house slug → which columns it prints, in order. A slug not listed uses the built-in order for its kind. */
  sections: Readonly<Record<string, readonly SectionId[]>>;
  /**
   * Ceiling on how tall a picture may stand, in px. The codex is explicit that a
   * picture is an inset, never the screen — and with the layout in code that is
   * this file's job now, not the model's: an ordinary portrait video thumbnail
   * runs 700x1000 in a 2fr column and pushes the headline clean off the page.
   */
  figMax: number;
  /** Front-page headline cards. 0 = no front page at all. */
  leadMax: number;
  /** Person cards per stack, before the rest fall through to the brief column. */
  cardMax: number;
  /** Print the brief-notes column at all. */
  briefs: boolean;
  /** Print "today's cast" at the foot of the paper. */
  roster: boolean;
  /** Print the new-faces board. */
  newbieBoard: boolean;
  /** Print the anchor index bar under the masthead. */
  index: boolean;
}

export const DEFAULT_STYLE: NewspaperStyle = {
  fontScale: 1,
  bodyFont: 'huiwen',
  accent: '#9b1c1c',
  houseAccents: { 'house-popclaw-me': '#9b1c1c', 'house-popclaw-world': '#1f4e79' },
  deckOrder: [],
  sections: {},
  figMax: 420,
  leadMax: 3,
  cardMax: 30,
  briefs: true,
  roster: true,
  newbieBoard: true,
  index: true,
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const BODY_FONTS = new Set<BodyFont>(['huiwen', 'lxgw', 'garamond', 'system']);

/**
 * Read a style object the owner may have got wrong in any number of ways.
 *
 * **Never rejects the whole file.** A bad value falls back to the default and is
 * named in `notes`, which the publish receipt prints — silently ignoring an edit
 * would be the exact failure this feature exists to end ("I changed it and
 * nothing happened"). An unknown key is reported too, so a typo doesn't read as
 * a knob that does not work.
 */
export function resolveStyle(raw: unknown, notes: string[] = []): NewspaperStyle {
  const src = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(src)) {
      if (!(k in DEFAULT_STYLE)) notes.push(`style.json: unknown key "${k}" (ignored)`);
    }
  } else if (raw !== undefined) {
    notes.push('style.json: not an object — the whole file was ignored');
  }

  const bad = (key: string, why: string): void => {
    notes.push(`style.json: ${key} ${why} — using the default`);
  };
  const num = (key: 'fontScale' | 'leadMax' | 'cardMax' | 'figMax', lo: number, hi: number): number => {
    const v = src[key];
    if (v === undefined) return DEFAULT_STYLE[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      bad(key, `must be a number between ${lo} and ${hi}`);
      return DEFAULT_STYLE[key];
    }
    return v;
  };
  const bool = (key: 'briefs' | 'roster' | 'newbieBoard' | 'index'): boolean => {
    const v = src[key];
    if (v === undefined) return DEFAULT_STYLE[key];
    if (typeof v !== 'boolean') {
      bad(key, 'must be true or false');
      return DEFAULT_STYLE[key];
    }
    return v;
  };
  const colour = (key: string, v: unknown, fallback: string): string => {
    if (typeof v !== 'string' || !HEX.test(v)) {
      bad(key, 'must be a colour like "#9b1c1c"');
      return fallback;
    }
    return v;
  };

  let bodyFont = DEFAULT_STYLE.bodyFont;
  if (src.bodyFont !== undefined) {
    if (typeof src.bodyFont === 'string' && BODY_FONTS.has(src.bodyFont as BodyFont)) {
      bodyFont = src.bodyFont as BodyFont;
    } else {
      bad('bodyFont', `must be one of ${[...BODY_FONTS].join(' / ')}`);
    }
  }

  const houseAccents: Record<string, string> = { ...DEFAULT_STYLE.houseAccents };
  if (src.houseAccents !== undefined) {
    if (src.houseAccents !== null && typeof src.houseAccents === 'object' && !Array.isArray(src.houseAccents)) {
      for (const [slug, v] of Object.entries(src.houseAccents as Record<string, unknown>)) {
        houseAccents[slug] = colour(`houseAccents["${slug}"]`, v, DEFAULT_STYLE.houseAccents[slug] ?? DEFAULT_STYLE.accent);
      }
    } else {
      bad('houseAccents', 'must be an object of slug → colour');
    }
  }

  let deckOrder = DEFAULT_STYLE.deckOrder;
  if (src.deckOrder !== undefined) {
    if (Array.isArray(src.deckOrder) && src.deckOrder.every((s) => typeof s === 'string')) {
      deckOrder = src.deckOrder as string[];
    } else {
      bad('deckOrder', 'must be a list of lore-house slugs');
    }
  }

  const sections: Record<string, readonly SectionId[]> = {};
  if (src.sections !== undefined) {
    if (src.sections !== null && typeof src.sections === 'object' && !Array.isArray(src.sections)) {
      for (const [slug, v] of Object.entries(src.sections as Record<string, unknown>)) {
        if (!Array.isArray(v)) {
          bad(`sections["${slug}"]`, 'must be a list of column names');
          continue;
        }
        const kept = v.filter((c): c is SectionId => typeof c === 'string' && ALL_SECTIONS.has(c));
        for (const c of v) {
          if (!kept.includes(c as SectionId)) notes.push(`style.json: sections["${slug}"] — no such column "${String(c)}" (ignored)`);
        }
        sections[slug] = kept;
      }
    } else {
      bad('sections', 'must be an object of slug → list of column names');
    }
  }

  return {
    fontScale: num('fontScale', 0.7, 1.6),
    bodyFont,
    accent: src.accent === undefined ? DEFAULT_STYLE.accent : colour('accent', src.accent, DEFAULT_STYLE.accent),
    houseAccents,
    deckOrder,
    sections,
    figMax: Math.floor(num('figMax', 80, 2000)),
    leadMax: Math.floor(num('leadMax', 0, 6)),
    cardMax: Math.floor(num('cardMax', 0, 200)),
    briefs: bool('briefs'),
    roster: bool('roster'),
    newbieBoard: bool('newbieBoard'),
    index: bool('index'),
  };
}

/**
 * Which accent a stack prints in: what the owner named for it, else the next
 * unclaimed colour off the cycle. Deterministic in `slugs` order so the same
 * issue always paints the same way.
 */
export function accentsFor(slugs: readonly string[], style: Pick<NewspaperStyle, 'houseAccents'>): Record<string, string> {
  const out: Record<string, string> = {};
  let next = 0;
  for (const slug of slugs) {
    const named = style.houseAccents[slug];
    out[slug] = named ?? ACCENT_CYCLE[next++ % ACCENT_CYCLE.length]!;
  }
  return out;
}

/** Which columns a stack prints, in which order: what the owner named for it, else the built-in order. */
export function sectionsFor(slug: string, style: NewspaperStyle): readonly SectionId[] {
  return style.sections[slug] ?? SECTION_ORDER;
}

/**
 * The font stylesheets the page links.
 *
 * The masthead face used to be asked for **by the characters it had to draw**:
 * `&text=<masthead>` bought the five glyphs of one issue's own name in 2,980
 * bytes instead of the 6.1MB of a whole CJK handwriting family (measured
 * 2026-08-26). It also meant every reader's browser told Google what the owner's
 * paper is called, one issue at a time — a saved page is supposed to depend on
 * nobody, and above all to tell nobody what is in it (owner ruling 2026-09-12).
 * So the family is asked for by name now. It costs more bytes and leaks nothing.
 *
 * `masthead` still decides **whether** the display face is linked at all: a paper
 * with no name on it has nothing to set in it.
 *
 * The CJK families are unicode-range chunked upstream, so a browser only fetches
 * the pieces the issue's own characters need (measured: ~50 chunks each).
 * `bodyFont: 'system'` drops one of them entirely.
 */
export function fontLinks(lang: Lang, style: NewspaperStyle, masthead = ''): readonly string[] {
  const garamond = FONT_STYLESHEETS.garamond;
  if (lang === 'en') {
    return masthead ? [garamond, FONT_STYLESHEETS.unifrakturMaguntia] : [garamond];
  }
  const links: string[] = [FONT_STYLESHEETS.kingHwaOldSong, FONT_STYLESHEETS.lxgwWenKai, garamond];
  if (masthead) links.push(FONT_STYLESHEETS.maShanZheng);
  // Huiwen-mincho is only pulled when it is actually the body face — a font the page never sets is a wasted round trip on a bad connection.
  if (style.bodyFont === 'huiwen') links.splice(1, 0, FONT_STYLESHEETS.huiwenMincho);
  return links;
}

/**
 * The last rungs of every CJK stack: the faces a machine with no web fonts — the
 * `fonts: 'system'` reader, or anyone opening the paper offline — actually has.
 * macOS ships Songti/PingFang, Windows ships SimSun/YaHei, a Linux desktop with
 * any CJK support at all ships Noto. Without these a page that fails to reach the
 * font CDN sets its Chinese in whatever the browser's default happens to be,
 * which on a bare Linux box is nothing at all.
 */
const CJK_FALLBACK = `'Songti SC','Noto Serif SC','Noto Sans CJK SC','SimSun','PingFang SC','Microsoft YaHei'`;

const BODY_STACK: Record<BodyFont, string> = {
  // '\u601D\u6E90\u5B8B\u4F53' is Source Han Serif's Chinese name; some installs register it only under that.
  huiwen: `'EB Garamond','Huiwen-mincho','\u601D\u6E90\u5B8B\u4F53',${CJK_FALLBACK},Georgia,serif`,
  lxgw: `'EB Garamond','LXGW WenKai Screen','Kaiti SC','KaiTi',${CJK_FALLBACK},Georgia,serif`,
  garamond: `'EB Garamond',Georgia,${CJK_FALLBACK},serif`,
  system: `${CJK_FALLBACK},Georgia,serif`,
};

/** Round to 2dp and drop a trailing `.0` — keeps the CSS readable when fontScale is 1. */
const px = (base: number, scale: number): string => `${Math.round(base * scale * 100) / 100}px`;

/**
 * The page's whole stylesheet, built from the style. One class vocabulary for
 * both languages: before v0.2 the English template used its own class names
 * (`.section` / `.folio` / `.rail`) so that an English-writing model would reach
 * for English words — nobody writes these class names any more, so the two
 * dictionaries are one, and the languages differ only in faces and base size.
 *
 * ⚠️ Every size here traces back to the issue the owner signed off on
 * (2026-08-25 15:00). `fontScale` multiplies them; nothing else should move.
 */
export function buildCss(lang: Lang, style: NewspaperStyle): string {
  const en = lang === 'en';
  const s = style.fontScale;
  const serif = en ? `'EB Garamond',Georgia,'Times New Roman',serif` : BODY_STACK[style.bodyFont];
  // 'KingHwaOldSong-GB' is the family name the CDN actually declares (verified
  // 2026-08-26: its stylesheet has exactly one @font-face, under that name). The
  // bare 'KingHwaOldSong' this inherited from v9 matched nothing — CSS family
  // matching is exact — so every heading on every issue has been falling back to
  // the system serif since the face was introduced. Both names are listed so an
  // install that has the font locally under either one still gets it.
  const disp = en ? `'EB Garamond',Georgia,'Times New Roman',serif` : `'EB Garamond','KingHwaOldSong-GB','KingHwaOldSong',${CJK_FALLBACK},Georgia,serif`;
  const kai = en ? `'EB Garamond',Georgia,serif` : `'EB Garamond','LXGW WenKai Screen','Kaiti SC','KaiTi',${CJK_FALLBACK},Georgia,serif`;
  const masthead = en ? `'UnifrakturMaguntia','EB Garamond',Georgia,serif` : `'Ma Shan Zheng','KingHwaOldSong-GB','KingHwaOldSong','KaiTi',${CJK_FALLBACK},Georgia,serif`;
  return `<style>
:root{--paper:#f7f3ea;--ink:#1a1a1a;--ink2:#4a453c;--ink3:#8d8578;--rule:#d9d1bf;--accent:${style.accent};
      --serif:${serif};--disp:${disp};--kai:${kai};--masthead:${masthead}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--serif);
     font-size:${px(en ? 17 : 15.5, s)};line-height:${en ? 1.55 : 1.7};-webkit-text-size-adjust:100%}
.wrap{max-width:1180px;margin:0 auto;padding:22px 18px 60px;overflow-x:hidden}
a{color:inherit}
.masthead{text-align:center;padding:8px 0 0}
.masthead h1{font-size:clamp(${px(en ? 40 : 44, s)},7.6vw,${px(en ? 74 : 80, s)});font-weight:400;letter-spacing:${en ? '.02em' : '.12em'};margin:0 0 6px;
             text-indent:${en ? '0' : '.12em'};font-family:var(--masthead)}
.rule2{border-top:3px solid var(--ink);border-bottom:1px solid var(--ink);height:4px;margin:6px 0}
.dateline{display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:center;
          font-size:${px(12.5, s)};color:var(--ink3);letter-spacing:.06em;padding:4px 0 8px}
.weather{font-size:${px(13, s)};color:var(--ink2);text-align:center;letter-spacing:.04em;padding:0 0 6px}
.index{display:flex;flex-wrap:wrap;gap:4px 14px;justify-content:center;font-size:${px(12.5, s)};
       border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);padding:7px 0;margin-bottom:26px}
.index a{color:var(--ink2);text-decoration:none;border-bottom:1px dotted var(--rule)}
.kicker{font-size:${px(13.5, s)};letter-spacing:.34em;text-indent:.34em;color:var(--accent);font-family:var(--disp);
        border-bottom:2px solid var(--accent);padding-bottom:5px;margin:34px 0 16px;font-weight:400}
.kicker span{float:right;letter-spacing:.06em;color:var(--ink3);font-size:${px(12, s)};font-family:var(--serif)}
.deck{margin-top:44px;border-top:2px solid var(--ink)}
.deckhead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;
          border-left:7px solid var(--accent);padding:12px 0 12px 14px;margin-bottom:4px}
.deckhead b{font-size:${px(23, s)};letter-spacing:.1em;font-weight:400;font-family:var(--disp)}
.deckhead em{font-style:normal;font-size:${px(12, s)};color:var(--ink3);margin-left:auto;letter-spacing:.06em}
.voice{font-size:${px(14, s)};color:var(--ink2);font-family:var(--kai);
       border-bottom:1px solid var(--rule);padding-bottom:12px;margin-bottom:20px}
.lead{border-top:1px solid var(--rule);padding-top:18px;margin-bottom:26px}
.lead h2{font-size:clamp(${px(24, s)},3.5vw,${px(33, s)});line-height:1.35;margin:10px 0 12px;font-weight:400;font-family:var(--disp)}
.grid{display:grid;gap:20px 0;grid-template-columns:repeat(auto-fill,minmax(min(100%,250px),1fr));
      margin-left:-1px;overflow:hidden}
.card{border-left:1px solid var(--rule);border-top:1px solid var(--rule);padding:12px 16px 0}
.card h3{font-size:${px(18, s)};line-height:1.45;margin:8px 0 6px;font-weight:400;font-family:var(--disp)}
.briefs{display:grid;gap:2px 26px;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));
        font-size:${px(14, s)};line-height:1.55;border-top:1px solid var(--rule);padding-top:12px}
.brief{padding:4px 0;border-bottom:1px dotted var(--rule)}
.brief img{width:16px;height:16px;border-radius:50%;vertical-align:-3px;margin-right:5px;object-fit:cover}
.who{display:flex;align-items:center;gap:9px;flex-wrap:wrap;text-decoration:none}
/* The card byline row: the .who anchor plus the doorbell chip beside it. The
   chip must never be INSIDE the anchor (invalid nesting; its click would
   navigate), so the row repeats the anchor's own flex line around both. */
.who-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.who img{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:none}
.who b{font-size:${px(17, s)};letter-spacing:.02em}
.who .sig{color:var(--ink3);font-weight:400}
.meta{font-size:${px(11.5, s)};color:var(--ink3);letter-spacing:.03em}
.tag{font-size:${px(10.5, s)};color:var(--ink3);border:1px solid var(--rule);border-radius:2px;padding:1px 5px}
.tag.hot{color:var(--accent);border-color:var(--accent)}
/* The doorbell chip: a real button, dressed as quietly as a tag. It is the
   page's one interactive control, so it gets the affordances a button owes
   (pointer, hover, a disabled face) and nothing louder. */
.follow-btn{font:inherit;font-size:${px(11, s)};color:var(--ink2);background:none;border:1px solid var(--rule);
            border-radius:2px;padding:1px 7px;cursor:pointer}
.follow-btn:hover{border-color:var(--accent);color:var(--accent)}
.follow-btn[disabled]{color:var(--ink3);cursor:default}
.brief .follow-btn{font-size:${px(10, s)};padding:0 5px}
.brief .tag{font-size:${px(10, s)};padding:0 4px}
/* The transient two-line strip the script shows after a successful ring. */
.follow-strip{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:var(--ink);color:var(--paper);
              font-size:${px(12.5, s)};line-height:1.6;padding:8px 16px;text-align:center;z-index:9;border-radius:3px}
.masthead-owner{font-size:${px(12.5, s)};color:var(--ink3);letter-spacing:.06em;padding-bottom:6px}
.body{display:block;color:inherit;text-decoration:none;margin:8px 0 10px}
.body p{margin:0 0 8px}
.drop::first-letter{float:left;font-size:4.1em;line-height:.86;padding:2px 9px 0 0;color:var(--accent);font-weight:700}
.pull{border-left:3px solid var(--accent);margin:16px 0;padding:2px 0 2px 14px;
      font-size:${px(18, s)};color:var(--ink2);font-family:var(--kai)}
.foot{display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:8px 0 14px;font-size:${px(12, s)}}
.btn{display:inline-block;border:1px solid var(--rule);border-radius:3px;padding:3px 9px;
     text-decoration:none;color:var(--ink2);white-space:nowrap}
.cnt{color:var(--ink3);margin-left:auto}
img.fig{max-width:100%;max-height:${px(style.figMax, 1)};width:auto;height:auto;object-fit:cover;display:block;border:1px solid var(--rule);margin:10px 0}
.lead img.fig{max-height:${px(Math.round(style.figMax * 1.35), 1)}}
/* Phone: one column, in DOM order — awaiting reply, then the lead stories, then
   the rest of the ear. Desktop: the two ear rails move into the right-hand column
   by grid placement, never by reversing the CSS order property (codex 2). */
.top{display:grid;gap:26px;grid-template-columns:1fr}
@media(min-width:900px){
  .top{grid-template-columns:2fr 1fr;grid-template-areas:"lead rail-a" "lead rail-b"}
  .top .lead-col{grid-area:lead}
  .top .rail-a{grid-area:rail-a}
  .top .rail-b{grid-area:rail-b;align-self:start}
}
/* A second item from the same person, appended under their one card head. */
.also{border-top:1px dotted var(--rule);padding-top:8px;margin-top:4px;font-size:${px(14, s)}}
.also a{text-decoration:none}
.also b{font-weight:400;color:var(--accent);margin-right:5px}
.ear{border:1px solid var(--accent);padding:14px 16px;margin-bottom:20px}
.ear h4{margin:0 0 10px;font-size:${px(13.5, s)};letter-spacing:.3em;text-indent:.3em;color:var(--accent);
        font-family:var(--disp);font-weight:400}
.ear .row{border-top:1px dotted var(--rule);padding:7px 0;font-size:${px(14, s)};font-family:var(--kai)}
.ear .row:first-of-type{border-top:0}
.why{display:block;font-size:${px(11.5, s)};color:var(--accent);margin-top:2px}
.latest{display:block;font-size:${px(13, s)};color:var(--ink2);margin-top:2px}
.note{display:block;font-size:${px(13, s)};color:var(--ink2);font-family:var(--kai);
      border-left:2px solid var(--rule);padding:2px 0 2px 10px;margin-top:6px;background:rgba(255,255,255,.3)}
.xref{display:block;font-size:${px(12, s)};color:var(--ink3);margin-top:4px}
.chron{list-style:none;padding:0;margin:0;border-top:1px solid var(--rule)}
.chron li{padding:9px 0 9px 20px;border-bottom:1px dotted var(--rule);position:relative;
          font-size:${px(15, s)};font-family:var(--kai)}
.chron li::before{content:"";position:absolute;left:2px;top:17px;width:7px;height:7px;
                  border:1px solid var(--accent);border-radius:50%}
.place h3{font-family:var(--kai);font-weight:400;font-size:${px(19, s)};margin:4px 0 6px}
.place p{font-size:${px(13.5, s)};margin:0 0 8px;color:var(--ink2)}
.mantle{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-family:var(--kai);font-size:${px(16, s)};
        border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);padding:11px 0;margin-bottom:20px}
.mantle .src{font-size:${px(11.5, s)};color:var(--ink3);font-family:var(--serif);margin-left:auto}
.doorplate{border:1px dashed var(--accent);padding:14px 16px;margin:14px 0;font-family:var(--kai);font-size:${px(15, s)}}
.doorplate b{display:block;font-size:${px(18, s)};font-weight:400;margin-bottom:8px}
.newbie{display:flex;gap:14px;border-top:1px solid var(--rule);padding:16px 0;align-items:flex-start}
.newbie img.av{width:48px;height:48px;border-radius:50%;object-fit:cover;flex:none}
.newbie>div{flex:1;min-width:0}
.newbie .bio{font-size:${px(13.5, s)};color:var(--ink2);margin:3px 0}
.roster{display:flex;flex-wrap:wrap;gap:9px 16px;border-top:1px solid var(--rule);padding-top:14px;font-size:${px(13, s)}}
.roster a{display:flex;align-items:center;gap:5px;text-decoration:none;color:var(--ink2)}
.roster img{width:20px;height:20px;border-radius:50%;object-fit:cover}
.end{text-align:center;color:var(--ink3);font-size:${px(12.5, s)};margin-top:46px;
     border-top:1px solid var(--ink);padding-top:16px;letter-spacing:.1em}
</style>`;
}

/**
 * The seeded `style.json`. Written out with the defaults spelled in full rather
 * than as an empty object: a knob the owner cannot see is a knob he does not have.
 */
export function defaultStyleJson(): string {
  return `${JSON.stringify(DEFAULT_STYLE, null, 2)}\n`;
}
