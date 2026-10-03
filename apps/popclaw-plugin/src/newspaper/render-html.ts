/** HTML escaping, safe links and image attributes shared by newspaper renderers. */
/**
 * Escape for HTML text and attributes. **Takes `undefined`**: every field here is
 * typed required, but the lore-house ones arrive from a server we do not control
 * and are read back through `JSON.parse` with no schema check — one omitted field
 * would otherwise throw and the owner would get no paper at all.
 */
export const esc = (s?: string): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `<a>` or nothing. An empty href yields the inner content unwrapped rather than
 * a dead link — the codex's "omit it, never compose one" rule, enforced at the
 * one place every link on the page goes through.
 *
 * **Only http(s).** Door plates, letter links and ping links are copied verbatim
 * out of a remote lore-house or an inbound message; the finished page is then
 * published to the canvas and opened by the owner. "The href only ever comes from
 * the materials" is not the same as "the materials are safe" — a `javascript:`
 * url in a lore-house field would otherwise become a live link on his page.
 */
export const a = (href: string | undefined, inner: string, cls = ''): string =>
  href && /^https?:\/\//i.test(href)
    ? `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    // No link, but the class is still load-bearing: `.who` IS the flex row, so
    // dropping the element entirely leaves a card head with no layout at all —
    // a natural-size avatar dumped above the name. Someone with no popclaw_id has
    // no page to point at (that is what the roster gap discloses), which makes
    // this an ordinary case, not an edge one.
    : cls
      ? `<span class="${cls}">${inner}</span>`
      : inner;

/**
 * A remote image. Always lazy, always hides itself on failure — never a broken
 * frame on the owner's page — and always `no-referrer`.
 *
 * The referrer is the point of `NO_REFERRER` (owner ruling 2026-09-12): a post's
 * picture may go on being fetched from the platform it was posted to, because
 * that is what makes the saved page look like the hosted one. What the platform
 * must not learn is **where it was fetched from** — a canvas URL is a capability,
 * and on a local file the path is the owner's own disk. The `<meta>` in the head
 * says the same thing for the whole document; this says it per element, so an
 * `<img>` lifted out of the page keeps the promise with it.
 */
export const NO_REFERRER = ' referrerpolicy="no-referrer"';

export const img = (src: string, cls = ''): string =>
  src
    ? `<img${cls ? ` class="${cls}"` : ''} src="${esc(src)}"${NO_REFERRER} loading="lazy" onerror="this.style.display='none'">`
    : '';

/** Percent-decoded display text for a link, href left byte-for-byte alone (codex §7). */
export function linkText(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

/** A column head. `h3` because the codex fixes the hierarchy at h1 masthead > h2 headline > h3 column (§8). */
export function head3(label: string, right = '', anchor = ''): string {
  return `<h3 class="kicker"${anchor ? ` id="${anchor}"` : ''}>${esc(label)}${right ? `<span>${esc(right)}</span>` : ''}</h3>`;
}
