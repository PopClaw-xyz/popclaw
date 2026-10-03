/**
 * "When did this house last deliver a frame?" — the one fact that separates a
 * lore-house outage from a genuinely quiet world (#588).
 *
 * The skill tells the agent to say it is quiet when it is quiet. That rule is
 * only honest while the houses are actually connected: with a house down, an
 * empty `popclaw_show_feed` / `popclaw_world_summary` renders the outage as
 * calm. So every empty result carries one line per mounted house naming it and
 * the time of its last frame — or saying "never".
 *
 * Cache only, no network, ever: the answer is `MAX(received_at)` over that
 * house's own `data/lorehouses/<slug>.db` (per-house db ownership makes the
 * row set inherently self-tagging — see `world-feed-store.ts`). One SQL
 * statement, read by two callers: `WorldFeedCache.lastFrameAt()` on the live
 * handles the tools already hold, and `/popclaw doctor`, which opens the same
 * files read-only. Keeping the statement here is what stops the two from
 * drifting into answering slightly different questions.
 */
import type { HostDb } from '../host/host-db.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { ownerTz, relativeTime, timeContext } from '../time/time-context.js';

/**
 * When a house's last frame landed:
 *  - a `number` — unix SECONDS;
 *  - `null` — the cache was read and holds nothing: this house has genuinely never delivered a frame;
 *  - `'unreadable'` — we could not read the cache at all, so we do not know.
 *
 * The third state exists because collapsing it into `null` makes a locked or
 * missing database claim that a perfectly healthy house has never spoken —
 * exactly the false alarm this whole feature is meant to prevent.
 */
export type LastFrame = number | null | 'unreadable';

/** One mounted house's silence facts. The slug is the house identifier every other tool surface uses. */
export interface HouseSilence {
  readonly slug: string;
  readonly lastFrameAt: LastFrame;
}

/**
 * When the newest frame from this house landed (`received_at`, seconds), or
 * null for a cache that has never seen one.
 *
 * Deliberately NOT `platform_post_created_at`: an old post relayed today is
 * still proof the house is alive, and a house that only ever relays old posts
 * would otherwise read as down. Never 0 — that would render as 1970.
 *
 * A database we cannot query at all (no `world_feed` table, a locked or
 * corrupt file) returns `'unreadable'` rather than throwing — and rather than
 * `null`, which would accuse a healthy house of never having spoken.
 */
export function readLastFrameAt(db: HostDb): LastFrame {
  try {
    const row = db.queryAll<{ t: number | null }>(`SELECT MAX(received_at) AS t FROM world_feed`)[0];
    return row?.t ?? null;
  } catch {
    return 'unreadable';
  }
}

export interface HouseSilenceOpts {
  readonly nowSec?: number;
  readonly tz?: string;
  readonly lang?: Lang;
}

/**
 * The block appended to an EMPTY feed / summary result: one line per mounted
 * house. Returns '' for an empty list so the caller can append it blind.
 */
export function houseSilenceText(
  houses: readonly HouseSilence[],
  opts: HouseSilenceOpts = {},
): string {
  if (houses.length === 0) return '';
  const lang = opts.lang ?? ownerLang();
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tz = opts.tz ?? ownerTz();
  const lines = houses.map(({ slug: house, lastFrameAt }) => {
    if (lastFrameAt === null) return renderCopy(lang, 'world.silence.never', { house });
    if (lastFrameAt === 'unreadable') return renderCopy(lang, 'world.silence.unreadable', { house });
    const t = timeContext(lastFrameAt, tz);
    return renderCopy(lang, 'world.silence.since', {
      house,
      when: `${t.ymd} ${t.hm}`,
      ago: relativeTime(nowSec - lastFrameAt, lang),
    });
  });
  return [renderCopy(lang, 'world.silence.head'), ...lines].join('\n');
}

/**
 * The silence facts off a composition root's runtime bag (`worldFeedCache` is
 * the cross-house `WorldFeedCatalog`). Duck-typed rather than importing the
 * catalog: this is read by tool code that already casts its runtime down, and
 * a partial test rig / a root without a catalog must degrade to "say nothing"
 * instead of failing the tool call. Never throws, never fetches.
 */
export function houseSilenceOf(rt: unknown): readonly HouseSilence[] {
  try {
    const catalog = (rt as { worldFeedCache?: { houseSilence?: () => HouseSilence[] } } | null | undefined)
      ?.worldFeedCache;
    return catalog?.houseSilence?.() ?? [];
  } catch {
    return [];
  }
}
