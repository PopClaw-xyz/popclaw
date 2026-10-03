/**
 * `/popclaw doctor` — the mounted lore-houses section (#588).
 *
 * Before this, the report covered identity, host tool config, skill presence,
 * gateway and install logs, and said **nothing about lore-houses**: the owner
 * could not see which houses were mounted, whether each had ever been
 * handshaken, when its guide was last refreshed, or when its last frame
 * arrived. Combined with the skill's "say it's quiet when it's quiet" rule,
 * a house outage was invisible and rendered as a quiet world.
 *
 * Pure, like `bundle.ts`: already-read facts in, report lines out. Every
 * actual disk read (handshake JSON, guide mtime, the per-house cache's
 * `MAX(received_at)`) lives in `collect.ts`, the doctor feature's designated
 * IO boundary — and all of it is **cache only**. A house with no handshake
 * file reads "never handshaken"; `house-handshake.ts` owns fetching, and
 * doctor must stay usable with the network unplugged (ADR-0035 discipline).
 */
import { renderCopy, type Lang } from '../lexicon/index.js';
import { timeContext } from '../time/time-context.js';
import type { LastFrame } from '../ingress/house-silence.js';

/** What `collect.ts` could read off disk for one mounted house. Absent field = no such cache entry — never a guess. */
export interface HouseCacheFacts {
  /**
   * The house's cache slug — deliberately the ONLY address form in this row.
   * The configured `lore_houses` URL is never carried here: this report is
   * attached to feedback DMs, and a self-hosted or `localhost:<port>` house
   * address is a topology disclosure (controller ruling 2026-09-13). The slug
   * is already the agent- and owner-facing house identifier everywhere else.
   */
  readonly slug: string;
  /**
   * The house's self-reported name, copied verbatim out of its manifest.
   * **House-supplied text**, like every other starred field on this interface:
   * sanitised on render (single line, capped). A forged `house_name` otherwise
   * writes whole fake rows into a report that goes out as a DM attachment.
   */
  readonly houseName?: string;
  /**
   * `fetched_at` from `<slug>.handshake.json`, unix seconds.
   * Absent = never handshaken; `'unreadable'` = the file is there but we could
   * not parse it, which is a broken cache, not a house we have never met.
   */
  readonly handshakeFetchedAt?: number | 'unreadable';
  /** House-supplied, unbounded — sanitised on render. */
  readonly manifestEtag?: string;
  /** House-supplied, unbounded — sanitised on render. */
  readonly guideEtag?: string;
  /** mtime of `<slug>.guide.md`, unix seconds. Absent = no guide cached (the house may simply not declare one). */
  readonly guideMtime?: number;
  /** `MAX(received_at)` in this house's cache: seconds, `null` = never a frame, `'unreadable'` = could not tell. */
  readonly lastFrameAt: LastFrame;
  /**
   * The `feedback:` contact this house declares in its guide, if any.
   * **House-supplied text**: sanitised on render (single line, capped) — this
   * report is attached to a DM, and a multi-line value would otherwise forge
   * report lines of its own.
   */
  readonly officialContact?: string;
}

export interface HouseSectionOpts {
  readonly tz: string;
  readonly lang: Lang;
}

/** Longest any single house-supplied value may make its line. Beyond this it is a paragraph, not a field. */
const FIELD_MAX = 120;

/**
 * House-supplied text → one harmless line: newlines folded, capped.
 *
 * `renderCopy` substitutes with a bare `String.replace` and escapes nothing,
 * so **every** value a house wrote — its name, its ETags, its contact — has to
 * come through here. This report is attached to a feedback DM; a value with a
 * newline in it otherwise forges report lines of its own, including rows
 * attributed to a different house.
 */
function oneLine(raw: string): string {
  const flat = raw.replace(/[\r\n]+/g, ' ').trim();
  return flat.length > FIELD_MAX ? `${flat.slice(0, FIELD_MAX)}…` : flat;
}

/** Owner-local `YYYY-MM-DD HH:MM`, the same shape section A's local-time line uses. */
function when(tsSec: number, tz: string): string {
  const t = timeContext(tsSec, tz);
  return `${t.ymd} ${t.hm}`;
}

/**
 * The section's lines (caller joins with '\n').
 *
 * `undefined` means the mounted-house list itself could not be read — which is
 * a different fact from "no houses", and must not be reported as one.
 */
export function renderHouseSection(
  houses: readonly HouseCacheFacts[] | undefined,
  opts: HouseSectionOpts,
): string[] {
  const { lang, tz } = opts;
  const out: string[] = [renderCopy(lang, 'doctor.file.sectionF')];
  if (houses === undefined || houses.length === 0) {
    out.push(renderCopy(lang, 'doctor.file.f.unreadable'));
    return out;
  }
  const none = renderCopy(lang, 'doctor.file.f.etagNone');
  for (const h of houses) {
    const name = h.houseName ? oneLine(h.houseName) : '';
    out.push(
      name
        ? renderCopy(lang, 'doctor.file.f.house', { name, slug: h.slug })
        : renderCopy(lang, 'doctor.file.f.houseUnnamed', { slug: h.slug }),
    );
    out.push(handshakeLine(h, tz, lang, none));
    out.push(
      h.guideMtime === undefined
        ? renderCopy(lang, 'doctor.file.f.guideNone')
        : renderCopy(lang, 'doctor.file.f.guideAt', { when: when(h.guideMtime, tz) }),
    );
    out.push(lastFrameLine(h.lastFrameAt, tz, lang));
    const contact = h.officialContact ? oneLine(h.officialContact) : '';
    out.push(
      contact
        ? renderCopy(lang, 'doctor.file.f.contact', { contact })
        : renderCopy(lang, 'doctor.file.f.contactNone'),
    );
  }
  return out;
}

/**
 * "never handshaken", "the handshake file is there but unreadable" and a real
 * timestamp are three different facts: a corrupt cache file must not be
 * reported as a house this machine has never met.
 */
function handshakeLine(h: HouseCacheFacts, tz: string, lang: Lang, none: string): string {
  if (h.handshakeFetchedAt === undefined) return renderCopy(lang, 'doctor.file.f.handshakeNever');
  if (h.handshakeFetchedAt === 'unreadable') return renderCopy(lang, 'doctor.file.f.handshakeUnreadable');
  return renderCopy(lang, 'doctor.file.f.handshakeAt', {
    when: when(h.handshakeFetchedAt, tz),
    manifest: h.manifestEtag ? oneLine(h.manifestEtag) : none,
    guide: h.guideEtag ? oneLine(h.guideEtag) : none,
  });
}

/** "never", "cache unreadable" and a real timestamp are three different facts; a cache we could not read must never be reported as a house that never spoke. */
function lastFrameLine(lastFrameAt: LastFrame, tz: string, lang: Lang): string {
  if (lastFrameAt === null) return renderCopy(lang, 'doctor.file.f.lastFrameNever');
  if (lastFrameAt === 'unreadable') return renderCopy(lang, 'doctor.file.f.lastFrameUnreadable');
  return renderCopy(lang, 'doctor.file.f.lastFrameAt', { when: when(lastFrameAt, tz) });
}
