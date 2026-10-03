/**
 * Bake the faces into the page at publish time.
 *
 * Every avatar on the paper is a remote url — `unavatar.io/<provider>/<handle>`,
 * a third-party service that goes and finds that person's current picture. That
 * is cheap and always fresh, and it costs three things the paper cannot really
 * afford:
 *
 *   1. **It is not "never sent anywhere".** The paper otherwise reaches no third
 *      party (the colophon names only the model that edited it, and a share
 *      link when there is one — never a claim about the page's own traffic),
 *      while every time the owner opens it his browser reports in to a
 *      service we do not run — once per face, with his IP, the time, and who
 *      he was looking at.
 *   2. **It fails exactly when it is busiest.** Thirty faces on one page is thirty
 *      simultaneous requests to a free service. Measured 2026-08-26, twenty in
 *      parallel all came back — but the risk scales with the number of faces, and
 *      a rate-limited or offline read leaves a paper with no faces on it at all.
 *   3. **It pulls a 400px original for a 40px circle.** unavatar ignores `?size=`
 *      (verified), so an avatar costs 8–52KB whatever we ask for.
 *
 * So the plugin fetches them **once, when the issue is published**, and embeds
 * them in the page. The reader makes no third-party request at all; the page
 * works offline; and a face is the face that person had on the day of the issue,
 * which for a daily is the more correct answer anyway.
 *
 * What keeps this safe: a **hard budget**. The canvas is capped at 2MB by the
 * server (axum's `DefaultBodyLimit`), and on a busy real issue (2026-08-26: 64
 * items, 14 distinct faces) the whole set came to 248KB raw / 331KB as data URIs
 * against a 72KB page. There is room, but a day with forty strangers and large
 * photos would not fit, so anything past the budget falls back.
 *
 * **What it falls back TO changed on 2026-09-12** (owner ruling, the
 * zero-dependency page). It used to keep the remote url — "worst case equals the
 * old behaviour". That worst case is exactly the leak reason (1) above, only
 * quieter, and on a page saved to disk it is also a gap: an offline reader gets
 * no picture at all. So a miss now takes the monogram the renderer already drew
 * for that face (`data-mono`, see `face()` in render-newspaper.ts) — a face
 * either way, from nobody but us. **No unavatar url survives this function.**
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { monogramDataUri } from './author-block.js';

/** Bytes of data-URI text this may add to one page. The 2MB canvas cap less generous room for the page itself. */
const BUDGET = 1_000_000;
/** One face may not cost more than this raw. Guards against a single pathological original eating the budget. */
const PER_AVATAR_MAX = 64 * 1024;
/** How long a cached face stays good. Matches unavatar's own `cache-control: max-age=2419200`. */
const TTL_MS = 28 * 24 * 60 * 60 * 1000;
/**
 * Faces fetched at once. Deliberately gentle: unavatar rate-limits, and once a
 * face is cached it is good for four weeks, so there is nothing to gain by
 * crowding the door — measured 2026-08-26, a burst produced 429s on half the set.
 */
const CONCURRENCY = 4;
/**
 * How long a REFUSED face is left alone before we ask again. A 429 is the service
 * telling us to back off; retrying it on every issue is how you stay rate-limited.
 * Short enough that a handle which starts resolving is picked up the same day.
 */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** What a refusal looks like in the cache — distinguishable from a real picture at a glance. */
const REFUSED = 'refused';

/** A fetched picture, or `null` for "could not get it" — never a throw. */
export interface FetchedImage {
  bytes: Uint8Array;
  /** MIME type as the server reported it; `image/*` only, anything else is refused. */
  type: string;
}

export interface InlineAvatarDeps {
  /** Where fetched faces are kept between issues. Not given = no cache, every issue re-fetches. */
  cacheDir?: string;
  /**
   * The fetch seam. Not injected = the global `fetch` — which is right for the
   * offline harness, and is why the plugin's own assembly root injects one
   * explicitly instead: a unit test that wires nothing then cannot reach the network.
   */
  fetchImage?: (url: string) => Promise<FetchedImage | null>;
  /** Bytes of data-URI text allowed on this page. Defaults to BUDGET. */
  budget?: number;
  /**
   * `inline` (default): fetch the faces and bake them in, as described above.
   * `off` (`newspaper.avatars: "off"`): ask nobody for anything — every remote
   * face becomes its monogram on the spot. The renderer draws monograms directly
   * when it knows the setting; this is the same rule applied to a page it did
   * not render, so the guarantee holds whichever end turns the knob.
   */
  mode?: 'inline' | 'off';
}

const isAvatar = (url: string): boolean => /^https:\/\/unavatar\.io\//i.test(url);

/**
 * Every face we did not bake in, swapped for its monogram — the stand-in the
 * renderer already drew and parked in `data-mono`. A page that never rendered
 * one (a caller assembling its own html) gets one drawn from the url, which is
 * stable per handle and so keeps the same person the same colour.
 *
 * This is the line that makes "no third-party request" true rather than
 * mostly-true: after it, the page holds no unavatar url at all.
 *
 * Exported because `inlineAvatars` is not the only way a page reaches the disk:
 * a host that wires no image fetcher (MCP, and any test harness) skips the
 * inlining entirely, and the guarantee is not allowed to be the fetcher's
 * courtesy. `publishNewspaper` applies it to every page it writes, wired or not.
 */
