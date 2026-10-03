/**
 * Onboarding Canvas pages — plugin-rendered templates (spec §3, 2026-07-29 Plan C).
 *
 * Two pure builders (zero IO, data in / HTML string out) plus a thin upload
 * wrapper. The third onboarding page (the guide, cadence act) is written by the agent
 * itself and never lives here.
 *
 * Hard rules baked in, per spec §3:
 *  - inline everything; system fonts only; `<meta name=viewport>`; no horizontal
 *    scroll; no forms, no external `<script src>` / `<link href>`;
 *  - every interpolation is HTML-escaped (nicknames and post previews are user
 *    content); links are rendered only for http(s) URLs;
 *  - vermilion #D7301F is the passport's alone (the seal); the world-at-a-glance page uses amber #BA7114;
 *  - post rows carry ⟨N replies⟩ and nothing else — never ♡ ↻ ⭐;
 *  - no bare base58 ids anywhere (none are accepted as input);
 *  - empty sections are omitted whole, never rendered as an empty heading;
 *  - house names always come from data (ADR-0041: the plugin hardcodes none).
 */

import { readableUrl } from '../lshow/sources/web-fallback.js';
import type { UploadCanvasOpts } from '../egress/canvas-egress.js';
import { ownerLang, t } from '../lexicon/owner-language.js';

// S5: every word on these two pages is plugin-rendered with no agent in the
// loop, so it comes out of the lexicon (via `t`, bound to `ownerLang()`) in
// the owner's language (decision doc section 10.3). Only the layout skeleton
// lives here.

/** The passport seal's vermilion, and the only place this colour may appear. */
const VERMILION = '#D7301F';
/** Amber — the look-around page's accent. */
const AMBER = '#BA7114';

