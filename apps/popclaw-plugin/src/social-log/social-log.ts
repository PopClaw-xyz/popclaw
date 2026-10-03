/**
 * Social log — raw material warehouse for the dream mechanism (spec
 * `docs/superpowers/specs/2026-07-26-social-log-and-dream-architecture.md`
 * §4, ADR-0023 Revision 2026-07-26).
 *
 * One sentence: **every social action the owner genuinely took gets written
 * to disk verbatim, on the spot, and never deleted.**
 *
 * Shape: `vault/social/log/YYYY-MM.jsonl` (a precious-tier location, alongside
 * my-social-assets.db; **not** the disposable data/ layer). Append-only, no
 * UPDATE/DELETE surface — this is P-004's concrete implementation.
 *
 * Three hard requirements:
 *   1. **Self-sufficient** — carries both directions' original text. The
 *      world-feed cache has a one-year prune and can be deleted and re-pulled
 *      any time; a log that only stores IDs would be a field of dangling pointers a year later.
 *   2. **`_then` records context as of that moment** — `tier_then` /
 *      `verified_then`. Relationships change; explaining past behavior with
 *      after-the-fact values would train a reversed causal story (look-ahead
 *      bias). **If it can't be looked up, omit it** — don't fill in a
 *      default. An honest gap is fine; a fake value poisons training.
 *   3. **`v` preserves room to evolve** (ADR-0003 additive superset).
 *
 * The month is cut by **the owner's local timezone** (same convention as the
 * `tz` field), not UTC — otherwise the owner's last 8 hours of the month at
 * UTC+8 would land in next month's file. Timezone comes from
 * `time/time-context.ts` (ADR-0045: cadence config > system timezone), not the raw process timezone.
 *
 * This module only handles writing and reading. Consumers (the dream digest /
 * taste distillation / tool tails) are out of scope here.
 *
 * ponytail: POSIX append is only atomic under 4KB, and records carrying
 * original text can easily exceed that → multiple writers would interleave
 * into a half-line of JSON. **Relies on a single writer** (P-006 §3's
 * resource-singleton rule already requires this; a duplicate plugin host is a
 * known bug, see memory popclaw-6.6-host-install-lessons). The cost of a torn
 * write is contained to "the reader skips the bad line" — no lock / tmp+rename
 * is implemented, since under a single owner/single process that would be
 * paying for concurrency that doesn't exist. Upgrade path: if multiple hosts
 * ever genuinely coexist, switch to `flock` or consolidate writes into a single service.
 */
// The social log writes a local private-domain file; HostAdapter has no
// generic fs-write surface, so this uses node:fs / node:path directly
// (same exemption as learned-writer.ts and pick-recorder.ts).
/* eslint-disable no-restricted-imports */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/* eslint-enable no-restricted-imports */
import { timeContext, utcOffsetLabel } from '../time/time-context.js';

/** Current record version. Adding a field doesn't bump the version (ADR-0003 additive superset); only a semantic change bumps it. */
export const SOCIAL_LOG_VERSION = 1;

/**
 * Which actions get recorded (spec §4). **Pure browsing is not recorded**
 * (status/help/scrolling the feed) — that's disposable debug noise, it goes
 * to `api.logger` bucket 1, not into the never-delete raw-material warehouse.
 */
export type SocialLogKind =
  /** I posted (including quote-reposts) — the strongest signal: what I chose to say is what I care about */
  | 'post_sent'
  /** I replied to someone — a topic I was willing to spend time engaging with */
  | 'reply_sent'
  /** Someone replied to me — who cares about me + what topic drew a response */
  | 'reply_received'
  /** DM sent/received — a strong relationship signal */
  | 'dm_sent'
  | 'dm_received'
  /** I marked something — explicit endorsement; un-marking is equally a taste signal (I changed my mind) */
  | 'mark_added'
  | 'mark_removed'
  /** Follow change — who I want to keep watching */
  | 'follow_added'
  | 'follow_removed'
  /** Someone followed me — who cares about me (a passive event, same tier as reply_received / dm_received) */
  | 'followed_you'
  /** I asked the agent "how's so-and-so lately" — implicit interest, more honest than a follow */
  | 'person_asked'
  /** I compiled and delivered an issue of the daily paper to the owner — this is **my** action, not the owner browsing. What's recorded is what made it onto that issue (material count / per-house counts / pings count / canvas link); what the owner clicked after reading it can't be observed in the browser, so it's not recorded. */
  | 'newspaper_published'
  /** The plugin itself upgraded — the build number changed at boot (see
   *  runtime/last-build.ts). Also "my" event rather than the owner's action,
   *  but it's exactly what the owner most wants to know when they come back
   *  after being away: `text` records `<old build> → <new build>`. */
  | 'plugin_upgraded';