export function monogramFallback(html: string): string {
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    const src = /\ssrc="([^"]*)"/.exec(tag)?.[1];
    if (!src || !isAvatar(src)) return tag;
    const mono = /\sdata-mono="([^"]*)"/.exec(tag)?.[1] || monogramDataUri('?', src);
    return tag.replace(`src="${src}"`, `src="${mono}"`);
  });
}

/**
 * One picture over http(s), or `null`. Exported because the plugin's assembly root
 * injects it explicitly (see `registerPopclawTools`) rather than letting the tools
 * reach for the network themselves — one implementation, one place it is chosen.
 */
export async function fetchImageOverHttp(url: string): Promise<FetchedImage | null> {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!type.startsWith('image/')) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    return bytes.byteLength ? { bytes, type } : null;
  } catch {
    return null;
  }
}

const fileOf = (dir: string, url: string): string =>
  join(dir, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.b64`);

/**
 * A cached face, the marker for "asked recently and was refused", or nothing.
 * Missing, stale and unreadable all read as nothing — never a throw.
 */
function readCache(dir: string, url: string): string | undefined {
  try {
    const f = fileOf(dir, url);
    const age = Date.now() - statSync(f).mtimeMs;
    const text = readFileSync(f, 'utf-8');
    if (text === REFUSED) return age > RETRY_AFTER_MS ? undefined : REFUSED;
    if (age > TTL_MS) return undefined;
    return text.startsWith('data:image/') ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort write; a read-only data dir costs a re-fetch tomorrow, never an issue. */
function writeCache(dir: string, url: string, uri: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileOf(dir, url), uri, 'utf-8');
    // Sweep while we are here: a face nobody has appeared in for four weeks is dead weight.
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      try {
        if (Date.now() - statSync(f).mtimeMs > TTL_MS) rmSync(f, { force: true });
      } catch {
        /* one unreadable file must not stop the sweep */
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Run `work` over `items`, at most `CONCURRENCY` at a time. */
async function pooled<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
  });
  await Promise.all(runners);
}

/**
 * Replace every avatar url in `html` with the picture itself.
 *
 * Anything that cannot be fetched, is not an image, is too big on its own, or
 * falls past the page's budget takes the monogram instead — a face either way,
 * never a gap, never a page over the cap, and never a request to a third party
 * left in a finished page.
 *
 * Returns how many faces ended up as stand-ins, for the receipt: a silently
 * half-inlined page would be the kind of quiet degradation this whole change
 * exists to stop.
 */
export async function inlineAvatars(
  html: string,
  deps: InlineAvatarDeps = {},
): Promise<{ html: string; notes: string[] }> {
  const urls = [...new Set([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!))].filter(isAvatar);
  if (!urls.length) return { html, notes: [] };
  // `avatars: "off"` — not a budget question and not a failure. Nobody is asked
  // anything, and the page still carries a face on every row.
  if (deps.mode === 'off') return { html: monogramFallback(html), notes: [] };

  const get = deps.fetchImage ?? fetchImageOverHttp;
  const budget = deps.budget ?? BUDGET;
  const resolved = new Map<string, string>();

  await pooled(urls, async (url) => {
    const cached = deps.cacheDir ? readCache(deps.cacheDir, url) : undefined;
    if (cached === REFUSED) return; // asked recently and turned away; do not knock again yet
    if (cached) {
      resolved.set(url, cached);
      return;
    }
    const got = await get(url);
    // The type gate lives here as well as in the fetch: this is the line that
    // composes a `data:` URI and puts it in a `src`, so it is the line that has to
    // refuse anything that is not an image.
    if (!got || !got.type.startsWith('image/') || got.bytes.byteLength > PER_AVATAR_MAX) {
      if (deps.cacheDir) writeCache(deps.cacheDir, url, REFUSED);
      return;
    }
    const uri = `data:${got.type};base64,${Buffer.from(got.bytes).toString('base64')}`;
    resolved.set(url, uri);
    if (deps.cacheDir) writeCache(deps.cacheDir, url, uri);
  });

  // Spend the budget on the faces that appear most — the one on six cards is
  // worth more than the one in a single brief row.
  const appearances = (url: string): number => html.split(`src="${url}"`).length - 1;
  let spent = 0;
  let out = html;
  let dropped = 0;
  for (const url of [...resolved.keys()].sort((x, y) => appearances(y) - appearances(x))) {
    const uri = resolved.get(url)!;
    if (spent + uri.length > budget) {
      dropped += 1;
      continue;
    }
    spent += uri.length;
    out = out.split(`src="${url}"`).join(`src="${uri}"`);
  }

  const notes: string[] = [];
  const missed = urls.length - resolved.size + dropped;
  if (missed) {
    notes.push(
      `avatars: ${urls.length - missed}/${urls.length} baked into the page; ` +
        `${missed} fell back to a drawn monogram (unreachable, oversized, or past this page's budget)`,
    );
  }
  return { html: monogramFallback(out), notes };
}
