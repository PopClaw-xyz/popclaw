/**
 * Short post references -> full event ids (C3).
 *
 * popclaw_author_latest (and the post receipts) address popclaw-native posts
 * by their canonical human form — `<webBaseUrl>/post/<first 10 hex chars>` —
 * while the wire format is the full 64-hex event_id. An agent that just read
 * a post holds the short form, so reply/quote references given in the short
 * form must resolve back to exactly one full event_id.
 *
 * Binding rules (the approving letter):
 *   - unique match only: 0 or >1 matches -> explicit refusal naming the
 *     absence/ambiguity. Never pick the first match, never guess. A cache
 *     that cannot be READ is its own refusal ("unverifiable", r15): it is
 *     neither a match nor an absence, and uniqueness must not be claimed
 *     over a source that was never really asked. The same holds one step
 *     earlier (r17) when the tool layer's runtime() itself throws and the
 *     cache cannot even be reached.
 *   - trusted sources only: (a) the local world-stream cache (the plugin's
 *     own cached feed), and (b) the exact short-id->event-id mapping observed
 *     by popclaw_author_latest itself — author_latest reads straight from the
 *     lore-house while the local cache can be EMPTY, so searching only the
 *     local cache cannot close this loop. A URL counts only when it points at
 *     the trusted web base (the same `boot.webBaseUrl` the links are printed
 *     with); cross-site URLs are refused, never fetched. The draft-time
 *     resolver may query the existing trusted public thread projection through
 *     an injected read lane when source context is missing. External ids are never treated as
 *     popclaw event ids (mirror rows are filtered out before remembering).
 *   - full 64-hex ids pass through unchanged (legacy calls keep working).
 */

import { getOrCreatePerProcess, resetSingletonForTest } from '../runtime/once.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import type { NativePostSource, PublicPostLookup } from './thread-post-source.js';

/** Minimum hex chars for a bare short reference — the same bar as the /popclaw post CLI's prefix lookup. */
const MIN_PREFIX_CHARS = 6;

/**
 * Bound on the observed-mapping table. author_latest can hand over 100 items
 * per call; the table exists to answer "the post I just read", not to hoard
 * the world — oldest remembered ids are dropped first (Map keeps insertion
 * order), and the local cache remains the long-term source either way.
 */
const MAX_OBSERVED = 1000;

/** short id (10 hex) -> the full 64-hex event ids observed under it (a set because two ids can share a short id). */
type ObservedMap = Map<string, Set<string>>;

/**
 * Process-level, NOT module-level — same mechanism and same reason as the
 * draft table (draft-store.ts): the host reloads the plugin repeatedly, each
 * reload a brand-new module instance, and a mapping remembered by one load
 * must survive into the next one or the short link printed a minute ago
 * stops resolving.
 *
 * Deliberately NOT keyed by webBaseUrl (r17 audit): there is exactly ONE web
 * base per process. Evidence — `resolveWebBaseUrl` runs once in bootRuntime
 * (plugin-bootstrap.ts) off config/env and lands on the immutable
 * `boot.webBaseUrl`; the runtime itself is the process-level singleton
 * (`getOrCreatePerProcess('runtime')`, P-006 §3), so even a host reload
 * reuses the same boot; every /post/ link renderer (author_latest, post
 * receipts, draft preview) reads that same value, regardless of which
 * lore-house relayed the item — a mounted house's own `baseUrl` is its API
 * endpoint, never a web base. A base change therefore requires a new
 * process, which also gives this globalThis table a fresh start: no
 * cross-base contamination window exists. (If a per-house web base ever
 * becomes real, this table and findFullEventId's own keying would need the
 * domain dimension together — not this table alone.)
 */
const observedMap = (): ObservedMap =>
  getOrCreatePerProcess('observed-post-ids', () => new Map() as ObservedMap);

