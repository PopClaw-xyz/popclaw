/**
 * **The newspaper's font stylesheets — one table, every consumer derives from it.**
 *
 * Three places used to carry the same URLs by hand: the zh layout codex, the en
 * codex, and the link-fidelity allowlist. They had to agree character for
 * character — a template prescribing a font the check did not allow got stripped
 * by the "remove & re-render" loop and the paper came out a stub (host-a,
 * 2026-07-29).
 *
 * v0.2 removed two of those three consumers: the codices are gone (the layout is
 * code) and so is the fidelity check (the agent never sees a URL). What the table
 * is for now is narrower and still worth having — `newspaper-style.ts` builds the
 * page's `<link>`s from it, so the URLs live in exactly one place.
 *
 * The masthead faces are here too, as of the zero-dependency pass (owner ruling
 * 2026-09-12). They used to be asked for per issue with `&text=<masthead>`, which
 * bought a 3KB subset instead of a whole display family — and paid for it by
 * putting the name of the owner's own paper in a URL a third party logs. The
 * family link costs more bytes; it tells Google nothing about the issue. Both CJK
 * families are unicode-range chunked upstream, so a browser still only fetches
 * the pieces the page's characters need.
 */
export const FONT_STYLESHEETS = {
  /** zh — KingHwaOldSong: deck names, column heads, headlines. ⚠️ Its @font-face declares the family as `KingHwaOldSong-GB`. */
  kingHwaOldSong: 'https://fontsapi.zeoseven.com/309/gb/result.css',
  /** zh — Huiwen-mincho: body copy and briefs. Only linked when it is the chosen body face. */
  huiwenMincho: 'https://fontsapi.zeoseven.com/256/main/result.css',
  /** zh — LXGW WenKai: the "written by a person" register (letters, quotes, notes). */
  lxgwWenKai: 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-web/lxgwwenkaiscreen/result.css',
  /** zh — Ma Shan Zheng: the masthead, and only the masthead. */
  maShanZheng: 'https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&display=swap',
  /** en — UnifrakturMaguntia: the blackletter masthead, and only the masthead. */
  unifrakturMaguntia: 'https://fonts.googleapis.com/css2?family=UnifrakturMaguntia&display=swap',
  /** Western text, both languages. Separate from the masthead faces: it is the one the body copy is set in. */
  garamond: 'https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..700&display=swap',
} as const;
