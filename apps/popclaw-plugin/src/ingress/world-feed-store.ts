import type { ExecutionStoreCatalog } from '../host/execution-store.js';
/**
 * openWorldFeedStore — connect a lore-house's world stream cache (P-005/ADR-0024).
 * Derives the host slug, opens data/lorehouses/<slug>.db (reusing LocalHostDb to keep the
 * better-sqlite3 boundary, ADR-0013), ensures the table. "Connect a new server =
 * open a new <host>.db" is exactly this factory — from spec B slice② onward,
 * boot calls this once per house in `lore_houses`, and the N caches are handed
 * to `WorldFeedCatalog` to merge into a single read-side view.
 */
import type { HostDb } from '../host/host-db.js';
import { LocalHostDb } from '../host/local-host-db.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import { normalizeHouseOrigin } from '../runtime/house-lifecycle/control-client.js';
import { hostDbSlug } from './host-slug.js';
import { WorldFeedCache } from './world-feed-cache.js';

/** An already-connected house: slug (per-house db ownership) + baseUrl (stream/snapshot) + its own cache. */
export interface HouseStore {
  readonly slug: string;
  /**
   * The house's CANONICAL origin — lowercased host, no trailing slash, no
   * path — never the raw `lore_houses` string. Everything downstream either
   * looks a house up under this spelling (the pin table, the execution
   * catalog, `HouseRuntime`'s own store map) or builds `${baseUrl}/v1/…`
   * from it. `openWorldFeedStore` is where that conversion happens.
   */
  readonly baseUrl: string;
  readonly cache: WorldFeedCache;
  readonly dbPath: string;
  /** This house's own SQLite handle — must be closed on gateway shutdown (gateway_stop). */
  readonly db: HostDb;
  /** Personally owned execution connection, owned/closed by the shared catalog. No cache fallback. */
  readonly executionDb?: HostDb;
  readonly executionError?: string;
  readonly cacheReadOnly?: boolean;
}
export function executionDbFor(house: HouseStore): HostDb {
  if (!house.executionDb) throw new Error(house.executionError ?? 'EXECUTION_STORE_UNAVAILABLE');
  return house.executionDb;
}

export async function openWorldFeedStore(
  baseUrl: string,
  paths: PopclawPaths,
  debug?: (msg: string) => void,
  executionStores?: ExecutionStoreCatalog,
): Promise<HouseStore> {
  // THE boundary where a configured house address becomes an origin.
  //
  // `config.lore_houses` is validated by `z.string().url()` and nothing else,
  // so `https://house.popclaw.me/` and `https://House.PopClaw.me` arrive
  // verbatim — and the store is where they enter the rest of the plugin:
  // `relation-reception` attaches under `baseUrl`, so `originBySlug` in the
  // relation host held whatever was typed, while the pin those lookups need
  // is filed under the CANONICAL origin (migration 034: "Canonical origin,
  // no trailing slash, no path"; `HouseRuntime` normalises before it binds).
  // `pinnedBinding` and `handleStillTrusted` are exact `WHERE origin = ?`, so
  // a raw spelling refused the attach, failed every later trust re-check, and
  // made the gap-recovery sweep skip its house in silence. Converting here
  // rather than at each consumer is the same rule the read resolver and the
  // strict slug map already follow: written once, it cannot be forgotten by
  // the next consumer.
  //
  // An address with no canonical form THROWS, deliberately, and is not a
  // second failure mode: `HouseRuntime`'s constructor normalises the same
  // configured list and throws on the same input, and it is constructed
  // before any store is opened in all three roots (src/index.ts 412 before
  // 498, src/mcp.ts 229 before 280, src/main.ts 149 before 197 and 457
  // before its `openStore`) — so boot has already refused such a house, and
  // this can only ever agree.
  const origin = normalizeHouseOrigin(baseUrl);
  // PopclawPaths is the single source of truth for the on-disk lore-house cache
  // location (<root>/data/lorehouses/<slug>.db). LocalHostDb mkdir -p's the parent.
  const slug = hostDbSlug(origin);
  let executionDb: HostDb | undefined;
  let executionError: string | undefined;
  let cacheReadOnly = false;
  let dbPath = paths.lorehouseDb(slug);
  if (executionStores) {
    try { executionDb = executionStores.open(origin).db; }
    catch (error) { executionError = String(error); debug?.(`execution store (${slug}): ${executionError}`); }
    const projection = executionStores.cacheProjection(origin);
    dbPath = projection.path; cacheReadOnly = projection.readOnly;
  }
  const db = new LocalHostDb(dbPath, {readOnly: cacheReadOnly}); // creates parent dir if missing
  const cache = new WorldFeedCache(debug ? { db, debug } : { db });
  try { if (!cacheReadOnly) await cache.start(); }
  catch (error) { db.close(); throw error; }
  return { slug, baseUrl: origin, cache, dbPath, db, ...(executionDb ? {executionDb} : {}),
    ...(executionError ? {executionError} : {}), ...(cacheReadOnly ? {cacheReadOnly} : {}) };
}

/**
 * Open each house in config order (`lore_houses`, with `[0]` as the home house).
 *
 * **The home house is a hard dependency: if it can't be opened, throw
 * immediately.** Without this, if the home house falls behind, `[0]` silently
 * becomes a secondary house, `catalog.home()` drifts along with it — and slice
 * ③ "original posts go to the home house" would post to the wrong house.
 * Only a secondary house failing to open degrades gracefully: just that one
 * drops, the rest still connect (`onError` logs one line).
 */
export async function openHouseStores(
  urls: readonly string[],
  paths: PopclawPaths,
  opts: { executionStores?: ExecutionStoreCatalog; debug?: (msg: string) => void; onError?: (url: string, err: unknown) => void } = {},
): Promise<HouseStore[]> {
  if (urls.length === 0) throw new Error('config.lore_houses must have at least one URL');
  const out: HouseStore[] = [];
  for (const [i, url] of urls.entries()) {
    try {
      out.push(await openWorldFeedStore(url, paths, opts.debug, opts.executionStores));
    } catch (err) {
      if (i === 0) throw new Error(`home lore-house ${url} unavailable — ${String(err)}`);
      opts.onError?.(url, err);
    }
  }
  return out;
}