/** The other party's verified platform account as of that time (`_then`), baked from the world-stream entry's `actor_verified`. */
export interface SocialLogVerified {
  readonly platform: string;
  readonly followers?: number;
}

/** The "other party" in an action. All fields optional: if it can't be looked up, omit it — never fill in something made up. */
export interface SocialLogActor {
  readonly id?: string;
  readonly name?: string;
  readonly sigil?: string;
  /** Their bond-book tier at the time. Looked up live and filled in by SocialLogWriter from the bond book (not found = stranger). */
  readonly tier_then?: string;
  readonly verified_then?: readonly SocialLogVerified[];
}

/** One action. The caller only needs to worry about "what happened"; v/ts/tz/tier_then are filled in by the writer. */
export interface SocialLogEntry {
  readonly kind: SocialLogKind;
  /**
   * Which house this happened in (ADR-0037's overall rule: recording "what
   * happened" always carries a house; recording "who I am" never does). Once
   * the origin is lost it can't be backfilled — if the collection point can
   * compute it, it must include it.
   * The home house / uncomputable → **omit**, never fill in a fake default
   * (same honest-gap discipline as `_then`).
   * Historical entries (written before this field existed) naturally lack it; the read side always tolerates its absence.
   */
  readonly house_slug?: string;
  readonly actor?: SocialLogActor;
  /** The complete original text of the action itself (what I said / what the other party said). */
  readonly text?: string;
  /** The complete original text of the thing being replied to — the other half of self-sufficiency. */
  readonly in_reply_to?: {
    readonly event_id?: string;
    readonly text?: string;
    readonly url?: string;
  };
  /** The event id this action produced (the event_id of the post/reply/mark I made). */
  readonly event_id?: string;
  readonly url?: string;
}

export interface SocialLogRecord extends SocialLogEntry {
  readonly v: number;
  /** Unix seconds (a UTC instant). */
  readonly ts: number;
  /** The owner's timezone offset at the moment of writing, e.g. `+08` / `-05:30` (D3: time is a first-class dimension for the dreamer). */
  readonly tz: string;
}

/** The logging seam injected at collection points. A structured interface, so tests can substitute a fake. */
export interface SocialLogRecorder {
  record(entry: SocialLogEntry): void;
}

// ---------------------------------------------------------------------------
// Time convention: both the month and tz read the owner's local timezone
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM`, taking the year/month in **the owner's local time** (ADR-0045:
 * no longer just the raw process timezone — once the owner configures
 * `cadence.delivery.timezone`, that takes precedence, so a cross-machine/container TZ=UTC won't skew the month boundary).
 */
export function socialLogMonth(d: Date): string {
  return timeContext(Math.floor(d.getTime() / 1000)).monthKey;
}

/** `+08` / `-05:30` — minutes omitted on the hour (matches the spec's example format), also in the owner's timezone. */
export function socialLogTz(d: Date): string {
  return utcOffsetLabel(Math.floor(d.getTime() / 1000));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Append one entry. Synchronous write: guarantees append order within a
 * single process (concurrent calls to async appendFile would interleave);
 * a record is only a few hundred bytes, so the cost is negligible.
 */
export function appendSocialLog(dir: string, entry: SocialLogEntry, nowMs = Date.now()): void {
  const d = new Date(nowMs);
  const rec: SocialLogRecord = {
    v: SOCIAL_LOG_VERSION,
    ts: Math.floor(nowMs / 1000),
    tz: socialLogTz(d),
    ...entry,
  };
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${socialLogMonth(d)}.jsonl`), JSON.stringify(rec) + '\n', 'utf-8');
}

