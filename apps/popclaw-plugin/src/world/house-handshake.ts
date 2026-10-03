/**
 * House-mounting handshake (ADR-0041) — the client-side half of "mount a house, know how to play."
 *
 * The owner adds a house to `lore_houses` → the plugin reads its manifest
 * (`/v1/manifest`, A-1) → if the manifest declares a `guide_url`, it fetches
 * that **guide written for the agent to read** and saves it to disk →
 * the `popclaw_world_guide` tool hands it to the agent along with everything
 * else. A house changing its rules of play only means changing its own
 * documentation — **the plugin never needs a release, and no house name ever
 * appears in the plugin's code**.
 *
 * The cache lives under `data/lorehouses/` (a regenerable layer — delete it,
 * restart, and it comes back; it never goes in the vault):
 *  - `<slug>.handshake.json` — manifest summary + two ETags;
 *  - `<slug>.guide.md` — the guide's body text (only present if the house declared a guide_url).
 *
 * Three rules of discipline:
 *  1. **Never guess a path.** No declared guide_url means no guide — the
 *     standard lore-house's `/v1/guide.md` endpoint serves the documentation
 *     baked into the popclaw.me binary, which is the wrong content for a
 *     third-party house; falling back to it is worse than having nothing.
 *  2. **One house going down only drops that house.** Nothing in the flow
 *     throws; a failure logs one line (loose coupling is this protocol's
 *     first goal: a bad neighbor must not drag down startup or the scheduler).
 *  3. **A 304 on the manifest still re-validates the guide.** The two ETags
 *     are each managed independently — a house updating only its guide
 *     without touching its manifest is the normal case, and is exactly the
 *     "publish and it takes effect" path this is meant to support.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { conditionalGet, fetchHouseManifest } from './manifest-client.js';
import { parseGuideFrontmatter, type HouseEntry } from './guide.js';
import { ownerLang } from '../lexicon/owner-language.js';
import type { Lang } from '../lexicon/index.js';
import { assertActionActive } from '../runtime/house-lifecycle/action-context.js';

/**
 * Pick the lane's value for a house field that may be declared twice
 * (`voice` / `voice_en`, `headline` / `headline_en`, …).
 *
 * **Absent `_en` falls back to the base key** — that is what makes these keys
 * additive: a house that never declares them (and every house frozen into an
 * older plugin package) behaves exactly as it did before. A declared-but-
 * illegal value is a different case and is *not* rescued by the base key; the
 * caps below drop it, same as they would drop an illegal base value.
 */
function laneValue(base: string | undefined, en: string | undefined, lang: Lang): string | undefined {
  return lang === 'en' && en !== undefined ? en : base;
}

/** headline cap (truncated if over). It's a single line, not a paragraph. */
const HEADLINE_MAX = 40;
/** first_move cap (over the cap → **the whole line is not rendered**) — a long sentence isn't a one-liner prompt, it's a smuggled instruction. */
const FIRST_MOVE_MAX = 20;

/** Guide size cap: it's the agent's context, not a data warehouse.
 *  ponytail: capped by character count (not bytes) — a multi-byte document is
 *  actually slightly under 256KB in practice; the goal is a ceiling, not precision. */
const GUIDE_MAX_CHARS = 256 * 1024;

/** The handshake record as persisted to disk (snake_case: this is a file format, not an internal type). */
export interface HouseHandshakeRecord {
  readonly manifest_etag?: string;
  readonly house_name: string;
  readonly official_ids: readonly string[];
  /** Already resolved to an absolute URL relative to the house root; missing = this house has no guide. */
  readonly guide_url?: string;
  readonly guide_etag?: string;
  /**
   * `read_auth.schemes` is deliberately NOT kept here.
   *
   * It was, and this file is the reason it could not stay: this cache is
   * written from an ordinary conditional GET that never reads
   * `X-Popclaw-Manifest-Proof`, and a 304 keeps a record whose provenance
   * nobody re-established. A declaration that decides which credential goes
   * to a house has to come from the same verified response as the key that
   * house is pinned to, so it lives in `house-read-declaration.ts`, projected
   * inside the transaction that commits the binding.
   */
  readonly fetched_at: number;
}

export interface HandshakeDeps {
  readonly paths: PopclawPaths;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Fetch for the declared guide document only. A guide may live on another
   * origin (ADR-0041), which the house-bound `fetch` refuses by design; the
   * roots pass the lifecycle's document lane here. Falls back to `fetch`.
   */
  readonly guideFetch?: typeof globalThis.fetch;
  readonly logger?: { info(m: string): void; warn(m: string): void };
  readonly now?: () => number;
}