// Exported for test teardown only. DO NOT use from production code.
export const _observedPostIdsForTest = {
  clear: (): void => resetSingletonForTest('observed-post-ids'),
};

/** What a trusted read returns per item — popclaw_author_latest passes its snapshot items straight through. */
export interface ObservedPostItem {
  readonly platform?: string | null;
  readonly platformPostId?: string | null;
}

/**
 * Remember the exact short-id->event-id mapping for the popclaw-native items
 * a trusted read (popclaw_author_latest) just returned. Only platform=
 * 'popclaw' rows with a full 64-hex platformPostId count — on mirror posts
 * platformPostId belongs to the external platform and must never be treated
 * as a popclaw event id.
 */
export function rememberObservedPostIds(items: readonly ObservedPostItem[]): void {
  const map = observedMap();
  for (const it of items) {
    const id = it.platformPostId ?? '';
    if (it.platform !== 'popclaw' || !/^[0-9a-f]{64}$/.test(id)) continue;
    const short = id.slice(0, 10);
    let fulls = map.get(short);
    if (!fulls) {
      if (map.size >= MAX_OBSERVED) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      fulls = new Set<string>();
      map.set(short, fulls);
    }
    fulls.add(id);
  }
}

/** The local-cache seam, duck-typed so partial test wiring degrades to "no cache source" instead of throwing. */
export interface PostRefCache {
  findFullEventId?(prefix: string): { full: string | null; ambiguous: string[] };
  findByEventIdPrefix?(prefix: string): { item: NativePostSource | null; ambiguous: string[] };
}

export interface PostRefSources {
  /**
   * The trusted web base short links are printed with (`boot.webBaseUrl`).
   * Absent (partial test wiring) -> no URL can be verified against anything,
   * so every URL form is refused rather than trusted blindly.
   */
  readonly webBaseUrl?: string;
  /** The local world-stream cache — trusted source (a). */
  readonly cache?: PostRefCache;
  /**
   * r17: the cache could not even be REACHED (the tool layer's `runtime()`
   * threw, so no cache object exists to ask). This is NOT the lenient
   * "unwired" case (a host that genuinely has no cache): the cache exists
   * but cannot be checked, exactly like `unreadable` below — a colliding id
   * it holds would be invisible — so short refs are refused, never signed
   * off the observed mapping alone. Uniqueness must not be claimed over a
   * source that was never asked.
   */
  readonly cacheUnreachable?: boolean;
  /** Exact ids returned by the existing trusted public thread query. */
  readonly publicEventIds?: readonly string[];
}

export type PostRefResolution = { ok: true; eventId: string } | { ok: false; text: string };

/** `${base}/post/<hex>` -> the hex part; null when the URL is not a /post/ link on the trusted base. */
function trustedPostUrlHex(raw: string, webBaseUrl: string): string | null {
  const base = webBaseUrl.replace(/\/+$/, '');
  const prefix = `${base}/post/`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
}

/** One local-cache lookup's outcome. */
type CacheOutcome =
  /** The cache answered; empty ids = it explicitly holds no match for the prefix. */
  | { kind: 'answered'; ids: string[] }
  /** No cache (or no findFullEventId) wired at all — a known condition, not a failure. */
  | { kind: 'unwired' }
  /** The query threw — NOTHING is known about what the cache holds. */
  | { kind: 'unreadable' };

/**
 * Ask the local cache — receiver-bound, always.
 *
 * Real-machine lesson (r15 probe): destructuring `const lookup =
 * cache.findFullEventId` and calling it bare drops `this` — WorldFeedCache
 * reads `this.opts.db`, WorldFeedCatalog reads `this.feeds` — so on the real
 * path every call threw, the catch below swallowed it, and the cache source
 * silently became "no matches": a mapping-observed id then got called UNIQUE
 * while the cache held a colliding id it was never really asked about. Two
 * rules came out of that:
 *   1. the call goes through the receiver (`fn.call(cache, …)`), never bare;
 *   2. a throw is UNREADABLE, not absence — claiming "unique" while the one
 *      source that could hold a collision is unreadable would be a guess, so
 *      the caller refuses instead (Codex ruling: explicit failure, no draft).
 */
