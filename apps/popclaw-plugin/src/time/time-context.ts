/**
 * **The one place owner-local time is derived** (ADR-0045; pays off the
 * `timeContext(ts, tz)` debt from charter D3).
 *
 * Three rules — do not hand-roll date formatting anywhere else:
 *   1. **Storage is always UTC epoch seconds.** This module only derives at
 *      read time; it never changes what is stored.
 *   2. **Display and day-boundaries are always owner-local.** Resolution chain:
 *      `cadence.delivery.timezone` (IANA) > the tz registered by the composition
 *      root > system tz > `UTC`. **Never IP geo** (VPNs lie — charter D3).
 *   3. stdlib `Intl` only, zero dependencies.
 *
 * `tz` accepts both IANA names (`Asia/Shanghai`) and the write-time offset
 * strings stored in the social log (`+08` / `-05:30`) — narrating a day in the
 * timezone it actually happened in depends on the latter.
 */

/** The one cadence field that matters here (avoids dragging in the whole config type). */
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export interface OwnerTzSource {
  readonly delivery?: { readonly timezone?: string };
}

/** Time-of-day bucket (charter D3). Keys are English; display wording is the lexicon's job. */
export type TimeBucket = 'small-hours' | 'dawn' | 'morning' | 'noon' | 'afternoon' | 'evening';

export interface TimeContext {
  /** Owner-local calendar day, `YYYY-MM-DD`. */
  readonly ymd: string;
  /** Owner-local wall clock, `HH:MM` (24h). */
  readonly hm: string;
  /** Owner-local `YYYY-MM` — what the social log slices its monthly files by. */
  readonly monthKey: string;
  readonly bucket: TimeBucket;
  /** The tz actually in effect, so callers can tell the owner the truth. */
  readonly tz: string;
}

let configuredTz: string | undefined;

/**
 * Called once by a composition root (index.ts / mcp.ts) after loading cadence.
 * **Process-wide singleton**: the timezone is one-per-owner config; threading it
 * as a parameter through a dozen display sites would be paying for a multi-owner
 * process that does not exist (same spirit as P-006 §3, resources are singletons).
 * Pass undefined to clear (tests).
 */
export function setOwnerTz(tz: string | null | undefined): void {
  configuredTz = validTz(tz);
}

/**
 * The tz a composition root registered from cadence, or undefined when nothing
 * was configured and `ownerTz()` is really falling back to the system clock.
 * Diagnostics only — telling the owner "Asia/Shanghai" is useless if they
 * cannot tell whether that came from their config or from the machine.
 */
export function configuredOwnerTz(): string | undefined {
  return configuredTz;
}

