/**
 * lore-house base URL → cache db file slug (without .db).
 * Takes the host (including a non-default port), lowercases it, folds
 * non-alphanumerics to '-', and trims leading/trailing '-'.
 * popclaw.me -> popclaw-me / localhost:8080 -> localhost-8080.
 * The port is included in the slug: multiple local servers (different ports)
 * each get their own independent cache db (P-005 / ADR-0024).
 */
export function hostDbSlug(baseUrl: string): string {
  const u = new URL(baseUrl); // an invalid URL throws TypeError — let the caller handle it
  const hostPort = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return hostPort
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A house name hand-typed by the owner/agent → db slug. A full URL goes
 * through `hostDbSlug`; a bare domain like `popclaw.world` gets folded by the
 * same character rules (→ `popclaw-world`); something that's already a slug is returned as-is.
 */
export function houseRefToSlug(ref: string): string {
  try {
    return hostDbSlug(ref);
  } catch {
    return ref
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}

/**
 * slug → that house's base URL. Missing / unrecognized → `urls[0]` (the home
 * house) — the same fallback as `MultiHouseEgress.pushTo`, so the read and
 * write sides never point at different houses.
 */
export function houseUrlOf(urls: readonly string[], slug: string | undefined): string {
  const hit = slug ? urls.find((u) => hostDbSlug(u) === slug) : undefined;
  return hit ?? urls[0]!;
}
