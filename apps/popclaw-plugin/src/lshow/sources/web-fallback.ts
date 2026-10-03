// popclaw.me web base URL.
//
// The plugin emits clickable post URLs (`/popclaw post`, draft tools). The
// host part must point at wherever the popclaw.me web app is reachable.
//
// Two-tier resolution (see resolveWebBaseUrl below):
//   1. plugin config `web_base_url`           — authoritative home, travels with
//                                                popclaw's config (not the client env)
//   2. process.env.POPCLAW_WEB_BASE_URL        — back-compat / ops override
//   3. https://popclaw.me                      — the live public web app
//                                                (deployed 2026-07-07)
//
// Dev setups that want local links set `web_base_url` (config) or
// POPCLAW_WEB_BASE_URL (env) to http://localhost:3000 or a LAN address —
// this module no longer auto-detects one.
// See memory popclaw-web-base-url-localhost-mvp.

export const FALLBACK_WEB_BASE_URL = 'https://popclaw.me';

// Read POPCLAW_WEB_BASE_URL env override. Empty / whitespace-only → null.
export function readWebBaseUrlEnv(): string | null {
  const raw = process.env.POPCLAW_WEB_BASE_URL;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Strip a single trailing slash so callers can append `/post/<id>` cleanly.
export function normalizeWebBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

// Resolve the web base URL: plugin config → env → https://popclaw.me.
//
// The plugin config (`plugin.json` `web_base_url`) is the authoritative home —
// like `lore_houses`/`canvas_base_url`, the address travels with popclaw's own
// config instead of depending on the client/host environment. POPCLAW_WEB_BASE_URL
// stays as a back-compat / ops override.
export function resolveWebBaseUrl(configValue?: string | null): string {
  const fromConfig = configValue?.trim();
  if (fromConfig) return normalizeWebBaseUrl(fromConfig);
  const fromEnv = readWebBaseUrlEnv();
  if (fromEnv) return normalizeWebBaseUrl(fromEnv);
  return normalizeWebBaseUrl(FALLBACK_WEB_BASE_URL);
}

// Canonical profile URL (ADR-0032): the sigil is a PATH segment, not a `#`
// fragment — a fragment never reaches the server, so `#sigil` links produce no
// link preview and no server-side disambiguation. Humans still SEE `nickname#sigil`;
// only the URL differs. Single source of truth for every plugin-side profile
// link (status, onboarding sigil card, …).
/**
 * The same URL with its name segment back in its own script — for showing to a
 * human. `profileUrl` stays the canonical wire form (ADR-0032); this is only
 * what the eye reads.
 *
 * The first real user feedback letter we ever received was about this
 * (issue #282): a Chinese nameplate arrived as
 * `popclaw.me/%E9%9D%92%E5%B1%B1.../n3tzfhnt`. Percent-encoding is a wire
 * concern; showing it to the owner is showing them the plumbing.
 *
 * **Unreadable and unsafe are two different things.** A CJK name decodes back;
 * a space does NOT, because a space is where a chat client stops auto-detecting
 * the link — the owner would be handed a URL that breaks when tapped. So the
 * escapes that stand for link-breaking characters are put back.
 *
 * Decoding never throws out of here: a malformed escape falls back to the
 * original run, so the worst case is today's behaviour, never a crashed line.
 */
const LINK_BREAKING = /["#%<>?[\\\]^`{|}/]/;

export function readableUrl(url: string): string {
  return url.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return Array.from(decodeURIComponent(run), (c) => {
        const code = c.charCodeAt(0);
        return code <= 0x20 || code === 0x7f || LINK_BREAKING.test(c) ? encodeURIComponent(c) : c;
      }).join('');
    } catch {
      return run;
    }
  });
}

export function profileUrl(handle: string, sigil: string, base?: string | null): string {
  return `${base ? normalizeWebBaseUrl(base) : resolveWebBaseUrl()}/${encodeURIComponent(handle)}/${sigil}`;
}

/**
 * The canonical address **as it is printed for the owner**: `profileUrl`, read
 * back through `readableUrl`, with the scheme dropped (8 characters saved on a
 * ~30-cell phone line; chat clients still make it clickable).
 *
 * One function, because one person has one address. Status and the namecard
 * used to format it separately and drifted: the namecard hand-built
 * `popclaw.me/<handle>#<sigil>`, a fragment that never reaches a server, and
 * ignored the configured web base. Anything that prints a person's address
 * comes through here.
 */
export function profileLinkText(handle: string, sigil: string, base?: string | null): string {
  return readableUrl(profileUrl(handle, sigil, base)).replace(/^https?:\/\//, '');
}