/** System timezone; falls back to `UTC` on the rare ICU-less runtime. */
export function systemTz(): string {
  return validTz(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
}

/**
 * Chain: explicit > registered by the composition root > system > UTC. A bogus
 * timezone is **skipped**, never thrown. The social log's write-time offset
 * strings come through here: narrate a day in the timezone it happened in (D3).
 */
export function resolveTz(tz?: string | null): string {
  return validTz(tz) ?? configuredTz ?? systemTz();
}

/** Whether `Intl` recognizes this timezone — the gate before persisting one. */
export function isValidTz(tz: string | null | undefined): boolean {
  return validTz(tz) !== undefined;
}

/** Same as `resolveTz`, entered from the cadence config. */
export function ownerTz(cadence?: OwnerTzSource): string {
  return resolveTz(cadence?.delivery?.timezone);
}

export function timeContext(tsSec: number, tz: string = ownerTz()): TimeContext {
  const p = partsOf(tsSec * 1000, tz);
  const ym = `${pad4(p.y)}-${pad2(p.mo)}`;
  return {
    ymd: `${ym}-${pad2(p.d)}`,
    hm: `${pad2(p.h)}:${pad2(p.mi)}`,
    monthKey: ym,
    bucket: bucketOf(p.h),
    tz,
  };
}

/**
 * "How long ago". Duration deltas are timezone-independent, but this used to
 * live **byte-identically in two files** (popclaw-feed + popclaw-search, B12).
 * Merged here so one edit fixes both.
 *
 * The five buckets were hardcoded English, with a comment promising the
 * lexicon "belongs to the language slice" — that slice shipped, and this line
 * was the leftover (ledger #012). Owner language, not host language: these
 * labels are read by the owner, not by a model.
 */
export function relativeTime(seconds: number, lang?: Lang): string {
  const l = lang ?? ownerLang();
  if (seconds < 0) return renderCopy(l, 'time.rel.now');
  if (seconds < 60) return renderCopy(l, 'time.rel.s', { n: String(seconds) });
  if (seconds < 3600) return renderCopy(l, 'time.rel.m', { n: String(Math.floor(seconds / 60)) });
  if (seconds < 86400) return renderCopy(l, 'time.rel.h', { n: String(Math.floor(seconds / 3600)) });
  return renderCopy(l, 'time.rel.d', { n: String(Math.floor(seconds / 86400)) });
}

/** UTC offset label for that instant in that zone: `+08` / `-05:30` (minutes dropped when 0). */
export function utcOffsetLabel(tsSec: number, tz: string = ownerTz()): string {
  const minutesEast = Math.round(offsetMs(tsSec * 1000, tz) / 60_000);
  const sign = minutesEast < 0 ? '-' : '+';
  const abs = Math.abs(minutesEast);
  const mm = abs % 60;
  return `${sign}${pad2(Math.floor(abs / 60))}${mm === 0 ? '' : `:${pad2(mm)}`}`;
}

/** UTC seconds at owner-local midnight — the start of a true "today" (e.g. the newspaper). */
export function startOfLocalDay(tsSec: number, tz: string = ownerTz()): number {
  const ms = tsSec * 1000;
  const p = partsOf(ms, tz);
  const naive = Date.UTC(p.y, p.mo - 1, p.d);
  // Guess with the offset in effect "now", then correct with the offset in effect
  // at the guessed midnight — on a DST-transition day those two differ.
  // ponytail: two passes is enough; in zones where local midnight itself is skipped
  // by DST (old Brazil rules) this lands on 01:00, an hour that day genuinely lacked.
  // Add a third pass only if that ever shows up for real.
  return Math.floor((naive - offsetMs(naive - offsetMs(ms, tz), tz)) / 1000);
}

// ---------------------------------------------------------------------------

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    // en-CA + h23 = plain digits, no localization noise. Seconds included because
    // historical zone offsets are not always whole minutes.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/**
 * `+08` / `+08:00` / `+0800` / `-05:30` → minutes east of UTC; null when it is
 * not an offset string.
 *
 * Why this must be parsed here and never handed to `Intl` (issue #332): the
 * social log stores the write-time offset as `tz`, and those are NOT IANA
 * names. Feeding them to `Intl.DateTimeFormat({timeZone})` put us at the mercy
 * of the host's ICU build:
 *   - node 22.19's ICU rejects them → `timeContext(ts, '+08')` throws RangeError;
 *   - the `resolveTz` path is worse — `validTz` swallows the throw and silently
 *     falls back to the system zone, so the DAY comes out wrong with no error
 *     (the dreamer filing a 07-31 entry under 07-30 was exactly this);
 *   - node 22.23's ICU happens to accept them, so CI went green on its own —
 *     the bug was never fixed, it just stopped being visible.
 * An offset needs no timezone database at all: shift the instant by that many
 * minutes and read the UTC fields — that IS the local wall clock. Anything
 * beyond ±24h is not an offset; it falls through to the Intl path as before.
 */
function offsetMinutes(tz: string): number | null {
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(tz.trim());
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  if (minutes > 24 * 60) return null;
  return m[1] === '-' ? -minutes : minutes;
}

function partsOf(ms: number, tz: string): Parts {
  const off = offsetMinutes(tz);
  if (off !== null) {
    // Shifted instant read as UTC — same fields as the Intl path below,
    // just without asking the timezone database.
    const d = new Date(ms + off * 60_000);
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      mi: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
    };
  }
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((x) => x.type === t)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Offset of that instant in that zone, in ms (east positive). */
function offsetMs(ms: number, tz: string): number {
  const p = partsOf(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

function bucketOf(h: number): TimeBucket {
  if (h < 5) return 'small-hours';
  if (h < 8) return 'dawn';
  if (h < 12) return 'morning';
  if (h < 14) return 'noon';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/** Only counts if `Intl` recognizes it (IANA name or `±HH[:MM]` offset). */
function validTz(tz: string | null | undefined): string | undefined {
  const t = (tz ?? '').trim();
  if (!t) return undefined;
  // Offsets are judged here, not by whatever ICU the host happens to ship.
  if (offsetMinutes(t) !== null) return t;
  try {
    formatter(t);
    return t;
  } catch {
    return undefined;
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad4 = (n: number): string => String(n).padStart(4, '0');