export interface SocialLogWriterOptions {
  /** `PopclawPaths.socialLogDir()`. */
  readonly dir: string;
  readonly warn?: (msg: string) => void;
  /**
   * The sole source for `tier_then`: the bond book. **Not injected = the
   * field is omitted** (an honest gap); injected but the person isn't found =
   * `stranger` ("don't know them" is itself the true context at that moment).
   */
  readonly bondTierOf?: (popclawId: string) => string | null | undefined;
  /** Clock seam, milliseconds. */
  readonly now?: () => number;
}

/**
 * The writer used at collection points. Consolidates try/catch and filling in
 * `_then` in one place, so each of the 9 collection points is left with just
 * one line: `safeRecord(...)`.
 */
export class SocialLogWriter implements SocialLogRecorder {
  constructor(private readonly opts: SocialLogWriterOptions) {}

  record(entry: SocialLogEntry): void {
    try {
      appendSocialLog(this.opts.dir, this.withThenContext(entry), this.opts.now?.() ?? Date.now());
    } catch (err) {
      // A failed log write must never drag down the main flow — it would be
      // absurd for the owner's post to fail just because the log couldn't be written.
      this.opts.warn?.(`social-log append failed — ${String(err)}`);
    }
  }

  /** Only fills in what can be looked up on the spot; fields that can't be found never appear in the JSON at all. */
  private withThenContext(entry: SocialLogEntry): SocialLogEntry {
    const actor = entry.actor;
    if (!actor) return entry;
    const verified = actor.verified_then;
    const next: SocialLogActor = {
      ...actor,
      ...(actor.tier_then === undefined && actor.id && this.opts.bondTierOf
        ? { tier_then: this.opts.bondTierOf(actor.id) ?? 'stranger' }
        : {}),
    };
    // An empty array isn't a signal, it's "nothing was found" → omit it.
    if (verified !== undefined && verified.length === 0) delete (next as { verified_then?: unknown }).verified_then;
    return { ...entry, actor: next };
  }
}

/**
 * The single entry point for collection sites. **No failure in logging is
 * ever allowed to break the real work** — the injected recorder is a
 * structured interface, and anyone could plug in an implementation that
 * throws; this is the last net. The silence is deliberate: this layer has no
 * logger, and a genuine write failure has already been warned about inside SocialLogWriter.
 */
export function safeRecord(
  log: SocialLogRecorder | undefined,
  entry: SocialLogEntry,
): void {
  try {
    log?.record(entry);
  } catch {
    /* never let this bubble up */
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Whether a line is usable. Missing ts / missing kind / parse failure all count as a bad line. */
function parseLine(line: string): SocialLogRecord | null {
  if (line.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const r = obj as Partial<SocialLogRecord>;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null;
  if (typeof r.kind !== 'string' || r.kind.length === 0) return null;
  return r as SocialLogRecord;
}

/**
 * Read actions within the `[fromSec, toSec]` window (inclusive of both ends),
 * ascending by ts. Automatically reads adjacent month files across a month
 * boundary; **bad lines are skipped** — one torn line must not ruin the
 * entire window (`loadRecentPicks` already follows this convention).
 * Directory/file not existing = empty array, never throws.
 *
 * Months are selected by listing the directory rather than stepping
 * month-by-month from `from`: a year is only 12 files, one readdir is cheaper
 * than any cursor, and it makes a window like `from=0` (read all history)
 * naturally work. `YYYY-MM`'s lexicographic order is chronological order, so
 * range comparison just uses strings directly. Each end is expanded by one
 * day to absorb cross-month drift caused by timezone offsets (max ±14h).
 */
export function readSocialLog(dir: string, fromSec: number, toSec: number): SocialLogRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no actions recorded yet
  }
  const lo = socialLogMonth(new Date((fromSec - 86_400) * 1000));
  const hi = socialLogMonth(new Date((toSec + 86_400) * 1000));
  const out: SocialLogRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const month = name.slice(0, -'.jsonl'.length);
    if (month < lo || month > hi) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const rec = parseLine(line);
      if (rec && rec.ts >= fromSec && rec.ts <= toSec) out.push(rec);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