function lookupCache(cache: PostRefSources['cache'], prefix: string): CacheOutcome {
  const fn = cache?.findFullEventId;
  if (typeof fn !== 'function') return { kind: 'unwired' };
  try {
    // The cache's own result already folds its ambiguity in: `full` when
    // unique, `ambiguous` listing the colliding ids otherwise. Both go into
    // the same candidate pool — unique-across-both-sources is what counts.
    const r = fn.call(cache, prefix);
    const ids: string[] = [];
    if (r.full) ids.push(r.full);
    for (const a of r.ambiguous) ids.push(a);
    return { kind: 'answered', ids };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** The short-hex leg: validate the shape, then resolve unique-or-refuse. `display` is what error copy names. */
function resolveShortHex(
  hex: string,
  sources: PostRefSources,
  lang: Lang,
  display: string,
): PostRefResolution {
  if (!/^[0-9a-f]+$/.test(hex)) {
    return { ok: false, text: renderCopy(lang, 'draft.postref.notHex', { ref: display }) };
  }
  if (hex.length < MIN_PREFIX_CHARS) {
    return { ok: false, text: renderCopy(lang, 'draft.postref.tooShort', { ref: display }) };
  }
  if (hex.length > 64) {
    return {
      ok: false,
      text: renderCopy(lang, 'draft.postref.tooLong', { len: String(hex.length) }),
    };
  }
  // r17: the tool layer could not reach the cache at all (runtime down) — the
  // same family as `unreadable` below, one step earlier: the source that
  // could hold a collision cannot even be asked. Refuse; never a
  // mapping-only "unique".
  if (sources.cacheUnreachable) {
    return { ok: false, text: renderCopy(lang, 'draft.postref.cacheUnreadable', { ref: display }) };
  }
  const cache = lookupCache(sources.cache, hex);
  // Unreadable cache = uniqueness CANNOT be verified: the cache may hold a
  // colliding id that is invisible right now. Refuse loudly (explicit
  // failure, never a silent mapping-only "unique", never "absent").
  if (cache.kind === 'unreadable') {
    return { ok: false, text: renderCopy(lang, 'draft.postref.cacheUnreadable', { ref: display }) };
  }
  const candidates = new Set<string>(cache.kind === 'answered' ? cache.ids : []);
  for (const fulls of observedMap().values()) {
    for (const id of fulls) if (id.startsWith(hex)) candidates.add(id);
  }
  for (const id of sources.publicEventIds ?? []) {
    if (/^[0-9a-f]{64}$/.test(id) && id.startsWith(hex)) candidates.add(id);
  }
  if (candidates.size === 1) return { ok: true, eventId: [...candidates][0]! };
  if (candidates.size === 0) {
    return { ok: false, text: renderCopy(lang, 'draft.postref.absent', { ref: display }) };
  }
  const list = [...candidates].slice(0, 4).map((id) => `#${id.slice(0, 10)}`).join(', ');
  return {
    ok: false,
    text: renderCopy(lang, 'draft.postref.ambiguous', {
      ref: display,
      count: String(candidates.size),
      list,
    }),
  };
}

/**
 * Resolve one reply/quote reference (raw string as the agent passed it).
 * Order: full 64-hex passes through untouched; a URL is accepted only
 * against the trusted web base (cross-site -> refusal, never a fetch); a
 * bare short id resolves against the trusted sources, unique-or-refuse.
 */
export function resolvePostRef(
  raw: string,
  sources: PostRefSources,
  lang: Lang = ownerLang(),
): PostRefResolution {
  const ref = raw.trim().replace(/^#(?=[0-9a-f]+$)/, '');

  // Legacy wire form: unchanged behavior, and deliberately NO source check —
  // a full id the owner typed by hand works even when no source holds it.
  if (/^[0-9a-f]{64}$/.test(ref)) return { ok: true, eventId: ref };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
    const hex =
      sources.webBaseUrl !== undefined && sources.webBaseUrl !== ''
        ? trustedPostUrlHex(ref, sources.webBaseUrl)
        : null;
    if (hex === null) {
      return {
        ok: false,
        text: renderCopy(lang, 'draft.postref.untrustedUrl', {
          ref,
          web: sources.webBaseUrl || '(unset)',
        }),
      };
    }
    // A full 64-hex inside a trusted-base URL is the same authoritative wire
    // form as a bare full id — passes through, no source check needed.
    if (/^[0-9a-f]{64}$/.test(hex)) return { ok: true, eventId: hex };
    return resolveShortHex(hex, sources, lang, ref);
  }
  return resolveShortHex(ref, sources, lang, ref);
}


export type PostRefWithSource =
  | {readonly ok: true; readonly eventId: string; readonly source: NativePostSource | null}
  | {readonly ok: false; readonly text: string};

/** Fill a missing source at draft time; the normal send path freezes it. */
export async function resolvePostRefWithSource(
  raw: string,
  sources: PostRefSources,
  lookupPublic?: (prefix: string) => Promise<PublicPostLookup>,
  lang: Lang = ownerLang(),
): Promise<PostRefWithSource> {
  const resolution = resolvePostRef(raw, sources, lang);
  const ref = raw.trim().replace(/^#(?=[0-9a-f]+$)/, '');
  const prefix = /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)
    ? sources.webBaseUrl ? trustedPostUrlHex(ref, sources.webBaseUrl) : null : ref;
  // Malformed/cross-site references never reach any network lookup.
  if (!prefix || !/^[0-9a-f]{6,64}$/.test(prefix)) return resolution.ok ? {...resolution, source: null} : resolution;
  if (prefix.length < 64 && (sources.cacheUnreachable || lookupCache(sources.cache, prefix).kind === 'unreadable')) return {ok: false, text: renderCopy(lang, 'draft.postref.cacheUnreadable', {ref})};
  let source: NativePostSource | null = null;
  if (resolution.ok) {
    try { source = sources.cache?.findByEventIdPrefix?.(resolution.eventId).item ?? null; }
    catch { return {ok: false, text: renderCopy(lang, 'draft.postref.cacheUnreadable', {ref})}; }
  }
  if (resolution.ok && source?.houseSlug && source.authorPopclawId && typeof source.textPreview === 'string') return {...resolution, source: {...source}};
  // Partial/legacy roots retain their original no-network resolution behavior.
  if (!lookupPublic) return resolution.ok ? {...resolution, source: source ? {...source} : null} : resolution;
  const result = await lookupPublic(prefix);
  const legacyFull = /^[0-9a-f]{64}$/.test(ref);
  if (!result.ok && resolution.ok && legacyFull) return {...resolution, source: source ? {...source} : null};
  if (!result.ok) return {ok: false, text: renderCopy(lang,
    result.reason === 'ambiguous' ? 'draft.postref.publicAmbiguous' : 'draft.postref.publicUnavailable')};
  const final = resolvePostRef(raw, {...sources, publicEventIds: result.sources.map(s => s.eventId)}, lang);
  if (!final.ok) return result.sources.length === 0 && !resolution.ok
    ? {ok: false, text: renderCopy(lang, 'draft.postref.publicNotFound')} : final;
  const found = result.sources.find(s => s.eventId === final.eventId && s.houseSlug === source?.houseSlug)
    ?? result.sources.find(s => s.eventId === final.eventId);
  if (!found) return resolution.ok && legacyFull ? {...resolution, source: source ? {...source} : null}
    : {ok: false, text: renderCopy(lang, 'draft.postref.publicNotFound')};
  return {...final, source: {...found}};
}
