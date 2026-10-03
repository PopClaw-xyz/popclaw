/**
 * Manifest client (ADR-0041's house-handshake first hop)
 *
 * `GET <house root>/v1/manifest`, supports `If-None-Match` conditional
 * requests. Error-handling style follows GuideClient: network failure /
 * non-2xx / bad JSON → `unavailable`, **never throw** — one house going down
 * must not knock over startup or the scheduler (loose coupling is this
 * protocol's first goal).
 *
 * Parsing is deliberately very lenient (ADR-0003 additive superset): we only
 * consume official_ids / guide_url / house.name / house.slug — unknown fields
 * are always ignored, missing fields always get a default. Full schema
 * validation of the manifest is **the house's own** job (validated on
 * lore-house startup); the client doesn't act as a second referee — otherwise
 * a house adding one field could brick every old plugin install.
 *
 * `read_auth` is NOT read here. This fetch is the lenient one: no proof header,
 * conditional requests, a cached body served under a 304. A declaration that
 * decides which credential a read carries comes out of the verified manifest
 * instead — see `house-read-declaration.ts`.
 */

/** The three states of a conditional GET. 304 vs "couldn't fetch" must be kept separate: the former means the cache is still fresh. */
export type ConditionalResult =
  | { readonly status: 'ok'; readonly etag?: string; readonly text: string }
  | { readonly status: 'not_modified' }
  | { readonly status: 'unavailable' };

export interface ConditionalGetOptions {
  readonly etag?: string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  /** Timeout cap; defaults to 10s. On the daily-paper path the owner is waiting, so that call passes 3s. */
  readonly timeoutMs?: number;
}

/** Same as the other clients: 10s cap, a stuck house must not hold up the handshake. */
const TIMEOUT_MS = 10_000;

/** Conditional GET with ETag support; shared by both the manifest and the guide fetch paths. */
export async function conditionalGet(
  url: string,
  opts: ConditionalGetOptions = {},
): Promise<ConditionalResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  try {
    const res = await fetchFn(url, {
      ...(opts.etag ? { headers: { 'if-none-match': opts.etag } } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    if (res.status === 304) return { status: 'not_modified' };
    if (!res.ok) return { status: 'unavailable' };
    const etag = res.headers.get('etag');
    const text = await res.text();
    return { status: 'ok', ...(etag ? { etag } : {}), text };
  } catch {
    return { status: 'unavailable' };
  }
}

/** The four fields from the manifest that we actually consume. */
export interface HouseManifestFacts {
  readonly houseName: string;
  readonly houseSlug: string;
  readonly officialIds: readonly string[];
  /** Guide address; absolute or relative to the house root, either works (resolved in house-handshake). Missing = this house has no guide. */
  readonly guideUrl?: string;
}

export type HouseManifestResult =
  | { readonly status: 'ok'; readonly etag?: string; readonly manifest: HouseManifestFacts }
  | { readonly status: 'not_modified' }
  | { readonly status: 'unavailable' };

export async function fetchHouseManifest(
  houseBaseUrl: string,
  opts: ConditionalGetOptions = {},
): Promise<HouseManifestResult> {
  const url = `${houseBaseUrl.replace(/\/$/, '')}/v1/manifest`;
  const res = await conditionalGet(url, opts);
  if (res.status !== 'ok') return res;
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    return { status: 'unavailable' };
  }
  const doc = (raw ?? {}) as Record<string, unknown>;
  const house = (doc.house ?? {}) as Record<string, unknown>;
  const guideUrl = typeof doc.guide_url === 'string' ? doc.guide_url.trim() : '';
  const manifest: HouseManifestFacts = {
    houseName: typeof house.name === 'string' ? house.name : '',
    houseSlug: typeof house.slug === 'string' ? house.slug : '',
    officialIds: Array.isArray(doc.official_ids)
      ? doc.official_ids.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [],
    ...(guideUrl ? { guideUrl } : {}),
  };
  return { status: 'ok', ...(res.etag ? { etag: res.etag } : {}), manifest };
}
