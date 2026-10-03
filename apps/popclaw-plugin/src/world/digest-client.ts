/**
 * Newspaper digest client (slice G; verdict `2026-07-31-world-section-verdict.md` §3).
 *
 * A house declares `newspaper.digest_url` in its guide frontmatter (optionally with a
 * `{popclaw_id}` placeholder). We fetch it **at the moment the paper gathers**, cache it
 * to disk and revalidate with an ETag. ADR-0035: the register/boot path never touches it.
 *
 * Same discipline as the house handshake:
 *  1. **Never guess a path.** No declaration = no digest (the mantel falls back to tiers
 *     ②-⑤, the homes column stays out), and the paper comes out as usual.
 *  2. **Never take the paper down with it.** 3s ceiling; network failure / non-2xx / bad
 *     JSON all degrade silently to the on-disk cache. **No path throws.**
 *  3. **Print what you were given.** Fields follow the shape the house actually shipped
 *     (timestamps are ISO strings, `me` is `{figures:[…]}`). `owner.popclaw_id` shipped
 *     2026-07-31T07:32 (verified against a live pull) — optional, parsed when present.
 *     A missing required field drops the whole card; unknown fields are ignored
 *     (ADR-0003, additive superset).
 *
 * The types deliberately keep the house's snake_case wire names: this document is stored
 * verbatim and then passed through to the agent nearly unchanged, so renaming would only
 * add a mapping table to keep in sync.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import { conditionalGet } from './manifest-client.js';
import { parseGuideFrontmatter } from './guide.js';

/** The digest is fetched on the paper's path, with the owner waiting — 3s or it never happened. */
const TIMEOUT_MS = 3_000;
/** Cap on homes per issue (the house already caps at 6; this is the client-side second gate). */
const MAX_HOMES = 6;

/**
 * How the owner's own figure(s) are doing. The `away` field names were verified against the
 * house's own source (`lib/world/digest.ts`) and guide §2.
 */
export interface DigestFigure {
  readonly figure: string;
  readonly state: 'away' | 'home';
  /** away = where it went; home = where it lives. `null` from the house means "not given". */
  readonly city?: string;
  /** Day N of the trip — the house computed it; the paper never computes its own. */
  readonly day?: number;
  readonly postcards_sent?: number;
  readonly postcards_total?: number;
  /** Return time, ISO string. Already past = in practice on its way home (guide §2). */
  readonly return_at?: string;
  /** The doorplate (guide §2.5: public, permanent — never the key home). */
  readonly visit_url?: string;
}

/** One "home worth visiting" card. `owner.popclaw_id` shipped 2026-07-31T07:32 — the
 *  house now puts it in (the doc is no longer anonymous-only); still optional, since
 *  older cached digests and any future house that omits it must keep degrading, not
 *  breaking. */
export interface DigestHome {
  readonly name: string;
  readonly visit_url: string;
  readonly cover_img?: string;
  readonly voice?: string;
  readonly built_at?: string;
  readonly visits_today?: number;
  readonly owner: {
    readonly nickname?: string;
    readonly sigil?: string;
    readonly popclaw_id?: string;
    readonly display?: string;
  };
}

export interface WorldDigest {
  /** As-of timestamp given by the house (ISO string). Any number the paper prints cites it. */
  readonly as_of: string;
  /** The ranking basis **verbatim**. The paper reproduces it and never composes a ranking. */
  readonly ranking_basis?: string;
  /**
   * The same statement in the house's own other languages, keyed by BCP-47 tag. The house
   * writing its own English beats anything we could translate for it, so when the tag the
   * owner reads is in here, that is what the paper prints. Absent → the paper falls back to
   * the writer's translation of `ranking_basis`, and failing that to `ranking_basis` itself.
   */
  readonly ranking_basis_i18n?: Readonly<Record<string, string>>;
  readonly figures: readonly DigestFigure[];
  readonly homes: readonly DigestHome[];
}