/** Read a house's handshake cache; missing / bad file → null (never throws). */
export function readHouseHandshake(
  paths: PopclawPaths,
  slug: string,
): HouseHandshakeRecord | null {
  try {
    return JSON.parse(readFileSync(paths.houseHandshakeFile(slug), 'utf8')) as HouseHandshakeRecord;
  } catch {
    return null;
  }
}

/**
 * Mirrors `send-draft-subject.ts`'s (module-private) `MAX_LABEL_CODE_POINTS`:
 * a house-supplied name is unverified remote text, and past this it stops
 * being a name and starts being a paragraph pushed into a receipt.
 */
const MAX_HOUSE_NAME_CODE_POINTS = 64;

/** Unicode control (Cc) and format (Cf) characters, plus the line/paragraph
 *  separators (Zl/Zp) — the invisible-formatting characters a house's
 *  self-reported name must not carry into a receipt rendered by a bare
 *  string substitution (`renderCopy` escapes nothing). */
const INVISIBLE_FORMATTING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A house's self-reported name (`manifest-client.ts` stores `house.name` as
 * written, `readHouseHandshake` returns it unchanged), made safe to render
 * verbatim in an owner-facing ✓ receipt: whitespace runs (CR/LF/tabs
 * included — `\s` already covers the Zl/Zp line/paragraph separators too)
 * collapsed to one space FIRST, then any remaining invisible formatting
 * character removed outright (never turned into a space — by this point
 * only non-whitespace Cc/Cf survive, e.g. a bare NUL or a zero-width space,
 * which carry no visible content to preserve a gap for), trimmed, and capped
 * at `MAX_HOUSE_NAME_CODE_POINTS` code points. A house is otherwise free to
 * inject line breaks or a very long string into the receipt — fake rows,
 * instructions aimed at the agent reading it.
 */
function cleanHouseName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').replace(INVISIBLE_FORMATTING, '').trim();
  const points = [...collapsed];
  return points.length <= MAX_HOUSE_NAME_CODE_POINTS
    ? collapsed
    : `${points.slice(0, MAX_HOUSE_NAME_CODE_POINTS).join('')}…`;
}

/**
 * The name to show the owner for a house identified only by its slug: its
 * own self-reported name (handshake cache) when set — cleaned, since it is
 * unverified remote text — else the host of the origin the current
 * configuration still maps that slug to (e.g. "popclaw.me"), else undefined.
 * A slug is a cache-file key, never a name — found leaking into an
 * owner-facing follow/unfollow receipt in acceptance on package 4d07af17
 * ("house-popclaw-me" instead of "popclaw.me").
 */