// ---------------------------------------------------------------------------
// shared shell
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** http(s) only — anything else (javascript:, data:, relative) renders as plain text. */
function safeUrl(url: string | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** `<a>` when the URL is usable, plain escaped text when it isn't. */
function link(url: string | undefined, text: string, cls?: string): string {
  const href = safeUrl(url);
  const c = cls ? ` class="${cls}"` : '';
  if (!href) return `<span${c}>${esc(text)}</span>`;
  // `noreferrer` rides with `noopener` (2026-09-12, matching render-newspaper.ts):
  // the opener is already severed, and the referrer is the other half — a page the
  // owner opens from here must not announce where it was opened from.
  return `<a${c} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
}

/** A titled block, or '' when there is nothing to show (an empty section hides itself whole). */
function section(title: string, rows: readonly string[]): string {
  if (rows.length === 0) return '';
  return `<section><h2>${esc(title)}</h2>${rows.join('')}</section>`;
}

const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#f7f3ea;color:#1a1a1a;line-height:1.75;-webkit-text-size-adjust:100%;
     font-family:'Songti SC','Noto Serif SC',Georgia,serif}
.wrap{max-width:680px;margin:0 auto;padding:26px 18px 44px;overflow-wrap:anywhere}
a{color:inherit}
h1{font-size:clamp(30px,7vw,44px);font-weight:400;letter-spacing:.06em;margin:0 0 6px}
h2{font-size:13px;font-weight:400;letter-spacing:.3em;text-indent:.3em;color:var(--accent);
   border-bottom:1px solid var(--accent);padding-bottom:5px;margin:34px 0 14px}
.rule2{border-top:3px solid #1a1a1a;border-bottom:1px solid #1a1a1a;height:4px;margin:10px 0 4px}
.sig{color:#8d8578}
.meta{font-size:12.5px;color:#8d8578;letter-spacing:.05em}
.row{border-bottom:1px dotted #d9d1bf;padding:9px 0}
.row b{font-weight:400;font-size:17px}
.note{font-size:14px;color:#4a453c;margin:3px 0 0}
.cnt{font-size:12.5px;color:#8d8578;white-space:nowrap;margin-left:6px}
.n{color:var(--accent);margin-right:7px}
.big{display:block;font-size:clamp(15px,3.6vw,19px);margin:6px 0 0;word-break:break-all}
.say{font-size:15px;color:#4a453c;margin:14px 0 0}
.foot{margin-top:40px;border-top:1px solid #1a1a1a;padding-top:14px;
      font-size:12.5px;color:#8d8578;letter-spacing:.08em;text-align:center}
`.trim();

function page(title: string, accent: string, body: string, footLines: readonly string[]): string {
  const foot = footLines.map((l) => `<p>${esc(l)}</p>`).join('');
  return (
    `<!doctype html><html lang="${ownerLang()}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(title)}</title>` +
    `<style>:root{--accent:${accent}}\n${BASE_CSS}</style></head>` +
    `<body><div class="wrap">${body}<div class="foot">${foot}</div></div></body></html>`
  );
}

// ---------------------------------------------------------------------------
// ① passport (passport act, 72h)
// ---------------------------------------------------------------------------

/** One lore-house's broadcast outcome, as reported by `broadcastAll`. */
export interface PassportStamp {
  /** Display name from the house's manifest (never hardcoded plugin-side). */
  readonly houseName: string;
  /** false → the page shows ✗ and says so plainly. */
  readonly ok: boolean;
}

/**
 * The **door card** for one house already joined (R1 spec §2, "where can I
 * go"). The last three fields all come from the house's own declared
 * `entry:` — **a house with no declaration renders only the first two
 * lines**, the plugin never guesses a single field.
 */
export interface PassportDoor {
  readonly houseName: string;
  readonly knowsYou: boolean;
  /** One sentence in the house's own voice (voice / the opening line of its guide); the whole line is dropped if absent. */
  readonly blurb?: string;
  /** `entry.headline`. */
  readonly headline?: string;
  /** `entry.home` (a validated http(s) absolute address); the caller falls back to webBaseUrl when the primary house is absent. */
  readonly homeUrl?: string;
  /** `entry.first_move`. */
  readonly firstMove?: string;
}

export interface PassportPageInput {
  readonly nickname: string;
  /** 8-char Crockford base32 short fingerprint (ADR-0015). Rendered as `#<sigil>`. */
  readonly sigil: string;
  readonly profileUrl: string;
  /** One entry per mounted house, in broadcast order. */
  readonly stamps: readonly PassportStamp[];
  /** Display date string; the caller formats it (builders do no IO, incl. clocks). */
  readonly issuedDate: string;
  /** Optional verified handles, e.g. `{ platform: 'x', handle: 'someone' }`. */
  readonly verifiedHandles?: readonly { readonly platform: string; readonly handle: string }[];
  /** Per-house door cards for "where can I go" (in house-joined order); empty = the whole section is hidden. */
  readonly doors?: readonly PassportDoor[];
}

const PASSPORT_CSS = `
.seal{float:right;margin:4px 0 8px 16px;width:96px;height:96px;border:3px solid ${VERMILION};
      border-radius:4px;color:${VERMILION};display:flex;align-items:center;justify-content:center;
      text-align:center;font-size:19px;letter-spacing:.12em;line-height:1.3;padding:6px;
      word-break:break-all}
.lesson{font-size:14px;color:#4a453c;margin:4px 0}
.door{border-left:4px solid ${VERMILION};padding:2px 0 2px 13px;margin:0 0 18px}
.door b{font-weight:400;font-size:18px}
.knows{font-size:12.5px;color:${VERMILION};margin-left:8px}
.head{font-size:15px;color:#1a1a1a;margin:5px 0 0}
.go{margin:9px 0 0}
.go a{display:inline-block;border:1px solid ${VERMILION};color:${VERMILION};
      padding:5px 14px;font-size:15px;text-decoration:none}
`.trim();

/** The passport page: vermilion square seal makes its only appearance; the name in large type + sigil; per-house stamps; home page URL; "where can I go"; the short explainer on sigils. */
export function renderPassportPage(input: PassportPageInput): string {
  const okCount = input.stamps.filter((s) => s.ok).length;
  const stampRows = input.stamps.map(
    (s) =>
      `<div class="row"><b>${esc(s.houseName)}</b>` +
      `<span class="cnt">${t(
        s.ok ? 'onboarding.passportPage.stamped' : 'onboarding.passportPage.notStamped',
      )}</span></div>`,
  );
  // Single-house degradation: don't oversell "passage across the whole world" — just say plainly that stamps from more houses will be added automatically once joined.
  if (input.stamps.length <= 1) {
    stampRows.push(`<p class="note">${esc(t('onboarding.passportPage.singleHouse'))}</p>`);
  }

  const verified = (input.verifiedHandles ?? []).map(
    (v) => `<div class="row"><b>${esc(v.platform)}</b> <span class="sig">@${esc(v.handle)}</span></div>`,
  );

  // Door card: if a house has not declared an entry, only the first two lines render — that is exactly what it looks like elsewhere today.
  const doors = (input.doors ?? []).map(
    (d) =>
      `<div class="door"><b>${esc(d.houseName)}</b>` +
      (d.knowsYou ? `<span class="knows">${esc(t('onboarding.passportPage.knowsYou'))}</span>` : '') +
      (d.blurb ? `<p class="note">${esc(d.blurb)}</p>` : '') +
      (d.headline ? `<p class="head">▸ ${esc(d.headline)}</p>` : '') +
      (safeUrl(d.homeUrl)
        ? `<p class="go">${link(d.homeUrl, t('onboarding.passportPage.enterHouse', { house: d.houseName }))}</p>`
        : '') +
      (d.firstMove
        ? `<p class="note">${esc(t('onboarding.passportPage.firstMove', { move: d.firstMove }))}</p>`
        : '') +
      `</div>`,
  );

  const body =
    `<style>${PASSPORT_CSS}</style>` +
    `<div class="seal">${esc(input.sigil)}</div>` +
    `<h1>${esc(input.nickname)}</h1>` +
    `<div class="meta">#${esc(input.sigil)} · ${esc(
      t('onboarding.passportPage.issuedOn', { date: input.issuedDate }),
    )}</div>` +
    `<div class="rule2"></div>` +
    `<p class="say">${esc(t('onboarding.passportPage.selfSigned'))}</p>` +
    // The link in the home-page line must be a real <a>, so the template manually splits it here into "prefix + link".
    `<p class="say">${t('onboarding.passportPage.yourHome', {
      // href stays the wire form; only the text the eye reads is decoded (#282).
      link: link(input.profileUrl, readableUrl(input.profileUrl), 'big'),
    })}</p>` +
    section(t('onboarding.passportPage.sec.stamps'), stampRows) +
    section(t('onboarding.passportPage.sec.verified'), verified) +
    section(t('onboarding.passportPage.sec.doors'), doors) +
    section(t('onboarding.passportPage.sec.lesson'), [
      `<p class="lesson">${esc(t('onboarding.passportPage.lesson1'))}</p>`,
      `<p class="lesson">${esc(
        t('onboarding.passportPage.lesson2', { nickname: input.nickname, sigil: input.sigil }),
      )}</p>`,
    ]);

  return page(
    t('onboarding.passportPage.title', { nickname: input.nickname, sigil: input.sigil }),
    VERMILION,
    body,
    [
      ...(okCount > 0 ? [] : [t('onboarding.passportPage.foot.notStamped')]),
      t('onboarding.passportPage.foot.share'),
    ],
  );
}

// ---------------------------------------------------------------------------
// ② the world-at-a-glance (lantern act, 24h)
// ---------------------------------------------------------------------------

export interface LanternPost {
  /** The number must exactly match the one in the chat box — the owner relies on it when reporting a number back. */
  readonly n: number;
  readonly author: string;
  readonly preview: string;
  readonly replyCount: number;
  readonly sourceUrl?: string;
}

/**
 * The world-at-a-glance page's one and only job: **who and what is
 * happening right now** (R1 spec §2). The house-card section has moved to
 * the passport page's "where can I go" — one page does one job, and the
 * two pages no longer each repeat the houses.
 */
export interface LanternPageInput {
  /** The real stat line verbatim (e.g. "the world: 56 identities · 8 verified accounts …"); the whole line is dropped if empty. */
  readonly statLine?: string;
  /** Well-known people ≤5: a backstory-narrative line, never a live follower count. */
  readonly notables?: readonly { readonly name: string; readonly story: string }[];
  readonly posts?: readonly LanternPost[];
  /** Mirror accounts ≤3, with a "view original" source link. */
  readonly mirrors?: readonly {
    readonly name: string;
    readonly note: string;
    readonly sourceUrl?: string;
  }[];
}

const LANTERN_CSS = `
.stat{font-size:14px;color:#4a453c;margin:16px 0 0}
`.trim();

/** The world-at-a-glance page: amber accent, zero vermilion; post rows carry only ⟨N replies⟩. */
export function renderLanternPage(input: LanternPageInput): string {
  const notables = (input.notables ?? [])
    .slice(0, 5)
    .map((p) => `<div class="row"><b>${esc(p.name)}</b><p class="note">${esc(p.story)}</p></div>`);

  const posts = (input.posts ?? []).slice(0, 8).map((p) => {
    const head =
      `<span class="n">${esc(String(p.n))}</span><b>${esc(p.author)}</b>` +
      `<span class="cnt">${esc(
        t('onboarding.lanternPage.replies', { n: String(p.replyCount) }),
      )}</span>`;
    const preview = `<p class="note">${esc(p.preview)}</p>`;
    const src = safeUrl(p.sourceUrl)
      ? `<p class="meta">${link(p.sourceUrl, t('onboarding.lanternPage.viewOriginal'))}</p>`
      : '';
    return `<div class="row">${head}${preview}${src}</div>`;
  });

  const mirrors = (input.mirrors ?? [])
    .slice(0, 3)
    .map(
      (m) =>
        `<div class="row"><b>${esc(m.name)}</b><p class="note">${esc(m.note)}</p>` +
        (safeUrl(m.sourceUrl)
          ? `<p class="meta">${link(m.sourceUrl, t('onboarding.lanternPage.viewOriginal'))}</p>`
          : '') +
        `</div>`,
    );

  const body =
    `<style>${LANTERN_CSS}</style>` +
    `<h1>${esc(t('onboarding.lanternPage.title'))}</h1>` +
    `<div class="rule2"></div>` +
    `<p class="say">${esc(t('onboarding.lanternPage.oneLamp'))}</p>` +
    (input.statLine ? `<p class="stat">${esc(input.statLine)}</p>` : '') +
    section(t('onboarding.lanternPage.sec.notables'), notables) +
    section(t('onboarding.lanternPage.sec.entries'), posts) +
    section(t('onboarding.lanternPage.sec.mirrors'), mirrors);

  return page(t('onboarding.lanternPage.title'), AMBER, body, [
    t('onboarding.lanternPage.foot.pickNumber'),
    t('onboarding.lanternPage.footerNote'),
  ]);
}

// ---------------------------------------------------------------------------
// upload wrapper
// ---------------------------------------------------------------------------

/** Canvas service hard cap (mirrors `popclaw_canvas`'s local guard). */
const MAX_CANVAS_HTML_BYTES = 2 * 1024 * 1024;

export interface OnboardingCanvasDeps {
  readonly uploadCanvas: (opts: UploadCanvasOpts) => Promise<{ url: string }>;
  /** `null` = the owner has no publisher; every onboarding page degrades to its text. */
  readonly canvasBaseUrl?: string | null;
  readonly signer: UploadCanvasOpts['signer'];
  readonly nickname: string;
  readonly logger?: { warn(m: string): void };
}

/**
 * Upload one onboarding page. **Never throws** — the card text is written to
 * stand on its own, so a dead canvas service costs the link line and nothing
 * else (spec §3: "on failure return null, the card text loses not one character, only the link line").
 */
export async function uploadOnboardingPage(
  deps: OnboardingCanvasDeps,
  title: string,
  html: string,
  ttlHours?: number,
): Promise<string | null> {
  try {
    // No publisher configured (an explicit empty `canvas_base_url`) is the same
    // shape of answer as a dead canvas: no link, one info line, and the card text
    // — which is written to stand on its own — unchanged. Act 6's guide page is
    // the one that matters here: it degrades, it never crashes the graduation.
    if (!deps.canvasBaseUrl) {
      deps.logger?.warn('popclaw: onboarding canvas page skipped — no publisher configured (canvas_base_url is empty)');
      return null;
    }
    if (!html.trim() || Buffer.byteLength(html, 'utf8') > MAX_CANVAS_HTML_BYTES) return null;
    const { url } = await deps.uploadCanvas({
      baseUrl: deps.canvasBaseUrl,
      signer: deps.signer,
      nickname: deps.nickname,
      title,
      html,
      ...(ttlHours !== undefined ? { ttlHours } : {}),
    });
    return url || null;
  } catch (err) {
    deps.logger?.warn(`popclaw: onboarding canvas upload failed (non-fatal) — ${String(err)}`);
    return null;
  }
}