/** On-disk cache record (snake_case = file format). */
interface DigestCacheRecord {
  readonly etag?: string;
  readonly fetched_at: number;
  readonly digest: WorldDigest;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function figureOf(raw: unknown): DigestFigure | undefined {
  const f = (raw ?? {}) as Record<string, unknown>;
  const figure = str(f.figure);
  const state = f.state === 'away' || f.state === 'home' ? f.state : undefined;
  if (!figure || !state) return undefined; // no name or no state → this one stays out, never guessed
  return {
    figure,
    state,
    ...opt('city', str(f.city)),
    ...opt('day', num(f.day)),
    ...opt('postcards_sent', num(f.postcards_sent)),
    ...opt('postcards_total', num(f.postcards_total)),
    ...opt('return_at', str(f.return_at)),
    ...opt('visit_url', str(f.visit_url)),
  };
}

function homeOf(raw: unknown): DigestHome | undefined {
  const h = (raw ?? {}) as Record<string, unknown>;
  const name = str(h.name);
  const visitUrl = str(h.visit_url);
  // Name and doorplate are this card's life: no name and it cannot be set, no doorplate and
  // the "pay a visit" button is dead.
  if (!name || !visitUrl) return undefined;
  const o = (h.owner ?? {}) as Record<string, unknown>;
  return {
    name,
    visit_url: visitUrl,
    ...opt('cover_img', str(h.cover_img)),
    ...opt('voice', str(h.voice)),
    ...opt('built_at', str(h.built_at)),
    ...opt('visits_today', num(h.visits_today)),
    owner: {
      ...opt('nickname', str(o.nickname)),
      ...opt('sigil', str(o.sigil)),
      ...opt('popclaw_id', str(o.popclaw_id)),
      ...opt('display', str(o.display)),
    },
  };
}

function opt<K extends string, V>(k: K, v: V | undefined): Record<K, V> | Record<string, never> {
  return v === undefined ? {} : ({ [k]: v } as Record<K, V>);
}

/** JSON text → digest. Bad JSON / not an object / no `as_of` → null (rather nothing than half-trusted). */
export function parseDigest(text: string): WorldDigest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  const asOf = str(doc.as_of);
  if (!asOf) return null; // without an as-of there is no honest way to cite this data
  const me = (doc.me ?? {}) as Record<string, unknown>;
  const figures = (Array.isArray(me.figures) ? me.figures : [])
    .map(figureOf)
    .filter((f): f is DigestFigure => !!f);
  const homes = (Array.isArray(doc.homes) ? doc.homes : [])
    .map(homeOf)
    .filter((h): h is DigestHome => !!h)
    .slice(0, MAX_HOMES);
  const i18n: Record<string, string> = {};
  const rawI18n = doc.ranking_basis_i18n;
  if (rawI18n !== null && typeof rawI18n === 'object' && !Array.isArray(rawI18n)) {
    for (const [tag, v] of Object.entries(rawI18n as Record<string, unknown>)) {
      const line = str(v);
      if (line) i18n[tag] = line;
    }
  }
  return {
    as_of: asOf,
    ...opt('ranking_basis', str(doc.ranking_basis)),
    ...(Object.keys(i18n).length ? { ranking_basis_i18n: i18n } : {}),
    figures,
    homes,
  };
}

/** Whatever is in the on-disk cache; absent / corrupt → undefined (never throws). */
export function readCachedDigest(paths: PopclawPaths, slug: string): WorldDigest | undefined {
  return readCacheRecord(paths, slug)?.digest;
}

function readCacheRecord(paths: PopclawPaths, slug: string): DigestCacheRecord | undefined {
  try {
    return JSON.parse(readFileSync(paths.houseDigestFile(slug), 'utf8')) as DigestCacheRecord;
  } catch {
    return undefined;
  }
}

export interface DigestDeps {
  readonly paths: PopclawPaths;
  readonly slug: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/**
 * Fetch (or ETag-revalidate) one house's digest. **Never throws, never blocks the issue**:
 * a fresh document is cached and returned; failing that the cache is returned; failing that,
 * `undefined`.
 */
export async function refreshHouseDigest(
  url: string,
  deps: DigestDeps,
): Promise<WorldDigest | undefined> {
  const prev = readCacheRecord(deps.paths, deps.slug);
  try {
    const res = await conditionalGet(url, {
      ...(prev?.etag ? { etag: prev.etag } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      timeoutMs: TIMEOUT_MS,
    });
    if (res.status !== 'ok') return prev?.digest; // 304 / unreachable → the cache stands
    const digest = parseDigest(res.text);
    if (!digest) return prev?.digest; // bad JSON never overwrites a good previous document
    const rec: DigestCacheRecord = {
      ...(res.etag ? { etag: res.etag } : {}),
      fetched_at: (deps.now ?? Date.now)(),
      digest,
    };
    try {
      mkdirSync(dirname(deps.paths.houseDigestFile(deps.slug)), { recursive: true });
      writeFileSync(deps.paths.houseDigestFile(deps.slug), JSON.stringify(rec, null, 2), 'utf8');
    } catch {
      /* a read-only data dir must not cost the paper a column — this issue uses what we just got */
    }
    return digest;
  } catch {
    return prev?.digest; // backstop: the digest is a bonus, never a dependency
  }
}

/**
 * A house's self-declared digest address (the cached guide's `newspaper.digest_url`), with
 * `{popclaw_id}` substituted for the owner's name. This is the single policy gate:
 *  - http(s) only (the guide is an external document; it must never become a reader for
 *    arbitrary local files);
 *  - no popclaw_id yet → do not send the request at all (a URL with an empty placeholder
 *    means nothing to the house);
 *  - not declared / never handshaken → `undefined`. **Never guess a path.**
 */
export function readHouseDigestUrl(
  paths: PopclawPaths,
  slug: string,
  ownerPopclawId: string,
): string | undefined {
  if (!ownerPopclawId) return undefined;
  let raw: string | undefined;
  try {
    const md = readFileSync(paths.houseGuideFile(slug), 'utf8');
    raw = parseGuideFrontmatter(md).frontmatter?.newspaper?.digestUrl?.trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const url = raw.replaceAll('{popclaw_id}', encodeURIComponent(ownerPopclawId));
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