export function houseDisplayName(
  paths: PopclawPaths,
  houseUrls: readonly string[],
  slug: string,
): string | undefined {
  const named = readHouseHandshake(paths, slug)?.house_name;
  if (named) {
    const cleaned = cleanHouseName(named);
    if (cleaned) return cleaned;
  }
  const url = houseUrls.find((u) => hostDbSlug(u) === slug);
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** A house's guide body text as saved to disk; no handshake yet / house didn't declare guide_url → null (never guess a path). */
export function readHouseGuide(paths: PopclawPaths, slug: string): string | null {
  try {
    return readFileSync(paths.houseGuideFile(slug), 'utf8');
  } catch {
    return null;
  }
}

/**
 * A house's **one-line self-description** — the `voice` field in the saved
 * guide's frontmatter. The daily paper's house-manifest line copies it
 * verbatim, without rewriting a single word (however the house describes
 * itself is exactly how it appears in print). No handshake yet / no such line
 * → '', and the whole line is omitted.
 */
export function readHouseVoice(paths: PopclawPaths, slug: string, lang: Lang = ownerLang()): string {
  const md = readHouseGuide(paths, slug);
  if (!md) return '';
  const fm = parseGuideFrontmatter(md).frontmatter;
  return laneValue(fm?.voice, fm?.voiceEn, lang)?.trim() ?? '';
}

/**
 * A house's self-reported **first thing to do** (R1 spec §1) — the `entry:`
 * field in the saved guide's frontmatter. Parsed on read, no new field
 * persisted. **Zero declaration → undefined**, and every surface behaves
 * exactly as it did before this protocol existed: the plugin never guesses
 * anything on its own (no prefix concatenation, no well-known-path guessing).
 *
 * This is the one and only policy checkpoint (the parser only carries the literal text):
 *  - `home` only allow-lists http(s) (same validation as `guide_url`);
 *    relative addresses resolve against the house root, and with no house
 *    root given, only absolute addresses are accepted — this door is for the
 *    owner to click, and must not become an entry point into arbitrary local files;
 *  - `headline` is truncated past 40 chars; `first_move` past 20 chars has **the whole line dropped** (guards against smuggled instructions).
 *
 * `headline` / `first_move` may each be declared twice — the base key and an
 * `_en` variant — and the owner's language picks the lane (`laneValue`). The
 * caps apply **after** the pick and are identical for both lanes: an English
 * spell over 20 chars is dropped exactly as a Chinese one is. A house that
 * declares no `_en` key reads exactly as it did before these keys existed,
 * which is what lets houses adopt them one at a time.
 */
export function readHouseEntry(
  paths: PopclawPaths,
  slug: string,
  houseUrl?: string,
  lang: Lang = ownerLang(),
): HouseEntry | undefined {
  const md = readHouseGuide(paths, slug);
  const raw = md ? parseGuideFrontmatter(md).frontmatter?.entry : undefined;
  if (!raw) return undefined;
  const home = httpUrlOf(raw.home?.trim(), houseUrl);
  // The lane is picked first, then the caps apply to whatever was picked: an
  // over-long `first_move_en` is dropped exactly as an over-long `first_move`
  // is, and never quietly falls back to the other language's line.
  const headline = laneValue(raw.headline, raw.headlineEn, lang)?.trim().slice(0, HEADLINE_MAX);
  const firstMove = laneValue(raw.firstMove, raw.firstMoveEn, lang)?.trim();
  const recipe = raw.recipe?.trim();
  const entry: HouseEntry = {
    ...(home ? { home } : {}),
    ...(headline ? { headline } : {}),
    ...(firstMove && firstMove.length <= FIRST_MOVE_MAX ? { firstMove } : {}),
    ...(recipe ? { recipe } : {}),
  };
  return Object.keys(entry).length > 0 ? entry : undefined;
}

/**
 * Fetch (or re-validate) a house's manifest and guide. Never throws, never blocks the caller.
 */
export async function refreshHouseHandshake(houseUrl: string, deps: HandshakeDeps): Promise<void> {
  const log = deps.logger ?? { info: () => {}, warn: () => {} };
  try {
    assertActionActive();
    const slug = hostDbSlug(houseUrl);
    const prev = readHouseHandshake(deps.paths, slug);
    const res = await fetchHouseManifest(houseUrl, {
      etag: prev?.manifest_etag,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    assertActionActive();

    if (res.status === 'unavailable') {
      log.info(`popclaw: handshake — could not fetch [${slug}]'s manifest, skipping (cache unchanged)`);
      return;
    }
    if (res.status === 'not_modified' && prev === null) return; // 304 but no cache: nothing to work with

    const now = deps.now ?? Date.now;
    // 304 → keep the old record (the guide still needs re-validation); 200 → rewrite from the new manifest.
    let rec: HouseHandshakeRecord;
    if (res.status === 'ok') {
      const guideUrl = guideUrlOf(res.manifest.guideUrl, houseUrl, slug, log);
      rec = {
        ...(res.etag ? { manifest_etag: res.etag } : {}),
        house_name: res.manifest.houseName,
        official_ids: [...res.manifest.officialIds],
        ...(guideUrl ? { guide_url: guideUrl } : {}),
        fetched_at: now(),
      };
    } else {
      rec = prev!;
    }

    // Guide address changed → the old ETag is invalidated (an ETag is issued per-resource,
    // it can't be reused across URLs). The body file being deleted also invalidates it:
    // only by omitting If-None-Match can we get a 200 back instead of a 304 forever
    // (data/ is a regenerable layer, and "delete it, restart, and it comes back" is its promise).
    const guideEtag =
      rec.guide_url === prev?.guide_url && existsSync(deps.paths.houseGuideFile(slug))
        ? prev?.guide_etag
        : undefined;
    if (rec.guide_url) {
      const guideFetch = deps.guideFetch ?? deps.fetch;
      const g = await conditionalGet(rec.guide_url, {
        etag: guideEtag,
        ...(guideFetch ? { fetch: guideFetch } : {}),
      });
      assertActionActive();
      if (g.status === 'ok') {
        let body = g.text;
        if (body.length > GUIDE_MAX_CHARS) {
          log.warn(
            `popclaw: handshake — [${slug}]'s guide is ${body.length} chars, over the ${GUIDE_MAX_CHARS} cap, truncated`,
          );
          body = body.slice(0, GUIDE_MAX_CHARS);
        }
        writeFileAtomicish(deps.paths.houseGuideFile(slug), body);
        rec = { ...rec, ...(g.etag ? { guide_etag: g.etag } : {}) };
        log.info(`popclaw: handshake — [${slug}]'s guide updated (${body.length} chars)`);
      } else if (g.status === 'not_modified') {
        rec = { ...rec, ...(guideEtag ? { guide_etag: guideEtag } : {}) };
      } else {
        log.info(`popclaw: handshake — could not fetch [${slug}]'s guide (cache unchanged)`);
        rec = { ...rec, ...(guideEtag ? { guide_etag: guideEtag } : {}) };
      }
    }

    assertActionActive();
    writeFileAtomicish(deps.paths.houseHandshakeFile(slug), JSON.stringify(rec, null, 2));
  } catch (err) {
    // Fallback: the handshake is a nice-to-have, never let it drag down startup or a timer.
    log.warn(`popclaw: handshake failed (non-fatal) ${houseUrl} — ${String(err)}`);
  }
}

/**
 * `guide_url` → absolute URL. Relative addresses resolve against the house
 * root; only http/https are allow-listed — the guide is an external document
 * fed to the agent, and must not become a read port into arbitrary local files.
 */
function guideUrlOf(
  raw: string | undefined,
  houseUrl: string,
  slug: string,
  log: { warn(m: string): void },
): string | undefined {
  if (!raw) return undefined;
  const url = httpUrlOf(raw, houseUrl);
  if (!url) {
    log.warn(`popclaw: handshake — [${slug}]'s guide_url is not a valid http(s) address, ignoring: ${raw}`);
  }
  return url;
}

/** Absolutize + only allow-list http(s). `base` missing = only absolute addresses are accepted. Invalid → undefined. */
function httpUrlOf(raw: string | undefined, base?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function writeFileAtomicish(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

export interface MountedHouseGuide {
  readonly slug: string;
  readonly houseName: string;
  readonly guide: string;
}

/** Houses whose guide is already cached (in `houseUrls` order). Houses without a cached guide are skipped. */
export function mountedHouseGuides(
  paths: PopclawPaths,
  houseUrls: readonly string[],
): MountedHouseGuide[] {
  const out: MountedHouseGuide[] = [];
  for (const url of houseUrls) {
    try {
      const slug = hostDbSlug(url);
      const guide = readFileSync(paths.houseGuideFile(slug), 'utf8').trim();
      if (guide.length === 0) continue;
      out.push({ slug, houseName: readHouseHandshake(paths, slug)?.house_name || slug, guide });
    } catch {
      continue; // a house without a guide = just no entry for it, not an error
    }
  }
  return out;
}

/**
 * Mounting a house means knowing it: the moment the owner adds a house to
 * `lore_houses` is an explicit consent to receive that house's official
 * messages, so the house's official identity **is not a stranger** to the
 * stranger-gate. There's exactly one criterion: it appears in the
 * `official_ids` of any already-mounted house's manifest.
 */
export function isMountedHouseOfficial(
  actorPopclawId: string,
  paths: PopclawPaths,
  houseUrls: readonly string[],
): boolean {
  return houseOfficialHouseName(actorPopclawId, paths, houseUrls) !== undefined;
}

/**
 * Which house is this identity the official identity of → that house's name
 * (the `house_name` self-reported in its manifest). Not an official identity → undefined.
 *
 * The purpose is **giving the house's official identity a name to be called
 * by**: a house's official identity never publishes a namecard (it isn't a
 * person, it never went through `/v1/profile`), so walking the name chain to
 * the end leaves nothing but a bare sigil string — on the real machine on
 * 2026-07-31 (host-c), a postcard notification literally read
 * `#6q0w4z7r sent you a DM`, and the owner couldn't tell this had come from
 * the world. The house name is what the house self-reported during the local
 * handshake — zero network calls, zero guessing — making it exactly the right
 * fallback for this tier.
 */
export function houseOfficialHouseName(
  actorPopclawId: string,
  paths: PopclawPaths,
  houseUrls: readonly string[],
): string | undefined {
  if (!actorPopclawId) return undefined;
  for (const url of houseUrls) {
    try {
      const slug = hostDbSlug(url);
      const rec = readHouseHandshake(paths, slug);
      if (rec?.official_ids?.includes(actorPopclawId)) return rec.house_name || slug;
    } catch {
      continue;
    }
  }
  return undefined;
}
