/**
 * Zero-config default — the public canvas host (ADR-0033: independently deployed, independent origin).
 * Deploy side has been ready since the 2026-07-07 first real deploy
 * (`deploy/docker-compose.yml` `CANVAS_PUBLIC_BASE_URL`, `deploy/Caddyfile`
 * `canvas.{$DOMAIN}`); this default was simply missed when lore-house and web
 * flipped to their public hosts. Local dev overrides via `plugin.json`
 * `canvas_base_url` or `POPCLAW_CANVAS_BASE_URL`.
 */
export const FALLBACK_CANVAS_BASE_URL = 'https://canvas.popclaw.me';

/**
 * Tri-state, deliberately:
 *   `undefined` — the variable is not set at all → fall through to the next source;
 *   `''`        — set, and empty (or blank): the owner said "no publisher";
 *   a value     — the trimmed base URL.
 *
 * Collapsing the first two into one `null` is what made `POPCLAW_CANVAS_BASE_URL=`
 * silently resolve to the public default — the opposite of what typing it means.
 */
export function readCanvasBaseUrlEnv(): string | undefined {
  const raw = process.env.POPCLAW_CANVAS_BASE_URL;
  if (raw === undefined) return undefined;
  return raw.trim();
}

export function normalizeCanvasBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * Resolve the canvas service base URL with precedence: plugin config → env → fallback,
 * where `null` means **there is no publisher**.
 *
 * The plugin config (`plugin.json` `canvas_base_url`) is the authoritative home —
 * like `lore_houses`, it travels with popclaw's own config instead of coupling to the
 * host's process environment. `POPCLAW_CANVAS_BASE_URL` stays as a back-compat / ops
 * override for when no config value is set; the public host is the last resort.
 *
 * The publisher is an owner-level setting and "off" has to be sayable, so an
 * EXPLICIT empty value at either level (config `""`, or the env var set to empty)
 * is answered rather than skipped: it resolves to `null`, and the whole publisher
 * surface — the upload, the doorbell poll, the canvas tools — stands down. Only an
 * ABSENT value falls through. `null`/`undefined` config is "the owner never said",
 * which is absence, not an answer.
 */
export function resolveCanvasBaseUrl(configValue?: string | null): string | null {
  if (configValue !== undefined && configValue !== null) {
    const trimmed = configValue.trim();
    return trimmed ? normalizeCanvasBaseUrl(trimmed) : null;
  }
  const fromEnv = readCanvasBaseUrlEnv();
  if (fromEnv !== undefined) return fromEnv ? normalizeCanvasBaseUrl(fromEnv) : null;
  return normalizeCanvasBaseUrl(FALLBACK_CANVAS_BASE_URL);
}
